import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';
import {Endpoint} from './endpoint.mjs';
globalThis.crypto=webcrypto;
const factory=(await import(pathToFileURL(resolve(process.argv[2])))).default;
const production=(await import(pathToFileURL(resolve(process.argv[3])))).default;
const native=resolve(process.argv[4]);const secret='33'.repeat(32);
let checks=0;
async function wasm(role,peer,override={}){
 const module=await factory();const e=new Endpoint(module);
 const r=await e.command('init',{role,secret,server_public_key:peer,testSeed:(role==='device'?'11':'22').repeat(32),...override});assert.equal(r.code,0);return e;
}
async function pair(){const s=await wasm('server');return [await wasm('device',s.state().public_key),s];}
async function ok(e,cmd,args={}){const r=await e.command(cmd,args);assert.equal(r.code,0,r.status);return r;}
async function tx(e){return (await ok(e,'tx')).frame;}
async function move(a,b){return ok(b,'rx',{frame:await tx(a)});}
const nonce=f=>Buffer.from(f.slice(38,62)).toString('hex');
async function scenario(name,fn){await fn();checks++;console.log('PASS '+name);}
await scenario('enrollment with useful data, lost first frame, confirmation, reboot',async()=>{
 const[d,s]=await pair();await ok(d,'report',{temperature:-18250});const lost=await tx(d);assert(!s.state().registered);
 await ok(d,'report',{temperature:-18125});const next=await tx(d);assert.notEqual(nonce(lost),nonce(next));await ok(s,'rx',{frame:next});assert.equal(s.state().temperature,-18125);
 await ok(s,'name',{name:'Freezer 3'});await move(s,d);assert.equal(d.state().actual_name,'Freezer 3');assert(s.state().pending);
 const receipt=await tx(d);const identity=d.state().public_key;await ok(d,'reboot');assert.equal(d.state().public_key,identity);
 const retry=await tx(d);assert.notEqual(nonce(retry),nonce(receipt));await ok(s,'rx',{frame:retry});await move(s,d);assert(!s.state().pending&&!d.state().pending);
});
await scenario('duplicates, stale reports, corrupted ciphertext and reflection',async()=>{
 const[d,s]=await pair();await ok(d,'report',{temperature:1000});const old=await tx(d);await ok(d,'report',{temperature:2000});const newer=await tx(d);
 await ok(s,'rx',{frame:newer});await ok(s,'rx',{frame:old});await ok(s,'rx',{frame:newer});assert.equal(s.state().temperature,2000);
 const before=s.state();const modified=newer.slice();modified[modified.length-1]^=1;assert((await s.command('rx',{frame:modified})).code<0);assert.deepEqual(s.state(),before);
 const deviceBefore=d.state();assert((await d.command('rx',{frame:newer})).code<0);assert.deepEqual(d.state(),deviceBefore);
});
await scenario('invalid enrollment authorization and conflicting device identity',async()=>{
 const[d,s]=await pair();const bad=await wasm('device',s.state().public_key,{secret:'44'.repeat(32)});await ok(bad,'report',{temperature:1});assert.equal((await s.command('rx',{frame:await tx(bad)})).code,-10);assert(!s.state().registered);
 await ok(d,'report',{temperature:2});await move(d,s);const conflict=await wasm('device',s.state().public_key,{testSeed:'55'.repeat(32)});await ok(conflict,'report',{temperature:3});assert((await s.command('rx',{frame:await tx(conflict)})).code<0);assert.equal(s.state().temperature,2);
});
await scenario('exact uint64 revisions, UTF-8 bounds, application rejection',async()=>{
 const[d,s]=await pair();const big=9007199254740993n;assert.equal(s.m._scw_test_revision(big),0);
 await ok(d,'report',{temperature:10});await move(d,s);await ok(s,'name',{name:'é'.repeat(32)});assert.equal(s.state().desired_revision,(big+1n).toString());await move(s,d);assert.equal(d.state().applied_desired_revision,(big+1n).toString());await move(d,s);assert(!s.state().pending);
 await assert.rejects(()=>s.command('name',{name:'é'.repeat(33)}),/64 UTF-8/);await assert.rejects(()=>s.command('name',{name:'\ud800'}),/UTF-8/);await assert.rejects(()=>s.command('name',{name:'x\0y'}),/NUL/);
 await ok(s,'name',{name:''});await move(s,d);assert.equal(d.state().apply_status,2);await move(d,s);assert(!s.state().pending);assert.equal(s.state().apply_status,2);
});
await scenario('storage and reservation failure recovery, budgets, copied buffers',async()=>{
 const[d,s]=await pair();const before=d.state();d.m._scw_test_fail(1);assert.equal((await d.command('report',{temperature:3})).code,-5);assert.deepEqual(d.state(),before);await ok(d,'report',{temperature:3});
 const state=d.state();assert.equal((await d.command('tx',{budget:1})).code,-2);assert.deepEqual(d.state(),state);
 d.m._scw_test_fail(2);assert.equal((await d.command('tx')).code,-5);const a=await tx(d),copy=a.slice();const b=await tx(d);assert.deepEqual(a,copy);assert.notEqual(nonce(a),nonce(b));b.fill(0);await ok(s,'rx',{frame:a});
});
await scenario('no fresh randomness required after provisioning; secure provisioning required',async()=>{
 const[d,s]=await pair();globalThis.crypto=undefined;
 try{await ok(d,'report',{temperature:4});await move(d,s);await ok(d,'reboot');await move(d,s);const e=new Endpoint(await production());await assert.rejects(()=>e.command('init',{role:'server',secret}),/randomness/);}finally{globalThis.crypto=webcrypto;}
 const p=new Endpoint(await production());assert.equal(p.m._scw_test_init,undefined);await assert.rejects(()=>p.command('init',{role:'server',secret,testSeed:'22'.repeat(32)}),/unavailable/);
});
class Native {
 constructor(dir){this.child=spawn(native,[],{stdio:['pipe','pipe','inherit']});this.waiters=[];this.dir=dir;createInterface({input:this.child.stdout}).on('line',line=>this.waiters.shift()?.resolve(JSON.parse(line)));this.child.on('exit',code=>{for(const p of this.waiters)p.reject(new Error('native exited '+code));this.waiters=[];});}
 command(command,args={}){return new Promise((resolve,reject)=>{this.waiters.push({resolve,reject});this.child.stdin.write(JSON.stringify({command,...args})+'\n');});}
 close(){this.child.stdin.end();this.child.kill();}
}
for(const role of ['device','server'])await scenario(`native C ↔ WebAssembly (${role} in Wasm), including exact ciphertext`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sc-web-'));const n=new Native(dir);const mirror=new Native(dir);try{
 const s=await wasm('server');const w=role==='server'?s:await wasm('device',s.state().public_key);const nativeRole=role==='device'?'server':'device';
 for(const [endpoint,r,storage]of [[n,nativeRole,join(dir,'native')],[mirror,role,join(dir,'mirror')]]){const result=await endpoint.command('init',{role:r,storage,serial:'mcu-0001',secret,key_seed:(r==='device'?'11':'22').repeat(32),server_public_key:s.state().public_key});assert.equal(result.status,'ok');}
 const cmd=role==='device'?'report':'name';const args=role==='device'?{temperature:-18125}:{name:'Wasm freezer'};
 if(role==='server'){await n.command('report',{temperature:5});const first=await n.command('tx');const frame=Uint8Array.from(Buffer.from(first.frame,'base64'));await ok(w,'rx',{frame});await mirror.command('rx',{frame:first.frame});}
 await ok(w,cmd,args);assert.equal((await mirror.command(cmd,args)).status,'ok');const frame=await tx(w);const m=await mirror.command('tx');assert.equal(Buffer.from(frame).toString('base64'),m.frame);
 const result=await n.command('rx',{frame:Buffer.from(frame).toString('base64')});assert.equal(result.status,'ok');
 if(role==='device')await n.command('name',{name:'Native freezer'});
 const reply=await n.command('tx');await ok(w,'rx',{frame:Uint8Array.from(Buffer.from(reply.frame,'base64'))});
 const receipt=await tx(w);assert.equal((await n.command('rx',{frame:Buffer.from(receipt).toString('base64')})).status,'ok');
 }finally{n.close();mirror.close();await rm(dir,{recursive:true,force:true});}
});
console.log(`${checks} WebAssembly protocol scenarios passed`);
