/* Rendering and user input only. The worker owns keys, storage, and endpoints.
 * No timer, UI refresh, or clipboard action invokes a protocol transmission.
 */
const $ = id => document.getElementById(id);
const worker = new Worker(new URL('./worker.mjs?v=43851a847fb842c03057', import.meta.url), {type: 'module'});
const waiting = new Map();
const consoles = new Map();
const outbound = new Map();
const incoming = new Map();
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

function shellQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

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
    for (const text of [entry.kind === 'external' ? 'Python / external' : entry.running ? 'C++ / running' : 'C++ / stopped',
      entry.error ? 'Storage error' : entry.server?.registered ? 'Registered' : 'Unregistered',
      entry.server?.credits_issued ?? '—', entry.server?.credits_consumed ?? '—']) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    $('fleet-rows').append(row);
    if (entry.kind === 'browser') updateConsole(entry);
  }
  const entry = fleet.find(item => item.serial === selected);
  $('details').hidden = !entry;
  if (entry) {
    const state = entry.server;
    $('selected-title').textContent = entry.serial;
    $('kind-label').textContent = entry.kind === 'browser' ? 'C++ / WebAssembly' : 'Python / native';
    $('entry-error').textContent = entry.error ?? '';
    $('server-key').textContent = state?.public_key ?? 'Unavailable';
    $('external-help').hidden = entry.kind !== 'external';
    $('launch-command').textContent = state ?
      `bazel run //examples/python_device:console -- --serial ${shellQuote(entry.serial)} --store ${shellQuote('/tmp/simple-crypts-device-' + encodeURIComponent(entry.serial))} --server-key ${state.public_key}` : '';
    $('candidate').textContent = state?.candidate_key ?? '—';
    $('challenge').textContent = state?.challenge ?? '—';
    displayedApproval = {challenge: state?.challenge, key: state?.candidate_key};
    $('expires').textContent = state?.enrollment_expires !== '0' && state?.enrollment_expires ?
      `Session expires: ${new Date(Number(state.enrollment_expires) * 1000).toLocaleString()}` : 'No active enrollment deadline.';
    $('totals').textContent = state ? `Issued: ${state.credits_issued} · Last reported consumed: ${state.credits_consumed}` : '';
    $('server-state').textContent = JSON.stringify(state, null, 2);
    $('outbound').value = outbound.get(selected) ?? '';
    $('incoming').value = incoming.get(selected) ?? '';
    $('device-controls').hidden = entry.kind !== 'browser';
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
    $('copy').disabled ||= !/^[0-9a-f]+$/i.test(outbound.get(selected) ?? '');
  }
  for (const item of fleet) {
    const panel = consoles.get(item.serial);
    if (!panel) continue;
    panel.input.disabled = busy || !available || !item.running || Boolean(item.error);
    panel.copy.disabled = busy || !available || !panel.frame;
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
    label.textContent = `Command for ${entry.serial}`;
    const input = document.createElement('input');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 4096;
    label.append(input);
    const submit = document.createElement('button');
    submit.textContent = 'Run command';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy last frame';
    copy.onclick = () => action(async () => {
      await navigator.clipboard.writeText(panel.frame);
      notice('Copied device frame. Paste it into the server to deliver it.');
    });
    form.append(label, submit, copy);
    root.append(top, log, form);
    $('consoles').append(root);
    panel = {root, title, log, input, submit, copy, lines: ['Type help to list commands.'], frame: ''};
    consoles.set(entry.serial, panel);
    form.onsubmit = event => {
      event.preventDefault();
      const line = input.value;
      action(async () => {
        const result = await send('console', entry.serial, {line});
        panel.lines.push(`> ${line}`, result.output);
        panel.lines = panel.lines.slice(-200);
        panel.log.textContent = panel.lines.join('\n');
        panel.log.scrollTop = panel.log.scrollHeight;
        if (/^(?:[a-f0-9]{2}){1,512}$/i.test(result.output)) panel.frame = result.output;
        input.value = '';
        notice(result.output.startsWith('error:') ? result.output : 'Device command completed. No frame was delivered.', result.output.startsWith('error:'));
      });
    };
    log.textContent = panel.lines.join('\n');
  }
  panel.title.textContent = `${entry.serial} · ${entry.running ? 'running' : 'stopped'}`;
}

async function server(command, args = {}) {
  const serial = selected;
  const result = await send('server', serial, {command, ...args});
  if (command === 'tx') outbound.set(serial, result.output);
  notice(command === 'tx' ? 'Frame generated. Copy it to the device console to deliver it.' : 'Server action completed. No frame was transmitted.');
}

$('create-form').onsubmit = event => {
  event.preventDefault();
  const serial = $('serial').value;
  const kind = event.submitter?.value ?? 'browser';
  action(async () => {
    await send('create', serial, {kind});
    selected = serial;
    let number = 1;
    while (fleet.some(item => item.serial === `mcu-${String(number).padStart(4, '0')}`)) number++;
    $('serial').value = `mcu-${String(number).padStart(4, '0')}`;
    notice('Device added. Authorize enrollment to begin the manual exchange.');
  });
};
$('begin').onclick = () => action(() => server('begin'));
$('cancel').onclick = () => action(() => server('cancel'));
$('approve').onclick = () => {
  const approval = {...displayedApproval};
  action(() => server('approve', approval));
};
$('tx').onclick = () => action(() => server('tx'));
$('request').onclick = () => action(() => server('request'));
$('incoming').oninput = () => incoming.set(selected, $('incoming').value);
$('receive-form').onsubmit = event => {
  event.preventDefault();
  action(() => server('rx', {frame: $('incoming').value}));
};
$('issue-form').onsubmit = event => {
  event.preventDefault();
  action(() => server('issue', {total: $('total').value}));
};
$('copy').onclick = () => action(async () => {
  await navigator.clipboard.writeText(outbound.get(selected));
  notice('Copied server frame. Paste it into a device rx command to deliver it.');
});
$('show-console').onclick = () => { consoles.get(selected).root.hidden = false; };
$('start').onclick = () => action(async () => { await send('start', selected); notice('Resumed saved device.'); });
$('stop').onclick = () => action(async () => { await send('stop', selected); notice('Stopped device. Saved state retained.'); });

render();
try {
  await send('list');
  available = true;
  notice('Fleet ready. All message transfers are manual.');
} catch (error) { notice(error.message, true); }
busy = false;
render();
