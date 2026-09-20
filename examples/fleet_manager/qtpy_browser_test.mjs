/* Real production Wasm server + real firmware application simulator. Only the
 * browser's USB port is replaced with a stream connected to the simulator. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, extname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { chromium, firefox } from '../../web/node_modules/playwright/index.mjs';
import { encode, decode, crc32 } from './qtpy-serial.mjs';

const root = resolve(process.argv[2]);
const binary = resolve(process.argv[3]);
const temporary = await mkdtemp(join(tmpdir(), 'qtpy-web-'));
const mime = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
};
const http = createServer(async (request, response) => {
  try {
    const path = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!path.startsWith(root + sep)) throw new Error('Outside site');
    response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    response.end(await readFile(path));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${http.address().port}/qtpy.html`;
let simulator,
  pending,
  packet = [],
  commands = [];
function boot() {
  simulator = spawn(binary, [join(temporary, 'flash.bin')], { stdio: ['pipe', 'pipe', 'inherit'] });
  packet = [];
  simulator.stdout.on('data', (bytes) => {
    for (const byte of bytes) {
      packet.push(byte);
      if (!byte) {
        pending?.(packet);
        pending = null;
        packet = [];
      }
    }
  });
}
async function stop() {
  const child = simulator;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin.end();
  await exited;
}
async function transfer(bytes) {
  if (bytes.length === 1 && bytes[0] === 0) return null;
  const command = decode(Uint8Array.from(bytes).subarray(0, -1))[3];
  commands.push(command);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Simulator response timeout')), 10000);
    pending = (reply) => {
      clearTimeout(timer);
      if (command === 3 && dropSetup) {
        dropSetup = false;
        reject(new Error('Injected lost setup response'));
      } else resolve(reply);
    };
    simulator.stdin.write(Uint8Array.from(bytes));
  });
}
async function attach(context) {
  await context.exposeBinding('qtTransfer', (_, bytes) => transfer(bytes));
  await context.addInitScript(() => {
    const serial = new EventTarget();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.qtFailRegistry && this.name === 'fleet') {
        throw new Error('Injected registry storage failure');
      }
      return put.apply(this, args);
    };
    serial.requestPort = async () => {
      if (window.qtDenyPort) throw new DOMException('Port selection cancelled', 'NotFoundError');
      let controller;
      return {
        async open() {
          this.readable = new ReadableStream({
            start(c) {
              controller = c;
            },
          });
          this.writable = new WritableStream({
            async write(bytes) {
              const result = await window.qtTransfer(Array.from(bytes));
              if (result) {
                const reply = Uint8Array.from(result);
                controller.enqueue(reply.subarray(0, 5));
                controller.enqueue(reply.subarray(5));
              }
            },
          });
        },
        async setSignals() {},
        async close() {},
      };
    };
    Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
  });
}
async function click(page, id) {
  await page.locator(`#qt-${id}`).click();
  await page.waitForFunction(
    () =>
      !document.querySelector('#qt-connect').disabled ||
      !document.querySelector('#qt-disconnect').disabled,
  );
}
async function notice(page, match) {
  await page.waitForFunction(
    (text) => document.querySelector('#qt-notice').textContent.includes(text),
    match,
  );
}
let dropSetup = false;
let browser;
try {
  boot();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await attach(context);
  let page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.evaluate(() => {
    window.qtDenyPort = true;
  });
  await click(page, 'connect');
  await notice(page, 'Port selection cancelled');
  await page.evaluate(() => {
    window.qtDenyPort = false;
  });
  await click(page, 'connect');
  await notice(page, 'Connected.');
  assert.equal(await page.locator('#qt-serial').textContent(), 'qtpy-simulator');
  await page.evaluate(() => {
    window.qtFailRegistry = true;
  });
  const writesBefore = commands.filter((command) => command !== 1).length;
  await click(page, 'register');
  await notice(page, 'Injected registry storage failure');
  assert.equal(commands.filter((command) => command !== 1).length, writesBefore);
  await page.evaluate(() => {
    window.qtFailRegistry = false;
  });
  await click(page, 'connect');
  dropSetup = true;
  await click(page, 'register');
  await notice(page, 'No command was retried');
  assert.equal(commands.filter((command) => command === 3).length, 1);
  await click(page, 'connect');
  const provisionedKey = await page.locator('#qt-key').textContent();
  await click(page, 'register');
  await notice(page, 'Enrollment response received.');
  assert.equal(await page.locator('#qt-key').textContent(), provisionedKey);
  assert.equal(commands.filter((command) => command === 3).length, 1);
  const key = await page.locator('#qt-key').textContent();
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(await page.locator('#qt-enrollment').textContent(), 'Awaiting approval');
  // Reload before approval must restore the same server identity and candidate.
  await click(page, 'disconnect');
  await page.reload();
  await click(page, 'connect');
  assert.equal(await page.locator('#qt-key').textContent(), key);
  await click(page, 'approve');
  await notice(page, 'Device approved.');
  await click(page, 'issue');
  await notice(page, 'Issued total saved');
  assert.equal(await page.locator('#qt-balance').textContent(), '100');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(globalThis.process.env.TEST_UNDECLARED_OUTPUTS_DIR ?? '/tmp', 'qtpy-browser.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  // Another tab must never own the persisted nonce state concurrently.
  const other = await context.newPage();
  await other.goto(url);
  await click(other, 'connect');
  await notice(other, 'Another QT Py tab');
  await other.close();
  await click(page, 'disconnect');
  await stop();
  boot();
  await page.reload();
  await click(page, 'connect');
  await click(page, 'status');
  await notice(page, 'Authenticated balance refreshed.');
  assert.equal(await page.locator('#qt-key').textContent(), key);
  assert.equal(await page.locator('#qt-balance').textContent(), '100');
  // Exact uint64 values must never round through JavaScript Number.
  await page.locator('#qt-total').fill('9007199254740993');
  await click(page, 'issue');
  assert.equal(await page.locator('#qt-balance').textContent(), '9007199254740993');
  await click(page, 'disconnect');
  // A different browser profile cannot replace the existing device/server pin.
  const foreign = await browser.newContext();
  await attach(foreign);
  const outsider = await foreign.newPage();
  await outsider.goto(url);
  const before = commands.length;
  await click(outsider, 'connect');
  await notice(outsider, 'trusts another host');
  assert.equal(await outsider.locator('#qt-register').isDisabled(), true);
  assert.deepEqual(commands.slice(before), [1]);
  await foreign.close();
  // Simulate a physical factory reset, then reconnect and explicitly register anew.
  const reset = new Uint8Array(12);
  reset.set([81, 84, 1, 7]);
  new DataView(reset.buffer).setUint32(4, 123);
  new DataView(reset.buffer).setUint32(8, crc32(reset.subarray(0, 8)));
  await transfer(Array.from(encode(reset)));
  await stop();
  boot();
  await click(page, 'connect');
  await click(page, 'register');
  const newKey = await page.locator('#qt-key').textContent();
  assert.notEqual(newKey, key);
  await click(page, 'approve');
  assert.equal(await page.locator('#qt-balance').textContent(), '0');
  assert.deepEqual(errors, []);
  await click(page, 'disconnect');
  await context.close();
  await browser.close();
  browser = null;
  const unsupported = await firefox.launch({ headless: true });
  try {
    const page = await unsupported.newPage();
    await page.addInitScript(() =>
      Object.defineProperty(navigator, 'serial', { value: undefined }),
    );
    await page.goto(url);
    await notice(page, 'Web Serial, Web Locks');
    assert.equal(await page.locator('#qt-connect').isDisabled(), true);
  } finally {
    await unsupported.close();
  }
  console.log(
    'QT Py browser enrollment, durable-host-before-setup, lost-response recovery, approval, reload, reboot, uint64, foreign host, tab lock, reset/re-enrollment, chooser cancellation, and unsupported-browser checks passed',
  );
} finally {
  await browser?.close();
  if (simulator?.exitCode === null) await stop();
  await new Promise((resolve) => http.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
