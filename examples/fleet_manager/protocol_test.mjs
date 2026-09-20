/* Production Wasm modules with a test storage implementation. The tests inject
 * failed writes at the provider boundary, without adding test crypto exports.
 */
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {Endpoint} from '../common/endpoint.mjs';

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

async function enrollment(server, device) {
  await server.server('begin', {}, now);
  const challenge = await server.server('tx', {}, now);
  assert.equal((await device.console(`rx ${challenge}`, now)).output, 'ok');
  const claim = (await device.console('tx', now)).output;
  await server.server('rx', {frame: claim}, now);
  const candidate = server.state();
  assert.equal(candidate.registered, false);
  await assert.rejects(server.server('approve', {challenge: zero, key: candidate.candidate_key}, now));
  await server.server('approve', {challenge: candidate.challenge, key: candidate.candidate_key}, now);
  return claim;
}

async function exchange(server, device) {
  const first = await server.server('tx', {}, now);
  assert.equal((await device.console(`rx ${first}`, now)).output, 'ok');
  const reply = (await device.console('tx', now)).output;
  await server.server('rx', {frame: reply}, now);
  const receipt = await server.server('tx', {}, now);
  assert.equal((await device.console(`rx ${receipt}`, now)).output, 'ok');
  return {first, reply};
}

let server = await open('server', 'wasm-01');
let device = await open('device', 'wasm-01', server.state().public_key);
assert.equal((await device.console('tx', now)).output, 'No output.');
const identity = device.state().public_key;
const claim = await enrollment(server, device);
// Confirmation is deliberately volatile in the core. A manual resend recovers
// an interrupted enrollment; do not serialize private runtime context fields.
server = await open('server', 'wasm-01', zero, false);
assert.equal(await server.server('tx', {}, now), 'No output.');
await server.server('rx', {frame: claim}, now);
await device.console(`rx ${await server.server('tx', {}, now)}`, now);
assert.equal(device.state().registered, true);
await server.server('issue', {total: '100'}, now);
assert.equal(device.state().credits_issued, '0'); // no automatic delivery
const issued = await exchange(server, device);
await device.console(`rx ${issued.first}`, now); // replay cannot add credits
assert.equal(device.state().credits_issued, '100');
await server.server('rx', {frame: (await device.console('tx', now)).output}, now);
await device.console(`rx ${await server.server('tx', {}, now)}`, now);
await device.console('consume 25', now);
assert.equal((await device.console('tx', now)).output, 'No output.');
assert.equal(server.state().credits_consumed, '0');
device = await open('device', 'wasm-01', server.state().public_key, false);
assert.equal(device.state().public_key, identity);
assert.equal(device.state().credits_consumed, '25');
assert.match((await device.console('consume 76', now)).output, /^error:/);
for (const text of ['consume -1', 'consume 18446744073709551616', 'rx abc', 'rx zz', 'rx ' + 'ab'.repeat(513)])
  assert.match((await device.console(text, now)).output, /^error:/);
await server.server('request', {}, now);
await exchange(server, device);
assert.equal(server.state().credits_consumed, '25');

// Independent identities and routing: a second serial cannot receive this grant.
const second = await open('server', 'wasm-02');
const other = await open('device', 'wasm-02', second.state().public_key);
assert.notEqual(second.state().public_key, server.state().public_key);
assert.match((await other.console(`rx ${issued.first}`, now)).output, /^error:/);
await second.server('begin', {}, now);
const invitation = await second.server('tx', {}, now);
await other.console(`rx ${invitation}`, now);
await assert.rejects(second.server('rx', {frame: (await other.console('tx', now)).output}, now + 600n));

// A failed debit must not be published or reappear after reopening.
const before = stores.get('device:wasm-01').slice();
failWrite = key => key === 'device:wasm-01';
assert.match((await device.console('consume 1', now)).output, /^error:/);
assert.deepEqual(stores.get('device:wasm-01'), before);
assert.match((await device.console('tx', now)).output, /^error:/);
failWrite = null;
device = await open('device', 'wasm-01', server.state().public_key, false);
assert.equal(device.state().credits_consumed, '25');

