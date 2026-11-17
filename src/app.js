// Partita frontend. Owns no musical state: every edit is sent to Rust,
// which answers with the full document view to redraw.

import {
  SP, renderScore, hitTest, pointerTarget, ghostMarkup, clientToLayout, layoutToClient, playheadMarkup, esc, eraserTarget, eventsInBox,
  lyricTarget, LYRIC_PX, LYRIC_FONT, MAX_VERSES,
} from './render.js';
import { installTooltips } from './tooltip.js';
import { installMenuBar } from './menu.js';

const tauri = window.__TAURI__;
const invoke = tauri.core.invoke;
const dialog = tauri.dialog;

const FILTERS = [{ name: 'Partita score', extensions: ['partita'] }];
// Opening also accepts scores saved under the project's former name, Da Capo.
const OPEN_FILTERS = [{ name: 'Partita score', extensions: ['partita', 'dacapo'] }];
const KEY_NAMES = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
const DURATION_KEYS = { 1: 'SixtyFourth', 2: 'ThirtySecond', 3: 'Sixteenth', 4: 'Eighth', 5: 'Quarter', 6: 'Half', 7: 'Whole' };
// Only with View → Breve and 128th Notes on.
const EXTENDED_KEYS = { 8: 'Breve', 9: 'HundredTwentyEighth' };
const VALUE_NAMES = { Breve: 'breve', HundredTwentyEighth: '128th', SixtyFourth: '64th', ThirtySecond: '32nd', Sixteenth: '16th' };

