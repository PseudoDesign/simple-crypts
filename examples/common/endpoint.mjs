/* A small JS boundary around the example C platform. Every potentially
 * suspending export uses async ccall. The fleet worker serializes calls.
 */
const encoder = new TextEncoder();
export const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');

export function unhex(text, bytes) {
  if (typeof text !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(text) ||
      text.length > 1024 || (bytes !== undefined && text.length !== bytes * 2))
    throw new Error('Expected contiguous hexadecimal bytes (frame maximum: 512).');
  return Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16));
}

export function uint64(text) {
  if (typeof text !== 'string' || !/^[0-9]{1,20}$/.test(text) || BigInt(text) > 18446744073709551615n)
    throw new Error('Expected an unsigned decimal uint64.');
  return BigInt(text);
}

export function validSerial(serial) {
  if (typeof serial !== 'string' || !/^[!-~]{1,32}$/.test(serial))
    throw new Error('Serial must be 1–32 printable ASCII bytes.');
  return serial;
}

export class Endpoint {
  constructor(module) { this.module = module; }

  static async open(factory, storage, role, serial, pin, fresh) {
    validSerial(serial);
    if (!globalThis.crypto?.getRandomValues) throw new Error('Secure randomness is unavailable.');
    const module = await factory({storage});
    const endpoint = new Endpoint(module);
    endpoint.put(new Uint8Array(4096));
    endpoint.put(unhex(pin, 32));
    endpoint.put(encoder.encode(serial), 32);
    await endpoint.call('ex_init', ['number', 'number'], [role === 'device' ? 1 : 2, fresh ? 1 : 0]);
    return endpoint;
  }

  put(bytes, offset = 0) {
    if (offset + bytes.length > 4096) throw new Error('Input exceeds bridge buffer.');
    this.module.HEAPU8.set(bytes, this.module._ex_input() + offset);
  }

  state() { return JSON.parse(this.module.UTF8ToString(this.module._ex_state())); }

  async call(name, types = [], args = []) {
    const result = await this.module.ccall(name, 'number', types, args, {async: true});
    if (result < 0) throw new Error(this.module.UTF8ToString(this.module._ex_status(result)));
    return result;
  }

  values(...values) {
    // Avoid i64 parameters on Asyncify exports: its rewind enters with no JS
    // arguments. An explicit byte buffer also keeps uint64 conversion exact.
    const bytes = new Uint8Array(values.length * 8);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setBigUint64(index * 8, value, false));
    this.put(bytes, 2048);
  }

  async server(command, args, now) {
    this.values(now, now + 600n);
    switch (command) {
      case 'begin': await this.call('ex_begin'); break;
      case 'cancel': await this.call('ex_cancel'); break;
      case 'approve':
        this.put(unhex(args.challenge, 32));
        this.put(unhex(args.key, 32), 32);
        await this.call('ex_approve'); break;
      case 'issue': this.values(uint64(args.total)); await this.call('ex_issue'); break;
      case 'request': await this.call('ex_request'); break;
      case 'rx': {
        const frame = unhex(args.frame.trim());
        this.put(frame);
        await this.call('ex_receive', ['number'], [frame.length]); break;
      }
      case 'tx': {
        const status = await this.call('ex_outbound');
        if (status === 1) return 'No output.';
        const start = this.module._ex_frame();
        return hex(this.module.HEAPU8.slice(start, start + this.module._ex_frame_length()));
      }
      default: throw new Error('Unknown server command.');
    }
    return 'ok';
  }

  async console(line, now) {
    this.values(now);
    const bytes = encoder.encode(line);
    if (line.includes('\0') || bytes.length > 4096) throw new Error('Invalid or oversized command.');
    const start = this.module._device_line();
    this.module.HEAPU8.set(bytes, start);
    this.module.HEAPU8[start + bytes.length] = 0;
    const quit = await this.module.ccall('device_command', 'number', [], [], {async: true});
    return {output: this.module.UTF8ToString(this.module._device_output()), quit: quit === 1};
  }
}
