// Score renderer: turns a DocView (from Rust) into SVG markup.
// Pure functions only — no Tauri calls — so it can be previewed in any
// browser with fake data (see dev/preview.html).
//
// Music symbols come from Bravura, the SMuFL reference font by Steinberg
// (SIL Open Font License, bundled in src/fonts/). SMuFL fonts are designed
// so that 1 em = 4 staff spaces and every glyph's origin sits on a staff
// position (a G clef's baseline is the G line, a notehead's baseline is its
// center…), which makes placement exact without measuring anything.

export const SP = 10; // one staff space, in px (CSS .m uses font-size 4·SP)
const STAFF_GAP = 10 * SP; // staff top to next staff top inside a system
const SYSTEM_GAP = 7 * SP;
const MARGIN_X = 28;
const MARGIN_TOP = 5 * SP;
const TICKS_WHOLE = 3840;

const BASES = ['whole', 'half', 'quarter', 'eighth', 'sixteenth', 'thirty_second', 'sixty_fourth'];
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
const HEAD = ['', '', '']; // whole, half, black
const REST = ['', '', '', '', '', '', ''];
const FLAG_UP = ['', '', '', '']; // 8th … 64th
const FLAG_DOWN = ['', '', '', ''];
const ACC = { '-2': '', '-1': '', '0': '', '1': '', '2': '' };
const DOT = '';
const timeDigits = (n) => String(n).split('').map((d) => String.fromCharCode(0xe080 + Number(d))).join('');

// Glyph widths in staff spaces (from Bravura's metadata).
const HEAD_W = [1.688, 1.18, 1.18];
const REST_W = [1.128, 1.128, 1.08, 0.988, 1.28, 1.48, 1.712];
const ACC_W = { '-2': 1.644, '-1': 0.904, '0': 0.672, '1': 0.996, '2': 0.988 };
const STEM_W = 0.12 * SP;
const STEM_LEN = 3.5 * SP;
const CLEF_COL = 3.6 * SP; // room for the widest clef (C clef, 2.8 spaces) plus gap

/** A music glyph: baseline at (x, y). */
const glyph = (g, x, y, cls = '') => `<text class="m${cls ? ` ${cls}` : ''}" x="${x}" y="${y}">${g}</text>`;

// Serde gives enum variants as written in Rust: DurationBase is PascalCase.
const baseKey = (b) => b.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

