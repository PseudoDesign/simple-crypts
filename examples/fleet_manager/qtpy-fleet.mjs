/** @module examples/fleet_manager/qtpy-fleet */
import createServer from './server.mjs';
import { SerialLink } from './qtpy-serial.mjs';
import { HardwareSession, openHardwareDatabase } from './qtpy-session.mjs';
import { rows } from './storage.mjs';

/** Physical peers in the fleet UI; one owner shares storage with the standalone page. */
export class HardwareFleet {
  /** Create a manager without requesting device permission.
   * @param {Function} changed Notify the UI that public views changed.
   */
  constructor(changed) {
    this.changed = changed;
    this.entries = new Map();
    this.supported = Boolean(
      globalThis.isSecureContext && navigator.serial && navigator.locks && crypto?.getRandomValues,
    );
    this.ready = false;
    this.problem = '';
    navigator.serial?.addEventListener('disconnect', (event) => {
      for (const entry of this.entries.values()) {
        if (entry.link && (event.target === entry.link.port || event.port === entry.link.port)) {
          entry.link.fail(new Error('USB device disconnected.'));
          entry.error = 'USB disconnected. Reconnect and inspect; no command was retried.';
          this.record(entry, entry.error);
          // Active commands own cleanup until they finish; otherwise release immediately.
          if (!entry.busy) this.disconnect(entry).finally(() => this.changed());
        }
      }
    });
  }
  /** Restore saved peers under the same Web Lock used by the standalone QT Py page.
   * @returns {Promise<void>} Ready, or a hardware-only failure message.
   */
  async initialize() {
    if (!this.supported) {
      this.problem =
        'QT Py USB requires desktop Web Serial over HTTPS or localhost. Simulated devices remain available.';
      return;
    }
    try {
      await new Promise((resolve, reject) => {
        navigator.locks
          .request('simple-crypts-qtpy-owner-v1', { ifAvailable: true }, async (lock) => {
            if (!lock) {
              reject(
                new Error(
                  'Another fleet or QT Py tab owns the USB host data. Close it and reload to manage hardware here.',
                ),
              );
              return;
            }
            await new Promise((release) => {
              this.release = release;
              resolve();
            });
          })
          .catch(reject);
      });
      this.db = await openHardwareDatabase();
      for (const row of await rows(this.db)) {
        const session = new HardwareSession(null, this.db, createServer);
        const entry = { serial: row.serial, session, activity: [], link: null };
        this.entries.set(row.serial, entry);
        try {
          await session.restore(row);
          this.record(entry, 'Saved QT Py host restored. Connect USB to manage this board.');
        } catch (error) {
          entry.error = error.message;
        }
      }
      this.ready = true;
    } catch (error) {
      this.problem = error.message;
      this.db?.close();
      this.release?.();
    }
  }
  /** Copy public state for the shared fleet table and read-only activity panel.
   * @returns {Array<object>} Physical peer views.
   */
  view() {
    return Array.from(this.entries.values(), (entry) => ({
      id: `qtpy:${entry.serial}`,
      kind: 'qtpy',
      serial: entry.serial,
      connected: Boolean(entry.link && !entry.link.failed),
      running: Boolean(entry.link && !entry.link.failed),
      error: entry.error || entry.session.problem,
      activity: entry.activity,
      debug: false,
      server: entry.session.server?.state(),
      device: entry.session.device,
    }));
  }
  /** Append a bounded public activity message.
   * @param {object} entry Physical peer.
   * @param {string} text User-visible activity.
   */
  record(entry, text) {
    entry.activity.push({ text, level: 'info' });
    entry.activity = entry.activity.slice(-200);
  }
  /** Close USB without erasing either identity or altering physical device power.
   * @param {object} entry Physical peer.
   * @returns {Promise<void>} Port released.
   */
  async disconnect(entry) {
    const link = entry.link;
    entry.link = null;
    entry.session.link = null;
    if (link) await link.close().catch(() => {});
  }
  /** Connect the selected port, optionally requiring the saved row's serial.
   * @param {SerialPort} port Port selected within a user gesture.
   * @param {string} [expected] Serial of the row being reconnected.
   * @returns {Promise<string>} Actual device serial; no enrollment is automatic.
   */
  async connect(port, expected) {
    if (!this.ready) throw new Error(this.problem || 'Hardware host is not ready.');
    const link = new SerialLink(port);
    let entry;
    try {
      await link.open();
      const device = await link.inspect();
      if (expected && expected !== device.serial)
        throw new Error('Selected port belongs to another device. Choose the matching board.');
      const previous = this.entries.get(device.serial);
      if (previous?.link) throw new Error('This board is already connected.');
      const session = new HardwareSession(link, this.db, createServer);
      entry = { serial: device.serial, session, link, activity: previous?.activity ?? [] };
      this.entries.set(device.serial, entry);
      await session.connect();
      this.record(
        entry,
        session.problem ||
          'USB connected. Register or resume enrollment in this row, or request a report.',
      );
      return device.serial;
    } catch (error) {
      if (entry) {
        entry.error = error.message;
        await this.disconnect(entry);
      } else await link.close().catch(() => {});
      throw error;
    } finally {
      this.changed();
    }
  }
  /** Execute one hardware row action. Never synthesize console commands or reset a board.
   * @param {string} serial Physical serial.
   * @param {string} command Fleet command.
   * @param {object} [args] Server action parameters.
   * @returns {Promise<object>} Completion for the shared UI.
   */
  async command(serial, command, args = {}) {
    const entry = this.entries.get(serial);
    if (!entry) throw new Error('Unknown QT Py.');
    if (command === 'connection' && args.enabled === false) {
      await this.disconnect(entry);
      this.record(entry, 'USB disconnected. Device power, credits, and enrollment are retained.');
      this.changed();
      return {};
    }
    if (!entry.link || entry.link.failed) throw new Error('Connect this QT Py over USB first.');
    if (entry.error || entry.session.problem) throw new Error(entry.error || entry.session.problem);
    entry.busy = true;
    try {
      if (command === 'inspect') {
        entry.session.device = await entry.link.inspect();
        const state = entry.session.device;
        this.record(
          entry,
          `Device identity: ${state.public_key}\nIssued: ${state.issued}; consumed: ${state.consumed}; ready: ${state.ready}; storage fault: ${state.fault}`,
        );
      } else if (command === 'server') {
        switch (args.command) {
          case 'begin':
            await entry.session.register();
            this.record(
              entry,
              'Enrollment response received. Review the device identity and approve it in the fleet table.',
            );
            break;
          case 'approve':
            await entry.session.approve(args);
            this.record(entry, 'Device enrollment approved and confirmation delivered.');
            break;
          case 'issue':
          case 'request':
            await entry.session.update(args.command, args.total);
            this.record(
              entry,
              args.command === 'issue'
                ? 'Cumulative issued total delivered.'
                : 'Authenticated consumption report received.',
            );
            break;
          default:
            throw new Error('This control is not available for a physical QT Py.');
        }
      } else
        throw new Error(
          'Use the physical BOOT button to consume credits; this panel shows activity only.',
        );
      return {};
    } catch (error) {
      entry.error = error.message;
      this.record(entry, error.message);
      await this.disconnect(entry);
      throw error;
    } finally {
      entry.busy = false;
      this.changed();
    }
  }
}
