/* Physical-board page: one Web Lock owns the host database and one selected port.
 * This trusted static page never exports private provider checkpoints or logs bundles.
 */
import createServer from './server.mjs?v=d41a01869d5c9434b1eb';
import { SerialLink } from './qtpy-serial.mjs?v=d41a01869d5c9434b1eb';
import { HardwareSession, openHardwareDatabase } from './qtpy-session.mjs?v=d41a01869d5c9434b1eb';

const el = (id) => document.getElementById(`qt-${id}`);
const supported =
  globalThis.isSecureContext &&
  navigator.serial &&
  navigator.locks &&
  globalThis.crypto?.getRandomValues;
let session,
  link,
  db,
  unlock,
  busy = false,
  candidate;
function render() {
  const state = session?.device;
  const server = session?.server?.state();
  const usable = state && !session.problem && !state.fault;
  el('connect').disabled = busy || Boolean(link) || !supported;
  el('disconnect').disabled = busy || !link;
  el('inspect').disabled = busy || !link;
  el('register').disabled = busy || !usable || Boolean(state.provisioned && server?.registered);
  candidate =
    server && server.candidate_revision !== '0' && !server.registered
      ? { challenge: server.challenge, key: server.candidate_key }
      : null;
  el('approve').disabled = busy || !usable || !candidate;
  el('issue').disabled = el('status').disabled = busy || !usable || !server?.registered;
  el('serial').textContent = state?.serial ?? 'Not connected';
  el('enrollment').textContent = !state
    ? '—'
    : state.registered
      ? 'Registered'
      : state.provisioned
        ? 'Awaiting approval'
        : 'Not registered';
  el('key').textContent = state?.provisioned ? state.public_key : '—';
  el('balance').textContent = !state
    ? '—'
    : !state.ready
      ? 'Reconnect and resume to read saved balance'
      : (BigInt(state.issued) - BigInt(state.consumed)).toString();
}
async function disconnect() {
  if (link) await link.close().catch(() => {});
  link = null;
  session = null;
  db?.close();
  db = null;
  unlock?.();
  unlock = null;
}
async function action(work, message) {
  if (busy) return;
  busy = true;
  render();
  try {
    await work();
    el('notice').textContent = session?.problem || message;
  } catch (error) {
    el('notice').textContent = error.message;
    await disconnect();
  } finally {
    busy = false;
    render();
  }
}
async function lock() {
  await new Promise((resolve, reject) => {
    navigator.locks
      .request('simple-crypts-qtpy-owner-v1', { ifAvailable: true }, async (owner) => {
        if (!owner) {
          reject(
            new Error(
              'Another QT Py tab owns this browser’s hardware session. Disconnect it first.',
            ),
          );
          return;
        }
        await new Promise((release) => {
          unlock = release;
          resolve();
        });
      })
      .catch(reject);
  });
}
el('connect').addEventListener('click', () => {
  // Request the chooser within the user gesture, before asynchronous database work.
  if (busy || link) return;
  const selection = navigator.serial.requestPort({
    filters: [{ usbVendorId: 0x2e8a, usbProductId: 0x000a }],
  });
  action(async () => {
    const port = await selection;
    await lock();
    db = await openHardwareDatabase();
    link = new SerialLink(port);
    await link.open();
    session = new HardwareSession(link, db, createServer);
    await session.connect();
  }, 'Connected. Register a new device, or refresh the balance to resume a saved enrollment.');
});
el('disconnect').addEventListener('click', () =>
  action(disconnect, 'Disconnected. Device and browser identities are retained.'),
);
el('inspect').addEventListener('click', () =>
  action(async () => {
    session.device = await link.inspect();
  }, 'Device inspected without flash writes.'),
);
el('register').addEventListener('click', () =>
  action(
    () => session.register(),
    'Enrollment response received. Review the device identity, then approve.',
  ),
);
el('approve').addEventListener('click', () => {
  const displayed = candidate;
  action(() => session.approve(displayed), 'Device approved. You can now issue credits.');
});
el('issue-form').addEventListener('submit', (event) => {
  event.preventDefault();
  action(
    () => session.update('issue', el('total').value),
    'Issued total saved and delivered to the device.',
  );
});
el('status').addEventListener('click', () =>
  action(() => session.update('request'), 'Authenticated balance refreshed.'),
);
navigator.serial?.addEventListener('disconnect', (event) => {
  if (event.target === link?.port || event.port === link?.port) {
    link.fail(new Error('USB device disconnected.'));
    if (!busy)
      action(disconnect, 'USB disconnected. Reconnect to inspect; no command was retried.');
  }
});
el('notice').textContent = supported
  ? 'Choose your QT Py serial port to begin.'
  : 'Web Serial, Web Locks, and secure randomness are required. Open this page over HTTPS or localhost in desktop Chrome or Edge. iPad browsers are not supported.';
render();
