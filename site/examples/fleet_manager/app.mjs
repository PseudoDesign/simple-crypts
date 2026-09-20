/* UI only: the worker owns endpoints, persistence, and the simulated link.
 * Console commands run in C++; exchange events return as readable activity.
 */
const $ = id => document.getElementById(id);
const worker = new Worker(new URL('./worker.mjs?v=d58ba208009013e6b13a', import.meta.url), {type: 'module'});
const waiting = new Map();
const consoles = new Map();
let nextId = 0, fleet = [], selected, busy = true, available = false;
let displayedApproval;

worker.onmessage = ({data}) => {
  if (data.result?.fleet || data.fleet) fleet = data.result?.fleet ?? data.fleet;
  const pending = waiting.get(data.id);
  if (!pending) return;
  waiting.delete(data.id);
  data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.result);
};
worker.onerror = event => {
  for (const pending of waiting.values()) pending.reject(new Error(event.message));
  waiting.clear();
  available = false;
  notice('The fleet worker stopped. Reload to reopen saved state.', true);
  render();
};

function send(command, serial, args = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    waiting.set(id, {resolve, reject});
    worker.postMessage({id, command, serial, args});
  });
}

function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').classList.toggle('error', error);
}

async function action(operation) {
  if (busy || !available) return;
  busy = true;
  render();
  try { await operation(); }
  catch (error) { notice(error.message, true); }
  finally { busy = false; render(); }
}

function render() {
  if (!fleet.some(entry => entry.serial === selected)) selected = fleet[0]?.serial;
  $('empty').hidden = fleet.length > 0;
  $('fleet-rows').replaceChildren();
  for (const entry of fleet) {
    const row = document.createElement('tr');
    row.classList.toggle('selected', entry.serial === selected);
    const cell = document.createElement('td');
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = entry.serial;
    button.onclick = () => { selected = entry.serial; render(); };
    cell.append(button);
    row.append(cell);
    for (const text of [entry.running ? 'Running' : 'Stopped',
      entry.error ? 'Storage error' : entry.server?.registered ? 'Registered' : 'Unregistered',
      entry.server?.credits_issued ?? '—', entry.server?.credits_consumed ?? '—']) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    $('fleet-rows').append(row);
    updateConsole(entry);
  }
  const entry = fleet.find(item => item.serial === selected);
  $('details').hidden = !entry;
  if (entry) {
    const state = entry.server;
    $('selected-title').textContent = `Server · ${entry.serial}`;
    $('entry-error').textContent = entry.error ?? '';
    $('server-key').textContent = state?.public_key ?? 'Unavailable';
    $('candidate').textContent = state?.candidate_key ?? '—';
    $('challenge').textContent = state?.challenge ?? '—';
    displayedApproval = {challenge: state?.challenge, key: state?.candidate_key};
    const candidate = state?.candidate_key && !/^0+$/.test(state.candidate_key);
    $('enrollment-status').textContent = state?.registered ? 'Registered. Device identity approved.' : candidate ?
      'Device responded. Review its identity and approve enrollment.' : 'Authorize enrollment to connect this device.';
    $('expires').textContent = state?.enrollment_expires !== '0' && state?.enrollment_expires ?
      `Session expires: ${new Date(Number(state.enrollment_expires) * 1000).toLocaleString()}` : '';
    $('totals').textContent = state ? `Issued: ${state.credits_issued} · Last reported consumed: ${state.credits_consumed}` : '';
    $('server-state').textContent = JSON.stringify(state, null, 2);
  }
  for (const button of document.querySelectorAll('button')) button.disabled = busy || !available;
  if (entry) {
    const unusable = busy || !available || entry.error || entry.server?.storage_failed;
    for (const button of $('details').querySelectorAll('button')) button.disabled = Boolean(unusable);
    $('approve').disabled ||= entry.server?.registered || !entry.server?.candidate_key || /^0+$/.test(entry.server.candidate_key);
    $('begin').disabled ||= entry.server?.registered;
    $('cancel').disabled ||= entry.server?.registered;
    $('request').disabled ||= !entry.server?.registered;
    $('issue-form').querySelector('button').disabled ||= !entry.server?.registered;
    $('start').disabled ||= entry.running;
    $('stop').disabled ||= !entry.running;
  }
  for (const item of fleet) {
    const panel = consoles.get(item.serial);
    panel.input.disabled = busy || !available || !item.running || Boolean(item.error) || item.device?.storage_failed;
    panel.submit.disabled = panel.input.disabled;
  }
}

