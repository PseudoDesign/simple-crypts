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
async function provision(page){
 assert.equal(await page.locator('.packet').count(),0);
 assert.equal(await page.locator('#device-public-key').textContent(),'Not generated yet');
 assert(await page.locator('#device-unique-id').isVisible());assert.equal(await page.locator('#device-unique-id').textContent(),'mcu-0001');
 for(const role of ['device','server'])assert(await page.locator('#'+role+'-panel').isVisible());
 assert.match(await page.locator('#server-public-key').textContent(),/^[a-f0-9]{64}$/);
 assert.equal(await page.locator('#device-private-key').textContent(),'Not generated yet');
 assert.match(await page.locator('#server-private-key').textContent(),/Kept on server/);
 await page.locator('#next').click();await ready(page);
 const key=await page.locator('#device-public-key').textContent();assert.match(key,/^[a-f0-9]{64}$/);assert.match(await page.locator('#device-private-key').textContent(),/Kept on device/);
 assert.equal(await page.locator('.packet').count(),0);assert.equal(await page.locator('#device-details').textContent(),'');
 await page.screenshot({path:'/tmp/simple-crypts-key-generation.png',fullPage:true});
 await page.locator('#next').click();await ready(page);
 assert.match(await page.locator('#device-details').textContent(),new RegExp(key));
 const pinned=await page.locator('#pinned-server-key').textContent();assert.match(pinned,/^[a-f0-9]{64}$/);assert.match(await page.locator('#server-details').textContent(),new RegExp(pinned));
 assert.equal(await page.locator('.packet').count(),0);assert.equal(await page.locator('#server-status').textContent(),'Not enrolled');
 return key;
}
async function update(page,form,input,value){await page.locator(input).fill(value);await page.locator(form+' button').click();await ready(page);}
async function toolsOpen(page){if(!await page.locator('#experiment-tools').evaluate(e=>e.open))await page.locator('#experiment-tools>summary').click();}
async function toolsClose(page){if(await page.locator('#experiment-tools').evaluate(e=>e.open))await page.locator('#experiment-tools>summary').click();}
async function send(page,role){await toolsClose(page);await page.locator(`[data-transmit="${role}"]`).click();await ready(page);}
async function action(page,action,index=0){
 if(action==='deliver'||action==='drop'){const card=page.locator('.packet').nth(index);await card.locator('[data-select]').click();if(action==='drop')await toolsOpen(page);await page.locator(`[data-destination="${action==='drop'?'discard':(await card.locator('[data-select]').textContent()).includes('Device →')?'server':'device'}"]`).click();}
 else await page.locator(`[data-action="${action}"]`).nth(index).click();
 await ready(page);await toolsClose(page);
}
async function drag(page,target){await page.locator('.tour-message [data-select]').dragTo(page.locator(`[data-destination="${target}"]`));await ready(page);}

