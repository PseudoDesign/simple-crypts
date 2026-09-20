import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium, firefox } from 'playwright';
const root = resolve(process.argv[2] || 'bazel-bin/web/site');
const mime = {
  '.html': 'text/html',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
const server = createServer(async (req, res) => {
  try {
    let route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (!route.startsWith('/simple-crypts/')) {
      res.writeHead(404);
      return res.end();
    }
    route = route.slice('/simple-crypts/'.length);
    const missingWasm = route.startsWith('missing-wasm/');
    if (missingWasm) route = route.slice('missing-wasm/'.length);
    if (missingWasm && route.endsWith('.wasm')) {
      res.writeHead(503);
      return res.end('Wasm unavailable');
    }
    if (!route || route.endsWith('/')) route += 'index.html';
    const file = resolve(root, route);
    if (!file.startsWith(root + sep)) throw new Error('Invalid path');
    res.setHeader('Content-Type', mime[extname(file)] || 'text/plain');
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/simple-crypts/`;
const demoURL = base + 'demo.html';
const artifacts = resolve(
  process.env.TEST_UNDECLARED_OUTPUTS_DIR ||
    process.env.BROWSER_ARTIFACTS_DIR ||
    '/tmp/simple-crypts-browser-artifacts',
);
await mkdir(artifacts, { recursive: true });
const contexts = new Map();
let contextNumber = 0;
async function monitoredContext(browser, options = {}, expectedFailure = false) {
  const context = await browser.newContext(options),
    record = {
      name: `${browser.browserType().name()}-${++contextNumber}`,
      issues: [],
      expectedFailure,
    };
  contexts.set(context, record);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  context.on('page', (page) => {
    page.setDefaultTimeout(12000);
    page.on('pageerror', (error) => record.issues.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico'))
        record.issues.push(`console: ${message.text()}`);
    });
  });
  context.on('requestfailed', (request) => {
    if (!/ABORTED|NS_BINDING_ABORTED/.test(request.failure()?.errorText ?? ''))
      record.issues.push(`request: ${request.url()} ${request.failure()?.errorText}`);
  });
  context.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico'))
      record.issues.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  return context;
}
async function closeContext(context) {
  const record = contexts.get(context);
  if (!record.expectedFailure)
    assert.deepEqual(record.issues, [], record.name + ' background errors');
  await context.tracing.stop({ path: resolve(artifacts, record.name + '.zip') });
  await writeFile(resolve(artifacts, record.name + '.json'), JSON.stringify(record, null, 2));
  contexts.delete(context);
  await context.close();
}
async function captureFailure(error) {
  for (const [context, record] of contexts) {
    for (const [index, page] of context.pages().entries()) {
      const stem = resolve(artifacts, `${record.name}-failure-${index}`);
      await page.screenshot({ path: stem + '.png', fullPage: true }).catch(() => {});
      await writeFile(stem + '.html', await page.content().catch(() => ''));
    }
    await writeFile(
      resolve(artifacts, record.name + '-failure.json'),
      JSON.stringify({ ...record, error: error.stack }, null, 2),
    );
    await context.tracing
      .stop({ path: resolve(artifacts, record.name + '-failure.zip') })
      .catch(() => {});
  }
}
async function apiReference(page) {
  const manifest = JSON.parse(await readFile(resolve(root, 'demo.json'), 'utf8'));
  if (manifest.format_version < 4) return;
  await page.goto(base);
  await page.getByRole('link', { name: 'C API', exact: true }).click();
  await page.locator('#MSearchField').waitFor();
  assert.match(await page.title(), /Simple Crypts C API/);
  await page.locator('#MSearchField').pressSequentially('sc_consume_credits');
  const result = page
    .locator('#MSearchResultsWindow a')
    .filter({ hasText: 'sc_consume_credits' })
    .first();
  await result.waitFor({ state: 'visible' });
  await result.click();
  await page.waitForURL(/api\/.*html/);
  assert.match(await page.locator('body').innerText(), /SC_ERR_CONFLICT/);
  if (manifest.api_assets['api/bindings.html']) {
    for (const [language, query] of [
      ['python', 'consume_credits'],
      ['go', 'ConsumeCredits'],
      ['javascript', 'outbound'],
    ]) {
      await page.goto(base + `api/${language}/index.html`);
      await page.getByRole('searchbox').fill(query);
      const entries = page.locator('article:visible');
      assert.ok((await entries.count()) > 0, `${language} API search has results`);
      for (const entry of await entries.allTextContents())
        assert.ok(entry.toLowerCase().includes(query.toLowerCase()));
      await page.getByRole('link', { name: 'All bindings', exact: true }).click();
      await page.getByRole('link', { name: 'Rust', exact: true }).waitFor();
    }
    await page.goto(base + 'api/rust/simplecrypts/struct.Endpoint.html');
    assert.match(await page.locator('body').innerText(), /consume_credits/);
    const search = page.locator('input.search-input');
    await search.fill('consume_credits');
    await search.press('Enter');
    await page
      .locator('.search-results a')
      .filter({ hasText: 'consume_credits' })
      .first()
      .waitFor();
  }
  await page.goto(base + 'api/');
  await page.getByRole('link', { name: 'Home and demos', exact: true }).click();
  assert.equal(new URL(page.url()).pathname, '/simple-crypts/index.html');
}
async function landing(page) {
  const requests = [];
  const record = (request) => requests.push(request.url());
  page.on('request', record);
  await page.goto(base);
  await page.locator('#credits-demo').waitFor();
  assert.equal(await page.title(), 'Simple Crypts · Small APIs. Real cryptography.');
  assert.deepEqual(await page.locator('.language-grid dt').allTextContents(), [
    'C',
    'Python',
    'Rust',
    'Go',
  ]);
  assert(await page.locator('#start-demo').isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert(
    !requests.some((url) => /\.wasm|worker\.mjs|app\.mjs/.test(url)),
    'Landing must not initialize the demo runtime',
  );
  page.off('request', record);
  await page.locator('#credits-demo').click();
  await ready(page);
  assert.equal(await page.locator('body').getAttribute('data-chapter'), 'credits');
  assert.equal((await state(page, 'device')).registered, 'true');
  assert.equal(await page.locator('#message-log .packet').count(), 0);
  await page.locator('#chapter-fleet').click();
  await page.waitForFunction(
    () => document.querySelector('#create-form button')?.disabled === false,
  );
  await page.goBack();
  await ready(page);
  await page.reload();
  await ready(page);
  assert.equal(await page.locator('body').getAttribute('data-chapter'), 'credits');
  await page.getByRole('link', { name: 'Simple Crypts home', exact: true }).click();
  await page.locator('#start-demo').click();
  await ready(page);
  assert.equal(await page.locator('body').getAttribute('data-chapter'), 'trust');
  await page.locator('#chapter-fleet').click();
  await page.waitForFunction(
    () => document.querySelector('#create-form button')?.disabled === false,
  );
  await page.goBack();
  await ready(page);
  console.log(
    'PASS landing: lightweight overview, direct credits, reload, home and enrollment navigation',
  );
}

async function ready(page) {
  await page.waitForFunction(
    () => document.body.dataset.ready === 'true' && document.body.dataset.busy === 'false',
  );
  assert(await page.locator('#error').isHidden(), await page.locator('#error').textContent());
  const record = contexts.get(page.context());
  if (record && !record.expectedFailure)
    assert.deepEqual(record.issues, [], record.name + ' background errors');
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Unexpected horizontal scrolling',
  );
}
async function state(page, role) {
  return Object.fromEntries(
    (await page.locator('#' + role + '-details').textContent())
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(':');
        return [line.slice(0, at), line.slice(at + 1).trim()];
      }),
  );
}
async function assertNext(page, label) {
  assert.equal(await page.locator('#next').textContent(), label);
  assert(await page.locator('#next').isEnabled());
}

async function next(page) {
  await page.locator('#next').click();
  await ready(page);
}
const pending = (page) => page.locator('.outbox .packet[data-pending="true"]').first();
const saved = (page) => page.locator('#message-log .packet[data-pending="false"]').first();
async function dragPacket(page, packet, target, touch = false) {
  const trayHeights = await page
    .locator('.outbox .message-tray')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  const packetId = await packet.getAttribute('data-packet');
  if (Number(packetId) > 0) {
    const sender = await packet.getAttribute('data-from');
    assert.equal(
      await page.locator(`#${sender}-outbox .packet[data-packet="${packetId}"]`).count(),
      1,
    );
    assert.equal(await page.locator('#message-log .packet[data-pending="true"]').count(), 0);
  }
  const handle = packet.locator('[data-select]');
  await handle.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox(),
    to = await page.locator(target).boundingBox(),
    viewport = page.viewportSize();
  const a = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const b = {
    x: to.x + to.width / 2,
    y: Math.max(
      to.y + 8,
      Math.min(
        to.y + to.height - 8,
        Math.max(280, Math.min(viewport.height - 16, to.y + to.height / 2)),
      ),
    ),
  };
  const before = await page.evaluate(
    () =>
      document.querySelector('#message-log .packet[data-pending="false"]')?.dataset.packet ?? null,
  );
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [a] });
    for (let i = 1; i <= 12; i++)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: a.x + ((b.x - a.x) * i) / 12, y: a.y + ((b.y - a.y) * i) / 12 }],
      });
    assert(await page.locator('.touch-packet').isVisible());
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + 12, a.y, { steps: 4 });
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await page.mouse.up();
  }
  await page.waitForFunction(
    (old) =>
      document.querySelector('#message-log .packet[data-pending="false"]')?.dataset.packet !== old,
    before,
  );
  await ready(page);
  assert.equal(await page.locator('.touch-packet,.drag-over').count(), 0);
  assert.deepEqual(
    await page
      .locator('.outbox .message-tray')
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height)),
    trayHeights,
  );
  if (Number(packetId) > 0) {
    assert.equal(await page.locator(`.outbox .packet[data-packet="${packetId}"]`).count(), 0);
    assert.equal(await page.locator(`#message-log .packet[data-packet="-${packetId}"]`).count(), 1);
  }
}
async function generate(page) {
  const emptyHeights = await page
    .locator('.endpoint')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  assert.equal(await page.locator('.outbox-empty').count(), 2);
  assert.equal(await page.locator('#device-public-key').textContent(), 'Not generated yet');
  assert.equal(await page.locator('#device-unique-id').textContent(), 'mcu-0001');
  assert.equal(
    await page.locator('#pinned-server-key').textContent(),
    await page.locator('#server-public-key').textContent(),
  );
  await next(page);
  assert.equal(await page.locator('#device-public-key').textContent(), 'Not generated yet');
  assert.deepEqual(
    await page
      .locator('.endpoint')
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height)),
    emptyHeights,
  );
  assert.equal(await pending(page).count(), 1);
  assert.equal(await page.locator('#server-outbox .packet').count(), 1);
  assert.equal(await page.locator('#device-outbox .packet,#message-log .packet').count(), 0);
}
async function corrupt(packet) {
  const button = packet.locator('[data-action="corrupt"]');
  await button.click();
}
async function creditFlow(page, touch = false) {
  if ((await page.locator('body').getAttribute('data-chapter')) !== 'credits') {
    assert.equal(await page.locator('#device-issued').textContent(), '0');
    const key = await page.locator('#device-public-key').textContent();
    await next(page);
    assert.equal(await page.locator('#device-public-key').textContent(), key);
  }
  assert.equal(await page.locator('body').getAttribute('data-chapter'), 'credits');
  assert.equal(await page.locator('#chapter-credits').getAttribute('aria-current'), 'step');
  assert.equal(await page.locator('#message-log .packet').count(), 0);
  assert.equal(await page.locator('#device-status').textContent(), 'Confirmed');
  assert(await page.locator('#next').isHidden());
  assert(await page.locator('#add-credit').isEnabled());
  assert(await page.locator('#consume-credit').isDisabled());
  await page.locator('#add-credit').click();
  await ready(page);
  assert(await page.locator('#add-credit').isDisabled());
  const grantId = await pending(page).getAttribute('data-packet');
  await dragPacket(page, pending(page), '#device-panel', touch);
  assert.equal(await page.locator('#device-issued').textContent(), '100');
  const grant = page.locator(`.packet[data-packet="-${grantId}"]`);
  await dragPacket(page, grant, '#device-panel', touch);
  assert.equal(await page.locator('#device-issued').textContent(), '100');
  await assertNext(page, 'Create status report →');
  await next(page);
  await dragPacket(page, pending(page), '#server-panel', touch);
  assert.equal(await page.locator('#server-consumed').textContent(), '0');
  await assertNext(page, 'Create receipt →');
  await next(page);
  assert.match(await pending(page).textContent(), /Receipt for request/);
  assert(!/Credits consumed/.test(await pending(page).textContent()));
  await dragPacket(page, pending(page), '#device-panel', touch);
  assert(await page.locator('#next').isHidden());
  await page.locator('#consume-credit').click();
  await ready(page);
  assert.equal(await pending(page).count(), 0);
  assert.equal(await page.locator('#device-consumed').textContent(), '25');
  assert.equal(await page.locator('#server-consumed').textContent(), '0');
  await assertNext(page, 'Request current status →');
  await next(page);
  await dragPacket(page, pending(page), '#device-panel', touch);
  await assertNext(page, 'Create status report →');
  await next(page);
  await corrupt(pending(page));
  await dragPacket(page, pending(page), '#server-panel', touch);
  assert.match(await page.locator('#server-result').textContent(), /authentication/);
  assert.equal(await page.locator('#server-consumed').textContent(), '0');
  await corrupt(saved(page));
  await dragPacket(page, saved(page), '#server-panel', touch);
  assert.equal(await page.locator('#server-consumed').textContent(), '25');
  await assertNext(page, 'Create receipt →');
  await next(page);
  await dragPacket(page, pending(page), '#device-panel', touch);
  assert.equal((await state(page, 'device')).pending, 'false');
  assert.equal((await state(page, 'server')).pending, 'false');
  assert.match(await page.locator('#tour-title').textContent(), /Credit exchange complete/);
}
async function errorFlow(page, touch = false) {
  if (!touch) {
    await page.locator('#add-credit').click();
    await ready(page);
    assert.equal(await page.locator('#server-issued').textContent(), '200');
    assert.equal(await page.locator('#device-issued').textContent(), '100');
    await dragPacket(page, pending(page), '#device-panel');
    await page.locator('#consume-credit').click();
    await ready(page);
    assert.equal(await page.locator('#device-consumed').textContent(), '50');
    assert.equal(await page.locator('#server-consumed').textContent(), '25');
    assert.equal(await pending(page).count(), 0);
  }
  const issued = await page.locator('#device-issued').textContent();
  let consumed = BigInt(await page.locator('#device-consumed').textContent());
  const reported = await page.locator('#server-consumed').textContent();
  await next(page);
  assert(await page.locator('#next').isHidden());
  assert.match(await page.locator('#tour-text').textContent(), /Press \+ beside/);
  while (consumed + 25n <= BigInt(issued)) {
    await page.locator('#consume-credit').click();
    await ready(page);
    consumed += 25n;
    assert.equal(await page.locator('#device-consumed').textContent(), consumed.toString());
    assert(await page.locator('#next').isHidden());
  }
  await page.locator('#consume-credit').click();
  await ready(page);
  assert.match(await page.locator('#tour-text').textContent(), /^conflict \(-7\)/);
  assert.equal(await page.locator('#device-consumed').textContent(), consumed.toString());
  assert.equal(await page.locator('#server-consumed').textContent(), reported);
  assert.equal(await pending(page).count(), 0);
  assert(await page.locator('#consume-credit').isDisabled());
  await next(page);
  const grantTotal = (BigInt(issued) + 100n).toString();
  assert.match(await page.locator('#tour-title').textContent(), /Drop this credit packet/);
  const droppedWire = await pending(page).locator('pre').textContent();
  const requestId = (await state(page, 'server')).request_id;
  assert.equal((await state(page, 'server')).pending, 'true');
  const deviceBefore = await page.locator('#device-details').textContent();
  const serverBefore = await page.locator('#server-details').textContent();
  await pending(page).locator('[data-action="drop"]').click();
  await ready(page);
  assert.equal(await page.locator('#device-details').textContent(), deviceBefore);
  assert.equal(await page.locator('#server-details').textContent(), serverBefore);
  assert.match(await page.locator('#tour-text').textContent(), /no receive error/);
  assert.equal(await pending(page).count(), 0);
  assert.match(await saved(page).textContent(), /dropped/);
  await next(page);
  assert.notEqual(
    await pending(page).locator('pre').textContent(),
    droppedWire,
    'Retry must use a fresh nonce',
  );
  assert.equal((await state(page, 'server')).request_id, requestId);
  await dragPacket(page, pending(page), '#device-panel', touch);
  assert.equal(await page.locator('#device-issued').textContent(), grantTotal);
  assert.match(await page.locator('#tour-title').textContent(), /again/);
  await dragPacket(page, saved(page), '#device-panel', touch);
  assert.equal(await page.locator('#device-issued').textContent(), grantTotal);
  assert.match(await page.locator('#device-result').textContent(), /ok \(0\)/);
  await next(page);
  await dragPacket(page, pending(page), '#server-panel', touch);
  assert.equal(await page.locator('#server-consumed').textContent(), consumed.toString());
  await next(page);
  await dragPacket(page, pending(page), '#device-panel', touch);
  assert.equal((await state(page, 'device')).pending, 'false');
  assert.equal((await state(page, 'server')).pending, 'false');
  assert.match(await page.locator('#tour-title').textContent(), /Exercise complete/);
  assert.equal(await page.locator('#chapter-sandbox').count(), 0);
  assert.equal(await page.locator('#next').textContent(), 'Restart credits ↺');
  assert.equal(await page.locator('#device-consumed').textContent(), consumed.toString());
}

