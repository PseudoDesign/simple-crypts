import {hex} from './endpoint.mjs';
export const MAX_QUEUE=64, MAX_EVENTS=200;
export class Lab {
  constructor(onChange=()=>{},workerFactory=url=>new Worker(url,{type:'module'})) {
    this.onChange=onChange;this.workerFactory=workerFactory;this.epoch=0;this.workers={};this.pending=new Map();this.sequence=0;
    this.queue=[];this.events=[];this.states={};this.nextPacket=1;this.ready=false;
  }
  notify(){this.onChange(this);}
  event(message,kind='info'){this.events.push({message,kind});if(this.events.length>MAX_EVENTS)this.events.shift();this.notify();}
  stop(){
    this.epoch++;this.ready=false;
    for(const worker of Object.values(this.workers))worker.terminate();
    this.workers={};for(const pending of this.pending.values())pending.reject(new DOMException('Session reset','AbortError'));
    this.pending.clear();
  }
  async reset(){
    this.stop();const epoch=this.epoch;this.queue=[];this.events=[];this.states={};this.nextPacket=1;this.notify();
    try{
      if(!globalThis.crypto?.getRandomValues)throw new Error('Secure browser randomness is unavailable. Open this demo over HTTPS or localhost.');
      const secretBytes=crypto.getRandomValues(new Uint8Array(32));const secret=hex(secretBytes);secretBytes.fill(0);
      for(const role of ['device','server']){
        const worker=this.workerFactory(new URL('./worker.mjs',import.meta.url));this.workers[role]=worker;
        worker.onmessage=({data})=>{const p=this.pending.get(data.id);if(!p)return;this.pending.delete(data.id);data.error?p.reject(new Error(data.error)):p.resolve(data.result);};
        worker.onerror=()=>{for(const [id,p]of this.pending){if(p.role===role){this.pending.delete(id);p.reject(new Error(`${role} runtime failed to load or execute`));}}};
      }
      const server=await this.raw('server','init',{role:'server',secret});
      if(server.code!==0)throw new Error(server.status);
      const device=await this.raw('device','init',{role:'device',secret,server_public_key:server.state.public_key});
      if(device.code!==0)throw new Error(device.status);
      if(epoch!==this.epoch)throw new DOMException('Session reset','AbortError');
      this.states={server:server.state,device:device.state};this.ready=true;
      this.event('Fresh identities provisioned. The device holds the server’s public key. No frames have been sent.');
    }catch(error){if(epoch===this.epoch){this.stop();this.event(error.message,'error');}throw error;}
  }
  raw(role,command,args={}){
    const worker=this.workers[role];if(!worker)return Promise.reject(new Error('Endpoint is unavailable'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject,role});worker.postMessage({id,command,args});});
  }
  async command(role,command,args={}){
    if(!this.ready)throw new Error('Session is not ready');
    const epoch=this.epoch;const response=await this.raw(role,command,args);
    if(epoch!==this.epoch)throw new DOMException('Session reset','AbortError');
    this.states[role]=response.state;this.notify();
    return response;
  }
  async update(role,command,args){
    const r=await this.command(role,command,args);
    if(r.code<0)throw new Error(`${role}: ${r.status}`);
    this.event(command==='name'?`Server desires “${args.name}”. Awaiting an authenticated application report.`:command==='report'?`Device measures ${(args.temperature/1000).toFixed(3)} °C. Its latest snapshot is pending.`:`${role === 'device'?'Device':'Server'} rebooted; identity, stored revisions, and nonce reservations retained.`);
    return r;
  }
  async transmit(role,budget=512){
    if(this.queue.length>=MAX_QUEUE)throw new Error('Relay queue is full (64 frames). Deliver or drop a frame before another opportunity.');
    const epoch=this.epoch;const r=await this.command(role,'tx',{budget});
    if(epoch!==this.epoch)throw new DOMException('Session reset','AbortError');
    if(r.code===1){this.event(`${role}: nothing to send.`);return null;}
    if(r.code<0)throw new Error(`${role}: ${r.status}; no frame queued.`);
    // UI serializes opportunities. Reserve capacity defensively for callers too.
    if(this.queue.length>=MAX_QUEUE)throw new Error('Relay queue filled during transmission; latest endpoint state remains pending.');
    const packet={id:this.nextPacket++,from:role,to:role==='device'?'server':'device',bytes:r.frame.slice(),corrupted:false};
    this.queue.push(packet);this.event(`Frame ${packet.id}: ${role} → ${packet.to}, ${packet.bytes.length} opaque bytes queued.`);return packet.id;
  }
  packet(id){const p=this.queue.find(p=>p.id===id);if(!p)throw new Error('Frame is no longer queued');return p;}
  drop(id){this.packet(id);this.queue=this.queue.filter(p=>p.id!==id);this.event(`Host dropped frame ${id}.`);}
  duplicate(id){
    if(this.queue.length>=MAX_QUEUE)throw new Error('Relay queue is full (64 frames).');
    const p=this.packet(id);const copy={...p,id:this.nextPacket++,bytes:p.bytes.slice()};this.queue.push(copy);this.event(`Host duplicated frame ${id} as frame ${copy.id}.`);return copy.id;
  }
  corrupt(id){const p=this.packet(id);p.bytes[p.bytes.length-1]^=1;p.corrupted=!p.corrupted;this.event(`Host flipped the final ciphertext byte of frame ${id}.`);}
  async deliver(id){
    const p=this.packet(id);const epoch=this.epoch;
    const result=await this.command(p.to,'rx',{frame:p.bytes.slice()});
    if(epoch!==this.epoch)throw new DOMException('Session reset','AbortError');
    this.queue=this.queue.filter(p=>p.id!==id);
    this.event(`Frame ${id} delivered to ${p.to}: ${result.code<0?'rejected — '+result.status:'authenticated and processed'}.`,result.code<0?'rejected':'success');
    return result;
  }
}
export const tour=[
  {title:'Useful data, before any reply',text:'The device measures −18.250 °C. Its first encrypted frame carries both enrollment and the temperature. There is no preliminary round trip.',code:'sc_report_temperature(&device, -18250);\nsc_outbound(&device, 512, frame, sizeof frame, &length);',run:async l=>{await l.update('device','report',{temperature:-18250});await l.transmit('device');}},
  {title:'The host drops the first frame',text:'Delivery is outside our control. Dropping a frame cannot make either endpoint believe it was received. The device keeps its latest state pending.',code:'// The host discards the opaque frame.\n// Neither endpoint needs a ping.',run:async l=>l.drop(l.queue[0].id)},
  {title:'A later report enrolls the device',text:'At the next explicit transmission opportunity, a fresh self-contained report reaches the server. It authorizes enrollment and accepts −18.125 °C together.',code:'sc_report_temperature(&device, -18125);\n// Forward the next opaque frame.\nsc_receive(&server, frame, length);',run:async l=>{await l.update('device','report',{temperature:-18125});await l.deliver(await l.transmit('device'));}},
  {title:'The server sets a name',text:'The server requests “Freezer 3.” The device authenticates and applies it. The server still shows pending: sending a request does not prove it was applied.',code:'sc_set_name(&server, "Freezer 3");\n// Forward the server frame to the device.\nsc_receive(&device, frame, length);',run:async l=>{await l.update('server','name',{name:'Freezer 3'});await l.deliver(await l.transmit('server'));}},
  {title:'The application report is lost',text:'The device reports that it applied the name, but the host drops that frame. The server correctly keeps the change pending.',code:'// Device reports its applied name revision.\n// The host drops this report.',run:async l=>l.drop(await l.transmit('device'))},
  {title:'Reboot without forgetting',text:'The demo recreates the device’s protocol context while retaining its simulated durable storage. Its identity and state survive; unused reserved nonces are skipped.',code:'sc_init(&device, &config, &provider);\n// Provider restores stored state and reserves fresh nonce ranges.',run:async l=>l.update('device','reboot',{})},
  {title:'Both endpoints agree',text:'Two explicit opportunities deliver the latest device report and server receipt. Both sides now show confirmed. No preliminary handshake, ping, or keepalive was required.',code:'// Forward device report, then server receipt.\nsc_receive(&server, device_frame, device_length);\nsc_receive(&device, server_frame, server_length);',run:async l=>{await l.deliver(await l.transmit('device'));await l.deliver(await l.transmit('server'));if(l.states.device.pending||l.states.server.pending)throw new Error('Expected both endpoints to confirm');}}
];
