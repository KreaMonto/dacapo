// Classic menu bar (File, Edit, View…), drawn in HTML so it follows the
// app's theme. Built from a plain definition:
//
//   [{ label: 'File', items: [
//       { label: 'New', cmd: 'new', key: 'Ctrl+N' },
//       { sep: true },
//       { label: 'Page', cmd: 'view:page', checked: () => true, radio: true },
//   ]}]
//
// `checked` and `enabled` are functions, evaluated every time a menu opens.
// Keyboard: Alt focuses the bar, Alt+<letter> opens a menu, arrows move,
// Enter/Space activates, Esc closes. The letter is the first one, or the
// one after '&' in a top-level label ('A&yuda' opens with Alt+Y), so a
// translation can avoid two menus starting with the same letter.

import { keyLabel } from './i18n.js';

export function installMenuBar(bar, menus, run, onClose) {
  const amp = (label) => Math.max(0, label.indexOf('&'));
  const letters = menus.map((m) => m.label.replace('&', '')[amp(m.label)].toLowerCase());
  bar.setAttribute('role', 'menubar');
  bar.innerHTML = menus
    .map((m, i) => `<div class="menu"><button class="menu-top" role="menuitem" aria-haspopup="true" aria-expanded="false" aria-keyshortcuts="Alt+${letters[i].toUpperCase()}" data-i="${i}" tabindex="-1">${m.label.replace('&', '')}</button><div class="menu-pop" role="menu" hidden></div></div>`)
    .join('');
  const tops = [...bar.querySelectorAll('.menu-top')];
  let open = -1;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function fill(i) {
    const pop = tops[i].nextElementSibling;
    pop.innerHTML = menus[i].items.map((it, j) => {
      if (it.sep) return '<div class="menu-sep" role="separator"></div>';
      const enabled = it.enabled ? it.enabled() : true;
      const checkable = it.checked !== undefined;
      const checked = checkable && it.checked();
      const role = checkable ? (it.radio ? 'menuitemradio' : 'menuitemcheckbox') : 'menuitem';
      return `<button class="menu-item" role="${role}" data-j="${j}" tabindex="-1"${enabled ? '' : ' disabled aria-disabled="true"'}${checkable ? ` aria-checked="${checked}"` : ''}>`
        + `<span class="menu-check">${checked ? (it.radio ? '●' : '✓') : ''}</span>`
        + `<span class="menu-label">${esc(it.label)}</span><span class="menu-key">${it.key ? esc(keyLabel(it.key)) : ''}</span></button>`;
    }).join('');
  }

  const items = (i) => [...tops[i].nextElementSibling.querySelectorAll('.menu-item:not([disabled])')];

  function openMenu(i, focusFirst = false) {
    if (open !== -1 && open !== i) closeMenu(false);
    open = i;
    fill(i);
    tops[i].setAttribute('aria-expanded', 'true');
    tops[i].classList.add('open');
    tops[i].nextElementSibling.hidden = false;
    if (focusFirst) items(i)[0]?.focus();
    else tops[i].focus();
  }

  function closeMenu(returnFocus = true) {
    if (open === -1) return;
    tops[open].setAttribute('aria-expanded', 'false');
    tops[open].classList.remove('open');
    tops[open].nextElementSibling.hidden = true;
    open = -1;
    if (returnFocus) onClose?.();
  }

  function activate(i, j) {
    const it = menus[i].items[j];
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
    if (item && !item.disabled) activate(open, Number(item.dataset.j));
  });
  // Moving across the bar while a menu is open switches menus, as on desktop.
  bar.addEventListener('mouseover', (ev) => {
    const top = ev.target.closest('.menu-top');
    if (top && open !== -1 && Number(top.dataset.i) !== open) openMenu(Number(top.dataset.i));
    const item = ev.target.closest('.menu-item');
    if (item && !item.disabled) item.focus();
  });
  document.addEventListener('mousedown', (ev) => {
    if (open !== -1 && !bar.contains(ev.target)) closeMenu(false);
  });
  window.addEventListener('blur', () => closeMenu(false));

  bar.addEventListener('keydown', (ev) => {
    const inTop = ev.target.classList.contains('menu-top');
    const i = inTop ? Number(ev.target.dataset.i) : open;
    const list = open !== -1 ? items(open) : [];
    const pos = list.indexOf(document.activeElement);
    const move = (d) => { ev.preventDefault(); openMenu((i + d + tops.length) % tops.length, !inTop || open !== -1); };
    switch (ev.key) {
      case 'ArrowRight': return move(1);
      case 'ArrowLeft': return move(-1);
      case 'ArrowDown':
        ev.preventDefault();
        if (open === -1 || inTop) return openMenu(i, true);
        return list[(pos + 1) % list.length]?.focus();
      case 'ArrowUp':
        ev.preventDefault();
        if (open === -1) return openMenu(i, false), items(i).at(-1)?.focus();
        return list[(pos - 1 + list.length) % list.length]?.focus();
      case 'Enter':
      case ' ':
        ev.preventDefault();
        if (inTop) return openMenu(i, true);
        if (pos >= 0) return activate(open, Number(list[pos].dataset.j));
        return;
      case 'Escape':
        ev.preventDefault();
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
