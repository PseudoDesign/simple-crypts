/** @module web/lab */
/** Maximum pending packet count and retained event count, respectively. */
export const MAX_QUEUE = 64,
  MAX_EVENTS = 200;
/** Fixed demo serial used before key generation or enrollment. */
export const DEVICE_SERIAL = 'mcu-0001';
/**
 * Own two isolated guided-demo workers and explicit packet queues. The lab controls simulated time and transport; it never fabricates protocol responses. Reset terminates old workers and rejects outstanding calls.
 */
export class Lab {
  /**
   * Create a lab without starting workers; reset initializes them.
   * @param {Function} [onChange] Observer called after state changes.
   * @param {Function} [workerFactory] Factory for isolated endpoint workers.
   */
  constructor(onChange = () => {}, workerFactory = (url) => new Worker(url, { type: 'module' })) {
    this.onChange = onChange;
    this.workerFactory = workerFactory;
    this.epoch = 0;
    this.workers = {};
    this.pending = new Map();
    this.sequence = 0;
    this.queue = [];
    this.archive = [];
    this.events = [];
    this.states = {};
    this.nextPacket = 1;
    this.ready = false; // Freeze the simulated server clock at a real date for readable packet timestamps.
    this.time = Math.floor(Date.now() / 1000);
  }
  /**
   * Notify the UI with the current lab state.
   */
  notify() {
    this.onChange(this);
  }
  /**
   * Append a bounded diagnostic event and notify observers.
   * @param {string} message Display text.
   * @param {string} [kind] Event category.
   */
  event(message, kind = 'info') {
    this.events.push({ message, kind });
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.notify();
  }
  /**
   * Terminate workers and reject pending calls, invalidating the current session.
   */
  stop() {
    this.epoch++;
    this.ready = false;
    for (const worker of Object.values(this.workers)) worker.terminate();
    this.workers = {};
    for (const pending of this.pending.values())
      pending.reject(new DOMException('Session reset', 'AbortError'));
    this.pending.clear();
  }
  /**
   * Discard transient state and initialize fresh workers and server identity.
   * @param {object} [options] Set deferDevice to postpone device provisioning.
   * @returns {Promise<void>} Completion; initialization failures reject.
   */
  async reset({ deferDevice = false } = {}) {
    this.stop();
    const epoch = this.epoch;
    this.queue = [];
    this.archive = [];
    this.events = [];
    this.states = {};
    this.devicePublicKey = null;
    this.verifiedChallenge = null;
    this.authorization = null;
    this.nextPacket = 1;
    this.notify();
    try {
      if (!globalThis.crypto?.getRandomValues)
        throw new Error(
          'Secure browser randomness is unavailable. Open this demo over HTTPS or localhost.',
        );
      // Compatibility slot only: signed enrollment uses no shared enrollment secret.
      const secret = '00'.repeat(32);
      for (const role of ['device', 'server']) {
        const worker = this.workerFactory(new URL('./worker.mjs?v=f7ac1ff01689f4d7a1b1', import.meta.url));
        this.workers[role] = worker;
        worker.onmessage = ({ data }) => {
          const p = this.pending.get(data.id);
          if (!p) return;
          this.pending.delete(data.id);
          data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
        };
        worker.onerror = () => {
          for (const [id, p] of this.pending) {
            if (p.role === role) {
              this.pending.delete(id);
              p.reject(new Error(`${role} runtime failed to load or execute`));
            }
          }
        };
      }
      const server = await this.raw('server', 'init', {
        role: 'server',
        serial: DEVICE_SERIAL,
        secret,
      });
      if (epoch !== this.epoch) throw new DOMException('Session reset', 'AbortError');
      if (server.code !== 0) throw new Error(server.status);
      this.authorization = secret;
      const enabled = await this.raw('server', 'enrollment_enable');
      if (enabled.code !== 0) throw new Error(enabled.status);
      if (deferDevice) {
        this.states = { server: enabled.state };
        this.ready = true;
        this.event('Server ready. Device key has not been generated.');
        return;
      }
      const device = await this.raw('device', 'init', {
        role: 'device',
        serial: DEVICE_SERIAL,
        secret,
        server_public_key: server.state.public_key,
      });
      if (device.code !== 0) throw new Error(device.status);
      if (epoch !== this.epoch) throw new DOMException('Session reset', 'AbortError');
      const enabledDevice = await this.raw('device', 'enrollment_enable');
      if (enabledDevice.code !== 0) throw new Error(enabledDevice.status);
      this.states = { server: enabled.state, device: enabledDevice.state };
      this.ready = true;
      this.event(
        'Fresh identities ready. The device holds the server’s public key. No frames have been sent.',
      );
    } catch (error) {
      if (epoch === this.epoch) {
        this.stop();
        this.event(error.message, 'error');
      }
      throw error;
    }
  }
  /**
   * Generate a fresh device identity after optional challenge verification.
   * @param {object} [options] Set fromChallenge to verify the displayed invitation first.
   * @returns {Promise<void>} Completion; invalid session or verification failures reject.
   */
  async generateDevice({ fromChallenge = false } = {}) {
    const epoch = this.epoch;
    const result = await this.raw('device', fromChallenge ? 'generate_from_challenge' : 'generate');
    if (epoch !== this.epoch) throw new DOMException('Session reset', 'AbortError');
    if (result.code !== 0) throw new Error(result.status);
    this.devicePublicKey = result.public_key;
    this.event('Device generated an Ed25519 key pair locally. No packet sent.');
    return result.public_key;
  }
  /**
   * Initialize the generated device with its serial and pinned server key.
   * @returns {Promise<void>} Completion; missing provisioning inputs reject.
   */
  async provisionDevice() {
    const epoch = this.epoch;
    const result = await this.raw('device', 'init', {
      role: 'device',
      serial: DEVICE_SERIAL,
      secret: this.authorization,
      server_public_key: this.states.server.public_key,
    });
    if (epoch !== this.epoch) throw new DOMException('Session reset', 'AbortError');
    if (result.code !== 0) throw new Error(result.status);
    const enabled = await this.raw('device', 'enrollment_enable');
    if (epoch !== this.epoch) throw new DOMException('Session reset', 'AbortError');
    if (enabled.code !== 0) throw new Error(enabled.status);
    this.states.device = enabled.state;
    this.event(
      'Device identity ready; its serial and trusted server public key are already available.',
    );
  }
  /**
   * Send a command to one worker and correlate its response; no peer transfer occurs.
   * @param {string} role Endpoint role.
   * @param {string} command Bridge command.
   * @param {object} [args] Command arguments.
   * @returns {Promise<object>} Worker response; runtime errors reject.
   */
  raw(role, command, args = {}) {
    const worker = this.workers[role];
    if (!worker) return Promise.reject(new Error('Endpoint is unavailable'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, role });
      worker.postMessage({ id, command, args });
    });
  }
  /**
   * Execute a worker command and update visible state and events.
   * @param {string} role Endpoint role.
   * @param {string} command Bridge command.
   * @param {object} [args] Command arguments.
   * @returns {Promise<object>} Worker result.
   */
  async command(role, command, args = {}) {
    if (!this.ready) throw new Error('Session is not ready');
    const epoch = this.epoch;
    const response = await this.raw(role, command, args);
    if (epoch !== this.epoch) throw new DOMException('Session reset', 'AbortError');
    this.states[role] = response.state;
    this.notify();
    return response;
  }
  /**
   * Apply a state-changing command and report its result; frame generation is separate.
   * @param {string} role Endpoint role.
   * @param {string} command Bridge command.
   * @param {object} args Command arguments.
   * @returns {Promise<object>} Command result; delivery remains explicit.
   */
  async update(role, command, args) {
    const r = await this.command(role, command, args);
    if (r.code < 0) throw new Error(`${role}: ${r.status}`);
    this.event(
      command === 'issue'
        ? `Server issued ${args.total} cumulative credits and requested status.`
        : command === 'consume'
          ? `Device consumed ${args.amount} credits locally. No report requested.`
          : command === 'request'
            ? 'Server requested a fresh credit snapshot.'
            : `${role} rebooted with durable state.`,
    );
    return r;
  }
  /**
   * Authorize a ten-minute session using the simulated server clock.
   * @returns {Promise<void>} Completion; native failures reject.
   */
  async beginEnrollment() {
    const r = await this.command('server', 'enrollment_begin', {
      now: this.time,
      expires: this.time + 600,
    });
    if (r.code !== 0) throw new Error(r.status);
    this.event('Application policy authorized a 10-minute enrollment session.');
  }
  /**
   * Approve the displayed candidate binding at the current simulated time.
   * @returns {Promise<void>} Completion; stale or absent candidates fail.
   */
  async approveEnrollment() {
    const s = this.states.server;
    const r = await this.command('server', 'enrollment_approve', {
      challenge: s.challenge,
      key: s.candidate_key,
      now: this.time,
    });
    if (r.code !== 0) throw new Error(r.status);
    this.event(
      'Application policy approved this exact serial, session, and Ed25519 key. Device registered.',
    );
  }
  /**
   * Generate and stage a packet in its sender box; do not deliver it.
   * @param {string} role Sending endpoint.
   * @param {number} [budget=512] Maximum frame bytes.
   * @returns {Promise<number|null>} Queued packet ID, or null when idle.
   */
  async transmit(role, budget = 512) {
    if (this.queue.length >= MAX_QUEUE)
      throw new Error(
        'Relay queue is full (64 frames). Deliver or drop a frame before another opportunity.',
      );
    const epoch = this.epoch;
    const r = await this.command(role, 'tx', { budget });
    if (epoch !== this.epoch) throw new DOMException('Session reset', 'AbortError');
    if (r.code === 1) {
      this.event(`${role}: nothing to send.`);
      return null;
    }
    if (r.code < 0) throw new Error(`${role}: ${r.status}; no frame queued.`);
    // UI serializes opportunities. Reserve capacity defensively for callers too.
    if (this.queue.length >= MAX_QUEUE)
      throw new Error(
        'Relay queue filled during transmission; latest endpoint state remains pending.',
      );
    const packet = {
      id: this.nextPacket++,
      from: role,
      to: role === 'device' ? 'server' : 'device',
      signed: r.frame[2] === 69,
      messageKind: r.messageKind,
      senderState: Object.freeze({ ...this.states[role] }),
      bytes: r.frame.slice(),
      corrupted: false,
      location: role + '-outbox',
      origin: this.nextPacket - 1,
    };
    this.queue.push(packet);
    this.event(
      `Frame ${packet.id}: ${role} → ${packet.to}, ${packet.bytes.length} ${packet.signed ? 'public signed' : 'encrypted'} bytes queued.`,
    );
    return packet.id;
  }
  /**
   * Find a queued packet or throw if it is no longer available.
   * @param {number} id Packet identifier.
   * @returns {object} Mutable queue record.
   */
  packet(id) {
    const p = this.queue.find((p) => p.id === id);
    if (!p) throw new Error('Frame is no longer queued');
    return p;
  }
  /**
   * Archive a packet with its final outcome, keeping bounded history.
   * @param {object} packet Queue record.
   * @param {string} outcome Final outcome.
   */
  remember(packet, outcome) {
    this.archive.unshift({ ...packet, bytes: packet.bytes.slice(), outcome });
    if (this.archive.length > 16) this.archive.pop();
  }
  /**
   * Move a visible packet between transport locations.
   * @param {number} id Packet identifier.
   * @param {string} location New location.
   */
  move(id, location) {
    if (!['relay', 'device-outbox', 'server-outbox'].includes(location))
      throw new Error('Unknown holding area');
    this.packet(id).location = location;
    this.event(`Message ${id} held; no endpoint has received it.`);
  }
  /**
   * Discard a packet without reception and record the outcome.
   * @param {number} id Packet identifier.
   */
  drop(id) {
    const p = this.packet(id);
    this.remember({ ...p, result: null }, 'dropped · receiver not called');
    this.queue = this.queue.filter((p) => p.id !== id);
    this.event(`Host discarded message ${id}.`);
  }
  /**
   * Queue a copy of archived bytes for explicit replay testing.
   * @param {object} packet Archived record.
   */
  replay(packet) {
    if (this.queue.length >= MAX_QUEUE) throw new Error('Relay queue is full (64 messages).');
    const copy = {
      ...packet,
      id: this.nextPacket++,
      bytes: packet.bytes.slice(),
      location: 'relay',
    };
    delete copy.outcome;
    delete copy.result;
    this.queue.push(copy);
    this.event(`An identical copy of message ${packet.id} is queued as message ${copy.id}.`);
    return copy.id;
  }
  /**
   * Queue a second copy without mutating the original.
   * @param {number} id Packet identifier.
   */
  duplicate(id) {
    if (this.queue.length >= MAX_QUEUE) throw new Error('Relay queue is full (64 frames).');
    const p = this.packet(id);
    const copy = { ...p, id: this.nextPacket++, bytes: p.bytes.slice() };
    this.queue.push(copy);
    this.event(`Host duplicated frame ${id} as frame ${copy.id}.`);
    return copy.id;
  }
  /**
   * Flip ciphertext bytes for authentication-failure testing.
   * @param {number} id Packet identifier.
   */
  corrupt(id) {
    const p = this.packet(id);
    p.bytes[p.bytes.length - 1] ^= 1;
    p.corrupted = !p.corrupted;
    this.event(`Host flipped the final wire byte of frame ${id}.`);
  }
  /**
   * Deliver a queued packet to one endpoint and record its acceptance or failure.
   * @param {number} id Packet identifier.
   * @param {string} target Destination role.
   * @returns {Promise<object>} Receive result.
   */
  async deliver(id, target) {
    const p = this.packet(id);
    target = target ?? p.to;
    if (!['device', 'server'].includes(target)) throw new Error('Unknown recipient');
    const epoch = this.epoch;
    const before = { ...this.states[target] };
    const result =
      target === 'device' && !this.states.device
        ? await this.raw('device', 'verify_challenge', {
            frame: p.bytes.slice(),
            server_public_key: this.states.server.public_key,
            serial: DEVICE_SERIAL,
          })
        : await this.command(target, 'rx', { frame: p.bytes.slice(), now: this.time });
    if (target === 'device' && !this.states.device && result.code === 0)
      this.verifiedChallenge = p.bytes.slice();
    if (epoch !== this.epoch) throw new DOMException('Session reset', 'AbortError');
    this.queue = this.queue.filter((p) => p.id !== id);
    const fields = [
      'registered',
      'credits_issued',
      'credits_consumed',
      'request_id',
      'snapshot_id',
      'acknowledged_id',
      'pending',
      'challenge',
      'candidate_key',
      'candidate_revision',
    ];
    const changes = fields
      .filter((k) => before[k] !== (result.state ?? {})[k])
      .map((k) => ({ field: k, before: before[k], after: (result.state ?? {})[k] }));
    result.changes = changes;
    this.remember(
      {
        ...p,
        result: { code: result.code, status: result.status, target, changed: changes.length },
      },
      result.code < 0
        ? 'rejected by ' + target
        : changes.length
          ? 'accepted by ' + target
          : 'accepted; no newer state',
    );
    this.event(
      `Frame ${id} delivered to ${target}: ${result.code < 0 ? 'rejected — ' + result.status : 'authenticated and processed'}.`,
      result.code < 0 ? 'rejected' : 'success',
    );
    return result;
  }
}
export const tour = [
  {
    title: 'Deliver the signed challenge.',
    text: 'The server opens an authorized session. Drag its challenge to the device.',
    target: 'device',
    success:
      'The signature is valid. Now generate a private identity using secure local randomness, with the public challenge mixed in as additional input.',
    code: 'sc_enrollment_begin(&server, now, expires);\nsc_receive(&device, frame, length);',
    prepare: async (l) => {
      await l.beginEnrollment();
      return l.transmit('server');
    },
  },
  {
    title: 'Deliver the encrypted response.',
    text: 'The device returns the challenge, its identity, to prove possession of its private key.',
    target: 'server',
    success:
      'The response authenticated. This proposed key is waiting for trusted approval; nothing is registered yet.',
    code: 'sc_receive_at(&server, frame, length, now);',
    prepare: async (l) => {
      if (!l.states.device) {
        await l.generateDevice({ fromChallenge: true });
        await l.provisionDevice();
        const r = await l.command('device', 'rx', { frame: l.verifiedChallenge });
        if (r.code !== 0) throw new Error(r.status);
      }
      return l.transmit('device');
    },
  },
  {
    title: 'Deliver the enrollment confirmation.',
    text: 'The approved server reply confirms this enrollment session.',
    target: 'device',
    success:
      'You’re connected! Continue to credits to see the device and server share data. Or retry enrollment: corrupt a packet before delivering it, or advance server time before sending the response, and see how the library reacts.',
    code: 'sc_receive(&device, frame, length);',
    prepare: (l) => l.transmit('server'),
  },
  {
    title: 'Deliver 100 issued credits.',
    text: 'The server grants a cumulative total of 100 and asks for a status snapshot. Replaying this grant cannot add another 100.',
    target: 'device',
    success:
      'The device accepted 100 issued credits and captured its current consumption for this request.',
    code: 'sc_set_credits_issued(&server, 100);',
    prepare: async (l) => {
      await l.update('server', 'issue', { total: '100' });
      return l.transmit('server');
    },
  },
  {
    title: 'Deliver the credit snapshot.',
    text: 'This captured response contains 100 issued and 0 consumed. It also confirms that the device accepted the grant.',
    target: 'server',
    success:
      'The server knows the device accepted 100 credits and had consumed 0 when it answered.',
    code: 'sc_receive(&server, frame, length);',
    prepare: (l) => l.transmit('device'),
  },
  {
    title: 'Deliver the receipt.',
    text: 'The server acknowledges this exact snapshot. The receipt asks for no additional report.',
    target: 'device',
    success:
      'Click + beside the device’s Credits consumed to spend 25 credits locally. No message is sent.',
    code: 'sc_receive(&device, frame, length);',
    prepare: (l) => l.transmit('server'),
  },
  {
    title: 'Deliver the status request.',
    text: 'The server requests current consumption. Until this reaches the device, its last report remains 0.',
    target: 'device',
    success: 'The device captured a new snapshot: 100 issued, 25 consumed.',
    code: 'sc_request_credit_status(&server);',
    prepare: async (l) => {
      await l.update('server', 'request', {});
      return l.transmit('server');
    },
  },
  {
    title: 'Deliver the updated snapshot.',
    text: 'The encrypted response links 25 consumed credits to this request. Older snapshots cannot roll it back.',
    target: 'server',
    success: 'The server’s last reported consumption is now 25.',
    code: 'sc_receive(&server, frame, length);',
    prepare: (l) => l.transmit('device'),
  },
  {
    title: 'Deliver the final receipt.',
    text: 'The device can stop retrying this snapshot once it receives the authenticated receipt.',
    target: 'device',
    success:
      'Both sides agree on the last report. Use the + buttons to add or consume more credits, or try overspending followed by dropped and repeated packets.',
    code: 'sc_receive(&device, frame, length);',
    prepare: (l) => l.transmit('server'),
  },
];
