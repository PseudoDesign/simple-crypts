import {hex} from './endpoint.mjs';
export const MAX_QUEUE=64, MAX_EVENTS=200;
export class Lab {
  constructor(onChange=()=>{},workerFactory=url=>new Worker(url,{type:'module'})) {
    this.onChange=onChange;this.workerFactory=workerFactory;this.epoch=0;this.workers={};this.pending=new Map();this.sequence=0;
    this.queue=[];this.archive=[];this.events=[];this.states={};this.nextPacket=1;this.ready=false;
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
    this.stop();const epoch=this.epoch;this.queue=[];this.archive=[];this.events=[];this.states={};this.nextPacket=1;this.notify();
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
    const packet={id:this.nextPacket++,from:role,to:role==='device'?'server':'device',bytes:r.frame.slice(),corrupted:false,location:role+'-outbox',origin:this.nextPacket-1};
    this.queue.push(packet);this.event(`Frame ${packet.id}: ${role} → ${packet.to}, ${packet.bytes.length} opaque bytes queued.`);return packet.id;
  }
  packet(id){const p=this.queue.find(p=>p.id===id);if(!p)throw new Error('Frame is no longer queued');return p;}
  remember(packet,outcome){this.archive.unshift({...packet,bytes:packet.bytes.slice(),outcome});if(this.archive.length>16)this.archive.pop();}
  move(id,location){if(!['relay','device-outbox','server-outbox'].includes(location))throw new Error('Unknown holding area');this.packet(id).location=location;this.event(`Message ${id} held; no endpoint has received it.`);}
  drop(id){const p=this.packet(id);this.remember(p,'discarded');this.queue=this.queue.filter(p=>p.id!==id);this.event(`Host discarded message ${id}.`);}
  replay(packet){if(this.queue.length>=MAX_QUEUE)throw new Error('Relay queue is full (64 messages).');const copy={...packet,id:this.nextPacket++,bytes:packet.bytes.slice(),location:'relay'};delete copy.outcome;this.queue.push(copy);this.event(`An identical copy of message ${packet.id} is queued as message ${copy.id}.`);return copy.id;}
  duplicate(id){
    if(this.queue.length>=MAX_QUEUE)throw new Error('Relay queue is full (64 frames).');
    const p=this.packet(id);const copy={...p,id:this.nextPacket++,bytes:p.bytes.slice()};this.queue.push(copy);this.event(`Host duplicated frame ${id} as frame ${copy.id}.`);return copy.id;
  }
  corrupt(id){const p=this.packet(id);p.bytes[p.bytes.length-1]^=1;p.corrupted=!p.corrupted;this.event(`Host flipped the final ciphertext byte of frame ${id}.`);}
  async deliver(id,target){
    const p=this.packet(id);target=target??p.to;if(!['device','server'].includes(target))throw new Error('Unknown recipient');const epoch=this.epoch;
    const before={...this.states[target]};
    const result=await this.command(target,'rx',{frame:p.bytes.slice()});
    if(epoch!==this.epoch)throw new DOMException('Session reset','AbortError');
    this.queue=this.queue.filter(p=>p.id!==id);
    const fields=['registered','temperature','actual_name','desired_name','reported_revision','desired_revision','processed_desired_revision','acked_reported_revision','pending'];
    const changes=fields.filter(k=>before[k]!==result.state[k]).map(k=>({field:k,before:before[k],after:result.state[k]}));
    result.changes=changes;
    this.remember(p,result.code<0?'rejected by '+target:changes.length?'accepted by '+target:'accepted; no newer state');
    this.event(`Frame ${id} delivered to ${target}: ${result.code<0?'rejected — '+result.status:'authenticated and processed'}.`,result.code<0?'rejected':'success');
    return result;
  }
}
export const tour=[
  {title:'The device creates its first message',text:'Enrollment and −18.250 °C travel together in this sealed box. You are the intermediary: drag it to Discard to simulate losing the first transmission.',target:'discard',success:'Message lost. Neither endpoint mistakes transmission for delivery; the device is still pending.',code:'sc_report_temperature(&device, -18250);\nsc_outbound(&device, 512, frame, sizeof frame, &length);',prepare:async l=>{await l.update('device','report',{temperature:-18250});return l.transmit('device');}},
  {title:'Try the next self-contained report',text:'The device has a newer temperature. Drag its new message to the Server inbox. It can enroll and report useful data without having received a reply.',target:'server',success:'The server authenticated the message, enrolled the device, and accepted −18.125 °C.',code:'sc_report_temperature(&device, -18125);\nsc_receive(&server, frame, length);',prepare:async l=>{await l.update('device','report',{temperature:-18125});return l.transmit('device');}},
  {title:'The server creates a desired-state message',text:'The server requests “Freezer 3.” Drag the server’s message to the Device inbox. Watch which side knows the name was applied.',target:'device',success:'The device applied the name. The server is still pending because it has not received an application report.',code:'sc_set_name(&server, "Freezer 3");\nsc_receive(&device, frame, length);',prepare:async l=>{await l.update('server','name',{name:'Freezer 3'});return l.transmit('server');}},
  {title:'Lose the application report',text:'The device generated a report confirming the name it applied. Drag this message to Discard. Sending an acknowledgment does not guarantee it arrives.',target:'discard',success:'The application report was lost. The server correctly keeps the name change pending.',code:'sc_outbound(&device, 512, frame, sizeof frame, &length);\n// The intermediary discards the report.',prepare:l=>l.transmit('device')},
  {title:'A reboot, then another opportunity',text:'The device rebooted with its simulated storage intact and generated a fresh report. Drag it to the Server inbox to close the information gap.',target:'server',success:'The server now knows the name was applied. The device still needs a receipt for its report.',code:'sc_init(&device, &config, &provider);\nsc_receive(&server, frame, length);',prepare:async l=>{await l.update('device','reboot',{});return l.transmit('device');}},
  {title:'Deliver the final receipt',text:'The server generated its receipt. Drag this last message to the Device inbox. No messages move unless you move them.',target:'device',success:'Both endpoints are confirmed. Try the sandbox: duplicate a message, tamper with it, replay an older one, or send it back to its source.',code:'sc_receive(&device, frame, length);\n// Both endpoint states are now confirmed.',prepare:l=>l.transmit('server')}
];
