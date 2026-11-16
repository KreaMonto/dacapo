// Da Capo frontend. Owns no musical state: every edit is sent to Rust,
// which answers with the full document view to redraw.

import { renderScore, hitTest, esc } from './render.js';

const tauri = window.__TAURI__;
const invoke = tauri.core.invoke;
const dialog = tauri.dialog;

const FILTERS = [{ name: 'Da Capo score', extensions: ['dacapo'] }];
const KEY_NAMES = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
const DURATION_KEYS = { 1: 'SixtyFourth', 2: 'ThirtySecond', 3: 'Sixteenth', 4: 'Eighth', 5: 'Quarter', 6: 'Half', 7: 'Whole' };

const state = {
  docs: new Map(), // id -> DocView
  order: [], // tab order
  active: null,
  duration: { base: 'Quarter', dots: 0 },
  layout: null,
  error: null,
};

const $ = (id) => document.getElementById(id);
const page = $('page');

// ----- talking to Rust -------------------------------------------------------

// Edits are chained so fast typing (key repeat) is applied in order.
let queue = Promise.resolve();
function serial(fn) {
  queue = queue.then(fn).catch(showError);
  return queue;
}

function showError(e) {
  state.error = String(e);
  renderStatus();
  console.error(e);
}

function adopt(view) {
  if (!state.docs.has(view.id)) state.order.push(view.id);
  state.docs.set(view.id, view);
  state.error = null;
  return view;
}

const active = () => state.docs.get(state.active);

function act(action) {
  return serial(async () => {
    if (!state.active) return;
    adopt(await invoke('edit', { id: state.active, action }));
    render();
  });
}

// ----- commands --------------------------------------------------------------

async function newDocument() {
  const v = adopt(await invoke('new_document'));
  state.active = v.id;
  render();
}

async function openDocument() {
  const path = await dialog.open({ multiple: false, filters: FILTERS });
  if (!path) return;
  const v = adopt(await invoke('open_document', { path }));
  state.active = v.id;
  render();
}

async function saveDocument(saveAs = false) {
  const doc = active();
  if (!doc) return false;
  let path = null;
  if (saveAs || !doc.path) {
    path = await dialog.save({ filters: FILTERS, defaultPath: `${doc.name}.dacapo` });
    if (!path) return false;
  }
  adopt(await invoke('save_document', { id: doc.id, path }));
  render();
  return true;
}

async function closeDocument(id) {
  const doc = state.docs.get(id);
  if (!doc) return;
  let discard = false;
  if (doc.dirty) {
    state.active = id;
    render();
    const save = await dialog.ask(`Save changes to “${doc.name}” before closing?`, {
      title: 'Da Capo', kind: 'warning', okLabel: 'Save', cancelLabel: 'Don’t save',
    });
    if (save) {
      if (!(await saveDocument())) return;
    } else {
      const sure = await dialog.ask(`Close “${doc.name}” and lose the unsaved changes?`, {
        title: 'Da Capo', kind: 'warning', okLabel: 'Discard changes', cancelLabel: 'Keep editing',
      });
      if (!sure) return;
      discard = true;
    }
  }
  await invoke('close_document', { id, discard });
  state.docs.delete(id);
  const i = state.order.indexOf(id);
  state.order.splice(i, 1);
  if (state.active === id) state.active = state.order[Math.min(i, state.order.length - 1)] ?? null;
  if (!state.active) await newDocument();
  render();
}

function cycleTab(dir) {
  if (state.order.length < 2) return;
  const i = state.order.indexOf(state.active);
  state.active = state.order[(i + dir + state.order.length) % state.order.length];
  render();
}

// ----- crash recovery --------------------------------------------------------

