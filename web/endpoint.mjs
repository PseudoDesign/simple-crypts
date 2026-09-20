/** @module web/endpoint */
/* The same adapter is exercised in Node tests and isolated browser workers. */
const encoder = new TextEncoder();
/**
 * Encode bytes as lowercase hexadecimal without changing the input.
 * @param {Uint8Array} bytes Bytes to encode.
 * @returns {string} Hexadecimal representation.
 */
export const hex = (bytes) => Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
/**
 * Decode exactly one 32-byte public key from hexadecimal.
 * @param {string} text A 64-character hexadecimal key.
 * @returns {Uint8Array} Fresh key bytes; malformed input throws.
 */
export function unhex(text) {
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error('Expected a 32-byte key');
  return Uint8Array.from(text.match(/../g), (n) => parseInt(n, 16));
}
function uint64(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new Error('Time must be an exact uint64');
  if (
    !['number', 'bigint', 'string'].includes(typeof value) ||
    (typeof value === 'string' && !/^[0-9]+$/.test(value))
  )
    throw new Error('Time must be an exact uint64');
  const n = BigInt(value);
  if (n < 0n || n > 18446744073709551615n) throw new Error('Time must be an exact uint64');
  return n;
}
function validText(value) {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    new TextDecoder('utf-8', { fatal: true }).decode(encoder.encode(value)) !== value
  )
    throw new Error('Text must be valid UTF-8 without NUL');
  return encoder.encode(value);
}
/**
 * Worker-owned adapter for one guided-demo WebAssembly instance. Commands are synchronous native operations wrapped by an async JS interface. State is temporary and belongs to this instance.
 */
export class Endpoint {
  /**
   * Wrap one isolated guided-demo Wasm instance.
   * @param {object} module Emscripten module with scw exports.
   */
  constructor(module) {
    this.m = module;
    this.initialized = false;
  }
  /**
   * Copy input bytes into the instance-owned bridge buffer.
   * @param {Uint8Array} bytes Input bytes.
   * @param {number} [offset=0] Offset within the 4096-byte buffer.
   */
  put(bytes, offset = 0) {
    if (!(bytes instanceof Uint8Array) || bytes.length + offset > 4096)
      throw new Error('Input exceeds buffer');
    this.m.HEAPU8.set(bytes, this.m._scw_input() + offset);
  }
  /**
   * Copy public diagnostics; this is not a restorable native context.
   * @returns {object|null} Public state with exact decimal counters.
   */
  state() {
    return JSON.parse(this.m.UTF8ToString(this.m._scw_state()));
  }
  /**
   * Apply one guided-demo command. Generation, initialization, enrollment, credit, receive and transmit commands delegate to the C bridge. Producing a frame does not deliver it.
   * @param {string} command Command name.
   * @param {object} [args] Command-specific inputs; uint64 values must be exact.
   * @returns {Promise<object>} Native status, copied state and optional frame; malformed inputs reject.
   */
  async command(command, args = {}) {
    const m = this.m;
    let status = 0,
      frame,
      messageKind;
    if (command === 'verify_challenge') {
      if (this.initialized) throw new Error('Already initialized');
      if (!(args.frame instanceof Uint8Array) || args.frame.length > 512)
        throw new Error('Frame must fit in 512 bytes');
      this.put(args.frame);
      this.put(unhex(args.server_public_key), 512);
      const serial = validText(args.serial);
      if (serial.length > 32) throw new Error('Serial too long');
      m.HEAPU8.fill(0, m._scw_input() + 544, m._scw_input() + 576);
      this.put(serial, 544);
      status = m._scw_verify_challenge(args.frame.length);
      return { code: status, status: m.UTF8ToString(m._scw_status(status)), state: null };
    }
    if (command === 'generate' || command === 'generate_from_challenge') {
      if (this.initialized) throw new Error('Already initialized');
      if (!globalThis.crypto?.getRandomValues)
        throw new Error('Secure browser randomness is unavailable');
      status = command === 'generate' ? m._scw_generate() : m._scw_generate_from_challenge();
      return {
        code: status,
        status: m.UTF8ToString(m._scw_status(status)),
        public_key:
          status === 0 ? hex(m.HEAPU8.slice(m._scw_public(), m._scw_public() + 32)) : null,
      };
    }
    if (command === 'init') {
      if (this.initialized) throw new Error('Already initialized');
      if (!globalThis.crypto?.getRandomValues)
        throw new Error('Secure browser randomness is unavailable');
      const serial = validText(args.serial ?? 'mcu-0001');
      if (serial.length < 1 || serial.length > 32 || !/^[!-~]+$/.test(args.serial ?? 'mcu-0001'))
        throw new Error('Serial must be 1–32 printable ASCII bytes');
      if (!['device', 'server'].includes(args.role)) throw new Error('Invalid role');
      m.HEAPU8.fill(0, m._scw_input(), m._scw_input() + 4096);
      this.put(unhex(args.secret));
      if (args.role === 'device') this.put(unhex(args.server_public_key), 32);
      this.put(serial, 64);
      if (args.testSeed) {
        if (!m._scw_test_init) throw new Error('Test provisioning is unavailable');
        this.put(unhex(args.testSeed), 128);
        status = m._scw_test_init(args.role === 'device' ? 1 : 2);
      } else status = m._scw_init(args.role === 'device' ? 1 : 2);
      this.initialized = status === 0;
    } else {
      if (!this.initialized) throw new Error('Endpoint not initialized');
      switch (command) {
        case 'state':
          break;
        case 'enrollment_enable':
          status = m._scw_enrollment_enable();
          break;
        case 'enrollment_begin':
          status = m._scw_enrollment_begin(uint64(args.now), uint64(args.expires));
          break;
        case 'enrollment_approve':
          this.put(unhex(args.challenge));
          this.put(unhex(args.key), 32);
          status = m._scw_enrollment_approve(uint64(args.now));
          break;
        case 'enrollment_cancel':
          status = m._scw_enrollment_cancel();
          break;
        case 'reboot':
          status = m._scw_reboot();
          break;
        case 'issue':
          status = m._scw_issue(uint64(args.total));
          break;
        case 'consume':
          status = m._scw_consume(uint64(args.amount));
          break;
        case 'request':
          status = m._scw_request();
          break;
        case 'rx':
          if (!(args.frame instanceof Uint8Array) || args.frame.length > 512)
            throw new Error('Frame must fit in 512 bytes');
          this.put(args.frame);
          status =
            args.now === undefined
              ? m._scw_receive(args.frame.length)
              : m._scw_receive_at(args.frame.length, uint64(args.now));
          break;
        case 'tx': {
          const budget = args.budget ?? 512;
          if (!Number.isInteger(budget) || budget < 0 || budget > 512)
            throw new Error('Budget must be 0–512 bytes');
          status = m._scw_outbound(budget);
          if (status === 0) {
            frame = m.HEAPU8.slice(m._scw_frame(), m._scw_frame() + m._scw_frame_length());
            messageKind = m._scw_frame_kind();
          }
          break;
        }
        default:
          throw new Error('Unknown endpoint command');
      }
    }
    return {
      code: status,
      status: m.UTF8ToString(m._scw_status(status)),
      state: this.state(),
      ...(frame ? { frame, messageKind } : {}),
    };
  }
}
