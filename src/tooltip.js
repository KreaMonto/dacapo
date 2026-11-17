// Tooltips for any element with data-tip (title), plus optional data-desc
// (one-line explanation) and data-key (keyboard shortcut). Replaces the
// browser's native `title` tooltips, which are slow, unstyled and cannot
// show shortcuts.

import { keyLabel } from './i18n.js';

const DELAY_MS = 450;

export function installTooltips(root = document) {
  const tip = document.getElementById('tooltip');
  let timer = null;
  let current = null;

  const hide = () => {
    clearTimeout(timer);
    timer = null;
    current = null;
    tip.hidden = true;
  };

  const show = (el) => {
    current = el;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const { tip: title, desc, key } = el.dataset;
    // On figure buttons data-key is the duration digit; show it as a key too.
    tip.innerHTML = `<div class="tt-head"><strong>${esc(title)}</strong>${key ? `<kbd>${esc(keyLabel(key))}</kbd>` : ''}</div>`
      + (desc ? `<div class="tt-desc">${esc(desc)}</div>` : '');
    tip.hidden = false;
    // Below the element, or above when there is no room; kept on screen.
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const margin = 8;
    let x = r.left + r.width / 2 - t.width / 2;
    x = Math.max(margin, Math.min(x, window.innerWidth - t.width - margin));
    let y = r.bottom + 6;
    if (y + t.height > window.innerHeight - margin) y = r.top - t.height - 6;
    // Palette buttons and menu items: beside them reads better than below
    // (below would cover the next item). Menus: beside the whole list, on
    // the side with room.
    const list = el.closest('.menu-pop');
    if (el.closest('.palette') || list) {
      const side = list ? list.getBoundingClientRect() : r;
      x = side.right + 8;
      if (list && x + t.width > window.innerWidth - margin) x = side.left - t.width - 8;
      y = Math.max(margin, Math.min(r.top + r.height / 2 - t.height / 2, window.innerHeight - t.height - margin));
    }
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };

  root.addEventListener('mouseover', (ev) => {
    const el = ev.target.closest('[data-tip]');
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    timer = setTimeout(() => show(el), DELAY_MS);
  });
  root.addEventListener('mouseout', (ev) => {
    const el = ev.target.closest('[data-tip]');
    if (el && !el.contains(ev.relatedTarget)) hide();
  });
  // Keyboard users get the tooltip immediately on focus.
  root.addEventListener('focusin', (ev) => {
    const el = ev.target.closest('[data-tip]');
    if (el && ev.target.matches(':focus-visible')) show(el);
  });
  root.addEventListener('focusout', hide);
  root.addEventListener('mousedown', hide, true);
  window.addEventListener('blur', hide);
  window.addEventListener('scroll', hide, true);
}
