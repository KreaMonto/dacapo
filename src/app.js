// Partita frontend. Owns no musical state: every edit is sent to Rust,
// which answers with the full document view to redraw.

import {
  SP, renderScore, hitTest, pointerTarget, ghostMarkup, clientToLayout, layoutToClient, playheadMarkup, esc, eraserTarget, eventsInBox,
  lyricTarget, MAX_VERSES, fullMetadata, BEATS, perMinute, toQuarterBpm,
  currentStyle, cssFont, resolveStyle, TEXT_KINDS, TEXT_DEFAULTS, UNITS_PER_PT, UNITS_PER_TENTH_MM,
} from './render.js';
import { installTooltips } from './tooltip.js';
import { installMenuBar } from './menu.js';
import {
  t, tn, has, keyLabel, applyTranslations, LANGUAGES, LANGUAGE_NAMES, languageChoice,
} from './i18n.js';
import {
  INSTRUMENTS, TRANSPOSITIONS, instrumentByProgram, instrumentOptions, shortNameFor, transpositionKey,
} from './instruments.js';

const tauri = window.__TAURI__;
const invoke = tauri.core.invoke;
const dialog = tauri.dialog;

const FILTERS = [{ name: t('filter.partita'), extensions: ['partita'] }];
// Opening also accepts scores saved under the project's former name, Da Capo,
// and MusicXML from other notation programs (imported as a new score).
const MUSICXML_EXTENSIONS = ['musicxml', 'mxl', 'xml'];
const OPEN_FILTERS = [
  { name: t('filter.all'), extensions: ['partita', 'dacapo', ...MUSICXML_EXTENSIONS] },
  { name: t('filter.partita'), extensions: ['partita', 'dacapo'] },
  { name: t('filter.musicxml'), extensions: MUSICXML_EXTENSIONS },
];
const MUSICXML_FILTERS = [{ name: t('filter.musicxml'), extensions: ['musicxml'] }];
const isMusicXml = (path) => MUSICXML_EXTENSIONS.includes(String(path).split('.').pop().toLowerCase());
const KEY_NAMES = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
const DURATION_KEYS = { 1: 'SixtyFourth', 2: 'ThirtySecond', 3: 'Sixteenth', 4: 'Eighth', 5: 'Quarter', 6: 'Half', 7: 'Whole' };
// Only with View → Breve and 128th Notes on.
const EXTENDED_KEYS = { 8: 'Breve', 9: 'HundredTwentyEighth' };

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
applyTranslations();

// ----- talking to Rust -------------------------------------------------------

// Edits are chained so fast typing (key repeat) is applied in order.
let queue = Promise.resolve();
function serial(fn) {
  queue = queue.then(fn).catch(showError);
  return queue;
}

/**
 * The text for an error. Rust sends `{ code, args, message }`: the code is
 * translated (error.<code>), and `message` is the English fallback for codes
 * the locale does not know (and the text of code "other").
 */
function errorText(e) {
  if (e && typeof e === 'object' && e.code) {
    return has(`error.${e.code}`) ? t(`error.${e.code}`, e.args) : String(e.message);
  }
  return String(e?.message ?? e);
}

function showError(e) {
  state.error = errorText(e);
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
  if (isMusicXml(path)) return importMusicXml(path);
  const v = adopt(await invoke('open_document', { path }));
  state.active = v.id;
  render();
}

/** Opens a MusicXML file as a new score and says what was simplified. */
async function importMusicXml(path) {
  const v = adopt(await invoke('import_musicxml', { path }));
  state.active = v.id;
  render();
  const notes = v.import_notes || [];
  if (notes.length) {
    await choiceDialog(t('import.title'),
      `<p>${esc(t('import.body'))}</p><ul>${notes.map((n) => `<li>${esc(tn(`import.note.${n.kind}`, n.count))}</li>`).join('')}</ul>`,
      [{ spacer: true }, { label: t('button.ok'), value: 'ok', primary: true }]);
  }
}

async function importMusicXmlFromDialog() {
  const path = await dialog.open({ multiple: false, filters: [{ name: t('filter.musicxml'), extensions: MUSICXML_EXTENSIONS }] });
  if (path) await importMusicXml(path);
}

/** Saves the active score as MusicXML, for other notation programs. */
async function exportMusicXml() {
  const doc = active();
  if (!doc) return;
  const path = await dialog.save({ filters: MUSICXML_FILTERS, defaultPath: `${doc.name}.musicxml` });
  if (!path) return;
  await invoke('export_musicxml', { id: doc.id, path });
}

/** Whether a staff still has the name it got by default ("Staff 2", in any language Partita speaks). */
function isDefaultStaffName(name) {
  return [t('default.staff'), 'Staff {n}'].some((template) => {
    const [before, after = ''] = template.split('{n}');
    const middle = name.slice(before.length, name.length - after.length);
    return name.startsWith(before) && name.endsWith(after) && /^\d+$/.test(middle);
  });
}

const CLEF_LABELS = Object.fromEntries(['treble', 'bass', 'alto', 'tenor'].map((c) => [c, t(`clef.${c}`)]));

/**
 * Name, sound and clef of a staff. With `staff` null it adds a new staff.
 * Picking a sound proposes its usual name and clef, unless the name was
 * already changed by hand.
 */