export function durationTicks(d) {
  const base = TICKS_WHOLE >> BASES.indexOf(baseKey(d.base));
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
 * `dacapo_core::model::is_measure_rest`.
 */
export function isMeasureRest(events, cap) {
  if (events.length !== 1 || events[0].kind !== 'rest') return false;
  const d = events[0].duration;
  return durationTicks(d) === cap || (baseKey(d.base) === 'whole' && d.dots === 0);
}

/**
 * Computes positions of systems, measures and events.
 * `opts.multiRest`: merge runs of rest-only measures into one multi-measure rest.
 */
export function layout(view, width, opts = {}) {
  const score = view.score;
  const nStaves = score.staves.length;
  const avail = Math.max(300, width - 2 * MARGIN_X);

  const single = score.measures.map((attrs, m) => {
    let maxEvents = 0;
    let maxFill = 0;
    let restOnly = true;
    // Per staff: the fullest voice, when it exceeds the time signature.
    const overfull = new Map();
    score.staves.forEach((staff, s) => {
      staff.measures[m].voices.forEach((voice, v) => {
        const mrest = isMeasureRest(voice, capacity(attrs));
        const fill = mrest ? capacity(attrs) : voice.reduce((t, e) => t + durationTicks(e.duration), 0);
        maxEvents = Math.max(maxEvents, voice.length);
        maxFill = Math.max(maxFill, fill);
        if (fill > capacity(attrs)) overfull.set(s, Math.max(overfull.get(s) || 0, fill));
        if (v === 0 ? !mrest : voice.length > 0) restOnly = false;
      });
    });
    const cap = Math.max(capacity(attrs), maxFill, 1);
    const prev = m > 0 ? score.measures[m - 1] : null;
    return {
      m, mEnd: m, attrs, cap, restOnly,
      overfull,
      content: Math.max(9 * SP, maxEvents * 3.6 * SP + 2 * SP),
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
      while (j + 1 < single.length && single[j + 1].restOnly && !single[j + 1].timeChange && !single[j + 1].keyChange) j++;
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

  const keyWidth = (f) => Math.abs(f) * 1.05 * SP;
  const systems = [];
  let sys = null;
  for (const ms of measures) {
    const startPrefix = 0.6 * SP + CLEF_COL + keyWidth(ms.attrs.key.fifths) + (ms.timeChange ? 2.8 * SP : 0) + SP;
    const midPrefix = (ms.keyChange ? keyWidth(ms.attrs.key.fifths) + SP : 0) + (ms.timeChange ? 2.8 * SP : 0);
    const fitsMid = sys && sys.width + midPrefix + ms.content <= avail;
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

  const systemHeight = (nStaves - 1) * STAFF_GAP + 4 * SP;
  systems.forEach((s, i) => {
    s.index = i;
    s.y = MARGIN_TOP + i * (systemHeight + SYSTEM_GAP);
    // Justify every system but the last (unless it is already nearly full).
    const last = i === systems.length - 1;
    const stretch = !last || s.width > avail * 0.75 ? (avail - s.width) / s.measures.length : 0;
    let x = MARGIN_X;
    for (const ms of s.measures) {
      ms.w += Math.max(0, stretch);
      ms.x = x;
      ms.system = s;
      ms.contentX = x + ms.prefix + 1.4 * SP;
      ms.contentW = ms.w - ms.prefix - 2.6 * SP;
      x += ms.w;
    }
    s.width = x - MARGIN_X;
  });

  return {
    systems, measures, byMeasure, nStaves,
    width: Math.max(width, avail + 2 * MARGIN_X),
    height: MARGIN_TOP + systems.length * (systemHeight + SYSTEM_GAP),
    staffTop: (ms, staff) => ms.system.y + staff * STAFF_GAP,
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

/** Maps a click to a caret position. */
export function hitTest(lay, view, x, y, voice) {
  const span = (lay.nStaves - 1) * STAFF_GAP + 4 * SP;
  let best = null;
  for (const s of lay.systems) {
    const top = s.y - 3 * SP;
    const bottom = s.y + span + 3 * SP;
    const dist = y < top ? top - y : y > bottom ? y - bottom : 0;
    if (!best || dist < best.dist) best = { s, dist };
  }
  if (!best) return null;
  const s = best.s;
  const staff = Math.max(0, Math.min(lay.nStaves - 1, Math.round((y - s.y - 2 * SP) / STAFF_GAP)));
  const ms = s.measures.find((m) => x < m.x + m.w) || s.measures[s.measures.length - 1];
  if (ms.multi) return { staff, measure: ms.m, voice, index: 0 };
  const events = view.score.staves[staff].measures[ms.m].voices[voice];
  const index = eventXs(lay, ms, events).filter((ex) => x > ex + 0.2 * SP).length;
  return { staff, measure: ms.m, voice, index };
}

/** Renders the whole document. Returns { svg, layout }. */
export function renderScore(view, width, opts = {}) {
  const lay = layout(view, width, opts);
  const score = view.score;
  const out = [];
  const push = (s) => out.push(s);

  // Selection highlight (below everything).
  const sel = view.selection;
  if (sel) {
    for (const ms of lay.measures) {
      if (ms.mEnd < sel.start.measure || ms.m > sel.end.measure) continue;
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
    const first = s.measures[0];
    const xEnd = MARGIN_X + s.width;
    // Measure number.
    push(`<text class="mnum" x="${MARGIN_X}" y="${s.y - 1.6 * SP}">${first.m + 1}</text>`);
    // System bracket.
    if (lay.nStaves > 1) {
      push(`<line class="bar" x1="${MARGIN_X}" x2="${MARGIN_X}" y1="${s.y}" y2="${s.y + (lay.nStaves - 1) * STAFF_GAP + 4 * SP}"/>`);
    }
    for (let st = 0; st < lay.nStaves; st++) {
      const top = s.y + st * STAFF_GAP;
      for (let l = 0; l < 5; l++) {
        push(`<line class="staff" x1="${MARGIN_X}" x2="${xEnd}" y1="${top + l * SP}" y2="${top + l * SP}"/>`);
      }
    }
  }

  for (const ms of lay.measures) {
    const lastMeasure = ms.mEnd === score.measures.length - 1;
    for (let st = 0; st < lay.nStaves; st++) {
      const staff = score.staves[st];
      const top = lay.staffTop(ms, st);
      const mid = CLEF_MIDDLE[staff.clef];
      const yOf = (d) => top + 2 * SP - (d - mid) * (SP / 2);

      if (ms.overfull.has(st)) {
        const beatTicks = TICKS_WHOLE / ms.attrs.time.beat_type;
        const beats = +(ms.overfull.get(st) / beatTicks).toFixed(2);
        const label = `Too many beats: ${beats} of ${ms.attrs.time.beats}`;
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
        const f = ms.attrs.key.fifths;
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

      // Barline.
      const bx = ms.x + ms.w;
      if (lastMeasure) {
        push(`<line class="bar" x1="${bx - 6}" x2="${bx - 6}" y1="${top}" y2="${top + 4 * SP}"/>`);
        push(`<rect class="barthick" x="${bx - 3.5}" y="${top}" width="3.5" height="${4 * SP}"/>`);
      } else {
        push(`<line class="bar" x1="${bx}" x2="${bx}" y1="${top}" y2="${top + 4 * SP}"/>`);
      }

      // Multi-measure rest: thick bar on the middle line, count above.
      if (ms.multi) {
        const x0 = ms.contentX + 0.4 * SP;
        const x1 = ms.contentX + ms.contentW - 0.4 * SP;
        push(`<g class="ev v0 mrest" data-measures="${ms.m + 1}-${ms.mEnd + 1}"><title>Measures ${ms.m + 1}–${ms.mEnd + 1}: ${ms.multi} measures of rest</title>`);
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
        events.forEach((e, i) => drawEvent(push, e, xs[i], top, yOf, mid, v, multi, ms.attrs.key.fifths, cls));
      });
    }
  }

  // Caret.
  const c = view.caret;
  const cms = lay.byMeasure[c.measure];
  if (cms) {
    const events = score.staves[c.staff].measures[c.measure].voices[c.voice];
    const x = gapX(lay, cms, events, c.index);
    const top = lay.staffTop(cms, c.staff);
    push(`<line class="caret v${c.voice}" x1="${x}" x2="${x}" y1="${top - 1.5 * SP}" y2="${top + 5.5 * SP}"/>`);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lay.width}" height="${lay.height}" viewBox="0 0 ${lay.width} ${lay.height}">${out.join('')}</svg>`;
  return { svg, layout: lay };
}

/**
 * Draws one event centred at x. `opts.stem === false` omits stem and flags
 * (used by the ghost when it previews adding a note to an existing chord).
 */
function drawEvent(push, e, x, top, yOf, mid, voice, multi, fifths, cls, opts = {}) {
  const baseIdx = BASES.indexOf(baseKey(e.duration.base));
  const pitches = pitchesOf(e);
  push(`<g class="${cls}"${e.id !== undefined ? ` data-id="${e.id}"` : ''}>`);

  if (pitches.length === 0) {
    // Rests: the whole rest hangs from the 2nd line, the half rest sits on
    // the middle line, the others are centred on it.
    const shift = multi ? (voice % 2 === 0 ? -2 : 2) * SP : 0;
    const w = REST_W[baseIdx] * SP;
    const y = (baseIdx === 0 ? top + SP : top + 2 * SP) + shift;
    push(glyph(REST[baseIdx], x - w / 2, y));
    drawDots(push, e.duration.dots, x + w / 2 + 0.3 * SP, top + 1.5 * SP + shift);
    push('</g>');
    return;
  }

  const headIdx = Math.min(baseIdx, 2);
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
  // down) and the flag glyph at its end.
  if (baseIdx >= 1 && opts.stem !== false) {
    const up = multi ? voice % 2 === 0 : (lo + hi) / 2 < mid;
    const extra = Math.max(0, baseIdx - 4) * 0.5 * SP; // room for 32nd/64th flags
    const sx = up ? left + w - STEM_W / 2 : left + STEM_W / 2;
    const yStart = up ? yOf(lo) - 0.17 * SP : yOf(hi) + 0.17 * SP;
    const yEnd = up ? yOf(hi) - STEM_LEN - extra : yOf(lo) + STEM_LEN + extra;
    push(`<line class="stem" x1="${sx}" x2="${sx}" y1="${yStart}" y2="${yEnd}"/>`);
    if (baseIdx >= 3) push(glyph((up ? FLAG_UP : FLAG_DOWN)[baseIdx - 3], sx - STEM_W / 2, yEnd));
  }
  push('</g>');
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
      const center = s.y + st * STAFF_GAP + 2 * SP;
      const dist = Math.abs(y - center);
      if (!best || dist < best.dist) best = { s, st, dist };
    }
  }
  if (!best || best.dist > 7 * SP) return null;
  const { s, st: staff } = best;
  const ms = s.measures.find((m) => x >= m.x && x < m.x + m.w);
  if (!ms) return null;

  const top = s.y + staff * STAFF_GAP;
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
    staff, measure: ms.m, voice, index, onEvent,
    step,
    octave: Math.floor(d / 7),
    alter: keyAlter(ms.attrs.key.fifths, step),
    fifths: ms.attrs.key.fifths,
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
