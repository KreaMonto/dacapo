// Classic menu bar (File, Edit, View…), drawn in HTML so it follows the
// app's theme. Built from a plain definition:
//
//   [{ label: 'File', items: [
//       { label: 'New', cmd: 'new', key: 'Ctrl+N' },
//       { sep: true },
//       { label: 'Page', cmd: 'view:page', checked: () => true, radio: true, desc: 'As printed.' },
//       { label: 'Theme', value: () => 'Dark', items: [ …a submenu… ] },
//   ]}]
//
// `checked`, `enabled` and `value` are functions, evaluated every time a
// menu opens. An item with `items` opens a submenu; its `value` (the current
// choice, e.g. the theme) shows on the right, where shortcuts go. `desc`
// becomes a tooltip; a label too long for the menu is cut with "…" and shown
// whole in a tooltip too, so every item stays on one line.
//
// Mouse: a submenu opens after a short pause on its item, and stays open
// while the pointer travels to it, even across other items. Keyboard: Alt
// focuses the bar, Alt+<letter> opens a menu, arrows move (→ opens a
// submenu, ← closes it), Enter/Space activates, Esc closes one level. The
// letter is the first one, or the one after '&' in a top-level label
// ('A&yuda' opens with Alt+Y), so a translation can avoid two menus starting
// with the same letter.

import { keyLabel } from './i18n.js';

const OPEN_DELAY_MS = 150; // hovering an item with a submenu
const CLOSE_DELAY_MS = 300; // leaving it: time to reach the submenu

