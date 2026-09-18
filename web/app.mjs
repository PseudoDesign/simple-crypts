import {Lab,tour} from './lab.mjs';
import {hex} from './endpoint.mjs';
const $=id=>document.getElementById(id);
let busy=false,mode='tour',step=-1,operation=0,queueKey='',archiveKey='',selected=null,dragged=null;
let expected=null,completed=false,original=null;
const lab=new Lab(render);
const text=(id,value)=>{$(id).textContent=value;};
function hint(){text('move-hint',selected===null?'Drag a message box, or select one and activate a destination. Escape cancels selection.':`Message ${selected} selected. Choose Device inbox, Server inbox, Hold here, or Discard.`);}
function card(p){
  const article=document.createElement('article');article.className='packet'+(p.corrupted?' corrupted':'');article.dataset.packet=p.id;article.dataset.origin=p.origin;
  const handle=document.createElement('div');handle.className='drag-handle';handle.draggable=true;handle.tabIndex=0;handle.setAttribute('role','button');handle.dataset.select=p.id;
  handle.setAttribute('aria-label',`Move message ${p.id} from ${p.from}`);handle.textContent=`⠿  Message ${p.id} · ${p.from === 'device'?'Device → Server':'Server → Device'}`;
  const meta=document.createElement('p');meta.className='packet-meta';meta.textContent=`${p.bytes.length} bytes · ${p.corrupted?'modified ciphertext':'sealed message'}`;
  const actions=document.createElement('div');actions.className='packet-actions';
  for(const [action,label]of [['duplicate','Duplicate'],['corrupt','Corrupt']]){const b=document.createElement('button');b.textContent=label;b.dataset.action=action;b.dataset.packet=p.id;b.setAttribute('aria-label',`${label} message ${p.id}`);actions.append(b);}
  const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='Inspect opaque bytes';pre.textContent=hex(p.bytes).match(/.{1,48}/g).join('\n');details.append(summary,pre);
  article.append(handle,meta,actions,details);return article;
}
function render(){
  for(const role of ['device','server']){
    const s=lab.states[role];
    if(!s){text(role+'-temperature','—');text(role+'-name','Not assigned');text(role+'-details','');text(role+'-status','Starting');$(role+'-status').className='badge';continue;}
    text(role+'-temperature',s.has_temperature?(s.temperature/1000).toFixed(3)+' °C':'—');
    text(role+'-name',(role==='device'?s.actual_name:s.desired_name)||'Not assigned');
    text(role+'-status',s.pending?'Pending':s.apply_status===2?'Rejected':s.registered?'Confirmed':'Not enrolled');
    $(role+'-status').className='badge '+(s.pending?'pending':s.registered?'confirmed':'');
    const fields={serial:s.serial,public_key:s.public_key,registered:!!s.registered,desired_revision:s.desired_revision,reported_revision:s.reported_revision,applied_desired_revision:s.applied_desired_revision,acked_reported_revision:s.acked_reported_revision};
    text(role+'-details',Object.entries(fields).map(([k,v])=>`${k}: ${v}`).join('\n'));
    if(role==='server')text('server-applied',s.processed_desired_revision==='0'?'No name application report yet':s.apply_status===2?'Device rejected the requested name':`Device reported name revision ${s.applied_desired_revision} applied`);
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
  for(const el of document.querySelectorAll('[data-select]')){el.draggable=!locked;el.setAttribute('aria-disabled',String(locked));el.tabIndex=locked?-1:0;el.setAttribute('aria-pressed',String(Number(el.dataset.select)===selected));el.closest('.packet').classList.toggle('selected',Number(el.dataset.select)===selected);el.closest('.packet').classList.toggle('tour-message',mode==='tour'&&!completed&&Number(el.closest('.packet').dataset.origin)===expected);}
  for(const zone of document.querySelectorAll('[data-destination]')){zone.classList.toggle('suggested',mode==='tour'&&step>=0&&!completed&&zone.dataset.destination===tour[step].target);zone.setAttribute('aria-describedby','move-hint');}
  $('next').disabled=locked||(mode==='tour'&&step>=0&&!completed);$('sandbox').disabled=locked||mode==='sandbox';
  $('retry').hidden=mode!=='tour'||step<0||completed||lab.queue.some(p=>p.origin===expected&&!p.corrupted);$('retry').disabled=locked||lab.queue.length>=64;
  document.body.dataset.busy=String(busy);document.body.dataset.ready=String(lab.ready);
  text('session-status',!lab.ready?'Initializing local endpoints…':busy?'Running the library…':mode==='sandbox'?'Sandbox · every message may be tried against either endpoint.':step<0?'Start the tour to generate the first message.':completed?'Action complete · continue when you are ready.':'Your turn · move the highlighted message.');
}
function intro(){step=-1;completed=false;expected=null;original=null;selected=null;dragged=null;hint();text('tour-progress','THE GUIDED EXCHANGE · 6 HANDS-ON STEPS');text('tour-title','Take a message. Choose its destination.');text('tour-text','The device and server will generate messages. You drag each box to an inbox or to Discard, then inspect what changed.');text('next','Start guided tour →');$('progress-fill').style.width='0%';text('result-title','No message has been delivered.');text('result-text','An inbox receives only when you drop a message into it.');$('result-changes').replaceChildren();}
async function run(fn){if(busy)return;const id=++operation;busy=true;$('error').hidden=true;render();try{await fn();}catch(error){if(id===operation&&error.name!=='AbortError'){text('error',error.message);$('error').hidden=false;}}finally{if(id===operation){busy=false;render();}}}
async function place(id,target){
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
    completed=true;text('tour-text',tour[step].success);text('next',step===tour.length-1?'Replay guided tour ↺':'Generate next message →');$('progress-fill').style.width=((step+1)/tour.length*100)+'%';
  }else if(mode==='tour'&&step>=0&&!completed&&target!=='relay'){
    text('tour-text',`You tried ${target==='discard'?'discarding it':`the ${target} inbox`}. The result below comes from the library. To continue this lesson, move the highlighted message to ${tour[step].target==='discard'?'Discard':`the ${tour[step].target} inbox`}. If it is gone or modified, use “Try this message again.”`);
  }
}
$('reset').onclick=()=>{operation++;busy=false;intro();mode='tour';run(()=>lab.reset());};
$('sandbox').onclick=()=>{mode='sandbox';text('tour-progress','SANDBOX · YOU ARE THE INTERMEDIARY');text('tour-title','Try any message against either endpoint.');text('tour-text','Generate messages, deliver older ones first, reflect them back to their sender, or replay a box from the history. Leave a box in Hold to delay it.');text('next','Restart guided tour →');render();};
$('next').onclick=()=>run(async()=>{
  if(mode==='sandbox'||step===tour.length-1){mode='tour';intro();await lab.reset();}
  const next=step+1;const id=await tour[next].prepare(lab);if(id===null)throw new Error('No message generated. Reset the tour to start a fresh exchange.');
  step=next;completed=false;expected=lab.packet(id).origin;original={...lab.packet(id),bytes:lab.packet(id).bytes.slice()};
  text('tour-progress',`YOUR TURN · STEP ${step+1} OF ${tour.length}`);text('tour-title',tour[step].title);text('tour-text',tour[step].text);text('step-code',tour[step].code);text('next','Move the message to continue');
});
$('retry').onclick=()=>run(()=>lab.replay(original));
$('temperature-form').onsubmit=e=>{e.preventDefault();run(()=>lab.update('device','report',{temperature:Math.round(Number($('temperature').value)*1000)}));};
$('name-form').onsubmit=e=>{e.preventDefault();run(()=>lab.update('server','name',{name:$('name').value}));};
for(const b of document.querySelectorAll('[data-transmit]'))b.onclick=()=>run(()=>lab.transmit(b.dataset.transmit,Number($('budget').value)));
for(const b of document.querySelectorAll('[data-reboot]'))b.onclick=()=>run(()=>lab.update(b.dataset.reboot,'reboot',{}));
let suppressClick=false;
document.addEventListener('click',e=>{
  if(suppressClick){suppressClick=false;e.preventDefault();return;}
  const b=e.target.closest('button,[data-select]');if(!b||b.disabled||b.getAttribute('aria-disabled')==='true'||busy)return;
  if(b.dataset.select){selected=selected===Number(b.dataset.select)?null:Number(b.dataset.select);hint();render();}
  if(b.dataset.destination){if(selected===null){text('move-hint','Select or drag a message first.');return;}run(()=>place(selected,b.dataset.destination));}
  if(b.dataset.action)run(()=>lab[b.dataset.action](Number(b.dataset.packet)));
  if(b.dataset.replay)run(()=>lab.replay(lab.archive.find(p=>p.id===Number(b.dataset.replay))));
});
document.addEventListener('keydown',e=>{const handle=e.target.closest('[data-select]');if(handle&&(e.key==='Enter'||e.key===' ')){e.preventDefault();handle.click();return;}if(e.key==='Escape'){selected=null;dragged=null;clearHighlights();hint();render();}});
function clearHighlights(){for(const z of document.querySelectorAll('.drag-over'))z.classList.remove('drag-over');}
document.addEventListener('dragstart',e=>{const handle=e.target.closest('[data-select]');if(!handle||busy){e.preventDefault();return;}dragged={id:Number(handle.dataset.select),epoch:lab.epoch};e.dataTransfer.setData('text/plain',String(dragged.id));e.dataTransfer.effectAllowed='move';});
document.addEventListener('dragover',e=>{const zone=e.target.closest('[data-destination]');if(zone&&dragged&&!busy&&!zone.disabled){e.preventDefault();e.dataTransfer.dropEffect='move';clearHighlights();zone.classList.add('drag-over');}});
document.addEventListener('drop',e=>{const zone=e.target.closest('[data-destination]');e.preventDefault();clearHighlights();const item=dragged;dragged=null;if(zone&&item&&item.epoch===lab.epoch&&!busy&&!zone.disabled)run(()=>place(item.id,zone.dataset.destination));});
document.addEventListener('dragend',()=>{dragged=null;clearHighlights();});
// Touch drag uses the same destination operation; tap-select is also available.
let touch=null;
document.addEventListener('pointerdown',e=>{suppressClick=false;const handle=e.target.closest('[data-select]');if(e.pointerType==='mouse'||!handle||handle.disabled||busy)return;touch={id:Number(handle.dataset.select),epoch:lab.epoch,x:e.clientX,y:e.clientY,active:false};handle.setPointerCapture(e.pointerId);});
document.addEventListener('pointermove',e=>{if(!touch)return;if(Math.hypot(e.clientX-touch.x,e.clientY-touch.y)>8)touch.active=true;if(!touch.active)return;e.preventDefault();clearHighlights();document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-destination]')?.classList.add('drag-over');});
document.addEventListener('pointerup',e=>{const t=touch;touch=null;clearHighlights();if(!t?.active)return;suppressClick=true;const zone=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-destination]');if(zone&&t.epoch===lab.epoch&&!busy&&!zone.disabled)run(()=>place(t.id,zone.dataset.destination));});
document.addEventListener('pointercancel',()=>{touch=null;clearHighlights();});
window.addEventListener('pagehide',()=>lab.stop());
run(()=>lab.reset());
