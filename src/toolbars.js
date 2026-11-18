// The toolbars: thin named groups of tools ("bars") around the score. Each
// bar is an element with a data-bar-id. Each side of the score (`.side`:
// top, left, right) holds any number of lanes: rows above the score,
// columns beside it. Which bar goes in which lane, and in what order, is
// data (DEFAULT_LAYOUT), so bars can be moved and layouts saved without
// touching the bars themselves.
//
// Any bar can go anywhere: drag it by its grip to another place in its lane,
// to another lane, or past the first or last lane of a side, which opens a
// new one. A lane left empty disappears.
//
// The bars that do not fit their lane move behind a » button, in a panel
// that opens beside it, instead of wrapping. They are the same elements,
// moved, so their controls keep working.

import { t } from './i18n.js';

const SIDES = ['top', 'left', 'right'];

/** Partita's own layout: side → lanes → bar ids, in order. */
export const DEFAULT_LAYOUT = {
  top: [
    ['file', 'edit', 'playback', 'view'],
    // Tools first, right above the entry bars: next to the score and the figures.
    ['tools', 'measure', 'staves', 'indications'],
  ],
  // Left of the score: what you write with.
  left: [['figures', 'accidentals', 'voice']],
  // Right of the score: what goes on the notes.
  right: [['lines', 'articulations', 'dynamics', 'expressions']],
};

/**
 * Partita's own layouts. They cannot be changed: moving or hiding a bar
 * changes the arrangement on screen, and choosing the layout again (or
 * Reset) brings it back. The instrument modes will add theirs here.
 */
export const BUILT_IN_LAYOUTS = [
  { id: 'partita', nameKey: 'layout.partita', layout: DEFAULT_LAYOUT, hidden: [] },
];

// Kept between sessions:
// - the arrangement on screen (`partita.toolbars`): which bars are hidden,
//   where each one is, and the layout it comes from (`active`);
// - the person's own layouts (`partita.layouts`): each with its name, the
//   built-in layout it started from (`base`), and its arrangement. While one
//   of them is active, every change is kept in it.
const STORE = 'partita.toolbars';
const LAYOUTS = 'partita.layouts';
const stored = load(STORE) || {};
let own = (load(LAYOUTS) || []).filter((l) => l && typeof l.id === 'string' && typeof l.name === 'string');
let active = stored.active && findLayout(stored.active) ? stored.active : 'partita';
let hidden = new Set(stored.hidden);
let layout = mergeLayout(stored.layout);
let rootEl = null;
let refitBar = () => {};
const lanes = new Map(); // lane element → { fit, close, owns(target), stop() }

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not kept */ }
}
function save() {
  store(STORE, { active, hidden: [...hidden], layout });
  const mine = own.find((l) => l.id === active);
  if (mine) {
    mine.hidden = [...hidden];
    mine.layout = structuredClone(layout);
    store(LAYOUTS, own);
  }
}

function findLayout(id) {
  return BUILT_IN_LAYOUTS.find((l) => l.id === id) ?? own.find((l) => l.id === id);
}
const builtInOf = (id) => (BUILT_IN_LAYOUTS.some((l) => l.id === id) ? id : (findLayout(id)?.base ?? 'partita'));

/** Every layout, Partita's first: { id, name, builtIn }. */
export const layoutList = () => [
  ...BUILT_IN_LAYOUTS.map((l) => ({ id: l.id, name: t(l.nameKey), builtIn: true })),
  ...own.map((l) => ({ id: l.id, name: l.name, builtIn: false })),
];
export const activeLayout = () => active;
export const activeLayoutName = () => layoutList().find((l) => l.id === active)?.name ?? '';

/** Puts layout `id` on screen, as it was saved (a built-in one, as Partita made it). */
export function chooseLayout(id) {
  const l = findLayout(id);
  if (!l) return;
  active = id;
  hidden = new Set(l.hidden ?? []);
  layout = mergeLayout(l.layout);
  save();
  showLayout();
}

/**
 * Keeps the arrangement on screen as the person's own layout `name` (an
 * existing one of theirs with that name is replaced), and makes it active.
 */
export function saveLayoutAs(name) {
  const clean = String(name).trim().slice(0, 40);
  if (!clean) return null;
  let mine = own.find((l) => l.name.toLowerCase() === clean.toLowerCase());
  if (!mine) {
    mine = { id: `own-${Date.now().toString(36)}`, name: clean, base: builtInOf(active) };
    own.push(mine);
  }
  active = mine.id;
  save(); // fills in its arrangement
  return mine.id;
}

