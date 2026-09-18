import {Lab,tour} from './lab.mjs';
import {hex} from './endpoint.mjs';
const $=id=>document.getElementById(id);
let busy=false,mode='tour',step=-1,operation=0,queueKey='';
const lab=new Lab(render);
function text(id,value){$(id).textContent=value;}
function render(){
  for(const role of ['device','server']){
    const s=lab.states[role];if(!s){text(role+'-temperature','—');text(role+'-name','Not assigned');text(role+'-details','');text(role+'-status','Starting');$(role+'-status').className='badge';continue;}
    text(role+'-temperature',s.has_temperature?(s.temperature/1000).toFixed(3)+' °C':'—');
    text(role+'-name',(role==='device'?s.actual_name:s.desired_name)||'Not assigned');
    const status=s.pending?'Pending':s.apply_status===2?'Rejected':s.registered?'Confirmed':'Not enrolled';
    text(role+'-status',status);$(role+'-status').className='badge '+(s.pending?'pending':s.registered?'confirmed':'');
    const fields={serial:s.serial,public_key:s.public_key,peer_public_key:s.peer_public_key,registered:!!s.registered,desired_revision:s.desired_revision,reported_revision:s.reported_revision,applied_desired_revision:s.applied_desired_revision,processed_desired_revision:s.processed_desired_revision,acked_reported_revision:s.acked_reported_revision,storage_generation:s.storage_generation};
    text(role+'-details',Object.entries(fields).map(([k,v])=>`${k}: ${v}`).join('\n'));
    if(role==='server')text('server-applied',s.processed_desired_revision==='0'?'No name application report yet':s.apply_status===2?`Device rejected name revision ${s.processed_desired_revision}`:`Device reported name revision ${s.applied_desired_revision} applied`);
  }
  if(!lab.states.server)text('server-applied','No application report yet');
  text('queue-count',`${lab.queue.length} / 64`);
  const key=lab.queue.map(p=>`${p.id}:${p.corrupted}`).join(',')+'|'+lab.epoch;
  if(key!==queueKey){
    queueKey=key;const queue=$('queue');queue.replaceChildren();
    if(!lab.queue.length){const p=document.createElement('p');p.className='empty';p.append('No frames in transit.');const span=document.createElement('span');span.textContent='Nothing is sent automatically.';p.append(span);queue.append(p);}
    for(const p of lab.queue){
      const card=document.createElement('article');card.className='packet'+(p.corrupted?' corrupted':'');card.dataset.packet=p.id;
      const head=document.createElement('div');head.className='packet-head';const title=document.createElement('span');title.textContent=`${p.from==='device'?'Device → Server':'Server → Device'}`;const id=document.createElement('span');id.textContent=`#${p.id}`;head.append(title,id);
      const meta=document.createElement('p');meta.className='packet-meta';meta.textContent=`${p.bytes.length} bytes · ${p.corrupted?'ciphertext modified':'encrypted frame'}`;
      const actions=document.createElement('div');actions.className='packet-actions';
      for(const [action,label]of [['deliver','Deliver'],['drop','Drop'],['duplicate','Duplicate'],['corrupt','Corrupt']]){
        const b=document.createElement('button');b.textContent=label;b.dataset.action=action;b.dataset.packet=p.id;b.setAttribute('aria-label',`${label} frame ${p.id}`);actions.append(b);
      }
      const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Inspect opaque bytes';const pre=document.createElement('pre');pre.textContent=hex(p.bytes).match(/.{1,48}/g).join('\n');details.append(summary,pre);card.append(head,meta,actions,details);queue.append(card);
    }
  }
  const history=$('events');history.replaceChildren();for(const e of lab.events){const li=document.createElement('li');li.className=e.kind;li.textContent=e.message;history.append(li);}history.scrollTop=history.scrollHeight;
  for(const element of document.querySelectorAll('.lanes button,.lanes input'))element.disabled=!lab.ready||busy||mode!=='sandbox';
  for(const b of document.querySelectorAll('[data-transmit], [data-action="duplicate"]'))b.disabled=b.disabled||lab.queue.length>=64;
  $('next').disabled=!lab.ready||busy;$('sandbox').disabled=!lab.ready||busy||mode==='sandbox';
  text('session-status',!lab.ready?(lab.events.some(e=>e.kind==='error')?'Unable to start. See the message below.':'Loading the cryptographic library…'):busy?'Running the library…':mode==='sandbox'?'Sandbox · you choose every transmission and delivery.':step===tour.length-1?'Exchange confirmed · explore the sandbox or replay.':'Guided tour · advance one step at a time.');
}
function intro(){step=-1;text('tour-progress','THE GUIDED EXCHANGE · 7 STEPS');text('tour-title','Let’s lose a few packets.');text('tour-text','Follow a temperature report from enrollment to confirmation, with a dropped message and a reboot along the way. Then take control of the relay yourself.');text('next','Start guided tour →');$('progress-fill').style.width='0%';text('step-code','sc_report_temperature(&device, -18125);\nsc_set_name(&server, "Freezer 3");\n// Forward opaque frames when a link is available.');}
async function run(fn){const id=++operation;busy=true;$('error').hidden=true;render();try{await fn();}catch(error){if(id===operation&&error.name!=='AbortError'){text('error',error.message);$('error').hidden=false;}}finally{if(id===operation){busy=false;render();}}}
$('reset').onclick=()=>{mode='tour';intro();run(()=>lab.reset());};
$('sandbox').onclick=()=>{mode='sandbox';text('tour-progress','SANDBOX · EVERY OPPORTUNITY IS EXPLICIT');text('tour-title','Your relay. Your experiment.');text('tour-text','Change a temperature or name, offer a transmission, then decide which frame gets through. Leave messages queued to withhold them, or deliver newer frames before older ones.');text('next','Restart guided tour →');render();};
$('next').onclick=()=>run(async()=>{
  if(mode==='sandbox'||step===tour.length-1){mode='tour';intro();await lab.reset();}
  const current=step+1;await tour[current].run(lab);step=current;
  text('tour-progress',`THE GUIDED EXCHANGE · STEP ${step+1} OF ${tour.length}`);text('tour-title',tour[step].title);text('tour-text',tour[step].text);text('step-code',tour[step].code);
  text('next',step===tour.length-1?'Replay guided tour ↺':'Next step →');$('progress-fill').style.width=((step+1)/tour.length*100)+'%';
});
$('temperature-form').onsubmit=e=>{e.preventDefault();run(()=>lab.update('device','report',{temperature:Math.round(Number($('temperature').value)*1000)}));};
$('name-form').onsubmit=e=>{e.preventDefault();run(()=>lab.update('server','name',{name:$('name').value}));};
for(const button of document.querySelectorAll('[data-transmit]'))button.onclick=()=>run(()=>lab.transmit(button.dataset.transmit,Number($('budget').value)));
for(const button of document.querySelectorAll('[data-reboot]'))button.onclick=()=>run(()=>lab.update(button.dataset.reboot,'reboot',{}));
$('queue').onclick=e=>{const button=e.target.closest('button[data-action]');if(!button||button.disabled)return;run(()=>lab[button.dataset.action](Number(button.dataset.packet)));};
window.addEventListener('pagehide',()=>lab.stop());
run(()=>lab.reset());
