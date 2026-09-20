/** @module examples/fleet_manager/qtpy-serial */
/** Private demo commands; these are not Simple Crypts protocol messages. */
export const commands = Object.freeze({ inspect: 1, start: 2, setup: 3, receive: 4, outbound: 5 });
/** Compute the demo's CRC-32 over bytes.
 * @param {Uint8Array} bytes Input bytes.
 * @returns {number} Unsigned CRC.
 */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Encode a COBS packet with its terminating zero.
 * @param {Uint8Array} bytes Packet bytes.
 * @returns {Uint8Array} Framed bytes.
 */
export function encode(bytes) {
  const out = [0];
  let mark = 0,
    code = 1;
  for (const byte of bytes) {
    if (byte) {
      out.push(byte);
      code++;
    }
    if (!byte || code === 255) {
      out[mark] = code;
      mark = out.length;
      code = 1;
      out.push(0);
    }
  }
  out[mark] = code;
  out.push(0);
  return Uint8Array.from(out);
}
/** Decode one bounded COBS packet without its delimiter.
 * @param {Uint8Array} bytes Encoded bytes.
 * @returns {Uint8Array} Packet bytes; malformed input throws.
 */
export function decode(bytes) {
  const out = [];
  for (let at = 0; at < bytes.length; ) {
    const code = bytes[at++];
    if (!code || at + code - 1 > bytes.length) throw new Error('Invalid serial frame.');
    for (let i = 1; i < code; i++) {
      if (!bytes[at]) throw new Error('Invalid serial frame.');
      out.push(bytes[at++]);
    }
    if (code !== 255 && at < bytes.length) out.push(0);
  }
  if (out.length > 1024) throw new Error('Oversized serial frame.');
  return Uint8Array.from(out);
}
/** One owned Web Serial port, one outstanding command, and no automatic retries. */
export class SerialLink {
  /** Create an adapter for a user-selected port.
   * @param {SerialPort} port Web Serial port.
   * @param {number} [timeout=30000] Deadline in milliseconds.
   */
  constructor(port, timeout = 30000) {
    this.port = port;
    this.timeout = timeout;
    this.sequence = 0;
    this.pending = null;
    this.failed = false;
  }
  /** Open USB CDC and assert DTR before accepting commands.
   * @returns {Promise<void>} Ready to exchange commands.
   */
  async open() {
    await this.port.open({ baudRate: 115200, bufferSize: 4096 });
    try {
      await this.port.setSignals({ dataTerminalReady: true });
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this.reading = this.read();
      await this.writer.write(new Uint8Array([0]));
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  /** Read chunks, checking framing and matching each response to its request.
   * @returns {Promise<void>} Resolves when closed; errors reject the pending command.
   */
  async read() {
    let packet = [];
    try {
      while (!this.failed) {
        const { value, done } = await this.reader.read();
        if (done) throw new Error('Device disconnected.');
        for (const byte of value) {
          if (byte) {
            packet.push(byte);
            if (packet.length > 1030) throw new Error('Oversized serial frame.');
          } else if (packet.length) {
            const bytes = decode(Uint8Array.from(packet));
            packet = [];
            const view = new DataView(bytes.buffer);
            const pending = this.pending;
            if (
              !pending ||
              bytes.length < 16 ||
              bytes[0] !== 81 ||
              bytes[1] !== 82 ||
              bytes[2] !== 1 ||
              bytes[3] !== pending.command ||
              view.getUint32(4) !== pending.sequence ||
              view.getUint32(bytes.length - 4) !== crc32(bytes.subarray(0, -4))
            )
              throw new Error('Unexpected or corrupt serial response.');
            this.pending = null;
            clearTimeout(pending.timer);
            const status = view.getInt32(8);
            if (status === 1 && pending.command === commands.outbound) pending.resolve(null);
            else if (status !== 0)
              pending.reject(new Error(`Device status ${status}. Inspect before retrying.`));
            else pending.resolve(bytes.slice(12, -4));
          }
        }
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.reader.releaseLock();
    }
  }
  /** Fail closed after ambiguous I/O; reconnect before sending another command.
   * @param {Error} error Original failure.
   */
  fail(error) {
    this.failed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(
        new Error(
          `${error.message} Result may be committed; reconnect and inspect. No command was retried.`,
        ),
      );
      this.pending = null;
    }
    this.reader?.cancel().catch(() => {});
  }
  /** Send one private management command with a bounded response deadline.
   * @param {number} command Command byte.
   * @param {Uint8Array} [payload] Command payload.
   * @returns {Promise<Uint8Array|null>} Response payload, or null for no outbound frame.
   */
  async command(command, payload = new Uint8Array()) {
    if (this.failed || !this.writer) throw new Error('Reconnect the device first.');
    if (this.pending) throw new Error('Another device command is in progress.');
    if (!(payload instanceof Uint8Array) || payload.length > 1008 || this.sequence === 0xffffffff)
      throw new Error('Invalid command payload or exhausted connection sequence.');
    const bytes = new Uint8Array(payload.length + 12);
    const view = new DataView(bytes.buffer);
    bytes.set([81, 84, 1, command]);
    view.setUint32(4, ++this.sequence);
    bytes.set(payload, 8);
    view.setUint32(bytes.length - 4, crc32(bytes.subarray(0, -4)));
    const frame = encode(bytes);
    bytes.fill(0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error('Serial command timed out.')),
        this.timeout,
      );
      this.pending = { command, sequence: this.sequence, resolve, reject, timer };
      this.writer
        .write(frame)
        .catch((error) => this.fail(error))
        .finally(() => frame.fill(0));
    });
  }
  /** Read device diagnostics without persistent device writes.
   * @returns {Promise<object>} Validated public diagnostics.
   */
  async inspect() {
    const state = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await this.command(commands.inspect)),
    );
    if (
      state.version !== 1 ||
      !/^qtpy-[!-~]{1,27}$/.test(state.serial) ||
      !/^[a-f0-9]{64}$/.test(state.public_key) ||
      !/^[a-f0-9]{64}$/.test(state.server_key) ||
      !/^[0-9]+$/.test(state.issued) ||
      !/^[0-9]+$/.test(state.consumed)
    )
      throw new Error('This port is not a compatible QT Py demo.');
    return state;
  }
  /** Cancel readers and release the port; never send a device reset.
   * @returns {Promise<void>} Port closed.
   */
  async close() {
    this.fail(new Error('Connection closed.'));
    await this.reading;
    this.writer?.releaseLock();
    this.writer = null;
    await this.port.close();
  }
}
