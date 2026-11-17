// Score renderer: turns a DocView (from Rust) into SVG markup.
// Pure functions only — no Tauri calls — so it can be previewed in any
// browser with fake data (see dev/preview.html).
//
// Music symbols come from Bravura, the SMuFL reference font by Steinberg
// (SIL Open Font License, bundled in src/fonts/). SMuFL fonts are designed
// so that 1 em = 4 staff spaces and every glyph's origin sits on a staff
// position (a G clef's baseline is the G line, a notehead's baseline is its
// center…), which makes placement exact without measuring anything.

import { t } from './i18n.js';

export const SP = 10; // one staff space, in px (CSS .m uses font-size 4·SP)
const STAFF_GAP = 10 * SP; // staff top to next staff top inside a system
const SYSTEM_GAP = 7 * SP;
const MARGIN_X = 28;
const MARGIN_TOP = 5 * SP;
const TICKS_WHOLE = 3840;

// ----- lyrics ------------------------------------------------------------------
// Each event carries one syllable per verse (`event.lyrics[verse]`). Verses
// are lines of text under the staff; a staff gets as many lines as its
// longest list of syllables anywhere in the score.
export const MAX_VERSES = 8; // mirrors partita_core::model::MAX_VERSES
export const LYRIC_PX = 1.7 * SP; // font size
export const LYRIC_FONT = 'Georgia, "Times New Roman", serif';
const LYRIC_LINE = 2.3 * SP; // from one verse's baseline to the next
const LYRIC_Y0 = 8.2 * SP; // staff top to the first baseline, unless low notes need more
const LYRIC_CLEAR = 1.4 * SP; // least air between the lowest note, stem or beam and the words
const LYRIC_GAP = 0.6 * SP; // least space between two syllables
const HYPHEN_ROOM = 0.9 * SP; // extra space when a hyphen sits between them
const LYRIC_LEAD = 1.1 * SP; // a measure's first note is this far right of where its lyrics may start

let measureCtx;
const widthCache = new Map();
/**
 * Width of a text in layout units, in a style (the lyrics' by default);
 * estimated where no canvas exists.
 */
function textWidth(text, st = currentStyle('lyrics')) {
  const font = cssFont(st);
  const key = `${font}\u0000${text}`;
  let w = widthCache.get(key);
  if (w !== undefined) return w;
  if (measureCtx === undefined) {
    try { measureCtx = document.createElement('canvas').getContext('2d'); } catch { measureCtx = null; }
  }
  if (measureCtx) {
    measureCtx.font = font;
    w = measureCtx.measureText(text).width;
  } else {
    w = text.length * st.size * 0.5;
  }
  widthCache.set(key, w);
  return w;
}
/** Lyrics font size and the distance between verses, as the lyrics style says. */
const lyricPx = () => currentStyle('lyrics').size;
const lyricLine = () => (LYRIC_LINE * lyricPx()) / LYRIC_PX;
/**
 * The name shown at the start of a staff, or '' for none: a single staff
 * with the automatic name ("Staff 1") shows nothing, as in a lead sheet.
 */
export function shownStaffName(score, staff) {
  const name = (score.staves[staff].name || '').trim();
  if (!name) return '';
  if (score.staves.length === 1 && /^Staff \d+$/.test(name)) return '';
  return name;
}
const NAME_GAP = 1.4 * SP; // between a staff name and the start of the staff
const GROUP_W = 1.6 * SP; // room for brackets and braces left of the staves

/** Short name shown on the systems after the first ('' for none). */
export function shownShortName(score, staff) {
  return (score.staves[staff].short_name || '').trim();
}

/**
 * The key a staff shows for a concert-pitch key: transposing instruments
 * (B-flat clarinet, F horn) read in another key. Mirrors
 * Transposition::written_key in Rust.
 */
export function writtenFifths(staff, fifths) {
  const t = staff.transposition;
  if (!t || (!t.diatonic && !t.chromatic)) return fifths;
  let f = fifths - (7 * t.chromatic - 12 * t.diatonic);
  while (f > 7) f -= 12;
  while (f < -7) f += 12;
  return f;
}

/**
 * Runs of consecutive staves joined by a bracket or brace:
 * [{ first, last, kind }], groups of one staff left out.
 */
export function staffGroups(score) {
  const out = [];
  score.staves.forEach((st, i) => {
    const g = st.group;
    const prev = out[out.length - 1];
    if (g && prev && prev.id === g.id && prev.last === i - 1) prev.last = i;
    else if (g) out.push({ id: g.id, kind: g.kind, first: i, last: i });
  });
  return out.filter((g) => g.last > g.first);
}

const syllableAt = (e, verse) => (e.lyrics && e.lyrics[verse] && e.lyrics[verse].text ? e.lyrics[verse] : null);

// ----- paper (page view) -----------------------------------------------------
// Pages are laid out in staff spaces assuming the common 7 mm staff
// (1 space = 1.75 mm), so a page keeps its real proportions on screen and in
// print, where it is scaled to the paper.
export const PAPER = { a4: { w: 210, h: 297 }, letter: { w: 215.9, h: 279.4 } };
const MM_PER_SP = 1.75;
const PAGE_MARGIN_MM = 15;

// ----- texts around the music ------------------------------------------------
// The headings of page 1 (title, composer...), the running header and footer
// and the page numbers, all from the score's metadata (see Metadata in
// model.rs). Drawn in the SVG so they print exactly as shown; clicking one
// edits it (app.js), which `data-text` names.

export const TEXT_FONT = 'Georgia, "Times New Roman", serif';

// ----- text styles ---------------------------------------------------------------
// Every kind of text has a style (TextKind and TextStyle in model.rs): the
// defaults below, with what the score changed. Text boxes have their own.

/** Layout units in a typographic point (a staff space is 1.75 mm). */
export const UNITS_PER_PT = (SP / 1.75) * (25.4 / 72);
/** The default look of each kind of text: size in layout units. */
export const TEXT_DEFAULTS = {
  title: { size: 4.2 * SP, bold: true },
  subtitle: { size: 2.3 * SP },
  composer: { size: 1.8 * SP },
  lyricist: { size: 1.8 * SP },
  dedication: { size: 1.6 * SP, italic: true },
  part: { size: 1.6 * SP },
  copyright: { size: 1.4 * SP },
  header: { size: 1.5 * SP },
  footer: { size: 1.5 * SP },
  page_number: { size: 1.5 * SP },
  tempo: { size: 2 * SP, bold: true },
  expression: { size: 1.7 * SP, italic: true },
  technique: { size: 1.7 * SP },
  rehearsal: { size: 2 * SP, bold: true },
  lyrics: { size: LYRIC_PX },
  staff_name: { size: LYRIC_PX },
  text_box: { size: 2 * SP },
};
/** The kinds whose style the score keeps (text boxes keep their own). */
export const TEXT_KINDS = Object.keys(TEXT_DEFAULTS).filter((k) => k !== 'text_box');

