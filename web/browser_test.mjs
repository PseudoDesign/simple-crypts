import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {chromium,firefox} from 'playwright';
const root=resolve(process.argv[2]||'bazel-bin/web/site');
const mime={'.html':'text/html','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json'};
const server=createServer(async(req,res)=>{try{
 let route=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 if(!route.startsWith('/simple-crypts/')){res.writeHead(404);return res.end();}
 route=route.slice('/simple-crypts/'.length);if(!route||route.endsWith('/'))route+='index.html';
 const file=resolve(root,route);if(!file.startsWith(root+sep))throw new Error('Invalid path');
 res.setHeader('Content-Type',mime[extname(file)]||'text/plain');res.end(await readFile(file));
}catch{res.writeHead(404);res.end('Not found');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/simple-crypts/`;
async function ready(page){await page.waitForFunction(()=>document.body.dataset.ready==='true'&&document.body.dataset.busy==='false');}
async function next(page){await page.locator('#next').click();await ready(page);}
const pending=page=>page.locator('#message-log .packet[data-pending="true"]').first();
const saved=page=>page.locator('#message-log .packet[data-pending="false"]').first();
async function dragPacket(page,packet,target,touch=false){
 const handle=packet.locator('[data-select]');await handle.scrollIntoViewIfNeeded();
 const from=await handle.boundingBox(),to=await page.locator(target).boundingBox(),viewport=page.viewportSize();
 const a={x:from.x+from.width/2,y:from.y+from.height/2};
 const b={x:to.x+to.width/2,y:Math.max(to.y+8,Math.min(to.y+to.height-8,Math.max(280,Math.min(viewport.height-16,to.y+to.height/2))))};
 const before=await page.evaluate(()=>document.querySelector('#message-log .packet[data-pending="false"]')?.dataset.packet??null);
 if(touch){
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a]});
  for(let i=1;i<=12;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:a.x+(b.x-a.x)*i/12,y:a.y+(b.y-a.y)*i/12}]});
  assert(await page.locator('.touch-packet').isVisible());
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
 }else{
  await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(a.x+12,a.y,{steps:4});await page.mouse.move(b.x,b.y,{steps:12});await page.mouse.up();
 }
 await page.waitForFunction(old=>document.querySelector('#message-log .packet[data-pending="false"]')?.dataset.packet!==old,before);
 await ready(page);assert.equal(await page.locator('.touch-packet,.drag-over').count(),0);
}
async function generate(page){
 assert.equal(await page.locator('#device-public-key').textContent(),'Not generated yet');
 assert.equal(await page.locator('#device-unique-id').textContent(),'mcu-0001');
 assert.equal(await page.locator('#pinned-server-key').textContent(),await page.locator('#server-public-key').textContent());
 await next(page);assert.equal(await page.locator('#device-public-key').textContent(),'Not generated yet');
 assert.equal(await pending(page).count(),1);
}
async function corrupt(packet){const button=packet.locator('[data-action="corrupt"]');await button.click();}
async function creditFlow(page,touch=false){
 if(await page.locator('body').getAttribute('data-chapter')!=='credits'){
  assert.equal(await page.locator('#device-issued').textContent(),'0');
  const key=await page.locator('#device-public-key').textContent();
  await next(page);
  assert.equal(await page.locator('#device-public-key').textContent(),key);
 }
 assert.equal(await page.locator('body').getAttribute('data-chapter'),'credits');
 assert.equal(await page.locator('#chapter-credits').getAttribute('aria-current'),'step');
 assert.equal(await page.locator('#message-log .packet').count(),0);
 assert.equal(await page.locator('#device-status').textContent(),'Confirmed');
 assert(await page.locator('#next').isHidden());
 await page.locator('#add-credit').click();await ready(page);const grantId=await pending(page).getAttribute('data-packet');
 await dragPacket(page,pending(page),'#device-panel',touch);assert.equal(await page.locator('#device-issued').textContent(),'100');
 const grant=page.locator(`[data-packet="-${grantId}"]`);
 await dragPacket(page,grant,'#device-panel',touch);assert.equal(await page.locator('#device-issued').textContent(),'100');
 await next(page);await dragPacket(page,pending(page),'#server-panel',touch);assert.equal(await page.locator('#server-consumed').textContent(),'0');
 await next(page);assert.match(await pending(page).textContent(),/Receipt for request/);assert(!/Credits consumed/.test(await pending(page).textContent()));await dragPacket(page,pending(page),'#device-panel',touch);
 assert(await page.locator('#next').isHidden());
 await page.locator('#consume-credit').click();await ready(page);assert.equal(await pending(page).count(),0);assert.equal(await page.locator('#device-consumed').textContent(),'25');assert.equal(await page.locator('#server-consumed').textContent(),'0');
 await next(page);await dragPacket(page,pending(page),'#device-panel',touch);
 await next(page);await corrupt(pending(page));await dragPacket(page,pending(page),'#server-panel',touch);assert.match(await page.locator('#server-result').textContent(),/authentication/);assert.equal(await page.locator('#server-consumed').textContent(),'0');
 await corrupt(saved(page));await dragPacket(page,saved(page),'#server-panel',touch);assert.equal(await page.locator('#server-consumed').textContent(),'25');
 await next(page);await dragPacket(page,pending(page),'#device-panel',touch);assert.match(await page.locator('#tour-title').textContent(),/Credit exchange complete/);
}
async function errorFlow(page,touch=false){
 if(!touch){
  await page.locator('#add-credit').click();await ready(page);
  assert.equal(await page.locator('#server-issued').textContent(),'200');
  assert.equal(await page.locator('#device-issued').textContent(),'100');
  await dragPacket(page,pending(page),'#device-panel');
  await page.locator('#consume-credit').click();await ready(page);
  assert.equal(await page.locator('#device-consumed').textContent(),'50');
  assert.equal(await page.locator('#server-consumed').textContent(),'25');
  assert.equal(await pending(page).count(),0);
 }
 const issued=await page.locator('#device-issued').textContent();
 let consumed=BigInt(await page.locator('#device-consumed').textContent());
 const reported=await page.locator('#server-consumed').textContent();
 await next(page);
 assert(await page.locator('#next').isHidden());
 assert.match(await page.locator('#tour-text').textContent(),/Press \+ beside/);
 while(consumed+25n<=BigInt(issued)){
  await page.locator('#consume-credit').click();await ready(page);consumed+=25n;
  assert.equal(await page.locator('#device-consumed').textContent(),consumed.toString());
  assert(await page.locator('#next').isHidden());
 }
 await page.locator('#consume-credit').click();await ready(page);
 assert.match(await page.locator('#tour-text').textContent(),/^conflict \(-7\)/);
 assert.equal(await page.locator('#device-consumed').textContent(),consumed.toString());
 assert.equal(await page.locator('#server-consumed').textContent(),reported);
 assert.equal(await pending(page).count(),0);
 assert(await page.locator('#consume-credit').isDisabled());
 await next(page);
 for(const expected of ['argument','conflict']){
  await next(page);assert((await page.locator('#tour-text').textContent()).startsWith(expected+' (-'));await next(page);
 }
 assert.match(await page.locator('#tour-title').textContent(),/corrupted packet/);
 await corrupt(pending(page));await dragPacket(page,pending(page),'#device-panel',touch);
 assert.match(await page.locator('#tour-text').textContent(),/authentication/);
 await next(page);await dragPacket(page,pending(page),'#server-panel',touch);
 assert.match(await page.locator('#tour-text').textContent(),/protocol/);
 assert.match(await page.locator('#tour-title').textContent(),/Error tour complete/);
 assert.equal(await page.locator('#device-consumed').textContent(),consumed.toString());
 assert.equal(await page.locator('#device-issued').textContent(),issued);
 assert.equal(await page.locator('#server-issued').textContent(),issued);
}

try{
for(const [name,type]of [['chromium',chromium],['firefox',firefox]]){
 const browser=await type.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1366,height:768},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await ready(page);
  for(const chapter of ['trust']){
   assert(await page.locator('#message-log').isVisible());assert.equal(await page.locator('#drop-target').count(),0);assert.equal(await page.locator('.inbox,#deliver,.show-tip').count(),0);
   await page.locator('#hide-tip').click();await page.locator('#chapter-'+chapter).click();assert(await page.locator('#guide-popup').isVisible());
   await generate(page);
   const state=await page.locator('#device-details').textContent();
   const original=await pending(page).locator('pre').textContent();
   await corrupt(pending(page));await corrupt(pending(page));assert.equal(await pending(page).locator('pre').textContent(),original);
   await corrupt(pending(page));await dragPacket(page,pending(page),'#device-panel');
   assert.match(await page.locator('#device-result').textContent(),/authentication \(-3\).*authentication failed/);
   assert.equal(await page.locator('#device-details').textContent(),state);
   assert.equal(await page.locator('#device-public-key').textContent(),'Not generated yet');
   assert(await page.locator('#restart-enrollment').isVisible());
   // Turn corruption off on the rejected attempt; exact original bytes are restored.
   await corrupt(saved(page));await dragPacket(page,saved(page),'#device-panel');
   assert.match(await page.locator('#device-result').textContent(),/ok \(0\)/i);assert(!(await page.locator('#next').isDisabled()));
   await next(page);assert.match(await page.locator('#device-public-key').textContent(),/^[a-f0-9]{64}$/);await dragPacket(page,pending(page),'#server-panel');
   assert.match(await page.locator('#server-summary').textContent(),/Awaiting approval/);assert.equal(await page.locator('#server-consumed').textContent(),'Not reported');
   // Replay is legitimate and idempotent here: expose success, not a fabricated error.
   await dragPacket(page,saved(page),'#server-panel');assert.match(await page.locator('#server-result').textContent(),/ok \(0\).*no newer state/i);
   assert.equal(await page.locator('#server-consumed').textContent(),'Not reported');
   await next(page);assert.equal(await page.locator('#server-consumed').textContent(),'Not reported');
   await next(page);
   await dragPacket(page,pending(page),'#device-panel');assert.equal(await page.locator('#device-status').textContent(),'Confirmed');
   assert.match(await page.locator('#tour-title').textContent(),/Enrollment complete/);
   assert.equal(await page.locator('#chapter-attack').count(),0);
   assert.match(await page.locator('#tour-text').textContent(),/Continue to credits.*retry enrollment.*corrupt.*server time/);
   const enrolledState=await page.locator('#server-details').textContent();
   await page.locator('#advance-time').click();await ready(page);
   assert.equal(await page.locator('#server-details').textContent(),enrolledState);
   assert.match(await page.locator('#clock-result').textContent(),/Completed enrollment stays valid/);
   await corrupt(saved(page));await dragPacket(page,saved(page),'#device-panel');
   assert.match(await page.locator('#device-result').textContent(),/authentication/);
   await corrupt(saved(page));
   assert.equal(await page.locator('#next').textContent(),'On to credits →');
   await dragPacket(page,saved(page),'#device-panel');assert.match(await page.locator('#device-result').textContent(),/ok \(0\).*no newer state/i);
   // Reflect the saved server confirmation back to the server and surface its actual error.
   await dragPacket(page,saved(page),'#server-panel');assert.match(await page.locator('#server-result').textContent(),/\(-\d+\).*Rejected/);
   await creditFlow(page);await errorFlow(page);
   await page.screenshot({path:`/tmp/simple-crypts-${name}-${chapter}-log.png`,fullPage:true});console.log('PASS',name,chapter,'log workflow');
  }
  // Credits is independently accessible, with actual enrollment completed as setup.
  await page.locator('#chapter-trust').click();await ready(page);
  await page.locator('#chapter-credits').click();await ready(page);
  await creditFlow(page);await errorFlow(page);
  await next(page);assert.equal(await page.locator('#device-issued').textContent(),'0');
  assert.equal(await page.locator('#message-log .packet').count(),0);
  await page.locator('#chapter-trust').click();await ready(page);
  // Advancing simulated server time alone does not call receive. A later response fails expiry.
  await page.locator('#reset').click();await ready(page);await generate(page);await dragPacket(page,pending(page),'#device-panel');await next(page);
  const identity=await page.locator('#device-public-key').textContent();const beforeClock=await page.locator('#server-details').textContent();
  await page.locator('#advance-time').click();await ready(page);assert.equal(await page.locator('#server-details').textContent(),beforeClock);
  await dragPacket(page,pending(page),'#server-panel');assert.match(await page.locator('#server-result').textContent(),/enrollment \(-10\)/);
  assert.equal(await page.locator('#server-consumed').textContent(),'Not reported');
  for(let i=0;i<18;i++)await dragPacket(page,saved(page),'#server-panel');assert.equal(await page.locator('#message-log .packet').count(),16);
  assert.match(await page.locator('#tour-text').textContent(),/expired/);
  await page.locator('#restart-enrollment').click();await ready(page);
  assert.equal(await page.locator('#device-public-key').textContent(),identity);
  assert.equal(await page.locator('#message-log .packet').count(),0);
  await next(page);await dragPacket(page,pending(page),'#device-panel');await next(page);await dragPacket(page,pending(page),'#server-panel');await next(page);await next(page);await dragPacket(page,pending(page),'#device-panel');
  assert.equal(await page.locator('#device-status').textContent(),'Confirmed');
  assert.equal(await page.locator('#restart-enrollment').textContent(),'Retry enrollment ↺');
  await page.locator('#restart-enrollment').click();await ready(page);
  assert.equal(await page.locator('#device-public-key').textContent(),'Not generated yet');
  assert.equal(await page.locator('#message-log .packet').count(),0);
  assert.equal(await page.locator('body').getAttribute('data-chapter'),'trust');
  await generate(page);
  assert.equal((await page.request.get(base+'report/')).status(),200);assert.deepEqual(errors,[]);
  await context.close();
  if(name==='chromium'){
   const touch=await browser.newContext({viewport:{width:390,height:844},hasTouch:true}),t=await touch.newPage();await t.goto(base);await ready(t);await generate(t);
   await corrupt(pending(t));await dragPacket(t,pending(t),'#device-panel',true);assert.match(await t.locator('#device-result').textContent(),/\(-3\)/);
   await corrupt(saved(t));await dragPacket(t,saved(t),'#device-panel',true);await next(t);await dragPacket(t,pending(t),'#server-panel',true);await next(t);await next(t);await dragPacket(t,pending(t),'#device-panel',true);
   assert.equal(await t.locator('#device-status').textContent(),'Confirmed');assert(await t.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const nextBox=await t.locator('#next').boundingBox(),retryBox=await t.locator('#restart-enrollment').boundingBox();
   assert(Math.abs(nextBox.y-retryBox.y)<4,'Completion actions should be side by side on touchscreens');
   await t.screenshot({path:'/tmp/simple-crypts-enrollment-complete.png',fullPage:true});
   await creditFlow(t,true);await errorFlow(t,true);
   await t.screenshot({path:'/tmp/simple-crypts-touch-log.png',fullPage:true});await touch.close();
  }
  const unavailable=await browser.newContext();await unavailable.addInitScript(()=>Object.defineProperty(globalThis,'crypto',{value:undefined}));const p=await unavailable.newPage();await p.goto(base);await p.locator('#error').waitFor({state:'visible'});assert.match(await p.locator('#error').textContent(),/randomness/);await unavailable.close();
  console.log(`PASS ${name}: common log, reversible corruption, direct replay, real result codes, challenge before keygen, rejection recovery, expiry, bounded history`);
 }finally{await browser.close();}
}
}finally{server.close();}