/** Removes one of the person's layouts; if it was on screen, its built-in layout takes over. */
export function deleteLayout(id) {
  const mine = own.find((l) => l.id === id);
  if (!mine) return;
  own = own.filter((l) => l !== mine);
  store(LAYOUTS, own);
  if (active === id) chooseLayout(mine.base ?? 'partita');
}

/**
 * Back to the built-in layout the one on screen comes from, as Partita made
 * it. The person's own layouts are kept: choosing one brings it back.
 */
export function resetBars() {
  chooseLayout(builtInOf(active));
}

/**
 * A saved layout, made safe: unknown sides and bars are dropped, each bar
 * appears once, empty lanes go, and a bar it does not mention (one added in
 * a later version) goes where Partita puts it. Layouts saved before sides
 * had lanes ({ top1, top2, left, right } of bar ids) are read too.
 */
function mergeLayout(saved) {
  const lanesOf = (v) => {
    if (!Array.isArray(v)) return [];
    return v.every((x) => typeof x === 'string') ? [v] : v.filter(Array.isArray);
  };
  const src = saved && typeof saved === 'object' ? saved : {};
  const given = {
    top: src.top ? lanesOf(src.top) : [src.top1, src.top2].filter(Array.isArray),
    left: lanesOf(src.left),
    right: lanesOf(src.right),
  };
  const known = new Set(Object.values(DEFAULT_LAYOUT).flat(2));
  const seen = new Set();
  const result = {};
  for (const side of SIDES) {
    result[side] = given[side].map((lane) => lane.filter((id) => known.has(id) && !seen.has(id) && seen.add(id)));
  }
  // Bars it does not mention: in their own lane if it is still there.
  for (const side of SIDES) {
    DEFAULT_LAYOUT[side].forEach((lane, i) => {
      for (const id of lane) {
        if (seen.has(id)) continue;
        seen.add(id);
        while (result[side].length <= i) result[side].push([]);
        result[side][Math.min(i, result[side].length - 1)].push(id);
      }
    });
  }
  for (const side of SIDES) result[side] = result[side].filter((lane) => lane.length);
  return result;
}

/** Every bar, side by side as Partita places them (for View → Toolbars → Show Bars). */
export const barZones = () => SIDES.map((side) => ({ zone: side, ids: DEFAULT_LAYOUT[side].flat() }));

/** The i18n key of a bar's name. */
export const barNameKey = (id) => document.querySelector(`[data-bar-id="${id}"]`)?.dataset.i18nBar;

export const isBarShown = (id) => !hidden.has(id);

export function setBarShown(id, shown) {
  if (shown) hidden.delete(id); else hidden.add(id);
  save();
  applyVisibility();
}

// ----- lanes -----------------------------------------------------------------

const sideEl = (side) => rootEl?.querySelector(`.side[data-side="${side}"]`);
const laneEls = (side) => [...(sideEl(side)?.children ?? [])].filter((el) => lanes.has(el));
const isColumn = (side) => side !== 'top';

/** A new, empty lane for `side`: the same parts as the ones in index.html. */
function makeLane(side) {
  const lane = document.createElement('div');
  lane.className = isColumn(side) ? 'toolbar vzone' : 'toolbar';
  lane.setAttribute('role', 'toolbar');
  lane.setAttribute('aria-label', t(`toolbar.lane.${side}`));
  lane.innerHTML = `<div class="tbar-row"></div>
    <button class="ibtn tbar-more" hidden aria-haspopup="true" aria-expanded="false"><svg class="icon"><use href="#i-more"/></svg></button>
    <div class="tbar-overflow" hidden></div>`;
  const more = lane.querySelector('.tbar-more');
  more.dataset.tip = t('bar.more');
  more.dataset.desc = t('bar.more.desc');
  more.setAttribute('aria-label', t('bar.more'));
  return lane;
}

