/** @module examples/common/endpoint */
/* A small JS boundary around the example C platform. Every potentially
 * suspending export uses async ccall. The fleet worker serializes calls.
 */
const encoder = new TextEncoder();
function keyBytes(text) {
  if (typeof text !== 'string' || !/^[a-f0-9]{64}$/i.test(text))
    throw new Error('Expected a 32-byte public key or challenge.');
  return Uint8Array.from(text.match(/../g), (pair) => parseInt(pair, 16));
}

/**
 * Parse an exact unsigned decimal uint64 without converting through Number.
 * @param {string} text Decimal digits only.
 * @returns {bigint} The exact value; malformed or overflowing input throws.
 */
export function uint64(text) {
  if (
    typeof text !== 'string' ||
    !/^[0-9]{1,20}$/.test(text) ||
    BigInt(text) > 18446744073709551615n
  )
    throw new Error('Expected an unsigned decimal uint64.');
  return BigInt(text);
}

/**
 * Validate a serial before creating storage or identity state.
 * @param {string} serial Between 1 and 32 printable non-space ASCII bytes.
 * @returns {string} The validated serial; invalid input throws.
 */
export function validSerial(serial) {
  if (typeof serial !== 'string' || !/^[!-~]{1,32}$/.test(serial))
    throw new Error('Serial must be 1–32 printable ASCII bytes.');
  return serial;
}

/**
 * Single-owner persistent WebAssembly endpoint. The worker must serialize calls and await every mutation: Asyncify storage callbacks finish durable IndexedDB transactions before reporting success.
 */
export class Endpoint {
  /**
   * Wrap a Wasm module already owned by the calling worker. Use open for initialization.
   * @param {object} module Emscripten module instance.
   */
  constructor(module) {
    this.module = module;
  }

  /**
   * Create an isolated instance and await initialization from durable storage. Missing or incompatible saved state rejects.
   * @param {Function} factory Emscripten module factory.
   * @param {object} storage Awaitable load/save callbacks.
   * @param {string} role Device or server role.
   * @param {string} serial Validated serial.
   * @param {string} pin Hexadecimal 32-byte server public key.
   * @param {boolean} fresh Require a new identity.
   * @returns {Promise<Endpoint>} Initialized, exclusively owned endpoint.
   */
  static async open(factory, storage, role, serial, pin, fresh) {
    validSerial(serial);
    if (!globalThis.crypto?.getRandomValues) throw new Error('Secure randomness is unavailable.');
    const module = await factory({ storage });
    const endpoint = new Endpoint(module);
    endpoint.put(new Uint8Array(4096));
    endpoint.put(keyBytes(pin));
    endpoint.put(encoder.encode(serial), 32);
    await endpoint.call(
      'ex_init',
      ['number', 'number'],
      [role === 'device' ? 1 : 2, fresh ? 1 : 0],
    );
    return endpoint;
  }

  /**
   * Copy bytes into the shared 4096-byte bridge input; callers serialize access.
   * @param {Uint8Array} bytes Input bytes.
   * @param {number} [offset=0] Byte offset.
   */
  put(bytes, offset = 0) {
    if (offset + bytes.length > 4096) throw new Error('Input exceeds bridge buffer.');
    this.module.HEAPU8.set(bytes, this.module._ex_input() + offset);
  }

  /**
   * Copy public diagnostics; uint64 values remain decimal strings.
   * @returns {object|null} Public state or null when unavailable.
   */
  state() {
    return JSON.parse(this.module.UTF8ToString(this.module._ex_state()));
  }

  /**
   * Await an exported mutation, including storage completion; native errors reject.
   * @param {string} name Export name.
   * @param {Array} [types] Emscripten argument types.
   * @param {Array} [args] Argument values.
   * @returns {Promise<number>} Nonnegative native status.
   */
  async call(name, types = [], args = []) {
    const result = await this.module.ccall(name, 'number', types, args, { async: true });
    if (result < 0) throw new Error(this.module.UTF8ToString(this.module._ex_status(result)));
    return result;
  }

  /**
   * Write exact uint64 slots at input offset 2048; avoids Asyncify i64 argument rewind.
   * @param {...bigint} values At most two values in the uint64 range.
   */
  values(...values) {
    // Avoid i64 parameters on Asyncify exports: its rewind enters with no JS
    // arguments. An explicit byte buffer also keeps uint64 conversion exact.
    const bytes = new Uint8Array(values.length * 8);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setBigUint64(index * 8, value, false));
    this.put(bytes, 2048);
  }

  /**
   * Apply a fleet control to this server, persisting pending work without delivery.
   * @param {string} command begin, cancel, approve, issue, or request.
   * @param {object} args Challenge/key for approval or decimal total for issuance.
   * @param {bigint} now Trusted server time in seconds; enrollment lasts 600 seconds.
   * @returns {Promise<string>} ok on success; errors reject.
   */
  async server(command, args, now) {
    this.values(now, now + 600n);
    switch (command) {
      case 'begin':
        await this.call('ex_begin');
        break;
      case 'cancel':
        await this.call('ex_cancel');
        break;
      case 'approve':
        this.put(keyBytes(args.challenge));
        this.put(keyBytes(args.key), 32);
        await this.call('ex_approve');
        break;
      case 'issue':
        this.values(uint64(args.total));
        await this.call('ex_issue');
        break;
      case 'request':
        await this.call('ex_request');
        break;
      default:
        throw new Error('Unknown server command.');
    }
    return 'ok';
  }

  // Opaque bytes belong to the simulated transport, never to console input.
  /**
   * Generate and copy one pending frame, awaiting nonce reservation before success.
   * @returns {Promise<Uint8Array|null>} Owned bytes, or null when idle. Never delivers the frame.
   */
  async outbound() {
    if ((await this.call('ex_outbound')) === 1) return null;
    const start = this.module._ex_frame();
    return this.module.HEAPU8.slice(start, start + this.module._ex_frame_length());
  }

  /**
   * Authenticate a complete frame and await durable state updates.
   * @param {Uint8Array} frame Between 1 and 512 bytes.
   * @param {bigint} now Trusted server time in seconds.
   * @returns {Promise<void>} Completion; failures reject.
   */
  async receive(frame, now) {
    if (!(frame instanceof Uint8Array) || frame.length === 0 || frame.length > 512)
      throw new Error('Expected a binary frame of 1–512 bytes.');
    this.values(now);
    this.put(frame);
    await this.call('ex_receive', ['number'], [frame.length]);
  }

  /**
   * Run the C++ command parser after copying a UTF-8 input line.
   * @param {string} line At most 4096 UTF-8 bytes without NUL.
   * @param {bigint} now Trusted server time in seconds.
   * @returns {Promise<object>} Copied output and quit/error/sync flags; the worker handles transport.
   */
  async console(line, now) {
    this.values(now);
    const bytes = encoder.encode(line);
    if (line.includes('\0') || bytes.length > 4096)
      throw new Error('Invalid or oversized command.');
    const start = this.module._device_line();
    this.module.HEAPU8.set(bytes, start);
    this.module.HEAPU8[start + bytes.length] = 0;
    const result = await this.module.ccall('device_command', 'number', [], [], { async: true });
    return {
      output: this.module.UTF8ToString(this.module._device_output()),
      quit: result === 1,
      error: result === 2,
      sync: result === 3,
    };
  }
}
