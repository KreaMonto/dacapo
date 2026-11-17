// Translations of the interface. Every text the user reads goes through
// t('some.key'); the texts themselves live in locales/<lang>.js, one flat
// object per language. English is the reference: a key missing from another
// language falls back to English, and a key missing from English shows the
// key itself (and warns), so a forgotten text is easy to spot.
//
// Placeholders are written {name} and filled from the second argument:
//   t('tab.close', { name: 'Sonata' })  →  'Close Sonata'
// Counts use '.one' / '.other' variants, picked by the language's rules:
//   tn('status.errors', 3)  →  '3 measures with errors'
//
// Static HTML is tagged instead of filled from code:
//   data-i18n="key"              → text content
//   data-i18n-tip / -desc        → tooltip title / explanation
//   data-i18n-aria / -placeholder / -title → those attributes

import en from './locales/en.js';

const LOCALES = { en };
export const LANGUAGES = Object.keys(LOCALES);

/** The language to use: the user's choice if any, else the system's, else English. */
function pickLanguage() {
  let chosen = null;
  try { chosen = JSON.parse(localStorage.getItem('partita.language')); } catch { /* storage unavailable */ }
  const wanted = [chosen, ...(navigator.languages || [navigator.language])].filter(Boolean);
  for (const tag of wanted) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (LOCALES[base]) return base;
  }
  return 'en';
}

export const lang = pickLanguage();
const dict = LOCALES[lang];
const plurals = new Intl.PluralRules(lang);
document.documentElement.lang = lang;

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

/** Whether a key has a text (in this language or English). */
export const has = (key) => key in dict || key in en;

/** The text for `key`, with {placeholders} filled from `vars`. */
export function t(key, vars) {
  const s = dict[key] ?? en[key];
  if (s === undefined) {
    console.warn(`[i18n] missing text: ${key}`);
    return key;
  }
  return fill(s, vars);
}

/** Like t(), choosing `key.one` or `key.other` for the count `n` (also passed as {n}). */
export function tn(key, n, vars) {
  const form = plurals.select(n);
  const k = has(`${key}.${form}`) ? `${key}.${form}` : `${key}.other`;
  return t(k, { n, ...vars });
}

// Key names inside shortcuts ("Ctrl+Shift+S", "Shift + Space") as the
// language writes them; letters, digits and symbols stay as they are.
const KEY_WORDS = /\b(Ctrl|Shift|Alt|Space|Esc|Enter|Del|Backspace|Home|End|Tab)\b/g;
export const keyLabel = (combo) => String(combo).replace(KEY_WORDS, (w) => t(`key.${w}`));

const ATTRS = { tip: 'data-tip', desc: 'data-desc', aria: 'aria-label', placeholder: 'placeholder', title: 'title' };

/** Fills the tagged static HTML under `root` with the current language. */
export function applyTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const [name, attr] of Object.entries(ATTRS)) {
    const data = `i18n${name[0].toUpperCase()}${name.slice(1)}`;
    for (const el of root.querySelectorAll(`[data-i18n-${name}]`)) el.setAttribute(attr, t(el.dataset[data]));
  }
}