/** Makes the lanes on screen match `layout`, and puts each bar in its own. */
function applyLayout() {
  // In three passes, so that no lane is removed while it still holds a bar
  // that belongs to another side: first enough lanes everywhere, then every
  // bar in its place, then away with the lanes left over.
  for (const side of SIDES) {
    const box = sideEl(side);
    if (!box) continue;
    while (laneEls(side).length < layout[side].length) {
      const lane = makeLane(side);
      box.append(lane);
      lanes.set(lane, fitLane(lane));
    }
  }
  for (const side of SIDES) {
    const els = laneEls(side);
    layout[side].forEach((ids, i) => {
      const row = els[i]?.querySelector('.tbar-row');
      for (const id of ids) {
        const bar = rootEl.querySelector(`[data-bar-id="${id}"]`);
        if (bar && row) row.append(bar);
      }
    });
  }
  for (const side of SIDES) {
    for (const lane of laneEls(side).slice(layout[side].length)) {
      // Anything still in it (a bar no layout names) is kept, out of sight.
      for (const bar of lane.querySelectorAll('[data-bar-id]')) pool().append(bar);
      lanes.get(lane).stop();
      lanes.delete(lane);
      lane.remove();
    }
  }
}

/** Where bars that no lane holds wait, hidden. */
function pool() {
  let el = document.getElementById('bar-pool');
  if (!el) {
    el = Object.assign(document.createElement('div'), { id: 'bar-pool', hidden: true });
    document.body.append(el);
  }
  return el;
}

/** Hides the hidden bars, and a lane with nothing left to show. */
function applyVisibility() {
  if (!rootEl) return;
  for (const bar of rootEl.querySelectorAll('[data-bar-id]')) bar.hidden = hidden.has(bar.dataset.barId);
  for (const lane of lanes.keys()) lane.hidden = ![...lane.querySelectorAll('[data-bar-id]')].some((b) => !b.hidden);
  fitAll();
}

function fitAll() {
  for (const l of lanes.values()) l.fit();
}

function showLayout() {
  if (!rootEl) return;
  applyLayout();
  for (const bar of rootEl.querySelectorAll('[data-bar-id]')) refitBar(bar);
  applyVisibility();
}

/**
 * Lays out the bars under `root` and keeps each lane fitting its room: a
 * row its width, a column (`.vzone`) its height. Every lane has a
 * `.tbar-row`, a `.tbar-more` button and a `.tbar-overflow` panel.
 */
export function installBars(root, { onChange, onMove } = {}) {
  rootEl = root;
  if (onMove) refitBar = onMove;
  // The lanes written in index.html are the first ones of their sides.
  for (const lane of root.querySelectorAll('.side > .toolbar')) lanes.set(lane, fitLane(lane));
  applyLayout();
  for (const drop of root.querySelectorAll('.drop')) installDrop(drop, onChange);
  for (const bar of root.querySelectorAll('[data-bar-id]')) installGrip(bar);
  applyVisibility();
  // One set of listeners for every lane's » panel, whatever lanes come and go.
  document.addEventListener('pointerdown', (ev) => {
    for (const l of lanes.values()) if (!l.owns(ev.target)) l.close();
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') for (const l of lanes.values()) l.close(true);
  }, true);
  // Each lane also watches itself; this covers the window and the fonts.
  window.addEventListener('resize', fitAll);
  document.fonts?.ready.then(fitAll);
  return { fit: fitAll };
}

function fitLane(lane) {
  const row = lane.querySelector('.tbar-row');
  const more = lane.querySelector('.tbar-more');
  const panel = lane.querySelector('.tbar-overflow');
  const vertical = lane.classList.contains('vzone');
  const overflows = () => (vertical
    ? row.scrollHeight > row.clientHeight
    : row.scrollWidth > row.clientWidth);

  const close = (focus = false) => {
    if (panel.hidden) return;
    panel.hidden = true;
    more.setAttribute('aria-expanded', 'false');
    if (focus) more.focus();
  };
  const open = () => {
    panel.hidden = false;
    more.setAttribute('aria-expanded', 'true');
  };

  // Moving a control out from under the person typing in it would drop its
  // focus: wait until they leave the lane.
  let pending = false;
  const fit = () => {
    if (!lane.isConnected) return;
    if (lane.contains(document.activeElement) && document.activeElement !== more) { pending = true; return; }
    pending = false;
    // Everything back in the row, in order, then out again from the end
    // while the row overflows.
    row.append(...panel.children);
    more.hidden = true;
    if (!overflows()) { close(); return; }
    more.hidden = false;
    // Keep at least one shown bar in the lane.
    const shown = () => [...row.children].filter((b) => !b.hidden).length;
    while (shown() > 1 && overflows()) panel.prepend(row.lastElementChild);
  };

  more.addEventListener('click', (ev) => {
    ev.stopPropagation(); // not a command for the toolbar's click handler
    if (panel.hidden) open(); else close();
  });
  // A button in the panel does its work and closes it; lists and fields
  // keep it open while they are used.
  panel.addEventListener('click', (ev) => { if (ev.target.closest('button')) close(); });
  lane.addEventListener('focusout', () => setTimeout(() => {
    if (pending && !lane.contains(document.activeElement)) fit();
  }, 0));

  const ro = new ResizeObserver(fit);
  ro.observe(lane);
  return {
    fit,
    close,
    owns: (target) => panel.contains(target) || more.contains(target),
    stop: () => ro.disconnect(),
  };
}

