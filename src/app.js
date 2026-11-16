// Da Capo frontend. Owns no musical state: every edit is sent to Rust,
// which answers with the full document view to redraw.

import { renderScore, hitTest, pointerTarget, ghostMarkup, esc } from './render.js';
import { installTooltips } from './tooltip.js';

const tauri = window.__TAURI__;
const invoke = tauri.core.invoke;
const dialog = tauri.dialog;

const FILTERS = [{ name: 'Da Capo score', extensions: ['dacapo'] }];
const KEY_NAMES = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
const DURATION_KEYS = { 1: 'SixtyFourth', 2: 'ThirtySecond', 3: 'Sixteenth', 4: 'Eighth', 5: 'Quarter', 6: 'Half', 7: 'Whole' };

// Small per-user view preferences. Storage may be unavailable; fall back
// to defaults silently.
function loadPref(name, fallback) {
  try {
    const v = localStorage.getItem(`dacapo.${name}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function savePref(name, value) {
  try { localStorage.setItem(`dacapo.${name}`, JSON.stringify(value)); } catch { /* ignore */ }
}

const state = {
  docs: new Map(), // id -> DocView
  order: [], // tab order
  active: null,
  duration: { base: 'Quarter', dots: 0 },
  // 'select': click places the caret / drag selects.
  // 'note' / 'rest': the pointer carries the chosen figure; click places it.
  mode: 'select',
  // Palette switch: whether the figures are notes or rests.
  kind: 'note',
  // View preference (per user, not saved in the document).
  multiRest: loadPref('multiRest', true),
  pointer: null, // last mouse position over the score, for the ghost figure
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
  const { svg, layout } = renderScore(doc, width, { multiRest: state.multiRest });
  scoreEl.innerHTML = svg;
  state.layout = layout;
  scoreEl.classList.toggle('entry', state.mode !== 'select');
  drawGhost();
  syncControls(doc);
  renderStatus();
  scrollCaretIntoView();
}

// ----- mouse entry mode ------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  render();
}

function currentTarget() {
  const doc = active();
  if (!doc || !state.layout || !state.pointer || state.mode === 'select') return null;
  const svg = $('score').querySelector('svg');
  if (!svg) return null;
  const r = svg.getBoundingClientRect();
  return pointerTarget(state.layout, doc, state.pointer.x - r.left, state.pointer.y - r.top, doc.caret.voice);
}

/** Draws the figure the pointer is carrying (or removes it). */
function drawGhost() {
  const scoreEl = $('score');
  const svg = scoreEl.querySelector('svg');
  if (!svg) return;
  svg.querySelector('.ghost')?.remove();
  const target = currentTarget();
  scoreEl.classList.toggle('over', !!target);
  if (!target) return;
  const voice = active().caret.voice;
  svg.insertAdjacentHTML('beforeend', ghostMarkup(target, state.duration, state.mode === 'rest')
    .replace('class="ghost"', `class="ghost v${voice}"`));
}

function placeAtPointer() {
  const t = currentTarget();
  if (!t) return false;
  const at = { staff: t.staff, measure: t.measure, voice: t.voice, index: t.index };
  if (state.mode === 'rest') {
    act({ type: 'place_rest', at, duration: state.duration });
  } else if (t.onEvent !== null) {
    act({ type: 'add_pitch', at: { ...at, index: t.onEvent }, step: t.step, octave: t.octave });
  } else {
    act({ type: 'place_note', at, step: t.step, octave: t.octave, duration: state.duration });
  }
  return true;
}

function renderTabs() {
  $('tabs').innerHTML = state.order.map((id) => {
    const d = state.docs.get(id);
    return `<div class="tab${id === state.active ? ' active' : ''}" role="tab" data-id="${id}" data-tip="${esc(d.name)}" data-desc="${esc(d.path || 'Not saved yet')}${d.dirty ? ' · unsaved changes' : ''}">
      <span>${esc(d.name)}</span>${d.dirty ? '<span class="dirty" aria-label="Unsaved changes">●</span>' : ''}
      <button class="x" data-close="${id}" aria-label="Close ${esc(d.name)}">×</button></div>`;
  }).join('');
}

function syncControls(doc) {
  const caret = doc.caret;
  const attrs = doc.score.measures[caret.measure];
  const staff = doc.score.staves[caret.staff];
  document.querySelector('[data-cmd=undo]').disabled = !doc.can_undo;
  document.querySelector('[data-cmd=redo]').disabled = !doc.can_redo;
  document.querySelectorAll('[data-dur]').forEach((b) => {
    b.textContent = b.dataset[state.kind];
    b.dataset.tip = `${b.dataset.name} ${state.kind}`;
    b.dataset.desc = 'Choose it, then click on a staff to place it. With a selection, changes its note values.';
    b.setAttribute('aria-label', b.dataset.tip);
    b.classList.toggle('on', b.dataset.dur === state.duration.base);
  });
  document.querySelectorAll('[data-kind]').forEach((b) => {
    b.classList.toggle('on', b.dataset.kind === state.kind);
    b.setAttribute('aria-checked', String(b.dataset.kind === state.kind));
  });
  document.querySelector('[data-cmd=select]').classList.toggle('on', state.mode === 'select');
  document.querySelector('.figures').classList.toggle('placing', state.mode !== 'select');
  document.querySelector('[data-cmd=dot]').classList.toggle('on', state.duration.dots > 0);
  const mr = document.querySelector('[data-cmd=multirest]');
  mr.classList.toggle('on', state.multiRest);
  mr.setAttribute('aria-pressed', String(state.multiRest));
  renderVoices(doc);
  if (document.activeElement !== $('clef')) $('clef').value = staff.clef;
  if (document.activeElement !== $('key')) $('key').value = String(attrs.key.fifths);
  if (document.activeElement !== $('time')) $('time').value = `${attrs.time.beats}/${attrs.time.beat_type}`;
  if (document.activeElement !== $('title')) $('title').value = doc.score.metadata.title;
  if (document.activeElement !== $('composer')) $('composer').value = doc.score.metadata.composer;
}

/** Number of voices to offer: those that contain music, plus the caret's. */
function voiceCount(doc) {
  let used = 1;
  for (const staff of doc.score.staves) {
    for (const m of staff.measures) {
      m.voices.forEach((v, i) => { if (v.length) used = Math.max(used, i + 1); });
    }
  }
  return Math.max(used, doc.caret.voice + 1);
}

// Voices appear only when the user asks for them (e.g. divisi strings).
function renderVoices(doc) {
  const n = voiceCount(doc);
  const current = doc.caret.voice;
  let html = n === 1
    ? '<span class="label">Single voice</span>'
    : Array.from({ length: n }, (_, v) =>
      `<button data-voice="${v}" class="${v === current ? 'on' : ''}" data-tip="Voice ${v + 1}" data-desc="Write in this voice. Each voice has its own color." data-key="Alt+${v + 1}">${v + 1}</button>`).join('');
  if (n < 4) html += `<button data-voice="${n}" class="add" data-tip="Add voice ${n + 1}" data-desc="A second independent line on the same staff, e.g. divisi strings or two melodies in one hand." data-key="Alt+${n + 1}">+ Voice</button>`;
  $('voices').innerHTML = html;
}

/** Measures that break the time signature, in score order. */
function measureErrors(doc) {
  const seen = new Set();
  return doc.issues
    .filter((i) => i.type === 'overfull')
    .filter((i) => !seen.has(`${i.staff}:${i.measure}`) && seen.add(`${i.staff}:${i.measure}`))
    .sort((a, b) => a.measure - b.measure || a.staff - b.staff);
}

function renderStatus() {
  const doc = active();
  const parts = [];
  if (doc) {
    const c = doc.caret;
    const voice = voiceCount(doc) > 1 ? ` · Voice ${c.voice + 1}` : '';
    parts.push(`Staff ${c.staff + 1} · Measure ${c.measure + 1}${voice}`);
    const d = state.duration;
    const value = `${d.dots ? 'dotted ' : ''}${d.base.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`;
    parts.push({
      select: `Select tool · next value: ${value}`,
      note: `<b>Placing ${value} notes</b> — click a line or space · click a note to add to its chord · Esc to stop`,
      rest: `<b>Placing ${value} rests</b> — click to place · Esc to stop`,
    }[state.mode]);
    parts.push(doc.dirty ? 'Unsaved changes' : (doc.path ? 'Saved' : 'New document'));
    parts.push(doc.protected
      ? '<span class="ok" data-tip="Crash recovery is on" data-desc="Every change is written to disk within half a second; your work survives a crash or power cut.">● Recovery on</span>'
      : '<span class="warn">● Recovery unavailable</span>');
    const errors = measureErrors(doc);
    if (errors.length) {
      parts.push(`<span class="errors" data-jump data-tip="Measures with errors" data-desc="Click to jump to the next one.">⚠ ${errors.length} measure${errors.length > 1 ? 's' : ''} with errors</span>`);
    }
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

function setDuration(base, enterMode = false) {
  state.duration = { base, dots: 0 };
  if (enterMode) state.mode = state.kind;
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
    case 'Escape': ev.preventDefault(); return setMode('select');
    case 'n': case 'N': ev.preventDefault(); return setMode(state.mode === 'select' ? 'note' : 'select');
    case 't': case 'T': return run({ type: 'toggle_tie' });
    case 's': case 'S': return run({ type: 'toggle_slur' });
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
  if (state.mode !== 'select') {
    // Entry mode: the click places the figure the pointer carries.
    state.pointer = { x: ev.clientX, y: ev.clientY };
    ev.preventDefault();
    page.focus();
    placeAtPointer();
    return;
  }
  const caret = caretFromMouse(ev);
  if (!caret) return;
  ev.preventDefault();
  page.focus();
  dragging = true;
  lastHit = JSON.stringify(caret);
  act({ type: 'set_caret', caret, extend: ev.shiftKey });
});
$('score').addEventListener('mousemove', (ev) => {
  if (state.mode === 'select') return;
  state.pointer = { x: ev.clientX, y: ev.clientY };
  drawGhost();
});
$('score').addEventListener('mouseleave', () => {
  state.pointer = null;
  drawGhost();
});
// Right-click leaves entry mode, like dropping the tool.
$('score').addEventListener('contextmenu', (ev) => {
  if (state.mode === 'select') return;
  ev.preventDefault();
  setMode('select');
});
// The ghost must follow the page when it scrolls under a still mouse.
page.addEventListener('scroll', () => { if (state.mode !== 'select') drawGhost(); });
window.addEventListener('mousemove', (ev) => {
  if (!dragging) return;
  const caret = caretFromMouse(ev);
  const key = JSON.stringify(caret);
  if (!caret || key === lastHit) return;
  lastHit = key;
  act({ type: 'set_caret', caret, extend: true });
});
window.addEventListener('mouseup', () => { dragging = false; });

// Notes/rests switch: swaps the figures; keeps placing if already placing.
function setKind(kind) {
  state.kind = kind;
  if (state.mode !== 'select') state.mode = kind;
  render();
}

// Status bar: jump to the next measure with errors after the caret.
$('status').addEventListener('click', (ev) => {
  if (!ev.target.closest('[data-jump]')) return;
  const doc = active();
  const errors = measureErrors(doc);
  const c = doc.caret;
  const next = errors.find((e) => e.measure > c.measure || (e.measure === c.measure && e.staff > c.staff)) || errors[0];
  if (next) act({ type: 'set_caret', caret: { staff: next.staff, measure: next.measure, voice: next.voice, index: 0 }, extend: false });
  page.focus();
});

// Toolbar and palette.
const onControlClick = (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.dataset.dur) setDuration(b.dataset.dur, true);
  else if (b.dataset.voice) setVoice(Number(b.dataset.voice));
  else if (b.dataset.kind) setKind(b.dataset.kind);
  else if (b.dataset.alter) act({ type: 'set_accidental', alter: Number(b.dataset.alter) });
  else if (b.dataset.artic) act({ type: 'toggle_articulation', articulation: b.dataset.artic });
  else if (b.dataset.dyn) act({ type: 'set_dynamic', dynamic: b.dataset.dyn });
  else ({
    select: () => setMode('select'),
    tie: () => act({ type: 'toggle_tie' }),
    slur: () => act({ type: 'toggle_slur' }),
    new: () => serial(newDocument),
    open: () => serial(openDocument),
    save: () => serial(() => saveDocument()),
    undo: () => act({ type: 'undo' }),
    redo: () => act({ type: 'redo' }),
    dot: () => { state.duration = { ...state.duration, dots: state.duration.dots ? 0 : 1 }; render(); },
    multirest: () => { state.multiRest = !state.multiRest; savePref('multiRest', state.multiRest); render(); },
    'add-measure': () => act({ type: 'insert_measure' }),
    'remove-measure': () => act({ type: 'remove_measure' }),
    'add-staff': () => act({ type: 'add_staff', clef: 'treble' }),
    'remove-staff': () => act({ type: 'remove_staff' }),
  })[b.dataset.cmd]?.();
  page.focus();
};
document.querySelector('.toolbar').addEventListener('click', onControlClick);
$('palette').addEventListener('click', onControlClick);

installTooltips();

// Palette sections: remember which ones the user keeps open.
for (const d of document.querySelectorAll('.palette details')) {
  const name = `palette.${d.dataset.section}`;
  d.open = loadPref(name, d.open);
  d.addEventListener('toggle', () => savePref(name, d.open));
}

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
  // Draw only once the music font is ready, or the first frame would use
  // fallback glyphs in the wrong places.
  try { await document.fonts.load('40px Bravura', ''); } catch { /* render anyway */ }
  await checkRecovery();
  for (const tab of await invoke('list_documents')) adopt(await invoke('get_document', { id: tab.id }));
  if (state.order.length) state.active = state.order[0];
  else await newDocument();
  render();
  page.focus();
});
