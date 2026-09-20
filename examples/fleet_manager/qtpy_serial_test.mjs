import assert from 'node:assert/strict';
import { SerialLink, crc32, encode, decode, commands } from './qtpy-serial.mjs';

assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
for (const length of [0, 1, 253, 254, 255, 1008]) {
  const input = Uint8Array.from({ length }, (_, i) => i % 256);
  assert.deepEqual(decode(encode(input).subarray(0, -1)), input);
}
assert.throws(() => decode(new Uint8Array([4, 1])));
assert.throws(() => decode(new Uint8Array([2, 0])));
function response(frame, status = 0, payload = new Uint8Array([7])) {
  const request = decode(frame.subarray(0, -1));
  const out = new Uint8Array(16 + payload.length);
  out.set([81, 82, 1, request[3]]);
  out.set(request.subarray(4, 8), 4);
  out.set(payload, 12);
  new DataView(out.buffer).setInt32(8, status);
  new DataView(out.buffer).setUint32(out.length - 4, crc32(out.subarray(0, -4)));
  return encode(out);
}
function fake(handler) {
  let controller;
  const sent = [];
  const port = {
    readable: new ReadableStream({
      start(c) {
        controller = c;
      },
    }),
    writable: new WritableStream({
      write(bytes) {
        if (bytes.length === 1) return;
        sent.push(bytes.slice());
        handler(bytes, controller);
      },
    }),
    async open() {},
    async setSignals(signals) {
      assert.equal(signals.dataTerminalReady, true);
    },
    async close() {},
  };
  return { port, sent };
}
{
  const { port } = fake((bytes, c) => {
    const reply = response(bytes);
    c.enqueue(reply.subarray(0, 3));
    c.enqueue(reply.subarray(3));
  });
  const link = new SerialLink(port);
  await link.open();
  assert.deepEqual(await link.command(commands.inspect), new Uint8Array([7]));
  await link.close();
}
{
  let count = 0;
  const { port } = fake((bytes, c) => c.enqueue(response(bytes, count++ ? 1 : -2)));
  const link = new SerialLink(port);
  await link.open();
  await assert.rejects(link.command(commands.inspect), /Device status -2/);
  assert.equal(await link.command(commands.outbound), null);
  assert.equal(link.failed, false);
  await link.close();
}
for (const fault of ['crc', 'sequence', 'disconnect', 'oversized', 'timeout', 'write']) {
  const { port, sent } = fake((bytes, c) => {
    if (fault === 'write') throw new Error('Write failed');
    if (fault === 'timeout') return;
    if (fault === 'disconnect') {
      c.close();
      return;
    }
    if (fault === 'oversized') {
      c.enqueue(new Uint8Array(1031).fill(1));
      return;
    }
    const raw = decode(response(bytes).subarray(0, -1));
    if (fault === 'crc') raw[12] ^= 1;
    else {
      raw[7] ^= 1;
      new DataView(raw.buffer).setUint32(raw.length - 4, crc32(raw.subarray(0, -4)));
    }
    c.enqueue(encode(raw));
  });
  const link = new SerialLink(port, 20);
  await link.open();
  const pending = link.command(commands.setup, new Uint8Array(268));
  await assert.rejects(link.command(commands.inspect), /in progress/);
  await assert.rejects(pending, /No command was retried/);
  await assert.rejects(link.command(commands.inspect), /Reconnect/);
  assert.equal(sent.length, 1);
  await link.close();
}
console.log(
  'QT Py framing, chunking, status, timeout, disconnect, corruption, and no-retry tests passed',
);
