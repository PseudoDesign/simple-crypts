import createModule from './endpoint.wasm.mjs';
import { Endpoint } from './endpoint.mjs';
const ready = createModule().then((module) => new Endpoint(module));
let serial = Promise.resolve();
self.onmessage = ({ data }) => {
  serial = serial.then(async () => {
    try {
      const endpoint = await ready;
      const result = await endpoint.command(data.command, data.args);
      self.postMessage({ id: data.id, result }, result.frame ? [result.frame.buffer] : []);
    } catch (error) {
      self.postMessage({ id: data.id, error: error.message });
    }
  });
};