// ----- drop-down groups ------------------------------------------------------

/**
 * A drop-down button for a large group (the dynamics): the button shows the
 * last item chosen, and a click opens the whole group beside it. Choosing an
 * item does what the item does (the toolbar's click handler sees the click)
 * and closes the group. The last choice is remembered.
 *
 * The group is placed with fixed coordinates, so the lane's clipping
 * (overflow: hidden, for ») does not cut it.
 */
function installDrop(drop, onChange) {
  const face = drop.querySelector('.drop-btn');
  const pop = drop.querySelector('.drop-pop');
  const key = `partita.drop.${drop.dataset.drop}`;
  const show = (item) => {
    if (!item) return;
    // A glyph (the dynamics) or an icon (the barlines).
    face.innerHTML = item.innerHTML;
    if (face.classList.contains('glyph')) onChange?.(face);
  };
  let saved = null;
  try { saved = localStorage.getItem(key); } catch { /* no storage: the default stays */ }
  if (saved) show([...pop.children].find((b) => markValue(b) === saved));

  const close = () => {
    pop.hidden = true;
    face.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    pop.hidden = false;
    face.setAttribute('aria-expanded', 'true');
    // Towards the score: below a button in a row, left of one on the right
    // side, right of one on the left side; kept inside the window.
    const r = face.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const side = drop.closest('.side')?.dataset.side;
    let x; let y;
    if (!isColumn(side)) { x = r.left; y = r.bottom + 4; }
    else { x = side === 'right' ? r.left - p.width - 6 : r.right + 6; y = r.top; }
    x = Math.max(4, Math.min(x, window.innerWidth - p.width - 4));
    y = Math.max(4, Math.min(y, window.innerHeight - p.height - 4));
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
  };

  face.addEventListener('click', (ev) => {
    ev.stopPropagation(); // not a command for the toolbar's click handler
    if (pop.hidden) open(); else close();
  });
  pop.addEventListener('click', (ev) => {
    const item = ev.target.closest('button');
    if (!item) return;
    show(item);
    try { localStorage.setItem(key, markValue(item)); } catch { /* not remembered */ }
    close();
  });
  document.addEventListener('pointerdown', (ev) => {
    if (!pop.hidden && !drop.contains(ev.target)) close();
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !pop.hidden) { close(); face.focus(); }
  }, true);
  window.addEventListener('resize', close);
}

/** What an item of a drop-down stands for, to remember it. */
const markValue = (b) => b.dataset.dyn ?? b.dataset.artic ?? b.dataset.barline ?? b.dataset.cmd ?? b.textContent;

// ----- moving bars -----------------------------------------------------------

/**
 * A grip (⋮⋮) at the start of a bar: drag it to another place in its lane,
 * to another lane, or onto the thin strip at either end of a side, which
 * opens a new lane there. A line marks where the bar will land. Esc cancels.
 */
