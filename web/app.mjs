import {Lab,tour,DEVICE_SERIAL} from './lab.mjs';
import {hex} from './endpoint.mjs';
const $=id=>document.getElementById(id);
let busy=false,mode='tour',step=-1,operation=0,queueKey='',archiveKey='',selected=null,dragged=null;
let expected=null,completed=false,original=null,setup=0;
const lab=new Lab(render);
let sandboxRole='device';
function guideRole(){return mode==='sandbox'?sandboxRole:step<0?(setup<2?'device':'server'):completed?tour[step].target:original?.from??'server';}
function positionTip(){
  const role=guideRole(),popup=$('guide-popup'),panel=$(role+'-panel');
  popup.dataset.role=role;
  $('guide-role').textContent=role==='device'?'Device':'Server';
  popup.setAttribute('aria-label',`${role==='device'?'Device':'Server'} step guidance`);
  for(const endpoint of document.querySelectorAll('.endpoint'))endpoint.classList.toggle('guidance-target',!popup.hidden&&endpoint===panel);
  const box=panel.getBoundingClientRect(),width=popup.getBoundingClientRect().width;
  const left=Math.max(12,Math.min(innerWidth-width-12,box.x+(box.width-width)/2));
  popup.style.left=left+'px';
  popup.style.setProperty('--pointer-x',(box.x+box.width/2-left)+'px');
}
function showTip(){ $('guide-popup').hidden=false;positionTip(); }
window.addEventListener('resize',positionTip);
$('hide-tip').onclick=()=>{$('guide-popup').hidden=true;positionTip();document.querySelector('.chapter-banner [aria-current]').focus();};
const text=(id,value)=>{$(id).textContent=value;};
function datetime(seconds){
  const value=BigInt(seconds);
  return value<=8640000000000n?new Date(Number(value)*1000).toISOString().replace('T',' ').replace('.000Z',' UTC'):'Outside date range';
}
function hint(){text('move-hint',mode==='tour'?'Drag the packet onto the highlighted recipient.':'Drag a message onto an endpoint, Hold here, or Discard.');}
function card(p){
  const article=document.createElement('article');article.className='packet'+(p.corrupted?' corrupted':'');article.dataset.packet=p.id;article.dataset.origin=p.origin;
  const handle=document.createElement('div');handle.className='drag-handle';handle.draggable=true;handle.tabIndex=0;handle.setAttribute('role','group');handle.dataset.select=p.id;
  handle.setAttribute('aria-label',`Move message ${p.id} from ${p.from}`);
  const title=document.createElement('span');title.className='packet-title';handle.append(title);
  const fields=[];
  if(p.signed&&p.bytes.length===172){
    const serial=new TextDecoder().decode(p.bytes.slice(36,68)).replace(/\0+$/,'');
    const challenge=hex(p.bytes.slice(68,100));
    const expires=new DataView(p.bytes.buffer,p.bytes.byteOffset,p.bytes.byteLength).getBigUint64(100).toString();
    fields.push(['Serial',serial],['Challenge',`${challenge.slice(0,8)}…`],['Expires',datetime(expires)],['Signature','Ed25519'],['Visibility','Public']);
  }else if(!p.signed&&p.senderState){
    const s=p.senderState;
    fields.push(['Serial',s.serial],['Challenge',`${s.challenge.slice(0,8)}…`]);
    if(p.from==='device'){
      if(s.has_temperature)fields.push(['Temperature',`${s.temperature} m°C`]);
      fields.push(['Report revision',s.reported_revision],['Name',s.actual_name||'(empty)']);
    }else{
      fields.push(['Confirmed','true'],['Report acknowledged',s.reported_revision],['Name',s.desired_name||'(empty)'],['Name revision',s.desired_revision]);
    }
  }
  if(fields.length){
    handle.classList.add('has-summary');
    const summary=document.createElement('span');summary.className='packet-summary';
    if(!p.signed){const note=document.createElement('span');note.className='packet-perspective-note';note.textContent='Sender’s view · before encryption';summary.append(note);}
    for(const [key,value] of fields){
      const line=document.createElement('span');
      const label=document.createElement('strong');label.textContent=key+': ';
      const content=document.createElement('span');content.textContent=value;
      line.append(label,content);summary.append(line);
    }
    if(!p.signed){
      const cipher=document.createElement('span');cipher.className='packet-ciphertext';
      // The first 62 bytes are routing/nonce metadata; NaCl box output follows.
      const bytes=p.bytes.slice(62);
      cipher.textContent=`Ciphertext + tag: ${bytes.length} bytes\n${hex(bytes).slice(0,24)}…`;
      summary.append(cipher);
    }
    handle.append(summary);
  }
  const meta=document.createElement('p');meta.className='packet-meta';meta.textContent=`${p.bytes.length} bytes · ${p.corrupted?'modified packet':p.signed?'signed public challenge':'sealed message'}`;
  const actions=document.createElement('div');actions.className='packet-actions';
  for(const [action,label]of [['duplicate','Duplicate'],['corrupt','Corrupt']]){const b=document.createElement('button');b.textContent=label;b.dataset.action=action;b.dataset.packet=p.id;b.setAttribute('aria-label',`${label} message ${p.id}`);actions.append(b);}
  const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=p.signed?'Inspect signed bytes':'Inspect opaque bytes';pre.textContent=hex(p.bytes).match(/.{1,48}/g).join('\n');details.append(summary,pre);
  article.append(handle,meta,actions,details);return article;
}
$('chapter-trust').onclick=e=>{e.preventDefault();if(mode==='tour'){showTip();return;}$('reset').click();};
$('chapter-state').onclick=e=>{e.preventDefault();if(busy)return;if(!lab.states.device?.registered||!lab.states.server?.registered){showTip();return;}if(mode!=='sandbox')enterSharedState();showTip();};
function render(){
  const enrolled=!!lab.states.device?.registered&&!!lab.states.server?.registered;
  const sharing=mode==='sandbox'&&enrolled;
  for(const [id,current]of [['chapter-trust',!sharing],['chapter-state',sharing]]){if(current)$(id).setAttribute('aria-current','step');else $(id).removeAttribute('aria-current');}
  $('chapter-state').setAttribute('aria-disabled',String(!enrolled||busy));
  $('chapter-state').title=enrolled?'Change the name, report temperature, and drag messages between endpoints':'Complete enrollment to share state';
  $('chapter-trust').title=mode==='tour'?'Current enrollment chapter':'Restart enrollment with fresh keys';

  document.body.dataset.mode=mode;
  document.body.dataset.phase=step<0?'intro':completed?'complete':'deliver';
  document.body.dataset.target=mode==='tour'&&step>=0?tour[step].target:'';
  $('server-trust-details').hidden=!lab.states.server;
  text('pinned-server-key',lab.states.device?.peer_public_key??lab.states.server?.public_key??'');
  text('device-unique-id',lab.states.device?.serial??DEVICE_SERIAL);
  text('device-public-key',lab.devicePublicKey??lab.states.device?.public_key??'Not generated yet');
  text('server-public-key',lab.states.server?.public_key??'Starting…');
  text('device-private-key',lab.devicePublicKey||lab.states.device?'●●●● · Kept on device':'Not generated yet');
  text('server-private-key',lab.states.server?'●●●● · Kept on server':'Starting…');
  $('registered-key-details').hidden=!lab.states.server?.registered&&(!lab.states.server||lab.states.server.candidate_revision==='0');
  text('registered-key-label',lab.states.server?.registered?'Registered device public key':'Proposed device public key · unapproved');
  text('registered-device-key',lab.states.server?.registered?lab.states.server.peer_public_key:lab.states.server?.candidate_key??'');
  for(const key of document.querySelectorAll('.public-key'))key.title=key.textContent;
  $('enrollment-packet').hidden=mode!=='tour'||step<0;
  for(const role of ['device','server']){
    document.querySelector('#'+role+'-panel h2').textContent=mode==='tour'?(role==='device'?'Device':'Server'):(role==='device'?'Temperature sensor':'Device registry');
    const state=lab.states[role];
    text(role+'-summary',state?(state.registered?(role==='device'?'Enrollment confirmed':'Serial + key registered'):(role==='device'?'Not yet confirmed':state.candidate_revision!=='0'?'Awaiting approval':'Not enrolled')):role==='device'?(lab.devicePublicKey?'Key pair generated':'No key pair yet'):'Starting…');
  }
  for(const role of ['device','server']){
    const s=lab.states[role];
    text(role+'-temperature-state',role==='device'
      ? !s?.has_temperature?'Not measured':s.acked_reported_revision===s.reported_revision?'Receipt confirmed':'Awaiting server receipt'
      : s?.has_temperature?'Accepted report':s?.candidate_revision&&s.candidate_revision!=='0'?'Report received · awaiting approval':'No accepted report');
    if(role==='device')text('device-name-state',!s||s.desired_revision==='0'?'No name received':s.apply_status===2?'Name rejected':`Applied · revision ${s.applied_desired_revision}`);
    if(!s){text(role+'-temperature','—');text(role+'-name','Not assigned');text(role+'-details','');text(role+'-status',role==='device'?'No identity yet':'Starting');$(role+'-status').className='badge';continue;}
    text(role+'-temperature',s.has_temperature?(s.temperature/1000).toFixed(3)+' °C':'—');
    text(role+'-name',(role==='device'?s.actual_name:s.desired_name)||'Not assigned');
    text(role+'-status',s.pending?'Pending':s.apply_status===2?'Rejected':s.registered?'Confirmed':'Not enrolled');
    $(role+'-status').className='badge '+(s.pending?'pending':s.registered?'confirmed':'');
    const fields={serial:s.serial,public_key:s.public_key,registered:!!s.registered,desired_revision:s.desired_revision,reported_revision:s.reported_revision,applied_desired_revision:s.applied_desired_revision,acked_reported_revision:s.acked_reported_revision};
    text(role+'-details',Object.entries(fields).map(([k,v])=>`${k}: ${v}`).join('\n'));
    if(role==='server')text('server-applied',s.desired_revision==='0'?'No name requested':s.processed_desired_revision!==s.desired_revision?'Awaiting device application report':s.apply_status===2?'Device rejected the requested name':`Device reported name revision ${s.applied_desired_revision} applied`);
  }
  if(!lab.states.server)text('server-applied','No application report yet');
  text('queue-count',`${lab.queue.length} / 64`);
  if(selected!==null&&!lab.queue.some(p=>p.id===selected)){selected=null;hint();}
  const key=lab.queue.map(p=>`${p.id}:${p.corrupted}:${p.location}`).join(',')+'|'+lab.epoch;
  if(key!==queueKey){
    queueKey=key;for(const [location,id]of [['device-outbox','device-outbox'],['relay','queue'],['server-outbox','server-outbox']]){
      const tray=$(id);tray.replaceChildren();const messages=lab.queue.filter(p=>p.location===location);
      if(!messages.length){const p=document.createElement('p');p.className='empty';p.textContent=location==='relay'?'No messages being held.':'No messages waiting.';tray.append(p);}
      for(const p of messages)tray.append(card(p));
    }
  }
  const akey=lab.archive.map(p=>`${p.id}:${p.outcome}`).join('|')+'|'+lab.epoch;
  if(akey!==archiveKey){archiveKey=akey;$('archive').replaceChildren();for(const p of lab.archive){const a=document.createElement('article');a.className='archive-card';const label=document.createElement('p');label.textContent=`Message ${p.id} · ${p.from} · ${p.outcome}`;const b=document.createElement('button');b.dataset.replay=p.id;b.textContent='Queue a copy';b.setAttribute('aria-label',`Replay message ${p.id}`);a.append(label,b);$('archive').append(a);}}
  const history=$('events');history.replaceChildren();for(const e of lab.events){const li=document.createElement('li');li.className=e.kind;li.textContent=e.message;history.append(li);}history.scrollTop=history.scrollHeight;
  const locked=!lab.ready||busy;
  for(const el of document.querySelectorAll('.lanes button,.lanes input,#archive button'))el.disabled=locked;
  for(const el of document.querySelectorAll('.endpoint form button,.endpoint form input,[data-transmit],[data-reboot],#budget'))el.disabled=locked||mode!=='sandbox';
  for(const el of document.querySelectorAll('[data-transmit],[data-action="duplicate"],[data-replay]'))el.disabled=el.disabled||lab.queue.length>=64;
  for(const el of document.querySelectorAll('[data-select]')){el.querySelector('.packet-title').textContent=mode==='tour'?(lab.packet(Number(el.dataset.select)).signed?'⠿  Signed challenge':'⠿  Encrypted packet'):`⠿  Message ${el.dataset.select} · ${lab.packet(Number(el.dataset.select)).from==='device'?'Device → Server':'Server → Device'}`;el.draggable=!locked;el.setAttribute('aria-disabled',String(locked));el.tabIndex=locked?-1:0;el.closest('.packet').classList.toggle('selected',Number(el.dataset.select)===selected);el.closest('.packet').classList.toggle('tour-message',mode==='tour'&&!completed&&Number(el.closest('.packet').dataset.origin)===expected);}
  for(const zone of document.querySelectorAll('[data-destination]')){zone.disabled=locked||(mode==='tour'&&(step<0||completed||zone.dataset.destination!==tour[step].target));zone.dataset.dropEnabled=String(!zone.disabled);zone.classList.toggle('suggested',mode==='tour'&&step>=0&&!completed&&zone.dataset.destination===tour[step].target);zone.setAttribute('aria-describedby','move-hint');}
  $('begin-enrollment').disabled=locked||mode!=='sandbox'||!!lab.states.server?.registered;
  $('approve-enrollment').disabled=locked||mode!=='sandbox'||!lab.states.server||lab.states.server.candidate_revision==='0';
  $('packet-inspector').hidden=mode!=='tour'||step<0;
  $('experiment-tools').hidden=mode!=='sandbox';
  $('next').hidden=mode==='tour'&&step>=0&&!completed;
  $('next').disabled=locked||(mode==='tour'&&step>=0&&!completed);
  $('retry').hidden=mode!=='tour'||step<0||completed||lab.queue.some(p=>p.origin===expected&&!p.corrupted);$('retry').disabled=locked||lab.queue.length>=64;
  document.body.dataset.busy=String(busy);document.body.dataset.ready=String(lab.ready);
  positionTip();
  text('session-status',!lab.ready?'Initializing local endpoints…':busy?'Running the library…':mode==='sandbox'?'Sandbox · every message may be tried against either endpoint.':step<0?'Start the tour to generate the first message.':completed?'Action complete · continue when you are ready.':'Your turn · move the highlighted message.');
}
function intro(){showTip();$('packet-inspector').open=false;$('experiment-tools').open=false;setup=0;step=-1;completed=false;expected=null;original=null;selected=null;dragged=null;hint();text('tour-progress','STEP 1 OF 5');text('tour-title','Generate the device’s key pair.');text('tour-text','Create a public identity and a private key inside the device.');text('next','Generate key pair →');$('progress-fill').style.width='0%';text('result-title','No message has been delivered.');text('result-text','An endpoint receives only when you drop a message onto it.');$('result-changes').replaceChildren();}
async function run(fn){if(busy)return;const id=++operation;busy=true;$('error').hidden=true;render();try{await fn();}catch(error){if(id===operation&&error.name!=='AbortError'){text('error',error.message);$('error').hidden=false;}}finally{if(id===operation){busy=false;render();}}}
async function place(id,target){
  if(mode==='tour'&&(step<0||completed||target!==tour[step].target))return;
  const p=lab.packet(id);let result;
  if(target==='relay'){lab.move(id,'relay');}
  else if(target==='discard'){lab.drop(id);text('result-title',`Message ${id} discarded`);text('result-text','No endpoint received this message. Pending work remains pending.');$('result-changes').replaceChildren();}
  else{
    result=await lab.deliver(id,target);
    text('result-title',`Message ${id}: ${result.code<0?'rejected':result.changes.length?'accepted':'accepted; no newer state'}`);
    text('result-text',result.code<0?`${target==='device'?'Device':'Server'} rejected this attempt (${result.status}). Its state did not change.`:result.changes.length?`${target==='device'?'Device':'Server'} authenticated the message. Its state changes are shown below.`:'The message authenticated, but it supplied no newer application state. Duplicates and stale snapshots cannot roll state back.');
    $('result-changes').replaceChildren();for(const change of result.changes){const li=document.createElement('li');li.textContent=`${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`;$('result-changes').append(li);}
  }
  selected=null;hint();
  if(mode==='tour'&&step>=0&&!completed&&p.origin===expected&&target===tour[step].target&&(target==='discard'||result?.code===0)){
    showTip();completed=true;text('tour-title',step===tour.length-1?'Enrollment complete.':target==='discard'?'Packet discarded.':'Delivered.');text('tour-text',tour[step].success);text('next',step===tour.length-1?'Start again ↺':step===1?'Approve this serial + key →':'Create encrypted response →');$('progress-fill').style.width=((step===2?5:step+2)/5*100)+'%';
  }else if(mode==='tour'&&step>=0&&!completed&&target!=='relay'){
    text('tour-text',`You tried ${target==='discard'?'discarding it':`the ${target}`}. The result below comes from the library. To continue this lesson, move the highlighted message to ${tour[step].target==='discard'?'Discard':`the ${tour[step].target}`}. If it is gone or modified, use “Try this message again.”`);
  }
}
$('reset').onclick=()=>{cancelTouch();operation++;busy=false;intro();mode='tour';run(()=>lab.reset({deferDevice:true}));};
function enterSharedState(){return run(async()=>{cancelTouch();if(!lab.states.device){if(!lab.devicePublicKey)await lab.generateDevice();await lab.provisionDevice();setup=2;}mode='sandbox';text('tour-progress','EXPLORE · YOU MOVE THE MESSAGES');text('tour-title','Share state between the endpoints.');text('tour-text','The server chooses a name; the device measures temperature. Create and drag messages to see when the other side learns each change.');text('next','Restart guided tour →');render();});}
$('next').onclick=()=>run(async()=>{
  if(mode==='sandbox'||step===tour.length-1){mode='tour';intro();await lab.reset({deferDevice:true});return;}
  if(setup===0){if(!lab.devicePublicKey)await lab.generateDevice();await lab.provisionDevice();setup=2;text('tour-title','The device has its own identity.');text('tour-text','Its private key stays on the device. The server can now authorize enrollment.');text('next','Authorize session & create challenge →');$('progress-fill').style.width='20%';return;}
  if(step===1&&completed&&!lab.states.server.registered){await lab.approveEnrollment();text('tour-progress','STEP 4 OF 5');text('tour-title','The server approved this identity.');text('tour-text','Approval binds the serial and key, accepts the report, and consumes the session.');text('next','Create confirmation →');$('progress-fill').style.width='80%';return;}
  const next=step+1;const id=await tour[next].prepare(lab);if(id===null)throw new Error('No message generated. Reset the tour to start a fresh exchange.');
  step=next;completed=false;expected=lab.packet(id).origin;original={...lab.packet(id),bytes:lab.packet(id).bytes.slice()};
  const sender=lab.states[original.from];
  text('packet-label',`${original.from.toUpperCase()} → ${original.to.toUpperCase()} · ${original.bytes.length} BYTES`);
  text('packet-title',step===0?'Signed enrollment challenge':step===1?'Encrypted enrollment response':'Enrollment confirmation');
  document.querySelector('.packet-perspective').textContent=step===0?'Public packet. The device verifies the signature using its pinned server key.':'Sender’s view before encryption. The host forwards opaque bytes.';
  const fields=step===0?[['Serial',sender.serial],['Session challenge',sender.challenge],['Expires at',datetime(sender.enrollment_expires)],['Signature','Ed25519 · 64 bytes'],['Authorization','Session open; no device key approved yet']]:step===1?[['Serial',sender.serial],['Session challenge',sender.challenge],['First report',`${sender.temperature} millidegrees Celsius`],['Report revision',sender.reported_revision],['Approval','Required before registration']]:[['Serial',sender.serial],['Session challenge',sender.challenge],['Enrollment confirmed','true'],['Acknowledged report revision',sender.reported_revision]];
  $('packet-fields').replaceChildren();for(const [name,value]of fields){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=value;$('packet-fields').append(dt,dd);}
  text('packet-wire',`Sender public key: ${sender.public_key}\nRecipient public key: ${lab.states[original.to].public_key}\n\nActual wire frame:\n${hex(original.bytes).match(/.{1,48}/g).join('\n')}`);
  $('enrollment-packet').querySelector('details').open=false;
  text('tour-progress',`STEP ${step===2?5:step+2} OF 5`);text('tour-title',tour[step].title);text('tour-text',tour[step].text);text('step-code',tour[step].code);text('next','Continue →');
});
$('begin-enrollment').onclick=()=>run(()=>lab.beginEnrollment());
$('approve-enrollment').onclick=()=>run(()=>lab.approveEnrollment());
$('retry').onclick=()=>run(()=>lab.replay(original));
$('temperature-form').onsubmit=e=>{e.preventDefault();run(()=>lab.update('device','report',{temperature:Math.round(Number($('temperature').value)*1000)}));};
$('name-form').onsubmit=e=>{e.preventDefault();run(()=>lab.update('server','name',{name:$('name').value}));};
for(const b of document.querySelectorAll('[data-transmit]'))b.onclick=()=>run(()=>lab.transmit(b.dataset.transmit,Number($('budget').value)));
for(const b of document.querySelectorAll('[data-reboot]'))b.onclick=()=>run(()=>lab.update(b.dataset.reboot,'reboot',{}));
let suppressClick=false;
document.addEventListener('click',e=>{
  if(suppressClick){suppressClick=false;e.preventDefault();return;}
  const b=e.target.closest('button,[data-select]');if(!b||b.disabled||b.getAttribute('aria-disabled')==='true'||busy)return;
  if(b.dataset.action)run(()=>lab[b.dataset.action](Number(b.dataset.packet)));
  if(b.dataset.replay)run(()=>{const packet=lab.archive.find(p=>p.id===Number(b.dataset.replay));const id=lab.replay(packet);lab.move(id,packet.from+'-outbox');$('experiment-tools').open=false;});
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){cancelTouch();selected=null;dragged=null;clearHighlights();hint();render();}});
function clearHighlights(){for(const z of document.querySelectorAll('.drag-over'))z.classList.remove('drag-over');}
document.addEventListener('dragstart',e=>{const handle=e.target.closest('[data-select]');if(!handle||busy||touch){e.preventDefault();return;}dragged={id:Number(handle.dataset.select),epoch:lab.epoch};e.dataTransfer.setData('text/plain',String(dragged.id));e.dataTransfer.effectAllowed='move';});
document.addEventListener('dragover',e=>{const zone=e.target.closest('[data-destination]');if(zone&&dragged&&!busy&&!zone.disabled){e.preventDefault();e.dataTransfer.dropEffect='move';clearHighlights();zone.classList.add('drag-over');}},true);
document.addEventListener('drop',e=>{const zone=e.target.closest('[data-destination]');e.preventDefault();clearHighlights();const item=dragged;dragged=null;if(zone&&item&&item.epoch===lab.epoch&&!busy&&!zone.disabled)run(()=>place(item.id,zone.dataset.destination));},true);
document.addEventListener('dragend',()=>{dragged=null;clearHighlights();});
// Use one pointer drag path for mouse, touch, and pen, including nested recipient controls.
// The floating preview never intercepts hit testing; only the owning pointer can deliver.
let touch=null;
function touchZone(x,y){
  const hit=document.elementFromPoint(x,y);
  let zone=hit?.closest('[data-destination]');
  if(!zone){
    const panel=hit?.closest('.endpoint');
    zone=panel?.querySelector('[data-destination]');
    if(!zone&&mode==='tour')zone=hit?.closest('.relay')?.querySelector('[data-destination="discard"]');
  }
  return zone&&!zone.disabled&&zone.getClientRects().length?zone:null;
}
function cancelTouch(){
  const t=touch;touch=null;
  if(t){
    t.preview?.remove();t.handle.classList.remove('touch-source');
    t.handle.draggable=lab.ready&&!busy;
    if(t.handle.hasPointerCapture(t.pointer))t.handle.releasePointerCapture(t.pointer);
  }
  clearHighlights();
}
document.addEventListener('pointerdown',e=>{
  suppressClick=false;
  const handle=e.target.closest('[data-select]');
  if(touch||e.button!==0||!e.isPrimary||!handle||handle.getAttribute('aria-disabled')==='true'||busy)return;
  touch={id:Number(handle.dataset.select),epoch:lab.epoch,pointer:e.pointerId,handle,x:e.clientX,y:e.clientY,active:false};
  handle.draggable=false;handle.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove',e=>{
  const t=touch;if(!t||e.pointerId!==t.pointer)return;
  if(!t.active&&Math.hypot(e.clientX-t.x,e.clientY-t.y)<=8)return;
  e.preventDefault();
  if(!t.active){
    t.active=true;
    t.preview=document.createElement('div');t.preview.className='touch-packet';
    t.preview.textContent=t.handle.querySelector('.packet-title').textContent;t.preview.setAttribute('aria-hidden','true');
    document.body.append(t.preview);t.handle.classList.add('touch-source');
  }
  // Offset above the finger so the moving packet and destination remain visible.
  t.preview.style.left=e.clientX+'px';t.preview.style.top=(e.clientY-24)+'px';
  clearHighlights();touchZone(e.clientX,e.clientY)?.classList.add('drag-over');
},{passive:false});
document.addEventListener('pointerup',e=>{
  const t=touch;if(!t||e.pointerId!==t.pointer)return;
  const zone=touchZone(e.clientX,e.clientY);cancelTouch();
  if(!t.active)return;
  suppressClick=true;
  if(zone&&t.epoch===lab.epoch&&!busy)run(()=>place(t.id,zone.dataset.destination));
});
for(const event of ['pointercancel','lostpointercapture'])document.addEventListener(event,e=>{if(e.pointerId===touch?.pointer)cancelTouch();});
document.addEventListener('contextmenu',e=>{if(e.target.closest('[data-select]'))e.preventDefault();});
window.addEventListener('blur',cancelTouch);
window.addEventListener('pagehide',()=>{cancelTouch();lab.stop();});
intro();run(()=>lab.reset({deferDevice:true}));