// Small per-user view preferences. Storage may be unavailable; fall back
// to defaults silently.
function loadPref(name, fallback) {
  try {
    const v = localStorage.getItem(`partita.${name}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function savePref(name, value) {
  try { localStorage.setItem(`partita.${name}`, JSON.stringify(value)); } catch { /* ignore */ }
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
  extendedValues: loadPref('extendedValues', false), // breve, 64th and 128th in the palette
  view: loadPref('view', 'page'), // 'page' | 'wrap' | 'continuous'
  paper: loadPref('paper', 'a4'), // 'a4' | 'letter'
  theme: loadPref('theme', 'system'), // 'system' | 'light' | 'dark'
  zoom: loadPref('zoom', 1), // 0.25 … 4
  pointer: null, // last mouse position over the score, for the ghost figure
  lyric: null, // { id, verse, staff }: the syllable being typed (see "lyrics")
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
  const path = await dialog.open({ multiple: false, filters: OPEN_FILTERS });
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
    path = await dialog.save({ filters: FILTERS, defaultPath: `${doc.name}.partita` });
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
      title: 'Partita', kind: 'warning', okLabel: 'Save', cancelLabel: 'Don’t save',
    });
    if (save) {
      if (!(await saveDocument())) return;
    } else {
      const sure = await dialog.ask(`Close “${doc.name}” and lose the unsaved changes?`, {
        title: 'Partita', kind: 'warning', okLabel: 'Discard changes', cancelLabel: 'Keep editing',
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
  box.innerHTML = '<strong>Partita closed unexpectedly.</strong> Unsaved work was recovered:' +
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
        title: 'Partita', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Keep',
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
  const meta = $('meta');
  // The title/composer block is re-attached on every render: inside page 1
  // in page view, above the music otherwise.
  scoreEl.before(meta);
  meta.removeAttribute('style');
  document.body.dataset.view = state.view;
  // At zoom z the wrap view lays out for width/z so it still fills the window.
  const width = (scoreEl.clientWidth || 1000) / state.zoom;
  const { pages, layout, hits, slots } = renderScore(doc, width, {
    multiRest: state.multiRest, view: state.view, paper: state.paper, zoom: state.zoom, lyricEdit: lyricEdit(doc),
  });
  if (layout.mode === 'page') {
    scoreEl.innerHTML = pages.map((svg, i) => {
      const p = layout.pages[i];
      return `<div class="paper" style="width:${p.w * state.zoom}px">${svg}</div>`;
    }).join('');
    placeTitleOnPage(meta, scoreEl.querySelector('.paper'), layout);
  } else {
    scoreEl.innerHTML = pages[0];
  }
  state.layout = layout;
  state.hits = hits;
  state.slots = slots;
  placeLyricInput();
  scoreEl.classList.toggle('entry', entering());
  scoreEl.classList.toggle('erasing', state.mode === 'erase');
  scoreEl.classList.toggle('marking', state.mode === 'mark');
  drawGhost();
  drawPlayhead();
  syncControls(doc);
  renderStatus();
  scrollCaretIntoView();
}

/** Puts the editable title block inside the top margin of page 1, scaled with the page. */
function placeTitleOnPage(meta, paper, layout) {
  const { geo } = layout;
  const scale = paper.clientWidth / geo.w;
  paper.append(meta);
  Object.assign(meta.style, {
    position: 'absolute',
    left: `${geo.margin * scale}px`,
    top: `${geo.margin * scale}px`,
    width: `${geo.w - 2 * geo.margin}px`,
    transform: `scale(${scale})`,
    transformOrigin: 'top left',
  });
}

/** Mouse position in layout coordinates (through whichever page is under it). */
function pointerInLayout(clientX, clientY) {
  if (!state.layout) return null;
  return clientToLayout(state.layout, $('score'), clientX, clientY);
}

/**
 * Centres a Bravura glyph vertically in its button from the glyph's own ink,
 * measured with canvas. SMuFL glyphs hang from a baseline at very different
 * heights (a 128th note's stem and flags reach far above it, a whole note
 * barely leaves it), so one fixed offset cannot fit them all. With
 * `line-height: 0` the baseline sits at the top of the content box, so the
 * top padding is exactly where the baseline goes.
 */
const glyphCtx = document.createElement('canvas').getContext('2d');
function fitGlyph(button) {
  const style = getComputedStyle(button);
  glyphCtx.font = `${style.fontSize} Bravura`;
  const m = glyphCtx.measureText(button.textContent);
  const ink = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const height = button.offsetHeight || 40;
  button.style.paddingTop = `${Math.round((height - ink) / 2 + m.actualBoundingBoxAscent)}px`;
}

// ----- mouse entry mode ------------------------------------------------------

/** Is the pointer carrying a note or rest (as opposed to Select or the eraser)? */
const entering = () => state.mode === 'note' || state.mode === 'rest';

function setMode(mode) {
  state.mode = mode;
  if (mode !== 'mark') {
    state.mark = null;
    markCursor.style.display = 'none';
  }
  render();
}

// ----- placing marks with the mouse ----------------------------------------------
// Accidentals, articulations and dynamics: with a selection, a palette button
// applies at once (as before). Without one, the pointer takes the mark and
// each click on a note applies it, until Esc, a right-click or another tool.

const markKey = (b) => (b.dataset.alter ? `alter:${b.dataset.alter}` : b.dataset.artic ? `artic:${b.dataset.artic}` : `dyn:${b.dataset.dyn}`);
const markCursor = Object.assign(document.createElement('div'), { className: 'mark-cursor glyph' });
document.body.append(markCursor);

function useMark(b) {
  if (active()?.selection) {
    if (b.dataset.alter) act({ type: 'set_accidental', alter: Number(b.dataset.alter) });
    else if (b.dataset.artic) act({ type: 'toggle_articulation', articulation: b.dataset.artic });
    else act({ type: 'set_dynamic', dynamic: b.dataset.dyn });
    return;
  }
  const key = markKey(b);
  if (state.mode === 'mark' && state.mark?.key === key) { setMode('select'); return; }
  state.mark = { key, glyph: b.textContent, name: b.dataset.tip, alter: b.dataset.alter, artic: b.dataset.artic, dyn: b.dataset.dyn };
  markCursor.textContent = b.textContent;
  setMode('mark');
}

/** Where an event is: { staff, measure, voice, index }, or null. */
function locateEvent(doc, id) {
  const staves = doc.score.staves;
  for (let staff = 0; staff < staves.length; staff++) {
    for (let measure = 0; measure < staves[staff].measures.length; measure++) {
      const voices = staves[staff].measures[measure].voices;
      for (let voice = 0; voice < voices.length; voice++) {
        const index = voices[voice].findIndex((e) => e.id === id);
        if (index >= 0) return { staff, measure, voice, index };
      }
    }
  }
  return null;
}

/** The note (or, for a fermata or dynamic, the rest) the armed mark would go on. */
function markTarget(ev) {
  const p = pointerInLayout(ev.clientX, ev.clientY);
  const t = p && eraserTarget(state.hits || [], p.x, p.y);
  if (!t) return null;
  if (t.rest && state.mark.alter !== undefined) return null;
  if (t.rest && state.mark.artic && state.mark.artic !== 'fermata') return null;
  return t;
}

function placeMark(t) {
  const m = state.mark;
  if (m.alter !== undefined) {
    act({ type: 'set_accidental_at', id: t.id, pitch: t.pitch, alter: Number(m.alter) });
    return;
  }
  const at = locateEvent(active(), t.id);
  if (!at) return;
  // Marks go on the event before the caret: put the caret right after it.
  act({ type: 'set_caret', caret: { ...at, index: at.index + 1 }, extend: false });
  act(m.artic ? { type: 'toggle_articulation', articulation: m.artic } : { type: 'set_dynamic', dynamic: m.dyn });
}

function highlightMarkable(id) {
  const scoreEl = $('score');
  scoreEl.querySelectorAll('.mark-hover').forEach((g) => g.classList.remove('mark-hover'));
  if (id !== undefined) scoreEl.querySelectorAll(`g[data-id="${id}"]`).forEach((g) => g.classList.add('mark-hover'));
}

function currentTarget() {
  const doc = active();
  if (!doc || !state.layout || !state.pointer || !entering()) return null;
  const p = pointerInLayout(state.pointer.x, state.pointer.y);
  return p && pointerTarget(state.layout, doc, p.x, p.y, doc.caret.voice);
}

/** Draws the figure the pointer is carrying (or removes it). */
function drawGhost() {
  const scoreEl = $('score');
  scoreEl.querySelectorAll('.ghost').forEach((g) => g.remove());
  const target = currentTarget();
  scoreEl.classList.toggle('over', !!target);
  if (!target) return;
  const svg = scoreEl.querySelector(`svg[data-page="${target.page}"]`);
  if (!svg) return;
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
    if (b.textContent !== b.dataset[state.kind]) {
      b.textContent = b.dataset[state.kind];
      fitGlyph(b);
    }
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
  document.querySelector('[data-cmd=erase]').classList.toggle('on', state.mode === 'erase');
  document.querySelectorAll('[data-alter], [data-artic], [data-dyn]').forEach((b) => {
    b.classList.toggle('armed', state.mode === 'mark' && state.mark?.key === markKey(b));
  });
  document.querySelector('.figures').classList.toggle('placing', entering());
  document.querySelector('[data-cmd=dot]').classList.toggle('on', state.duration.dots > 0);
  const mr = document.querySelector('[data-cmd=multirest]');
  mr.classList.toggle('on', state.multiRest);
  mr.setAttribute('aria-pressed', String(state.multiRest));
  renderVoices(doc);
  if (document.activeElement !== $('clef')) $('clef').value = staff.clef;
  if (document.activeElement !== $('key')) $('key').value = String(attrs.key.fifths);
  if (document.activeElement !== $('time')) $('time').value = `${attrs.time.beats}/${attrs.time.beat_type}`;
  if (document.activeElement !== $('tempo')) $('tempo').value = String(doc.score.tempo ?? 100);
  syncTransport();
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
    const value = `${d.dots ? 'dotted ' : ''}${VALUE_NAMES[d.base] || d.base.toLowerCase()}`;
    parts.push(state.lyric
      ? `<b>Lyrics${state.layout?.verses[state.lyric.staff] > 1 ? ` · verse ${state.lyric.verse + 1}` : ''}</b> — Space: next note · - hyphen · _ hold the syllable · ↓ ↑ verse · Esc to finish`
      : {
        select: `Select tool · next value: ${value}`,
        note: `<b>Placing ${value} notes</b> — click a line or space · click a note to add to its chord · Esc to stop`,
        rest: `<b>Placing ${value} rests</b> — click to place · Esc to stop`,
        erase: '<b>Eraser</b> — click a note, or drag a box · Esc to stop',
        mark: `<b>Placing ${esc(state.mark?.name || '')}</b> — click a note · Esc to stop`,
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
    const s = playback.sound;
    if (s?.state === 'downloading') {
      const pct = s.total ? Math.min(100, Math.floor((s.received / s.total) * 100)) : 0;
      parts.push(`<span class="download" role="status" data-tip="Downloading the FluidR3 GM sounds" data-desc="One-time download. Playback starts by itself when it finishes.">`
        + `Downloading sounds <progress max="100" value="${pct}" aria-label="Download progress"></progress> <b>${pct}%</b> · ${MB(s.received)} / ${MB(s.total)} MB</span>`);
    }
    if (s?.state === 'loading') parts.push('<span class="ok">Loading sounds…</span>');
    const u = updatePart();
    if (u) parts.push(u);
    parts.push(`<span class="zoom" data-zoom data-tip="Zoom ${Math.round(state.zoom * 100)}%" data-desc="Alt + mouse wheel, or Ctrl + = / Ctrl + −. Click to go back to 100%." data-key="Ctrl+0">${Math.round(state.zoom * 100)}%</span>`);
  }
  else {
    const u = updatePart();
    if (u) parts.push(u);
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
  // Continuous view scrolls sideways too.
  if (r.left < p.left + 40 || r.right > p.right - 40) {
    page.scrollBy({ left: r.left - p.left - p.width / 3 });
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
  if (key === 'F1') { ev.preventDefault(); showDialog('shortcuts'); return; }
  if (ctrl && !ev.altKey) {
    const handled = {
      s: () => serial(() => saveDocument(ev.shiftKey)),
      o: () => serial(openDocument),
      n: () => serial(newDocument),
      w: () => serial(() => closeDocument(state.active)),
      p: () => printScore(),
      tab: () => cycleTab(ev.shiftKey ? -1 : 1),
      // Zoom: Ctrl+= / Ctrl++ in, Ctrl+- out, Ctrl+0 actual size.
      '=': () => stepZoom(1),
      '+': () => stepZoom(1),
      '-': () => stepZoom(-1),
      0: () => setZoom(1),
    }[lower === 'Tab' ? 'tab' : lower];
    if (handled) {
      ev.preventDefault();
      // What is being typed as lyrics goes into the document first.
      commitLyric();
      handled();
      return;
    }
    if (lower === 'l') { ev.preventDefault(); runCommand('lyrics'); return; }
  }
  // Menus and dialogs handle their own keys.
  if (t.closest?.('.menubar, dialog')) return;
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
    case 'Escape':
      ev.preventDefault();
      if (playback.playing) return serial(stopPlayback);
      return setMode('select');
    case ' ':
      ev.preventDefault();
      if (ev.shiftKey) return runCommand('play-start');
      return togglePlayback();
    case 'n': case 'N': ev.preventDefault(); return setMode(entering() ? 'select' : 'note');
    case 'x': case 'X': ev.preventDefault(); return setMode(state.mode === 'erase' ? 'select' : 'erase');
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
  const base = DURATION_KEYS[key] || (state.extendedValues && EXTENDED_KEYS[key]);
  if (base) { ev.preventDefault(); setDuration(base); }
});

// Click to place the caret, Shift+click or drag to select.
let dragging = false;
let lastHit = '';
function caretFromMouse(ev) {
  const doc = active();
  if (!doc || !state.layout) return null;
  const p = pointerInLayout(ev.clientX, ev.clientY);
  return p && hitTest(state.layout, doc, p.x, p.y, doc.caret.voice);
}
$('score').addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  if (state.mode === 'mark') {
    ev.preventDefault();
    page.focus();
    const t = markTarget(ev);
    if (t) placeMark(t);
    return;
  }
  if (state.mode === 'erase') {
    // Click: erase what is under the crosshair. Drag: a box (see below).
    const p = pointerInLayout(ev.clientX, ev.clientY);
    ev.preventDefault();
    page.focus();
    if (p) eraser.start = { cx: ev.clientX, cy: ev.clientY, x: p.x, y: p.y, dragged: false };
    return;
  }
  if (entering()) {
    // Entry mode: the click places the figure the pointer carries.
    state.pointer = { x: ev.clientX, y: ev.clientY };
    ev.preventDefault();
    page.focus();
    placeAtPointer();
    return;
  }
  // A click on a line of lyrics (or where the first one would go) types there.
  const words = !ev.shiftKey && lyricUnderPointer(ev);
  if (words) {
    ev.preventDefault();
    commitLyric();
    openLyric(words);
    return;
  }
  const caret = caretFromMouse(ev);
  if (!caret) return;
  ev.preventDefault();
  page.focus();
  // Pressing on a notehead grabs it: dragging up or down changes its pitch.
  // Anywhere else, dragging selects.
  const p = pointerInLayout(ev.clientX, ev.clientY);
  const head = !ev.shiftKey && p && eraserTarget(state.hits || [], p.x, p.y);
  if (head && !head.rest) {
    noteDrag = { id: head.id, pitch: head.pitch, y: p.y, steps: 0 };
  } else {
    dragging = true;
    lastHit = JSON.stringify(caret);
  }
  act({ type: 'set_caret', caret, extend: ev.shiftKey });
});
$('score').addEventListener('mousemove', (ev) => {
  if (state.mode === 'mark') {
    Object.assign(markCursor.style, { display: 'block', left: `${ev.clientX + 14}px`, top: `${ev.clientY - 6}px` });
    highlightMarkable(markTarget(ev)?.id);
    return;
  }
  if (state.mode === 'erase') {
    if (eraser.start) return; // the box drag is followed on window
    const p = pointerInLayout(ev.clientX, ev.clientY);
    const t = p && eraserTarget(state.hits || [], p.x, p.y);
    highlightErasable(t ? [t.id] : []);
    return;
  }
  if (state.mode === 'select') {
    // Show that a notehead can be grabbed.
    const p = !dragging && !noteDrag && pointerInLayout(ev.clientX, ev.clientY);
    const t = p && eraserTarget(state.hits || [], p.x, p.y);
    $('score').classList.toggle('over-note', !!(t && !t.rest));
    drawLyricHover(!dragging && !noteDrag ? lyricUnderPointer(ev) : null);
    return;
  }
  if (!entering()) return;
  state.pointer = { x: ev.clientX, y: ev.clientY };
  drawGhost();
});

// ----- dragging notes ------------------------------------------------------------

let noteDrag = null; // { id, pitch, y, steps } while a notehead is held

/** A pitch moved by diatonic steps (accidental left to the core). */
function shiftedPitch(p, steps) {
  const d = p.octave * 7 + 'CDEFGAB'.indexOf(p.step) + steps;
  return { ...p, step: 'CDEFGAB'[((d % 7) + 7) % 7], octave: Math.floor(d / 7) };
}

window.addEventListener('mousemove', (ev) => {
  if (!noteDrag) return;
  const p = pointerInLayout(ev.clientX, ev.clientY);
  if (!p) return;
  $('score').classList.add('dragging-note');
  // One step per half staff space (a line or a space).
  const steps = Math.round((noteDrag.y - p.y) / (SP / 2));
  const delta = steps - noteDrag.steps;
  if (!delta) return;
  noteDrag.steps = steps;
  act({ type: 'move_pitch', id: noteDrag.id, pitch: noteDrag.pitch, steps: delta });
  if (noteDrag.pitch) noteDrag.pitch = shiftedPitch(noteDrag.pitch, delta);
});
window.addEventListener('mouseup', () => {
  if (!noteDrag) return;
  noteDrag = null;
  $('score').classList.remove('dragging-note');
});
$('score').addEventListener('mouseleave', () => {
  state.pointer = null;
  drawGhost();
  drawLyricHover(null);
  if (!eraser.start) highlightErasable([]);
  markCursor.style.display = 'none';
  highlightMarkable();
});

// ----- eraser ------------------------------------------------------------------

const eraser = {
  start: null, // { cx, cy, x, y, dragged } while the button is down
  box: Object.assign(document.createElement('div'), { className: 'erase-box' }),
};
document.body.append(eraser.box);

/** Marks the events the eraser would remove. */
function highlightErasable(ids) {
  const scoreEl = $('score');
  scoreEl.querySelectorAll('.erase-hover').forEach((g) => g.classList.remove('erase-hover'));
  for (const id of ids) scoreEl.querySelectorAll(`g[data-id="${id}"]`).forEach((g) => g.classList.add('erase-hover'));
}

window.addEventListener('mousemove', (ev) => {
  const s = eraser.start;
  if (!s) return;
  if (!s.dragged && Math.hypot(ev.clientX - s.cx, ev.clientY - s.cy) < 5) return;
  s.dragged = true;
  Object.assign(eraser.box.style, {
    display: 'block',
    left: `${Math.min(s.cx, ev.clientX)}px`,
    top: `${Math.min(s.cy, ev.clientY)}px`,
    width: `${Math.abs(ev.clientX - s.cx)}px`,
    height: `${Math.abs(ev.clientY - s.cy)}px`,
  });
  const p = pointerInLayout(ev.clientX, ev.clientY);
  if (p) highlightErasable(eventsInBox(state.hits || [], s.x, s.y, p.x, p.y));
});
window.addEventListener('mouseup', (ev) => {
  const s = eraser.start;
  if (!s || ev.button !== 0) return;
  eraser.start = null;
  eraser.box.style.display = 'none';
  highlightErasable([]);
  let targets = [];
  if (s.dragged) {
    const p = pointerInLayout(ev.clientX, ev.clientY);
    if (p) targets = eventsInBox(state.hits || [], s.x, s.y, p.x, p.y).map((id) => ({ id, pitch: null }));
  } else {
    const t = eraserTarget(state.hits || [], s.x, s.y);
    if (t) targets = [t];
  }
  if (targets.length) act({ type: 'erase', targets });
});
// Right-click leaves entry mode, like dropping the tool.
$('score').addEventListener('contextmenu', (ev) => {
  if (state.mode === 'select') return;
  ev.preventDefault();
  setMode('select');
});
// ----- scrolling, zoom and panning ---------------------------------------------

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

/**
 * Sets the zoom, keeping the point under the mouse (or the centre of the
 * view) where it is on screen.
 */
function setZoom(z, clientX, clientY) {
  z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
  if (z === state.zoom) return;
  const r = page.getBoundingClientRect();
  const cx = clientX ?? r.left + r.width / 2;
  const cy = clientY ?? r.top + r.height / 2;
  const anchor = pointerInLayout(cx, cy);
  setPref('zoom', z);
  render();
  const now = anchor && layoutToClient(state.layout, $('score'), anchor);
  if (now) {
    page.scrollLeft += now.x - cx;
    page.scrollTop += now.y - cy;
  }
}

/** Zoom so a whole page (or the wrap view's sheet) fits the window width. */
function fitWidth() {
  const avail = page.clientWidth - 48; // .page padding
  const w = state.view === 'page' && state.layout?.geo ? state.layout.geo.w : null;
  setZoom(w ? avail / w : 1);
}

/** Next zoom step up (+1) or down (−1) from the current zoom. */
function stepZoom(dir) {
  const next = dir > 0
    ? ZOOM_STEPS.find((s) => s > state.zoom + 0.001)
    : [...ZOOM_STEPS].reverse().find((s) => s < state.zoom - 0.001);
  if (next) setZoom(next);
}

// Wheel: up/down by default; Ctrl+wheel sideways; Alt+wheel zooms around
// the pointer. Shift+wheel keeps the browser's own sideways scroll.
let zoomFrame = 0;
let pendingZoom = null;
page.addEventListener('wheel', (ev) => {
  const px = ev.deltaMode === 1 ? 40 : ev.deltaMode === 2 ? page.clientHeight : 1; // lines/pages → px
  if (ev.altKey) {
    ev.preventDefault();
    // Smooth for trackpads, ~12% per notch for wheels; one render per frame.
    const factor = Math.exp(-ev.deltaY * px * 0.0012);
    pendingZoom = { z: (pendingZoom?.z ?? state.zoom) * factor, x: ev.clientX, y: ev.clientY };
    if (!zoomFrame) {
      zoomFrame = requestAnimationFrame(() => {
        zoomFrame = 0;
        const p = pendingZoom;
        pendingZoom = null;
        setZoom(p.z, p.x, p.y);
      });
    }
    return;
  }
  if (ev.ctrlKey) {
    // Also blocks the webview's own page zoom on Ctrl+wheel.
    ev.preventDefault();
    const delta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
    page.scrollLeft += delta * px;
  }
}, { passive: false });

// Middle button + drag pans the score in any direction, in every view.
let pan = null;
page.addEventListener('mousedown', (ev) => {
  if (ev.button !== 1) return;
  ev.preventDefault(); // stops the browser's own autoscroll mode
  pan = { x: ev.clientX, y: ev.clientY, left: page.scrollLeft, top: page.scrollTop };
  page.classList.add('panning');
});
window.addEventListener('mousemove', (ev) => {
  if (!pan) return;
  page.scrollLeft = pan.left - (ev.clientX - pan.x);
  page.scrollTop = pan.top - (ev.clientY - pan.y);
});
window.addEventListener('mouseup', (ev) => {
  if (!pan || ev.button !== 1) return;
  pan = null;
  page.classList.remove('panning');
});
// Some systems open links or paste on middle-click release; not here.
page.addEventListener('auxclick', (ev) => { if (ev.button === 1) ev.preventDefault(); });

// The ghost must follow the page when it scrolls under a still mouse.
page.addEventListener('scroll', () => { if (state.mode !== 'select') drawGhost(); placeLyricInput(); });
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
  if (entering()) state.mode = kind;
  render();
}

// Status bar: jump to the next measure with errors after the caret.
$('status').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-zoom]')) { setZoom(1); page.focus(); return; }
  if (ev.target.closest('[data-update]')) { serial(offerRestart); return; }
  if (!ev.target.closest('[data-jump]')) return;
  const doc = active();
  const errors = measureErrors(doc);
  const c = doc.caret;
  const next = errors.find((e) => e.measure > c.measure || (e.measure === c.measure && e.staff > c.staff)) || errors[0];
  if (next) act({ type: 'set_caret', caret: { staff: next.staff, measure: next.measure, voice: next.voice, index: 0 }, extend: false });
  page.focus();
});

// ----- commands (shared by menus, toolbar and palette) -----------------------

function setPref(key, value) {
  state[key] = value;
  savePref(key, value);
}

/** Shows or hides the rarely used values (breve, 64th, 128th) in the palette. */
function applyExtendedValues() {
  $('palette').classList.toggle('extended-values', state.extendedValues);
}

function applyTheme() {
  // 'system' removes the attribute so CSS follows prefers-color-scheme.
  if (state.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
}

const commands = {
  // File
  new: () => serial(newDocument),
  open: () => serial(openDocument),
  save: () => serial(() => saveDocument()),
  saveas: () => serial(() => saveDocument(true)),
  close: () => serial(() => closeDocument(state.active)),
  print: () => printScore(),
  // Edit
  undo: () => act({ type: 'undo' }),
  redo: () => act({ type: 'redo' }),
  cut: () => act({ type: 'cut' }),
  copy: () => act({ type: 'copy' }),
  paste: () => act({ type: 'paste' }),
  delete: () => act({ type: 'delete_forward' }),
  selectall: () => act({ type: 'select_all' }),
  // View
  'view:page': () => { setPref('view', 'page'); render(); },
  'view:wrap': () => { setPref('view', 'wrap'); render(); },
  'view:continuous': () => { setPref('view', 'continuous'); render(); },
  'paper:a4': () => { setPref('paper', 'a4'); render(); },
  'paper:letter': () => { setPref('paper', 'letter'); render(); },
  multirest: () => { setPref('multiRest', !state.multiRest); render(); },
  'extended-values': () => { setPref('extendedValues', !state.extendedValues); applyExtendedValues(); },
  'zoom-in': () => stepZoom(1),
  'zoom-out': () => stepZoom(-1),
  'zoom-reset': () => setZoom(1),
  'zoom-fit': () => fitWidth(),
  'theme:system': () => { setPref('theme', 'system'); applyTheme(); },
  'theme:light': () => { setPref('theme', 'light'); applyTheme(); },
  'theme:dark': () => { setPref('theme', 'dark'); applyTheme(); },
  // Insert / notation
  'add-measure': () => act({ type: 'insert_measure' }),
  'remove-measure': () => act({ type: 'remove_measure' }),
  'add-staff': () => act({ type: 'add_staff', clef: 'treble' }),
  'remove-staff': () => act({ type: 'remove_staff' }),
  tie: () => act({ type: 'toggle_tie' }),
  slur: () => act({ type: 'toggle_slur' }),
  lyrics: () => (state.lyric ? closeLyric() : startLyricsAtCaret()),
  select: () => setMode('select'),
  erase: () => setMode(state.mode === 'erase' ? 'select' : 'erase'),
  dot: () => { state.duration = { ...state.duration, dots: state.duration.dots ? 0 : 1 }; render(); },
  // Playback
  play: () => togglePlayback(),
  'play-start': () => serial(async () => { if (playback.playing) await stopPlayback(); await startPlayback(true); }),
  stop: () => serial(stopPlayback),
  // Help
  shortcuts: () => showDialog('shortcuts'),
  about: () => showDialog('about'),
  credits: () => showDialog('credits'),
  'open-repo': () => openExternal('https://github.com/partita-notation/partita'),
  support: () => openExternal('https://partita-notation.github.io/support/'),
  'report-problem': () => openExternal('https://github.com/partita-notation/partita/issues'),
  changelog: () => openExternal('https://github.com/partita-notation/partita/blob/main/CHANGELOG.md'),
  'check-updates': () => serial(() => checkForUpdates(true)),
  'auto-updates': () => { savePref('updates.auto', !loadPref('updates.auto', true)); },
};

function runCommand(cmd) {
  commands[cmd]?.();
}

// ----- printing --------------------------------------------------------------

/**
 * Prints the score as it looks in page view: one sheet per page, in black on
 * white whatever the theme. Other views switch to page view for the print
 * and back afterwards.
 */
function printScore() {
  if (!active()) return;
  closeLyric();
  const previous = state.view;
  state.view = 'page';
  setMode('select'); // re-renders in page view, without ghost figure
  // The @page size must match the chosen paper.
  let pageStyle = document.getElementById('print-page-size');
  if (!pageStyle) {
    pageStyle = document.createElement('style');
    pageStyle.id = 'print-page-size';
    document.head.append(pageStyle);
  }
  pageStyle.textContent = `@page { size: ${state.paper === 'letter' ? 'letter' : 'A4'}; margin: 0; }`;
  const restore = () => {
    window.removeEventListener('afterprint', restore);
    state.view = previous;
    render();
  };
  window.addEventListener('afterprint', restore);
  window.print();
}

// ----- playback --------------------------------------------------------------

const playback = {
  playing: false,
  position: null, // { measure, tick } while playing
  sound: null, // last audio_status from Rust
  pollTimer: 0,
};

const MB = (bytes) => (bytes / 1e6).toFixed(0); // decimal MB, as in the download dialog

/** Makes sure the SoundFont is ready; offers to download it the first time. */
async function ensureSound() {
  let s = await invoke('audio_status');
  playback.sound = s;
  if (s.state === 'ready') return true;
  if (s.state === 'no_device') {
    showError(`No audio output: ${s.message}`);
    return false;
  }
  if (s.state === 'missing' || s.state === 'error') {
    const detail = s.state === 'error' ? `<p class="warn">The last attempt failed: ${esc(s.message)}</p>` : '';
    const ok = await askDialog('Download the sounds?',
      `<p>To play music, Partita uses <b>FluidR3 GM</b>, a free collection of recorded instruments by Frank Wen (MIT license).</p>
       <p>It is a one-time download of <b>148 MB</b>, kept on this computer for future sessions.</p>${detail}`,
      'Download');
    if (!ok) return false;
    await invoke('download_soundfont');
  }
  // Downloading or loading: wait, showing progress in the status bar.
  while (true) {
    s = await invoke('audio_status');
    playback.sound = s;
    renderStatus();
    if (s.state === 'ready') return true;
    if (s.state === 'error' || s.state === 'no_device') {
      showError(`Sounds unavailable: ${s.message}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function startPlayback(fromStart = false) {
  const doc = active();
  if (!doc || playback.playing) return;
  if (!(await ensureSound())) return;
  await invoke('play', { id: doc.id, fromStart });
  playback.playing = true;
  syncTransport();
  pollPlayback();
}

/** Pauses, leaving the caret where the music stopped. */
async function pausePlayback() {
  if (!playback.playing) return;
  playback.playing = false;
  clearTimeout(playback.pollTimer);
  adopt(await invoke('pause', { id: state.active }));
  playback.position = null;
  render();
}

/** Stops without moving the caret. */
async function stopPlayback() {
  playback.playing = false;
  clearTimeout(playback.pollTimer);
  await invoke('stop_playback');
  playback.position = null;
  drawPlayhead();
  syncTransport();
}

function togglePlayback() {
  return serial(() => (playback.playing ? pausePlayback() : startPlayback(false)));
}

/** Follows the engine ~30 times per second while playing. */
async function pollPlayback() {
  const s = await invoke('playback_state');
  if (!playback.playing) return; // paused/stopped meanwhile
  if (!s.playing) {
    // Reached the end.
    playback.playing = false;
    playback.position = null;
    drawPlayhead();
    syncTransport();
    return;
  }
  playback.position = { measure: s.measure, tick: s.tick };
  drawPlayhead(true);
  playback.pollTimer = setTimeout(pollPlayback, 33);
}

/** Draws (or removes) the playback line; optionally scrolls to keep it visible. */
function drawPlayhead(follow = false) {
  const scoreEl = $('score');
  scoreEl.querySelectorAll('.playhead').forEach((l) => l.remove());
  if (!playback.position || !state.layout) return;
  const ph = playheadMarkup(state.layout, playback.position.measure, playback.position.tick);
  const svg = ph && scoreEl.querySelector(`svg[data-page="${ph.page}"]`);
  if (!svg) return;
  svg.insertAdjacentHTML('beforeend', ph.markup);
  if (follow) {
    const r = svg.querySelector('.playhead').getBoundingClientRect();
    const p = page.getBoundingClientRect();
    if (r.top < p.top + 20 || r.bottom > p.bottom - 20) page.scrollBy({ top: r.top - p.top - p.height / 4, behavior: 'smooth' });
    if (r.left < p.left + 40 || r.right > p.right - 80) page.scrollBy({ left: r.left - p.left - p.width / 4, behavior: 'smooth' });
  }
}

function syncTransport() {
  const btn = $('play-btn');
  btn.querySelector('use').setAttribute('href', playback.playing ? '#i-pause' : '#i-play');
  btn.setAttribute('aria-label', playback.playing ? 'Pause' : 'Play');
  btn.classList.toggle('on', playback.playing);
}

// ----- lyrics ------------------------------------------------------------------
// Lyrics are typed into a small text field that sits where the syllable is
// drawn. Each syllable belongs to a note; leaving the field (Space, -, _,
// arrows, Esc, a click elsewhere) writes it to the document as one undo step.

const lyric = {
  input: Object.assign(document.createElement('input'), {
    className: 'lyric-input', type: 'text', spellcheck: false, autocomplete: 'off', hidden: true,
  }),
  initial: '', // the syllable's text when editing started (or was last written)
  join: 'none', // and how it joined the next one: 'none' | 'hyphen' | 'extender'
  ctx: null, // canvas context to measure text
};
lyric.input.setAttribute('aria-label', 'Lyric syllable');
document.body.append(lyric.input);

/** Where an event lives in a document: `{ e, staff, measure, voice, index }`. */
function findEvent(doc, id) {
  for (let staff = 0; staff < doc.score.staves.length; staff++) {
    const measures = doc.score.staves[staff].measures;
    for (let measure = 0; measure < measures.length; measure++) {
      for (let voice = 0; voice < measures[measure].voices.length; voice++) {
        const index = measures[measure].voices[voice].findIndex((e) => e.id === id);
        if (index >= 0) return { e: measures[measure].voices[voice][index], staff, measure, voice, index };
      }
    }
  }
  return null;
}

/**
 * The notes of a staff and voice that can start a syllable, in score order:
 * every note except those tied from the previous one.
 */
function singable(doc, staff, voice) {
  const out = [];
  let tied = false;
  doc.score.staves[staff].measures.forEach((cell, measure) => {
    cell.voices[voice].forEach((e, index) => {
      const rest = e.kind === 'rest';
      if (!rest && !tied) out.push({ id: e.id, measure, index });
      tied = !rest && !!e.tie;
    });
  });
  return out;
}

/** Lines of lyrics a staff has in the document. */
function verseCount(doc, staff) {
  let n = 0;
  for (const cell of doc.score.staves[staff].measures) {
    for (const voice of cell.voices) for (const e of voice) n = Math.max(n, (e.lyrics || []).length);
  }
  return n;
}

/** The syllable being edited, for the renderer; drops it if its note is gone. */
function lyricEdit(doc) {
  if (!state.lyric) return null;
  const found = findEvent(doc, state.lyric.id);
  if (!found || found.e.kind === 'rest') {
    state.lyric = null;
    lyric.input.hidden = true;
    return null;
  }
  // Nothing typed yet: follow the document (it may have changed by undo).
  if (lyric.input.value === lyric.initial) {
    const syl = found.e.lyrics?.[state.lyric.verse];
    lyric.initial = syl?.text || '';
    lyric.join = syl?.join || 'none';
    lyric.input.value = lyric.initial;
  }
  return state.lyric;
}

/** Puts the text field where its syllable is drawn (after every render and scroll). */
function placeLyricInput() {
  const l = state.lyric;
  const slot = l && (state.slots || []).find((s) => s.id === l.id);
  if (!slot) return;
  const lay = state.layout;
  const scoreEl = $('score');
  const y = lay.lyricY(slot.system, slot.staff, l.verse);
  const at = layoutToClient(lay, scoreEl, { x: slot.x, y, page: slot.page });
  const unit = layoutToClient(lay, scoreEl, { x: slot.x + 100, y, page: slot.page });
  if (!at || !unit) return;
  const scale = (unit.x - at.x) / 100;
  if (!lyric.ctx) {
    lyric.ctx = document.createElement('canvas').getContext('2d');
    lyric.ctx.font = `${LYRIC_PX}px ${LYRIC_FONT}`;
  }
  const px = LYRIC_PX * scale;
  const width = Math.max(2.4 * px, lyric.ctx.measureText(lyric.input.value).width * scale + 1.2 * px);
  // Hidden while its note is scrolled out of the score area.
  const area = page.getBoundingClientRect();
  const inside = at.x > area.left && at.x < area.right && at.y > area.top + px && at.y < area.bottom;
  Object.assign(lyric.input.style, {
    font: `${px}px ${LYRIC_FONT}`,
    left: `${at.x - width / 2}px`,
    top: `${at.y - 1.16 * px}px`, // the text's baseline lands on the verse's baseline
    width: `${width}px`,
    height: `${1.5 * px}px`,
    visibility: inside ? 'visible' : 'hidden',
  });
}

/** Starts typing the syllable of note `id` in `verse`. */
function openLyric({ id, verse }) {
  const doc = active();
  const found = doc && findEvent(doc, id);
  if (!found || found.e.kind === 'rest') return;
  state.lyric = { id, verse, staff: found.staff };
  state.mode = 'select';
  const syl = found.e.lyrics?.[verse];
  lyric.initial = syl?.text || '';
  lyric.join = syl?.join || 'none';
  lyric.input.value = lyric.initial;
  lyric.input.hidden = false;
  render();
  lyric.input.focus({ preventScroll: true });
  lyric.input.setSelectionRange(lyric.initial.length, lyric.initial.length);
  // Keep the field in view while moving from note to note.
  const r = lyric.input.getBoundingClientRect();
  const p = page.getBoundingClientRect();
  if (r.top < p.top + 40 || r.bottom > p.bottom - 40) page.scrollBy({ top: r.top - p.top - p.height / 2 });
  if (r.left < p.left + 40 || r.right > p.right - 40) page.scrollBy({ left: r.left - p.left - p.width / 2 });
}

/**
 * Writes the field's text to the document if it changed. `join` says what
 * follows the syllable; without it the syllable keeps what it had.
 */
function commitLyric(join) {
  const l = state.lyric;
  if (!l) return;
  const text = lyric.input.value.trim().replace(/\s+/g, ' ');
  const j = text ? (join ?? lyric.join) : 'none';
  if (text === lyric.initial && j === lyric.join) return;
  lyric.initial = text;
  lyric.join = j;
  lyric.input.value = text;
  act({ type: 'set_lyric', id: l.id, verse: l.verse, text, join: j });
}

/** Leaves lyric entry, keeping what was typed. */
function closeLyric() {
  if (!state.lyric) return;
  commitLyric();
  state.lyric = null;
  lyric.input.hidden = true;
  drawLyricHover(null);
  render();
  page.focus();
}

/** Moves to the next (+1) or previous (−1) note of the voice, writing the syllable first. */
function lyricStep(dir, join) {
  const l = state.lyric;
  const doc = active();
  const here = doc && findEvent(doc, l.id);
  if (!here) return;
  commitLyric(join);
  const notes = singable(doc, here.staff, here.voice);
  const i = notes.findIndex((n) => n.id === l.id);
  const next = i < 0 ? null : notes[i + dir];
  if (next) openLyric({ id: next.id, verse: l.verse });
  else {
    // No note there. The field stays (leaving it would turn the next
    // letters typed into notes); say why nothing moved.
    render();
    if (dir > 0) serial(() => { state.error = 'That was the last note of this voice. Press Esc to finish the lyrics.'; renderStatus(); });
  }
}

/** Moves to the verse below (+1) or above (−1) on the same note. */
function lyricVerse(dir) {
  const l = state.lyric;
  const doc = active();
  if (!doc) return;
  // One new line may be started below the verses that have text.
  const used = Math.max(verseCount(doc, l.staff), lyric.input.value.trim() ? l.verse + 1 : 0);
  const verse = l.verse + dir;
  if (verse < 0 || verse > Math.min(used, MAX_VERSES - 1)) return;
  commitLyric();
  openLyric({ id: l.id, verse });
}

/** Ctrl+L: lyrics for the note at the caret (or the next one that can be sung). */
function startLyricsAtCaret() {
  const doc = active();
  if (!doc) return;
  const c = doc.caret;
  const notes = singable(doc, c.staff, c.voice);
  const target = notes.find((n) => n.measure === c.measure && n.index === c.index - 1)
    || notes.find((n) => n.measure > c.measure || (n.measure === c.measure && n.index >= c.index))
    || notes[notes.length - 1];
  if (!target) {
    showError('Lyrics go under notes: write some notes on this staff first.');
    return;
  }
  openLyric({ id: target.id, verse: 0 });
}

/** The lyric line under the pointer (select tool only): `{ id, verse, staff }` or null. */
function lyricUnderPointer(ev) {
  if (state.mode !== 'select' || !state.layout) return null;
  const p = pointerInLayout(ev.clientX, ev.clientY);
  if (!p) return null;
  const head = eraserTarget(state.hits || [], p.x, p.y);
  if (head && !head.rest) return null; // a notehead there can be dragged instead
  return lyricTarget(state.layout, state.slots || [], p.x, p.y);
}

/** Marks the place a click would start typing lyrics (or removes the mark). */
function drawLyricHover(target) {
  const scoreEl = $('score');
  scoreEl.querySelectorAll('.lyric-hover').forEach((r) => r.remove());
  if (target && state.lyric && state.lyric.id === target.id && state.lyric.verse === target.verse) target = null;
  const slot = target && (state.slots || []).find((s) => s.id === target.id);
  scoreEl.classList.toggle('over-lyric', !!slot);
  if (!slot) return;
  const svg = scoreEl.querySelector(`svg[data-page="${slot.page}"]`);
  if (!svg) return;
  const y = state.layout.lyricY(slot.system, slot.staff, target.verse);
  svg.insertAdjacentHTML('beforeend',
    `<rect class="lyric-hover" x="${slot.x - 1.7 * SP}" y="${y - 1.45 * SP}" width="${3.4 * SP}" height="${2 * SP}" rx="3"><title>Click to write lyrics here</title></rect>`);
}

lyric.input.addEventListener('input', placeLyricInput);
lyric.input.addEventListener('blur', () => { if (!lyric.input.hidden) closeLyric(); });
lyric.input.addEventListener('keydown', (ev) => {
  if (!state.lyric) return;
  const el = lyric.input;
  const untouched = el.value === lyric.initial;
  const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
  const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
  const key = ev.key;
  let handled = true;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) {
    const lower = key.toLowerCase();
    // With nothing typed, Ctrl+Z / Ctrl+Y undo and redo whole syllables;
    // otherwise they undo the typing itself, as in any text field.
    if (ev.altKey) handled = false;
    else if (lower === 'z' && untouched) act({ type: ev.shiftKey ? 'redo' : 'undo' });
    else if (lower === 'y' && untouched) act({ type: 'redo' });
    else if (lower === 'l') closeLyric();
    else handled = false;
  } else {
    switch (key) {
      case ' ': lyricStep(1, 'none'); break;
      case '-': lyricStep(1, el.value.trim() ? 'hyphen' : undefined); break;
      case '_': lyricStep(1, el.value.trim() ? 'extender' : undefined); break;
      case 'Tab': lyricStep(ev.shiftKey ? -1 : 1); break;
      case 'ArrowRight': if (atEnd) lyricStep(1); else handled = false; break;
      case 'ArrowLeft': if (atStart) lyricStep(-1); else handled = false; break;
      case 'Backspace': if (el.value === '') lyricStep(-1); else handled = false; break;
      case 'ArrowDown': lyricVerse(1); break;
      case 'ArrowUp': lyricVerse(-1); break;
      case 'Enter': case 'Escape': closeLyric(); break;
      default: handled = false;
    }
  }
  if (handled) {
    ev.preventDefault();
    ev.stopPropagation();
  }
});

// ----- dialogs ---------------------------------------------------------------

/** A yes/no dialog. Resolves true when the user picks the OK button. */
function askDialog(title, bodyHtml, okLabel) {
  const dlg = $('dialog');
  dlg.innerHTML = `<h2>${esc(title)}</h2><div class="dialog-body">${bodyHtml}</div>
    <div class="dialog-actions"><button type="button" data-answer="no">Cancel</button><button type="button" data-answer="yes" class="primary" autofocus>${esc(okLabel)}</button></div>`;
  dlg.showModal();
  // Resolved from the buttons themselves (and Esc = Cancel): the dialog's
  // `close` event proved unreliable in the webview when a form closes it.
  return new Promise((resolve) => {
    const done = (answer) => {
      dlg.removeEventListener('click', onClick);
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      resolve(answer);
    };
    const onClick = (ev) => {
      const b = ev.target.closest('[data-answer]');
      if (b) done(b.dataset.answer === 'yes');
    };
    const onCancel = (ev) => { ev.preventDefault(); done(false); };
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('cancel', onCancel);
  });
}

const SHORTCUTS = [
  ['Entering music', [
    ['A – G', 'Insert a note (octave follows the previous note)'],
    ['Shift + A – G', 'Add a note to the previous chord'],
    ['R or 0', 'Insert a rest'],
    ['1 – 7', 'Note value: 64th … whole'],
    ['8 / 9', 'Breve / 128th (View → Breve and 128th Notes)'],
    ['.', 'Dot'],
    ['+ / −', 'Raise / lower the accidental'],
    ['Alt + ↑ / ↓', 'Move the note a step (Ctrl+Alt: an octave)'],
    ['T', 'Tie to the next note'],
    ['S', 'Slur over the selection'],
    ['N', 'Mouse entry mode on / off'],
    ['X', 'Eraser on / off (click a note, or drag a box)'],
    ['Alt + 1 – 4', 'Switch voice'],
  ]],
  ['Lyrics', [
    ['Ctrl + L', 'Write lyrics under the note at the caret (again to finish)'],
    ['Click under a staff', 'Write lyrics under that note'],
    ['Space', 'End the word and go to the next note'],
    ['-', 'End the syllable with a hyphen and go to the next note'],
    ['_', 'Hold the syllable over the next notes (extender line)'],
    ['← / →', 'Previous / next note (at the edge of the text)'],
    ['↓ / ↑', 'Next / previous verse'],
    ['Backspace', 'In an empty syllable: back to the previous note'],
    ['Esc or Enter', 'Finish'],
  ]],
  ['Moving and selecting', [
    ['← / →', 'Previous / next note'],
    ['↑ / ↓', 'Staff above / below'],
    ['Home / End', 'Start / end of the measure'],
    ['Ctrl + ← / →', 'Previous / next measure'],
    ['Ctrl + Home / End', 'Start / end of the score'],
    ['Shift + any move', 'Extend the selection'],
    ['Click / drag', 'Place the caret / select'],
    ['Shift + click', 'Extend the selection'],
    ['Ctrl + A', 'Select all'],
    ['Esc', 'Back to the select tool'],
  ]],
  ['Navigation and zoom', [
    ['Wheel', 'Scroll up / down'],
    ['Ctrl + wheel', 'Scroll sideways'],
    ['Alt + wheel', 'Zoom in / out around the pointer'],
    ['Middle button + drag', 'Pan the score'],
    ['Ctrl + = / Ctrl + −', 'Zoom in / out'],
    ['Ctrl + 0', 'Zoom to 100%'],
  ]],
  ['Playback', [
    ['Space', 'Play from the caret / pause'],
    ['Shift + Space', 'Play from the beginning'],
    ['Esc (while playing)', 'Stop'],
  ]],
  ['Editing', [
    ['Backspace / Del', 'Delete before / after the caret, or the selection'],
    ['Ctrl + X / C / V', 'Cut / copy / paste'],
    ['Ctrl + Z / Y', 'Undo / redo'],
    ['Ctrl + Enter', 'Insert a measure'],
  ]],
  ['Files and windows', [
    ['Ctrl + N / O', 'New / open'],
    ['Ctrl + S', 'Save (Ctrl+Shift+S: save as)'],
    ['Ctrl + P', 'Print'],
    ['Ctrl + W', 'Close tab'],
    ['Ctrl + Tab', 'Next tab'],
    ['Alt', 'Menu bar'],
    ['F1', 'This list'],
  ]],
];

// Title and Close stay put; only the body scrolls when the window is short.
function openDialog(title, body, extraButtons = '') {
  const dlg = $('dialog');
  dlg.innerHTML = `<h2>${title}</h2><div class="dialog-body">${body}</div>`
    + `<div class="dialog-actions">${extraButtons}<span class="spacer"></span><button type="button" data-close autofocus>Close</button></div>`;
  dlg.showModal();
}

function showDialog(which) {
  if (which === 'about' || which === 'credits') return serial(() => showAbout(which === 'credits'));
  openDialog('Keyboard and mouse shortcuts', `<div class="shortcut-cols">${SHORTCUTS.map(([group, rows]) =>
    `<section><h3>${group}</h3><table>${rows.map(([k, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join('')}</table></section>`).join('')}</div>`);
}

/** Opens a web page in the system browser (the webview cannot navigate away). */
function openExternal(url) {
  if (tauri.opener?.openUrl) tauri.opener.openUrl(url).catch(showError);
  else window.open(url, '_blank', 'noopener');
}

// ----- updates ---------------------------------------------------------------

const updates = {
  status: null, // last update_status from Rust
  polling: false,
};
const DAY_MS = 24 * 60 * 60 * 1000;
const releaseUrl = (v) => `https://github.com/partita-notation/partita/releases/tag/v${v}`;

/** Status bar text while an update downloads or waits for a restart. */
function updatePart() {
  const u = updates.status;
  if (u?.state === 'downloading') {
    const pct = u.total ? Math.min(100, Math.floor((u.received / u.total) * 100)) : 0;
    return `<span class="download" role="status" data-tip="Downloading Partita ${esc(u.version)}" data-desc="You can keep working. Partita asks before restarting.">`
      + `Downloading update <progress max="100" value="${pct}" aria-label="Update download progress"></progress> <b>${pct}%</b></span>`;
  }
  if (u?.state === 'ready') {
    return `<span class="update" data-update data-tip="Partita ${esc(u.version)} is ready" data-desc="Click to restart and install it. Unsaved changes are kept.">⟳ Restart to update</span>`;
  }
  return '';
}

/** A dialog with several buttons. Resolves with the value of the one picked (null for Esc). */
function choiceDialog(title, bodyHtml, buttons) {
  const dlg = $('dialog');
  dlg.innerHTML = `<h2>${esc(title)}</h2><div class="dialog-body">${bodyHtml}</div><div class="dialog-actions">${
    buttons.map((b) => (b.spacer ? '<span class="spacer"></span>'
      : `<button type="button" data-answer="${esc(b.value)}"${b.primary ? ' class="primary" autofocus' : ''}>${esc(b.label)}</button>`)).join('')}</div>`;
  dlg.showModal();
  return new Promise((resolve) => {
    const done = (answer) => {
      dlg.removeEventListener('click', onClick);
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      resolve(answer);
    };
    const onClick = (ev) => {
      const b = ev.target.closest('[data-answer]');
      if (b) done(b.dataset.answer);
    };
    const onCancel = (ev) => { ev.preventDefault(); done(null); };
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('cancel', onCancel);
  });
}

/**
 * Looks for a new version. Automatic checks (manual = false) run at most once
 * a day, stay silent unless there is an update, and respect "Skip This
 * Version"; Help → Check for Updates always answers.
 */
async function checkForUpdates(manual) {
  if (!manual) {
    if (!loadPref('updates.auto', true)) return;
    if (Date.now() - loadPref('updates.lastCheck', 0) < DAY_MS) return;
  }
  const current = updates.status?.state;
  if (current === 'downloading' || current === 'ready') {
    if (manual) await offerRestart();
    return;
  }
  const s = await invoke('check_for_update');
  updates.status = s;
  if (s.state !== 'error') savePref('updates.lastCheck', Date.now());
  if (s.state === 'available') {
    if (!manual && loadPref('updates.skip', null) === s.version) return;
    await offerUpdate(s);
  } else if (manual && s.state === 'up_to_date') {
    await choiceDialog('Partita is up to date', `<p>You have the latest version, <b>${esc(s.current)}</b>.</p>`,
      [{ label: 'OK', value: 'ok', primary: true }]);
  } else if (manual && s.state === 'error') {
    await choiceDialog('Could not check for updates',
      `<p>Partita could not reach GitHub to look for a new version. Check your internet connection and try again.</p><p class="muted">${esc(s.message)}</p>`,
      [{ label: 'OK', value: 'ok', primary: true }]);
  } else if (s.state === 'error') {
    console.warn('[partita] update check failed:', s.message);
  }
}

async function offerUpdate(info) {
  const date = info.date ? ` It was published on ${esc(info.date)}.` : '';
  const answer = await choiceDialog(`Partita ${info.version} is available`,
    `<p>You have version ${esc(info.current)}.${date} ${link(releaseUrl(info.version), 'See what’s new')}</p>
     <p>The update downloads in the background while you keep working. Partita asks before restarting, and unsaved changes are kept.</p>`,
    [
      { label: 'Skip This Version', value: 'skip' },
      { spacer: true },
      { label: 'Later', value: 'later' },
      { label: 'Download and Install', value: 'download', primary: true },
    ]);
  if (answer === 'skip') savePref('updates.skip', info.version);
  if (answer !== 'download') return;
  await invoke('download_update');
  pollUpdate();
}

/** Follows the download in the status bar, then offers to restart. */
async function pollUpdate() {
  if (updates.polling) return;
  updates.polling = true;
  try {
    while (true) {
      const s = await invoke('update_status');
      updates.status = s;
      renderStatus();
      if (s.state === 'ready') { serial(offerRestart); return; }
      if (s.state === 'error') { showError(`The update could not be downloaded: ${s.message}`); return; }
      if (s.state !== 'downloading') return;
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    updates.polling = false;
  }
}

async function offerRestart() {
  const u = updates.status;
  if (u?.state !== 'ready') return;
  const dirty = [...state.docs.values()].some((d) => d.dirty);
  const keep = dirty ? '<p>Your unsaved changes are kept: Partita offers them back when it starts again.</p>' : '';
  const answer = await choiceDialog(`Restart to install Partita ${u.version}?`,
    `<p>The update has been downloaded and verified.</p>${keep}`,
    [{ label: 'Later', value: 'later' }, { label: 'Restart Now', value: 'restart', primary: true }]);
  if (answer !== 'restart') return;
  if (playback.playing) await stopPlayback();
  try {
    await invoke('install_update');
  } catch (e) {
    updates.status = { state: 'error', message: String(e) };
    renderStatus();
    showError(`The update could not be installed: ${e}`);
  }
}

const link = (url, text) => `<a href="${esc(url)}" data-external>${esc(text ?? url.replace(/^https?:\/\//, ''))}</a>`;
const OS_NAMES = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

/** Help → About: version, platform, downloaded components and credits. */
async function showAbout(scrollToCredits = false) {
  const a = await invoke('about_info');
  const sf = a.soundfont;
  const platform = `${OS_NAMES[a.os] || a.os} ${a.arch}`;
  // Plain-text summary for bug reports.
  const summary = [
    `Partita ${a.version} (${platform})`,
    `Tauri ${a.tauri} · file format ${a.file_format}`,
    `SoundFont: ${sf.name} ${sf.version} ${sf.installed ? `installed (${MB(sf.size_bytes)} MB)` : 'not downloaded'}`,
  ].join('\n');
  const sfState = sf.installed
    ? `<span class="ok">● Installed</span> · ${MB(sf.size_bytes)} MB`
    : sf.status.state === 'downloading'
      ? `<span class="ok">Downloading…</span>`
      : '<span class="muted">Not downloaded yet — it is offered the first time you press Play.</span>';
  const body = `
    <div class="about-head">
      <img src="app-icon.png" alt="" width="56" height="56">
      <div>
        <div class="about-name">Partita <span class="about-version">${esc(a.version)}</span></div>
        <div class="muted">Open source music notation editor · ${esc(platform)}</div>
        <div class="muted">Free software under the ${link('https://www.gnu.org/licenses/gpl-3.0.html', 'GNU GPL v3.0 or later')}.</div>
      </div>
    </div>
    <p class="about-links">${link(a.repository, 'Source code')} · ${link(a.issues, 'Report a problem')} · ${link(`${a.repository}/blob/main/CHANGELOG.md`, 'What’s new')}</p>

    <h3>Downloaded by Partita</h3>
    <table class="about-table">
      <tr><th>${esc(sf.name)} ${esc(sf.version)}</th><td>${sfState}</td></tr>
      <tr><td colspan="2" class="muted">Instrument sounds by ${esc(sf.author)} · ${esc(sf.license)} license · ${link(sf.homepage, 'more information')}</td></tr>
      ${sf.installed ? `<tr><td colspan="2" class="path" title="${esc(sf.path)}">${esc(sf.path)}</td></tr>` : ''}
    </table>

    <h3 id="about-credits">Credits</h3>
    <p class="muted">Partita is built on the work of these projects. Thank you!</p>
    <table class="about-table credits">
      ${a.credits.map((c) => `<tr>
        <th>${link(c.url, c.name)} <span class="muted">${esc(c.version)}</span></th>
        <td>${esc(c.role)}<div class="muted">${esc(c.author)} · ${esc(c.license)}</div></td>
      </tr>`).join('')}
    </table>

    <h3>Technical details</h3>
    <table class="about-table">
      <tr><th>Version</th><td>${esc(a.version)}</td></tr>
      <tr><th>Platform</th><td>${esc(platform)} · Tauri ${esc(a.tauri)}</td></tr>
      <tr><th>File format</th><td>.partita version ${a.file_format}</td></tr>
      <tr><th>Data folder</th><td class="path" title="${esc(a.data_dir)}">${esc(a.data_dir)}</td></tr>
    </table>`;
  openDialog('About Partita', body,
    `<button type="button" data-copy>Copy version info</button>${sf.installed ? '<button type="button" data-reveal>Show SoundFont file</button>' : ''}`);
  const dlg = $('dialog');
  dlg.dataset.summary = summary;
  dlg.dataset.sfPath = sf.path;
  if (scrollToCredits) $('about-credits').scrollIntoView();
}

const dialogEl = $('dialog');
dialogEl.addEventListener('close', () => page.focus());
dialogEl.addEventListener('click', (ev) => {
  // Clicking the backdrop closes the dialog.
  if (ev.target === ev.currentTarget) { ev.currentTarget.close(); return; }
  const a = ev.target.closest('a[data-external]');
  if (a) { ev.preventDefault(); openExternal(a.getAttribute('href')); return; }
  if (ev.target.closest('[data-close]')) { dialogEl.close(); return; }
  const copy = ev.target.closest('[data-copy]');
  if (copy) {
    navigator.clipboard.writeText(dialogEl.dataset.summary || '').then(() => { copy.textContent = 'Copied ✓'; }, showError);
    return;
  }
  if (ev.target.closest('[data-reveal]')) {
    tauri.opener?.revealItemInDir?.(dialogEl.dataset.sfPath)?.catch?.(showError);
  }
});

// Toolbar and palette.
const onControlClick = (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.dataset.dur) setDuration(b.dataset.dur, true);
  else if (b.dataset.voice) setVoice(Number(b.dataset.voice));
  else if (b.dataset.kind) setKind(b.dataset.kind);
  else if (b.dataset.alter || b.dataset.artic || b.dataset.dyn) useMark(b);
  else runCommand(b.dataset.cmd);
  page.focus();
};
document.querySelector('.toolbar').addEventListener('click', onControlClick);
$('palette').addEventListener('click', onControlClick);

// ----- menu bar --------------------------------------------------------------

const hasDoc = () => !!active();
const hasSelection = () => !!active()?.selection;
const MENUS = [
  { label: 'File', items: [
    { label: 'New', cmd: 'new', key: 'Ctrl+N' },
    { label: 'Open…', cmd: 'open', key: 'Ctrl+O' },
    { sep: true },
    { label: 'Save', cmd: 'save', key: 'Ctrl+S', enabled: hasDoc },
    { label: 'Save As…', cmd: 'saveas', key: 'Ctrl+Shift+S', enabled: hasDoc },
    { sep: true },
    { label: 'Print…', cmd: 'print', key: 'Ctrl+P', enabled: hasDoc },
    { sep: true },
    { label: 'Close Tab', cmd: 'close', key: 'Ctrl+W', enabled: hasDoc },
  ] },
  { label: 'Edit', items: [
    { label: 'Undo', cmd: 'undo', key: 'Ctrl+Z', enabled: () => !!active()?.can_undo },
    { label: 'Redo', cmd: 'redo', key: 'Ctrl+Y', enabled: () => !!active()?.can_redo },
    { sep: true },
    { label: 'Cut', cmd: 'cut', key: 'Ctrl+X', enabled: hasSelection },
    { label: 'Copy', cmd: 'copy', key: 'Ctrl+C', enabled: hasSelection },
    { label: 'Paste', cmd: 'paste', key: 'Ctrl+V', enabled: hasDoc },
    { label: 'Delete', cmd: 'delete', key: 'Del', enabled: hasDoc },
    { sep: true },
    { label: 'Select All', cmd: 'selectall', key: 'Ctrl+A', enabled: hasDoc },
  ] },
  { label: 'View', items: [
    { label: 'Page (as printed)', cmd: 'view:page', radio: true, checked: () => state.view === 'page' },
    { label: 'Wrap to Window', cmd: 'view:wrap', radio: true, checked: () => state.view === 'wrap' },
    { label: 'Continuous (one line)', cmd: 'view:continuous', radio: true, checked: () => state.view === 'continuous' },
    { sep: true },
    { label: 'Paper: A4', cmd: 'paper:a4', radio: true, checked: () => state.paper === 'a4' },
    { label: 'Paper: Letter', cmd: 'paper:letter', radio: true, checked: () => state.paper === 'letter' },
    { sep: true },
    { label: 'Zoom In', cmd: 'zoom-in', key: 'Ctrl+=', enabled: () => state.zoom < ZOOM_MAX },
    { label: 'Zoom Out', cmd: 'zoom-out', key: 'Ctrl+−', enabled: () => state.zoom > ZOOM_MIN },
    { label: 'Actual Size (100%)', cmd: 'zoom-reset', key: 'Ctrl+0', enabled: () => state.zoom !== 1 },
    { label: 'Fit Page Width', cmd: 'zoom-fit', enabled: () => state.view === 'page' },
    { sep: true },
    { label: 'Multi-measure Rests', cmd: 'multirest', checked: () => state.multiRest },
    { label: 'Breve and 128th Notes', cmd: 'extended-values', checked: () => state.extendedValues },
    { sep: true },
    { label: 'Theme: System', cmd: 'theme:system', radio: true, checked: () => state.theme === 'system' },
    { label: 'Theme: Light', cmd: 'theme:light', radio: true, checked: () => state.theme === 'light' },
    { label: 'Theme: Dark', cmd: 'theme:dark', radio: true, checked: () => state.theme === 'dark' },
  ] },
  { label: 'Insert', items: [
    { label: 'Measure After Current', cmd: 'add-measure', key: 'Ctrl+Enter', enabled: hasDoc },
    { label: 'Staff', cmd: 'add-staff', enabled: hasDoc },
    { sep: true },
    { label: 'Tie', cmd: 'tie', key: 'T', enabled: hasDoc },
    { label: 'Slur over Selection', cmd: 'slur', key: 'S', enabled: hasSelection },
    { label: 'Lyrics', cmd: 'lyrics', key: 'Ctrl+L', enabled: hasDoc, checked: () => !!state.lyric },
    { sep: true },
    { label: 'Delete Current Measure', cmd: 'remove-measure', enabled: hasDoc },
    { label: 'Delete Current Staff', cmd: 'remove-staff', enabled: hasDoc },
  ] },
  { label: 'Play', items: [
    { label: 'Play / Pause', cmd: 'play', key: 'Space', enabled: hasDoc },
    { label: 'Play from Beginning', cmd: 'play-start', key: 'Shift+Space', enabled: hasDoc },
    { label: 'Stop', cmd: 'stop', key: 'Esc', enabled: () => playback.playing },
  ] },
  { label: 'Help', items: [
    { label: 'Keyboard Shortcuts', cmd: 'shortcuts', key: 'F1' },
    { sep: true },
    { label: 'What’s New', cmd: 'changelog' },
    { label: 'Report a Problem…', cmd: 'report-problem' },
    { label: 'Source Code on GitHub', cmd: 'open-repo' },
    { label: 'Support Partita…', cmd: 'support' },
    { sep: true },
    { label: 'Check for Updates…', cmd: 'check-updates' },
    { label: 'Automatic Updates', cmd: 'auto-updates', checked: () => loadPref('updates.auto', true) },
    { sep: true },
    { label: 'Credits and Licenses', cmd: 'credits' },
    { label: 'About Partita', cmd: 'about' },
  ] },
];
installMenuBar($('menubar'), MENUS, runCommand, () => page.focus());
applyTheme();
applyExtendedValues();

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
$('tempo').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const bpm = Number(ev.target.value);
  if (!Number.isInteger(bpm) || bpm < 20 || bpm > 400) { showError('Tempo must be a whole number from 20 to 400'); return; }
  act({ type: 'set_tempo', bpm });
  page.focus();
});
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
    title: 'Partita', kind: 'warning', okLabel: 'Quit without saving', cancelLabel: 'Cancel',
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
  // First run of page view: start with the page fitted to the window.
  if (state.view === 'page' && loadPref('zoom', null) === null) fitWidth();
  page.focus();
  // Look for a new version a little after start-up, at most once a day.
  setTimeout(() => serial(() => checkForUpdates(false)), 5000);
});
