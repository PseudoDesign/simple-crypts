import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { Endpoint } from './endpoint.mjs';
globalThis.crypto = webcrypto;
const factory = (await import(pathToFileURL(resolve(process.argv[2])))).default;
const production = (await import(pathToFileURL(resolve(process.argv[3])))).default;
const native = resolve(process.argv[4]);
const secret = '33'.repeat(32);
let checks = 0;
async function wasm(role, peer, override = {}) {
  const module = await factory();
  const e = new Endpoint(module);
  const r = await e.command('init', {
    role,
    secret,
    server_public_key: peer,
    testSeed: (role === 'device' ? '11' : '22').repeat(32),
    ...override,
  });
  assert.equal(r.code, 0);
  return e;
}
async function pair() {
  const s = await wasm('server');
  return [await wasm('device', s.state().public_key), s];
}
async function ok(e, cmd, args = {}) {
  const r = await e.command(cmd, args);
  assert.equal(r.code, 0, r.status);
  return r;
}
async function tx(e) {
  return (await ok(e, 'tx')).frame;
}
async function move(a, b) {
  return ok(b, 'rx', { frame: await tx(a) });
}
async function scenario(name, fn) {
  await fn();
  checks++;
  console.log('PASS ' + name);
}
await scenario('challenge verification before keygen and secure entropy requirement', async () => {
  const server = await wasm('server');
  await ok(server, 'enrollment_enable');
  await ok(server, 'enrollment_begin', { now: 100, expires: 700 });
  const frame = await tx(server);
  const d = new Endpoint(await production()),
    args = { frame, server_public_key: server.state().public_key, serial: 'mcu-0001' };
  assert((await d.command('generate_from_challenge')).code < 0);
  const bad = frame.slice();
  bad[171] ^= 1;
  assert.equal((await d.command('verify_challenge', { ...args, frame: bad })).code, -3);
  assert.equal(d.state(), null);
  await ok(d, 'verify_challenge', args);
  const rng = globalThis.crypto;
  globalThis.crypto = undefined;
  await assert.rejects(() => d.command('generate_from_challenge'), /randomness/);
  globalThis.crypto = rng;
  const key = await d.command('generate_from_challenge');
  assert.equal(key.code, 0);
  const other = new Endpoint(await production());
  await ok(other, 'verify_challenge', args);
  assert.notEqual((await other.command('generate_from_challenge')).public_key, key.public_key);
  await ok(d, 'init', { role: 'device', secret, server_public_key: server.state().public_key });
  await ok(d, 'enrollment_enable');
  await ok(d, 'rx', { frame });
  const response = await tx(d);
  assert.equal((await server.command('rx', { frame: response, now: 701 })).code, -10);
  await ok(server, 'rx', { frame: response, now: 101 });
  assert(!server.state().registered);
  await ok(server, 'enrollment_approve', {
    challenge: server.state().challenge,
    key: key.public_key,
    now: 102,
  });
  await move(server, d);
  assert(d.state().registered);
});
await scenario(
  'credits, frozen responses, reboot, exact integers and no unsolicited reports',
  async () => {
    const [d, s] = await pair();
    await move(d, s);
    await move(s, d);
    await ok(s, 'issue', { total: '18446744073709551615' });
    const grant = await tx(s);
    await ok(d, 'rx', { frame: grant });
    await ok(d, 'consume', { amount: '9007199254740993' });
    await move(d, s);
    assert.equal(s.state().credits_consumed, '0');
    await move(s, d);
    assert.equal((await d.command('tx')).code, 1);
    await ok(d, 'rx', { frame: grant });
    await move(d, s);
    await move(s, d);
    assert.equal(s.state().credits_consumed, '0');
    await ok(d, 'reboot');
    assert.equal(d.state().credits_consumed, '9007199254740993');
    await ok(s, 'request');
    await move(s, d);
    await move(d, s);
    await move(s, d);
    assert.equal(s.state().credits_consumed, '9007199254740993');
    const state = d.state();
    d.m._scw_test_fail(1);
    assert.equal((await d.command('consume', { amount: '1' })).code, -5);
    assert.deepEqual(d.state(), state);
    await assert.rejects(() => d.command('consume', { amount: 9007199254740992 }), /exact uint64/);
    assert((await d.command('consume', { amount: '18446744073709551615' })).code < 0);
    await ok(s, 'request');
    const f = await tx(s);
    assert(
      (await d.command('rx', { frame: f.map((v, i) => (i === f.length - 1 ? v ^ 1 : v)) })).code <
        0,
    );
    await ok(d, 'rx', { frame: f });
    assert.equal((await d.command('tx', { budget: 1 })).code, -2);
    await move(d, s);
    await move(s, d);
  },
);
class Native {
  constructor(dir) {
    this.child = spawn(native, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.waiters = [];
    this.dir = dir;
    createInterface({ input: this.child.stdout }).on('line', (line) =>
      this.waiters.shift()?.resolve(JSON.parse(line)),
    );
    this.child.on('exit', (code) => {
      for (const p of this.waiters) p.reject(new Error('native exited ' + code));
      this.waiters = [];
    });
  }
  command(command, args = {}) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify({ command, ...args }) + '\n');
    });
  }
  close() {
    this.child.stdin.end();
    this.child.kill();
  }
}
for (const role of ['device', 'server'])
  await scenario(`native C and Wasm ${role} exact ciphertext`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-web-')),
      n = new Native(dir),
      mirror = new Native(dir);
    try {
      const server = await wasm('server'),
        w = role === 'server' ? server : await wasm('device', server.state().public_key),
        nativeRole = role === 'server' ? 'device' : 'server';
      for (const [e, r, path] of [
        [n, nativeRole, 'native'],
        [mirror, role, 'mirror'],
      ])
        assert.equal(
          (
            await e.command('init', {
              role: r,
              storage: join(dir, path),
              serial: 'mcu-0001',
              secret,
              key_seed: (r === 'device' ? '11' : '22').repeat(32),
              ...(r === 'device' ? { server_public_key: server.state().public_key } : {}),
            })
          ).status,
          'ok',
        );
      const sendW = async () => {
        const f = await tx(w),
          m = await mirror.command('tx');
        assert.equal(Buffer.from(f).toString('base64'), m.frame);
        assert.equal((await n.command('rx', { frame: m.frame })).status, 'ok');
      };
      const sendN = async () => {
        const f = await n.command('tx');
        assert.equal(f.status, 'ok');
        await ok(w, 'rx', { frame: Uint8Array.from(Buffer.from(f.frame, 'base64')) });
        assert.equal((await mirror.command('rx', { frame: f.frame })).status, 'ok');
      };
      if (role === 'device') {
        await sendW();
        await sendN();
        await n.command('issue', { total: '100' });
        await sendN();
        await sendW();
        await sendN();
        await ok(w, 'consume', { amount: '25' });
        await mirror.command('consume', { amount: '25' });
        await n.command('request');
        await sendN();
        await sendW();
        await sendN();
      } else {
        await sendN();
        await sendW();
        await ok(w, 'issue', { total: '100' });
        await mirror.command('issue', { total: '100' });
        await sendW();
        await sendN();
        await sendW();
        await n.command('consume', { amount: '25' });
        await ok(w, 'request');
        await mirror.command('request');
        await sendW();
        await sendN();
        await sendW();
      }
    } finally {
      n.close();
      mirror.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
console.log(`${checks} WebAssembly scenarios passed`);