async function checkRecovery() {
  const items = await invoke('list_recoverable');
  const box = $('recovery');
  if (!items.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = '<strong>Da Capo closed unexpectedly.</strong> Unsaved work was recovered:' +
    items.map((r) => {
      const m = r.manifest;
      const name = m ? m.display_name : 'Unknown document';
      const when = m ? new Date(m.updated_ms).toLocaleString() : '';
      return `<div class="item" data-sid="${r.session_id}">
        <span>${esc(name)} <span style="color:var(--muted)">${esc(when)}</span></span>
        <button data-recover>Restore</button><button data-discard>Discard</button></div>`;
    }).join('');
  box.onclick = (ev) => serial(async () => {
    const item = ev.target.closest('.item');
    if (!item) return;
    const sid = item.dataset.sid;
    if (ev.target.matches('[data-recover]')) {
      const v = adopt(await invoke('recover_document', { sessionId: sid }));
      state.active = v.id;
      item.remove();
    } else if (ev.target.matches('[data-discard]')) {
      const sure = await dialog.ask('Delete this recovered work permanently?', {
        title: 'Da Capo', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Keep',
      });
      if (!sure) return;
      await invoke('discard_recoverable', { sessionId: sid });
      item.remove();
    }
    if (!box.querySelector('.item')) box.hidden = true;
    render();
  });
}

// ----- rendering -------------------------------------------------------------

function render() {
  renderTabs();
  const doc = active();
  if (!doc) return;
  const scoreEl = $('score');
  const width = scoreEl.clientWidth || 1000;
  const { svg, layout } = renderScore(doc, width);
  scoreEl.innerHTML = svg;
  state.layout = layout;
  syncControls(doc);
  renderStatus();
  scrollCaretIntoView();
}

function renderTabs() {
  $('tabs').innerHTML = state.order.map((id) => {
    const d = state.docs.get(id);
    return `<div class="tab${id === state.active ? ' active' : ''}" role="tab" data-id="${id}" title="${esc(d.path || d.name)}">
      <span>${esc(d.name)}</span>${d.dirty ? '<span class="dirty" title="Unsaved changes">●</span>' : ''}
      <button class="x" data-close="${id}" aria-label="Close ${esc(d.name)}">×</button></div>`;
  }).join('');
}

function syncControls(doc) {
  const caret = doc.caret;
  const attrs = doc.score.measures[caret.measure];
  const staff = doc.score.staves[caret.staff];
  document.querySelector('[data-cmd=undo]').disabled = !doc.can_undo;
  document.querySelector('[data-cmd=redo]').disabled = !doc.can_redo;
  document.querySelectorAll('[data-dur]').forEach((b) => b.classList.toggle('on', b.dataset.dur === state.duration.base));
  document.querySelector('[data-cmd=dot]').classList.toggle('on', state.duration.dots > 0);
  document.querySelectorAll('[data-voice]').forEach((b) => b.classList.toggle('on', Number(b.dataset.voice) === caret.voice));
  if (document.activeElement !== $('clef')) $('clef').value = staff.clef;
  if (document.activeElement !== $('key')) $('key').value = String(attrs.key.fifths);
  if (document.activeElement !== $('time')) $('time').value = `${attrs.time.beats}/${attrs.time.beat_type}`;
  if (document.activeElement !== $('title')) $('title').value = doc.score.metadata.title;
  if (document.activeElement !== $('composer')) $('composer').value = doc.score.metadata.composer;
}

function renderStatus() {
  const doc = active();
  const parts = [];
  if (doc) {
    const c = doc.caret;
    parts.push(`Staff ${c.staff + 1} · Measure ${c.measure + 1} · Voice ${c.voice + 1}`);
    const d = state.duration;
    parts.push(`Note value: ${d.base}${d.dots ? ' dotted' : ''}`);
    parts.push(doc.dirty ? 'Unsaved changes' : (doc.path ? 'Saved' : 'New document'));
    parts.push(doc.protected
      ? '<span class="ok" title="Every change is journaled; work survives a crash or power cut">● Recovery on</span>'
      : '<span class="warn">● Recovery unavailable</span>');
    const over = doc.issues.filter((i) => i.type === 'overfull').length;
    if (over) parts.push(`<span class="warn">${over} overfull measure${over > 1 ? 's' : ''}</span>`);
    if (doc.warning) parts.push(`<span class="warn">${esc(doc.warning)}</span>`);
  }
  if (state.error) parts.push(`<span class="warn">${esc(state.error)}</span>`);
  $('status').innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
}

function scrollCaretIntoView() {
  const caret = $('score').querySelector('.caret');
  if (!caret) return;
  const r = caret.getBoundingClientRect();
  const p = page.getBoundingClientRect();
  if (r.top < p.top + 40 || r.bottom > p.bottom - 40) {
    page.scrollBy({ top: r.top - p.top - p.height / 3 });
  }
}

// ----- input -----------------------------------------------------------------

function setDuration(base) {
  state.duration = { base, dots: 0 };
  const doc = active();
  if (doc && doc.selection) act({ type: 'set_duration', duration: state.duration });
  else render();
}

function setVoice(voice) {
  const doc = active();
  if (!doc) return;
  act({ type: 'set_caret', caret: { ...doc.caret, voice, index: 0 }, extend: false });
}

document.addEventListener('keydown', (ev) => {
  const t = ev.target;
  const inField = t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
  const ctrl = ev.ctrlKey || ev.metaKey;
  const key = ev.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;

  // Shortcuts that work everywhere.
  if (ctrl && !ev.altKey) {
    const handled = {
      s: () => serial(() => saveDocument(ev.shiftKey)),
      o: () => serial(openDocument),
      n: () => serial(newDocument),
      w: () => serial(() => closeDocument(state.active)),
      tab: () => cycleTab(ev.shiftKey ? -1 : 1),
    }[lower === 'Tab' ? 'tab' : lower];
    if (handled) {
      ev.preventDefault();
      handled();
      return;
    }
  }
  if (inField) {
    if (key === 'Escape') { t.blur(); page.focus(); }
    return;
  }
  if (!active()) return;

  const run = (action) => { ev.preventDefault(); act(action); };

  if (ctrl) {
    switch (lower) {
      case 'z': return run({ type: ev.shiftKey ? 'redo' : 'undo' });
      case 'y': return run({ type: 'redo' });
      case 'a': return run({ type: 'select_all' });
      case 'c': return run({ type: 'copy' });
      case 'x': return run({ type: 'cut' });
      case 'v': return run({ type: 'paste' });
      case 'Enter': return run({ type: 'insert_measure' });
      case 'ArrowLeft': return run({ type: 'move', to: 'prev_measure', extend: ev.shiftKey });
      case 'ArrowRight': return run({ type: 'move', to: 'next_measure', extend: ev.shiftKey });
      case 'Home': return run({ type: 'move', to: 'score_start', extend: ev.shiftKey });
      case 'End': return run({ type: 'move', to: 'score_end', extend: ev.shiftKey });
    }
    if (!ev.altKey) return;
  }

  if (ev.altKey) {
    if (key === 'ArrowUp') return run({ type: 'transpose', steps: ctrl ? 7 : 1 });
    if (key === 'ArrowDown') return run({ type: 'transpose', steps: ctrl ? -7 : -1 });
    if (/^[1-4]$/.test(key)) { ev.preventDefault(); return setVoice(Number(key) - 1); }
    return;
  }

  switch (key) {
    case 'ArrowLeft': return run({ type: 'move', to: 'left', extend: ev.shiftKey });
    case 'ArrowRight': return run({ type: 'move', to: 'right', extend: ev.shiftKey });
    case 'ArrowUp': return run({ type: 'move', to: 'up', extend: ev.shiftKey });
    case 'ArrowDown': return run({ type: 'move', to: 'down', extend: ev.shiftKey });
    case 'Home': return run({ type: 'move', to: 'measure_start', extend: ev.shiftKey });
    case 'End': return run({ type: 'move', to: 'measure_end', extend: ev.shiftKey });
    case 'Backspace': return run({ type: 'delete_backward' });
    case 'Delete': return run({ type: 'delete_forward' });
    case '+': return run({ type: 'accidental', delta: 1 });
    case '-': return run({ type: 'accidental', delta: -1 });
    case '.':
      ev.preventDefault();
      state.duration = { ...state.duration, dots: state.duration.dots ? 0 : 1 };
      if (active().selection) act({ type: 'set_duration', duration: state.duration });
      else render();
      return;
  }
  if (/^[a-g]$/i.test(key)) {
    const step = key.toUpperCase();
    return run(ev.shiftKey ? { type: 'add_to_chord', step } : { type: 'insert_note', step, duration: state.duration });
  }
  if (lower === 'r' || key === '0') return run({ type: 'insert_rest', duration: state.duration });
  if (DURATION_KEYS[key]) { ev.preventDefault(); setDuration(DURATION_KEYS[key]); }
});

// Click to place the caret, Shift+click or drag to select.
let dragging = false;
let lastHit = '';
function caretFromMouse(ev) {
  const doc = active();
  if (!doc || !state.layout) return null;
  const svg = $('score').querySelector('svg');
  const r = svg.getBoundingClientRect();
  return hitTest(state.layout, doc, ev.clientX - r.left, ev.clientY - r.top, doc.caret.voice);
}
$('score').addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  const caret = caretFromMouse(ev);
  if (!caret) return;
  ev.preventDefault();
  page.focus();
  dragging = true;
  lastHit = JSON.stringify(caret);
  act({ type: 'set_caret', caret, extend: ev.shiftKey });
});
window.addEventListener('mousemove', (ev) => {
  if (!dragging) return;
  const caret = caretFromMouse(ev);
  const key = JSON.stringify(caret);
  if (!caret || key === lastHit) return;
  lastHit = key;
  act({ type: 'set_caret', caret, extend: true });
});
window.addEventListener('mouseup', () => { dragging = false; });

