// The toolbars: thin named groups of tools ("bars"), placed in zones around
// the score. Each bar is an element with a data-bar-id; which zone it goes
// in, and in what order, is data (DEFAULT_LAYOUT), so later steps can move
// bars and save layouts without touching the bars themselves.
//
// In a zone that is a row, the bars that do not fit the window move behind
// a » button, in a panel that opens below it, instead of wrapping to a
// second row. They are the same elements, moved, so their controls keep
// working.

/** Partita's own layout: zone → bar ids, in order. */
export const DEFAULT_LAYOUT = {
  top1: ['file', 'edit', 'playback', 'view'],
  // Tools first, right above the palette: next to the score and the figures.
  top2: ['tools', 'measure', 'staves', 'indications'],
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
 * Lays out the bars under `root` and keeps each row fitting its width.
 * Every `.toolbar` row has a `.tbar-row`, a `.tbar-more` button and a
 * `.tbar-overflow` panel.
 */
export function installBars(root) {
  applyLayout(root);
  const rows = [...root.querySelectorAll('.toolbar')].map(fitRow);
  const fitAll = () => { for (const r of rows) r.fit(); };
  // Each row also watches itself; this covers the window and the fonts.
  window.addEventListener('resize', fitAll);
  document.fonts?.ready.then(fitAll);
  return { fit: fitAll };
}

function fitRow(toolbar) {
  const row = toolbar.querySelector('.tbar-row');
  const more = toolbar.querySelector('.tbar-more');
  const panel = toolbar.querySelector('.tbar-overflow');

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
    if (row.scrollWidth <= row.clientWidth) { close(); return; }
    more.hidden = false;
    while (row.children.length > 1 && row.scrollWidth > row.clientWidth) panel.prepend(row.lastElementChild);
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
