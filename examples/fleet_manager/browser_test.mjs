/* Acceptance against the actual static bundle, in both supported browsers. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname, join, sep} from 'node:path';
import {chromium, firefox} from '../../web/node_modules/playwright/index.mjs';

const root = resolve(process.argv[2]);
const mime = {'.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.wasm': 'application/wasm'};
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(root + sep)) throw new Error('Outside site');
    response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const artifacts = process.env.BROWSER_ARTIFACTS_DIR ?? '/tmp/simple-crypts-fleet-browser';
await mkdir(artifacts, {recursive: true});

async function wait(page) {
  await page.waitForFunction(() => !document.querySelector('#create-form button').disabled);
}
async function click(page, id) { await page.locator(id).click(); await wait(page); }
async function device(page, line) {
  const panel = page.locator('.console').first();
  await panel.locator('input').fill(line);
  await panel.locator('button', {hasText: 'Run command'}).click();
  await wait(page);
  return (await panel.locator('pre').textContent()).split('\n').at(-1);
}
async function state(page) { return JSON.parse(await page.locator('#server-state').textContent()); }
async function tx(page) { await click(page, '#tx'); return page.locator('#outbound').inputValue(); }
async function rx(page, frame) {
  await page.locator('#incoming').fill(frame);
  await click(page, '#receive-form button');
}
async function exchange(page) {
  assert.equal(await device(page, 'rx ' + await tx(page)), 'ok');
  await rx(page, await device(page, 'tx'));
  assert.equal(await device(page, 'rx ' + await tx(page)), 'ok');
}

try {
  for (const [name, engine] of [['chromium', chromium], ['firefox', firefox]]) {
    const browser = await engine.launch({headless: true});
    const context = await browser.newContext();
    await context.tracing.start({screenshots: true, snapshots: true});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    try {
      await page.goto(url);
      await wait(page);
      await click(page, '#create-form button[value=browser]');
      const firstKey = (await state(page)).public_key;
      const deviceKey = JSON.parse(await device(page, 'status')).public_key;
      await click(page, '#begin');
      assert.equal((await state(page)).registered, false);
      assert.equal(await device(page, 'tx'), 'No output.');
      assert.equal(await device(page, 'rx ' + await tx(page)), 'ok');
      const claim = await device(page, 'tx');
      await rx(page, claim);
      assert.equal((await state(page)).registered, false);
      await click(page, '#approve');
      // The confirmation is recovered manually after a real page/worker restart.
      await page.reload();
      await wait(page);
      assert.equal((await state(page)).public_key, firstKey);
      await rx(page, claim);
      assert.equal(await device(page, 'rx ' + await tx(page)), 'ok');
      await click(page, '#issue-form button');
      assert.equal(JSON.parse(await device(page, 'status')).credits_issued, '0');
      await exchange(page);
      assert.equal(await device(page, 'consume 25'), 'ok');
      assert.equal(await device(page, 'tx'), 'No output.');
      assert.equal((await state(page)).credits_consumed, '0');
      await click(page, '#request');
      await exchange(page);
      assert.equal((await state(page)).credits_consumed, '25');
      assert.match(await device(page, 'consume 100'), /^error:/);
      await click(page, '#stop');
      await click(page, '#start');
      assert.equal(JSON.parse(await device(page, 'status')).public_key, deviceKey);
      assert.equal(JSON.parse(await device(page, 'status')).credits_consumed, '25');
      await page.locator('.console button', {hasText: 'Hide'}).first().click();
      assert.equal(await page.locator('.console').first().isVisible(), false);
      await click(page, '#show-console');
      assert.equal(await page.locator('.console').first().isVisible(), true);
      await page.locator('#serial').fill('external-python');
      await click(page, '#create-form button[value=external]');
      assert.match(await page.locator('#launch-command').textContent(), /python_device:console/);
      assert.notEqual((await state(page)).public_key, firstKey);
      await page.locator('#serial').fill('mcu-0002');
      await click(page, '#create-form button[value=browser]');
      assert.equal(await page.locator('.console').count(), 2);
      assert.equal((await state(page)).credits_consumed, '0');

      const secondTab = await context.newPage();
      await secondTab.goto(url);
      await secondTab.waitForFunction(() => document.querySelector('#notice').textContent.includes('another tab'));
      assert.equal(await secondTab.locator('#create-form button').first().isDisabled(), true);
      await secondTab.close();

      await page.reload();
      await wait(page);
      await page.getByRole('button', {name: 'mcu-0001', exact: true}).click();
      assert.equal((await state(page)).public_key, firstKey);
      assert.equal((await state(page)).credits_consumed, '25');
      assert.equal(await page.locator('#fleet-rows tr').count(), 3);
      await page.setViewportSize({width: 390, height: 844});
      await page.screenshot({path: join(artifacts, `${name}-fleet.png`), fullPage: true});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

      // Corrupt an existing store deliberately, then verify no replacement key
      // or silent reinitialization. This tests the real IndexedDB restore path.
      await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('simple-crypts-fleet-v1', 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction('endpoints', 'readwrite');
          tx.objectStore('endpoints').put(new Uint8Array([1, 2]), 'server:mcu-0001');
          tx.oncomplete = resolve;
          tx.onabort = reject;
        });
        db.close();
      });
      await page.reload();
      await wait(page);
      await page.getByRole('button', {name: 'mcu-0001', exact: true}).click();
      assert.match(await page.locator('#entry-error').textContent(), /storage/);
      assert.equal(await page.locator('#begin').isDisabled(), true);
      assert.deepEqual(errors, []);
      console.log(`${name}: manual fleet, C++ console, IndexedDB restart, isolation, lock and corruption passed.`);
    } finally {
      await context.tracing.stop({path: join(artifacts, `${name}-trace.zip`)});
      await browser.close();
    }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