async function cancelledDrag(page, touch = false) {
  const pendingBefore = await page.locator('.outbox').allTextContents();
  const before = await page.locator('#message-log').textContent(),
    device = await state(page, 'device'),
    server = await state(page, 'server');
  const box = await pending(page).locator('[data-select]').boundingBox();
  const a = { x: box.x + box.width / 2, y: box.y + 20 },
    b = { x: a.x + 20, y: a.y - 20 };
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [a] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [b] });
    assert(await page.locator('.touch-packet').isVisible());
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    assert(await page.locator('.touch-packet').isVisible());
    await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  await ready(page);
  assert.equal(await page.locator('.touch-packet,.drag-over').count(), 0);
  assert.deepEqual(await page.locator('.outbox').allTextContents(), pendingBefore);
  assert.equal(await page.locator('#message-log').textContent(), before);
  assert.deepEqual(await state(page, 'device'), device);
  assert.deepEqual(await state(page, 'server'), server);
  // A tap/click is not a delivery either.
  await pending(page).locator('[data-select]').click();
  await ready(page);
  assert.equal(await pending(page).count(), 1);
}
async function lifecycle(page, touch = false) {
  assert.deepEqual(await page.locator('.chapter-banner a[id]').allTextContents(), [
    '1 · Establish trust',
    '2 · Credits',
    '3 · Fleet',
  ]);
  assert.match(
    await page.locator('#chapter-fleet').getAttribute('href'),
    /examples\/fleet_manager\//,
  );
  assert(await page.locator('#add-credit').isHidden());
  assert(await page.locator('#consume-credit').isHidden());
  await generate(page);
  await cancelledDrag(page, touch);
  // The message details are visible on the actual draggable box.
  assert.match(await pending(page).textContent(), /Serial: mcu-0001/);
  assert.match(await pending(page).textContent(), /Expires: .*UTC/);
  const key = await page.locator('#server-public-key').textContent();
  await page.locator('#reset').click();
  await ready(page);
  assert.notEqual(await page.locator('#server-public-key').textContent(), key);
  assert.equal(await page.locator('#message-log .packet').count(), 0);
  // A clean enrollment without corruptions or replays, including explicit approval.
  await generate(page);
  await dragPacket(page, pending(page), '#device-panel', touch);
  await next(page);
  await dragPacket(page, pending(page), '#server-panel', touch);
  assert.equal((await state(page, 'server')).registered, 'false');
  assert.equal((await state(page, 'device')).registered, 'false');
  await assertNext(page, 'Approve this serial + key →');
  await next(page);
  assert.equal((await state(page, 'server')).registered, 'true');
  assert.equal((await state(page, 'device')).registered, 'false');
  await assertNext(page, 'Create confirmation →');
  await next(page);
  await dragPacket(page, pending(page), '#device-panel', touch);
  assert.equal((await state(page, 'device')).registered, 'true');
  // Switching chapter discards pending work; reload starts fresh enrollment.
  await page.locator('#chapter-credits').click();
  await ready(page);
  await page.locator('#add-credit').click();
  await ready(page);
  await page.locator('#chapter-trust').click();
  await ready(page);
  assert.equal(await page.locator('#message-log .packet').count(), 0);
  assert.equal(await page.locator('#device-public-key').textContent(), 'Not generated yet');
  await page.reload();
  await ready(page);
  assert.equal(await page.locator('body').getAttribute('data-chapter'), 'trust');
  console.log(
    'PASS lifecycle',
    touch ? 'touch' : 'mouse',
    ': cancellation, clean enrollment, reset, chapter switch, reload',
  );
}

