import {hex} from './endpoint.mjs';
export const MAX_QUEUE=64, MAX_EVENTS=200;
// The demo device has a fixed serial before it generates keys or enrolls.
export const DEVICE_SERIAL='mcu-0001';
export class Lab {
  constructor(onChange=()=>{},workerFactory=url=>new Worker(url,{type:'module'})) {
    this.onChange=onChange;this.workerFactory=workerFactory;this.epoch=0;this.workers={};this.pending=new Map();this.sequence=0;
    this.queue=[];this.archive=[];this.events=[];this.states={};this.nextPacket=1;this.ready=false;// Freeze the simulated server clock at a real date for readable packet timestamps.
    this.time=Math.floor(Date.now()/1000);
  }
  notify(){this.onChange(this);}
  event(message,kind='info'){this.events.push({message,kind});if(this.events.length>MAX_EVENTS)this.events.shift();this.notify();}
  stop(){
    this.epoch++;this.ready=false;
    for(const worker of Object.values(this.workers))worker.terminate();
    this.workers={};for(const pending of this.pending.values())pending.reject(new DOMException('Session reset','AbortError'));
    this.pending.clear();
  }
  async reset({deferDevice=false}={}){
    this.stop();const epoch=this.epoch;this.queue=[];this.archive=[];this.events=[];this.states={};this.devicePublicKey=null;this.verifiedChallenge=null;this.authorization=null;this.nextPacket=1;this.notify();
    try{
      if(!globalThis.crypto?.getRandomValues)throw new Error('Secure browser randomness is unavailable. Open this demo over HTTPS or localhost.');
      // Compatibility slot only: signed enrollment uses no shared enrollment secret.
      const secret='00'.repeat(32);
      for(const role of ['device','server']){
        const worker=this.workerFactory(new URL('./worker.mjs',import.meta.url));this.workers[role]=worker;
        worker.onmessage=({data})=>{const p=this.pending.get(data.id);if(!p)return;this.pending.delete(data.id);data.error?p.reject(new Error(data.error)):p.resolve(data.result);};
        worker.onerror=()=>{for(const [id,p]of this.pending){if(p.role===role){this.pending.delete(id);p.reject(new Error(`${role} runtime failed to load or execute`));}}};
      }
      const server=await this.raw('server','init',{role:'server',serial:DEVICE_SERIAL,secret});
      if(epoch!==this.epoch)throw new DOMException('Session reset','AbortError');
      if(server.code!==0)throw new Error(server.status);
      this.authorization=secret;
      const enabled=await this.raw('server','enrollment_enable');if(enabled.code!==0)throw new Error(enabled.status);
      if(deferDevice){this.states={server:enabled.state};this.ready=true;this.event('Server ready. Device key has not been generated.');return;}
      const device=await this.raw('device','init',{role:'device',serial:DEVICE_SERIAL,secret,server_public_key:server.state.public_key});
      if(device.code!==0)throw new Error(device.status);
      if(epoch!==this.epoch)throw new DOMException('Session reset','AbortError');
      const enabledDevice=await this.raw('device','enrollment_enable');if(enabledDevice.code!==0)throw new Error(enabledDevice.status);this.states={server:enabled.state,device:enabledDevice.state};this.ready=true;
      this.event('Fresh identities ready. The device holds the server’s public key. No frames have been sent.');
    }catch(error){if(epoch===this.epoch){this.stop();this.event(error.message,'error');}throw error;}
  }
  async generateDevice({fromChallenge=false}={}){
    const epoch=this.epoch;const result=await this.raw('device',fromChallenge?'generate_from_challenge':'generate');
    if(epoch!==this.epoch)throw new DOMException('Session reset','AbortError');
    if(result.code!==0)throw new Error(result.status);
    this.devicePublicKey=result.public_key;this.event('Device generated an Ed25519 key pair locally. No packet sent.');
    return result.public_key;
  }
  async provisionDevice(){
    const epoch=this.epoch;const result=await this.raw('device','init',{role:'device',serial:DEVICE_SERIAL,secret:this.authorization,server_public_key:this.states.server.public_key});
    if(epoch!==this.epoch)throw new DOMException('Session reset','AbortError');
    if(result.code!==0)throw new Error(result.status);
    const enabled=await this.raw('device','enrollment_enable');if(epoch!==this.epoch)throw new DOMException('Session reset','AbortError');if(enabled.code!==0)throw new Error(enabled.status);this.states.device=enabled.state;this.event('Device identity ready; its serial and trusted server public key are already available.');
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
    this.event(command==='issue'?`Server issued ${args.total} cumulative credits and requested status.`:command==='consume'?`Device consumed ${args.amount} credits locally. No report requested.`:command==='request'?'Server requested a fresh credit snapshot.':`${role} rebooted with durable state.`);
    return r;
  }
  async beginEnrollment(){
    const r=await this.command('server','enrollment_begin',{now:this.time,expires:this.time+600});
    if(r.code!==0)throw new Error(r.status);
    this.event('Application policy authorized a 10-minute enrollment session.');
  }
  async approveEnrollment(){
    const s=this.states.server;
    const r=await this.command('server','enrollment_approve',{challenge:s.challenge,key:s.candidate_key,now:this.time});
    if(r.code!==0)throw new Error(r.status);
    this.event('Application policy approved this exact serial, session, and Ed25519 key. Device registered.');
  }
  async transmit(role,budget=512){
    if(this.queue.length>=MAX_QUEUE)throw new Error('Relay queue is full (64 frames). Deliver or drop a frame before another opportunity.');
    const epoch=this.epoch;const r=await this.command(role,'tx',{budget});
    if(epoch!==this.epoch)throw new DOMException('Session reset','AbortError');
    if(r.code===1){this.event(`${role}: nothing to send.`);return null;}
    if(r.code<0)throw new Error(`${role}: ${r.status}; no frame queued.`);
    // UI serializes opportunities. Reserve capacity defensively for callers too.
    if(this.queue.length>=MAX_QUEUE)throw new Error('Relay queue filled during transmission; latest endpoint state remains pending.');
    const packet={id:this.nextPacket++,from:role,to:role==='device'?'server':'device',signed:r.frame[2]===69,messageKind:r.messageKind,senderState:Object.freeze({...this.states[role]}),bytes:r.frame.slice(),corrupted:false,location:role+'-outbox',origin:this.nextPacket-1};
    this.queue.push(packet);this.event(`Frame ${packet.id}: ${role} → ${packet.to}, ${packet.bytes.length} ${packet.signed?'public signed':'encrypted'} bytes queued.`);return packet.id;
  }
  packet(id){const p=this.queue.find(p=>p.id===id);if(!p)throw new Error('Frame is no longer queued');return p;}
  remember(packet,outcome){this.archive.unshift({...packet,bytes:packet.bytes.slice(),outcome});if(this.archive.length>16)this.archive.pop();}
  move(id,location){if(!['relay','device-outbox','server-outbox'].includes(location))throw new Error('Unknown holding area');this.packet(id).location=location;this.event(`Message ${id} held; no endpoint has received it.`);}
  drop(id){const p=this.packet(id);this.remember({...p,result:null},'dropped · receiver not called');this.queue=this.queue.filter(p=>p.id!==id);this.event(`Host discarded message ${id}.`);}
  replay(packet){if(this.queue.length>=MAX_QUEUE)throw new Error('Relay queue is full (64 messages).');const copy={...packet,id:this.nextPacket++,bytes:packet.bytes.slice(),location:'relay'};delete copy.outcome;delete copy.result;this.queue.push(copy);this.event(`An identical copy of message ${packet.id} is queued as message ${copy.id}.`);return copy.id;}
  duplicate(id){
    if(this.queue.length>=MAX_QUEUE)throw new Error('Relay queue is full (64 frames).');
    const p=this.packet(id);const copy={...p,id:this.nextPacket++,bytes:p.bytes.slice()};this.queue.push(copy);this.event(`Host duplicated frame ${id} as frame ${copy.id}.`);return copy.id;
  }
  corrupt(id){const p=this.packet(id);p.bytes[p.bytes.length-1]^=1;p.corrupted=!p.corrupted;this.event(`Host flipped the final wire byte of frame ${id}.`);}
  async deliver(id,target){
    const p=this.packet(id);target=target??p.to;if(!['device','server'].includes(target))throw new Error('Unknown recipient');const epoch=this.epoch;
    const before={...this.states[target]};
    const result=target==='device'&&!this.states.device
      ?await this.raw('device','verify_challenge',{frame:p.bytes.slice(),server_public_key:this.states.server.public_key,serial:DEVICE_SERIAL})
      :await this.command(target,'rx',{frame:p.bytes.slice(),now:this.time});
    if(target==='device'&&!this.states.device&&result.code===0)this.verifiedChallenge=p.bytes.slice();
    if(epoch!==this.epoch)throw new DOMException('Session reset','AbortError');
    this.queue=this.queue.filter(p=>p.id!==id);
    const fields=['registered','credits_issued','credits_consumed','request_id','snapshot_id','acknowledged_id','pending','challenge','candidate_key','candidate_revision'];
    const changes=fields.filter(k=>before[k]!==(result.state??{})[k]).map(k=>({field:k,before:before[k],after:(result.state??{})[k]}));
    result.changes=changes;
    this.remember({...p,result:{code:result.code,status:result.status,target,changed:changes.length}},result.code<0?'rejected by '+target:changes.length?'accepted by '+target:'accepted; no newer state');
    this.event(`Frame ${id} delivered to ${target}: ${result.code<0?'rejected — '+result.status:'authenticated and processed'}.`,result.code<0?'rejected':'success');
    return result;
  }
}
export const tour=[
  {title:'Deliver the signed challenge.',text:'The server opens an authorized session. Drag its challenge to the device.',target:'device',success:'The signature is valid. Now generate a private identity using secure local randomness, with the public challenge mixed in as additional input.',code:'sc_enrollment_begin(&server, now, expires);\nsc_receive(&device, frame, length);',prepare:async l=>{await l.beginEnrollment();return l.transmit('server');}},
  {title:'Deliver the encrypted response.',text:'The device returns the challenge, its identity, to prove possession of its private key.',target:'server',success:'The response authenticated. This proposed key is waiting for trusted approval; nothing is registered yet.',code:'sc_receive_at(&server, frame, length, now);',prepare:async l=>{if(!l.states.device){await l.generateDevice({fromChallenge:true});await l.provisionDevice();const r=await l.command('device','rx',{frame:l.verifiedChallenge});if(r.code!==0)throw new Error(r.status);}return l.transmit('device');}},
  {title:'Deliver the enrollment confirmation.',text:'The approved server reply confirms this enrollment session.',target:'device',success:'You’re connected! Continue to credits to see the device and server share data. Or retry enrollment: corrupt a packet before delivering it, or advance server time before sending the response, and see how the library reacts.',code:'sc_receive(&device, frame, length);',prepare:l=>l.transmit('server')},
 {title:'Deliver 100 issued credits.',text:'The server grants a cumulative total of 100 and asks for a status snapshot. Replaying this grant cannot add another 100.',target:'device',success:'The device accepted 100 issued credits and captured its current consumption for this request.',code:'sc_set_credits_issued(&server, 100);',prepare:async l=>{await l.update('server','issue',{total:'100'});return l.transmit('server');}},
 {title:'Deliver the credit snapshot.',text:'This captured response contains 100 issued and 0 consumed. It also confirms that the device accepted the grant.',target:'server',success:'The server knows the device accepted 100 credits and had consumed 0 when it answered.',code:'sc_receive(&server, frame, length);',prepare:l=>l.transmit('device')},
 {title:'Deliver the receipt.',text:'The server acknowledges this exact snapshot. The receipt asks for no additional report.',target:'device',success:'The exchange is settled. Next, spend credits locally without sending a message.',code:'sc_receive(&device, frame, length);',prepare:l=>l.transmit('server')},
 {title:'Deliver the status request.',text:'The server requests current consumption. Until this reaches the device, its last report remains 0.',target:'device',success:'The device captured a new snapshot: 100 issued, 25 consumed.',code:'sc_request_credit_status(&server);',prepare:async l=>{await l.update('server','request',{});return l.transmit('server');}},
 {title:'Deliver the updated snapshot.',text:'The encrypted response links 25 consumed credits to this request. Older snapshots cannot roll it back.',target:'server',success:'The server’s last reported consumption is now 25.',code:'sc_receive(&server, frame, length);',prepare:l=>l.transmit('device')},
 {title:'Deliver the final receipt.',text:'The device can stop retrying this snapshot once it receives the authenticated receipt.',target:'device',success:'Both sides agree on the last reported snapshot. Future consumption remains local until another request.',code:'sc_receive(&device, frame, length);',prepare:l=>l.transmit('server')}
];
