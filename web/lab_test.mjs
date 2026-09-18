import assert from 'node:assert/strict';
import {Lab,MAX_EVENTS} from './lab.mjs';
const l=new Lab();l.ready=true;l.queue=[{id:1,from:'device',to:'server',bytes:new Uint8Array([1,2,3]),corrupted:false}];l.nextPacket=2;
const copy=l.duplicate(1);l.corrupt(copy);assert.deepEqual([...l.packet(1).bytes],[1,2,3]);assert.deepEqual([...l.packet(copy).bytes],[1,2,2]);
for(let i=l.queue.length;i<64;i++)l.duplicate(1);
let called=false;l.command=async()=>{called=true;return {code:1};};await assert.rejects(()=>l.transmit('device'),/full/);assert(!called);assert.throws(()=>l.duplicate(1),/full/);
for(let i=0;i<1000;i++)l.event('event '+i);assert.equal(l.events.length,MAX_EVENTS);assert.equal(l.events[0].message,'event 800');
let cancelled=false;l.workers={device:{terminate(){cancelled=true;}}};l.pending.set(1,{reject(error){assert.equal(error.name,'AbortError');}});l.stop();assert(cancelled);assert.equal(l.pending.size,0);assert(!l.ready);
console.log('PASS relay: independent copies, queue/history bounds, no transmission at capacity, cancellation');
