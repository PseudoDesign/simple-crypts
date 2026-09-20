/* The worker owns devices, storage, and links. This file owns only table forms
 * and movable console windows; dragging/hiding never changes device lifetime.
 */
const $ = id => document.getElementById(id);
const worker = new Worker(new URL('./worker.mjs?v=6d550667e48da10bb61f', import.meta.url), {type: 'module'});
const waiting = new Map();
const consoles = new Map();
const rows = new Map();
let nextId = 0, fleet = [], busy = true, available = false, topWindow = 50;

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

function raise(panel) {
  // Keep windows below navigation. DOM order is also the keyboard tab order.
  if (++topWindow >= 9999) {
    topWindow = 50;
    for (const item of consoles.values()) item.root.style.zIndex = '50';
  }
  panel.root.style.zIndex = String(topWindow);
}

function place(panel, x, y) {
  // Bound the entire window, including its title bar, after drag or resize.
  panel.x = Math.max(8, Math.min(x, innerWidth - panel.root.offsetWidth - 8));
  panel.y = Math.max(48, Math.min(y, innerHeight - panel.root.offsetHeight - 8));
  panel.root.style.left = `${panel.x}px`;
  panel.root.style.top = `${panel.y}px`;
}

function openConsole(serial) {
  const panel = consoles.get(serial);
  panel.root.hidden = false;
  place(panel, panel.x, panel.y);
  raise(panel);
  (panel.input.disabled ? panel.handle : panel.input).focus();
}

function makeRow(entry) {
  const root = $('row-template').content.firstElementChild.cloneNode(true);
  root.dataset.serial = entry.serial;
  const row = {root, entry};
  rows.set(entry.serial, row);
  $('fleet-rows').append(root);
  const button = name => root.querySelector(`[data-action="${name}"]`);
  const server = (command, args = {}) => action(async () => {
    await send('server', entry.serial, {command, ...args});
    notice(`Updated ${entry.serial}. See its console for the exchange.`);
  });
  button('open').onclick = () => openConsole(entry.serial);
  button('begin').onclick = () => server('begin');
  button('cancel').onclick = () => server('cancel');
  button('request').onclick = () => server('request');
  button('approve').onclick = () => {
    // Capture exactly the displayed binding before starting asynchronous work.
    const {challenge, candidate_key: key} = row.entry.server;
    server('approve', {challenge, key});
  };
  button('issue').onsubmit = event => {
    event.preventDefault();
    server('issue', {total: button('issue').elements.total.value});
  };
  button('power').onclick = () => action(async () => {
    const command = row.entry.running ? 'stop' : 'start';
    await send(command, entry.serial);
    notice(`${entry.serial} ${command === 'stop' ? 'stopped' : 'started'}. Saved state retained.`);
  });
  return row;
}

function updateRow(entry) {
  const row = rows.get(entry.serial) ?? makeRow(entry);
  row.entry = entry;
  const field = (name, text) => { row.root.querySelector(`[data-field="${name}"]`).textContent = text; };
  const control = name => row.root.querySelector(`[data-action="${name}"]`);
  const state = entry.server;
  const candidate = state?.candidate_key && !/^0+$/.test(state.candidate_key);
  field('serial', entry.serial);
  field('error', entry.error ?? '');
  field('running', entry.running ? 'Running' : 'Stopped');
  field('connection', entry.connected ? 'Connection enabled' : 'Disconnected');
  field('enrollment', state?.registered ? 'Registered' : candidate ? 'Awaiting approval' : 'Unregistered');
  field('candidate', state?.candidate_key ?? '—');
  field('challenge', state?.challenge ?? '—');
  field('server-key', state?.public_key ?? 'Unavailable');
  field('expires', state?.enrollment_expires && state.enrollment_expires !== '0' ?
    `Session expires: ${new Date(Number(state.enrollment_expires) * 1000).toLocaleString()}` : '');
  field('issued', state?.credits_issued ?? '—');
  field('consumed', state?.credits_consumed ?? '—');
  control('power').textContent = entry.running ? 'Stop device' : 'Start device';
  const unusable = busy || !available || Boolean(entry.error) || state?.storage_failed;
  for (const button of row.root.querySelectorAll('button')) button.disabled = Boolean(unusable);
  control('open').disabled = busy || !available;
  control('begin').disabled ||= state?.registered;
  control('cancel').disabled ||= state?.registered || !state?.enrollment_expires || state.enrollment_expires === '0';
  control('approve').disabled ||= state?.registered || !candidate;
  control('request').disabled ||= !state?.registered;
  control('issue').querySelector('button').disabled ||= !state?.registered;
}

function render() {
  $('empty').hidden = fleet.length > 0;
  for (const [serial, row] of rows) {
    if (fleet.some(entry => entry.serial === serial)) continue;
    row.root.remove();
    rows.delete(serial);
    consoles.get(serial).root.remove();
    consoles.delete(serial);
  }
  for (const entry of fleet) {
    updateRow(entry);
    updateConsole(entry);
  }
  $('create-form').querySelector('button').disabled = busy || !available;
  $('reset').disabled = busy || !available;
}