try{
for(const [name,browserType]of [['chromium',chromium],['firefox',firefox]]){
 const browser=await browserType.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'});const page=await context.newPage();const errors=[],outside=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(base))outside.push(r.url());});
  // Model a returning browser with the old unversioned stylesheet cached.
  // The old pre-enrollment rule must never be requested by this release.
  let staleStyleRequests=0;
  await page.route('**/style.css',route=>{staleStyleRequests++;return route.fulfill({contentType:'text/css',body:'body[data-phase="intro"] .lanes{display:none!important}'});});
  await page.goto(base);await ready(page);
  assert.equal(staleStyleRequests,0);
  assert.equal(await page.locator('#guide-popup').getAttribute('data-role'),'device');
  assert.equal(await page.locator('.lanes>article:visible').count(),2);
  assert(await page.locator('.top').isHidden());assert(await page.locator('#guide-popup').isVisible());
  await page.locator('#hide-tip').click();assert(await page.locator('#guide-popup').isHidden());
  await page.locator('#device-panel .show-tip').click();assert(await page.locator('#guide-popup').isVisible());
  for(const role of ['device','server'])assert(await page.locator('#'+role+'-panel').isVisible());
  await page.screenshot({path:`/tmp/simple-crypts-${name}-pre-enrollment.png`,fullPage:true});
  for(const role of ['device','server']){assert(await page.locator('#'+role+'-temperature').isVisible());assert(await page.locator('#'+role+'-name').isVisible());assert.equal(await page.locator('#'+role+'-temperature').textContent(),'—');}
  await provision(page);
  assert.equal(await page.locator('.packet').count(),0);
  const firstIdentity=await page.locator('#device-details').textContent();
  const destinations=['device','server','device'];
  for(let step=0;step<destinations.length;step++){
   if(step===2){assert.equal(await page.locator('#server-status').textContent(),'Not enrolled');await page.locator('#next').click();await ready(page);assert.match(await page.locator('#tour-progress').textContent(),/STEP 5 OF 6/);}
   await page.locator('#next').click();await ready(page);
   assert.equal(await page.locator('#error').isVisible(),false,await page.locator('#error').textContent());
   assert.match(await page.locator('#tour-progress').textContent(),new RegExp(`STEP ${step===2?6:step+3} OF 6`));
   assert(await page.locator('#next').isDisabled());
   assert(await page.locator('#next').isHidden());
   assert.equal(await page.locator('[data-destination]:visible').count(),1);
   for(const selector of ['.hero','.result-panel','.archive-panel','.below','.notes','.endpoint form','.packet-actions','.packet details','#budget'])assert(await page.locator(selector).first().isHidden(),selector+' should be hidden in the guide');
   assert((await page.locator('#tour-text').textContent()).split(/\s+/).length<=14);

   assert.equal(await page.locator('.tour-message').count(),1);
   const speaker=step===1?'device':'server';
   assert.equal(await page.locator('#guide-popup').getAttribute('data-role'),speaker);
   const popupBox=await page.locator('#guide-popup').boundingBox(),roleBox=await page.locator('#'+speaker+'-panel').boundingBox();
   assert(Math.abs(popupBox.x+popupBox.width/2-roleBox.x-roleBox.width/2)<2);

   if(step===0){assert(await page.locator('.tour-message .packet-summary').isVisible());assert.match(await page.locator('.tour-message .packet-summary').textContent(),/Serial: mcu-0001Challenge: [0-9a-f]{8}…Expires: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTCSignature: Ed25519Visibility: Public/);}
   if(step>0){
    const summary=page.locator('.tour-message .packet-summary');assert(await summary.isVisible());
    assert.match(await summary.textContent(),step===1?/Sender’s view · before encryptionSerial: mcu-0001Challenge: [0-9a-f]{8}…Temperature: -18125 m°CReport revision: 1/:/Confirmed: trueReport acknowledged: 1/);
    assert.match(await page.locator('.tour-message .packet-ciphertext').textContent(),/Ciphertext \+ tag: \d+ bytes\n[0-9a-f]{24}…/);
    await page.screenshot({path:`/tmp/simple-crypts-${name}-packet-${step}.png`,fullPage:true});
   }
   for(const role of ['device','server']){assert(await page.locator('#'+role+'-public-key').isVisible());assert(await page.locator('#'+role+'-private-key').isVisible());}

   await page.locator('#packet-inspector>summary').click();
   assert(await page.locator('#enrollment-packet').isVisible());
   assert.match(await page.locator('#packet-fields').textContent(),step===0?/SignatureEd25519/:step===1?/First report-18125.*Report revision1/:/Enrollment confirmedtrue.*Acknowledged report revision1/);
   assert.match(await page.locator('#packet-wire').textContent(),/Sender public key: [a-f0-9]{64}/);
   await page.locator('#packet-inspector>summary').click();
   assert.equal(await page.locator('#archive .archive-card').count(),step);
   if(step===0)await page.screenshot({path:`/tmp/simple-crypts-${name}-messages.png`,fullPage:true});
   for(const role of ['device','server']){assert(await page.locator('#'+role+'-temperature').isVisible());assert.equal(await page.locator('#'+role+'-name').textContent(),'Not assigned');}
   assert.equal(await page.locator('#device-temperature').textContent(),step===0?'—':'-18.125 °C');
   assert.equal(await page.locator('#server-temperature').textContent(),step<2?'—':'-18.125 °C');
   await drag(page,destinations[step]);assert.equal(await page.locator('#guide-popup').getAttribute('data-role'),destinations[step]);assert(!(await page.locator('#next').isDisabled()));
   if(step===1){assert.equal(await page.locator('#server-temperature').textContent(),'—');assert.equal(await page.locator('#server-temperature-state').textContent(),'Report received · awaiting approval');assert.match(await page.locator('#server-summary').textContent(),/Awaiting approval/);assert.equal(await page.locator('#registered-device-key').textContent(),await page.locator('#device-public-key').textContent());}
  }
  assert.equal(await page.locator('#device-temperature-state').textContent(),'Receipt confirmed');
  assert.equal(await page.locator('#server-temperature-state').textContent(),'Accepted report');
  assert.equal(await page.locator('#device-status').textContent(),'Confirmed');assert.equal(await page.locator('#server-status').textContent(),'Confirmed');
  assert.equal(await page.locator('.packet').count(),0);assert.equal(await page.locator('#server-temperature').textContent(),'-18.125 °C');
  await page.screenshot({path:`/tmp/simple-crypts-${name}-tour.png`,fullPage:true});
  await page.locator('#sandbox').click();
  await update(page,'#temperature-form','#temperature','12.345');await send(page,'device');
  await action(page,'duplicate');await action(page,'corrupt');await action(page,'deliver');
  assert.equal(await page.locator('#server-temperature').textContent(),'-18.125 °C');assert.match(await page.locator('#events').textContent(),/rejected/);
  await action(page,'deliver');assert.equal(await page.locator('#server-temperature').textContent(),'12.345 °C');
  await update(page,'#temperature-form','#temperature','13');await send(page,'device');await update(page,'#temperature-form','#temperature','14');await send(page,'device');
  await action(page,'deliver',1);await action(page,'deliver',0);assert.equal(await page.locator('#server-temperature').textContent(),'14.000 °C');
  await update(page,'#name-form','#name','é'.repeat(33));assert.match(await page.locator('#error').textContent(),/64 UTF-8/);
  await update(page,'#name-form','#name','<img src=x onerror=alert(1)>');await send(page,'server');await action(page,'deliver');assert.equal(await page.locator('#device-name img').count(),0);assert.match(await page.locator('#device-name').textContent(),/<img/);
  await toolsOpen(page);await page.locator('#budget').fill('1');await send(page,'device');assert.match(await page.locator('#error').textContent(),/bounds/);await toolsOpen(page);await page.locator('#budget').fill('512');
  await send(page,'device');
  // Fill queue through real UI duplication; no endpoints run on their own.
  for(let i=1;i<64;i++)await action(page,'duplicate',0);
  assert.equal(await page.locator('.packet').count(),64);assert(await page.locator('[data-transmit="device"]').isDisabled());assert(await page.locator('[data-action="duplicate"]').first().isDisabled());
  await action(page,'drop');assert.equal(await page.locator('.packet').count(),63);assert(!(await page.locator('[data-transmit="device"]').isDisabled()));
  await page.locator('#reset').click();await ready(page);await provision(page);assert.equal(await page.locator('.packet').count(),0);assert.notEqual(await page.locator('#device-details').textContent(),firstIdentity);
  const resetIdentity=await page.locator('#device-details').textContent();await page.reload();await ready(page);await provision(page);assert.notEqual(await page.locator('#device-details').textContent(),resetIdentity);
  // Browser remains idle across rendering turns: initialization sends no frames.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.locator('.packet').count(),0);
  await page.setViewportSize({width:390,height:844});await page.keyboard.press('Tab');assert(await page.evaluate(()=>document.activeElement!==document.body));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`/tmp/simple-crypts-${name}-mobile.png`,fullPage:true});
  assert.equal((await page.request.get(base+'report/')).status(),200);assert.equal((await page.request.get(base+'resources/cortex-m4.md')).status(),200);
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  await context.close();
  // Hold a report command, reset, then release the stale command to a terminated worker.
  const resetContext=await browser.newContext();await resetContext.addInitScript(()=>{const Original=Worker;window.__held=[];window.Worker=class extends Original{postMessage(message,...rest){if(message.command==='report')window.__held.push(()=>super.postMessage(message,...rest));else super.postMessage(message,...rest);}};});
  const p=await resetContext.newPage();await p.goto(base);await ready(p);await provision(p);await p.locator('#next').click();await ready(p);await p.locator('#deliver').click();await ready(p);await p.locator('#next').click();await p.waitForFunction(()=>window.__held.length===1);await p.locator('#reset').click();await ready(p);await p.evaluate(()=>window.__held.splice(0).forEach(fn=>fn()));assert.equal(await p.locator('.packet').count(),0);assert.equal(await p.locator('#device-temperature').textContent(),'—');assert.match(await p.locator('#tour-progress').textContent(),/STEP 1 OF 6/);await resetContext.close();
  const experiment=await browser.newContext();const x=await experiment.newPage();await x.goto(base);await ready(x);await provision(x);await x.locator('#next').click();await ready(x);
  // The focused guide has only its intended destination. A wrong drop leaves the packet untouched.
  await x.locator('.tour-message [data-select]').dragTo(x.locator('#server-panel h2'));await ready(x);assert.equal(await x.locator('.packet').count(),1);assert.equal(await x.locator('#archive .archive-card').count(),0);
  await x.locator('.tour-message [data-select]').focus();await x.keyboard.press('Enter');await x.locator('[data-destination="device"]').focus();await x.keyboard.press('Enter');await ready(x);assert(!(await x.locator('#next').isDisabled()));
  await x.locator('#next').click();await ready(x);await drag(x,'server');await x.locator('#next').click();await ready(x);await x.locator('#next').click();await ready(x);await drag(x,'device');
  await x.locator('#sandbox').click();await update(x,'#name-form','#name','Freezer 3');await send(x,'server');
  await x.locator('.packet [data-select]').click();await x.locator('[data-destination="server"]').click();await ready(x);assert.match(await x.locator('#result-title').textContent(),/rejected/);
  await toolsOpen(x);await x.locator('#archive [data-replay]').first().click();await ready(x);await toolsClose(x);await x.locator('.packet [data-action="corrupt"]').click();await ready(x);await toolsClose(x);await action(x,'deliver');assert.match(await x.locator('#result-title').textContent(),/rejected/);
  await toolsOpen(x);await x.locator('#archive [data-replay]').nth(1).click();await ready(x);await toolsClose(x);await action(x,'deliver');assert.equal(await x.locator('#device-name').textContent(),'Freezer 3');assert.equal(await x.locator('#device-unique-id').textContent(),'mcu-0001');
  await toolsOpen(x);await x.locator('#archive [data-replay]').first().click();await ready(x);await toolsClose(x);await action(x,'deliver');assert.match(await x.locator('#result-title').textContent(),/no newer state/);
  await x.setViewportSize({width:390,height:844});await toolsOpen(x);await x.locator('#archive [data-replay]').first().click();await ready(x);await toolsClose(x);await x.locator('.packet [data-select]').click();await x.locator('[data-destination="server"]').click();await ready(x);assert.match(await x.locator('#result-title').textContent(),/rejected/);assert(await x.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await experiment.close();
  if(name==='chromium'){
   const touchContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});const t=await touchContext.newPage();await t.goto(base);await ready(t);await provision(t);await t.locator('#next').click();await ready(t);
   const cdp=await touchContext.newCDPSession(t);
   const center=box=>({x:box.x+box.width/2,y:box.y+box.height/2});
   async function touchMove(target,end='touchEnd'){
    const handle=t.locator('.tour-message [data-select]');
    const from=await handle.boundingBox(),to=await t.locator(target).boundingBox();
    assert(from.y>=0&&from.y+from.height<=844&&to.y>=0&&to.y+to.height<=844);
    const a=center(from),b=center(to),scroll=await t.evaluate(()=>scrollY);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a]});
    for(let i=1;i<=12;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:a.x+(b.x-a.x)*i/12,y:a.y+(b.y-a.y)*i/12}]});
    assert(await t.locator('.touch-packet').isVisible(),'The packet must follow the finger');
    assert.equal(await t.evaluate(()=>scrollY),scroll,'Dragging a packet must not scroll the page');
    if(end==='touchEnd'&&target!=='#tour-title')assert.equal(await t.locator('.drag-over').count(),1);
    await t.screenshot({path:'/tmp/simple-crypts-touch-drag.png'});
    await cdp.send('Input.dispatchTouchEvent',{type:end,touchPoints:[]});await ready(t);
    assert.equal(await t.locator('.touch-packet,.touch-source,.drag-over').count(),0,'Gesture cleanup');
   }
   // Invalid drops and OS-cancelled gestures must retain the packet and allow retry.
   await touchMove('#tour-title');assert(await t.locator('#next').isDisabled());
   await touchMove('#device-panel h2','touchCancel');assert(await t.locator('#next').isDisabled());
   assert.equal(await t.locator('.packet').count(),1);assert.equal(await t.locator('#archive .archive-card').count(),0);
   // Both enrollment steps: deliberately drop on entity headers, outside the inbox buttons.
   for(const [index,target]of ['#device-panel h2','#server-panel h2','#device-panel h2'].entries()){
    if(index===2){await t.locator('#next').tap();await ready(t);}
    if(index){await t.locator('#next').tap();await ready(t);}
    await touchMove(target);assert(!(await t.locator('#next').isDisabled()));
    assert.equal(await t.locator('#archive .archive-card').count(),index+1);
   }
   // Tap/select remains a no-drag alternative and does not accidentally deliver on selection.
   await t.locator('#reset').tap();await ready(t);await provision(t);await t.locator('#next').tap();await ready(t);
   await t.locator('.tour-message [data-select]').tap();assert.equal(await t.locator('.selected').count(),1);
   assert(await t.locator('#next').isDisabled());await t.locator('[data-destination="device"]').tap();await ready(t);assert(!(await t.locator('#next').isDisabled()));
   await touchContext.close();
  }
  const noRng=await browser.newContext();await noRng.addInitScript(()=>Object.defineProperty(globalThis,'crypto',{value:undefined}));const r=await noRng.newPage();await r.goto(base);await r.locator('#error').waitFor({state:'visible'});assert.match(await r.locator('#error').textContent(),/randomness/);assert(await r.locator('#next').isDisabled());await noRng.close();
  console.log(`PASS ${name}: user-delivered tour, drag/drop, reflection/replay, focused instructions, bounds, reset, UTF-8, keyboard/mobile, no external requests, RNG failure`);
 }finally{await browser.close();}
}
}finally{await new Promise(r=>server.close(r));}
