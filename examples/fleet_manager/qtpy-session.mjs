/** @module examples/fleet_manager/qtpy-session */
import { Endpoint, validSerial, uint64 } from './endpoint.mjs';
import { transaction, endpointStorage } from './storage.mjs';
import { commands } from './qtpy-serial.mjs';

const keyBytes = (hex) => Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
const now = () => BigInt(Math.floor(Date.now() / 1000));
/** Open a separate hardware-host database, without changing the simulated fleet.
 * @returns {Promise<IDBDatabase>} Persistent host store.
 */
export function openHardwareDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('simple-crypts-qtpy-v1', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('fleet', { keyPath: 'serial' });
      request.result.createObjectStore('endpoints');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other QT Py tabs to open storage.'));
    request.onsuccess = () => resolve(request.result);
  });
}
/** Persistent browser server paired with a physical QT Py; the caller owns the Web Lock. */
export class HardwareSession {
  /** Bind the private serial transport and production Wasm provider.
   * @param {object} link Private demo transport.
   * @param {IDBDatabase} db Host storage.
   * @param {Function} factory Production Wasm server factory.
   */
  constructor(link, db, factory) {
    this.link = link;
    this.db = db;
    this.factory = factory;
    this.server = null;
  }
  /** Inspect and restore only a matching saved host identity. Never replace a pin.
   * @returns {Promise<object>} Device diagnostics.
   */
  async connect() {
    this.device = await this.link.inspect();
    validSerial(this.device.serial);
    this.row = await transaction(this.db, 'fleet', 'readonly', (store) =>
      store.get(this.device.serial),
    );
    this.problem = '';
    if (this.device.fault)
      this.problem =
        'Device storage is faulted. Use the documented hardware reset procedure, then reconnect.';
    else if (
      this.device.provisioned &&
      (!this.row || this.row.serverKey !== this.device.server_key)
    )
      this.problem =
        'This device trusts another host. Use its original browser/profile or Python operator. To move it here, factory-reset the board first; this erases its identity and credits.';
    else if (this.row) {
      await this.restore(this.row);
    }
    return this.device;
  }
  /** Restore a saved host without opening or writing to the device.
   * @param {object} row Saved serial/session/server-key binding.
   * @returns {Promise<void>} Host restored; missing identities fail closed.
   */
  async restore(row) {
    validSerial(row.serial);
    this.row = row;
    this.server = await Endpoint.open(
      this.factory,
      endpointStorage(this.db, row.session, 'server', false),
      'server',
      row.serial,
      '00'.repeat(32),
      false,
    );
    if (this.server.state().public_key !== row.serverKey)
      throw new Error('Saved host identity mismatch. No replacement identity was created.');
  }
  /** Supply fresh per-boot entropy through the demo-only management channel.
   * @returns {Promise<void>} Device ready for management/protocol work.
   */
  async start() {
    this.device = await this.link.inspect();
    if (this.device.fault) throw new Error('Device storage is faulted.');
    if (!this.device.provisioned)
      throw new Error('Device was reset. Register it again before exchanging credits.');
    if (
      !this.server ||
      (this.device.provisioned && this.device.server_key !== this.server.state().public_key)
    )
      throw new Error('Device does not match this saved host. Reconnect and inspect.');
    if (!this.device.crypto_ready) {
      const entropy = crypto.getRandomValues(new Uint8Array(32));
      try {
        await this.link.command(commands.start, entropy);
      } finally {
        entropy.fill(0);
      }
    }
  }
  /** Begin or resume enrollment. Save host identity before sending a provisioning bundle.
   * @returns {Promise<void>} Candidate ready for explicit approval.
   */
  async register() {
    if (this.problem) throw new Error(this.problem);
    this.device = await this.link.inspect();
    if (this.device.fault) throw new Error('Device storage is faulted.');
    if (!this.device.provisioned && (!this.server || this.server.state().registered)) {
      const session = crypto.randomUUID();
      const server = await Endpoint.open(
        this.factory,
        endpointStorage(this.db, session, 'server', true),
        'server',
        this.device.serial,
        '00'.repeat(32),
        true,
      );
      const row = { serial: this.device.serial, session, serverKey: server.state().public_key };
      await transaction(this.db, 'fleet', 'readwrite', (store) => store.put(row));
      this.row = row;
      this.server = server;
    }
    if (!this.server) throw new Error('Missing saved host identity.');
    if (this.device.provisioned && this.device.server_key !== this.row.serverKey)
      throw new Error('Device trusts another host.');
    if (this.server.state().registered) {
      await this.start();
      await this.exchange();
      return;
    }
    await this.server.server('begin', {}, now());
    if (!this.device.provisioned) {
      const invitation = await this.server.outbound();
      if (!invitation || invitation.length !== 172)
        throw new Error('Missing signed enrollment invitation.');
      const bundle = new Uint8Array(96 + invitation.length);
      crypto.getRandomValues(bundle.subarray(0, 64));
      bundle.set(keyBytes(this.row.serverKey), 64);
      bundle.set(invitation, 96);
      try {
        await this.link.command(commands.setup, bundle);
      } finally {
        bundle.fill(0);
      }
    } else await this.start();
    await this.exchange();
  }
  /** Forward bounded opaque frames until idle or awaiting approval, without retries.
   * @returns {Promise<void>} Current diagnostics refreshed.
   */
  async exchange() {
    for (let pass = 0; pass < 32; pass++) {
      const outgoing = await this.server.outbound();
      if (outgoing) await this.link.command(commands.receive, outgoing);
      const incoming = await this.link.command(commands.outbound);
      if (incoming) await this.server.receive(incoming, now());
      const state = this.server.state();
      if ((!state.registered && state.candidate_revision !== '0') || (!outgoing && !incoming)) {
        this.device = await this.link.inspect();
        return;
      }
    }
    throw new Error('Exchange did not settle. Reconnect and inspect before trying again.');
  }
  /** Approve exactly the candidate currently displayed to the operator.
   * @param {object} candidate Displayed challenge and device key.
   * @returns {Promise<void>} Confirmation delivered to the board.
   */
  async approve(candidate) {
    await this.start();
    const state = this.server.state();
    if (
      state.challenge !== candidate.challenge ||
      state.candidate_key !== candidate.key ||
      candidate.key !== this.device.public_key
    )
      throw new Error('Enrollment identity changed. Register again and review the new identity.');
    await this.server.server('approve', candidate, now());
    await this.exchange();
  }
  /** Refresh the authenticated balance or issue an exact cumulative total.
   * @param {string} action request or issue.
   * @param {string} [total] Exact decimal total for issuance.
   * @returns {Promise<void>} Updated balance.
   */
  async update(action, total) {
    if (!['request', 'issue'].includes(action)) throw new Error('Unknown action.');
    if (action === 'issue') uint64(total);
    await this.start();
    if (!this.server.state().registered) throw new Error('Approve enrollment first.');
    await this.server.server(action, { total }, now());
    await this.exchange();
  }
}
