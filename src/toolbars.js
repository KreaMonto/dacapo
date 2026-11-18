// The toolbar's bars: thin named groups of tools in one row. When the window
// is too narrow for all of them, the last bars move behind a » button, in a
// panel that opens below it, instead of wrapping to a second row. They are
// the same elements, moved, so their controls keep working.

/**
 * @param {HTMLElement} toolbar the `.toolbar` with a `.tbar-row`, a
 *   `.tbar-more` button and a `.tbar-overflow` panel.
 */
export function installBars(toolbar) {
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
  // focus: wait until they leave the toolbar.
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
  window.addEventListener('resize', fit);
  document.fonts?.ready.then(fit);
  return { fit };
}
