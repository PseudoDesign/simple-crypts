/* Acceptance against the actual static bundle, in both supported browsers. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join, sep } from 'node:path';
import { chromium, firefox } from '../../web/node_modules/playwright/index.mjs';

const root = resolve(process.argv[2]);
const mime = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
};
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(root + sep)) throw new Error('Outside site');
    response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    response.end(await readFile(path));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const artifacts =
  process.env.TEST_UNDECLARED_OUTPUTS_DIR ??
  process.env.BROWSER_ARTIFACTS_DIR ??
  '/tmp/simple-crypts-fleet-browser';
await mkdir(artifacts, { recursive: true });

async function wait(page) {
  await page.waitForFunction(() => !document.querySelector('#create-form button').disabled);
}
const row = (page, serial = 'mcu-0001') => page.locator(`.device-row[data-serial="${serial}"]`);
async function hideConsoles(page) {
  while (await page.locator('.console:visible').count()) {
    const panel = page.locator('.console:visible').first();
    // Bring an overlapping window forward using its visible title when needed.
    await panel.locator('.drag-handle').focus();
    await panel.getByRole('button', { name: 'Hide', exact: true }).click();
  }
}
async function click(page, selector) {
  await hideConsoles(page);
  await page.locator(selector).click();
  await wait(page);
}
async function control(page, name, serial = 'mcu-0001') {
  await hideConsoles(page);
  if (['connection', 'debug'].includes(name)) {
    await row(page, serial).locator('[data-action="open"]').click();
    await page.locator(`.console[data-serial="${serial}"] [data-action="${name}"]`).click();
  } else {
    await row(page, serial).locator(`[data-action="${name}"]`).click();
  }
  await wait(page);
}
async function device(page, line, serial = 'mcu-0001') {
  const panel = page.locator(`.console[data-serial="${serial}"]`);
  if (!(await panel.isVisible())) await control(page, 'open', serial);
  await panel.locator('input').fill(line);
  await panel.locator('input').press('Enter');
  await wait(page);
  return panel.locator('pre').textContent();
}
async function state(page, serial = 'mcu-0001') {
  const field = (name) => row(page, serial).locator(`[data-field="${name}"]`).textContent();
  return {
    public_key: await field('server-key'),
    candidate_key: await field('candidate'),
    registered: (await field('enrollment')) === 'Registered',
    credits_consumed: await field('consumed'),
  };
}

try {
  for (const [name, engine] of [
    ['chromium', chromium],
    ['firefox', firefox],
  ]) {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    try {
      await page.goto(url);
      await wait(page);
      assert.equal(await page.locator('textarea').count(), 0);
      assert.equal(await page.getByRole('button', { name: /external|copy.*frame/i }).count(), 0);
      await click(page, '#create-form button');
      const firstKey = (await state(page)).public_key;
      assert.match(await device(page, 'help'), /sync/);
      await control(page, 'begin');
      assert.equal((await state(page)).registered, false);
      assert.doesNotMatch(
        await page.locator('.console pre').textContent(),
        /signed enrollment challenge/,
      );
      assert.equal(
        await page.locator('.console [data-action="debug"]').getAttribute('aria-pressed'),
        'false',
      );
      assert.equal(await row(page).locator('[data-action="connection"]').count(), 0);
      const deviceKey = (await state(page)).candidate_key;
      assert.notEqual(deviceKey, '00'.repeat(32));
      assert.match(await device(page, 'status'), /awaiting enrollment/);
      // Existing saved pending enrollment still requires an explicit approval.
      await page.reload();
      await wait(page);
      assert.equal((await state(page)).public_key, firstKey);
      assert.equal((await state(page)).registered, false);
      await control(page, 'approve');
      assert.equal((await state(page)).registered, true);
      assert.match(await device(page, 'status'), /Registration: registered/);
      assert.match(
        await device(page, 'consume 25'),
        /Insufficient credits: requested 25, available 0/,
      );
      assert.match(await page.locator('#notice').textContent(), /No credits consumed/);
      await control(page, 'debug');
      assert.equal(
        await page.locator('.console [data-action="debug"]').getAttribute('aria-pressed'),
        'true',
      );
      await click(page, '.device-row[data-serial="mcu-0001"] [data-action="issue"] button');
      assert.match(await device(page, 'status'), /Credits issued: 100/);
      assert.match(
        await page.locator('.console pre').textContent(),
        /Server → device: encrypted message/,
      );
      await control(page, 'debug');
      assert.doesNotMatch(
        await page.locator('.console pre').textContent(),
        /Server → device: encrypted message/,
      );
      assert.match(await page.locator('.console pre').textContent(), /Credits issued: 100/);
      // Enabling debug never creates an exchange; disabled logging did not
      // capture the earlier enrollment. Each console owns its own setting.
      await control(page, 'debug');
      assert.doesNotMatch(
        await page.locator('.console pre').textContent(),
        /signed enrollment challenge/,
      );
      assert.match(await device(page, 'consume 25'), /Consumed 25/);
      assert.equal((await state(page)).credits_consumed, '0');
      await device(page, 'sync');
      assert.equal((await state(page)).credits_consumed, '0');
      await control(page, 'request');
      assert.equal((await state(page)).credits_consumed, '25');
      assert.match(
        await device(page, 'consume 100'),
        /Insufficient credits: requested 100, available 75/,
      );
      await device(page, 'status');
      const commandInput = page.locator('.console input').first();
      assert.equal(await commandInput.evaluate((node) => node === document.activeElement), true);
      await commandInput.press('ArrowUp');
      assert.equal(await commandInput.inputValue(), 'status');
      await commandInput.press('ArrowUp');
      assert.equal(await commandInput.inputValue(), 'consume 100');
      await commandInput.press('ArrowDown');
      assert.equal(await commandInput.inputValue(), 'status');
      await commandInput.fill('');
      await control(page, 'power');
      await row(page).locator('input[name="total"]').fill('200');
      await click(page, '.device-row[data-serial="mcu-0001"] [data-action="issue"] button');
      await page.reload();
      await wait(page);
      assert.equal(await page.locator('.console input').first().isDisabled(), true);
      await control(page, 'power');
      const restored = await device(page, 'status');
      assert.match(restored, /Credits issued: 200/);
      assert.match(restored, /Credits consumed: 25/);
      assert.equal(
        await page.locator('.console [data-action="debug"]').getAttribute('aria-pressed'),
        'false',
      );
      assert.ok(restored.includes(deviceKey));
      await device(page, 'reboot');
      assert.match(await device(page, 'status'), /Credits remaining: 175/);
      await device(page, 'quit');
      assert.equal(await commandInput.isDisabled(), true);
      await control(page, 'power');
      await hideConsoles(page);
      assert.equal(await page.locator('.console').first().isVisible(), false);
      await control(page, 'open');
      assert.equal(await page.locator('.console').first().isVisible(), true);
      // Disconnection is independent of power. Consume locally and queue server
      // work without delivery, even through sync/reboot/reload, then reconnect.
      await control(page, 'connection');
      assert.match(await device(page, 'consume 5'), /Consumed 5/);
      await hideConsoles(page);
      await row(page).locator('input[name="total"]').fill('300');
      await click(page, '.device-row[data-serial="mcu-0001"] [data-action="issue"] button');
      await control(page, 'request');
      await device(page, 'sync');
      await device(page, 'reboot');
      assert.match(await device(page, 'status'), /Credits issued: 200/);
      assert.equal((await state(page)).credits_consumed, '25');
      await page.reload();
      await wait(page);
      assert.match(await device(page, 'status'), /Credits issued: 200/);
      assert.match(
        await row(page).locator('[data-field="connection"]').textContent(),
        /Disconnected/,
      );
      await control(page, 'connection');
      assert.match(await device(page, 'status'), /Credits issued: 300/);
      assert.equal((await state(page)).credits_consumed, '30');

      const window = page.locator('.console').first();
      const handle = window.locator('.drag-handle');
      const before = await window.boundingBox();
      const grip = await handle.boundingBox();
      await page.mouse.move(grip.x + 30, grip.y + 12);
      await page.mouse.down();
      await page.mouse.move(grip.x - 90, grip.y - 68, { steps: 8 });
      await page.mouse.up();
      const after = await window.boundingBox();
      assert.ok(after.x < before.x - 100 && after.y < before.y - 60);
      await handle.focus();
      await handle.press('ArrowRight');
      assert.equal(Math.round((await window.boundingBox()).x - after.x), 20);
      await handle.press('ArrowDown');
      const moved = await window.boundingBox();
      await hideConsoles(page);
      await control(page, 'open');
      assert.equal((await window.boundingBox()).x, moved.x);
      assert.equal((await window.boundingBox()).y, moved.y);
      assert.equal(await page.locator('#details').count(), 0);
      assert.equal(await page.locator('.chapter-banner a').count(), 4);
      assert.match(
        await page.locator('.chapter-banner a').nth(1).getAttribute('href'),
        /demo.html#establish-trust/,
      );
      await hideConsoles(page);
      await page.locator('#serial').fill('mcu-0002');
      await click(page, '#create-form button');
      assert.equal(await page.locator('.console').count(), 2);
      await control(page, 'debug');
      assert.equal(
        await page
          .locator('.console[data-serial="mcu-0001"] [data-action="debug"]')
          .getAttribute('aria-pressed'),
        'true',
      );
      assert.equal(
        await page
          .locator('.console[data-serial="mcu-0002"] [data-action="debug"]')
          .getAttribute('aria-pressed'),
        'false',
      );
      assert.equal((await state(page, 'mcu-0002')).credits_consumed, '0');
      assert.notEqual((await state(page, 'mcu-0002')).public_key, firstKey);
      await control(page, 'connection', 'mcu-0002');
      assert.match(
        await row(page, 'mcu-0002').locator('[data-field="connection"]').textContent(),
        /Disconnected/,
      );
      assert.match(
        await row(page).locator('[data-field="connection"]').textContent(),
        /Connection enabled/,
      );
      await control(page, 'begin', 'mcu-0002');
      assert.equal((await state(page, 'mcu-0002')).candidate_key, '00'.repeat(32));
      await control(page, 'connection', 'mcu-0002');
      assert.notEqual((await state(page, 'mcu-0002')).candidate_key, '00'.repeat(32));
      await control(page, 'open');
      await page.screenshot({ path: join(artifacts, `${name}-desktop.png`) });

      const secondTab = await context.newPage();
      await secondTab.goto(url);
      await secondTab.waitForFunction(() =>
        document.querySelector('#notice').textContent.includes('another tab'),
      );
      assert.equal(await secondTab.locator('#create-form button').first().isDisabled(), true);
      assert.equal(await secondTab.locator('#reset').isDisabled(), true);
      await secondTab.close();

      await page.reload();
      await wait(page);
      await hideConsoles(page);
      assert.equal((await state(page)).public_key, firstKey);
      assert.equal((await state(page)).credits_consumed, '30');
      assert.equal(await page.locator('#fleet-rows tr').count(), 2);
      await page.setViewportSize({ width: 390, height: 844 });
      await control(page, 'open');
      const mobileWindow = await page.locator('.console').first().boundingBox();
      assert.ok(mobileWindow.x >= 0 && mobileWindow.x + mobileWindow.width <= 390);
      assert.ok(mobileWindow.y >= 40 && mobileWindow.y + mobileWindow.height <= 844);
      // Check actual geometry with the input focused: neither its focus ring nor
      // titlebar controls may collide, even in a narrow mobile viewport.
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const panel = page.locator('.console').first();
        await panel.locator('input').focus();
        const prompt = await panel.locator('.console-prompt').boundingBox();
        const input = await panel.locator('input').boundingBox();
        assert.ok(input.y >= prompt.y + prompt.height + 7);
        const buttons = await panel.locator('.console-titlebar button').all();
        let right = 0;
        for (const button of buttons) {
          const box = await button.boundingBox();
          assert.ok(box.x >= right && box.x + box.width <= width - 8);
          right = box.x + box.width;
        }
        const form = await panel.locator('form').boundingBox();
        const output = await panel.locator('pre').boundingBox();
        assert.ok(output.y + output.height <= form.y + 1);
        assert.ok(input.y + input.height < form.y + form.height - 8);
      }
      await page.screenshot({ path: join(artifacts, `${name}-fleet.png`), fullPage: true });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );

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
          tx.objectStore('fleet').put({ serial: 'old-external', kind: 'external', phase: 'ready' });
          tx.oncomplete = resolve;
          tx.onabort = reject;
        });
        db.close();
      });
      await page.reload();
      await wait(page);
      await hideConsoles(page);
      assert.match(await row(page).locator('[data-field="error"]').textContent(), /storage/);
      assert.equal(await row(page).locator('[data-action="begin"]').isDisabled(), true);
      assert.equal(await page.locator('#fleet-rows tr').count(), 2);
      assert.equal(await page.getByRole('button', { name: 'old-external' }).count(), 0);
      // Reset is available even when one saved device is corrupt. Canceling
      // preserves identities; committing clears both stores, including legacy rows.
      await click(page, '#reset');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await page.locator('.device-row').count(), 2);
      await click(page, '#reset');
      await page.locator('#confirm-reset').click();
      await page.waitForFunction(() => document.querySelector('#fleet-rows').children.length === 0);
      await wait(page);
      assert.equal(await page.locator('.console').count(), 0);
      const counts = await page.evaluate(async () => {
        const db = await new Promise((resolve) => {
          const request = indexedDB.open('simple-crypts-fleet-v1', 1);
          request.onsuccess = () => resolve(request.result);
        });
        const counts = await Promise.all(
          ['fleet', 'endpoints'].map(
            (store) =>
              new Promise((resolve) => {
                const request = db.transaction(store).objectStore(store).count();
                request.onsuccess = () => resolve(request.result);
              }),
          ),
        );
        db.close();
        return counts;
      });
      assert.deepEqual(counts, [0, 0]);
      await page.reload();
      await wait(page);
      assert.equal(await page.locator('.device-row').count(), 0);
      await click(page, '#create-form button');
      assert.notEqual((await state(page)).public_key, firstKey);
      assert.deepEqual(errors, []);
      console.log(
        `${name}: console titlebar controls, debug logging, narrow-window layout, connections, reset and persistence passed.`,
      );
    } finally {
      await context.tracing.stop({ path: join(artifacts, `${name}-trace.zip`) });
      await browser.close();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