async function staffDialog(staff) {
  const doc = active();
  if (!doc) return;
  const adding = staff === null;
  const current = adding
    ? { name: '', short_name: '', instrument: 0, clef: 'treble', transposition: { diatonic: 0, chromatic: 0 } }
    : doc.score.staves[staff];
  if (!current) return;
  const trans = current.transposition || { diatonic: 0, chromatic: 0 };
  const listed = transpositionKey(trans);
  // Staves of this instrument: those braced with it (a piano's two hands).
  // A lone staff can become a grand staff here; going back means deleting
  // the extra staff, so a braced instrument shows its count, fixed.
  const group = !adding && current.group?.kind === 'brace' ? current.group.id : null;
  const braced = group === null ? 1 : doc.score.staves.filter((st) => st.group?.id === group).length;
  const proposed = adding ? instrumentByProgram(current.instrument || 0).staves : braced;
  const transOptions = TRANSPOSITIONS.map((tr) =>
    `<option value="${tr.key}"${tr.key === listed ? ' selected' : ''}>${esc(tr.label)}</option>`).join('')
    + (listed ? '' : `<option value="custom" selected>${esc(t('staff.transposition.other', trans))}</option>`);
  const body = `<form class="staff-form" id="staff-form">
    <div class="row">
      <label>${esc(t('staff.name'))}
        <input id="staff-name" type="text" maxlength="40" value="${esc(current.name)}" placeholder="${adding ? esc(t('staff.name.example')) : ''}" autocomplete="off"></label>
      <label>${esc(t('staff.short'))}
        <input id="staff-short" type="text" maxlength="40" value="${esc(current.short_name || '')}" placeholder="${esc(t('staff.short.example'))}" autocomplete="off"></label>
    </div>
    <label>${esc(t('staff.sound'))}
      <select id="staff-sound">${instrumentOptions(current.instrument || 0, esc)}</select></label>
    <div class="row">
      <label>${esc(t('staff.clef'))}
        <select id="staff-clef">${Object.entries(CLEF_LABELS).map(([v, l]) =>
          `<option value="${v}"${v === current.clef ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label>${esc(t('staff.transposition'))}
        <select id="staff-trans">${transOptions}</select></label>
    </div>
    <label>${esc(t('staff.count'))}
      <select id="staff-count"${braced > 1 ? ' disabled' : ''}>
        <option value="1">${esc(t('staff.count.one'))}</option>
        <option value="2"${proposed === 2 ? ' selected' : ''}>${esc(t('staff.count.two'))}</option>
        ${braced > 2 ? `<option value="${braced}" selected>${esc(t('staff.count.n', { n: braced }))}</option>` : ''}
      </select></label>
    ${braced > 1 ? `<p class="muted hint">${esc(t('staff.count.braced'))}</p>` : ''}
    <p class="muted hint">${esc(t('staff.hint'))}</p>
  </form>`;
  const pending = choiceDialog(adding ? t('staff.title.add') : t('staff.title'), body, [
    { spacer: true },
    { label: t('button.cancel'), value: 'cancel' },
    { label: adding ? t('staff.add') : t('button.ok'), value: 'ok', primary: true },
  ]);
  const name = $('staff-name');
  const short = $('staff-short');
  const sound = $('staff-sound');
  const clef = $('staff-clef');
  const transSel = $('staff-trans');
  const count = $('staff-count');
  const inst = () => INSTRUMENTS[Number(sound.value)];
  // Name and short name follow the sound until the user types their own.
  const startInst = instrumentByProgram(current.instrument || 0);
  let nameTouched = !adding && current.name !== startInst.name && !isDefaultStaffName(current.name);
  let shortTouched = !adding && !!current.short_name && current.short_name !== shortNameFor(current.name, startInst);
  name.addEventListener('input', () => {
    nameTouched = name.value.trim() !== '';
    if (!shortTouched) short.value = shortNameFor(name.value, inst());
  });
  short.addEventListener('input', () => { shortTouched = short.value.trim() !== ''; });
  sound.addEventListener('change', () => {
    const i = inst();
    if (!nameTouched) name.value = i.name;
    if (!shortTouched) short.value = shortNameFor(name.value, i);
    clef.value = i.clef;
    transSel.value = transpositionKey(i.transposition) || 'none';
    if (!count.disabled) count.value = String(i.staves);
  });
  $('staff-form').addEventListener('submit', (ev) => { ev.preventDefault(); $('dialog').querySelector('[data-answer="ok"]').click(); });
  name.focus();
  name.select();
  const answer = await pending;
  if (answer !== 'ok') return;
  const instrument = Number(sound.value);
  const chosen = TRANSPOSITIONS.find((tr) => tr.key === transSel.value);
  const props = {
    name: name.value.trim() || instrumentByProgram(instrument).name,
    short_name: short.value.trim(),
    instrument,
    clef: clef.value,
    transposition: chosen ? { diatonic: chosen.diatonic, chromatic: chosen.chromatic } : trans,
  };
  if (adding) await act({ type: 'add_staff', ...props, staves: Number(count.value) });
  else await act({ type: 'set_staff', staff, ...props, staves: Number(count.value) });
}

/** Joins the selected staves with a bracket or brace, or ungroups them. */
function groupSelectedStaves(kind) {
  const doc = active();
  const sel = doc?.selection;
  if (!sel || sel.staff_hi <= sel.staff_lo) {
    return choiceDialog(t('group.select.title'),
      `<p>${esc(t('group.select.body'))}</p>`,
      [{ spacer: true }, { label: t('button.ok'), value: 'ok', primary: true }]);
  }
  return act({ type: 'group_staves', first: sel.staff_lo, last: sel.staff_hi, kind });
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
    const save = await dialog.ask(t('close.save', { name: doc.name }), {
      title: 'Partita', kind: 'warning', okLabel: t('close.save.ok'), cancelLabel: t('close.save.no'),
    });
    if (save) {
      if (!(await saveDocument())) return;
    } else {
      const sure = await dialog.ask(t('close.discard', { name: doc.name }), {
        title: 'Partita', kind: 'warning', okLabel: t('close.discard.ok'), cancelLabel: t('close.discard.no'),
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
  box.innerHTML = `<strong>${esc(t('recovery.title'))}</strong> ${esc(t('recovery.body'))}` +
    items.map((r) => {
      const m = r.manifest;
      const name = m ? m.display_name : t('recovery.unknown');
      const when = m ? new Date(m.updated_ms).toLocaleString() : '';
      return `<div class="item" data-sid="${r.session_id}">
        <span>${esc(name)} <span style="color:var(--muted)">${esc(when)}</span></span>
        <button data-recover>${esc(t('recovery.restore'))}</button><button data-discard>${esc(t('recovery.discard'))}</button></div>`;
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
      const sure = await dialog.ask(t('recovery.discard.ask'), {
        title: 'Partita', kind: 'warning', okLabel: t('recovery.discard.ok'), cancelLabel: t('recovery.discard.no'),
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
  document.body.dataset.view = state.view;
  // At zoom z the wrap view lays out for width/z so it still fills the window.
  const width = (scoreEl.clientWidth || 1000) / state.zoom;
  const { pages, layout, hits, slots } = renderScore(doc, width, {
    multiRest: state.multiRest, view: state.view, paper: state.paper, zoom: state.zoom, lyricEdit: lyricEdit(doc),
    // Grey hints where an empty title or composer can be clicked (not printed).
    placeholders: { title: t('pagetext.title'), composer: t('pagetext.composer') },
    noteTextEdit: state.noteTextEdit,
    boxEdit: state.boxEdit,
  });
  if (layout.mode === 'page') {
    scoreEl.innerHTML = pages.map((svg, i) => {
      const p = layout.pages[i];
      return `<div class="paper" style="width:${p.w * state.zoom}px">${svg}</div>`;
    }).join('');
  } else {
    scoreEl.innerHTML = pages[0];
  }
  state.layout = layout;
  state.hits = hits;
  state.slots = slots;
  placeLyricInput();
  placeTextInput();
  scoreEl.classList.toggle('entry', entering());
  scoreEl.classList.toggle('erasing', state.mode === 'erase');
  scoreEl.classList.toggle('texting', state.mode === 'text');
  scoreEl.classList.toggle('marking', state.mode === 'mark');
  drawGhost();
  drawPlayhead();
  syncControls(doc);
  renderStatus();
  scrollCaretIntoView();
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
    return `<div class="tab${id === state.active ? ' active' : ''}" role="tab" data-id="${id}" data-tip="${esc(d.name)}" data-desc="${esc(d.path || t('tab.notsaved'))}${d.dirty ? esc(t('tab.unsaved')) : ''}">
      <span>${esc(d.name)}</span>${d.dirty ? `<span class="dirty" aria-label="${esc(t('tab.dirty'))}">●</span>` : ''}
      <button class="x" data-close="${id}" aria-label="${esc(t('tab.close', { name: d.name }))}">×</button></div>`;
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
    b.dataset.tip = t(`figure.${b.dataset.dur}.${state.kind}`);
    b.dataset.desc = t('palette.figure.desc');
    b.setAttribute('aria-label', b.dataset.tip);
    b.classList.toggle('on', b.dataset.dur === state.duration.base);
  });
  document.querySelectorAll('[data-kind]').forEach((b) => {
    b.classList.toggle('on', b.dataset.kind === state.kind);
    b.setAttribute('aria-checked', String(b.dataset.kind === state.kind));
  });
  document.querySelector('[data-cmd=select]').classList.toggle('on', state.mode === 'select');
  document.querySelector('[data-cmd=erase]').classList.toggle('on', state.mode === 'erase');
  document.querySelector('[data-cmd=text]').classList.toggle('on', state.mode === 'text');
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
    ? `<span class="label">${esc(t('palette.voice.single'))}</span>`
    : Array.from({ length: n }, (_, v) =>
      `<button data-voice="${v}" class="${v === current ? 'on' : ''}" data-tip="${esc(t('palette.voice.n', { n: v + 1 }))}" data-desc="${esc(t('palette.voice.desc'))}" data-key="Alt+${v + 1}">${v + 1}</button>`).join('');
  if (n < 4) html += `<button data-voice="${n}" class="add" data-tip="${esc(t('palette.voice.add', { n: n + 1 }))}" data-desc="${esc(t('palette.voice.add.desc'))}" data-key="Alt+${n + 1}">${esc(t('palette.voice.add.button'))}</button>`;
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
    const voice = voiceCount(doc) > 1 ? t('status.voice', { n: c.voice + 1 }) : '';
    parts.push(esc(t('status.position', { staff: c.staff + 1, measure: c.measure + 1 }) + voice));
    const d = state.duration;
    const base = t(`value.${d.base}`);
    const value = d.dots ? t('value.dotted', { value: base }) : base;
    const verse = state.lyric && state.layout?.verses[state.lyric.staff] > 1 ? t('status.lyrics.verse', { n: state.lyric.verse + 1 }) : '';
    const bold = (head, help) => `<b>${esc(head)}</b> ${esc(t(help))}`;
    parts.push(state.lyric
      ? bold(t('status.lyrics') + verse, 'status.lyrics.help')
      : {
        select: () => esc(t('status.select', { value })),
        note: () => bold(t('status.notes', { value }), 'status.notes.help'),
        rest: () => bold(t('status.rests', { value }), 'status.rests.help'),
        erase: () => bold(t('status.erase'), 'status.erase.help'),
        mark: () => bold(t('status.mark', { name: state.mark?.name || '' }), 'status.mark.help'),
      }[state.mode]());
    parts.push(esc(doc.dirty ? t('status.unsaved') : (doc.path ? t('status.saved') : t('status.new'))));
    parts.push(doc.protected
      ? `<span class="ok" data-tip="${esc(t('status.recovery.tip'))}" data-desc="${esc(t('status.recovery.desc'))}">${esc(t('status.recovery.on'))}</span>`
      : `<span class="warn">${esc(t('status.recovery.off'))}</span>`);
    const errors = measureErrors(doc);
    if (errors.length) {
      parts.push(`<span class="errors" data-jump data-tip="${esc(t('status.errors.tip'))}" data-desc="${esc(t('status.errors.desc'))}">${esc(tn('status.errors', errors.length))}</span>`);
    }
    if (doc.warning) parts.push(`<span class="warn">${esc(t('warning.recovery', { detail: doc.warning }))}</span>`);
    const s = playback.sound;
    if (s?.state === 'downloading') {
      const pct = s.total ? Math.min(100, Math.floor((s.received / s.total) * 100)) : 0;
      parts.push(`<span class="download" role="status" data-tip="${esc(t('status.sounds.tip'))}" data-desc="${esc(t('status.sounds.desc'))}">`
        + `${esc(t('status.sounds.downloading'))} <progress max="100" value="${pct}" aria-label="${esc(t('status.sounds.progress'))}"></progress> <b>${pct}%</b> · ${MB(s.received)} / ${MB(s.total)} MB</span>`);
    }
    if (s?.state === 'loading') parts.push(`<span class="ok">${esc(t('status.sounds.loading'))}</span>`);
    const u = updatePart();
    if (u) parts.push(u);
    const pct = Math.round(state.zoom * 100);
    parts.push(`<span class="zoom" data-zoom data-tip="${esc(t('status.zoom.tip', { pct }))}" data-desc="${esc(t('status.zoom.desc'))}" data-key="Ctrl+0">${pct}%</span>`);
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
  const target = ev.target;
  const inField = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
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
      // What is being typed (lyrics, a title) goes into the document first.
      commitLyric();
      commitTextEdit();
      handled();
      return;
    }
    if (lower === 'l') { ev.preventDefault(); runCommand('lyrics'); return; }
    if (lower === 'e') { ev.preventDefault(); commitLyric(); runCommand('note-text:expression'); return; }
  }
  // Menus and dialogs handle their own keys.
  if (target.closest?.('.menubar, dialog')) return;
  if (inField) {
    if (key === 'Escape') { target.blur(); page.focus(); }
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
  // Text boxes: the eraser removes one; otherwise a click edits it and a
  // drag moves it (see boxDrag).
  const tbox = ev.target.closest?.('[data-box]');
  if (tbox && !tbox.classList.contains('placeholder')) {
    ev.preventDefault();
    const id = Number(tbox.dataset.box);
    if (state.mode === 'erase') { act({ type: 'remove_text_box', id }); return; }
    boxDrag = { id, el: tbox, cx: ev.clientX, cy: ev.clientY, moved: false };
    return;
  }
  // The T tool: a click on a page starts a new text box there.
  if (state.mode === 'text') {
    ev.preventDefault();
    startTextBox(ev);
    return;
  }
  // Texts around the music (title, header, footer...): a click edits the
  // text there; the page number opens the dialog with all of them.
  // Words on a note and rehearsal marks: typed over where they are.
  const ntext = ev.target.closest?.('[data-ntext]');
  if (ntext && !ntext.classList.contains('placeholder')) {
    ev.preventDefault();
    openTextEdit(`note:${ntext.dataset.ntext}`);
    return;
  }
  const rehearsal = ev.target.closest?.('[data-rehearsal]');
  if (rehearsal) {
    ev.preventDefault();
    openTextEdit(`rehearsal:${rehearsal.dataset.rehearsal}`);
    return;
  }
  // A tempo marking opens its dialog.
  const tempo = ev.target.closest?.('[data-tempo]');
  if (tempo) {
    ev.preventDefault();
    tempoDialog(Number(tempo.dataset.tempo));
    return;
  }
  const ptext = ev.target.closest?.('[data-text]');
  if (ptext) {
    ev.preventDefault();
    if (ptext.dataset.text === 'pnum') pageTextsDialog();
    else openTextEdit(ptext.dataset.text);
    return;
  }
  // A staff name opens that staff's name, sound and clef.
  const name = ev.target.closest?.('.sname');
  if (name) {
    ev.preventDefault();
    staffDialog(Number(name.dataset.staff));
    return;
  }
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

// ----- dragging text boxes ------------------------------------------------------------

let boxDrag = null; // { id, el, cx, cy, moved } while a text box is held

/** Layout units per screen pixel in the page under an element. */
function layoutPerPixel(el) {
  const svg = el.ownerSVGElement || el.closest('svg');
  return svg ? svg.viewBox.baseVal.width / svg.getBoundingClientRect().width : 1;
}

window.addEventListener('mousemove', (ev) => {
  if (!boxDrag) return;
  const dx = ev.clientX - boxDrag.cx;
  const dy = ev.clientY - boxDrag.cy;
  if (!boxDrag.moved && Math.hypot(dx, dy) < 4) return;
  boxDrag.moved = true;
  const k = layoutPerPixel(boxDrag.el);
  boxDrag.el.setAttribute('transform', `translate(${dx * k} ${dy * k})`);
});
window.addEventListener('mouseup', (ev) => {
  const d = boxDrag;
  if (!d || ev.button !== 0) return;
  boxDrag = null;
  const doc = active();
  const box = doc?.score.text_boxes?.find((b) => b.id === d.id);
  if (!box) return;
  if (!d.moved) { openTextEdit(`box:${d.id}`); return; }
  // Moved: one undo step, in tenths of a millimetre on its page.
  const k = layoutPerPixel(d.el) / UNITS_PER_TENTH_MM;
  act({ type: 'set_text_box', text_box: { ...box, x: Math.round(box.x + (ev.clientX - d.cx) * k), y: Math.round(box.y + (ev.clientY - d.cy) * k) } });
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
page.addEventListener('scroll', () => { if (state.mode !== 'select') drawGhost(); placeLyricInput(); placeTextInput(); });
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

/**
 * View → Language. The texts are read once at start-up, so the page reloads
 * in the new language. Nothing is lost: documents, undo history and crash
 * recovery live in Rust, and the page reopens every tab. What is being typed
 * as lyrics is written first and playback stops; the active tab is kept.
 */
function setLanguage(code) {
  if (code === languageChoice) return;
  closeLyric();
  serial(async () => {
    if (playback.playing) await stopPlayback();
    savePref('language', code === 'system' ? null : code);
    try { sessionStorage.setItem('partita.activeTab', state.active ?? ''); } catch { /* ignore */ }
    location.reload();
  });
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
  'language:system': () => setLanguage('system'),
  ...Object.fromEntries(LANGUAGES.map((code) => [`language:${code}`, () => setLanguage(code)])),
  // Insert / notation
  'add-measure': () => act({ type: 'insert_measure' }),
  'remove-measure': () => act({ type: 'remove_measure' }),
  'add-staff': () => staffDialog(null),
  'staff-properties': () => staffDialog(active()?.caret.staff ?? 0),
  'group-bracket': () => groupSelectedStaves('bracket'),
  'group-brace': () => groupSelectedStaves('brace'),
  'group-none': () => groupSelectedStaves(null),
  'import-musicxml': () => importMusicXmlFromDialog(),
  'export-musicxml': () => exportMusicXml(),
  'remove-staff': () => act({ type: 'remove_staff' }),
  tie: () => act({ type: 'toggle_tie' }),
  slur: () => act({ type: 'toggle_slur' }),
  lyrics: () => (state.lyric ? closeLyric() : startLyricsAtCaret()),
  select: () => setMode('select'),
  erase: () => setMode(state.mode === 'erase' ? 'select' : 'erase'),
  text: () => setMode(state.mode === 'text' ? 'select' : 'text'),
  'text-styles': () => textStylesDialog(),
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
    showError(t('error.noaudio', { message: s.message }));
    return false;
  }
  if (s.state === 'missing' || s.state === 'error') {
    const detail = s.state === 'error' ? `<p class="warn">${esc(t('sounds.failed', { message: s.message }))}</p>` : '';
    const ok = await askDialog(t('sounds.title'), t('sounds.body') + detail, t('sounds.download'));
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
      showError(t('error.sounds', { message: s.message }));
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
  btn.setAttribute('aria-label', playback.playing ? t('toolbar.pause') : t('toolbar.play'));
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
lyric.input.setAttribute('aria-label', t('lyrics.input'));
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
  // In the lyrics' style, which may have changed since the last syllable.
  const lst = currentStyle('lyrics');
  lyric.ctx ||= document.createElement('canvas').getContext('2d');
  lyric.ctx.font = cssFont(lst);
  const px = lst.size * scale;
  const width = Math.max(2.4 * px, lyric.ctx.measureText(lyric.input.value).width * scale + 1.2 * px);
  // Hidden while its note is scrolled out of the score area.
  const area = page.getBoundingClientRect();
  const inside = at.x > area.left && at.x < area.right && at.y > area.top + px && at.y < area.bottom;
  Object.assign(lyric.input.style, {
    font: cssFont(lst, px),
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
    if (dir > 0) serial(() => { state.error = t('error.lyrics.last'); renderStatus(); });
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
    showError(t('error.lyrics.nonotes'));
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
    `<rect class="lyric-hover" x="${slot.x - 1.7 * SP}" y="${y - 1.45 * SP}" width="${3.4 * SP}" height="${2 * SP}" rx="3"><title>${esc(t('lyrics.hover'))}</title></rect>`);
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

// ----- texts around the music ---------------------------------------------------
// The title, composer, header, footer... are drawn in the score (render.js,
// drawPageTexts). Clicking one opens a text field over it: Enter or a click
// elsewhere writes it (one undo step), Esc leaves it as it was. The dialog
// (Score → Titles, Header and Footer…) has every text and the page numbers.

const textEdit = {
  key: null, // what is being typed: see textTarget
  input: Object.assign(document.createElement('input'), {
    className: 'lyric-input text-input', type: 'text', autocomplete: 'off', hidden: true,
  }),
  // Text boxes have several lines: Enter keeps them, Shift+Enter starts a new line.
  area: Object.assign(document.createElement('textarea'), {
    className: 'lyric-input text-input text-area', spellcheck: false, rows: 1, hidden: true,
  }),
  field: null, // the one in use
};
document.body.append(textEdit.input, textEdit.area);

const metadataOf = (doc) => fullMetadata(doc.score.metadata);

/** Writes every text of the score at once (the backend takes them all). */
function setMetadata(changes) {
  const doc = active();
  if (doc) act({ type: 'set_metadata', ...metadataOf(doc), ...changes });
}

/**
 * What a text field edits, by key: a page text ('title', 'footer'…), words
 * on a note ('note:<id>:<kind>'), a rehearsal mark ('rehearsal:<measure>')
 * or a text box ('box:<id>', 'box:new'). `kind` is the style it is drawn in
 * (TextKind in model.rs); a text box has its own (`box`).
 */
function textTarget(key, doc) {
  const [type, a, b] = key.split(':');
  if (type === 'note') {
    const found = findEvent(doc, Number(a));
    return {
      kind: b,
      selector: `[data-ntext="${a}:${b}"]`,
      value: found?.e.texts?.find((nt) => nt.kind === b)?.text ?? '',
      label: t(`notetext.${b}`),
      write: (text) => act({ type: 'set_note_text', id: Number(a), kind: b, text }),
    };
  }
  if (type === 'rehearsal') {
    const measure = Number(a);
    return {
      kind: 'rehearsal',
      selector: `[data-rehearsal="${measure}"] text`,
      value: doc.score.measures[measure]?.rehearsal ?? '',
      label: t('rehearsal.label'),
      write: (text) => act({ type: 'set_rehearsal', measure, text: text || null }),
    };
  }
  if (type === 'box') {
    const draft = state.boxEdit;
    const saved = doc.score.text_boxes?.find((x) => String(x.id) === a);
    return {
      box: true,
      selector: `[data-box="${a}"] text`,
      value: saved?.text ?? '',
      label: t('textbox.label'),
      // Words, look and place together: one undo step.
      write: (text) => {
        const { id, page, x, y, style, align, frame } = draft;
        act({ type: 'set_text_box', text_box: { id: id === 'new' ? 0 : id, page, x, y, text, style, align, frame } });
      },
      changed: () => !!saved && (JSON.stringify(saved.style || {}) !== JSON.stringify(draft.style)
        || (saved.align || 'left') !== draft.align || !!saved.frame !== draft.frame),
    };
  }
  return {
    kind: key,
    selector: `[data-text="${key}"]`,
    value: metadataOf(doc)[key],
    label: t(`pagetext.${key}`),
    write: (text) => setMetadata({ [key]: text }),
  };
}

function openTextEdit(key) {
  const doc = active();
  if (!doc) return;
  if (state.lyric) closeLyric();
  commitTextEdit();
  const [type, id, kind] = key.split(':');
  if (type === 'box' && id !== 'new') {
    const saved = doc.score.text_boxes?.find((x) => String(x.id) === id);
    if (!saved) return;
    state.boxEdit = { ...saved, style: { ...(saved.style || {}) }, align: saved.align || 'left', frame: !!saved.frame };
  }
  const target = textTarget(key, doc);
  textEdit.key = key;
  textEdit.field = target.box ? textEdit.area : textEdit.input;
  textEdit.field.value = target.value;
  textEdit.field.setAttribute('aria-label', target.label);
  textEdit.field.hidden = false;
  // New words on a note: drawn as a hint where they will go, to type over.
  if (type === 'note' && !target.value) {
    state.noteTextEdit = { id: Number(id), kind, hint: t(`notetext.${kind}.hint`) };
  }
  render();
  showFormatBar();
  textEdit.field.focus({ preventScroll: true });
  textEdit.field.select();
}

/** Puts the field over its text (after every render and scroll), in the text's own font and size. */
function placeTextInput() {
  const key = textEdit.key;
  const doc = active();
  const field = textEdit.field;
  if (!key || !doc || !field) return;
  const el = $('score').querySelector(textTarget(key, doc).selector);
  const svg = el?.ownerSVGElement;
  if (!el || !svg) { field.style.visibility = 'hidden'; formatBar.hidden = true; return; }
  const box = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const scale = box.width / vb.width;
  const px = Number(el.getAttribute('font-size') || 15) * scale;
  const r = el.getBoundingClientRect();
  const anchor = el.getAttribute('text-anchor') || 'start';
  const lines = field === textEdit.area ? Math.max(1, field.value.split('\n').length) : 1;
  const width = Math.max(r.width + 3 * px, 10 * px);
  const left = anchor === 'start' ? r.left - 0.3 * px : anchor === 'end' ? r.right - width + 0.3 * px : r.left + r.width / 2 - width / 2;
  const baseline = box.top + (Number(el.getAttribute('y')) - vb.y) * scale;
  const style = getComputedStyle(el);
  Object.assign(field.style, {
    font: `${style.fontStyle} ${style.fontWeight} ${px}px ${style.fontFamily}`,
    lineHeight: field === textEdit.area ? `${1.25 * px}px` : '',
    textAlign: anchor === 'start' ? 'left' : anchor === 'end' ? 'right' : 'center',
    left: `${left}px`,
    top: `${baseline - 1.16 * px}px`, // the text's baseline lands on the drawn one
    width: `${width}px`,
    height: `${(lines - 1) * 1.25 * px + 1.5 * px}px`,
    visibility: 'visible',
  });
  placeFormatBar();
}

/** Leaves the field, writing what was typed unless `cancel`. */
function commitTextEdit(cancel = false) {
  const key = textEdit.key;
  if (!key) return;
  const doc = active();
  const target = doc && textTarget(key, doc);
  const field = textEdit.field;
  textEdit.key = null;
  field.hidden = true;
  formatBar.hidden = true;
  const value = target?.box ? field.value.replace(/\s+$/, '') : field.value.trim();
  const write = !cancel && target && (value !== target.value || target.changed?.()) && (value || target.value);
  if (write) target.write(value);
  const hinted = !!(state.noteTextEdit || state.boxEdit);
  state.noteTextEdit = null;
  state.boxEdit = null;
  if (!write && hinted) render();
  page.focus();
}

for (const field of [textEdit.input, textEdit.area]) {
  field.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !(field === textEdit.area && ev.shiftKey)) { ev.preventDefault(); commitTextEdit(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); commitTextEdit(true); }
  });
  field.addEventListener('input', () => { if (field === textEdit.area) placeTextInput(); });
  // Using the format bar keeps the field open.
  field.addEventListener('blur', (ev) => { if (!formatBar.contains(ev.relatedTarget)) commitTextEdit(); });
}

// ----- text boxes ------------------------------------------------------------------
// The T tool: a click on a page starts a box there (page view only, as a box
// belongs to a place on a page). Click a box to change it, drag to move it,
// erase it with the eraser or by leaving it empty.

function startTextBox(ev) {
  const lay = state.layout;
  if (!lay || lay.mode !== 'page') { showError(t('error.textbox.pageview')); return; }
  const p = pointerInLayout(ev.clientX, ev.clientY);
  const pg = p && lay.pages.find((g) => p.y >= g.y && p.y < g.y + g.h);
  if (!pg) return;
  const size = TEXT_DEFAULTS.text_box.size;
  state.mode = 'select';
  state.boxEdit = {
    id: 'new',
    page: pg.index,
    x: Math.round((p.x - pg.x) / UNITS_PER_TENTH_MM),
    // The click is the top of the first line.
    y: Math.round((p.y - pg.y + 0.8 * size) / UNITS_PER_TENTH_MM),
    style: {},
    align: 'left',
    frame: false,
    hint: t('textbox.hint'),
  };
  openTextEdit('box:new');
}

// ----- formatting ------------------------------------------------------------------
// While a text is typed, a bar above it sets its font, size, bold and
// italic. For a kind of text (title, tempo, expression…) that is the style
// of every text of the kind (one undo step each change); a text box has its
// own, written with its words.

const FONTS = ['Georgia', 'Times New Roman', 'Palatino Linotype', 'Book Antiqua', 'Garamond', 'Cambria',
  'Arial', 'Helvetica', 'Segoe UI', 'Calibri', 'Verdana', 'Trebuchet MS', 'Courier New'];
const ptOf = (st) => Math.round((st.size / UNITS_PER_PT) * 2) / 2;

/** `<option>`s for a font list, with `current` added if it is not one of them. */
function fontOptions(current) {
  const list = current && !FONTS.includes(current) ? [current, ...FONTS] : FONTS;
  return `<option value="">${esc(t('format.font.default'))}</option>`
    + list.map((f) => `<option value="${esc(f)}" style="font-family:'${esc(f)}'"${f === current ? ' selected' : ''}>${esc(f)}</option>`).join('');
}

const formatBar = Object.assign(document.createElement('div'), { className: 'format-bar', hidden: true });
formatBar.setAttribute('role', 'toolbar');
document.body.append(formatBar);

/** The style being set: of the text box being typed, or of the kind of text. */
function formatTarget() {
  const doc = active();
  if (!doc || !textEdit.key) return null;
  const target = textTarget(textEdit.key, doc);
  if (target.box) return { box: true, style: state.boxEdit.style, resolved: resolveStyle('text_box', state.boxEdit.style) };
  return { kind: target.kind, style: { ...(doc.score.text_styles?.[target.kind] || {}) }, resolved: currentStyle(target.kind) };
}

function showFormatBar() {
  const f = formatTarget();
  if (!f) return;
  const st = f.resolved;
  const pressed = (on) => ` aria-pressed="${on}"${on ? ' class="on"' : ''}`;
  formatBar.innerHTML = `<select class="fb-font" aria-label="${esc(t('format.font'))}" data-tip="${esc(t('format.font'))}">${fontOptions(st.font)}</select>
    <input class="fb-size" type="number" min="4" max="72" step="0.5" value="${ptOf(st)}" aria-label="${esc(t('format.size'))}" data-tip="${esc(t('format.size'))}"><span class="fb-pt">pt</span>
    <button type="button" data-fmt="bold"${pressed(st.bold)} data-tip="${esc(t('format.bold'))}"><b>${esc(t('format.bold.short'))}</b></button>
    <button type="button" data-fmt="italic"${pressed(st.italic)} data-tip="${esc(t('format.italic'))}"><i>${esc(t('format.italic.short'))}</i></button>
    ${f.box ? ['left', 'center', 'right'].map((a) =>
      `<button type="button" data-fmt="align-${a}"${pressed(state.boxEdit.align === a)} data-tip="${esc(t(`format.align.${a}`))}"><svg class="icon"><use href="#i-align-${a}"/></svg></button>`).join('')
      + `<button type="button" data-fmt="frame"${pressed(state.boxEdit.frame)} data-tip="${esc(t('format.frame'))}"><svg class="icon"><use href="#i-frame"/></svg></button>`
      : `<button type="button" data-fmt="reset" data-tip="${esc(t('format.reset'))}" data-desc="${esc(t('format.reset.desc', { kind: t(`textkind.${f.kind}`) }))}">↺</button>`}`;
  formatBar.hidden = false;
  placeFormatBar();
}

function placeFormatBar() {
  const field = textEdit.field;
  if (formatBar.hidden || !field || field.hidden) return;
  const r = field.getBoundingClientRect();
  const h = formatBar.offsetHeight || 34;
  const top = r.top - h - 6 > 4 ? r.top - h - 6 : r.bottom + 6;
  const left = Math.max(4, Math.min(r.left, window.innerWidth - formatBar.offsetWidth - 4));
  Object.assign(formatBar.style, { left: `${left}px`, top: `${top}px` });
}

/** Applies a change of look, then goes back to typing. */
function applyFormat(change) {
  const f = formatTarget();
  if (!f) return;
  if (f.box) {
    Object.assign(state.boxEdit, change.box || {});
    state.boxEdit.style = { ...state.boxEdit.style, ...(change.style || {}) };
    render();
  } else if (change.reset) {
    act({ type: 'set_text_style', kind: f.kind, style: {} });
  } else {
    act({ type: 'set_text_style', kind: f.kind, style: { ...f.style, ...change.style } });
  }
  // Redraw the bar once the change is in.
  queue.then(() => { if (textEdit.key) { showFormatBar(); textEdit.field.focus({ preventScroll: true }); } });
}

formatBar.addEventListener('mousedown', (ev) => { if (ev.target.closest('button')) ev.preventDefault(); });
formatBar.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-fmt]');
  const f = b && formatTarget();
  if (!f) return;
  const st = f.resolved;
  const fmt = b.dataset.fmt;
  if (fmt === 'bold') applyFormat({ style: { bold: !st.bold } });
  else if (fmt === 'italic') applyFormat({ style: { italic: !st.italic } });
  else if (fmt === 'frame') applyFormat({ box: { frame: !state.boxEdit.frame } });
  else if (fmt.startsWith('align-')) applyFormat({ box: { align: fmt.slice(6) } });
  else if (fmt === 'reset') applyFormat({ reset: true });
});
formatBar.addEventListener('change', (ev) => {
  if (ev.target.matches('.fb-font')) applyFormat({ style: { font: ev.target.value } });
  if (ev.target.matches('.fb-size')) {
    const pt = Number(ev.target.value);
    if (pt >= 4 && pt <= 72) applyFormat({ style: { size: Math.round(pt * 10) } });
  }
});
formatBar.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { ev.preventDefault(); textEdit.field?.focus(); }
  if (ev.key === 'Enter' && ev.target.matches('.fb-size')) { ev.preventDefault(); ev.target.blur(); }
});
// Leaving the bar for anywhere but the field ends the typing.
formatBar.addEventListener('focusout', (ev) => {
  if (ev.relatedTarget !== textEdit.field && !formatBar.contains(ev.relatedTarget)) commitTextEdit();
});

/** Score → Text Styles…: the look of every kind of text at once. */
async function textStylesDialog() {
  const doc = active();
  if (!doc) return;
  commitTextEdit();
  const rows = TEXT_KINDS.map((k) => {
    const st = currentStyle(k);
    return `<tr data-kind="${k}">
      <th>${esc(t(`textkind.${k}`))}</th>
      <td><select class="ts-font" aria-label="${esc(t('format.font'))}">${fontOptions(st.font)}</select></td>
      <td><input class="ts-size" type="number" min="4" max="72" step="0.5" value="${ptOf(st)}" aria-label="${esc(t('format.size'))}"> pt</td>
      <td><label class="check"><input type="checkbox" class="ts-bold"${st.bold ? ' checked' : ''}> <b>${esc(t('format.bold.short'))}</b></label></td>
      <td><label class="check"><input type="checkbox" class="ts-italic"${st.italic ? ' checked' : ''}> <i>${esc(t('format.italic.short'))}</i></label></td>
    </tr>`;
  }).join('');
  const body = `<form class="styles-form" id="styles-form"><table class="styles-table">
    <thead><tr><th></th><th>${esc(t('format.font'))}</th><th>${esc(t('format.size'))}</th><th></th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="muted hint">${esc(t('styles.hint'))}</p></form>`;
  const pending = choiceDialog(t('styles.title'), body, [
    { label: t('styles.reset'), value: 'reset' },
    { spacer: true },
    { label: t('button.cancel'), value: 'cancel' },
    { label: t('button.ok'), value: 'ok', primary: true },
  ]);
  const answer = await pending;
  if (answer === 'reset') { act({ type: 'set_text_styles', styles: Object.fromEntries(TEXT_KINDS.map((k) => [k, {}])) }); return; }
  if (answer !== 'ok') return;
  // Only what differs from each kind's default is kept.
  const styles = {};
  for (const row of $('styles-form').querySelectorAll('tr[data-kind]')) {
    const k = row.dataset.kind;
    const d = resolveStyle(k);
    const pt = Number(row.querySelector('.ts-size').value);
    const bold = row.querySelector('.ts-bold').checked;
    const italic = row.querySelector('.ts-italic').checked;
    styles[k] = {
      font: row.querySelector('.ts-font').value,
      size: pt >= 4 && pt <= 72 && pt !== ptOf(d) ? Math.round(pt * 10) : 0,
      bold: bold === d.bold ? null : bold,
      italic: italic === d.italic ? null : italic,
    };
  }
  act({ type: 'set_text_styles', styles });
}

/**
 * Notes → Expression / Technique: words on the note before the caret (or
 * the one at it, at the start of a measure).
 */
function startNoteText(kind) {
  const doc = active();
  if (!doc) return;
  const c = doc.caret;
  const voice = doc.score.staves[c.staff]?.measures[c.measure]?.voices[c.voice] || [];
  const e = voice[c.index - 1] || voice[c.index];
  if (!e) { showError(t('error.notetext.nonote')); return; }
  openTextEdit(`note:${e.id}:${kind}`);
}

/**
 * Score → Rehearsal Mark: the next letter (A, B, C… after the last one
 * before the caret's measure) at the start of that measure; if it has one
 * already, it opens to be changed.
 */
function rehearsalMark() {
  const doc = active();
  if (!doc) return;
  const m = doc.caret.measure;
  if (doc.score.measures[m]?.rehearsal) { openTextEdit(`rehearsal:${m}`); return; }
  const before = doc.score.measures.slice(0, m).map((a) => a.rehearsal).filter((r) => /^[A-Z]$/.test(r || ''));
  const last = before.at(-1);
  const next = last && last < 'Z' ? String.fromCharCode(last.charCodeAt(0) + 1) : 'A';
  act({ type: 'set_rehearsal', measure: m, text: next });
}

// Page number positions offered in the dialog: edge and place across.
const PAGE_NUMBER_PLACES = ['top-left', 'top-center', 'top-right', 'top-outside', 'bottom-left', 'bottom-center', 'bottom-right', 'bottom-outside'];
const TOKENS = ['page', 'pages', 'title', 'composer'];

/** Score → Titles, Header and Footer…: every text around the music, and page numbers. */
async function pageTextsDialog() {
  const doc = active();
  if (!doc) return;
  commitTextEdit();
  const m = metadataOf(doc);
  const pn = m.page_numbers;
  const field = (key, wide = false) => `<label${wide ? ' class="wide"' : ''}>${esc(t(`pagetext.${key}`))}
      <input type="text" data-field="${key}" value="${esc(m[key])}" placeholder="${esc(t(`pagetext.${key}.example`))}" autocomplete="off"></label>`;
  const body = `<form class="staff-form texts-form" id="texts-form">
    <h3>${esc(t('texts.page1'))}</h3>
    ${field('title', true)}
    ${field('subtitle', true)}
    <div class="row">${field('lyricist')}${field('composer')}</div>
    <div class="row">${field('part')}${field('dedication')}</div>
    ${field('copyright', true)}
    <h3>${esc(t('texts.pages'))}</h3>
    <div class="row">${field('header')}${field('footer')}</div>
    <h3>${esc(t('texts.numbers'))}</h3>
    <label class="check"><input type="checkbox" id="pn-show"${pn.show ? ' checked' : ''}> ${esc(t('texts.numbers.show'))}</label>
    <div class="row">
      <label>${esc(t('texts.numbers.place'))}
        <select id="pn-place">${PAGE_NUMBER_PLACES.map((place) =>
          `<option value="${place}"${place === `${pn.edge}-${pn.align}` ? ' selected' : ''}>${esc(t(`texts.place.${place}`))}</option>`).join('')}</select></label>
      <label>${esc(t('texts.numbers.format'))}
        <input type="text" id="pn-format" value="${esc(pn.format)}" autocomplete="off"></label>
    </div>
    <label class="check"><input type="checkbox" id="pn-first"${pn.first_page ? ' checked' : ''}> ${esc(t('texts.numbers.first'))}</label>
    <div class="tokens"><span class="muted">${esc(t('texts.tokens'))}</span>${TOKENS.map((k) =>
      `<button type="button" data-token="{${k}}" data-tip="{${k}}">${esc(t(`texts.token.${k}`))}</button>`).join('')}</div>
    <p class="muted hint">${esc(t('texts.hint'))}</p>
  </form>`;
  const pending = choiceDialog(t('texts.title'), body, [
    { spacer: true },
    { label: t('button.cancel'), value: 'cancel' },
    { label: t('button.ok'), value: 'ok', primary: true },
  ]);
  const form = $('texts-form');
  // The token buttons type into the field last used (or the page number text).
  let target = $('pn-format');
  form.addEventListener('focusin', (ev) => { if (ev.target.matches('input[type="text"]')) target = ev.target; });
  form.addEventListener('mousedown', (ev) => { if (ev.target.closest('[data-token]')) ev.preventDefault(); });
  form.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-token]');
    if (!b) return;
    target.setRangeText(b.dataset.token, target.selectionStart ?? target.value.length, target.selectionEnd ?? target.value.length, 'end');
    target.focus();
  });
  form.addEventListener('submit', (ev) => { ev.preventDefault(); $('dialog').querySelector('[data-answer="ok"]').click(); });
  form.querySelector('[data-field="title"]').focus();
  const answer = await pending;
  if (answer !== 'ok') return;
  const changes = {};
  for (const input of form.querySelectorAll('[data-field]')) changes[input.dataset.field] = input.value.trim();
  const [edge, align] = $('pn-place').value.split('-');
  changes.page_numbers = {
    show: $('pn-show').checked, edge, align, first_page: $('pn-first').checked, format: $('pn-format').value.trim() || '{page}',
  };
  setMetadata(changes);
}

// ----- tempo markings --------------------------------------------------------------
// Words and a metronome mark at the start of a measure (TempoMark in
// model.rs). Score → Tempo Marking… opens it for the caret's measure, and
// clicking a printed marking opens that one. In the first measure the
// metronome value is the opening tempo, the toolbar's.

// Usual tempo words, offered as suggestions (the same in every language).
const TEMPO_WORDS = ['Grave', 'Largo', 'Lento', 'Adagio', 'Andante', 'Andante con moto', 'Andantino', 'Moderato',
  'Allegretto', 'Allegro', 'Allegro moderato', 'Allegro vivace', 'Vivace', 'Presto', 'Prestissimo', 'a tempo',
  'Tempo I', 'rit.', 'rall.', 'accel.', 'Più mosso', 'Meno mosso'];

// What a marking prints: words and metronome mark, one of them, or nothing
// (it still plays).
const TEMPO_SHOW = ['both', 'text', 'metronome', 'none'];
const showOf = (mark) => (mark.show_text ? (mark.show_metronome ? 'both' : 'text') : mark.show_metronome ? 'metronome' : 'none');

/** Playback tempo in force in measure `m` (quarter notes per minute). */
function tempoAt(score, m) {
  let bpm = score.tempo ?? 100;
  for (let i = 1; i <= m; i++) if (score.measures[i]?.tempo?.bpm) bpm = score.measures[i].tempo.bpm;
  return bpm;
}

async function tempoDialog(measure) {
  const doc = active();
  if (!doc) return;
  const score = doc.score;
  const first = measure === 0;
  const current = score.measures[measure]?.tempo || null;
  const mark = current || { text: '', bpm: null, beat: 'quarter', show_text: true, show_metronome: true };
  const beat = BEATS[mark.beat] ? mark.beat : 'quarter';
  // The value shown: this marking's, or the tempo already in force here.
  const quarter = first ? score.tempo ?? 100 : mark.bpm ?? tempoAt(score, measure);
  const changes = first || mark.bpm != null || !current;
  const body = `<form class="staff-form tempo-form" id="tempo-form">
    <label>${esc(t('tempo.text'))}
      <input type="text" id="tempo-text" list="tempo-words" value="${esc(mark.text)}" placeholder="${esc(t('tempo.text.example'))}" autocomplete="off"></label>
    <datalist id="tempo-words">${TEMPO_WORDS.map((w) => `<option value="${esc(w)}">`).join('')}</datalist>
    ${first ? '' : `<label class="check"><input type="checkbox" id="tempo-changes"${changes ? ' checked' : ''}> ${esc(t('tempo.changes'))}</label>`}
    <div class="row" id="tempo-metronome">
      <label>${esc(t('tempo.beat'))}
        <select id="tempo-beat">${Object.keys(BEATS).map((b) =>
          `<option value="${b}"${b === beat ? ' selected' : ''}>${esc(t(`tempo.beat.${b}`))}</option>`).join('')}</select></label>
      <label>${esc(t('tempo.per_minute'))}
        <input type="number" id="tempo-number" min="5" max="999" value="${perMinute(quarter, beat)}"></label>
    </div>
    <label>${esc(t('tempo.show'))}
      <select id="tempo-show">${TEMPO_SHOW.map((v) =>
        `<option value="${v}"${v === showOf(mark) ? ' selected' : ''}>${esc(t(`tempo.show.${v}`))}</option>`).join('')}</select></label>
    <p class="muted hint">${esc(t(first ? 'tempo.hint.first' : 'tempo.hint'))}</p>
  </form>`;
  const pending = choiceDialog(t('tempo.title', { n: measure + 1 }), body, [
    ...(current ? [{ label: t('tempo.remove'), value: 'remove' }] : []),
    { spacer: true },
    { label: t('button.cancel'), value: 'cancel' },
    { label: t('button.ok'), value: 'ok', primary: true },
  ]);
  const number = $('tempo-number');
  const beatSel = $('tempo-beat');
  const changesBox = $('tempo-changes');
  // Keep the same speed when the beat unit changes (♩ = 90 is ♩. = 60).
  let lastBeat = beat;
  beatSel.addEventListener('change', () => {
    const q = toQuarterBpm(Number(number.value) || 0, lastBeat);
    lastBeat = beatSel.value;
    if (q) number.value = perMinute(q, lastBeat);
  });
  // Words alone ("a tempo", "dolce") have no metronome mark to print.
  const show = $('tempo-show');
  const syncChanges = () => {
    const on = !changesBox || changesBox.checked;
    $('tempo-metronome').classList.toggle('disabled', !on);
    number.disabled = beatSel.disabled = !on;
    for (const o of show.options) if (o.value === 'both' || o.value === 'metronome') o.disabled = !on;
    if (!on && (show.value === 'both' || show.value === 'metronome')) show.value = 'text';
  };
  changesBox?.addEventListener('change', syncChanges);
  syncChanges();
  $('tempo-form').addEventListener('submit', (ev) => { ev.preventDefault(); $('dialog').querySelector('[data-answer="ok"]').click(); });
  $('tempo-text').focus();
  const answer = await pending;
  if (answer === 'remove') { act({ type: 'set_tempo_mark', measure, mark: null }); return; }
  if (answer !== 'ok') return;
  const text = $('tempo-text').value.trim();
  const withValue = !changesBox || changesBox.checked;
  const q = toQuarterBpm(Number(number.value) || 0, beatSel.value);
  if (withValue && (q < 20 || q > 400)) { showError(t('error.tempo')); return; }
  const next = {
    text,
    bpm: withValue ? q : null,
    beat: beatSel.value,
    show_text: show.value === 'both' || show.value === 'text',
    show_metronome: withValue && (show.value === 'both' || show.value === 'metronome'),
  };
  // Nothing to print and no tempo to set: no marking.
  if (!first && !text && !withValue) { act({ type: 'set_tempo_mark', measure, mark: null }); return; }
  act({ type: 'set_tempo_mark', measure, mark: next });
}

// ----- dialogs ---------------------------------------------------------------

/** A yes/no dialog. Resolves true when the user picks the OK button. */
function askDialog(title, bodyHtml, okLabel) {
  const dlg = $('dialog');
  dlg.innerHTML = `<h2>${esc(title)}</h2><div class="dialog-body">${bodyHtml}</div>
    <div class="dialog-actions"><button type="button" data-answer="no">${esc(t('button.cancel'))}</button><button type="button" data-answer="yes" class="primary" autofocus>${esc(okLabel)}</button></div>`;
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

// Help → Keyboard Shortcuts: [keys, text key] by group. The description is
// shortcuts.<id>; the keys are translated key by key (keyLabel), unless the
// language gives the whole cell as shortcuts.<id>.keys (for words such as
// "Click under a staff").
const SHORTCUTS = [
  ['entry', [
    ['A – G', 'entry.note'],
    ['Shift + A – G', 'entry.chord'],
    ['R or 0', 'entry.rest'],
    ['1 – 7', 'entry.value'],
    ['8 / 9', 'entry.extended'],
    ['.', 'entry.dot'],
    ['+ / −', 'entry.accidental'],
    ['Alt + ↑ / ↓', 'entry.move'],
    ['T', 'entry.tie'],
    ['S', 'entry.slur'],
    ['Ctrl + E', 'entry.expression'],
    ['N', 'entry.mouse'],
    ['X', 'entry.eraser'],
    ['Alt + 1 – 4', 'entry.voice'],
  ]],
  ['lyrics', [
    ['Ctrl + L', 'lyrics.start'],
    ['Click under a staff', 'lyrics.click'],
    ['Space', 'lyrics.space'],
    ['-', 'lyrics.hyphen'],
    ['_', 'lyrics.extender'],
    ['← / →', 'lyrics.notes'],
    ['↓ / ↑', 'lyrics.verses'],
    ['Backspace', 'lyrics.back'],
    ['Esc or Enter', 'lyrics.finish'],
  ]],
  ['moving', [
    ['← / →', 'moving.notes'],
    ['↑ / ↓', 'moving.staves'],
    ['Home / End', 'moving.measure'],
    ['Ctrl + ← / →', 'moving.measures'],
    ['Ctrl + Home / End', 'moving.score'],
    ['Shift + any move', 'moving.extend'],
    ['Click / drag', 'moving.click'],
    ['Shift + click', 'moving.shiftclick'],
    ['Ctrl + A', 'moving.all'],
    ['Esc', 'moving.esc'],
  ]],
  ['navigation', [
    ['Wheel', 'navigation.wheel'],
    ['Ctrl + wheel', 'navigation.ctrlwheel'],
    ['Alt + wheel', 'navigation.altwheel'],
    ['Middle button + drag', 'navigation.pan'],
    ['Ctrl + = / Ctrl + −', 'navigation.zoom'],
    ['Ctrl + 0', 'navigation.zoom100'],
  ]],
  ['playback', [
    ['Space', 'playback.play'],
    ['Shift + Space', 'playback.start'],
    ['Esc (while playing)', 'playback.stop'],
  ]],
  ['editing', [
    ['Backspace / Del', 'editing.delete'],
    ['Ctrl + X / C / V', 'editing.clipboard'],
    ['Ctrl + Z / Y', 'editing.undo'],
    ['Ctrl + Enter', 'editing.measure'],
  ]],
  ['files', [
    ['Ctrl + N / O', 'files.newopen'],
    ['Ctrl + S', 'files.save'],
    ['Ctrl + P', 'files.print'],
    ['Ctrl + W', 'files.close'],
    ['Ctrl + Tab', 'files.nexttab'],
    ['Alt', 'files.menu'],
    ['F1', 'files.help'],
  ]],
];
const shortcutKeys = (keys, id) => (has(`shortcuts.${id}.keys`) ? t(`shortcuts.${id}.keys`) : keyLabel(keys));

// Title and Close stay put; only the body scrolls when the window is short.
function openDialog(title, body, extraButtons = '') {
  const dlg = $('dialog');
  dlg.innerHTML = `<h2>${title}</h2><div class="dialog-body">${body}</div>`
    + `<div class="dialog-actions">${extraButtons}<span class="spacer"></span><button type="button" data-close autofocus>${esc(t('button.close'))}</button></div>`;
  dlg.showModal();
}

function showDialog(which) {
  if (which === 'about' || which === 'credits') return serial(() => showAbout(which === 'credits'));
  openDialog(esc(t('shortcuts.title')), `<div class="shortcut-cols">${SHORTCUTS.map(([group, rows]) =>
    `<section><h3>${esc(t(`shortcuts.group.${group}`))}</h3><table>${rows.map(([k, id]) =>
      `<tr><td><kbd>${esc(shortcutKeys(k, id))}</kbd></td><td>${esc(t(`shortcuts.${id}`))}</td></tr>`).join('')}</table></section>`).join('')}</div>`);
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
    return `<span class="download" role="status" data-tip="${esc(t('status.update.tip', { version: u.version }))}" data-desc="${esc(t('status.update.desc'))}">`
      + `${esc(t('status.update.downloading'))} <progress max="100" value="${pct}" aria-label="${esc(t('status.update.progress'))}"></progress> <b>${pct}%</b></span>`;
  }
  if (u?.state === 'ready') {
    return `<span class="update" data-update data-tip="${esc(t('status.update.ready.tip', { version: u.version }))}" data-desc="${esc(t('status.update.ready.desc'))}">${esc(t('status.update.ready'))}</span>`;
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
    await choiceDialog(t('update.uptodate.title'), `<p>${t('update.uptodate.body', { version: esc(s.current) })}</p>`,
      [{ label: t('button.ok'), value: 'ok', primary: true }]);
  } else if (manual && s.state === 'error') {
    await choiceDialog(t('update.error.title'),
      `<p>${esc(t('update.error.body'))}</p><p class="muted">${esc(s.message)}</p>`,
      [{ label: t('button.ok'), value: 'ok', primary: true }]);
  } else if (s.state === 'error') {
    console.warn('[partita] update check failed:', s.message);
  }
}

async function offerUpdate(info) {
  const date = info.date ? ` ${esc(t('update.available.date', { date: info.date }))}` : '';
  const answer = await choiceDialog(t('update.available.title', { version: info.version }),
    `<p>${esc(t('update.available.current', { version: info.current }))}${date} ${link(releaseUrl(info.version), t('update.available.whatsnew'))}</p>
     <p>${esc(t('update.available.body'))}</p>`,
    [
      { label: t('update.skip'), value: 'skip' },
      { spacer: true },
      { label: t('button.later'), value: 'later' },
      { label: t('update.download'), value: 'download', primary: true },
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
      if (s.state === 'error') { showError(t('error.update.download', { message: s.message })); return; }
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
  const keep = dirty ? `<p>${esc(t('update.restart.keep'))}</p>` : '';
  const answer = await choiceDialog(t('update.restart.title', { version: u.version }),
    `<p>${esc(t('update.restart.body'))}</p>${keep}`,
    [{ label: t('button.later'), value: 'later' }, { label: t('update.restart.now'), value: 'restart', primary: true }]);
  if (answer !== 'restart') return;
  if (playback.playing) await stopPlayback();
  try {
    await invoke('install_update');
  } catch (e) {
    updates.status = { state: 'error', message: errorText(e) };
    renderStatus();
    showError(t('error.update.install', { message: errorText(e) }));
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
    ? `<span class="ok">${esc(t('about.sf.installed'))}</span> · ${MB(sf.size_bytes)} MB`
    : sf.status.state === 'downloading'
      ? `<span class="ok">${esc(t('about.sf.downloading'))}</span>`
      : `<span class="muted">${esc(t('about.sf.missing'))}</span>`;
  const body = `
    <div class="about-head">
      <img src="app-icon.png" alt="" width="56" height="56">
      <div>
        <div class="about-name">Partita <span class="about-version">${esc(a.version)}</span></div>
        <div class="muted">${esc(t('about.tagline'))} · ${esc(platform)}</div>
        <div class="muted">${esc(t('about.license', { link: '\u0000' })).replace('\u0000', link('https://www.gnu.org/licenses/gpl-3.0.html', t('about.license.name')))}</div>
      </div>
    </div>
    <p class="about-links">${link(a.repository, t('about.source'))} · ${link(a.issues, t('about.report'))} · ${link(`${a.repository}/blob/main/CHANGELOG.md`, t('about.whatsnew'))}</p>

    <h3>${esc(t('about.downloaded'))}</h3>
    <table class="about-table">
      <tr><th>${esc(sf.name)} ${esc(sf.version)}</th><td>${sfState}</td></tr>
      <tr><td colspan="2" class="muted">${esc(t('about.sf.credit', { author: sf.author, license: sf.license, link: '\u0000' })).replace('\u0000', link(sf.homepage, t('about.sf.more')))}</td></tr>
      ${sf.installed ? `<tr><td colspan="2" class="path" title="${esc(sf.path)}">${esc(sf.path)}</td></tr>` : ''}
    </table>

    <h3 id="about-credits">${esc(t('about.credits'))}</h3>
    <p class="muted">${esc(t('about.credits.intro'))}</p>
    <table class="about-table credits">
      ${a.credits.map((c) => `<tr>
        <th>${link(c.url, c.name)} <span class="muted">${esc(c.version)}</span></th>
        <td>${esc(has(`about.role.${c.id}`) ? t(`about.role.${c.id}`) : c.role)}<div class="muted">${esc(c.author)} · ${esc(c.license)}</div></td>
      </tr>`).join('')}
    </table>

    <h3>${esc(t('about.technical'))}</h3>
    <table class="about-table">
      <tr><th>${esc(t('about.version'))}</th><td>${esc(a.version)}</td></tr>
      <tr><th>${esc(t('about.platform'))}</th><td>${esc(platform)} · Tauri ${esc(a.tauri)}</td></tr>
      <tr><th>${esc(t('about.fileformat'))}</th><td>${esc(t('about.fileformat.value', { version: a.file_format }))}</td></tr>
      <tr><th>${esc(t('about.datafolder'))}</th><td class="path" title="${esc(a.data_dir)}">${esc(a.data_dir)}</td></tr>
    </table>`;
  openDialog(esc(t('about.title')), body,
    `<button type="button" data-copy>${esc(t('about.copy'))}</button>${sf.installed ? `<button type="button" data-reveal>${esc(t('about.reveal'))}</button>` : ''}`);
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
    navigator.clipboard.writeText(dialogEl.dataset.summary || '').then(() => { copy.textContent = t('about.copied'); }, showError);
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
  // Back to the score, unless the button opened something to type in.
  if (!textEdit.key && !$('dialog').open) page.focus();
};
document.querySelector('.toolbar').addEventListener('click', onControlClick);
$('palette').addEventListener('click', onControlClick);

// ----- menu bar --------------------------------------------------------------

const hasDoc = () => !!active();
const hasSelection = () => !!active()?.selection;

// Marks from the palette, also offered in Notes so the keyboard reaches them.
// They go on the selection, or on the note before the caret.
const ACCIDENTALS = [['sharp', 1], ['flat', -1], ['natural', 0]];
const ARTICULATIONS = ['staccato', 'staccatissimo', 'tenuto', 'accent', 'marcato', 'fermata'];
const DYNAMICS = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sfz', 'fp'];
for (const [name, alter] of ACCIDENTALS) commands[`alter:${name}`] = () => act({ type: 'set_accidental', alter });
for (const a of ARTICULATIONS) commands[`artic:${a}`] = () => act({ type: 'toggle_articulation', articulation: a });
for (const d of DYNAMICS) commands[`dyn:${d}`] = () => act({ type: 'set_dynamic', dynamic: d });
commands['page-texts'] = () => pageTextsDialog();
commands['tempo-mark'] = () => { const doc = active(); if (doc) tempoDialog(doc.caret.measure); };
commands['note-text:expression'] = () => startNoteText('expression');
commands['note-text:technique'] = () => startNoteText('technique');
commands.rehearsal = () => rehearsalMark();

/** A radio choice of a submenu: label and tooltip from `key` (and `key.desc` if there is one). */
const choice = (key, cmd, checked) => ({
  label: t(key), cmd, radio: true, checked, ...(has(`${key}.desc`) ? { desc: t(`${key}.desc`) } : {}),
});

// Every label fits on one line: the menu that holds an item says what it is
// about ("Group Staves › Brace"), and `desc` explains it in a tooltip.
const MENUS = [
  { label: t('menu.file'), items: [
    { label: t('menu.file.new'), cmd: 'new', key: 'Ctrl+N' },
    { label: t('menu.file.open'), cmd: 'open', key: 'Ctrl+O' },
    { sep: true },
    { label: t('menu.file.save'), cmd: 'save', key: 'Ctrl+S', enabled: hasDoc },
    { label: t('menu.file.saveas'), cmd: 'saveas', key: 'Ctrl+Shift+S', enabled: hasDoc },
    { sep: true },
    { label: t('menu.file.import'), items: [
      { label: t('menu.file.musicxml'), cmd: 'import-musicxml', desc: t('menu.file.import.desc') },
    ] },
    { label: t('menu.file.export'), enabled: hasDoc, items: [
      { label: t('menu.file.musicxml'), cmd: 'export-musicxml', desc: t('menu.file.export.desc') },
    ] },
    { sep: true },
    { label: t('menu.file.print'), cmd: 'print', key: 'Ctrl+P', enabled: hasDoc },
    { sep: true },
    { label: t('menu.file.close'), cmd: 'close', key: 'Ctrl+W', enabled: hasDoc },
  ] },
  { label: t('menu.edit'), items: [
    { label: t('menu.edit.undo'), cmd: 'undo', key: 'Ctrl+Z', enabled: () => !!active()?.can_undo },
    { label: t('menu.edit.redo'), cmd: 'redo', key: 'Ctrl+Y', enabled: () => !!active()?.can_redo },
    { sep: true },
    { label: t('menu.edit.cut'), cmd: 'cut', key: 'Ctrl+X', enabled: hasSelection },
    { label: t('menu.edit.copy'), cmd: 'copy', key: 'Ctrl+C', enabled: hasSelection },
    { label: t('menu.edit.paste'), cmd: 'paste', key: 'Ctrl+V', enabled: hasDoc },
    { label: t('menu.edit.delete'), cmd: 'delete', key: 'Del', enabled: hasDoc },
    { sep: true },
    { label: t('menu.edit.selectall'), cmd: 'selectall', key: 'Ctrl+A', enabled: hasDoc },
  ] },
  { label: t('menu.view'), items: [
    { label: t('menu.view.layout'), value: () => t(`menu.view.layout.${state.view}`), items: [
      choice('menu.view.layout.page', 'view:page', () => state.view === 'page'),
      choice('menu.view.layout.wrap', 'view:wrap', () => state.view === 'wrap'),
      choice('menu.view.layout.continuous', 'view:continuous', () => state.view === 'continuous'),
    ] },
    { label: t('menu.view.zoom'), value: () => t('menu.view.zoom.value', { pct: Math.round(state.zoom * 100) }), items: [
      { label: t('menu.view.zoom.in'), cmd: 'zoom-in', key: 'Ctrl+=', enabled: () => state.zoom < ZOOM_MAX },
      { label: t('menu.view.zoom.out'), cmd: 'zoom-out', key: 'Ctrl+−', enabled: () => state.zoom > ZOOM_MIN },
      { label: t('menu.view.zoom.reset'), cmd: 'zoom-reset', key: 'Ctrl+0', enabled: () => state.zoom !== 1 },
      { label: t('menu.view.zoom.fit'), cmd: 'zoom-fit', enabled: () => state.view === 'page', desc: t('menu.view.zoom.fit.desc') },
    ] },
    { label: t('menu.view.paper'), value: () => t(`menu.view.paper.${state.paper}`), items: [
      choice('menu.view.paper.a4', 'paper:a4', () => state.paper === 'a4'),
      choice('menu.view.paper.letter', 'paper:letter', () => state.paper === 'letter'),
    ] },
    { sep: true },
    { label: t('menu.view.multirest'), cmd: 'multirest', checked: () => state.multiRest, desc: t('toolbar.multirest.desc') },
    { label: t('menu.view.extended'), cmd: 'extended-values', checked: () => state.extendedValues, desc: t('menu.view.extended.desc') },
    { sep: true },
    { label: t('menu.view.theme'), value: () => t(`menu.view.theme.${state.theme}`), items: [
      choice('menu.view.theme.system', 'theme:system', () => state.theme === 'system'),
      choice('menu.view.theme.light', 'theme:light', () => state.theme === 'light'),
      choice('menu.view.theme.dark', 'theme:dark', () => state.theme === 'dark'),
    ] },
    { label: t('menu.view.language'),
      value: () => (languageChoice === 'system' ? t('menu.view.language.system') : LANGUAGE_NAMES[languageChoice]),
      items: [
        choice('menu.view.language.system', 'language:system', () => languageChoice === 'system'),
        { sep: true },
        // Each language is offered under its own name.
        ...LANGUAGES.map((code) => ({
          label: LANGUAGE_NAMES[code], cmd: `language:${code}`, radio: true, checked: () => languageChoice === code,
          desc: t('menu.view.language.reload'),
        })),
      ] },
  ] },
  { label: t('menu.score'), items: [
    { label: t('menu.score.texts'), cmd: 'page-texts', enabled: hasDoc, desc: t('menu.score.texts.desc') },
    { label: t('menu.score.tempo'), cmd: 'tempo-mark', enabled: hasDoc, desc: t('menu.score.tempo.desc') },
    { label: t('menu.score.rehearsal'), cmd: 'rehearsal', enabled: hasDoc, desc: t('menu.score.rehearsal.desc') },
    { label: t('menu.score.textbox'), cmd: 'text', enabled: hasDoc, desc: t('palette.text.desc') },
    { label: t('menu.score.styles'), cmd: 'text-styles', enabled: hasDoc, desc: t('menu.score.styles.desc') },
    { sep: true },
    { label: t('menu.score.measure'), enabled: hasDoc, items: [
      { label: t('menu.score.measure.add'), cmd: 'add-measure', key: 'Ctrl+Enter', desc: t('toolbar.addmeasure.desc') },
      { label: t('menu.score.measure.remove'), cmd: 'remove-measure', desc: t('toolbar.removemeasure.desc') },
    ] },
    { label: t('menu.score.staff'), enabled: hasDoc, items: [
      { label: t('menu.score.staff.add'), cmd: 'add-staff', desc: t('toolbar.addstaff.desc') },
      { label: t('menu.score.staff.props'), cmd: 'staff-properties', desc: t('menu.score.staff.props.desc') },
      { sep: true },
      { label: t('menu.score.staff.remove'), cmd: 'remove-staff', desc: t('toolbar.removestaff.desc') },
    ] },
    { label: t('menu.score.group'), enabled: hasDoc, items: [
      { label: t('menu.score.group.bracket'), cmd: 'group-bracket', desc: t('menu.score.group.bracket.desc') },
      { label: t('menu.score.group.brace'), cmd: 'group-brace', desc: t('menu.score.group.brace.desc') },
      { sep: true },
      { label: t('menu.score.group.none'), cmd: 'group-none', desc: t('menu.score.group.none.desc') },
    ] },
  ] },
  { label: t('menu.notes'), items: [
    { label: t('palette.tie'), cmd: 'tie', key: 'T', enabled: hasDoc, desc: t('palette.tie.desc') },
    { label: t('palette.slur'), cmd: 'slur', key: 'S', enabled: hasSelection, desc: t('palette.slur.desc') },
    { label: t('menu.notes.lyrics'), cmd: 'lyrics', key: 'Ctrl+L', enabled: hasDoc, checked: () => !!state.lyric, desc: t('menu.notes.lyrics.desc') },
    { label: t('menu.notes.expression'), cmd: 'note-text:expression', key: 'Ctrl+E', enabled: hasDoc, desc: t('notetext.expression.desc') },
    { label: t('menu.notes.technique'), cmd: 'note-text:technique', enabled: hasDoc, desc: t('notetext.technique.desc') },
    { sep: true },
    { label: t('palette.accidentals'), enabled: hasDoc, items: ACCIDENTALS.map(([name]) =>
      ({ label: t(`palette.${name}`), cmd: `alter:${name}`, desc: t(`palette.${name}.desc`) })) },
    { label: t('palette.articulations'), enabled: hasDoc, items: ARTICULATIONS.map((a) =>
      ({ label: t(`palette.${a}`), cmd: `artic:${a}`, desc: t(`palette.${a}.desc`) })) },
    { label: t('palette.dynamics'), enabled: hasDoc, items: DYNAMICS.map((d) =>
      ({ label: t('menu.notes.dynamic', { name: t(`palette.${d}`), mark: d }), cmd: `dyn:${d}`, desc: t(`palette.${d}.desc`) })) },
  ] },
  { label: t('menu.play'), items: [
    { label: t('menu.play.toggle'), cmd: 'play', key: 'Space', enabled: hasDoc },
    { label: t('menu.play.start'), cmd: 'play-start', key: 'Shift+Space', enabled: hasDoc },
    { label: t('menu.play.stop'), cmd: 'stop', key: 'Esc', enabled: () => playback.playing },
  ] },
  { label: t('menu.help'), items: [
    { label: t('menu.help.shortcuts'), cmd: 'shortcuts', key: 'F1' },
    { sep: true },
    { label: t('menu.help.changelog'), cmd: 'changelog' },
    { label: t('menu.help.report'), cmd: 'report-problem' },
    { label: t('menu.help.repo'), cmd: 'open-repo' },
    { label: t('menu.help.support'), cmd: 'support' },
    { sep: true },
    { label: t('menu.help.updates'), cmd: 'check-updates' },
    { label: t('menu.help.autoupdates'), cmd: 'auto-updates', checked: () => loadPref('updates.auto', true), desc: t('menu.help.autoupdates.desc') },
    { sep: true },
    { label: t('menu.help.credits'), cmd: 'credits' },
    { label: t('menu.help.about'), cmd: 'about' },
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

// The key names' letter is translated (C → Do); the accidental is kept.
$('key').innerHTML = KEY_NAMES.map((n, i) =>
  `<option value="${i - 7}">${esc(t('keysig.major', { note: t(`note.${n[0]}`) + n.slice(1) }))}</option>`).join('');
$('key').addEventListener('change', (ev) => { act({ type: 'set_key', fifths: Number(ev.target.value) }); page.focus(); });
$('clef').addEventListener('change', (ev) => { act({ type: 'set_clef', clef: ev.target.value }); page.focus(); });
$('tempo').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const bpm = Number(ev.target.value);
  if (!Number.isInteger(bpm) || bpm < 20 || bpm > 400) { showError(t('error.tempo')); return; }
  act({ type: 'set_tempo', bpm });
  page.focus();
});
$('time').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const m = ev.target.value.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  if (!m) { showError(t('error.time')); return; }
  act({ type: 'set_time', beats: Number(m[1]), beat_type: Number(m[2]) });
  page.focus();
});

$('tabs').addEventListener('click', (ev) => {
  const close = ev.target.closest('[data-close]');
  if (close) { serial(() => closeDocument(close.dataset.close)); return; }
  const tab = ev.target.closest('.tab');
  if (tab) { state.active = tab.dataset.id; render(); page.focus(); }
});

window.addEventListener('resize', () => render());

// Closing the window with unsaved work.
tauri.event.listen('close-requested', async ({ payload }) => {
  const names = payload.map((name) => t('quoted', { name })).join(t('list.separator'));
  const quit = await dialog.ask(t('quit.unsaved', { names }), {
    title: 'Partita', kind: 'warning', okLabel: t('quit.ok'), cancelLabel: t('button.cancel'),
  });
  if (quit) await invoke('quit');
});

// ----- start -----------------------------------------------------------------

serial(async () => {
  // Draw only once the music font is ready, or the first frame would use
  // fallback glyphs in the wrong places.
  try { await document.fonts.load('40px Bravura', ''); } catch { /* render anyway */ }
  await checkRecovery();
  // The names Rust gives new documents and staves, in this language.
  await invoke('set_default_names', { untitled: t('default.untitled'), nameless: t('default.nameless'), staff: t('default.staff') });
  for (const tab of await invoke('list_documents')) adopt(await invoke('get_document', { id: tab.id }));
  // After View → Language the page reloads: go back to the tab that was open.
  let previous = null;
  try {
    previous = sessionStorage.getItem('partita.activeTab');
    sessionStorage.removeItem('partita.activeTab');
  } catch { /* ignore */ }
  if (state.docs.has(previous)) state.active = previous;
  else if (state.order.length) state.active = state.order[0];
  else await newDocument();
  render();
  // First run of page view: start with the page fitted to the window.
  if (state.view === 'page' && loadPref('zoom', null) === null) fitWidth();
  page.focus();
  // An update may already be downloading or waiting (the page was reloaded):
  // show it again in the status bar.
  const u = await invoke('update_status');
  if (u.state === 'downloading' || u.state === 'ready') {
    updates.status = u;
    if (u.state === 'downloading') pollUpdate();
    else renderStatus();
  }
  // Look for a new version a little after start-up, at most once a day.
  setTimeout(() => serial(() => checkForUpdates(false)), 5000);
});