try {
  for (const [name, type] of [
    ['chromium', chromium],
    ['firefox', firefox],
  ]) {
    const browser = await type.launch({ headless: true });
    try {
      const context = await monitoredContext(browser, {
          viewport: { width: 1366, height: 768 },
          reducedMotion: 'reduce',
        }),
        page = await context.newPage(),
        errors = [];
      page.setDefaultTimeout(10000);
      page.on('pageerror', (e) => errors.push(e.message));
      await apiReference(page);
      await landing(page);
      await lifecycle(page);
      for (const chapter of ['trust']) {
        assert(await page.locator('#message-log').isVisible());
        assert.equal(await page.locator('#drop-target').count(), 0);
        assert.equal(await page.locator('.inbox,#deliver,.show-tip').count(), 0);
        await page.locator('#hide-tip').click();
        await page.locator('#chapter-' + chapter).click();
        assert(await page.locator('#guide-popup').isVisible());
        await generate(page);
        const state = await page.locator('#device-details').textContent();
        const original = await pending(page).locator('pre').textContent();
        await corrupt(pending(page));
        await corrupt(pending(page));
        assert.equal(await pending(page).locator('pre').textContent(), original);
        await corrupt(pending(page));
        await dragPacket(page, pending(page), '#device-panel');
        assert.match(
          await page.locator('#device-result').textContent(),
          /authentication \(-3\).*authentication failed/,
        );
        assert.equal(await page.locator('#device-details').textContent(), state);
        assert.equal(await page.locator('#device-public-key').textContent(), 'Not generated yet');
        assert(await page.locator('#restart-enrollment').isVisible());
        // Turn corruption off on the rejected attempt; exact original bytes are restored.
        await corrupt(saved(page));
        await dragPacket(page, saved(page), '#device-panel');
        assert.match(await page.locator('#device-result').textContent(), /ok \(0\)/i);
        assert(!(await page.locator('#next').isDisabled()));
        await next(page);
        assert.match(await page.locator('#device-public-key').textContent(), /^[a-f0-9]{64}$/);
        await dragPacket(page, pending(page), '#server-panel');
        assert.match(await page.locator('#server-summary').textContent(), /Awaiting approval/);
        assert.equal(await page.locator('#server-consumed').textContent(), 'Not reported');
        // Replay is legitimate and idempotent here: expose success, not a fabricated error.
        await dragPacket(page, saved(page), '#server-panel');
        assert.match(
          await page.locator('#server-result').textContent(),
          /ok \(0\).*no newer state/i,
        );
        assert.equal(await page.locator('#server-consumed').textContent(), 'Not reported');
        await next(page);
        assert.equal(await page.locator('#server-consumed').textContent(), 'Not reported');
        await next(page);
        await dragPacket(page, pending(page), '#device-panel');
        assert.equal(await page.locator('#device-status').textContent(), 'Confirmed');
        assert.match(await page.locator('#tour-title').textContent(), /Enrollment complete/);
        assert.equal(await page.locator('#chapter-attack').count(), 0);
        assert.match(
          await page.locator('#tour-text').textContent(),
          /Continue to credits.*retry enrollment.*corrupt.*server time/,
        );
        const enrolledState = await page.locator('#server-details').textContent();
        await page.locator('#advance-time').click();
        await ready(page);
        assert.equal(await page.locator('#server-details').textContent(), enrolledState);
        assert.match(
          await page.locator('#clock-result').textContent(),
          /Completed enrollment stays valid/,
        );
        await corrupt(saved(page));
        await dragPacket(page, saved(page), '#device-panel');
        assert.match(await page.locator('#device-result').textContent(), /authentication/);
        await corrupt(saved(page));
        assert.equal(await page.locator('#next').textContent(), 'On to credits →');
        await dragPacket(page, saved(page), '#device-panel');
        assert.match(
          await page.locator('#device-result').textContent(),
          /ok \(0\).*no newer state/i,
        );
        // Reflect the saved server confirmation back to the server and surface its actual error.
        await dragPacket(page, saved(page), '#server-panel');
        assert.match(await page.locator('#server-result').textContent(), /\(-\d+\).*Rejected/);
        await creditFlow(page);
        await errorFlow(page);
        await page.screenshot({
          path: `/tmp/simple-crypts-${name}-${chapter}-log.png`,
          fullPage: true,
        });
        console.log('PASS', name, chapter, 'log workflow');
      }
      // Credits is independently accessible, with actual enrollment completed as setup.
      await page.locator('#chapter-trust').click();
      await ready(page);
      await page.locator('#chapter-credits').click();
      await ready(page);
      await creditFlow(page);
      await errorFlow(page);
      await next(page);
      assert.equal(await page.locator('#device-issued').textContent(), '0');
      assert.equal(await page.locator('#message-log .packet').count(), 0);
      await page.locator('#chapter-trust').click();
      await ready(page);
      // Advancing simulated server time alone does not call receive. A later response fails expiry.
      await page.locator('#reset').click();
      await ready(page);
      await generate(page);
      await dragPacket(page, pending(page), '#device-panel');
      await next(page);
      const identity = await page.locator('#device-public-key').textContent();
      const beforeClock = await page.locator('#server-details').textContent();
      await page.locator('#advance-time').click();
      await ready(page);
      assert.equal(await page.locator('#server-details').textContent(), beforeClock);
      await dragPacket(page, pending(page), '#server-panel');
      assert.match(await page.locator('#server-result').textContent(), /enrollment \(-10\)/);
      assert.equal(await page.locator('#server-consumed').textContent(), 'Not reported');
      for (let i = 0; i < 18; i++) await dragPacket(page, saved(page), '#server-panel');
      assert.equal(await page.locator('#message-log .packet').count(), 16);
      assert.match(await page.locator('#tour-text').textContent(), /expired/);
      await page.locator('#restart-enrollment').click();
      await ready(page);
      assert.equal(await page.locator('#device-public-key').textContent(), identity);
      assert.equal(await page.locator('#message-log .packet').count(), 0);
      await next(page);
      await dragPacket(page, pending(page), '#device-panel');
      await next(page);
      await dragPacket(page, pending(page), '#server-panel');
      await next(page);
      await next(page);
      await dragPacket(page, pending(page), '#device-panel');
      assert.equal(await page.locator('#device-status').textContent(), 'Confirmed');
      assert.equal(await page.locator('#restart-enrollment').textContent(), 'Retry enrollment ↺');
      await page.locator('#restart-enrollment').click();
      await ready(page);
      assert.equal(await page.locator('#device-public-key').textContent(), 'Not generated yet');
      assert.equal(await page.locator('#message-log .packet').count(), 0);
      assert.equal(await page.locator('body').getAttribute('data-chapter'), 'trust');
      await generate(page);
      assert.equal((await page.request.get(base + 'report/')).status(), 200);
      assert.deepEqual(errors, []);
      await closeContext(context);
      if (name === 'chromium') {
        const touch = await monitoredContext(browser, {
            viewport: { width: 390, height: 844 },
            hasTouch: true,
          }),
          t = await touch.newPage();
        await landing(t);
        await lifecycle(t, true);
        await generate(t);
        await corrupt(pending(t));
        await dragPacket(t, pending(t), '#device-panel', true);
        assert.match(await t.locator('#device-result').textContent(), /\(-3\)/);
        await corrupt(saved(t));
        await dragPacket(t, saved(t), '#device-panel', true);
        await next(t);
        await dragPacket(t, pending(t), '#server-panel', true);
        await next(t);
        await next(t);
        await dragPacket(t, pending(t), '#device-panel', true);
        assert.equal(await t.locator('#device-status').textContent(), 'Confirmed');
        assert(await t.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const nextBox = await t.locator('#next').boundingBox(),
          retryBox = await t.locator('#restart-enrollment').boundingBox();
        assert(
          Math.abs(nextBox.y - retryBox.y) < 4,
          'Completion actions should be side by side on touchscreens',
        );
        await t.screenshot({ path: '/tmp/simple-crypts-enrollment-complete.png', fullPage: true });
        await creditFlow(t, true);
        await errorFlow(t, true);
        await t.screenshot({ path: '/tmp/simple-crypts-touch-log.png', fullPage: true });
        await closeContext(touch);
      }
      const unavailable = await monitoredContext(browser, {}, true);
      await unavailable.addInitScript(() =>
        Object.defineProperty(globalThis, 'crypto', { value: undefined }),
      );
      const p = await unavailable.newPage();
      await p.goto(demoURL);
      await p.locator('#error').waitFor({ state: 'visible' });
      assert.match(await p.locator('#error').textContent(), /randomness/);
      await closeContext(unavailable);
      const loading = await monitoredContext(browser);
      let releaseLoad;
      const loadGate = new Promise((resolve) => {
        releaseLoad = resolve;
      });
      await loading.route('**/endpoint.wasm.wasm*', async (route) => {
        await loadGate;
        await route.continue();
      });
      const loadingPage = await loading.newPage();
      await loadingPage.goto(demoURL);
      await loadingPage.waitForFunction(() => document.body.dataset.busy === 'true');
      assert(await loadingPage.locator('#next').isDisabled());
      assert.equal(
        await loadingPage.locator('#chapter-credits').getAttribute('aria-disabled'),
        'true',
      );
      const disabledLink = await loadingPage.locator('#chapter-credits').boundingBox();
      await loadingPage.mouse.click(
        disabledLink.x + disabledLink.width / 2,
        disabledLink.y + disabledLink.height / 2,
      );
      assert.equal(await loadingPage.locator('body').getAttribute('data-chapter'), 'trust');
      releaseLoad();
      await ready(loadingPage);
      await generate(loadingPage);
      await closeContext(loading);
      // Fail on the HTTP server too: Firefox may recover routed fetch failures via sync XHR.
      const broken = await monitoredContext(browser, {}, true);
      const brokenPage = await broken.newPage();
      await brokenPage.goto(base + 'missing-wasm/demo.html');
      await brokenPage.locator('#error').waitFor({ state: 'visible' });
      assert.match(
        await brokenPage.locator('#error').textContent(),
        /runtime failed|load|fetch|wasm|WebAssembly|Aborted/i,
      );
      assert(await brokenPage.locator('#next').isDisabled());
      await closeContext(broken);
      console.log(
        `PASS ${name}: sender outboxes, attempt log, reversible corruption, direct replay, real result codes, challenge before keygen, rejection recovery, expiry, bounded history`,
      );
    } catch (error) {
      await captureFailure(error);
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
}
