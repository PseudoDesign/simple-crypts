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
async function generateIdentity(page){
 assert.equal(await page.locator('.packet').count(),0);
 assert.equal(await page.locator('#device-public-key').textContent(),'Not generated yet');
 assert(await page.locator('#device-unique-id').isVisible());assert.equal(await page.locator('#device-unique-id').textContent(),'mcu-0001');
 for(const role of ['device','server'])assert(await page.locator('#'+role+'-panel').isVisible());
 assert.match(await page.locator('#server-public-key').textContent(),/^[a-f0-9]{64}$/);
 assert.equal(await page.locator('#device-private-key').textContent(),'Not generated yet');
 assert(await page.locator('#pinned-server-key').isVisible());assert.equal(await page.locator('#pinned-server-key').textContent(),await page.locator('#server-public-key').textContent());
 assert.match(await page.locator('#server-private-key').textContent(),/Kept on server/);
 await page.locator('#next').click();await ready(page);
 const key=await page.locator('#device-public-key').textContent();assert.match(key,/^[a-f0-9]{64}$/);assert.match(await page.locator('#device-private-key').textContent(),/Kept on device/);
 assert.equal(await page.locator('.packet').count(),0);assert.match(await page.locator('#next').textContent(),/Authorize session/);assert.equal(await page.getByRole('button',{name:/provision/i}).count(),0);
 await page.screenshot({path:'/tmp/simple-crypts-key-generation.png',fullPage:true});
 assert.match(await page.locator('#device-details').textContent(),new RegExp(key));
 const pinned=await page.locator('#pinned-server-key').textContent();assert.match(pinned,/^[a-f0-9]{64}$/);assert.match(await page.locator('#server-details').textContent(),new RegExp(pinned));
 assert.equal(await page.locator('.packet').count(),0);assert.equal(await page.locator('#server-status').textContent(),'Not enrolled');
 return key;
}
async function update(page,form,input,value){await page.locator(input).fill(value);await page.locator(form+' button').click();await ready(page);}
async function toolsOpen(page){if(!await page.locator('#experiment-tools').evaluate(e=>e.open))await page.locator('#experiment-tools>summary').click();}
async function toolsClose(page){if(await page.locator('#experiment-tools').evaluate(e=>e.open))await page.locator('#experiment-tools>summary').click();}
async function send(page,role){await toolsClose(page);await page.locator(`[data-transmit="${role}"]`).click();await ready(page);}
// Target the visible part of a recipient taller than the viewport. Firefox cancels
// native drags if automation scrolls to an off-screen panel center mid-gesture.
async function dragRecipient(source,target){
 if(!await target.evaluate(e=>e.classList.contains('endpoint')))return source.dragTo(target);
 await source.scrollIntoViewIfNeeded();
 const from=await source.boundingBox(),to=await target.boundingBox(),page=source.page();
 const x=from.x+from.width/2,y=from.y+from.height/2;
 const destination={x:to.x+to.width/2,y:Math.max(to.y+8,Math.min(to.y+to.height-8,y))};
 await page.mouse.move(x,y);await page.mouse.down();
 await page.mouse.move(x+12,y,{steps:4});
 await page.mouse.move(destination.x,destination.y,{steps:12});
 await page.mouse.move(destination.x+1,destination.y);await page.mouse.up();
}
async function action(page,action,index=0){
 const card=page.locator('.packet').nth(index);
 if(action==='deliver'){
  const count=await page.locator('.packet').count(),target=(await card.getAttribute('data-from'))==='device'?'server':'device';
  await dragRecipient(card.locator('[data-select]'),page.locator(`[data-destination="${target}"]`));
  await page.waitForFunction(n=>document.querySelectorAll('.packet').length===n,count-1);
 }else await card.locator(`[data-action="${action}"]`).click();
 await ready(page);
}
async function drag(page,target){await page.locator('.tour-message [data-select]').dragTo(page.locator(`[data-destination="${target}"]`));await ready(page);}