function installGrip(bar) {
  const grip = document.createElement('span');
  grip.className = 'tbar-grip';
  // Its tooltip names the bar too (tooltip.js shows the bar's name).
  grip.dataset.tip = t('bar.grip');
  grip.dataset.desc = t('bar.grip.desc');
  bar.prepend(grip);

  grip.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    try { grip.setPointerCapture(ev.pointerId); } catch { /* the pointer is already gone */ }
    const mark = Object.assign(document.createElement('div'), { className: 'tbar-mark', hidden: true });
    document.body.append(mark);
    bar.classList.add('dragging');
    document.body.classList.add('moving-bar');
    // Lanes with every bar hidden take part too; and every side gets a strip
    // at each end (only one when it has no lane), to open a new lane there.
    const shownAgain = [...lanes.keys()].filter((l) => l.hidden);
    for (const l of shownAgain) { l.hidden = false; l.classList.add('empty-zone'); }
    const strips = [];
    for (const side of SIDES) {
      const box = sideEl(side);
      if (!box) continue;
      for (const at of laneEls(side).length ? ['start', 'end'] : ['end']) {
        const strip = document.createElement('div');
        strip.className = `new-lane${isColumn(side) ? ' vzone' : ''}`;
        Object.assign(strip.dataset, { side, at });
        if (at === 'start') box.prepend(strip); else box.append(strip);
        strips.push(strip);
      }
    }
    let target = null; // { side, lane, before } or { side, at } for a new lane

    const place = (x, y) => {
      target = null;
      mark.hidden = true;
      for (const s of strips) s.classList.remove('over');
      const hit = document.elementFromPoint(x, y);
      const strip = hit?.closest('.new-lane');
      if (strip) {
        strip.classList.add('over');
        target = { side: strip.dataset.side, at: strip.dataset.at };
        return;
      }
      const lane = hit?.closest('.side > .toolbar');
      if (!lane || !lanes.has(lane)) return;
      const side = lane.parentElement.dataset.side;
      const column = isColumn(side);
      const others = [...lane.querySelectorAll('.tbar-row > [data-bar-id]')].filter((b) => b !== bar && !b.hidden);
      const before = others.find((b) => {
        const r = b.getBoundingClientRect();
        return column ? y < r.top + r.height / 2 : x < r.left + r.width / 2;
      }) ?? null;
      target = { side, lane: laneEls(side).indexOf(lane), before };
      // The landing line: in front of `before`, or after the last bar.
      const box = lane.querySelector('.tbar-row').getBoundingClientRect();
      const last = others.at(-1)?.getBoundingClientRect();
      const ref = before?.getBoundingClientRect();
      const at = column
        ? (ref ? ref.top : last ? last.bottom : box.top)
        : (ref ? ref.left : last ? last.right : box.left);
      Object.assign(mark.style, column
        ? { left: `${box.left}px`, top: `${at - 1}px`, width: `${box.width}px`, height: '2px' }
        : { left: `${at - 1}px`, top: `${box.top}px`, width: '2px', height: `${box.height}px` });
      mark.hidden = false;
    };
    const move = (e) => place(e.clientX, e.clientY);
    const up = () => end(true);
    const cancel = () => end(false);
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); } };
    function end(drop) {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', cancel);
      document.removeEventListener('keydown', key, true);
      mark.remove();
      for (const s of strips) s.remove();
      bar.classList.remove('dragging');
      document.body.classList.remove('moving-bar');
      for (const l of shownAgain) l.classList.remove('empty-zone');
      const id = bar.dataset.barId;
      if (drop && target?.at) moveBarToNewLane(id, target.side, target.at);
      else if (drop && target) moveBar(id, target.side, target.lane, target.before?.dataset.barId ?? null);
      else applyVisibility();
    }
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', cancel);
    document.addEventListener('keydown', key, true);
  });
}

/** Takes bar `id` out of wherever it is. */
function takeOut(id) {
  for (const side of SIDES) {
    for (const lane of layout[side]) {
      const i = lane.indexOf(id);
      if (i >= 0) lane.splice(i, 1);
    }
  }
}

/** Saves the layout after a move and puts it on screen; empty lanes go. */
function afterMove(id) {
  for (const side of SIDES) layout[side] = layout[side].filter((lane) => lane.length);
  save();
  applyLayout();
  refitBar(rootEl.querySelector(`[data-bar-id="${id}"]`));
  applyVisibility();
}

/** Moves bar `id` into lane `lane` of `side`, in front of bar `before` (or last). */
export function moveBar(id, side, lane, before = null) {
  const target = layout[side][lane];
  if (!target) return;
  takeOut(id);
  const at = before ? target.indexOf(before) : -1;
  if (at >= 0) target.splice(at, 0, id); else target.push(id);
  afterMove(id);
}

/** Moves bar `id` into a new lane at the start or the end of `side`. */
export function moveBarToNewLane(id, side, at) {
  takeOut(id);
  if (at === 'start') layout[side].unshift([id]); else layout[side].push([id]);
  afterMove(id);
}
