/* Production Wasm endpoints. Storage failures are injected at the real provider
 * boundary; no test cryptography or fake protocol responses are linked. */
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {Endpoint} from '../common/endpoint.mjs';
import {exchange} from './transport.mjs';

globalThis.crypto ??= webcrypto;
const serverFactory = (await import(pathToFileURL(resolve(process.argv[2])))).default;
const deviceFactory = (await import(pathToFileURL(resolve(process.argv[3])))).default;
const zero = '00'.repeat(32), now = 1900000000n;
const stores = new Map();
let failWrite = null;
const storage = key => ({
  async load() { return stores.get(key)?.slice(); },
  async save(bytes) {
    if (failWrite?.(key, bytes)) throw new Error('Injected transaction failure');
    stores.set(key, bytes.slice());
  },
});
const open = (role, serial, pin = zero, fresh = true) => Endpoint.open(
  role === 'server' ? serverFactory : deviceFactory,
  storage(`${role}:${serial}`), role, serial, pin, fresh);
const approve = server => {
  const candidate = server.state();
  return server.server('approve', {challenge: candidate.challenge, key: candidate.candidate_key}, now);
};

let server = await open('server', 'wasm-01');
let device = await open('device', 'wasm-01', server.state().public_key);
const identity = device.state().public_key;
assert.match((await device.console('help', now)).output, /sync/);
for (const command of ['tx', 'rx aabb', 'consume -1', 'consume 18446744073709551616', 'status extra'])
  assert.equal((await device.console(command, now)).error, true);
assert.equal((await device.console('sync', now)).sync, true);
assert.equal(await device.outbound(), null);
await server.server('begin', {}, now);
const events = [];
await exchange(server, device, now, text => events.push(text));
assert.equal(server.state().registered, false);
assert.equal(device.state().registered, false);
assert.equal(server.state().candidate_key, identity);
assert.match(events.join('\n'), /Awaiting server approval/);
await assert.rejects(server.server('approve', {challenge: zero, key: identity}, now));
await approve(server);
// A server restart before confirmation must recover through the same transport.
server = await open('server', 'wasm-01', zero, false);
await exchange(server, device, now);
assert.equal(device.state().registered, true);

await server.server('issue', {total: '100'}, now);
const grant = await server.outbound();
await device.receive(grant, now);
await exchange(server, device, now);
await device.receive(grant, now); // replay produces a reply, never extra credits
await exchange(server, device, now);
assert.equal(device.state().credits_issued, '100');
assert.match((await device.console('consume 25', now)).output, /Consumed 25/);
assert.equal(server.state().credits_consumed, '0');
assert.equal(await device.outbound(), null);
await exchange(server, device, now); // sync doesn't fabricate a status request
assert.equal(server.state().credits_consumed, '0');
await server.server('request', {}, now);
await exchange(server, device, now);
assert.equal(server.state().credits_consumed, '25');
assert.equal((await device.console('consume 76', now)).error, true);
assert.match((await device.console('status', now)).output, /Credits remaining: 75/);
assert.equal((await device.console('reboot', now)).sync, true);
device = await open('device', 'wasm-01', server.state().public_key, false);
assert.equal(device.state().public_key, identity);
assert.equal(device.state().credits_consumed, '25');

// Server work remains durable while a simulated device is stopped.
await server.server('issue', {total: '200'}, now);
await exchange(server, null, now);
assert.equal(device.state().credits_issued, '100');
await exchange(server, device, now);
assert.equal(device.state().credits_issued, '200');

// Different serials cannot receive each other's traffic, and stale sessions do
// not acquire enrollment approval through the transport.
const second = await open('server', 'wasm-02');
const other = await open('device', 'wasm-02', second.state().public_key);
assert.notEqual(second.state().public_key, server.state().public_key);
await assert.rejects(other.receive(grant, now));
await assert.rejects(other.receive(new Uint8Array(513), now));
await second.server('begin', {}, now);
await exchange(second, other, now);
await assert.rejects(exchange(second, other, now + 600n), /expired/);
await second.server('cancel', {}, now);
await assert.rejects(approve(second));
await second.server('begin', {}, now);
await exchange(second, other, now);
await approve(second);
await exchange(second, other, now);
await second.server('issue', {total: '18446744073709551615'}, now);
await exchange(second, other, now);
assert.equal(other.state().credits_issued, '18446744073709551615');
await other.console('consume 18446744073709551615', now);
await second.server('request', {}, now);
await exchange(second, other, now);
assert.equal(second.state().credits_consumed, '18446744073709551615');

// A failed debit is neither reported successful nor recovered as successful.
const before = stores.get('device:wasm-01').slice();
failWrite = key => key === 'device:wasm-01';
assert.equal((await device.console('consume 1', now)).error, true);
assert.deepEqual(stores.get('device:wasm-01'), before);
await assert.rejects(device.outbound());
failWrite = null;
device = await open('device', 'wasm-01', server.state().public_key, false);
assert.equal(device.state().credits_consumed, '25');

// Reservation failure exposes no frame. Restart burns unused reserved values.
await server.server('request', {}, now);
await device.receive(await server.outbound(), now);
const beforeReservation = stores.get('device:wasm-01').slice();
failWrite = key => key === 'device:wasm-01';
await assert.rejects(device.outbound());
assert.deepEqual(stores.get('device:wasm-01'), beforeReservation);
failWrite = null;
device = await open('device', 'wasm-01', server.state().public_key, false);
const report1 = await device.outbound();
device = await open('device', 'wasm-01', server.state().public_key, false);
const report2 = await device.outbound();
assert.notDeepEqual(report1.slice(38, 62), report2.slice(38, 62));
await server.receive(report2, now);
await exchange(server, device, now);

// A completed nonce reservation survives a later failed record commit.
await server.server('request', {}, now);
await device.receive(await server.outbound(), now);
device = await open('device', 'wasm-01', server.state().public_key, false);
const highWater = blob => new DataView(blob.buffer, blob.byteOffset).getBigUint64(186, false);
const oldHighWater = highWater(stores.get('device:wasm-01'));
let writes = 0;
failWrite = key => key === 'device:wasm-01' && ++writes === 2;
await assert.rejects(device.outbound());
assert.equal(writes, 2);
assert.equal(highWater(stores.get('device:wasm-01')), oldHighWater + 32n);
failWrite = null;
device = await open('device', 'wasm-01', server.state().public_key, false);
assert.ok(await device.outbound());
assert.equal(highWater(stores.get('device:wasm-01')), oldHighWater + 64n);
await assert.rejects(open('device', 'wasm-01', zero, false));
stores.set('device:wasm-01', new Uint8Array([1, 2]));
await assert.rejects(open('device', 'wasm-01', server.state().public_key, false));

// The action-driven transport has a finite limit even for a broken endpoint.
let count = 0;
const looping = {state: () => ({registered: true}),
  outbound: async () => { count++; return new Uint8Array([1]); }, receive: async () => {}};
await assert.rejects(exchange(looping, looping, now), /did not settle/);
assert.equal(count, 16);
console.log('Interactive transport, explicit approval, C++ commands, exact credits, persistence and nonce safety passed.');