// Reservation failure returns no ciphertext. Restart must burn unused ranges.
await server.server('request', {}, now);
await device.console(`rx ${await server.server('tx', {}, now)}`, now);
const savedBefore = stores.get('device:wasm-01').slice();
failWrite = key => key === 'device:wasm-01';
assert.match((await device.console('tx', now)).output, /^error:/);
assert.deepEqual(stores.get('device:wasm-01'), savedBefore);
failWrite = null;
device = await open('device', 'wasm-01', server.state().public_key, false);
const report1 = (await device.console('tx', now)).output;
device = await open('device', 'wasm-01', server.state().public_key, false);
const report2 = (await device.console('tx', now)).output;
assert.notEqual(report1.slice(76, 124), report2.slice(76, 124));

// Reservation succeeded, but saving the sent-snapshot marker fails. Reopening
// must retain that already committed reservation, even though no frame escaped.
await server.server('rx', {frame: report2}, now);
await device.console(`rx ${await server.server('tx', {}, now)}`, now);
await server.server('request', {}, now);
await device.console(`rx ${await server.server('tx', {}, now)}`, now);
device = await open('device', 'wasm-01', server.state().public_key, false);
const highWater = blob => new DataView(blob.buffer, blob.byteOffset).getBigUint64(186, false);
const previousHighWater = highWater(stores.get('device:wasm-01'));
let writes = 0;
failWrite = key => key === 'device:wasm-01' && ++writes === 2;
assert.match((await device.console('tx', now)).output, /^error:/);
assert.equal(writes, 2);
const burnedHighWater = highWater(stores.get('device:wasm-01'));
assert.equal(burnedHighWater, previousHighWater + 32n);
failWrite = null;
device = await open('device', 'wasm-01', server.state().public_key, false);
const recovered = (await device.console('tx', now)).output;
assert.match(recovered, /^[0-9a-f]+$/);
assert.equal(highWater(stores.get('device:wasm-01')), burnedHighWater + 32n);

await assert.rejects(open('device', 'wasm-01', zero, false));
const checkpoint = stores.get('device:wasm-01');
stores.set('device:wasm-01', checkpoint.slice(0, 12));
await assert.rejects(open('device', 'wasm-01', server.state().public_key, false));
stores.set('device:wasm-01', checkpoint);

// The native example is Python. Exercise its real stdin/stdout interface against
// a Wasm server, using exactly the commands shown in the README and webpage.
if (process.argv[4]) {
  const directory = await mkdtemp(join(tmpdir(), 'simple-crypts-python-example-'));
  const external = await open('server', 'python-01');
  const child = spawn(resolve(process.argv[4]), ['--serial', 'python-01', '--store', join(directory, 'device'),
    '--server-key', external.state().public_key], {stdio: ['pipe', 'pipe', 'inherit']});
  const lines = createInterface({input: child.stdout})[Symbol.asyncIterator]();
  const read = async () => { const line = await lines.next(); assert.equal(line.done, false); return line.value; };
  const command = async text => { child.stdin.write(text + '\n'); return read(); };
  try {
    assert.match(await read(), /^help/);
    await external.server('begin', {}, now);
    assert.equal(await command('rx ' + await external.server('tx', {}, now)), 'ok');
    await external.server('rx', {frame: await command('tx')}, now);
    const candidate = external.state();
    await external.server('approve', {challenge: candidate.challenge, key: candidate.candidate_key}, now);
    assert.equal(await command('rx ' + await external.server('tx', {}, now)), 'ok');
    await external.server('issue', {total: '18446744073709551615'}, now);
    await command('rx ' + await external.server('tx', {}, now));
    await external.server('rx', {frame: await command('tx')}, now);
    await command('rx ' + await external.server('tx', {}, now));
    await command('consume 25');
    await command('reboot');
    assert.equal(JSON.parse(await command('status')).credits_consumed, '25');
    await external.server('request', {}, now);
    await command('rx ' + await external.server('tx', {}, now));
    await external.server('rx', {frame: await command('tx')}, now);
    await command('rx ' + await external.server('tx', {}, now));
    assert.equal(external.state().credits_consumed, '25');
    await command('quit');
  } finally { child.kill(); await rm(directory, {recursive: true, force: true}); }
}
console.log('Fleet production Wasm, persistence, manual transport, and Python interoperability passed.');
