/* The same adapter is exercised in Node tests and isolated browser workers. */
const encoder = new TextEncoder();
export const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
export function unhex(text) {
  if (!/^[0-9a-f]{64}$/i.test(text)) throw new Error('Expected a 32-byte key');
  return Uint8Array.from(text.match(/../g), n => parseInt(n, 16));
}
function uint64(value){
  if(typeof value==='number'&&!Number.isSafeInteger(value))throw new Error('Time must be an exact uint64');
  if(!['number','bigint','string'].includes(typeof value)||(typeof value==='string'&&!/^[0-9]+$/.test(value)))throw new Error('Time must be an exact uint64');
  const n=BigInt(value);if(n<0n||n>18446744073709551615n)throw new Error('Time must be an exact uint64');return n;
}
function validText(value) {
  if (typeof value !== 'string' || value.includes('\0') || new TextDecoder('utf-8', {fatal:true}).decode(encoder.encode(value)) !== value)
    throw new Error('Text must be valid UTF-8 without NUL');
  return encoder.encode(value);
}
export class Endpoint {
  constructor(module) { this.m = module; this.initialized = false; }
  put(bytes, offset = 0) {
    if (!(bytes instanceof Uint8Array) || bytes.length + offset > 4096) throw new Error('Input exceeds buffer');
    this.m.HEAPU8.set(bytes, this.m._scw_input() + offset);
  }
  state() { return JSON.parse(this.m.UTF8ToString(this.m._scw_state())); }
  async command(command, args = {}) {
    const m = this.m; let status = 0, frame;
    if (command === 'generate') {
      if(this.initialized)throw new Error('Already initialized');
      if(!globalThis.crypto?.getRandomValues)throw new Error('Secure browser randomness is unavailable');
      status=m._scw_generate();
      return {code:status,status:m.UTF8ToString(m._scw_status(status)),public_key:status===0?hex(m.HEAPU8.slice(m._scw_public(),m._scw_public()+32)):null};
    }
    if (command === 'init') {
      if (this.initialized) throw new Error('Already initialized');
      if (!globalThis.crypto?.getRandomValues) throw new Error('Secure browser randomness is unavailable');
      const serial = validText(args.serial ?? 'mcu-0001');
      if (serial.length < 1 || serial.length > 32 || !/^[!-~]+$/.test(args.serial ?? 'mcu-0001')) throw new Error('Serial must be 1–32 printable ASCII bytes');
      if (!['device','server'].includes(args.role)) throw new Error('Invalid role');
      m.HEAPU8.fill(0, m._scw_input(), m._scw_input()+4096);
      this.put(unhex(args.secret));
      if (args.role === 'device') this.put(unhex(args.server_public_key),32);
      this.put(serial,64);
      if (args.testSeed) {
        if (!m._scw_test_init) throw new Error('Test provisioning is unavailable');
        this.put(unhex(args.testSeed),128);status=m._scw_test_init(args.role === 'device' ? 1:2);
      } else status=m._scw_init(args.role === 'device' ? 1:2);
      this.initialized = status === 0;
    } else {
      if (!this.initialized) throw new Error('Endpoint not initialized');
      switch(command) {
        case 'state': break;
        case 'enrollment_enable': status=m._scw_enrollment_enable();break;
        case 'enrollment_begin': status=m._scw_enrollment_begin(uint64(args.now),uint64(args.expires));break;
        case 'enrollment_approve': this.put(unhex(args.challenge));this.put(unhex(args.key),32);status=m._scw_enrollment_approve(uint64(args.now));break;
        case 'enrollment_cancel': status=m._scw_enrollment_cancel();break;
        case 'reboot': status=m._scw_reboot(); break;
        case 'report':
          if (!Number.isInteger(args.temperature) || args.temperature < -2147483648 || args.temperature > 2147483647) throw new Error('Temperature must be an int32 millidegree value');
          status=m._scw_report(args.temperature);break;
        case 'name': { const bytes=validText(args.name);if(bytes.length>64)throw new Error('Name must fit in 64 UTF-8 bytes');this.put(bytes);status=m._scw_name(bytes.length);break; }
        case 'rx':
          if (!(args.frame instanceof Uint8Array) || args.frame.length>512) throw new Error('Frame must fit in 512 bytes');
          this.put(args.frame);status=args.now===undefined?m._scw_receive(args.frame.length):m._scw_receive_at(args.frame.length,uint64(args.now));break;
        case 'tx': {
          const budget=args.budget ?? 512;
          if (!Number.isInteger(budget) || budget<0 || budget>512)throw new Error('Budget must be 0–512 bytes');
          status=m._scw_outbound(budget);
          if(status===0)frame=m.HEAPU8.slice(m._scw_frame(),m._scw_frame()+m._scw_frame_length());break;
        }
        default: throw new Error('Unknown endpoint command');
      }
    }
    return {code:status,status:m.UTF8ToString(m._scw_status(status)),state:this.state(),...(frame?{frame}:{})};
  }
}