function updateConsole(entry) {
  let panel = consoles.get(entry.serial);
  if (!panel) {
    const root = document.createElement('article');
    root.className = 'console';
    root.dataset.serial = entry.serial;
    root.setAttribute('aria-label', `Device console ${entry.serial}`);
    const top = document.createElement('div');
    top.className = 'console-titlebar';
    const handle = document.createElement('button');
    handle.className = 'drag-handle';
    handle.title = 'Drag to move. Focus and use arrow keys to move; Escape cancels a drag.';
    const title = document.createElement('span');
    title.className = 'console-name';
    title.textContent = entry.serial;
    const status = document.createElement('span');
    status.className = 'console-status';
    handle.append(title, status);
    const connection = document.createElement('button');
    connection.dataset.action = 'connection';
    connection.onclick = () => action(async () => {
      const enabled = !panel.entry.connected;
      await send('connection', entry.serial, {enabled});
      notice(`${entry.serial}: connection ${enabled ? 'enabled' : 'disabled'}.`);
    });
    const debug = document.createElement('button');
    debug.dataset.action = 'debug';
    debug.onclick = () => action(async () => {
      await send('debug', entry.serial, {enabled: !panel.entry.debug});
    });
    const hide = document.createElement('button');
    hide.textContent = 'Hide';
    hide.onclick = () => {
      root.hidden = true;
      rows.get(entry.serial).root.querySelector('[data-action="open"]').focus();
    };
    top.append(handle, connection, debug, hide);
    const log = document.createElement('pre');
    log.setAttribute('aria-label', `Console output ${entry.serial}`);
    log.setAttribute('aria-live', 'polite');
    const form = document.createElement('form');
    const label = document.createElement('label');
    const prompt = document.createElement('span');
    prompt.className = 'console-prompt';
    prompt.textContent = `${entry.serial} >`;
    label.append(prompt);
    const input = document.createElement('input');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 4096;
    input.placeholder = 'help, status, consume 25, sync';
    label.append(input);
    const submit = document.createElement('button');
    submit.textContent = 'Run';
    form.append(label, submit);
    root.append(top, log, form);
    $('consoles').append(root);
    panel = {root, handle, status, connection, debug, log, input, submit, history: [], cursor: 0, draft: ''};
    consoles.set(entry.serial, panel);
    place(panel, innerWidth - 464 - (consoles.size - 1) % 5 * 28,
      innerHeight - 374 - (consoles.size - 1) % 5 * 28);
    raise(panel);
    root.addEventListener('pointerdown', () => raise(panel));
    root.addEventListener('focusin', () => raise(panel));

    // Pointer capture keeps dragging reliable outside the handle and supports
    // mouse, pen, and touch. Only the title handle initiates a move.
    let drag;
    handle.onpointerdown = event => {
      if (event.button !== 0) return;
      drag = {id: event.pointerId, x: event.clientX, y: event.clientY, left: panel.x, top: panel.y};
      handle.setPointerCapture(event.pointerId);
      root.classList.add('dragging');
      handle.focus();
    };
    handle.onpointermove = event => {
      if (drag?.id !== event.pointerId) return;
      place(panel, drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
    };
    const endDrag = () => {
      if (drag && handle.hasPointerCapture(drag.id)) handle.releasePointerCapture(drag.id);
      drag = undefined;
      root.classList.remove('dragging');
    };
    handle.onpointerup = endDrag;
    handle.onpointercancel = () => {
      if (drag) place(panel, drag.left, drag.top);
      endDrag();
    };
    handle.onlostpointercapture = endDrag;
    handle.onkeydown = event => {
      if (event.key === 'Escape' && drag) {
        place(panel, drag.left, drag.top);
        endDrag();
      }
      const delta = {ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20]}[event.key];
      if (delta) { event.preventDefault(); place(panel, panel.x + delta[0], panel.y + delta[1]); }
    };
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
  panel.entry = entry;
  panel.status.textContent = !entry.running ? 'stopped' : entry.connected ? 'connected' : 'disconnected';
  panel.connection.textContent = entry.connected ? 'Disconnect' : 'Connect';
  panel.connection.setAttribute('aria-pressed', String(entry.connected));
  panel.connection.disabled = busy || !available || Boolean(entry.error) || entry.server?.storage_failed;
  panel.debug.textContent = entry.debug ? 'Debug: on' : 'Debug: off';
  panel.debug.setAttribute('aria-pressed', String(entry.debug));
  panel.debug.title = entry.debug ? 'Disable debug logging' : 'Enable debug logging';
  panel.debug.disabled = busy || !available;
  panel.input.disabled = busy || !available || !entry.running || Boolean(entry.error) || entry.device?.storage_failed;
  panel.submit.disabled = panel.input.disabled;
  const text = entry.activity
    .filter(line => entry.debug || line.level !== 'debug')
    .map(line => line.text).join('\n');
  if (panel.log.textContent !== text) {
    panel.log.textContent = text;
    panel.log.scrollTop = panel.log.scrollHeight;
  }
}

window.addEventListener('resize', () => {
  for (const panel of consoles.values()) if (!panel.root.hidden) place(panel, panel.x, panel.y);
});
$('create-form').onsubmit = async event => {
  event.preventDefault();
  const serial = $('serial').value;
  await action(async () => {
    await send('create', serial);
    let number = 1;
    while (fleet.some(item => item.serial === `mcu-${String(number).padStart(4, '0')}`)) number++;
    $('serial').value = `mcu-${String(number).padStart(4, '0')}`;
    notice('Device created. Authorize enrollment and approve its identity in the fleet table.');
  });
  if (consoles.has(serial)) openConsole(serial);
};
$('reset').onclick = () => $('reset-dialog').showModal();
$('reset-dialog').addEventListener('close', () => {
  if ($('reset-dialog').returnValue !== 'reset') return;
  action(async () => {
    await send('reset');
    $('serial').value = 'mcu-0001';
    notice('All saved fleet data deleted. Create a device to start fresh.');
  });
});

render();
try {
  await send('list');
  available = true;
  notice('Fleet ready. Create a device or open a console to begin.');
} catch (error) { notice(error.message, true); }
busy = false;
render();
