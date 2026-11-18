// The toolbars: thin named groups of tools ("bars"), placed in zones around
// the score. Each bar is an element with a data-bar-id; which zone it goes
// in, and in what order, is data (DEFAULT_LAYOUT), so later steps can move
// bars and save layouts without touching the bars themselves.
//
// The bars that do not fit their zone move behind a » button, in a panel
// that opens beside it (below a row, to the right of a column), instead of
// wrapping. They are the same elements, moved, so their controls keep
// working.

import { t } from './i18n.js';

/** Partita's own layout: zone → bar ids, in order. */
export const DEFAULT_LAYOUT = {
  top1: ['file', 'edit', 'playback', 'view'],
  // Tools first, right above the palette: next to the score and the figures.
  top2: ['tools', 'measure', 'staves', 'indications'],
  // A column left of the score: what you write with.
  left: ['figures', 'accidentals', 'voice'],
  // A column right of the score: what goes on the notes.
  right: ['lines', 'articulations', 'dynamics', 'expressions'],
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
let fitAll = () => {};
let refitBar = () => {};

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

function showLayout() {
  if (!rootEl) return;
  applyLayout(rootEl, layout);
  for (const bar of rootEl.querySelectorAll('[data-bar-id]')) refitBar(bar);
  applyVisibility();
}

/**
 * A saved layout, made safe: unknown zones and bars are dropped, each bar
 * appears once, and a bar it does not mention (one added in a later
 * version) goes where Partita puts it.
 */
function mergeLayout(saved) {
  const result = Object.fromEntries(Object.keys(DEFAULT_LAYOUT).map((z) => [z, []]));
  const known = new Set(Object.values(DEFAULT_LAYOUT).flat());
  const seen = new Set();
  if (saved && typeof saved === 'object') {
    for (const zone of Object.keys(result)) {
      for (const id of Array.isArray(saved[zone]) ? saved[zone] : []) {
        if (known.has(id) && !seen.has(id)) { seen.add(id); result[zone].push(id); }
      }
    }
  }
  for (const [zone, ids] of Object.entries(DEFAULT_LAYOUT)) {
    for (const id of ids) if (!seen.has(id)) result[zone].push(id);
  }
  return result;
}

/** The bars of the default layout, zone by zone: { zone, ids }. */
export const barZones = () => Object.entries(DEFAULT_LAYOUT).map(([zone, ids]) => ({ zone, ids }));

/** The i18n key of a bar's name. */
export const barNameKey = (id) => document.querySelector(`[data-bar-id="${id}"]`)?.dataset.i18nBar;

export const isBarShown = (id) => !hidden.has(id);

export function setBarShown(id, shown) {
  if (shown) hidden.delete(id); else hidden.add(id);
  save();
  applyVisibility();
}

/**
 * Back to the built-in layout the one on screen comes from, as Partita made
 * it. The person's own layouts are kept: choosing one brings it back.
 */
export function resetBars() {
  chooseLayout(builtInOf(active));
}

/** Hides the hidden bars, and a zone with nothing left to show. */
function applyVisibility() {
  if (!rootEl) return;
  for (const bar of rootEl.querySelectorAll('[data-bar-id]')) bar.hidden = hidden.has(bar.dataset.barId);
  for (const zone of rootEl.querySelectorAll('.toolbar[data-zone]')) {
    zone.hidden = ![...zone.querySelectorAll('[data-bar-id]')].some((b) => !b.hidden);
  }
  fitAll();
}

/** Puts every bar named in `layout` into its zone, in order. */
export function applyLayout(root, layout = DEFAULT_LAYOUT) {
  for (const [zone, ids] of Object.entries(layout)) {
    const row = root.querySelector(`[data-zone="${zone}"] .tbar-row`);
    if (!row) continue;
    for (const id of ids) {
      const bar = root.querySelector(`[data-bar-id="${id}"]`);
      if (bar) row.append(bar);
    }
  }
}

/**
 * Lays out the bars under `root` and keeps each zone fitting its room: a
 * row its width, a column (`.vzone`) its height. Every `.toolbar` zone has
 * a `.tbar-row`, a `.tbar-more` button and a `.tbar-overflow` panel.
 */
export function installBars(root, { onChange, onMove } = {}) {
  rootEl = root;
  if (onMove) refitBar = onMove;
  applyLayout(root, layout);
  for (const drop of root.querySelectorAll('.drop')) installDrop(drop, onChange);
  for (const bar of root.querySelectorAll('[data-bar-id]')) installGrip(bar);
  const rows = [...root.querySelectorAll('.toolbar')].map(fitRow);
  fitAll = () => { for (const r of rows) r.fit(); };
  applyVisibility();
  // Each row also watches itself; this covers the window and the fonts.
  window.addEventListener('resize', fitAll);
  document.fonts?.ready.then(fitAll);
  return { fit: fitAll };
}

/**
 * A drop-down button for a large group (the dynamics): the button shows the
 * last item chosen, and a click opens the whole group beside it. Choosing an
 * item does what the item does (the toolbar's click handler sees the click)
 * and closes the group. The last choice is remembered.
 *
 * The group is placed with fixed coordinates, so the column's clipping
 * (overflow: hidden, for ») does not cut it.
 */
function installDrop(drop, onChange) {
  const face = drop.querySelector('.drop-btn');
  const pop = drop.querySelector('.drop-pop');
  const key = `partita.drop.${drop.dataset.drop}`;
  const show = (item) => {
    if (!item) return;
    face.textContent = item.textContent;
    onChange?.(face);
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
    // Towards the score: below a button in a row, left of one in the right
    // column, right of one in the left column; kept inside the window.
    const r = face.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const zone = drop.closest('[data-zone]');
    let x; let y;
    if (!zone?.classList.contains('vzone')) { x = r.left; y = r.bottom + 4; }
    else { x = zone.dataset.zone === 'right' ? r.left - p.width - 6 : r.right + 6; y = r.top; }
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

// ----- moving bars -----------------------------------------------------------

const zoneKind = (zone) => (zone.classList.contains('vzone') ? 'column' : 'row');
/** Can `bar` go in `zone`? Bars with fields and lists fit rows only (data-fits). */
const fits = (bar, zone) => !bar.dataset.fits || bar.dataset.fits === zoneKind(zone);

/**
 * A grip (⋮⋮) at the start of a bar: drag it to another place in its zone,
 * or to another zone. While dragging, empty zones show up so a bar can go
 * back into them, and a line marks where it will land. Esc cancels.
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
    // Empty zones take part too: show them, with room to drop into.
    const zones = [...rootEl.querySelectorAll('.toolbar[data-zone]')];
    for (const z of zones) if (z.hidden) { z.hidden = false; z.classList.add('empty-zone'); }
    let target = null; // { zone, before }: the bar to land in front of, or null for the end

    const place = (x, y) => {
      target = null;
      mark.hidden = true;
      const zone = document.elementFromPoint(x, y)?.closest('.toolbar[data-zone]');
      document.body.classList.toggle('no-drop', !!zone && !fits(bar, zone));
      if (!zone || !fits(bar, zone)) return;
      const column = zoneKind(zone) === 'column';
      const others = [...zone.querySelectorAll('.tbar-row > [data-bar-id]')].filter((b) => b !== bar && !b.hidden);
      const before = others.find((b) => {
        const r = b.getBoundingClientRect();
        return column ? y < r.top + r.height / 2 : x < r.left + r.width / 2;
      }) ?? null;
      target = { zone, before };
      // The landing line: in front of `before`, or after the last bar.
      const box = zone.querySelector('.tbar-row').getBoundingClientRect();
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
      bar.classList.remove('dragging');
      document.body.classList.remove('moving-bar', 'no-drop');
      for (const z of zones) z.classList.remove('empty-zone');
      if (drop && target) moveBar(bar.dataset.barId, target.zone.dataset.zone, target.before?.dataset.barId ?? null);
      else applyVisibility();
    }
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', cancel);
    document.addEventListener('keydown', key, true);
  });
}

/** Moves bar `id` into `zone`, in front of bar `before` (or last), and keeps it there. */
export function moveBar(id, zone, before = null) {
  for (const ids of Object.values(layout)) {
    const i = ids.indexOf(id);
    if (i >= 0) ids.splice(i, 1);
  }
  const ids = layout[zone];
  const at = before ? ids.indexOf(before) : -1;
  if (at >= 0) ids.splice(at, 0, id); else ids.push(id);
  save();
  applyLayout(rootEl, layout);
  refitBar(rootEl.querySelector(`[data-bar-id="${id}"]`));
  applyVisibility();
}

/** What an item of a drop-down stands for, to remember it. */
const markValue = (b) => b.dataset.dyn ?? b.dataset.artic ?? b.dataset.cmd ?? b.textContent;

function fitRow(toolbar) {
  const row = toolbar.querySelector('.tbar-row');
  const more = toolbar.querySelector('.tbar-more');
  const panel = toolbar.querySelector('.tbar-overflow');
  const vertical = toolbar.classList.contains('vzone');
  const overflows = () => (vertical
    ? row.scrollHeight > row.clientHeight
    : row.scrollWidth > row.clientWidth);

  const close = () => {
    panel.hidden = true;
    more.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    panel.hidden = false;
    more.setAttribute('aria-expanded', 'true');
  };

  // Moving a control out from under the person typing in it would drop its
  // focus: wait until they leave the row.
  let pending = false;
  const fit = () => {
    if (toolbar.contains(document.activeElement) && document.activeElement !== more) { pending = true; return; }
    pending = false;
    // Everything back in the row, in order, then out again from the end
    // while the row overflows.
    row.append(...panel.children);
    more.hidden = true;
    if (!overflows()) { close(); return; }
    more.hidden = false;
    // Keep at least one shown bar in the zone.
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
  document.addEventListener('pointerdown', (ev) => {
    if (!panel.hidden && !panel.contains(ev.target) && !more.contains(ev.target)) close();
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !panel.hidden) { close(); more.focus(); }
  }, true);
  toolbar.addEventListener('focusout', () => setTimeout(() => {
    if (pending && !toolbar.contains(document.activeElement)) fit();
  }, 0));

  new ResizeObserver(fit).observe(toolbar);
  return { fit };
}
