// The toolbars: thin named groups of tools ("bars"), placed in zones around
// the score. Each bar is an element with a data-bar-id; which zone it goes
// in, and in what order, is data (DEFAULT_LAYOUT), so later steps can move
// bars and save layouts without touching the bars themselves.
//
// The bars that do not fit their zone move behind a » button, in a panel
// that opens beside it (below a row, to the right of a column), instead of
// wrapping. They are the same elements, moved, so their controls keep
// working.

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
export function installBars(root, { onChange } = {}) {
  applyLayout(root);
  for (const drop of root.querySelectorAll('.drop')) installDrop(drop, onChange);
  const rows = [...root.querySelectorAll('.toolbar')].map(fitRow);
  const fitAll = () => { for (const r of rows) r.fit(); };
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
    // Beside the button, towards the score: left of a right column, right
    // of anything else; kept inside the window.
    const r = face.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const toLeft = !!drop.closest('[data-zone="right"]');
    let x = toLeft ? r.left - p.width - 6 : r.right + 6;
    x = Math.max(4, Math.min(x, window.innerWidth - p.width - 4));
    const y = Math.max(4, Math.min(r.top, window.innerHeight - p.height - 4));
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
    while (row.children.length > 1 && overflows()) panel.prepend(row.lastElementChild);
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
