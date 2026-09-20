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
async function device(page, line, serial = 'mcu-0001') {
  const panel = page.locator(`.console[data-serial="${serial}"]`);
  await panel.locator('input').fill(line);
  await panel.locator('input').press('Enter');
  await wait(page);
  return panel.locator('pre').textContent();
}
async function state(page) { return JSON.parse(await page.locator('#server-state').textContent()); }

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
      assert.equal(await page.locator('textarea').count(), 0);
      assert.equal(await page.getByRole('button', {name: /external|copy.*frame/i}).count(), 0);
      await click(page, '#create-form button');
      const firstKey = (await state(page)).public_key;
      assert.match(await device(page, 'help'), /sync/);
      await click(page, '#begin');
      assert.equal((await state(page)).registered, false);
      const deviceKey = (await state(page)).candidate_key;
      assert.notEqual(deviceKey, '00'.repeat(32));
      assert.match(await device(page, 'status'), /awaiting enrollment/);
      // Existing saved pending enrollment still requires an explicit approval.
      await page.reload();
      await wait(page);
      assert.equal((await state(page)).public_key, firstKey);
      assert.equal((await state(page)).registered, false);
      await click(page, '#approve');
      assert.equal((await state(page)).registered, true);
      assert.match(await device(page, 'status'), /Registration: registered/);
      await click(page, '#issue-form button');
      assert.match(await device(page, 'status'), /Credits issued: 100/);
      assert.match(await device(page, 'consume 25'), /Consumed 25/);
      assert.equal((await state(page)).credits_consumed, '0');
      await device(page, 'sync');
      assert.equal((await state(page)).credits_consumed, '0');
      await click(page, '#request');
      assert.equal((await state(page)).credits_consumed, '25');
      assert.match(await device(page, 'consume 100'), /error:/);
      await device(page, 'status');
      const commandInput = page.locator('.console input').first();
      assert.equal(await commandInput.evaluate(node => node === document.activeElement), true);
      await commandInput.press('ArrowUp');
      assert.equal(await commandInput.inputValue(), 'status');
      await commandInput.press('ArrowUp');
      assert.equal(await commandInput.inputValue(), 'consume 100');
      await commandInput.press('ArrowDown');
      assert.equal(await commandInput.inputValue(), 'status');
      await commandInput.fill('');
      await click(page, '#stop');
      await page.locator('#total').fill('200');
      await click(page, '#issue-form button');
      await page.reload();
      await wait(page);
      assert.equal(await page.locator('.console input').first().isDisabled(), true);
      await click(page, '#start');
      const restored = await device(page, 'status');
      assert.match(restored, /Credits issued: 200/);
      assert.match(restored, /Credits consumed: 25/);
      assert.ok(restored.includes(deviceKey));
      await device(page, 'reboot');
      assert.match(await device(page, 'status'), /Credits remaining: 175/);
      await device(page, 'quit');
      assert.equal(await commandInput.isDisabled(), true);
      await click(page, '#start');
      await page.locator('.console button', {hasText: 'Hide'}).first().click();
      assert.equal(await page.locator('.console').first().isVisible(), false);
      await click(page, '#show-console');
      assert.equal(await page.locator('.console').first().isVisible(), true);
      await page.locator('#serial').fill('mcu-0002');
      await click(page, '#create-form button');
      assert.equal(await page.locator('.console').count(), 2);
      assert.equal((await state(page)).credits_consumed, '0');
      assert.notEqual((await state(page)).public_key, firstKey);

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
      assert.equal(await page.locator('#fleet-rows tr').count(), 2);
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
          const tx = db.transaction(['endpoints', 'fleet'], 'readwrite');
          tx.objectStore('endpoints').put(new Uint8Array([1, 2]), 'server:mcu-0001');
          tx.objectStore('fleet').put({serial: 'old-external', kind: 'external', phase: 'ready'});
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
      assert.equal(await page.locator('#fleet-rows tr').count(), 2);
      assert.equal(await page.getByRole('button', {name: 'old-external'}).count(), 0);
      assert.deepEqual(errors, []);
      console.log(`${name}: interactive C++ consoles, transport, history, restart, isolation, lock and migration passed.`);
    } finally {
      await context.tracing.stop({path: join(artifacts, `${name}-trace.zip`)});
      await browser.close();
    }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
