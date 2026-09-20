/* One runtime owner, one serialized command queue, one fleet-wide Web Lock.
 * Each endpoint gets a separate Wasm memory and independent identity. There is
 * deliberately no relay/pump: only explicit tx and rx commands move bytes.
 */
import createServer from './server.mjs?v=43851a847fb842c03057';
import createDevice from './device.mjs?v=43851a847fb842c03057';
import {Endpoint, validSerial} from './endpoint.mjs?v=43851a847fb842c03057';
import {openDatabase, rows, saveRow, endpointStorage} from './storage.mjs?v=43851a847fb842c03057';

const zeroKey = '00'.repeat(32);
const fleet = new Map();
let db;
let resolveReady, rejectReady;
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
// Attach a handler immediately; a locked second tab may initialize before its
// first request arrives. Requests still observe the original rejected promise.
ready.catch(() => {});

async function openEndpoint(row, role, fresh) {
  return Endpoint.open(role === 'server' ? createServer : createDevice,
    endpointStorage(db, row.serial, role, fresh), role, row.serial,
    role === 'server' ? zeroKey : row.serverKey, fresh);
}

async function initialize() {
  db = await openDatabase();
  for (const row of await rows(db)) {
    const entry = {row};
    fleet.set(row.serial, entry);
    try {
      validSerial(row.serial);
      if (row.phase !== 'ready' || !['browser', 'external'].includes(row.kind))
        throw new Error('Incomplete or incompatible saved entry. State was retained; no replacement identity was created.');
      entry.server = await openEndpoint(row, 'server', false);
      if (entry.server.state().public_key !== row.serverKey) throw new Error('Saved server identity mismatch.');
      if (row.kind === 'browser' && row.running) entry.device = await openEndpoint(row, 'device', false);
    } catch (error) { entry.error = error.message; }
  }
}

if (!navigator.locks) rejectReady(new Error('Web Locks are required. Use HTTPS or localhost in a supported browser.'));
else navigator.locks.request('simple-crypts-fleet-v1', {ifAvailable: true}, async lock => {
  if (!lock) throw new Error('This saved fleet is open in another tab. Close that tab and reload.');
  await initialize();
  resolveReady();
  // The dedicated worker dies with its page; then the browser releases the lock.
  await new Promise(() => {});
}).catch(rejectReady);

function view() {
  return Array.from(fleet.values(), ({row, server, device, error}) => ({
    serial: row.serial, kind: row.kind, running: Boolean(device), error,
    server: server?.state(), device: device?.state(),
  }));
}

async function create(serial, kind) {
  validSerial(serial);
  if (!['browser', 'external'].includes(kind)) throw new Error('Invalid device kind.');
  if (fleet.has(serial)) throw new Error('That serial already exists.');
  const row = {serial, kind, phase: 'creating', running: kind === 'browser'};
  // Reserve the serial first. A crash leaves an explicit incomplete entry,
  // rather than silently regenerating an identity on the next page load.
  await saveRow(db, row, true);
  const entry = {row};
  fleet.set(serial, entry);
  try {
    entry.server = await openEndpoint(row, 'server', true);
    row.serverKey = entry.server.state().public_key;
    if (kind === 'browser') entry.device = await openEndpoint(row, 'device', true);
    row.phase = 'ready';
    await saveRow(db, row);
  } catch (error) { entry.error = error.message; throw error; }
}

async function stop(entry) {
  const next = {...entry.row, running: false};
  await saveRow(db, next);
  entry.row = next;
  entry.device = undefined;
}

async function dispatch({command, serial, args = {}}) {
  if (command === 'list') return {};
  if (command === 'create') { await create(serial, args.kind); return {}; }
  const entry = fleet.get(serial);
  if (!entry) throw new Error('Unknown serial.');
  if (entry.error) throw new Error(entry.error);
  const now = BigInt(Math.floor(Date.now() / 1000));
  switch (command) {
    case 'server': return {output: await entry.server.server(args.command, args, now)};
    case 'console': {
      if (!entry.device) throw new Error('Device is stopped. Start it first.');
      const result = await entry.device.console(args.line, now);
      if (result.quit) await stop(entry);
      return result;
    }
    case 'stop': await stop(entry); return {};
    case 'start': {
      if (entry.row.kind !== 'browser') throw new Error('Run external devices in your Python terminal.');
      if (!entry.device) {
        const device = await openEndpoint(entry.row, 'device', false);
        const next = {...entry.row, running: true};
        await saveRow(db, next);
        entry.row = next;
        entry.device = device;
      }
      return {};
    }
    default: throw new Error('Unknown fleet command.');
  }
}

let queue = Promise.resolve();
self.onmessage = ({data}) => {
  queue = queue.then(async () => {
    try {
      await ready;
      const result = await dispatch(data);
      self.postMessage({id: data.id, result: {...result, fleet: view()}});
    } catch (error) {
      self.postMessage({id: data.id, error: error.message, fleet: view()});
    }
  });
};