try{
for(const [name,browserType]of [['chromium',chromium],['firefox',firefox]]){
 const browser=await browserType.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1366,height:768},reducedMotion:'reduce'});const page=await context.newPage();const errors=[],outside=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(base))outside.push(r.url());});
  // Model a returning browser with the old unversioned stylesheet cached.
  // The old pre-enrollment rule must never be requested by this release.
  let staleStyleRequests=0;
  await page.route('**/style.css',route=>{staleStyleRequests++;return route.fulfill({contentType:'text/css',body:'body[data-phase="intro"] .lanes{display:none!important}'});});
  await page.goto(base);await ready(page);
  assert.equal(staleStyleRequests,0);assert.equal(await page.locator('#chapter-trust').getAttribute('aria-current'),'step');assert.equal(await page.locator('#chapter-attack').getAttribute('aria-disabled'),null);assert.equal(await page.locator('#deliver').count(),0);assert.equal(await page.locator('.inbox').count(),0);
  assert.equal(await page.locator('#guide-popup').getAttribute('data-role'),'device');
  assert.equal(await page.locator('.lanes>article:visible').count(),2);
  assert(await page.locator('.top').isHidden());assert(await page.locator('#guide-popup').isVisible());
  await page.locator('#hide-tip').click();assert(await page.locator('#guide-popup').isHidden());
  await page.locator('#chapter-trust').click();assert(await page.locator('#guide-popup').isVisible());
  for(const role of ['device','server'])assert(await page.locator('#'+role+'-panel').isVisible());
  await page.screenshot({path:`/tmp/simple-crypts-${name}-pre-enrollment.png`,fullPage:true});
  for(const role of ['device','server']){assert(await page.locator('#'+role+'-temperature').isVisible());assert(await page.locator('#'+role+'-name').isVisible());assert.equal(await page.locator('#'+role+'-temperature').textContent(),'—');}
  await generateIdentity(page);
  assert.equal(await page.locator('.packet').count(),0);
  const firstIdentity=await page.locator('#device-details').textContent();
  const destinations=['device','server','device'];
  for(let step=0;step<destinations.length;step++){
   if(step===2){assert.equal(await page.locator('#server-status').textContent(),'Not enrolled');await page.locator('#next').click();await ready(page);assert.match(await page.locator('#tour-progress').textContent(),/STEP 4 OF 5/);}
   await page.locator('#next').click();await ready(page);
   assert.equal(await page.locator('#error').isVisible(),false,await page.locator('#error').textContent());
   assert.match(await page.locator('#tour-progress').textContent(),new RegExp(`STEP ${step===2?5:step+2} OF 5`));
   assert(await page.locator('#next').isDisabled());
   assert(await page.locator('#next').isHidden());
   assert.equal(await page.locator('[data-destination][data-drop-enabled="true"]:visible').count(),1);
   for(const selector of ['.hero','.result-panel','.archive-panel','.below','.notes','.endpoint form','.packet-actions','.packet details','#budget'])assert(await page.locator(selector).first().isHidden(),selector+' should be hidden in the guide');
   assert((await page.locator('#tour-text').textContent()).split(/\s+/).length<=14);

   assert.equal(await page.locator('.tour-message').count(),1);
   for(const role of ['device','server']){const box=await page.locator('#'+role+'-panel').boundingBox();assert(box.y+box.height<=768,role+' panel should fit on a laptop screen');}
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
  const enrolledKey=await page.locator('#device-public-key').textContent();
  await page.locator('#chapter-attack').click();await ready(page);
  assert.equal(await page.locator('#chapter-attack').getAttribute('aria-current'),'step');
  assert.equal(await page.locator('#device-public-key').textContent(),'Not generated yet');
  assert(await page.locator('#name-form').isHidden());assert(await page.locator('#temperature-form').isHidden());
  await generateIdentity(page);assert.notEqual(await page.locator('#device-public-key').textContent(),enrolledKey);
  await page.locator('#next').click();await ready(page);
  // Drop a challenge: nothing changes until a retained copy is replayed.
  await action(page,'drop');assert.equal(await page.locator('.packet').count(),0);assert(await page.locator('#next').isDisabled());
  assert.equal(await page.locator('#server-temperature').textContent(),'—');
  await page.locator('#retry').click();await ready(page);
  // Alter one duplicate, reject it, then deliver the unchanged original.
  await action(page,'duplicate');await action(page,'corrupt',1);await action(page,'deliver',1);
  assert.match(await page.locator('#device-result').textContent(),/Rejected/);assert(await page.locator('#next').isDisabled());
  await action(page,'deliver');assert(!(await page.locator('#next').isDisabled()));
  await page.locator('#next').click();await ready(page);
  // A response reflected to its sender is rejected, not mistaken for confirmation.
  await action(page,'duplicate');
  await page.locator('.packet').last().locator('[data-select]').dragTo(page.locator('#device-panel h2'));await ready(page);
  assert.match(await page.locator('#device-result').textContent(),/Rejected/);
  await action(page,'duplicate');await action(page,'deliver',1);
  assert.match(await page.locator('#server-summary').textContent(),/Awaiting approval/);
  assert.equal(await page.locator('#server-temperature').textContent(),'—');
  await action(page,'deliver');assert.match(await page.locator('#server-result').textContent(),/no newer state/);
  assert.equal(await page.locator('#server-temperature').textContent(),'—');
  // Only the trusted approval accepts the staged temperature and key.
  await page.locator('#next').click();await ready(page);assert.equal(await page.locator('#server-temperature').textContent(),'-18.125 °C');
  await page.locator('#next').click();await ready(page);await action(page,'drop');
  assert.equal(await page.locator('#device-temperature-state').textContent(),'Awaiting server receipt');
  await toolsOpen(page);await page.locator('#archive [data-replay]').first().click();await ready(page);
  await action(page,'deliver');assert.equal(await page.locator('#device-status').textContent(),'Confirmed');
  await toolsOpen(page);await page.locator('#archive [data-replay]').first().click();await ready(page);
  await action(page,'deliver');assert.match(await page.locator('#device-result').textContent(),/no newer state/);
  await page.screenshot({path:`/tmp/simple-crypts-${name}-attack-enrollment.png`,fullPage:true});
  // Copies remain bounded even when the intermediary withholds every packet.
  await toolsOpen(page);await page.locator('#archive [data-replay]').first().click();await ready(page);
  for(let i=1;i<64;i++)await action(page,'duplicate',0);
  assert.equal(await page.locator('.packet').count(),64);assert(await page.locator('[data-action="duplicate"]').first().isDisabled());
  await action(page,'drop');assert.equal(await page.locator('.packet').count(),63);
  await page.locator('#chapter-trust').click();await ready(page);assert.equal(await page.locator('#chapter-trust').getAttribute('aria-current'),'step');
  await page.locator('#reset').click();await ready(page);await generateIdentity(page);assert.equal(await page.locator('.packet').count(),0);assert.notEqual(await page.locator('#device-details').textContent(),firstIdentity);
  const resetIdentity=await page.locator('#device-details').textContent();await page.reload();await ready(page);await generateIdentity(page);assert.notEqual(await page.locator('#device-details').textContent(),resetIdentity);
  // Browser remains idle across rendering turns: initialization sends no frames.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await page.locator('.packet').count(),0);
  await page.setViewportSize({width:390,height:844});await page.keyboard.press('Tab');assert(await page.evaluate(()=>document.activeElement!==document.body));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`/tmp/simple-crypts-${name}-mobile.png`,fullPage:true});
  assert.equal((await page.request.get(base+'report/')).status(),200);assert.equal((await page.request.get(base+'resources/cortex-m4.md')).status(),200);
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  await context.close();
  // Hold a report command, reset, then release the stale command to a terminated worker.
  const resetContext=await browser.newContext();await resetContext.addInitScript(()=>{const Original=Worker;window.__held=[];window.Worker=class extends Original{postMessage(message,...rest){if(message.command==='report')window.__held.push(()=>super.postMessage(message,...rest));else super.postMessage(message,...rest);}};});
  const p=await resetContext.newPage();await p.goto(base);await ready(p);await generateIdentity(p);await p.locator('#next').click();await ready(p);await drag(p,'device');await p.locator('#next').click();await p.waitForFunction(()=>window.__held.length===1);await p.locator('#reset').click();await ready(p);await p.evaluate(()=>window.__held.splice(0).forEach(fn=>fn()));assert.equal(await p.locator('.packet').count(),0);assert.equal(await p.locator('#device-temperature').textContent(),'—');assert.match(await p.locator('#tour-progress').textContent(),/STEP 1 OF 5/);await resetContext.close();
  const experiment=await browser.newContext();const x=await experiment.newPage();await x.goto(base);await ready(x);await generateIdentity(x);await x.locator('#next').click();await ready(x);
  // The focused guide has only its intended destination. A wrong drop leaves the packet untouched.
  await x.locator('.tour-message [data-select]').dragTo(x.locator('#server-panel h2'));await ready(x);assert.equal(await x.locator('.packet').count(),1);assert.equal(await x.locator('#archive .archive-card').count(),0);
  await x.locator('.tour-message [data-select]').focus();await x.keyboard.press('Enter');await x.locator('[data-destination="device"]').focus();await x.keyboard.press('Enter');await ready(x);assert(await x.locator('#next').isDisabled());assert.equal(await x.locator('.packet').count(),1);await drag(x,'device');
  await x.locator('#next').click();await ready(x);await drag(x,'server');await x.locator('#next').click();await ready(x);await x.locator('#next').click();await ready(x);await drag(x,'device');
  // Attack chapter is also directly available before enrollment, without prerequisite traffic.
  await x.locator('#chapter-attack').click();await ready(x);assert.equal(await x.locator('.packet').count(),0);
  assert.equal(await x.locator('#server-status').textContent(),'Not enrolled');
  await experiment.close();
  if(name==='chromium'){
   const touchContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true});const t=await touchContext.newPage();await t.goto(base);await ready(t);await generateIdentity(t);await t.locator('#next').click();await ready(t);
   const cdp=await touchContext.newCDPSession(t);
   const center=box=>({x:box.x+box.width/2,y:box.y+box.height/2});
   async function touchMove(target,end='touchEnd'){
    for(const role of ['device','server']){const box=await t.locator('#'+role+'-panel').boundingBox();assert(box.y>=0&&box.y+box.height<=844,role+' panel should fit on a phone screen');}
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
   // Deliver all enrollment packets directly onto the recipient headers.
   for(const [index,target]of ['#device-panel h2','#server-panel h2','#device-panel h2'].entries()){
    if(index===2){await t.locator('#next').tap();await ready(t);}
    if(index){await t.locator('#next').tap();await ready(t);}
    await touchMove(target);assert(!(await t.locator('#next').isDisabled()));
    assert.equal(await t.locator('#archive .archive-card').count(),index+1);
   }
   // Taps on a packet and recipient must never deliver it; dragging is required.
   await t.locator('#reset').tap();await ready(t);await generateIdentity(t);await t.locator('#next').tap();await ready(t);
   await t.locator('.tour-message [data-select]').tap();assert.equal(await t.locator('.selected').count(),0);
   assert(await t.locator('#next').isDisabled());await t.locator('[data-destination="device"]').tap();await ready(t);assert(await t.locator('#next').isDisabled());assert.equal(await t.locator('.packet').count(),1);await touchMove('#device-panel h2');assert(!(await t.locator('#next').isDisabled()));
   await t.locator('#chapter-attack').tap();await ready(t);await generateIdentity(t);await t.locator('#next').tap();await ready(t);
   await t.locator('[data-action="corrupt"]').tap();await ready(t);
   await touchMove('#device-panel h2');assert.match(await t.locator('#device-result').textContent(),/Rejected/);
   await t.locator('#retry').tap();await ready(t);await touchMove('#device-panel h2');assert(!(await t.locator('#next').isDisabled()));
   await touchContext.close();
  }
  const noRng=await browser.newContext();await noRng.addInitScript(()=>Object.defineProperty(globalThis,'crypto',{value:undefined}));const r=await noRng.newPage();await r.goto(base);await r.locator('#error').waitFor({state:'visible'});assert.match(await r.locator('#error').textContent(),/randomness/);assert(await r.locator('#next').isDisabled());await noRng.close();
  console.log(`PASS ${name}: user-delivered tour, drag/drop, reflection/replay, focused instructions, bounded queues, enrollment attacks, reset, keyboard/mobile, no external requests, RNG failure`);
 }finally{await browser.close();}
}
}finally{await new Promise(r=>server.close(r));}