// Toolbar.
document.querySelector('.toolbar').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.dataset.dur) setDuration(b.dataset.dur);
  else if (b.dataset.voice) setVoice(Number(b.dataset.voice));
  else ({
    new: () => serial(newDocument),
    open: () => serial(openDocument),
    save: () => serial(() => saveDocument()),
    undo: () => act({ type: 'undo' }),
    redo: () => act({ type: 'redo' }),
    dot: () => { state.duration = { ...state.duration, dots: state.duration.dots ? 0 : 1 }; render(); },
    rest: () => act({ type: 'insert_rest', duration: state.duration }),
    'add-measure': () => act({ type: 'insert_measure' }),
    'remove-measure': () => act({ type: 'remove_measure' }),
    'add-staff': () => act({ type: 'add_staff', clef: 'treble' }),
    'remove-staff': () => act({ type: 'remove_staff' }),
  })[b.dataset.cmd]?.();
  page.focus();
});

$('key').innerHTML = KEY_NAMES.map((n, i) => `<option value="${i - 7}">${n} major</option>`).join('');
$('key').addEventListener('change', (ev) => { act({ type: 'set_key', fifths: Number(ev.target.value) }); page.focus(); });
$('clef').addEventListener('change', (ev) => { act({ type: 'set_clef', clef: ev.target.value }); page.focus(); });
$('time').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const m = ev.target.value.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  if (!m) { showError('Time signature must look like 3/4'); return; }
  act({ type: 'set_time', beats: Number(m[1]), beat_type: Number(m[2]) });
  page.focus();
});
for (const id of ['title', 'composer']) {
  $(id).addEventListener('change', () => act({ type: 'set_metadata', title: $('title').value, composer: $('composer').value }));
  $(id).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.target.blur(); page.focus(); } });
}

$('tabs').addEventListener('click', (ev) => {
  const close = ev.target.closest('[data-close]');
  if (close) { serial(() => closeDocument(close.dataset.close)); return; }
  const tab = ev.target.closest('.tab');
  if (tab) { state.active = tab.dataset.id; render(); page.focus(); }
});

window.addEventListener('resize', () => render());

// Closing the window with unsaved work.
tauri.event.listen('close-requested', async ({ payload }) => {
  const names = payload.map((n) => `“${n}”`).join(', ');
  const quit = await dialog.ask(`You have unsaved changes in ${names}.\n\nQuit and discard them?`, {
    title: 'Da Capo', kind: 'warning', okLabel: 'Quit without saving', cancelLabel: 'Cancel',
  });
  if (quit) await invoke('quit');
});

// ----- start -----------------------------------------------------------------

serial(async () => {
  await checkRecovery();
  for (const tab of await invoke('list_documents')) adopt(await invoke('get_document', { id: tab.id }));
  if (state.order.length) state.active = state.order[0];
  else await newDocument();
  render();
  page.focus();
});