/** How a text looks: a kind's default with what `style` changes. */
export function resolveStyle(kind, style = {}) {
  const d = TEXT_DEFAULTS[kind] || TEXT_DEFAULTS.text_box;
  const font = (style.font || '').replace(/["'\\<>]/g, '');
  return {
    font,
    family: font ? `"${font}", ${TEXT_FONT}` : TEXT_FONT,
    size: style.size ? (style.size / 10) * UNITS_PER_PT : d.size,
    bold: style.bold ?? !!d.bold,
    italic: style.italic ?? !!d.italic,
  };
}
let styles = {}; // the styles of the score being laid out and drawn, resolved
function useStyles(score) {
  styles = Object.fromEntries(TEXT_KINDS.map((k) => [k, resolveStyle(k, score.text_styles?.[k])]));
}
/** The style of a kind of text in the score laid out last. */
export const currentStyle = (kind) => styles[kind] || resolveStyle(kind);
/** A style as a CSS `font` value (sizes in layout units, or `size`). */
export const cssFont = (st, size = st.size) => `${st.italic ? 'italic ' : ''}${st.bold ? 700 : 400} ${size}px ${st.family}`;
/** A style as SVG attributes. */
const styleAttrs = (st) =>
  `font-family='${st.family}' font-size="${st.size}" font-weight="${st.bold ? 700 : 400}" font-style="${st.italic ? 'italic' : 'normal'}"`;

const PAGE_NUMBERS = { show: true, edge: 'top', align: 'right', first_page: false, format: '{page}' };

// ----- tempo markings -----------------------------------------------------------
// "Andante con moto ♩ = 76" above the top staff, where a measure has a
// marking (TempoMark in model.rs). What prints is chosen apart from what
// plays: a hidden marking still sets the tempo.

/** Length of each beat unit in eighth notes, and its SMuFL metronome glyph. */
export const BEATS = {
  eighth: { eighths: 1, glyph: '\uECA7' },
  quarter: { eighths: 2, glyph: '\uECA5' },
  dotted_quarter: { eighths: 3, glyph: '\uECA5\u2009\uECB7' },
  half: { eighths: 4, glyph: '\uECA3' },
  dotted_half: { eighths: 6, glyph: '\uECA3\u2009\uECB7' },
};
/** The number a metronome mark shows for a tempo in quarter notes per minute. */
export const perMinute = (quarterBpm, beat) => Math.floor((quarterBpm * 2 + BEATS[beat].eighths / 2) / BEATS[beat].eighths);
/** Quarter notes per minute for `n` beats of `beat` per minute. */
export const toQuarterBpm = (n, beat) => Math.floor((n * BEATS[beat].eighths + 1) / 2);

const TEMPO_ROOM = 2.6 * SP; // above a system that shows a marking, at the default size

/** The metronome value a marking shows: the opening tempo in measure 1. */
const markBpm = (mark, m, score) => (m === 0 ? score.tempo ?? 100 : mark.bpm);
/** Whether a measure's marking prints anything. */
function tempoShown(mark, m, score) {
  if (!mark) return false;
  return (mark.show_text && !!mark.text) || (mark.show_metronome && !!markBpm(mark, m, score));
}

/** The metadata with every field, also for a view from an older backend. */
export function fullMetadata(m = {}) {
  return {
    title: '', composer: '', subtitle: '', dedication: '', lyricist: '', part: '', copyright: '', header: '', footer: '',
    ...m,
    page_numbers: { ...PAGE_NUMBERS, ...(m.page_numbers || {}) },
  };
}

/** A text with its {page}, {pages}, {title} and {composer} filled in. */
export function fillTokens(text, vars) {
  return String(text).replace(/\{(page|pages|title|composer)\}/g, (_, k) => String(vars[k] ?? ''));
}

/**
 * The headings of page 1, top to bottom: where each sits (`y` is its
 * baseline below the top of the block) and the height of the block. The
 * title and composer keep their place even when empty, so they can be
 * clicked to type them; the other lines take room only when they have text.
 */
function headingLayout(meta) {
  const lines = [];
  let y = 0;
  if (meta.part || meta.dedication) {
    y += Math.max(currentStyle('part').size, currentStyle('dedication').size);
    lines.push({ key: 'part', align: 'left', y }, { key: 'dedication', align: 'center', y });
    y += 0.9 * SP;
  }
  const size = (k) => currentStyle(k).size;
  y += 0.85 * size('title');
  lines.push({ key: 'title', align: 'center', y });
  if (meta.subtitle) {
    y += 0.5 * SP + 0.9 * size('subtitle');
    lines.push({ key: 'subtitle', align: 'center', y });
  }
  y += 0.6 * SP + Math.max(size('composer'), size('lyricist'));
  lines.push({ key: 'lyricist', align: 'left', y }, { key: 'composer', align: 'right', y });
  return { lines, height: y + 1.4 * SP };
}

/** Page size and margin in layout units for a paper name. */
export function pageGeometry(paper) {
  const p = PAPER[paper] || PAPER.a4;
  const unit = SP / MM_PER_SP;
  return { w: p.w * unit, h: p.h * unit, margin: PAGE_MARGIN_MM * unit };
}

// Note values from longest to shortest. The index is used throughout: a
// value lasts (2 wholes >> index) ticks; 0 = breve, 4 = eighth, 8 = 128th.
const BASES = ['breve', 'whole', 'half', 'quarter', 'eighth', 'sixteenth', 'thirty_second', 'sixty_fourth', 'hundred_twenty_eighth'];
const V_WHOLE = 1;
const V_HALF = 2;
const V_EIGHTH = 4;
const STEP_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const CLEF_MIDDLE = { treble: 34, bass: 22, alto: 28, tenor: 26 }; // diatonic index of middle line
// Key-signature positions (steps above middle line) for treble; other clefs shift.
const KEY_SHARPS = [4, 1, 5, 2, -1, 3, 0];
const KEY_FLATS = [0, 3, -1, 2, -2, 1, -3];
const CLEF_KEY_SHIFT = { treble: 0, bass: -2, alto: -1, tenor: 1 };

// ----- SMuFL glyphs (Bravura) ------------------------------------------------

const CLEF = {
  treble: { g: '', line: 3 }, // baseline on the G line (lines counted from the top)
  bass: { g: '', line: 1 }, // baseline on the F line
  alto: { g: '', line: 2 }, // baseline on the C line
  tenor: { g: '', line: 1 },
};
const HEAD = ['\uE0A0', '\uE0A2', '\uE0A3', '\uE0A4']; // breve, whole, half, black
const REST = ['\uE4E2', '\uE4E3', '\uE4E4', '\uE4E5', '\uE4E6', '\uE4E7', '\uE4E8', '\uE4E9', '\uE4EA']; // breve … 128th
const FLAG_UP = ['\uE240', '\uE242', '\uE244', '\uE246', '\uE248']; // 8th … 128th
const FLAG_DOWN = ['\uE241', '\uE243', '\uE245', '\uE247', '\uE249'];
const ACC = { '-2': '', '-1': '', '0': '', '1': '', '2': '' };
const DOT = '';
// Articulations: [above, below]. Fermata is always above.
const ARTIC = {
  staccato: ['', ''],
  staccatissimo: ['', ''],
  tenuto: ['', ''],
  accent: ['', ''],
  marcato: ['', ''],
};
const FERMATA = '';
export const DYNAMIC = {
  ppp: '', pp: '', p: '', mp: '', mf: '',
  f: '', ff: '', fff: '', sfz: '', fp: '',
};
const timeDigits = (n) => String(n).split('').map((d) => String.fromCharCode(0xe080 + Number(d))).join('');

// Glyph widths in staff spaces (from Bravura's metadata).
const HEAD_W = [2.5, 1.688, 1.18, 1.18];
const REST_W = [0.5, 1.128, 1.128, 1.08, 0.988, 1.28, 1.48, 1.712, 1.94];
const ACC_W = { '-2': 1.644, '-1': 0.904, '0': 0.672, '1': 0.996, '2': 0.988 };
const STEM_W = 0.12 * SP;
const STEM_LEN = 3.5 * SP;
const BEAM_T = 0.5 * SP; // beam thickness
const BEAM_STEP = 0.75 * SP; // from one beam to the next (thickness + gap)
const CLEF_COL = 3.6 * SP; // room for the widest clef (C clef, 2.8 spaces) plus gap

/** A music glyph: baseline at (x, y). */
const glyph = (g, x, y, cls = '') => `<text class="m${cls ? ` ${cls}` : ''}" x="${x}" y="${y}">${g}</text>`;

// Serde gives enum variants as written in Rust: DurationBase is PascalCase.
const baseKey = (b) => b.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

/** Index of a duration's base value in BASES (0 = breve … 8 = 128th). */
const valueIdx = (d) => BASES.indexOf(baseKey(d.base));

export function durationTicks(d) {
  const base = (2 * TICKS_WHOLE) >> valueIdx(d);
  let t = 0;
  for (let i = 0; i <= d.dots; i++) t += base >> i;
  return t;
}

const diatonic = (p) => p.octave * 7 + STEP_INDEX[p.step];
const capacity = (attrs) => attrs.time.beats * (TICKS_WHOLE / attrs.time.beat_type);
const pitchesOf = (e) => (e.kind === 'rest' ? [] : e.kind.chord.pitches);

export function keyAlter(fifths, step) {
  const n = Math.min(Math.abs(fifths), 7);
  if (fifths > 0 && SHARP_ORDER.slice(0, n).includes(step)) return 1;
  if (fifths < 0 && SHARP_ORDER.slice(7 - n).includes(step)) return -1;
  return 0;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * A voice holding a single rest that fills the measure. A plain whole rest
 * means "whole measure" in any time signature. Mirrors
 * `partita_core::model::is_measure_rest`.
 */
export function isMeasureRest(events, cap) {
  if (events.length !== 1 || events[0].kind !== 'rest') return false;
  const d = events[0].duration;
  return durationTicks(d) === cap || (baseKey(d.base) === 'whole' && d.dots === 0);
}

/**
 * Computes positions of systems, measures and events.
 * - `opts.multiRest`: merge runs of rest-only measures into one multi-measure rest.
 * - `opts.view`: 'wrap' (fill `width`, default), 'continuous' (one endless
 *   line) or 'page' (systems flow onto pages of `opts.paper`, as printed).
 * - `opts.lyricEdit`: `{ staff, verse }` being typed, so a verse that has no
 *   text yet already gets its line.
 */
export function layout(view, width, opts = {}) {
  const score = view.score;
  useStyles(score);
  const nStaves = score.staves.length;
  const mode = opts.view || 'wrap';
  const geo = mode === 'page' ? pageGeometry(opts.paper) : null;
  const marginX = geo ? geo.margin : MARGIN_X;
  const meta = fullMetadata(score.metadata);
  // Page 1 headings: across the page, or across the window in the other
  // views (in continuous view the music may be far wider than the window).
  const heading = headingLayout(meta);
  heading.top = geo ? geo.margin : MARGIN_TOP;
  heading.left = marginX;
  heading.right = (geo ? geo.w : Math.max(300, width)) - marginX;
  const avail = geo ? geo.w - 2 * geo.margin
    : mode === 'continuous' ? Infinity
      : Math.max(300, width - 2 * MARGIN_X);

  // Lines of lyrics under each staff.
  const verses = score.staves.map((staff, s) => {
    let n = opts.lyricEdit && opts.lyricEdit.staff === s ? opts.lyricEdit.verse + 1 : 0;
    for (const cell of staff.measures) {
      for (const voice of cell.voices) for (const e of voice) if (e.lyrics) n = Math.max(n, e.lyrics.length);
    }
    return Math.min(n, MAX_VERSES);
  });

  const single = score.measures.map((attrs, m) => {
    let maxEvents = 0;
    let maxFill = 0;
    let restOnly = true;
    // Per staff: the fullest voice, when it exceeds the time signature.
    const overfull = new Map();
    // Room the syllables need: [ticks between two of them, width], and
    // [ticks from the last one to the barline, width].
    const lyricNeeds = [];
    score.staves.forEach((staff, s) => {
      staff.measures[m].voices.forEach((voice, v) => {
        const mrest = isMeasureRest(voice, capacity(attrs));
        const fill = mrest ? capacity(attrs) : voice.reduce((t, e) => t + durationTicks(e.duration), 0);
        maxEvents = Math.max(maxEvents, voice.length);
        maxFill = Math.max(maxFill, fill);
        if (fill > capacity(attrs)) overfull.set(s, Math.max(overfull.get(s) || 0, fill));
        if (v === 0 ? !mrest : voice.length > 0) restOnly = false;
        for (let k = 0; k < verses[s]; k++) {
          let tick = 0;
          let last = null; // { tick, right, hyphen }
          for (const e of voice) {
            const syl = syllableAt(e, k);
            if (syl) {
              const w = textWidth(syl.text);
              if (last) lyricNeeds.push([tick - last.tick, last.right + w / 2 + LYRIC_GAP + (last.hyphen ? HYPHEN_ROOM : 0)]);
              // How far it reaches right of its note: half of it, or more
              // when the barline on its left stops it (see drawLyrics).
              last = { tick, right: tick === 0 ? Math.max(w / 2, w - LYRIC_LEAD) : w / 2, hyphen: syl.join === 'hyphen' };
            }
            tick += durationTicks(e.duration);
          }
          if (last) lyricNeeds.push([-last.tick, last.right - 1.2 * SP]);
        }
      });
    });
    const cap = Math.max(capacity(attrs), maxFill, 1);
    const prev = m > 0 ? score.measures[m - 1] : null;
    // Events are spaced by time, so two syllables `dt` ticks apart need the
    // whole measure to be `cap / dt` times as wide as they are.
    let lyricW = 0;
    for (const [dt, need] of lyricNeeds) {
      const ticks = dt > 0 ? dt : cap + dt; // (negative: measured from the barline)
      if (ticks > 0 && need > 0) lyricW = Math.max(lyricW, (need * cap) / ticks);
    }
    return {
      m, mEnd: m, attrs, cap, restOnly,
      tempo: attrs.tempo || null,
      tempoShown: tempoShown(attrs.tempo, m, score),
      rehearsal: attrs.rehearsal || null,
      overfull,
      content: Math.max(9 * SP, maxEvents * 3.6 * SP + 2 * SP, Math.min(lyricW, 80 * SP) + 2.6 * SP),
      timeChange: !prev || prev.time.beats !== attrs.time.beats || prev.time.beat_type !== attrs.time.beat_type,
      keyChange: !!prev && prev.key.fifths !== attrs.key.fifths,
    };
  });

  // Multi-measure rests: a run of 2+ rest-only measures with no time or
  // key change inside becomes a single wide entry.
  const measures = [];
  for (let i = 0; i < single.length; i++) {
    let j = i;
    if (opts.multiRest && single[i].restOnly) {
      // A tempo marking (even a hidden one) starts a new run: it may change the tempo.
      while (j + 1 < single.length && single[j + 1].restOnly && !single[j + 1].timeChange && !single[j + 1].keyChange && !single[j + 1].tempo && !single[j + 1].rehearsal) j++;
    }
    if (j > i) {
      measures.push({ ...single[i], mEnd: single[j].m, multi: j - i + 1, content: 13 * SP });
    } else {
      measures.push(single[i]);
    }
    i = j;
  }
  // Every score measure -> the layout entry that draws it.
  const byMeasure = [];
  for (const ms of measures) for (let m = ms.m; m <= ms.mEnd; m++) byMeasure[m] = ms;

  // Staff names sit left of the systems: full names on the first, short
  // names on the others. Brackets and braces need room too.
  const groups = staffGroups(score);
  const groupIndent = groups.length ? GROUP_W : 0;
  // In a braced group of staves with one name (a piano), it is shown once.
  const sharedName = (list) => {
    const out = [...list];
    for (const g of groups) {
      if (g.kind !== 'brace') continue;
      const named = out.slice(g.first, g.last + 1).filter(Boolean);
      if (named.length > 1 && named.every((n) => n === named[0])) {
        for (let st = g.first + 1; st <= g.last; st++) out[st] = '';
      }
    }
    return out;
  };
  const names = sharedName(score.staves.map((_, st) => shownStaffName(score, st)));
  const shortNames = sharedName(score.staves.map((_, st) => shownShortName(score, st)));
  const widest = (list) => (list.some(Boolean) ? Math.max(...list.map((n) => (n ? textWidth(n, currentStyle('staff_name')) : 0))) + NAME_GAP : 0);
  const nameIndent = widest(names) + groupIndent;
  const shortIndent = widest(shortNames) + groupIndent;

  const keyWidth = (f) => Math.abs(f) * 1.05 * SP;
  // The widest key signature among the staves (transposing ones differ).
  const keyRoom = (fifths) => Math.max(...score.staves.map((st) => keyWidth(writtenFifths(st, fifths))));
  const systems = [];
  let sys = null;
  for (const ms of measures) {
    const startPrefix = 0.6 * SP + CLEF_COL + keyRoom(ms.attrs.key.fifths) + (ms.timeChange ? 2.8 * SP : 0) + SP;
    const midPrefix = (ms.keyChange ? keyRoom(ms.attrs.key.fifths) + SP : 0) + (ms.timeChange ? 2.8 * SP : 0);
    const room = avail - (systems.length === 1 ? nameIndent : shortIndent);
    const fitsMid = sys && sys.width + midPrefix + ms.content <= room;
    if (!fitsMid) {
      sys = { measures: [], width: 0 };
      systems.push(sys);
      ms.prefix = startPrefix;
      ms.systemStart = true;
    } else {
      ms.prefix = midPrefix;
      ms.systemStart = false;
    }
    ms.w = ms.prefix + ms.content;
    sys.width += ms.w;
    sys.measures.push(ms);
  }

  // Staff positions inside each system. A staff with lyrics takes more
  // room: the text starts below the lowest note of that line of music.
  for (const s of systems) {
    s.lyricY = score.staves.map((staff, st) => {
      if (!verses[st]) return LYRIC_Y0;
      const mid = CLEF_MIDDLE[staff.clef];
      let low = 0; // lowest ink, from the staff top
      for (const ms of s.measures) {
        if (ms.multi) continue;
        const voices = staff.measures[ms.m].voices;
        const multi = voices.filter((v) => v.length).length > 1;
        voices.forEach((voice, v) => {
          const headY = (e) => 2 * SP + (mid - Math.min(...pitchesOf(e).map(diatonic))) * (SP / 2);
          // Beamed groups: a beam under the notes sits lower than a single
          // stem would (longer stems for extra beams, plus the slant).
          const beamed = new Set();
          const groups = isMeasureRest(voice, capacity(ms.attrs)) ? [] : beamGroups(voice, ms.attrs.time);
          for (const g of groups) {
            const events = g.map((i) => voice[i]);
            g.forEach((i) => beamed.add(i));
            if (multi ? v % 2 === 0 : groupStemsUp(events, mid)) {
              for (const e of events) low = Math.max(low, headY(e) + 0.5 * SP);
              continue;
            }
            const count = Math.max(...events.map((e) => valueIdx(e.duration) - V_EIGHTH)) + 1;
            const minLen = Math.max(STEM_LEN, 2.5 * SP + (count - 1) * BEAM_STEP);
            low = Math.max(low, Math.max(...events.map(headY)) + minLen + SP);
          }
          voice.forEach((e, i) => {
            const ds = pitchesOf(e).map(diatonic);
            if (!ds.length || beamed.has(i)) return;
            const lo = Math.min(...ds);
            const hi = Math.max(...ds);
            const up = multi ? v % 2 === 0 : (lo + hi) / 2 < mid;
            const stem = valueIdx(e.duration) >= V_HALF && !up;
            low = Math.max(low, stem ? headY(e) + STEM_LEN + Math.max(0, valueIdx(e.duration) - 5) * 0.5 * SP : headY(e) + 0.5 * SP);
          });
        });
      }
      return Math.max(LYRIC_Y0, low + 0.75 * lyricPx() + LYRIC_CLEAR);
    });
    // Bottom of each staff's block: the staff itself, or its last verse.
    const bottom = (st) => (verses[st] ? s.lyricY[st] + (verses[st] - 1) * lyricLine() + 0.7 * SP : 4 * SP);
    s.staffY = [0];
    for (let st = 0; st + 1 < nStaves; st++) s.staffY.push(s.staffY[st] + Math.max(STAFF_GAP, bottom(st) + 3.3 * SP));
    s.span = s.staffY[nStaves - 1] + 4 * SP; // first staff line to last staff line
    s.height = s.staffY[nStaves - 1] + Math.max(4 * SP, bottom(nStaves - 1) - 2 * SP);
  }
  // Vertical placement. Page view flows systems onto pages (a system that
  // would cross the bottom margin starts the next page); the other views
  // stack them on one endless sheet.
  const pageTop = (p) => (geo ? p * geo.h : 0);
  let page = 0;
  let y = heading.top + heading.height + MARGIN_TOP;
  systems.forEach((s, i) => {
    // Room above for a tempo marking.
    const above = s.measures.some((ms) => ms.tempoShown || ms.rehearsal)
      ? TEMPO_ROOM + Math.max(0, Math.max(currentStyle('tempo').size, currentStyle('rehearsal').size) - 2 * SP)
      : 0;
    if (geo && i > 0 && y + above + s.height + 2 * SP > pageTop(page) + geo.h - geo.margin) {
      page++;
      y = pageTop(page) + geo.margin + MARGIN_TOP;
    }
    s.index = i;
    s.page = page;
    s.y = y + above;
    y += above + s.height + SYSTEM_GAP;
    // Justify every system but the last (unless it is already nearly full).
    const last = i === systems.length - 1;
    const indent = i === 0 ? nameIndent : shortIndent;
    const room = avail - indent;
    const stretch = Number.isFinite(room) && (!last || s.width > room * 0.75) ? (room - s.width) / s.measures.length : 0;
    let x = marginX + indent;
    for (const ms of s.measures) {
      ms.w += Math.max(0, stretch);
      ms.x = x;
      ms.system = s;
      ms.contentX = x + ms.prefix + 1.4 * SP;
      ms.contentW = ms.w - ms.prefix - 2.6 * SP;
      x += ms.w;
    }
    s.x0 = marginX + indent;
    s.width = x - s.x0;
  });

  const contentWidth = Math.max(...systems.map((s) => s.x0 - marginX + s.width), 0) + 2 * marginX;
  const totalWidth = geo ? geo.w : mode === 'continuous' ? Math.max(width, contentWidth) : Math.max(width, avail + 2 * marginX);
  // Below the last staff: room for low notes' stems and beams.
  const totalHeight = geo ? (page + 1) * geo.h : y - SYSTEM_GAP + 2 * MARGIN_TOP;
  // The regions drawn as separate SVGs: one per page, or one for the sheet.
  const pages = geo
    ? Array.from({ length: page + 1 }, (_, p) => ({ index: p, x: 0, y: pageTop(p), w: geo.w, h: geo.h }))
    : [{ index: 0, x: 0, y: 0, w: totalWidth, h: totalHeight }];

  return {
    systems, measures, byMeasure, nStaves, pages, mode, geo, marginX, verses, names, shortNames, groups, groupIndent, meta, heading,
    width: totalWidth,
    height: totalHeight,
    staffTop: (ms, staff) => ms.system.y + ms.system.staffY[staff],
    /** Baseline of a verse under a staff of a system. */
    lyricY: (system, staff, verse) => system.y + system.staffY[staff] + system.lyricY[staff] + verse * lyricLine(),
    tickX: (ms, tick) => ms.contentX + (tick / ms.cap) * ms.contentW,
  };
}

/** Horizontal center of a measure's content: where a measure rest sits. */
const centerX = (ms) => ms.contentX + ms.contentW / 2;

/** x (center) of each event's notehead/rest in a voice. */
function eventXs(lay, ms, events) {
  if (isMeasureRest(events, capacity(ms.attrs))) return [centerX(ms)];
  let tick = 0;
  return events.map((e) => {
    const x = lay.tickX(ms, tick);
    tick += durationTicks(e.duration);
    return x;
  });
}

/** x of the caret gap before event `index` (or after the last one). */
function gapX(lay, ms, events, index) {
  if (ms.multi) return ms.contentX - 0.6 * SP;
  if (isMeasureRest(events, capacity(ms.attrs))) {
    return index === 0 ? ms.contentX - 0.6 * SP : centerX(ms) + 1.6 * SP;
  }
  let tick = 0;
  for (let i = 0; i < index && i < events.length; i++) tick += durationTicks(events[i].duration);
  if (index < events.length) return lay.tickX(ms, tick) - 1.0 * SP;
  if (events.length === 0) return ms.contentX - 0.6 * SP;
  const lastStart = tick - durationTicks(events[events.length - 1].duration);
  return Math.max(lay.tickX(ms, tick) - 1.0 * SP, lay.tickX(ms, lastStart) + 1.6 * SP);
}

/** The staff of a system whose middle line is closest to y. */
function nearestStaff(s, y) {
  let best = 0;
  s.staffY.forEach((sy, st) => {
    if (Math.abs(y - (s.y + sy + 2 * SP)) < Math.abs(y - (s.y + s.staffY[best] + 2 * SP))) best = st;
  });
  return best;
}

/** Maps a click to a caret position. */
export function hitTest(lay, view, x, y, voice) {
  let best = null;
  for (const s of lay.systems) {
    const top = s.y - 3 * SP;
    const bottom = s.y + s.span + 3 * SP;
    const dist = y < top ? top - y : y > bottom ? y - bottom : 0;
    if (!best || dist < best.dist) best = { s, dist };
  }
  if (!best) return null;
  const s = best.s;
  const staff = nearestStaff(s, y);
  const ms = s.measures.find((m) => x < m.x + m.w) || s.measures[s.measures.length - 1];
  if (ms.multi) return { staff, measure: ms.m, voice, index: 0 };
  const events = view.score.staves[staff].measures[ms.m].voices[voice];
  const index = eventXs(lay, ms, events).filter((ex) => x > ex + 0.2 * SP).length;
  return { staff, measure: ms.m, voice, index };
}

/**
 * Draws the tempo markings that print something, above the top staff at the
 * start of their measure (over the clef at the start of a system). Each
 * carries `data-tempo` (its measure): a click opens it.
 */
function drawTempoMarks(lay, score, push, onPage) {
  let system = null;
  let right = -Infinity; // where the previous marking of this system ends
  for (const ms of lay.measures) {
    if (!ms.tempoShown && !ms.rehearsal) continue;
    onPage(ms.system.page);
    if (ms.system !== system) { system = ms.system; right = -Infinity; }
    const y = lay.staffTop(ms, 0) - 3.2 * SP;
    // A rehearsal mark sits in a box on the barline (over the clef at the
    // start of a system); the tempo marking follows it.
    if (ms.rehearsal) {
      const st = currentStyle('rehearsal');
      const w = textWidth(ms.rehearsal, st) + 0.6 * st.size;
      const bx = Math.max(ms.systemStart ? ms.system.x0 : ms.x - w / 2, right + 1.2 * SP);
      push(`<g class="rehearsal" data-rehearsal="${ms.m}"><rect x="${bx}" y="${y - 1.05 * st.size}" width="${w}" height="${1.4 * st.size}" rx="2"/>`
        + `<text ${styleAttrs(st)} text-anchor="middle" x="${bx + w / 2}" y="${y}">${esc(ms.rehearsal)}</text></g>`);
      right = bx + w;
    }
    if (!ms.tempoShown) continue;
    const mark = ms.tempo;
    // At the start of the measure, unless the previous marking still runs
    // there (narrow measures): then right after it.
    const x = Math.max(ms.systemStart ? ms.system.x0 : ms.x + 0.6 * SP, right + 1.2 * SP);
    const parts = [];
    let width = 0;
    const st = currentStyle('tempo');
    const plain = { ...st, bold: false, italic: false };
    if (mark.show_text && mark.text) {
      parts.push(`<tspan class="tempo-words" font-weight="${st.bold ? 700 : 400}" font-style="${st.italic ? 'italic' : 'normal'}">${esc(mark.text)}</tspan>`);
      width += textWidth(mark.text, st);
    }
    const bpm = markBpm(mark, ms.m, score);
    if (mark.show_metronome && bpm) {
      const beat = BEATS[mark.beat] ? mark.beat : 'quarter';
      const value = `\u2009\u00a0=\u00a0${perMinute(bpm, beat)}`;
      parts.push(`<tspan class="tempo-note" font-family="Bravura" font-size="${1.6 * st.size}">${BEATS[beat].glyph}</tspan><tspan>${value}</tspan>`);
      width += (parts.length > 1 ? textWidth('\u00a0\u00a0', plain) : 0)
        + (BEATS[beat].eighths % 3 === 0 ? 0.95 : 0.6) * st.size + textWidth(value, plain);
    }
    right = x + width;
    push(`<text class="tempo" data-tempo="${ms.m}" font-family='${st.family}' font-size="${st.size}" font-weight="400" x="${x}" y="${y}">${parts.join('\u00a0\u00a0')}</text>`);
  }
}

/** Layout units in a tenth of a millimetre (text boxes are placed in those). */
export const UNITS_PER_TENTH_MM = SP / 17.5;

/**
 * Where a text box is drawn: its page (the last one if the music now has
 * fewer pages) and the anchor of its first line, in layout units.
 */
export function textBoxAnchor(lay, box) {
  const page = lay.pages[Math.min(box.page, lay.pages.length - 1)];
  return { page: page.index, x: page.x + box.x * UNITS_PER_TENTH_MM, y: page.y + box.y * UNITS_PER_TENTH_MM };
}

/**
 * Text boxes, in page view only: they belong to a place on a page. Each
 * carries `data-box` (its id): a click edits it, a drag moves it. The box
 * being typed (`opts.boxEdit`) shows its new look at once; a new one shows
 * a hint where it goes.
 */
function drawTextBoxes(lay, score, push, onPage, opts) {
  if (!lay.geo) return;
  const edit = opts.boxEdit;
  const boxes = (score.text_boxes || []).map((b) =>
    (edit && edit.id === b.id ? { ...b, style: edit.style, align: edit.align, frame: edit.frame } : b));
  if (edit && edit.id === 'new') boxes.push({ ...edit, text: edit.hint, hint: true });
  for (const box of boxes) {
    const at = textBoxAnchor(lay, box);
    onPage(at.page);
    const st = resolveStyle('text_box', box.style);
    const lines = String(box.text).split('\n');
    const lineH = 1.25 * st.size;
    const align = box.align || 'left';
    const anchor = { left: 'start', center: 'middle', right: 'end' }[align];
    const widths = lines.map((l) => textWidth(l || ' ', st));
    const w = Math.max(...widths, st.size);
    const left = align === 'left' ? at.x : align === 'right' ? at.x - w : at.x - w / 2;
    const pad = 0.35 * st.size;
    const top = at.y - 0.95 * st.size;
    const height = lineH * (lines.length - 1) + 1.3 * st.size;
    push(`<g class="tbox${box.hint ? ' placeholder' : ''}${box.frame ? ' framed' : ''}" data-box="${box.id}">`
      // The frame, or an invisible area to grab the box by.
      + `<rect class="tbox-area" x="${left - pad}" y="${top - pad}" width="${w + 2 * pad}" height="${height + 2 * pad}"/>`
      + `<text ${styleAttrs(st)} text-anchor="${anchor}" x="${at.x}" y="${at.y}">${lines.map((l, i) =>
        `<tspan x="${at.x}" dy="${i ? lineH : 0}">${esc(l) || '\u00a0'}</tspan>`).join('')}</text></g>`);
  }
}

/**
 * Draws the texts around the music: the headings of page 1 (in every view)
 * and, in page view, the running header, the footer, the copyright and the
 * page numbers. With `opts.placeholders`, an empty title or composer shows
 * a grey hint to click (not printed).
 */
function drawPageTexts(lay, push, onPage, opts) {
  const meta = lay.meta;
  const h = lay.heading;
  const anchorOf = { left: 'start', center: 'middle', right: 'end' };
  const xOf = (align, left, right) => (align === 'left' ? left : align === 'right' ? right : (left + right) / 2);
  const text = (key, value, x, y, align, extra = '') => push(
    `<text class="ptext ptext-${key}${extra}" data-text="${key}" ${styleAttrs(currentStyle(key === 'pnum' ? 'page_number' : key))} `
    + `text-anchor="${anchorOf[align]}" x="${x}" y="${y}">${esc(value)}</text>`);
  onPage(0);
  for (const line of h.lines) {
    const value = meta[line.key];
    const x = xOf(line.align, h.left, h.right);
    if (value) text(line.key, value, x, h.top + line.y, line.align);
    else if (opts.placeholders && (line.key === 'title' || line.key === 'composer')) {
      text(line.key, opts.placeholders[line.key], x, h.top + line.y, line.align, ' placeholder');
    }
  }
  if (!lay.geo) return;
  const g = lay.geo;
  const vars = { pages: lay.pages.length, title: meta.title, composer: meta.composer };
  const pn = meta.page_numbers;
  for (const p of lay.pages) {
    onPage(p.index);
    const v = { ...vars, page: p.index + 1 };
    const top = p.y + g.margin * 0.55;
    const bottom = p.y + p.h - g.margin * 0.4;
    if (p.index > 0 && meta.header) text('header', fillTokens(meta.header, v), p.w / 2, top, 'center');
    if (meta.footer) text('footer', fillTokens(meta.footer, v), p.w / 2, bottom, 'center');
    if (p.index === 0 && meta.copyright) {
      text('copyright', meta.copyright, p.w / 2, meta.footer ? bottom - 1.9 * SP : bottom, 'center');
    }
    if (pn.show && (p.index > 0 || pn.first_page)) {
      // Outside: right on odd pages, left on even ones, as in a bound book.
      const align = pn.align === 'outside' ? (p.index % 2 === 0 ? 'right' : 'left') : pn.align;
      text('pnum', fillTokens(pn.format, v), xOf(align, g.margin, p.w - g.margin), pn.edge === 'bottom' ? bottom : top, align);
    }
  }
}

/**
 * Renders the whole document. Returns `{ pages: [svg…], svg, layout }`: one
 * SVG per page in page view (each showing its slice of the shared layout
 * coordinates through its viewBox), otherwise a single SVG (`svg`).
 */
export function renderScore(view, width, opts = {}) {
  noteTextEdit = opts.noteTextEdit || null;
  const lay = layout(view, width, opts);
  const score = view.score;
  // Markup per page; `onPage` selects where the next pushes go.
  const outs = lay.pages.map(() => []);
  let cur = 0;
  const onPage = (p) => { cur = p || 0; };
  const push = (s) => outs[cur].push(s);
  // Where each event's noteheads (or rest) are, for the eraser.
  const hits = [];

  // Selection highlight (below everything).
  const sel = view.selection;
  if (sel) {
    for (const ms of lay.measures) {
      if (ms.mEnd < sel.start.measure || ms.m > sel.end.measure) continue;
      onPage(ms.system.page);
      const exact = !ms.multi && !ms.restOnly;
      const x0 = exact && ms.m === sel.start.measure ? lay.tickX(ms, sel.start.tick) - 1.0 * SP : ms.x;
      const x1 = exact && ms.m === sel.end.measure ? lay.tickX(ms, sel.end.tick) - 1.0 * SP
        : ms.mEnd === sel.end.measure && sel.end.tick === 0 ? ms.x : ms.x + ms.w;
      if (x1 <= x0) continue;
      for (let st = sel.staff_lo; st <= sel.staff_hi; st++) {
        const top = lay.staffTop(ms, st);
        push(`<rect class="sel" x="${x0}" y="${top - 1.5 * SP}" width="${x1 - x0}" height="${7 * SP}" rx="3"/>`);
      }
    }
  }

  for (const s of lay.systems) {
    onPage(s.page);
    const first = s.measures[0];
    const xEnd = s.x0 + s.width;
    // Measure number.
    push(`<text class="mnum" x="${s.x0}" y="${s.y - 1.6 * SP}">${first.m + 1}</text>`);
    // Staff names: full on the first system, short on the others. Click
    // one to edit the staff. A name shared by a braced group is centred.
    (s.index === 0 ? lay.names : lay.shortNames).forEach((name, st) => {
      if (!name) return;
      const brace = lay.groups.find((g) => g.kind === 'brace' && g.first === st);
      const shared = brace && (s.index === 0 ? lay.names : lay.shortNames).slice(st + 1, brace.last + 1).every((n) => !n);
      const top = s.y + s.staffY[st];
      const mid = shared ? (top + s.y + s.staffY[brace.last] + 4 * SP) / 2 : top + 2 * SP;
      push(`<text class="sname" data-staff="${st}" ${styleAttrs(currentStyle('staff_name'))} text-anchor="end" dominant-baseline="central" x="${s.x0 - lay.groupIndent - NAME_GAP}" y="${mid}">${esc(name)}</text>`);
    });
    // Brackets (instrument families) and braces (one instrument on
    // several staves) left of the system.
    for (const g of lay.groups) {
      const y1 = s.y + s.staffY[g.first];
      const y2 = s.y + s.staffY[g.last] + 4 * SP;
      if (g.kind === 'brace') {
        // SMuFL braces are one staff (4 spaces) tall: stretch to the group.
        const k = (y2 - y1) / (4 * SP);
        const w = 0.6 * SP + 0.25 * SP * k;
        push(`<text class="m group" transform="translate(${s.x0 - 0.35 * SP - w} ${y2}) scale(${w / (0.328 * SP)} ${k})">\uE000</text>`);
      } else {
        const x = s.x0 - 0.9 * SP;
        push(`<rect class="group" x="${x}" y="${y1 - 0.5 * SP}" width="${0.5 * SP}" height="${y2 - y1 + SP}"/>`);
        push(`<text class="m group" x="${x}" y="${y1 - 0.5 * SP}">\uE003</text>`);
        push(`<text class="m group" x="${x}" y="${y2 + 0.5 * SP}">\uE004</text>`);
      }
    }
    // System bracket.
    if (lay.nStaves > 1) {
      push(`<line class="bar" x1="${s.x0}" x2="${s.x0}" y1="${s.y}" y2="${s.y + s.span}"/>`);
    }
    for (let st = 0; st < lay.nStaves; st++) {
      const top = s.y + s.staffY[st];
      for (let l = 0; l < 5; l++) {
        push(`<line class="staff" x1="${s.x0}" x2="${xEnd}" y1="${top + l * SP}" y2="${top + l * SP}"/>`);
      }
    }
  }
  drawPageTexts(lay, push, onPage, opts);
  drawTextBoxes(lay, score, push, onPage, opts);
  drawTempoMarks(lay, score, push, onPage);

  // Drawn events, for ties and slurs: per staff+voice in score order, and by id.
  const seqs = new Map();
  const byId = new Map();

  for (const ms of lay.measures) {
    onPage(ms.system.page);
    const lastMeasure = ms.mEnd === score.measures.length - 1;
    for (let st = 0; st < lay.nStaves; st++) {
      const staff = score.staves[st];
      const top = lay.staffTop(ms, st);
      const mid = CLEF_MIDDLE[staff.clef];
      const yOf = (d) => top + 2 * SP - (d - mid) * (SP / 2);

      if (ms.overfull.has(st)) {
        const beatTicks = TICKS_WHOLE / ms.attrs.time.beat_type;
        const beats = +(ms.overfull.get(st) / beatTicks).toFixed(2);
        const label = esc(t('score.overfull', { beats, total: ms.attrs.time.beats }));
        push(`<rect class="overfull" x="${ms.x + 2}" y="${top - 0.5 * SP}" width="${ms.w - 4}" height="${5 * SP}"><title>${label}</title></rect>`);
        push(`<text class="errlabel" x="${ms.x + (ms.systemStart ? ms.prefix : 0) + 5}" y="${top - 1.1 * SP}">⚠ ${label}</text>`);
      }

      // Prefix: clef, key, time.
      let px = ms.x + 0.6 * SP;
      if (ms.systemStart) {
        const clef = CLEF[staff.clef];
        push(glyph(clef.g, px, top + clef.line * SP, 'clef'));
        px += CLEF_COL;
      }
      if (ms.systemStart || ms.keyChange) {
        const f = writtenFifths(staff, ms.attrs.key.fifths);
        const positions = (f >= 0 ? KEY_SHARPS : KEY_FLATS).slice(0, Math.abs(f));
        for (const p of positions) {
          const y = top + 2 * SP - (p + CLEF_KEY_SHIFT[staff.clef]) * (SP / 2);
          push(glyph(f > 0 ? ACC['1'] : ACC['-1'], px, y));
          px += 1.05 * SP;
        }
        if (positions.length) px += 0.4 * SP;
      }
      if (ms.timeChange) {
        // SMuFL time-signature digits are centred on their baseline: the
        // upper number sits on the 2nd line, the lower on the 4th.
        push(`<text class="m tsig" x="${px + 1.1 * SP}" y="${top + SP}">${timeDigits(ms.attrs.time.beats)}</text>`);
        push(`<text class="m tsig" x="${px + 1.1 * SP}" y="${top + 3 * SP}">${timeDigits(ms.attrs.time.beat_type)}</text>`);
      }

      // Barline. Inside a bracket or brace it runs on to the next staff.
      const bx = ms.x + ms.w;
      const joined = lay.groups.some((g) => st >= g.first && st < g.last);
      const barBottom = joined ? lay.staffTop(ms, st + 1) : top + 4 * SP;
      if (lastMeasure) {
        push(`<line class="bar" x1="${bx - 6}" x2="${bx - 6}" y1="${top}" y2="${barBottom}"/>`);
        push(`<rect class="barthick" x="${bx - 3.5}" y="${top}" width="3.5" height="${barBottom - top}"/>`);
      } else {
        push(`<line class="bar" x1="${bx}" x2="${bx}" y1="${top}" y2="${barBottom}"/>`);
      }

      // Multi-measure rest: thick bar on the middle line, count above.
      if (ms.multi) {
        const x0 = ms.contentX + 0.4 * SP;
        const x1 = ms.contentX + ms.contentW - 0.4 * SP;
        push(`<g class="ev v0 mrest" data-measures="${ms.m + 1}-${ms.mEnd + 1}"><title>${esc(t('score.multirest', { from: ms.m + 1, to: ms.mEnd + 1, n: ms.multi }))}</title>`);
        push(`<rect x="${x0}" y="${top + 1.6 * SP}" width="${x1 - x0}" height="${0.8 * SP}"/>`);
        push(`<rect x="${x0}" y="${top + SP}" width="${0.16 * SP}" height="${2 * SP}"/><rect x="${x1 - 0.16 * SP}" y="${top + SP}" width="${0.16 * SP}" height="${2 * SP}"/>`);
        push(`<text class="m tsig" x="${(x0 + x1) / 2}" y="${top - 1.2 * SP}">${timeDigits(ms.multi)}</text></g>`);
        continue;
      }

      // Events.
      const voices = staff.measures[ms.m].voices;
      const multi = voices.filter((v) => v.length).length > 1;
      voices.forEach((events, v) => {
        const cls = `ev v${v}${view.caret.voice === v ? '' : ' dim'}`;
        const xs = eventXs(lay, ms, events);
        // Beam groups share one stem direction, chosen before drawing.
        const groups = isMeasureRest(events, capacity(ms.attrs)) ? [] : beamGroups(events, ms.attrs.time);
        const groupOf = new Map();
        const groupUp = groups.map((g, gi) => {
          g.forEach((i) => groupOf.set(i, gi));
          return multi ? v % 2 === 0 : groupStemsUp(g.map((i) => events[i]), mid);
        });
        const infos = events.map((e, i) => {
          const gi = groupOf.get(i);
          const opts = gi === undefined ? {} : { up: groupUp[gi], beamed: true };
          const info = drawEvent(push, e, xs[i], top, yOf, mid, v, multi, writtenFifths(staff, ms.attrs.key.fifths), cls, opts);
          return Object.assign(info, { e, ms, top, staff: st, voice: v, cls, sung: lay.verses[st] > 0 });
        });
        const starts = eventStarts(events);
        groups.forEach((g, gi) => drawBeams(push, g.map((i) => infos[i]), g.map((i) => starts[i]), groupUp[gi], multi ? null : yOf(mid), cls));
        infos.forEach((info) => {
          drawAttachments(push, info);
          hits.push({
            id: info.e.id, page: ms.system.page, rest: !!info.rest, left: info.left, right: info.left + info.w,
            heads: info.heads, hi: info.hi, lo: info.lo,
          });
          const key = `${st}:${v}`;
          if (!seqs.has(key)) seqs.set(key, []);
          seqs.get(key).push(info);
          byId.set(info.e.id, info);
        });
      });
    }
  }

  drawTies(push, seqs, onPage);
  drawSlurs(push, score.slurs || [], byId, seqs, onPage);
  drawLyrics(push, lay, seqs, onPage, opts.lyricEdit);

  // Where lyrics can be typed: every drawn note, in score order per staff
  // and voice. A note tied from the previous one continues its syllable.
  const slots = [];
  for (const seq of seqs.values()) {
    seq.forEach((n, i) => {
      const prev = seq[i - 1];
      slots.push({
        id: n.e.id, staff: n.staff, voice: n.voice, x: n.x, system: n.ms.system, page: n.ms.system.page || 0,
        singable: !n.rest && !(prev && !prev.rest && prev.e.tie),
      });
    });
  }

  // Caret (the lyric editor shows its own text cursor instead).
  const c = view.caret;
  const cms = opts.lyricEdit ? null : lay.byMeasure[c.measure];
  if (cms) {
    onPage(cms.system.page);
    const events = score.staves[c.staff].measures[c.measure].voices[c.voice];
    const x = gapX(lay, cms, events, c.index);
    const top = lay.staffTop(cms, c.staff);
    push(`<line class="caret v${c.voice}" x1="${x}" x2="${x}" y1="${top - 1.5 * SP}" y2="${top + 5.5 * SP}"/>`);
  }

  // `opts.zoom` only changes the on-screen size: the viewBox keeps layout
  // coordinates, so hit-testing (clientToLayout) is unaffected.
  const z = opts.zoom || 1;
  const pages = lay.pages.map((p, i) =>
    `<svg xmlns="http://www.w3.org/2000/svg" data-page="${i}" width="${p.w * z}" height="${p.h * z}" viewBox="${p.x} ${p.y} ${p.w} ${p.h}">${outs[i].join('')}</svg>`);
  return { pages, svg: pages[0], layout: lay, hits, slots };
}

/**
 * Lyrics: the syllables of every verse, the hyphens between the syllables of
 * a word and the extender lines of syllables held over several notes.
 * `edit` ({ id, verse }) is the syllable being typed: its text is left out
 * (the editor's input sits there) but still takes its room.
 */
function drawLyrics(push, lay, seqs, onPage, edit) {
  const attrs = styleAttrs(currentStyle('lyrics'));
  const hyphenW = textWidth('-');
  for (const seq of seqs.values()) {
    const nVerses = Math.max(0, ...seq.map((n) => (n.e.lyrics || []).length));
    for (let k = 0; k < nVerses; k++) {
      const yOf = (n) => lay.lyricY(n.ms.system, n.staff, k);
      const hyphen = (n, x) => {
        onPage(n.ms.system.page);
        push(`<text class="lyric" ${attrs} text-anchor="middle" x="${x}" y="${yOf(n)}">-</text>`);
      };
      const line = (n, x1, x2) => {
        if (x2 - x1 < 0.8 * SP) return;
        onPage(n.ms.system.page);
        push(`<line class="lyric-line" x1="${x1}" x2="${x2}" y1="${yOf(n)}" y2="${yOf(n)}"/>`);
      };
      // The extender of the syllable at seq[a.i] runs to the last note
      // before the next syllable or rest.
      const extend = (a) => {
        let j = a.i;
        while (seq[j + 1] && !seq[j + 1].rest && !syllableAt(seq[j + 1].e, k)) j++;
        if (j === a.i) return;
        const end = seq[j];
        if (end.ms.system === a.n.ms.system) {
          line(a.n, a.right + 0.25 * SP, end.left + end.w);
        } else {
          line(a.n, a.right + 0.25 * SP, systemEnd(a.n.ms) - 0.5 * SP);
          line(end, end.ms.system.measures[0].contentX - 1.4 * SP, end.left + end.w);
        }
      };
      let prev = null; // the last syllable drawn: { n, i, right, join }
      seq.forEach((n, i) => {
        const syl = syllableAt(n.e, k);
        if (!syl) return;
        const w = textWidth(syl.text);
        const sameLine = prev && prev.n.ms.system === n.ms.system;
        // Centred under the note, pushed right if the previous syllable is
        // in the way or if it would reach back into the previous measure.
        const left = Math.max(n.x - w / 2, n.ms.contentX - LYRIC_LEAD,
          sameLine ? prev.right + LYRIC_GAP * (prev.join === 'hyphen' ? 2 : 1) : -Infinity);
        if (prev && prev.join === 'hyphen') {
          if (sameLine) hyphen(n, (prev.right + left) / 2);
          else hyphen(prev.n, prev.right + hyphenW);
        }
        if (prev && prev.join === 'extender') extend(prev);
        onPage(n.ms.system.page);
        // With several verses, each is numbered where it begins.
        if (!prev && lay.verses[n.staff] > 1) {
          push(`<text class="lyric" ${attrs} text-anchor="end" x="${left - 0.5 * SP}" y="${yOf(n)}">${k + 1}.</text>`);
        }
        if (!(edit && edit.id === n.e.id && edit.verse === k)) {
          push(`<text class="lyric" ${attrs} text-anchor="middle" x="${left + w / 2}" y="${yOf(n)}">${esc(syl.text)}</text>`);
        }
        prev = { n, i, right: left + w, join: syl.join };
      });
      if (prev && prev.join === 'hyphen') hyphen(prev.n, prev.right + hyphenW);
      if (prev && prev.join === 'extender') extend(prev);
    }
  }
}

/**
 * The note and verse whose lyric a click at (x, y) would edit, or null when
 * the pointer is not on a line of lyrics. Besides the existing verses, the
 * line just below the last one counts (it starts a new verse); a staff
 * without lyrics offers one line where its first verse would go.
 */
export function lyricTarget(lay, slots, x, y) {
  for (const s of lay.systems) {
    for (let st = 0; st < lay.nStaves; st++) {
      const n = lay.verses[st];
      const first = s.y + s.staffY[st] + s.lyricY[st];
      const top = first - 0.72 * lyricLine();
      const lines = Math.min(n + 1, MAX_VERSES);
      if (y < top || y > top + lines * lyricLine()) continue;
      let best = null;
      for (const slot of slots) {
        if (slot.system !== s || slot.staff !== st || !slot.singable) continue;
        const d = Math.abs(x - slot.x);
        if (d <= 4 * SP && (!best || d < best.d)) best = { d, slot };
      }
      if (!best) return null;
      return { id: best.slot.id, staff: st, verse: Math.min(lines - 1, Math.floor((y - top) / lyricLine())) };
    }
  }
  return null;
}

/**
 * Converts a mouse position to layout coordinates, using whichever page SVG
 * is under (or nearest to) the pointer. SVGs may be scaled by CSS.
 */
export function clientToLayout(lay, container, clientX, clientY) {
  const svgs = [...container.querySelectorAll('svg[data-page]')];
  if (!svgs.length) return null;
  let best = null;
  for (const svg of svgs) {
    const r = svg.getBoundingClientRect();
    const dy = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
    if (!best || dy < best.dy) best = { svg, r, dy };
  }
  const p = lay.pages[Number(best.svg.dataset.page)];
  const k = p.w / best.r.width;
  return { x: p.x + (clientX - best.r.left) * k, y: p.y + (clientY - best.r.top) * k, page: p.index };
}

/**
 * The playback cursor at (measure, tick): a line across the whole system.
 * Returns `{ page, markup }` or null. Inside a multi-measure rest the line
 * moves proportionally through the merged measures.
 */
export function playheadMarkup(lay, measure, tick) {
  const ms = lay.byMeasure[measure];
  if (!ms) return null;
  let x;
  if (ms.multi) {
    const fraction = ((measure - ms.m) * ms.cap + tick) / (ms.multi * ms.cap);
    x = ms.contentX + fraction * ms.contentW;
  } else {
    x = lay.tickX(ms, Math.min(tick, ms.cap));
  }
  const s = ms.system;
  const y1 = s.y - 1.5 * SP;
  const y2 = s.y + s.span + 1.5 * SP;
  return {
    page: s.page || 0,
    markup: `<line class="playhead" x1="${x}" x2="${x}" y1="${y1}" y2="${y2}"/>`,
  };
}

/** Inverse of clientToLayout: where a layout point currently is on screen. */
export function layoutToClient(lay, container, point) {
  const svg = container.querySelector(`svg[data-page="${point.page || 0}"]`);
  if (!svg) return null;
  const p = lay.pages[point.page || 0];
  const r = svg.getBoundingClientRect();
  const k = r.width / p.w;
  return { x: r.left + (point.x - p.x) * k, y: r.top + (point.y - p.y) * k };
}

/**
 * Draws one event centred at x. `opts.stem === false` omits stem and flags
 * (used by the ghost when it previews adding a note to an existing chord).
 * `opts.up` forces the stem direction and `opts.beamed` leaves the stem to
 * drawBeams (the event is part of a beam group).
 */
function drawEvent(push, e, x, top, yOf, mid, voice, multi, fifths, cls, opts = {}) {
  const baseIdx = valueIdx(e.duration);
  const pitches = pitchesOf(e);
  push(`<g class="${cls}"${e.id !== undefined ? ` data-id="${e.id}"` : ''}>`);

  if (pitches.length === 0) {
    // Rests: the whole rest hangs from the 2nd line, the half rest sits on
    // the middle line, the others are centred on it.
    const shift = multi ? (voice % 2 === 0 ? -2 : 2) * SP : 0;
    const w = REST_W[baseIdx] * SP;
    // (The breve rest fills the space above the middle line.)
    const y = (baseIdx === V_WHOLE ? top + SP : top + 2 * SP) + shift;
    push(glyph(REST[baseIdx], x - w / 2, y));
    drawDots(push, e.duration.dots, x + w / 2 + 0.3 * SP, top + 1.5 * SP + shift);
    push('</g>');
    return { x, left: x - w / 2, w, heads: [], up: true, hi: top + SP + shift, lo: top + 3 * SP + shift, rest: true };
  }

  const headIdx = Math.min(baseIdx, 3);
  const w = HEAD_W[headIdx] * SP;
  const left = x - w / 2;
  const ds = pitches.map(diatonic).sort((a, b) => a - b);
  const lo = ds[0];
  const hi = ds[ds.length - 1];

  // Ledger lines: 0.4 spaces beyond the notehead on each side.
  const ledger = (d) => {
    const y = yOf(d);
    push(`<line class="ledger" x1="${left - 0.4 * SP}" x2="${left + w + 0.4 * SP}" y1="${y}" y2="${y}"/>`);
  };
  for (let d = mid + 6; d <= hi; d += 2) ledger(d);
  for (let d = mid - 6; d >= lo; d -= 2) ledger(d);

  // Noteheads, accidentals, dots.
  for (const p of pitches) {
    const y = yOf(diatonic(p));
    push(glyph(HEAD[headIdx], left, y));
    if (p.alter !== keyAlter(fifths, p.step)) {
      const a = String(p.alter);
      push(glyph(ACC[a], left - 0.25 * SP - ACC_W[a] * SP, y));
    }
    const onLine = (diatonic(p) - mid) % 2 === 0;
    drawDots(push, e.duration.dots, left + w + 0.3 * SP, onLine ? y - SP / 2 : y);
  }

  // Stem (attached to the notehead's right edge going up, left edge going
  // down) and the flag glyph at its end. Whole notes have no stem, but the
  // direction still decides which side ties and articulations go.
  const up = opts.up ?? (multi ? voice % 2 === 0 : (lo + hi) / 2 < mid);
  const sx = up ? left + w - STEM_W / 2 : left + STEM_W / 2;
  const yStart = up ? yOf(lo) - 0.17 * SP : yOf(hi) + 0.17 * SP;
  let stemEnd = null;
  if (baseIdx >= V_HALF && opts.stem !== false && !opts.beamed) {
    const extra = Math.max(0, baseIdx - 5) * 0.5 * SP; // room for 32nd–128th flags
    stemEnd = up ? yOf(hi) - STEM_LEN - extra : yOf(lo) + STEM_LEN + extra;
    push(`<line class="stem" x1="${sx}" x2="${sx}" y1="${yStart}" y2="${stemEnd}"/>`);
    if (baseIdx >= V_EIGHTH) push(glyph((up ? FLAG_UP : FLAG_DOWN)[baseIdx - V_EIGHTH], sx - STEM_W / 2, stemEnd));
  }
  push('</g>');
  return {
    x, left, w, up, stemEnd, mid,
    // For drawBeams: stem x, where the stem leaves the chord, and the
    // notehead nearest the beam.
    stemX: sx, stemStart: yStart, beamRef: up ? yOf(hi) : yOf(lo),
    heads: pitches.map((p) => ({ key: `${p.step}${p.octave}`, step: p.step, octave: p.octave, y: yOf(diatonic(p)), d: diatonic(p) })),
    hi: Math.min(yOf(hi) - 0.5 * SP, stemEnd ?? Infinity), // topmost ink
    lo: Math.max(yOf(lo) + 0.5 * SP, stemEnd ?? -Infinity), // lowest ink
  };
}

// ----- beams -------------------------------------------------------------------

/** Start tick of each event in a voice. */
function eventStarts(events) {
  let t = 0;
  return events.map((e) => { const s = t; t += durationTicks(e.duration); return s; });
}

/**
 * Splits a voice into beam groups: runs of notes of an eighth or shorter
 * that start in the same beat group. Returns arrays of event indices (two
 * or more each). Rests and longer notes break beams.
 *
 * Beat groups follow the time signature: a dotted quarter in compound
 * meters (6/8, 9/8, 12/8; 3/8 is one group), a quarter in x/4 and in other
 * x/8 meters, a half in x/2. In 4/4 four plain eighths in the same half bar
 * share one beam, as is customary.
 */
export function beamGroups(events, time) {
  const beats = time.beats;
  const bt = time.beat_type || 4;
  const unitOf = TICKS_WHOLE / bt;
  const unit = bt >= 8 && beats % 3 === 0 ? 3 * unitOf
    : bt >= 8 ? TICKS_WHOLE / 4
      : unitOf;
  const starts = eventStarts(events);
  const beamable = (e) => e.kind !== 'rest' && valueIdx(e.duration) >= V_EIGHTH;

  let groups = [];
  let cur = [];
  let curBeat = -1;
  const flush = () => { if (cur.length > 1) groups.push(cur); cur = []; };
  events.forEach((e, i) => {
    if (!beamable(e)) { flush(); return; }
    const beat = Math.floor(starts[i] / unit);
    if (cur.length && beat !== curBeat) flush();
    cur.push(i);
    curBeat = beat;
  });
  flush();

  if (beats === 4 && bt === 4) {
    const half = TICKS_WHOLE / 2;
    for (let h = 0; h < 2; h++) {
      const idx = events.map((_, i) => i).filter((i) => starts[i] >= h * half && starts[i] < (h + 1) * half);
      const plainEighths = idx.length === 4 && idx.every((i) => beamable(events[i])
        && valueIdx(events[i].duration) === V_EIGHTH && !events[i].duration.dots);
      if (plainEighths) {
        groups = groups.filter((g) => !g.some((i) => idx.includes(i)));
        groups.push(idx);
      }
    }
    groups.sort((a, b) => a[0] - b[0]);
  }
  return groups;
}

/** Stem direction of a beam group: away from the note farthest from the middle line. */
function groupStemsUp(events, mid) {
  const ds = events.flatMap((e) => pitchesOf(e).map(diatonic));
  const lo = Math.min(...ds);
  const hi = Math.max(...ds);
  return mid - lo > hi - mid;
}

/**
 * Draws the stems and beams of one group. `infos` come from drawEvent
 * (drawn with `beamed`), `starts` are their start ticks; `midY` is the y of
 * the middle line (null with several voices, whose stems stay short).
 * Updates each info's stem end and ink extent.
 */
function drawBeams(push, infos, starts, up, midY, cls) {
  const levels = infos.map((n) => valueIdx(n.e.duration) - V_EIGHTH); // 0 = 8th, 1 = 16th…
  const count = Math.max(...levels) + 1;
  const away = up ? -1 : 1; // from the noteheads towards the beam
  const first = infos[0];
  const last = infos[infos.length - 1];
  const x1 = first.stemX;
  const span = Math.max(last.stemX - x1, 1);

  // Slant follows the outer notes, at most one space, and the beam is flat
  // when an inner note reaches further than both ends.
  const inner = infos.slice(1, -1).map((n) => n.beamRef);
  const ends = [first.beamRef, last.beamRef];
  const concave = up ? inner.some((y) => y < Math.min(...ends)) : inner.some((y) => y > Math.max(...ends));
  const dy = last.beamRef - first.beamRef;
  const slant = concave ? 0 : Math.max(-SP, Math.min(SP, dy / 2));
  const slope = slant / span;

  // Place the beam so every stem is long enough for all its beams and
  // reaches at least the middle line.
  const minLen = Math.max(STEM_LEN, 2.5 * SP + (count - 1) * BEAM_STEP);
  const need = infos.flatMap((n) => [n.beamRef + away * minLen, midY ?? n.beamRef + away * minLen])
    .map((y, k) => y - slope * (infos[k >> 1].stemX - x1));
  const b = up ? Math.min(...need) : Math.max(...need);
  const yAt = (x) => b + slope * (x - x1);

  push(`<g class="${cls}">`);
  for (const n of infos) {
    const y = yAt(n.stemX);
    push(`<line class="stem" x1="${n.stemX}" x2="${n.stemX}" y1="${n.stemStart}" y2="${y}"/>`);
    n.stemEnd = y;
    if (up) n.hi = Math.min(n.hi, y);
    else n.lo = Math.max(n.lo, y);
  }
  const beam = (xa, xb, level) => {
    const off = -away * level * BEAM_STEP; // further beams sit closer to the noteheads
    const ya = yAt(xa) + off;
    const yb = yAt(xb) + off;
    const t = -away * BEAM_T;
    push(`<polygon class="beam" points="${xa},${ya} ${xb},${yb} ${xb},${yb + t} ${xa},${ya + t}"/>`);
  };
  const half = STEM_W / 2;
  beam(x1 - half, last.stemX + half, 0);
  for (let level = 1; level < count; level++) {
    let i = 0;
    while (i < infos.length) {
      if (levels[i] < level) { i++; continue; }
      let j = i;
      while (j + 1 < infos.length && levels[j + 1] >= level) j++;
      if (j > i) {
        beam(infos[i].stemX - half, infos[j].stemX + half, level);
      } else {
        // A lone shorter note gets a beamlet, pointing into the group: right
        // at the start, left at the end, otherwise towards its own beat.
        const n = infos[i];
        const ticks = durationTicks(n.e.duration);
        const right = i === 0 || (i < infos.length - 1 && Math.round((starts[i] - starts[0]) / ticks) % 2 === 0);
        const neighbour = infos[right ? i + 1 : i - 1];
        const len = Math.min(1.1 * SP, Math.abs(neighbour.stemX - n.stemX) / 2);
        if (right) beam(n.stemX - half, n.stemX + len, level);
        else beam(n.stemX - len, n.stemX + half, level);
      }
      i = j + 1;
    }
  }
  push('</g>');
}

// ----- eraser ------------------------------------------------------------------

/**
 * The notehead or rest at (x, y) in layout coordinates, for the eraser and
 * for dragging notes: `{ id, pitch, rest }`, where `pitch` ({ step, octave })
 * names the chord tone hit when the event is a chord of several notes, else
 * null. Only noteheads and rests count, so one note can be picked out of a
 * crowded passage.
 */
export function eraserTarget(hits, x, y) {
  let best = null;
  const consider = (d, target) => { if (!best || d < best.d) best = { d, ...target }; };
  for (const h of hits) {
    if (x < h.left - 0.25 * SP || x > h.right + 0.25 * SP) continue;
    if (h.rest) {
      if (y >= h.hi - 0.25 * SP && y <= h.lo + 0.25 * SP) consider(Math.abs(x - (h.left + h.right) / 2), { id: h.id, pitch: null, rest: true });
      continue;
    }
    for (const head of h.heads) {
      const dy = Math.abs(y - head.y);
      if (dy > 0.6 * SP) continue;
      const pitch = h.heads.length > 1 ? { step: head.step, octave: head.octave, alter: 0 } : null;
      consider(dy + Math.abs(x - (h.left + h.right) / 2) / 4, { id: h.id, pitch, rest: false });
    }
  }
  return best && { id: best.id, pitch: best.pitch, rest: best.rest };
}

/** Ids of the events with a notehead or rest inside the box (layout coordinates). */
export function eventsInBox(hits, x0, y0, x1, y1) {
  const [xa, xb] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ya, yb] = [Math.min(y0, y1), Math.max(y0, y1)];
  return hits.filter((h) => h.right >= xa && h.left <= xb && (h.rest
    ? h.lo >= ya && h.hi <= yb
    : h.heads.some((head) => head.y >= ya && head.y <= yb))).map((h) => h.id);
}

/** Is y on a staff line inside the staff? (Then a mark must move to a space.) */
const onStaffLine = (y, top) => {
  const k = (y - top) / SP;
  return k > -0.01 && k < 4.01 && Math.abs(k - Math.round(k)) < 0.01;
};

// The note text being typed (app.js): drawn as a hint until it has words.
let noteTextEdit = null;

/** Articulations, fermata, dynamic and texts of one drawn event. */
function drawAttachments(push, info) {
  const { e, top, x } = info;
  const arts = e.articulations || [];
  const texts = [...(e.texts || [])];
  if (noteTextEdit && noteTextEdit.id === e.id && !texts.some((nt) => nt.kind === noteTextEdit.kind)) {
    texts.push({ kind: noteTextEdit.kind, text: noteTextEdit.hint, hint: true });
  }
  const open = arts.length || e.dynamic || texts.length;
  if (open) push(`<g class="${info.cls}">`);

  // Articulations go on the notehead side (away from the stem), stacked
  // outward, starting in the nearest staff space.
  const below = info.up;
  const ys = info.heads.map((h) => h.y);
  let y = below ? Math.max(...ys, top + 2 * SP) : Math.min(...ys, top + 2 * SP);
  if (info.rest) y = below ? top + 4 * SP : top;
  for (const a of arts) {
    if (a === 'fermata') continue;
    y += below ? 1.0 * SP : -1.0 * SP;
    if (onStaffLine(y, top)) y += below ? 0.5 * SP : -0.5 * SP;
    push(`<text class="m mark" x="${x}" y="${y}">${ARTIC[a][below ? 1 : 0]}</text>`);
    // Slurs must clear articulations too: extend the event's ink extent.
    if (below) info.lo = Math.max(info.lo, y + 0.8 * SP);
    else info.hi = Math.min(info.hi, y - 0.8 * SP);
  }
  if (arts.includes('fermata')) {
    // Above the staff, or above the highest ink if that is higher.
    const fy = Math.min(top - 0.6 * SP, info.hi - 0.6 * SP, below ? Infinity : y - 0.8 * SP);
    push(`<text class="m mark" x="${x}" y="${fy}">${FERMATA}</text>`);
  }
  // Below the staff; above it when the staff has lyrics, as in vocal music.
  const dy = info.sung
    ? Math.min(top - 1.6 * SP, info.hi - 1.4 * SP, below ? Infinity : y - 1.6 * SP)
    : Math.max(top + 6.6 * SP, info.lo + 2.2 * SP, below ? y + 2 * SP : -Infinity);
  if (e.dynamic) push(`<text class="m mark" x="${x}" y="${dy}">${DYNAMIC[e.dynamic]}</text>`);
  for (const nt of texts) {
    const cls = `ntext ntext-${nt.kind}${nt.hint ? ' placeholder' : ''}`;
    const attrs = `class="${cls}" data-ntext="${e.id}:${nt.kind}" ${styleAttrs(currentStyle(nt.kind))}`;
    if (nt.kind === 'expression') {
      // Italic, where the dynamic goes (after it, when there is one).
      const after = e.dynamic ? 1.4 * SP * e.dynamic.length + 0.6 * SP : -0.5 * SP;
      push(`<text ${attrs} x="${x + after}" y="${dy}">${esc(nt.text)}</text>`);
    } else {
      // Over the staff and above the highest ink (fermata included).
      const ty = Math.min(top - 1.4 * SP, info.hi - 1.3 * SP, below ? Infinity : y - 1.4 * SP) - (arts.includes('fermata') ? 2 * SP : 0);
      push(`<text ${attrs} x="${x - 0.5 * SP}" y="${ty}">${esc(nt.text)}</text>`);
    }
  }
  if (open) push('</g>');
}

/**
 * A tie or slur: a filled crescent from (x1,y1) to (x2,y2) that bulges by
 * `h` towards `dir` (+1 down, −1 up). Thickest in the middle, as engraved.
 */
function arc(x1, y1, x2, y2, dir, h, thick) {
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const outer = cy + dir * h * 2; // a quadratic peaks at half its control offset
  const inner = cy + dir * (h - thick) * 2;
  return `<path class="arc" d="M${x1} ${y1} Q${cx} ${outer} ${x2} ${y2} Q${cx} ${inner} ${x1} ${y1}Z"/>`;
}

const systemEnd = (ms) => ms.system.x0 + ms.system.width;

/** Ties: from each tied note to the same pitch in the next event of its voice. */
function drawTies(push, seqs, onPage) {
  // Each half goes to its own page's SVG (a system break can be a page break).
  const group = (n, markup) => { onPage(n.ms.system.page); push(`<g class="${n.cls}">${markup}</g>`); };
  for (const seq of seqs.values()) {
    seq.forEach((a, i) => {
      if (!a.e.tie || a.rest) return;
      const b = seq[i + 1];
      a.heads.forEach((head) => {
        // In a chord the top note's tie curves up and the others down;
        // a single note's tie goes opposite the stem.
        const isTop = a.heads.length > 1 && head.d === Math.max(...a.heads.map((h) => h.d));
        const dir = a.heads.length > 1 ? (isTop ? -1 : 1) : (a.up ? 1 : -1);
        const y = head.y + dir * 0.55 * SP;
        const x1 = a.left + a.w + 0.15 * SP;
        const target = b && !b.rest ? b.heads.find((h) => h.key === head.key) : null;
        if (!target) {
          group(a, arc(x1, y, x1 + 2 * SP, y, dir, 0.45 * SP, 0.14 * SP)); // tie into nothing
        } else if (b.ms.system === a.ms.system) {
          const x2 = b.left - 0.15 * SP;
          group(a, arc(x1, y, x2, y, dir, Math.min(1.1 * SP, Math.max(0.45 * SP, (x2 - x1) * 0.1)), 0.16 * SP));
        } else {
          // Crosses a line break: one half on each system.
          const y2 = target.y + dir * 0.55 * SP;
          group(a, arc(x1, y, systemEnd(a.ms) - 0.3 * SP, y, dir, 0.6 * SP, 0.16 * SP));
          group(b, arc(b.ms.contentX - 1.4 * SP, y2, b.left - 0.15 * SP, y2, dir, 0.6 * SP, 0.16 * SP));
        }
      });
    });
  }
}

/** Slurs: over (or under) the notes between their start and end events. */
function drawSlurs(push, slurs, byId, seqs, onPage) {
  for (const s of slurs) {
    const a = byId.get(s.start);
    const b = byId.get(s.end);
    if (!a || !b || a.staff !== b.staff || a.voice !== b.voice) continue;
    const seq = seqs.get(`${a.staff}:${a.voice}`);
    const inner = seq.slice(seq.indexOf(a), seq.indexOf(b) + 1);
    // Below when every stem points up (notehead side), otherwise above.
    const dir = inner.every((n) => n.up) ? 1 : -1;
    const end = (n) => (dir > 0 ? n.lo + 0.5 * SP : n.hi - 0.5 * SP);
    const draw = (owner, part, x1, y1, x2, y2) => {
      // Lift the curve so it clears every note it spans.
      const extreme = part.length
        ? (dir > 0 ? Math.max(...part.map((n) => n.lo)) : Math.min(...part.map((n) => n.hi)))
        : y1;
      const base = (y1 + y2) / 2;
      const need = dir > 0 ? extreme + 0.6 * SP - base : base - (extreme - 0.6 * SP);
      const h = Math.min(3 * SP, Math.max(0.8 * SP, (x2 - x1) * 0.08, need));
      onPage(owner.ms.system.page);
      push(`<g class="${a.cls}">${arc(x1, y1, x2, y2, dir, h, 0.2 * SP)}</g>`);
    };
    if (a.ms.system === b.ms.system) {
      draw(a, inner.slice(1, -1), a.x, end(a), b.x, end(b));
    } else {
      const first = inner.filter((n) => n.ms.system === a.ms.system);
      const second = inner.filter((n) => n.ms.system === b.ms.system);
      draw(a, first.slice(1), a.x, end(a), systemEnd(a.ms) - 0.3 * SP, end(a));
      draw(b, second.slice(0, -1), b.ms.contentX - 1.4 * SP, end(b), b.x, end(b));
    }
  }
}

function drawDots(push, dots, x, y) {
  for (let i = 0; i < dots; i++) push(glyph(DOT, x + i * 0.6 * SP, y));
}

// ----- mouse note entry ----------------------------------------------------

const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const ALTER_TEXT = { '-2': '𝄫', '-1': '♭', '0': '', '1': '♯', '2': '𝄪' };

/**
 * Where a note would land if the user clicked at (x, y) in note-entry mode.
 * Returns null when the pointer is too far from any staff.
 *
 * - `index`: insertion point in the voice (between events).
 * - `onEvent`: index of the event under the pointer (click adds to its chord).
 * - `step`/`octave`: pitch snapped to the nearest line or space.
 */
export function pointerTarget(lay, view, x, y, voice) {
  let best = null;
  for (const s of lay.systems) {
    for (let st = 0; st < lay.nStaves; st++) {
      const center = s.y + s.staffY[st] + 2 * SP;
      const dist = Math.abs(y - center);
      if (!best || dist < best.dist) best = { s, st, dist };
    }
  }
  if (!best || best.dist > 7 * SP) return null;
  const { s, st: staff } = best;
  const ms = s.measures.find((m) => x >= m.x && x < m.x + m.w);
  if (!ms) return null;

  const top = s.y + s.staffY[staff];
  const clef = view.score.staves[staff].clef;
  const mid = CLEF_MIDDLE[clef];
  const d = mid + Math.round((top + 2 * SP - y) / (SP / 2));
  const events = view.score.staves[staff].measures[ms.m].voices[voice];

  let index = 0;
  let onEvent = null;
  let onEventDist = Infinity;
  let eventX = 0;
  // A measure rest (or a multi-measure rest) is replaced by what is placed,
  // so it is never a chord target and the insertion point is its start.
  const restMeasure = ms.multi || isMeasureRest(events, capacity(ms.attrs));
  if (!restMeasure) {
    eventXs(lay, ms, events).forEach((ex, i) => {
      if (x > ex + 0.2 * SP) index++;
      const dist = Math.abs(x - ex);
      if (dist <= 0.8 * SP && dist < onEventDist) {
        onEvent = i;
        onEventDist = dist;
        eventX = ex;
      }
    });
  }

  const step = STEPS[((d % 7) + 7) % 7];
  return {
    staff, measure: ms.m, voice, index, onEvent, page: s.page || 0,
    step,
    octave: Math.floor(d / 7),
    alter: keyAlter(writtenFifths(view.score.staves[staff], ms.attrs.key.fifths), step),
    fifths: writtenFifths(view.score.staves[staff], ms.attrs.key.fifths),
    d, mid, top,
    x: onEvent !== null ? eventX : x,
    y: top + 2 * SP - (d - mid) * (SP / 2),
    gapX: gapX(lay, ms, events, index),
  };
}

/** Semi-transparent preview of the figure that a click would place. */
export function ghostMarkup(t, duration, rest) {
  if (!t) return '';
  const out = [];
  const push = (s) => out.push(s);
  // Insertion marker (where the new event goes), unless adding to a chord.
  if (t.onEvent === null || rest) {
    push(`<line class="ins" x1="${t.gapX}" x2="${t.gapX}" y1="${t.top - 1.5 * SP}" y2="${t.top + 5.5 * SP}"/>`);
  }
  const yOf = (k) => t.top + 2 * SP - (k - t.mid) * (SP / 2);
  const event = rest
    ? { duration, kind: 'rest' }
    : { duration, kind: { chord: { pitches: [{ step: t.step, octave: t.octave, alter: t.alter }] } } };
  drawEvent(push, event, t.x, t.top, yOf, t.mid, 0, false, t.fifths, 'gfig', { stem: t.onEvent === null });
  if (!rest) {
    // Pitch name next to the figure.
    push(`<text class="pname" x="${t.x + 1.6 * SP}" y="${t.y - 0.8 * SP}">${t.step}${ALTER_TEXT[String(t.alter)]}${t.octave}${t.onEvent !== null ? ' +' : ''}</text>`);
  }
  return `<g class="ghost">${out.join('')}</g>`;
}

export { esc };