function updateConsole(entry) {
  let panel = consoles.get(entry.serial);
  if (!panel) {
    const root = document.createElement('article');
    root.className = 'console';
    root.dataset.serial = entry.serial;
    const top = document.createElement('div');
    top.className = 'section-title';
    const title = document.createElement('h3');
    const hide = document.createElement('button');
    hide.textContent = 'Hide';
    hide.onclick = () => { root.hidden = true; };
    top.append(title, hide);
    const log = document.createElement('pre');
    log.setAttribute('aria-label', `Console output ${entry.serial}`);
    log.setAttribute('aria-live', 'polite');
    const form = document.createElement('form');
    const label = document.createElement('label');
    label.textContent = `${entry.serial} >`;
    const input = document.createElement('input');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 4096;
    input.placeholder = 'Type help, status, consume 25, or sync';
    label.append(input);
    const submit = document.createElement('button');
    submit.textContent = 'Run command';
    form.append(label, submit);
    root.append(top, log, form);
    $('consoles').append(root);
    panel = {root, title, log, input, submit, history: [], cursor: 0, draft: ''};
    consoles.set(entry.serial, panel);
    input.onkeydown = event => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      if (panel.cursor === panel.history.length) panel.draft = input.value;
      panel.cursor = Math.max(0, Math.min(panel.history.length,
        panel.cursor + (event.key === 'ArrowUp' ? -1 : 1)));
      input.value = panel.cursor === panel.history.length ? panel.draft : panel.history[panel.cursor];
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const line = input.value.trim();
      if (!line) return;
      await action(async () => {
        panel.history.push(line);
        panel.history = panel.history.slice(-50);
        panel.cursor = panel.history.length;
        panel.draft = '';
        input.value = '';
        const result = await send('console', entry.serial, {line});
        notice(result.error ? result.output : `Command completed on ${entry.serial}.`, result.error);
      });
      if (!input.disabled) input.focus();
    };
  }
  panel.title.textContent = `${entry.serial} · ${entry.running ? 'connected' : 'stopped'}`;
  const text = entry.activity.join('\n');
  if (panel.log.textContent !== text) {
    panel.log.textContent = text;
    panel.log.scrollTop = panel.log.scrollHeight;
  }
}

async function server(command, args = {}) {
  await send('server', selected, {command, ...args});
  notice('Server action completed. See the device console for the exchange.');
}

$('create-form').onsubmit = async event => {
  event.preventDefault();
  const serial = $('serial').value;
  await action(async () => {
    await send('create', serial);
    selected = serial;
    let number = 1;
    while (fleet.some(item => item.serial === `mcu-${String(number).padStart(4, '0')}`)) number++;
    $('serial').value = `mcu-${String(number).padStart(4, '0')}`;
    notice('Device created. Authorize enrollment, then approve its identity.');
  });
  consoles.get(serial)?.input.focus();
};
$('begin').onclick = () => action(() => server('begin'));
$('cancel').onclick = () => action(() => server('cancel'));
$('approve').onclick = () => {
  const approval = {...displayedApproval};
  action(() => server('approve', approval));
};
$('request').onclick = () => action(() => server('request'));
$('issue-form').onsubmit = event => {
  event.preventDefault();
  const total = $('total').value;
  action(() => server('issue', {total}));
};
$('show-console').onclick = () => {
  const panel = consoles.get(selected);
  panel.root.hidden = false;
  panel.root.scrollIntoView({block: 'nearest'});
  panel.input.focus();
};
$('start').onclick = () => action(async () => { await send('start', selected); notice('Device resumed and synchronized.'); });
$('stop').onclick = () => action(async () => { await send('stop', selected); notice('Device stopped. Saved state retained.'); });

render();
try {
  await send('list');
  available = true;
  notice('Fleet ready. Create a device or open a console to begin.');
} catch (error) { notice(error.message, true); }
busy = false;
render();
