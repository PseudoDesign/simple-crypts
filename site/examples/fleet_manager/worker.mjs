/* One owner, one serialized command queue, one fleet-wide Web Lock. Each
 * browser device and server peer has its own Wasm instance and identity.
 * The transport runs in response to user actions, never from a retry timer.
 */
import createServer from './server.mjs?v=6d550667e48da10bb61f';
import createDevice from './device.mjs?v=6d550667e48da10bb61f';
import {Endpoint, validSerial} from './endpoint.mjs?v=6d550667e48da10bb61f';
import {openDatabase, rows, saveRow, endpointStorage, clearFleet} from './storage.mjs?v=6d550667e48da10bb61f';
import {exchange} from './transport.mjs?v=6d550667e48da10bb61f';

const zeroKey = '00'.repeat(32);
const fleet = new Map();
const savedSerials = new Set();
let db;
let resolveReady, rejectReady;
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
ready.catch(() => {});

function log(entry, text, level = 'info') {
  // Debug output is opt-in per running console session. Command results and
  // errors are always retained; this preference never changes protocol work.
  if (level === 'debug' && !entry.debug) return;
  entry.activity.push(...text.split('\n').map(text => ({text, level})));
  entry.activity = entry.activity.slice(-200);
}

async function openEndpoint(row, role, fresh) {
  return Endpoint.open(role === 'server' ? createServer : createDevice,
    endpointStorage(db, row.serial, role, fresh), role, row.serial,
    role === 'server' ? zeroKey : row.serverKey, fresh);
}

async function synchronize(entry) {
  if (entry.row.connected === false) {
    log(entry, 'Connection disabled. Pending messages wait until you reconnect.');
    return;
  }
  try {
    await exchange(entry.server, entry.device, BigInt(Math.floor(Date.now() / 1000)), text => log(entry, text, 'debug'));
  } catch (error) {
    log(entry, `error: ${error.message}`);
    throw error;
  }
}

async function initialize() {
  db = await openDatabase();
  for (const row of await rows(db)) {
    savedSerials.add(row.serial);
    // Retired external entries are left untouched on disk. Never repurpose an
    // existing identity or delete user state when removing an example workflow.
    if (row.kind === 'external') continue;
    const entry = {row, activity: [], debug: false};
    fleet.set(row.serial, entry);
    try {
      validSerial(row.serial);
      if (row.phase !== 'ready' || row.kind !== 'browser')
        throw new Error('Incomplete or incompatible saved entry. No replacement identity was created.');
      entry.server = await openEndpoint(row, 'server', false);
      if (entry.server.state().public_key !== row.serverKey) throw new Error('Saved server identity mismatch.');
      if (row.running) entry.device = await openEndpoint(row, 'device', false);
      log(entry, row.running ? 'Device restored. Type help for commands.' : 'Device stopped. Saved state retained.');
    } catch (error) { entry.error = error.message; log(entry, `error: ${error.message}`); }
  }
  for (const entry of fleet.values()) {
    if (!entry.error && entry.device) {
      // A transport error does not invalidate the registry or regenerate keys.
      try { await synchronize(entry); } catch { /* Already recorded in console. */ }
    }
  }
}

if (!navigator.locks) rejectReady(new Error('Web Locks are required. Use HTTPS or localhost in a supported browser.'));
else navigator.locks.request('simple-crypts-fleet-v1', {ifAvailable: true}, async lock => {
  if (!lock) throw new Error('This saved fleet is open in another tab. Close that tab and reload.');
  await initialize();
  resolveReady();
  await new Promise(() => {}); // Worker lifetime owns the lock.
}).catch(rejectReady);

function view() {
  return Array.from(fleet.values(), ({row, server, device, error, activity, debug}) => ({
    serial: row.serial, running: Boolean(device), connected: row.connected !== false, error, activity, debug,
    server: server?.state(), device: device?.state(),
  }));
}

async function create(serial) {
  validSerial(serial);
  if (savedSerials.has(serial)) throw new Error('That serial exists in saved storage. Choose a different serial.');
  const row = {serial, kind: 'browser', phase: 'creating', running: true, connected: true};
  await saveRow(db, row, true);
  savedSerials.add(serial);
  const entry = {row, activity: [], debug: false};
  fleet.set(serial, entry);
  try {
    entry.server = await openEndpoint(row, 'server', true);
    row.serverKey = entry.server.state().public_key;
    entry.device = await openEndpoint(row, 'device', true);
    row.phase = 'ready';
    await saveRow(db, row);
    log(entry, 'Device ready. Type help for commands.');
    log(entry, 'Waiting for the server to authorize enrollment.');
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
  if (command === 'reset') {
    await clearFleet(db);
    fleet.clear();
    savedSerials.clear();
    return {};
  }
  if (command === 'create') { await create(serial); return {}; }
  const entry = fleet.get(serial);
  if (!entry) throw new Error('Unknown serial.');
  if (command === 'debug') {
    if (typeof args.enabled !== 'boolean') throw new Error('Debug setting must be boolean.');
    entry.debug = args.enabled;
    return {};
  }
  if (entry.error) throw new Error(entry.error);
  const now = BigInt(Math.floor(Date.now() / 1000));
  switch (command) {
    case 'connection': {
      if (typeof args.enabled !== 'boolean') throw new Error('Connection setting must be boolean.');
      const next = {...entry.row, connected: args.enabled};
      await saveRow(db, next);
      entry.row = next;
      log(entry, args.enabled ? 'Connection enabled.' : 'Connection disabled. Device power unchanged.');
      if (args.enabled) await synchronize(entry);
      return {};
    }
    case 'server': {
      const labels = {begin: 'Server authorized enrollment.', cancel: 'Server canceled enrollment.',
        approve: 'Server approved the device identity.', issue: `Server set issued total to ${args.total}.`,
        request: 'Server requested a fresh consumption report.'};
      if (!Object.hasOwn(labels, args.command)) throw new Error('Unknown server command.');
      await entry.server.server(args.command, args, now);
      log(entry, labels[args.command], 'debug');
      if (args.command !== 'cancel') await synchronize(entry);
      return {};
    }
    case 'console': {
      if (!entry.device) throw new Error('Device is stopped. Start it first.');
      log(entry, `> ${args.line}`);
      const result = await entry.device.console(args.line, now);
      log(entry, result.output);
      if (result.quit) await stop(entry);
      else if (result.sync) await synchronize(entry);
      return result;
    }
    case 'stop': await stop(entry); log(entry, 'Device stopped. Saved state retained.'); return {};
    case 'start': {
      if (!entry.device) {
        const device = await openEndpoint(entry.row, 'device', false);
        const next = {...entry.row, running: true};
        await saveRow(db, next);
        entry.row = next;
        entry.device = device;
        log(entry, 'Device started with saved identity and credits.');
      }
      await synchronize(entry);
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
