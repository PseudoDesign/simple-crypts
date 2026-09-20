import {Lab,tour,DEVICE_SERIAL} from './lab.mjs?v=e574c95ce10839c1155f';
import {resources} from './resources.mjs?v=e574c95ce10839c1155f';
import {hex} from './endpoint.mjs?v=e574c95ce10839c1155f';
const $=id=>document.getElementById(id);
let busy=false,mode='tour',step=-1,operation=0,queueKey='',archiveKey='',selected=null,dragged=null;
let expected=null,completed=false,original=null,setup=0,chapter='trust',consumedLocally=false;
let errorLesson=-1,errorDone=false,errorOrigin=null;
let networkPhase=null,networkOrigin=null;
const errorLessons=[
 {role:'device',title:'Try spending more than you have.',text:'Press + beside the device’s Credits consumed to spend 25 at a time. Keep going until the library refuses the next purchase.',status:'conflict',reason:'The debit exceeds the device’s accepted credit balance.'},

];
const lab=new Lab(render);
const logCorruption=new Map();
function packetView(id){
 if(id>0)return lab.packet(id);
 const saved=lab.archive.find(p=>p.id===-id);if(!saved)throw new Error('This packet has left the bounded log.');
 const copy={...saved,id,bytes:saved.bytes.slice()};
 if(logCorruption.get(-id)){copy.bytes[copy.bytes.length-1]^=1;copy.corrupted=!copy.corrupted;}
 return copy;
}
function resultLabel(result){return `${result.status} (${result.code})`;}
let rejectionRole=null;
function rejectionReason(result){
 const reasons={authentication:'Signature or ciphertext authentication failed. The packet may have been altered or sent by an unexpected key.',enrollment:'This packet does not match an active enrollment session or approved identity.',protocol:'The packet format, direction, or authenticated fields are invalid.',bounds:'The packet length is outside the accepted limits.',conflict:'The packet conflicts with an already accepted revision.',storage:'The state could not be saved. Try again.',random_unavailable:'Secure randomness is unavailable. Key generation cannot continue.',crypto:'The cryptographic provider could not complete the operation.'};
 if(result.status==='enrollment'&&lab.states.server?.enrollment_expires!=='0'&&BigInt(lab.time)>=BigInt(lab.states.server?.enrollment_expires??0))return 'The server’s enrollment session has expired. Start a new session.';
 return reasons[result.status]??`The library rejected this operation: ${result.status}.`;
}
function guideRole(){if(networkPhase)return ['report','reported'].includes(networkPhase)?'server':'device';if(errorLesson>=0)return errorLessons[errorLesson].role;if(chapter==='credits'&&step===5&&completed&&!consumedLocally)return 'device';if(rejectionRole)return rejectionRole;return step<0?'server':completed?tour[step].target:original?.from??'server';}
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
  const article=document.createElement('article');article.className='packet'+(p.corrupted?' corrupted':'');article.dataset.packet=p.id;article.dataset.origin=p.origin;article.dataset.from=p.from;article.dataset.pending=String(p.id>0);
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
    if(p.messageKind===3){fields.push(['Receipt for request',s.snapshot_id]);}
    else if(p.messageKind===1||p.messageKind===2){
      const response=p.messageKind===2;
      fields.push(['Message',response?'Status snapshot':'Snapshot request'],[resources.groups[0].fields[0].label,response?s.snapshot_issued:s.credits_issued],
        [resources.groups[0].fields[1].label,response?s.snapshot_consumed:s.has_snapshot?s.credits_consumed:'Not reported'],
        ['Request ID',s.request_id]);
    }else fields.push(['Enrollment',p.from==='device'?'Identity claim':'Confirmed']);
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
  const toggle=document.createElement('button');toggle.dataset.action='corrupt';toggle.dataset.packet=p.id;toggle.textContent=p.corrupted?'Corruption: on':'Corruption: off';toggle.setAttribute('aria-pressed',String(p.corrupted));toggle.setAttribute('aria-label',`Toggle corruption for message ${Math.abs(p.id)}`);actions.append(toggle);
  const outcome=document.createElement('p');outcome.className='message-outcome';
  outcome.textContent=p.result?`Last attempt · ${p.result.target}: ${resultLabel(p.result)} · ${p.result.code<0?'rejected':p.result.changed?'state updated':'no change'}`:p.outcome??'Not delivered';
  if(p.result?.code<0)outcome.dataset.error='true';
  const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=p.signed?'Inspect signed bytes':'Inspect opaque bytes';pre.textContent=hex(p.bytes).match(/.{1,48}/g).join('\n');details.append(summary,pre);
  if(p.id>0&&networkPhase==='drop'){
    const drop=document.createElement('button');drop.dataset.action='drop';drop.dataset.packet=p.id;drop.textContent='Drop';drop.setAttribute('aria-label',`Drop message ${p.id}`);actions.append(drop);
  }
  article.append(outcome,actions,handle,meta,details);return article;
}
function chapterEnd(){return chapter==='credits'?tour.length-1:2;}
async function prepareChapter(){
  history.replaceState(null,'',chapter==='credits'?'#credits':'#establish-trust');
  if(chapter==='credits'){
    // A direct chapter jump starts from an actually enrolled, empty-credit pair.
    if(!lab.states.device?.registered||!lab.states.server?.registered||(chapter==='credits'&&lab.states.server.credits_issued!=='0')){
      await lab.reset({deferDevice:true});
      for(let index=0;index<3;index++){
        if(index===2)await lab.approveEnrollment();
        const id=await tour[index].prepare(lab);
        const result=await lab.deliver(id,tour[index].target);
        if(result.code!==0)throw new Error(result.status);
      }
      lab.queue=[];lab.archive=[];lab.events=[];
    }
    if(chapter==='credits'){lab.queue=[];lab.archive=[];lab.events=[];lab.event('Credits chapter starts with enrolled endpoints and zero credits.');}
  }else await lab.reset({deferDevice:true});
  intro();
}
async function startChapter(name){
  if(busy)return;
  cancelTouch();chapter=name;mode='tour';intro();
  await run(prepareChapter);
}
for(const name of ['trust','credits'])$('chapter-'+name).onclick=e=>{
  e.preventDefault();if(busy)return;if(chapter===name){showTip();return;}startChapter(name);
};
function render(){
  for(const name of ['trust','credits']){const link=$('chapter-'+name);if(name===chapter)link.setAttribute('aria-current','step');else link.removeAttribute('aria-current');link.setAttribute('aria-disabled',String(busy));}
  document.body.dataset.chapter=chapter;
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
    text(role+'-consumed-state',role==='device'?'Local total · reports only on request':s?.has_snapshot?`Last reported · request ${s.snapshot_id}`:'Not reported');
    text(role+'-issued-state',role==='device'?'Accepted cumulative total':'Server-issued cumulative total');
    text(role+'-consumed',!s?'—':role==='server'&&!s.has_snapshot?'Not reported':s.credits_consumed);
    text(role+'-issued',s?.credits_issued??'—');
    text(role+'-status',s?.pending?'Pending':s?.registered?'Confirmed':'Not enrolled');
    text(role+'-details',s?Object.entries(s).map(([k,v])=>`${k}: ${v}`).join('\n'):'');
  }
  text('queue-count',`${lab.queue.length} / 64`);
  if(selected!==null&&!lab.queue.some(p=>p.id===selected)){selected=null;hint();}
  // New frames stay with their sender until an attempted delivery or drop.
  // Only completed attempts enter the shared replay log.
  for(const id of logCorruption.keys())if(!lab.archive.some(p=>p.id===id))logCorruption.delete(id);
  const key=lab.queue.map(p=>`${p.id}:${p.corrupted}`).join(',')+'|'+lab.archive.map(p=>`${p.id}:${p.outcome}:${logCorruption.get(p.id)}`).join(',')+'|'+lab.epoch+'|'+chapter+'|'+networkPhase;
  if(key!==queueKey){
    queueKey=key;const log=$('message-log');log.replaceChildren();
    for(const role of ['device','server']){
      const outbox=$(role+'-outbox');
      outbox.replaceChildren();
      const pending=lab.queue.filter(packet=>packet.from===role);
      if(!pending.length){
        const empty=document.createElement('p');empty.className='outbox-empty';
        empty.textContent='No pending message';outbox.append(empty);
      }
      for(const packet of pending)outbox.append(card(packet));
    }
    if(!lab.archive.length){
      const empty=document.createElement('p');empty.className='log-empty';
      empty.textContent='Delivered, rejected, or dropped messages will appear here.';log.append(empty);
    }
    for(const packet of lab.archive)log.append(card(packetView(-packet.id)));
  }
  const history=$('events');history.replaceChildren();for(const e of lab.events){const li=document.createElement('li');li.className=e.kind;li.textContent=e.message;history.append(li);}history.scrollTop=history.scrollHeight;
  const locked=!lab.ready||busy;
  for(const el of document.querySelectorAll('.lanes button,.lanes input,#message-log button,#advance-time'))el.disabled=locked;
  for(const el of document.querySelectorAll('.endpoint form button,.endpoint form input,[data-transmit],[data-reboot],#budget'))el.disabled=true;
  for(const el of document.querySelectorAll('[data-transmit],[data-action="duplicate"],[data-replay]'))el.disabled=el.disabled||lab.queue.length>=64;
  for(const el of document.querySelectorAll('[data-select]')){el.querySelector('.packet-title').textContent=`⠿ #${Math.abs(Number(el.dataset.select))} · ${packetView(Number(el.dataset.select)).from==='device'?'Device → Server':'Server → Device'}`;el.draggable=!locked;el.setAttribute('aria-disabled',String(locked));el.tabIndex=locked?-1:0;el.closest('.packet').classList.toggle('selected',Number(el.dataset.select)===selected);el.closest('.packet').classList.toggle('tour-message',mode==='tour'&&(!completed||['drop','deliver','repeat','report','receipt'].includes(networkPhase)||errorLesson>=3&&!errorDone)&&Number(el.closest('.packet').dataset.origin)===expected);}
  for(const zone of document.querySelectorAll('[data-destination]')){zone.disabled=locked;zone.dataset.dropEnabled=String(!locked);zone.classList.toggle('suggested',['deliver','repeat','report','receipt'].includes(networkPhase)?zone.dataset.destination===(networkPhase==='report'?'server':'device'):errorLesson>=3&&!errorDone?zone.dataset.destination===errorLessons[errorLesson].role:step>=0&&!completed&&zone.dataset.destination===tour[step].target);zone.setAttribute('aria-describedby','move-hint');}
  $('restart-enrollment').disabled=locked;
  const enrollmentDone=chapter==='trust'&&step===2&&completed;
  $('restart-enrollment').hidden=!enrollmentDone&&!rejectionRole;
  text('restart-enrollment',enrollmentDone?'Retry enrollment ↺':chapter==='credits'?'Restart credits ↺':'Restart enrollment ↺');
  $('advance-time').disabled=locked||!lab.states.server;
  $('begin-enrollment').disabled=true||!!lab.states.server?.registered;
  $('approve-enrollment').disabled=true||!lab.states.server||lab.states.server.candidate_revision==='0';
  $('packet-inspector').hidden=mode!=='tour'||step<0;
  $('experiment-tools').hidden=true;
  const waitForPlus=chapter==='credits'&&(step<0||step===5&&completed&&!consumedLocally);
  $('add-credit').hidden=$('consume-credit').hidden=chapter==='trust';
  $('add-credit').disabled=locked||!!networkPhase||errorLesson>=0||!(step<0||step===8&&completed);
  $('consume-credit').disabled=locked||!!networkPhase||(errorLesson>=0?errorLesson!==0||errorDone:!(step===5&&completed&&!consumedLocally||step===8&&completed));
  $('next').hidden=(networkPhase?!['dropped','repeated','reported','done'].includes(networkPhase):waitForPlus||(errorLesson>=0?(errorLesson===0||errorLesson>=3)&&!errorDone:mode==='tour'&&step>=0&&!completed));
  $('next').disabled=locked||(mode==='tour'&&step>=0&&!completed);
  $('retry').hidden=true;
  document.body.dataset.busy=String(busy);document.body.dataset.ready=String(lab.ready);
  positionTip();
  text('session-status',!lab.ready?'Initializing local endpoints…':busy?'Running the library…':step<0?'Start the tour to generate the first message.':completed?'Action complete · continue when you are ready.':'Your turn · move the highlighted message.');
}
function intro(){networkPhase=null;networkOrigin=null;errorLesson=-1;errorDone=false;errorOrigin=null;logCorruption.clear();rejectionRole=null;$('restart-enrollment').hidden=true;text('clock-result','Expiration is checked when a response arrives.');for(const role of ['device','server'])$(role+'-result').hidden=true;showTip();$('packet-inspector').open=false;$('experiment-tools').open=false;setup=0;consumedLocally=false;step=-1;completed=false;expected=null;original=null;selected=null;dragged=null;hint();text('tour-progress',chapter==='credits'?'CREDITS · START':'STEP 1 OF 5');text('tour-title',chapter==='credits'?'Share credits between enrolled endpoints.':'Authorize an enrollment session.');text('tour-text',chapter==='credits'?'Click + beside the server’s Credits issued to add 100 credits and create a message for the device.':'The server signs a challenge for this device’s unique ID. The device already knows the server’s public key.');text('next',chapter==='credits'?'Issue 100 credits →':'Authorize session & create challenge →');$('progress-fill').style.width='0%';text('result-title','No message has been delivered.');text('result-text','An endpoint receives only when you drop a message onto it.');$('result-changes').replaceChildren();
}
async function run(fn){if(busy)return;const id=++operation;busy=true;$('error').hidden=true;render();try{await fn();}catch(error){if(id===operation&&error.name!=='AbortError'){text('error',error.message);$('error').hidden=false;}}finally{if(id===operation){busy=false;render();}}}
async function place(id,target){
  if(id<0)id=lab.replay(packetView(id));
  const p=lab.packet(id);let result;
  if(target==='relay'){lab.move(id,'relay');}

  else{
    result=await lab.deliver(id,target);rejectionRole=result.code<0?target:null;$('restart-enrollment').hidden=result.code>=0;text('restart-enrollment',chapter==='credits'?'Restart credits ↺':'Restart enrollment ↺');
    {text(target+'-result',`${resultLabel(result)} · ${result.code<0?'Rejected · '+rejectionReason(result):result.changes.length?'state updated':'no newer state'}`);$(target+'-result').hidden=false;$(target+'-result').dataset.rejected=String(result.code<0);}
    text('result-title',`Message ${id}: ${resultLabel(result)} · ${result.code<0?'rejected':result.changes.length?'accepted':'accepted; no newer state'}`);
    text('result-text',result.code<0?`${resultLabel(result)}: ${rejectionReason(result)} No state was accepted.`:result.changes.length?`${target==='device'?'Device':'Server'} authenticated the message. Its state changes are shown below.`:'The packet authenticated without changing enrollment or application state.');
    $('result-changes').replaceChildren();for(const change of result.changes){const li=document.createElement('li');li.textContent=`${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`;$('result-changes').append(li);}
  }
  selected=null;hint();
  if(networkPhase){
    if(p.origin===networkOrigin&&result?.code===0){
      if(networkPhase==='deliver'&&target==='device')networkGuide('repeat');
      else if(networkPhase==='repeat'&&target==='device')networkGuide('repeated');
      else if(networkPhase==='report'&&target==='server')networkGuide('reported');
      else if(networkPhase==='receipt'&&target==='device')networkGuide('done');
    }
    return;
  }
  if(errorLesson>=0){
    const lesson=errorLessons[errorLesson];
    if(!errorDone&&errorLesson>=3&&p.origin===errorOrigin&&target===lesson.role&&result?.status===lesson.status)finishError(result);
    else if(!errorDone){text('tour-text',`${resultLabel(result)}. ${lesson.text}`);showTip();}
    return;
  }
  if(mode==='tour'&&step>=0&&!completed&&p.origin===expected&&target===tour[step].target&&result?.code===0){
    showTip();completed=true;text('tour-title',step===chapterEnd()?(chapter==='credits'?'Credit exchange complete.':'Enrollment complete.') :step===2?'Enrollment complete.':'Delivered.');text('tour-text',tour[step].success);text('next',step===chapterEnd()?(chapter==='credits'?'Explore errors →':'On to credits →'):step===0?(lab.states.device?'Create encrypted response →':'Generate key pair & create response →'):step===1?'Approve this serial + key →':step===2?'Issue 100 credits →':step===5?'Consume 25 locally →':(step===3||step===6?'Create status report →':'Create receipt →'));$('progress-fill').style.width=((step-(chapter==='credits'?3:0)+1)/(chapter==='credits'?6:3)*100)+'%';
  }else{
    showTip();if(result?.code<0)text('tour-title','Packet rejected.');text('tour-text',$('result-text').textContent);

  }
}
$('restart-enrollment').onclick=()=>run(async()=>{
  if(chapter==='credits'){await prepareChapter();return;}
  if(lab.states.server.registered){intro();await lab.reset({deferDevice:true});return;}
  const result=await lab.command('server','enrollment_cancel');if(result.code!==0)throw new Error(result.status);
  lab.queue=[];lab.archive=[];lab.verifiedChallenge=null;intro();
});
$('reset').onclick=()=>startChapter(chapter);
function finishError(result){
  const lesson=errorLessons[errorLesson];errorDone=true;rejectionRole=null;
  text(lesson.role+'-result',`${resultLabel(result)} · ${lesson.reason}`);$(lesson.role+'-result').hidden=false;$(lesson.role+'-result').dataset.rejected='true';
  text('tour-title','The library rejected it.');
  text('tour-text',`${resultLabel(result)}: ${lesson.reason} Credit totals stay unchanged.`);
  text('next','Try dropped / repeated packets →');showTip();
}
function beginError(index){
  errorLesson=index;errorDone=false;rejectionRole=null;const lesson=errorLessons[index];
  text('tour-progress','CREDITS · OVERSPENDING');text('tour-title',lesson.title);text('tour-text',lesson.text);text('next',lesson.button??'Deliver the packet');
  if(index>=3){const id=lab.replay(original);errorOrigin=lab.packet(id).origin;expected=errorOrigin;}
  showTip();
}
const networkGuidance={
 drop:['Drop this credit packet.','The server has added 100 credits, but the device has not received them. Click Drop on the new packet.',''],
 dropped:['The packet never arrived.','The device’s total is unchanged. There is no receive error: the library was never called. The server still has pending work. Give it another transmission opportunity.','Retry transmission →'],
 deliver:['Deliver the retry.','Drag the new packet to the device. The server retries the same cumulative total, using a fresh nonce.',''],
 repeat:['Deliver that packet again.','Drag the saved packet to the device once more. Will it add another 100 credits?',''],
 repeated:['Repeated delivery adds no credits.','The library accepted the duplicate without increasing the total. Now send the device’s captured status report.','Create status report →'],
 report:['Deliver the status report.','Drag the device’s response to the server to confirm the accepted credit total.',''],
 reported:['The server has its answer.','The server accepted the snapshot. Create its receipt to finish the exchange.','Create receipt →'],
 receipt:['Deliver the receipt.','Drag the receipt to the device so it can stop retrying its report.',''],
 done:['Exercise complete.','You’ve seen overspending rejected, a dropped packet retried, and a duplicate accepted without adding credits. Restart to try the exchange again.','Restart credits ↺']
};
function networkGuide(phase){
 networkPhase=phase;rejectionRole=null;const [title,description,button]=networkGuidance[phase];
 text('tour-progress','CREDITS · DELIVERY');text('tour-title',title);text('tour-text',description);text('next',button);showTip();
}
async function networkPacket(role,phase){
 const id=await lab.transmit(role);if(id===null)throw new Error('No pending packet. Restart the exercise.');
 networkOrigin=lab.packet(id).origin;expected=networkOrigin;networkGuide(phase);
}
async function beginNetwork(){
 errorLesson=-1;errorDone=false;
 await lab.update('server','issue',{total:(BigInt(lab.states.server.credits_issued)+100n).toString()});
 await networkPacket('server','drop');
}
async function advanceTour(){
  if(networkPhase){
    if(networkPhase==='dropped')await networkPacket('server','deliver');
    else if(networkPhase==='repeated')await networkPacket('device','report');
    else if(networkPhase==='reported')await networkPacket('server','receipt');
    else if(networkPhase==='done')await prepareChapter();
    return;
  }
  if(errorLesson>=0){
    if(errorDone)await beginNetwork();
    else if(errorLesson>0&&errorLesson<3){const lesson=errorLessons[errorLesson];const result=await lab.command(lesson.role,lesson.command,lesson.args());if(result.status!==lesson.status)throw new Error(`Unexpected library result: ${result.status}`);finishError(result);}
    return;
  }
  if(chapter==='credits'&&step===8&&completed){beginError(0);return;}
  if(step===chapterEnd()){mode='tour';chapter='credits';await prepareChapter();return;}

  if(step===1&&completed&&!lab.states.server.registered){await lab.approveEnrollment();text('tour-progress','STEP 4 OF 5');text('tour-title','The server approved this identity.');text('tour-text','Approval binds the serial and key and consumes the enrollment session.');text('next','Create confirmation →');$('progress-fill').style.width='80%';return;}
  rejectionRole=null;$('restart-enrollment').hidden=true;
  const next=step<0&&chapter==='credits'?3:step+1;const id=await tour[next].prepare(lab);if(id===null)throw new Error('No message generated. Reset the tour to start a fresh exchange.');
  step=next;completed=false;expected=lab.packet(id).origin;original={...lab.packet(id),bytes:lab.packet(id).bytes.slice()};
  const sender=lab.states[original.from];
  text('packet-label',`${original.from.toUpperCase()} → ${original.to.toUpperCase()} · ${original.bytes.length} BYTES`);
  text('packet-title',tour[step].title);
  document.querySelector('.packet-perspective').textContent=step===0?'Public packet. The device verifies the signature using its pinned server key.':'Sender’s view before encryption. The host forwards opaque bytes.';
  const fields=step===0?[['Serial',sender.serial],['Challenge',sender.challenge],['Expires at',datetime(sender.enrollment_expires)],['Signature','Ed25519']]:step<3?[['Serial',sender.serial],['Challenge',sender.challenge],['Enrollment',step===1?'Approval required':'Confirmed']]:original.messageKind===3?[['Receipt for request',sender.snapshot_id]]:[['Credits issued',original.from==='device'?sender.snapshot_issued:sender.credits_issued],['Credits consumed',original.from==='device'?sender.snapshot_consumed:sender.has_snapshot?sender.credits_consumed:'Not reported'],['Request ID',sender.request_id]];
  $('packet-fields').replaceChildren();for(const [name,value]of fields){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=value;$('packet-fields').append(dt,dd);}
  text('packet-wire',`Sender public key: ${sender.public_key}\nRecipient public key: ${(lab.states[original.to]?.public_key??'Not generated yet')}\n\nActual wire frame:\n${hex(original.bytes).match(/.{1,48}/g).join('\n')}`);
  $('enrollment-packet').querySelector('details').open=false;
  text('tour-progress',step<3?`ENROLLMENT · ${step+1} OF 3`:`CREDITS · ${step-2} OF 6`);text('tour-title',tour[step].title);text('tour-text',tour[step].text);text('step-code',tour[step].code);text('next','Continue →');
}
$('next').onclick=()=>run(advanceTour);
$('add-credit').onclick=()=>run(async()=>{
  if(step<0){await advanceTour();return;}
  const total=BigInt(lab.states.server.credits_issued)+100n;
  if(total>18446744073709551615n)throw new Error('Credit total exceeds uint64.');
  await lab.update('server','issue',{total:total.toString()});await lab.transmit('server');
});
$('consume-credit').onclick=()=>run(async()=>{
  const result=await lab.command('device','consume',{amount:'25'});
  text('device-result',`${resultLabel(result)} · ${result.code<0?'Not enough available credits.':'25 credits consumed locally.'}`);$('device-result').hidden=false;$('device-result').dataset.rejected=String(result.code<0);
  if(errorLesson===0&&!errorDone){
    if(result.status==='conflict')finishError(result);
    else if(result.code===0){
      const remaining=BigInt(lab.states.device.credits_issued)-BigInt(lab.states.device.credits_consumed);
      text('tour-text',`${remaining} credits left. ${remaining>=25n?'Press + again to consume another 25.':'Press + once more to try spending beyond your balance.'}`);showTip();
    }
  }
  if(result.code===0&&step===5){consumedLocally=true;text('tour-title','25 credits consumed locally.');text('tour-text','The device saved its consumption. No packet was created: the server still sees its last report of 0.');text('next','Request current status →');}
});
$('advance-time').onclick=()=>run(()=>{lab.time+=601;lab.event('Simulated server clock advanced by 601 seconds; no packet was delivered.');text('clock-result',lab.states.server.registered?'Server time advanced. Completed enrollment stays valid; drag a saved packet to see the response.':'Server time advanced. Replay an enrollment response to test the expired session.');});
$('begin-enrollment').onclick=()=>run(()=>lab.beginEnrollment());
$('approve-enrollment').onclick=()=>run(()=>lab.approveEnrollment());
$('retry').onclick=()=>run(()=>{const id=lab.replay(original);lab.move(id,original.from+'-outbox');});
$('consume-form').onsubmit=e=>{e.preventDefault();run(()=>lab.update('device','consume',{amount:$('amount').value}));};
$('issue-form').onsubmit=e=>{e.preventDefault();run(()=>lab.update('server','issue',{total:$('total').value}));};
for(const b of document.querySelectorAll('[data-transmit]'))b.onclick=()=>run(()=>lab.transmit(b.dataset.transmit,Number($('budget').value)));
for(const b of document.querySelectorAll('[data-reboot]'))b.onclick=()=>run(()=>lab.update(b.dataset.reboot,'reboot',{}));
let suppressClick=false;
document.addEventListener('click',e=>{
  if(suppressClick){suppressClick=false;e.preventDefault();return;}
  const b=e.target.closest('button,[data-select]');if(!b||b.disabled||b.getAttribute('aria-disabled')==='true'||busy)return;
  if(b.dataset.action==='drop')run(()=>{
    const id=Number(b.dataset.packet),p=lab.packet(id);lab.drop(id);
    if(networkPhase==='drop'&&p.origin===networkOrigin)networkGuide('dropped');
  });
  if(b.dataset.action==='corrupt')run(()=>{
    const id=Number(b.dataset.packet);
    if(id>0)lab.corrupt(id);else logCorruption.set(-id,!logCorruption.get(-id));
  });
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
  delete document.body.dataset.dragging;
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
    t.active=true;document.body.dataset.dragging='true';
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
chapter=location.hash==='#credits'?'credits':'trust';
intro();run(prepareChapter);