export function installMenuBar(bar, menus, run, onClose) {
  const amp = (label) => Math.max(0, label.indexOf('&'));
  const letters = menus.map((m) => m.label.replace('&', '')[amp(m.label)].toLowerCase());
  bar.setAttribute('role', 'menubar');
  bar.innerHTML = menus
    .map((m, i) => `<div class="menu"><button class="menu-top" role="menuitem" aria-haspopup="true" aria-expanded="false" aria-keyshortcuts="Alt+${letters[i].toUpperCase()}" data-i="${i}" tabindex="-1">${m.label.replace('&', '')}</button><div class="menu-pop" role="menu" data-level="0" hidden></div></div>`)
    .join('');
  const tops = [...bar.querySelectorAll('.menu-top')];
  let open = -1;
  // The open lists, outermost first: { pop, list, parent } where `parent`
  // is the item that opened a submenu (null for the top menu's own list).
  let levels = [];
  let openTimer = 0;
  let closeTimer = 0;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function render(list) {
    return list.map((it, j) => {
      if (it.sep) return '<div class="menu-sep" role="separator"></div>';
      const enabled = it.enabled ? it.enabled() : true;
      const checkable = it.checked !== undefined;
      const checked = checkable && it.checked();
      const sub = !!it.items;
      const role = checkable ? (it.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem';
      const right = sub
        ? `${it.value ? `<span class="menu-value">${esc(it.value())}</span>` : ''}<span class="menu-arrow" aria-hidden="true">›</span>`
        : (it.key ? esc(keyLabel(it.key)) : '');
      const tip = it.desc ? ` data-tip="${esc(it.label)}" data-desc="${esc(it.desc)}"` : '';
      return `<button class="menu-item${sub ? ' has-sub' : ''}" role="${role}" data-j="${j}" tabindex="-1"`
        + `${sub ? ' aria-haspopup="menu" aria-expanded="false"' : ''}${enabled ? '' : ' disabled aria-disabled="true"'}`
        + `${checkable ? ` aria-checked="${checked}"` : ''}${tip}>`
        + `<span class="menu-check">${checked ? (it.radio ? '●' : '✓') : ''}</span>`
        + `<span class="menu-label">${esc(it.label)}</span><span class="menu-key">${right}</span></button>`;
    }).join('');
  }

  /** Labels cut with "…" get their full text as a tooltip. */
  function tipTruncated(pop, list) {
    for (const b of pop.querySelectorAll('.menu-item')) {
      const label = b.querySelector('.menu-label');
      if (!b.dataset.tip && label.scrollWidth > label.clientWidth) b.dataset.tip = list[Number(b.dataset.j)].label;
    }
  }

  const enabledItems = (pop) => [...pop.querySelectorAll(':scope > .menu-item:not([disabled])')];
  const levelOf = (el) => Number(el.closest('.menu-pop')?.dataset.level ?? -1);
  const itemOf = (button) => levels[levelOf(button)]?.list[Number(button.dataset.j)];

  function clearTimers() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    openTimer = closeTimer = 0;
  }

  /** Closes the submenus deeper than `level` (0 keeps only the top menu's list). */
  function closeSubmenus(level) {
    while (levels.length > level + 1) {
      const { pop, parent } = levels.pop();
      pop.remove();
      parent.setAttribute('aria-expanded', 'false');
      parent.classList.remove('sub-open');
    }
  }

  /** Opens the submenu of item `button`, beside it (flipped left when there is no room). */
  function openSubmenu(button, focusFirst = false) {
    const level = levelOf(button);
    const it = itemOf(button);
    if (!it?.items || button.disabled) return;
    if (levels[level + 1]?.parent === button) {
      if (focusFirst) enabledItems(levels[level + 1].pop)[0]?.focus();
      return;
    }
    closeSubmenus(level);
    const pop = document.createElement('div');
    pop.className = 'menu-pop sub';
    pop.setAttribute('role', 'menu');
    pop.dataset.level = String(level + 1);
    pop.innerHTML = render(it.items);
    bar.querySelector('.menu-top.open').parentElement.append(pop);
    levels.push({ pop, list: it.items, parent: button });
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('sub-open');
    const r = button.getBoundingClientRect();
    const parentBox = button.closest('.menu-pop').getBoundingClientRect();
    const box = pop.getBoundingClientRect();
    // To the right; to the left if only that side has room; if neither has,
    // to the right but shifted to fit, which covers the parent list's right
    // side (values, arrows) rather than the label of the item that opened it.
    let left = parentBox.right - 3;
    const fitsRight = left + box.width <= window.innerWidth - 4;
    const fitsLeft = parentBox.left - box.width + 3 >= 4;
    if (!fitsRight) left = fitsLeft ? parentBox.left - box.width + 3 : Math.max(4, window.innerWidth - box.width - 4);
    let top = r.top - 5; // the list's first item lines up with the parent item
    if (top + box.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - box.height - 4);
    Object.assign(pop.style, { left: `${left}px`, top: `${top}px` });
    tipTruncated(pop, it.items);
    if (focusFirst) enabledItems(pop)[0]?.focus();
  }

  function openMenu(i, focusFirst = false) {
    if (open !== -1 && open !== i) closeMenu(false);
    clearTimers();
    closeSubmenus(0);
    open = i;
    const pop = tops[i].nextElementSibling;
    pop.innerHTML = render(menus[i].items);
    levels = [{ pop, list: menus[i].items, parent: null }];
    tops[i].setAttribute('aria-expanded', 'true');
    tops[i].classList.add('open');
    pop.style.left = '';
    pop.hidden = false;
    // A menu near the right edge of a narrow window shifts left to fit.
    const overflow = pop.getBoundingClientRect().right - (window.innerWidth - 4);
    if (overflow > 0) pop.style.left = `${-overflow}px`;
    tipTruncated(pop, menus[i].items);
    if (focusFirst) enabledItems(pop)[0]?.focus();
    else tops[i].focus();
  }

  function closeMenu(returnFocus = true) {
    if (open === -1) return;
    clearTimers();
    closeSubmenus(0);
    levels = [];
    tops[open].setAttribute('aria-expanded', 'false');
    tops[open].classList.remove('open');
    tops[open].nextElementSibling.hidden = true;
    open = -1;
    if (returnFocus) onClose?.();
  }

  function activate(button) {
    const it = itemOf(button);
    if (!it || button.disabled) return;
    if (it.items) { clearTimers(); openSubmenu(button, true); return; }
    closeMenu();
    run(it.cmd);
  }

  bar.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep focus where it was
  bar.addEventListener('click', (ev) => {
    const top = ev.target.closest('.menu-top');
    if (top) {
      const i = Number(top.dataset.i);
      if (open === i) closeMenu();
      else openMenu(i);
      return;
    }
    const item = ev.target.closest('.menu-item');
    if (item) activate(item);
  });
  // Moving across the bar while a menu is open switches menus, as on desktop.
  bar.addEventListener('mouseover', (ev) => {
    const top = ev.target.closest('.menu-top');
    if (top && open !== -1 && Number(top.dataset.i) !== open) openMenu(Number(top.dataset.i));
    const item = ev.target.closest('.menu-item');
    const pop = ev.target.closest('.menu-pop');
    if (!pop) return;
    const level = levelOf(pop);
    // Reaching a submenu (anywhere in it) keeps it as it is; so does coming
    // back to the item that opened it.
    if (level > 0) clearTimers();
    else if (levels[1]?.parent === item) clearTimeout(closeTimer);
    if (!item) return;
    if (!item.disabled) item.focus({ preventScroll: true });
    clearTimeout(openTimer);
    if (levels[level + 1] && levels[level + 1].parent !== item) {
      // Another item of this list: close the open submenu, unless the
      // pointer is only crossing it on the way there.
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => closeSubmenus(level), CLOSE_DELAY_MS);
    }
    if (item.classList.contains('has-sub') && !item.disabled) {
      openTimer = setTimeout(() => openSubmenu(item), levels[level + 1] ? CLOSE_DELAY_MS : OPEN_DELAY_MS);
    }
  });
  document.addEventListener('mousedown', (ev) => {
    if (open !== -1 && !bar.contains(ev.target)) closeMenu(false);
  });
  window.addEventListener('blur', () => closeMenu(false));

  bar.addEventListener('keydown', (ev) => {
    const inTop = ev.target.classList.contains('menu-top');
    const i = inTop ? Number(ev.target.dataset.i) : open;
    const level = inTop ? 0 : Math.max(0, levelOf(ev.target));
    const list = open !== -1 && levels[level] ? enabledItems(levels[level].pop) : [];
    const pos = list.indexOf(document.activeElement);
    const current = !inTop && pos >= 0 ? list[pos] : null;
    const move = (d) => { ev.preventDefault(); openMenu((i + d + tops.length) % tops.length, !inTop || open !== -1); };
    clearTimers();
    switch (ev.key) {
      case 'ArrowRight':
        if (current?.classList.contains('has-sub')) { ev.preventDefault(); return openSubmenu(current, true); }
        return move(1);
      case 'ArrowLeft':
        if (level > 0) {
          ev.preventDefault();
          const { parent } = levels[level];
          closeSubmenus(level - 1);
          return parent.focus();
        }
        return move(-1);
      case 'ArrowDown':
        ev.preventDefault();
        if (open === -1 || inTop) return openMenu(i, true);
        return list[(pos + 1) % list.length]?.focus();
      case 'ArrowUp':
        ev.preventDefault();
        if (open === -1) return openMenu(i, false), enabledItems(tops[i].nextElementSibling).at(-1)?.focus();
        return list[(pos - 1 + list.length) % list.length]?.focus();
      case 'Enter':
      case ' ':
        ev.preventDefault();
        if (inTop) return openMenu(i, true);
        if (current) return activate(current);
        return;
      case 'Escape':
        ev.preventDefault();
        if (level > 0) {
          const { parent } = levels[level];
          closeSubmenus(level - 1);
          return parent.focus();
        }
        if (open !== -1 && !inTop) { const k = open; closeMenu(false); tops[k].focus(); return; }
        closeMenu();
        onClose?.();
        return;
      case 'Tab':
        closeMenu();
        return;
    }
  });

  // Alt alone toggles focus on the menu bar; Alt+letter opens a menu.
  let altAlone = false;
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Alt') { altAlone = true; return; }
    if (ev.altKey && !ev.ctrlKey && ev.key.length === 1) {
      const i = letters.indexOf(ev.key.toLowerCase());
      if (i !== -1) { ev.preventDefault(); openMenu(i, true); }
    }
    altAlone = false;
  }, true);
  // Alt+wheel (zoom) or Alt+click is not "Alt alone": don't open the menu.
  document.addEventListener('wheel', (ev) => { if (ev.altKey) altAlone = false; }, { capture: true, passive: true });
  document.addEventListener('mousedown', (ev) => { if (ev.altKey) altAlone = false; }, true);
  document.addEventListener('keyup', (ev) => {
    if (ev.key !== 'Alt' || !altAlone) return;
    altAlone = false;
    ev.preventDefault();
    if (bar.contains(document.activeElement)) { closeMenu(); onClose?.(); } else tops[0].focus();
  });
}
