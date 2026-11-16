// Score renderer: turns a DocView (from Rust) into SVG markup.
// Pure functions only — no Tauri calls — so it can be previewed in any
// browser with fake data (see dev/preview.html).
//
// Glyphs come from the Unicode "Musical Symbols" block, which Windows ships
// in Segoe UI Symbol. A proper SMuFL font (Bravura) is on the roadmap.

export const SP = 10; // one staff space, in px
const STAFF_GAP = 10 * SP; // staff top to next staff top inside a system
const SYSTEM_GAP = 7 * SP;
const MARGIN_X = 28;
const MARGIN_TOP = 5 * SP;
const TICKS_WHOLE = 3840;

const BASES = ['whole', 'half', 'quarter', 'eighth', 'sixteenth', 'thirty_second', 'sixty_fourth'];
const STEP_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const CLEF_MIDDLE = { treble: 34, bass: 22, alto: 28, tenor: 26 }; // diatonic index of middle line
const CLEF_GLYPH = { treble: '\u{1D11E}', bass: '\u{1D122}', alto: '\u{1D121}', tenor: '\u{1D121}' };
// Key-signature positions (steps above middle line) for treble; other clefs shift.
const KEY_SHARPS = [4, 1, 5, 2, -1, 3, 0];
const KEY_FLATS = [0, 3, -1, 2, -2, 1, -3];
const CLEF_KEY_SHIFT = { treble: 0, bass: -2, alto: -1, tenor: 1 };
const REST_GLYPH = {
  quarter: '\u{1D13D}', eighth: '\u{1D13E}', sixteenth: '\u{1D13F}',
  thirty_second: '\u{1D140}', sixty_fourth: '\u{1D141}',
};
const ACCIDENTAL = { '-2': '\u{1D12B}', '-1': '♭', '0': '♮', '1': '♯', '2': '\u{1D12A}' };

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

// ----- glyph placement -------------------------------------------------------
// Fonts disagree on how big a symbol is and where it sits relative to the
// baseline, so fixed offsets look wrong with some fonts (the bass clef ended
// up squeezed into the top corner). Instead, the real ink extent of each
// glyph is measured once with a canvas, and the glyph is scaled and placed
// so its ink lands exactly between two target y positions.

// Canvas font specs; `{px}` is replaced by the measuring size. They must
// match the CSS used to draw the same glyphs (.glyph and .tsig).
const GLYPH_FONT = '{px} "Segoe UI Symbol", "Noto Music", "Apple Symbols", serif';
const TSIG_FONT = '700 {px} Georgia, "Times New Roman", serif';
const inkCache = new Map();

/** Ink extent above/below the baseline, as fractions of the font size. */
function inkMetrics(text, font) {
  const key = `${font}|${text}`;
  if (inkCache.has(key)) return inkCache.get(key);
  // Fallback when no canvas is available. All values are fractions of the
  // font size: ink above/below the baseline, ink start after the pen
  // position (`left`) and ink width.
  let m = { above: 0.75, below: 0.25, left: 0, width: 0.6 };
  try {
    const size = 160;
    const canvas = document.createElement('canvas');
    canvas.width = size * 3;
    canvas.height = size * 3;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.font = font.replace('{px}', `${size}px`);
    g.fillStyle = '#000';
    const base = size * 2;
    const pen = size * 0.5;
    g.fillText(text, pen, base);
    const { data, width, height } = g.getImageData(0, 0, canvas.width, canvas.height);
    let top = -1;
    let bottom = -1;
    let left = width;
    let right = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 60) {
          if (top < 0) top = y;
          bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    if (top >= 0) {
      m = {
        above: (base - top) / size,
        below: (bottom + 1 - base) / size,
        left: (left - pen) / size,
        width: (right + 1 - left) / size,
      };
    }
  } catch {
    /* keep fallback */
  }
  inkCache.set(key, m);
  return m;
}

/**
 * Font size and baseline y so that the ink spans [inkTop, inkBottom], plus
 * the pen offset `dx` that makes the ink start exactly at the given x, and
 * the ink `width`.
 */
function fitGlyph(text, font, inkTop, inkBottom) {
  const m = inkMetrics(text, font);
  const fs = (inkBottom - inkTop) / (m.above + m.below);
  return { fs, y: inkTop + m.above * fs, dx: -m.left * fs, width: m.width * fs };
}

/** Ink width of a clef drawn on a staff (independent of the staff's y). */
const clefWidth = (clef) => fitGlyph(CLEF_GLYPH[clef], GLYPH_FONT, 0, (CLEF_INK[clef][1] - CLEF_INK[clef][0]) * SP).width;
/** Room reserved for the clef column: the widest clef in the system. */
const clefColumn = (score) => Math.max(...score.staves.map((s) => clefWidth(s.clef))) + 1.0 * SP;

// Where each clef's ink should start and end, in staff spaces from the top
// line (standard engraving proportions, as in the SMuFL reference font).
const CLEF_INK = {
  treble: [-1.45, 5.6], // curl around the G line, tail below the staff
  bass: [-0.05, 3.5], // head from the top line, dots around the F line
  alto: [0, 4], // centered on the middle (C) line
  tenor: [-1, 3], // centered on the 4th (C) line
};

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

  const keyWidth = (f) => Math.abs(f) * 0.9 * SP;
  const clefCol = clefColumn(score);
  const systems = [];
  let sys = null;
  for (const ms of measures) {
    const startPrefix = 0.6 * SP + clefCol + keyWidth(ms.attrs.key.fifths) + (ms.timeChange ? 2.8 * SP : 0) + SP;
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
    systems, measures, byMeasure, nStaves, clefCol,
    width: Math.max(width, avail + 2 * MARGIN_X),
    height: MARGIN_TOP + systems.length * (systemHeight + SYSTEM_GAP),
    staffTop: (ms, staff) => ms.system.y + staff * STAFF_GAP,
    tickX: (ms, tick) => ms.contentX + (tick / ms.cap) * ms.contentW,
  };
}

/** Horizontal center of a measure's content: where a measure rest sits. */
const centerX = (ms) => ms.contentX + ms.contentW / 2 - 0.6 * SP;

/** x of each event's notehead/rest in a voice. */
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
    return index === 0 ? ms.contentX - 0.6 * SP : centerX(ms) + 2.2 * SP;
  }
  let tick = 0;
  for (let i = 0; i < index && i < events.length; i++) tick += durationTicks(events[i].duration);
  if (index < events.length) return lay.tickX(ms, tick) - 0.9 * SP;
  if (events.length === 0) return ms.contentX - 0.6 * SP;
  const lastStart = tick - durationTicks(events[events.length - 1].duration);
  return Math.max(lay.tickX(ms, tick) - 0.9 * SP, lay.tickX(ms, lastStart) + 1.6 * SP);
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
      const x0 = exact && ms.m === sel.start.measure ? lay.tickX(ms, sel.start.tick) - 0.9 * SP : ms.x;
      const x1 = exact && ms.m === sel.end.measure ? lay.tickX(ms, sel.end.tick) - 0.9 * SP
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
        const [a, b] = CLEF_INK[staff.clef];
        const { fs, y, dx } = fitGlyph(CLEF_GLYPH[staff.clef], GLYPH_FONT, top + a * SP, top + b * SP);
        push(`<text class="glyph clef" x="${px + dx}" y="${y}" style="font-size:${fs}px">${CLEF_GLYPH[staff.clef]}</text>`);
        px += lay.clefCol;
      }
      if (ms.systemStart || ms.keyChange) {
        const f = ms.attrs.key.fifths;
        const positions = (f >= 0 ? KEY_SHARPS : KEY_FLATS).slice(0, Math.abs(f));
        for (const p of positions) {
          const y = top + 2 * SP - (p + CLEF_KEY_SHIFT[staff.clef]) * (SP / 2);
          push(`<text class="acc" x="${px}" y="${y + 0.45 * SP}">${f > 0 ? '♯' : '♭'}</text>`);
          px += 0.9 * SP;
        }
        if (positions.length) px += 0.4 * SP;
      }
      if (ms.timeChange) {
        // Each number fills exactly half the staff (two spaces), as printed.
        const upper = fitGlyph(String(ms.attrs.time.beats), TSIG_FONT, top, top + 2 * SP);
        const lower = fitGlyph(String(ms.attrs.time.beat_type), TSIG_FONT, top + 2 * SP, top + 4 * SP);
        push(`<text class="tsig" x="${px + 1.1 * SP}" y="${upper.y}" style="font-size:${upper.fs}px">${ms.attrs.time.beats}</text>`);
        push(`<text class="tsig" x="${px + 1.1 * SP}" y="${lower.y}" style="font-size:${lower.fs}px">${ms.attrs.time.beat_type}</text>`);
      }

      // Barline.
      const bx = ms.x + ms.w;
      if (lastMeasure) {
        push(`<line class="bar" x1="${bx - 5}" x2="${bx - 5}" y1="${top}" y2="${top + 4 * SP}"/>`);
        push(`<rect class="barthick" x="${bx - 3}" y="${top}" width="3" height="${4 * SP}"/>`);
      } else {
        push(`<line class="bar" x1="${bx}" x2="${bx}" y1="${top}" y2="${top + 4 * SP}"/>`);
      }

      // Multi-measure rest: thick bar on the middle line, count above.
      if (ms.multi) {
        const x0 = ms.contentX + 0.4 * SP;
        const x1 = ms.contentX + ms.contentW - 0.4 * SP;
        push(`<g class="ev v0 mrest" data-measures="${ms.m + 1}-${ms.mEnd + 1}"><title>Measures ${ms.m + 1}–${ms.mEnd + 1}: ${ms.multi} measures of rest</title>`);
        push(`<rect x="${x0}" y="${top + 1.6 * SP}" width="${x1 - x0}" height="${0.8 * SP}"/>`);
        push(`<rect x="${x0}" y="${top + SP}" width="1.4" height="${2 * SP}"/><rect x="${x1 - 1.4}" y="${top + SP}" width="1.4" height="${2 * SP}"/>`);
        push(`<text class="tsig" x="${(x0 + x1) / 2}" y="${top - 0.6 * SP}">${ms.multi}</text></g>`);
        continue;
      }

      // Events.
      const voices = staff.measures[ms.m].voices;
      const multi = voices.filter((v) => v.length).length > 1;
      voices.forEach((events, v) => {
        const active = view.caret.voice === v;
        if (isMeasureRest(events, capacity(ms.attrs))) {
          // Measure rest: whole-rest symbol hanging from the 4th line, centered.
          const shift = multi ? (v % 2 === 0 ? -2 : 2) * SP : 0;
          const x = centerX(ms);
          push(`<g class="ev v${v}${active ? '' : ' dim'}" data-id="${events[0].id}"><rect x="${x - 0.6 * SP}" y="${top + SP + shift}" width="${1.2 * SP}" height="${0.5 * SP}"/></g>`);
          return;
        }
        const xs = eventXs(lay, ms, events);
        events.forEach((e, i) => drawEvent(push, e, xs[i], top, yOf, mid, v, multi, ms.attrs.key.fifths, active));
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

function drawEvent(push, e, x, top, yOf, mid, voice, multi, fifths, activeVoice) {
  const baseIdx = BASES.indexOf(baseKey(e.duration.base));
  const cls = `ev v${voice}${activeVoice ? '' : ' dim'}`;
  const pitches = pitchesOf(e);
  push(`<g class="${cls}" data-id="${e.id}">`);
  if (pitches.length === 0) {
    const shift = multi ? (voice % 2 === 0 ? -2 : 2) * SP : 0;
    if (baseIdx === 0) {
      push(`<rect x="${x - 0.6 * SP}" y="${top + SP + shift}" width="${1.2 * SP}" height="${0.5 * SP}"/>`);
    } else if (baseIdx === 1) {
      push(`<rect x="${x - 0.6 * SP}" y="${top + 1.5 * SP + shift}" width="${1.2 * SP}" height="${0.5 * SP}"/>`);
    } else {
      push(`<text class="glyph rest" x="${x - 0.5 * SP}" y="${top + 2.9 * SP + shift}" font-size="${3.2 * SP}">${REST_GLYPH[baseKey(e.duration.base)]}</text>`);
    }
    drawDots(push, e.duration.dots, x + 0.9 * SP, top + 1.5 * SP + shift);
    push('</g>');
    return;
  }

  const ds = pitches.map(diatonic).sort((a, b) => a - b);
  const lo = ds[0];
  const hi = ds[ds.length - 1];
  const rx = baseIdx === 0 ? 0.78 * SP : 0.62 * SP;
  const ry = 0.46 * SP;

  // Ledger lines.
  const ledger = (from, to) => {
    for (let d = from; d <= to; d += 2) {
      const y = yOf(d);
      push(`<line class="ledger" x1="${x - rx - 0.45 * SP}" x2="${x + rx + 0.45 * SP}" y1="${y}" y2="${y}"/>`);
    }
  };
  if (hi >= mid + 6) ledger(mid + 6, hi);
  if (lo <= mid - 6) ledger(lo + ((mid - 6 - lo) % 2 === 0 ? 0 : 1), mid - 6);

  // Noteheads, accidentals, dots.
  for (const p of pitches) {
    const y = yOf(diatonic(p));
    const hollow = baseIdx <= 1;
    const rot = baseIdx === 0 ? '' : ` transform="rotate(-20 ${x} ${y})"`;
    push(`<ellipse class="${hollow ? 'hollow' : 'head'}" cx="${x}" cy="${y}" rx="${rx}" ry="${ry}"${rot}/>`);
    if (p.alter !== keyAlter(fifths, p.step)) {
      push(`<text class="acc" x="${x - rx - 1.25 * SP}" y="${y + 0.45 * SP}">${ACCIDENTAL[String(p.alter)]}</text>`);
    }
    const onLine = (diatonic(p) - mid) % 2 === 0;
    drawDots(push, e.duration.dots, x + rx + 0.55 * SP, onLine ? y - SP / 2 : y);
  }

  // Stem and flags.
  if (baseIdx >= 1) {
    const up = multi ? voice % 2 === 0 : (lo + hi) / 2 < mid;
    const len = 3.4 * SP;
    const sx = up ? x + rx - 0.6 : x - rx + 0.6;
    const yStart = up ? yOf(lo) : yOf(hi);
    const yEnd = up ? yOf(hi) - len : yOf(lo) + len;
    push(`<line class="stem" x1="${sx}" x2="${sx}" y1="${yStart}" y2="${yEnd}"/>`);
    const flags = Math.max(0, baseIdx - 2);
    for (let f = 0; f < flags; f++) {
      const fy = up ? yEnd + f * 0.8 * SP : yEnd - f * 0.8 * SP;
      const dir = up ? 1 : -1;
      push(`<path class="flag" d="M${sx} ${fy} c ${0.2 * SP} ${dir * 0.9 * SP}, ${1.3 * SP} ${dir * 1.2 * SP}, ${0.9 * SP} ${dir * 2.6 * SP}"/>`);
    }
  }
  push('</g>');
}

function drawDots(push, dots, x, y) {
  for (let i = 0; i < dots; i++) {
    push(`<circle class="dot" cx="${x + i * 0.55 * SP}" cy="${y}" r="${0.18 * SP}"/>`);
  }
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

  return {
    staff, measure: ms.m, voice, index, onEvent,
    step: STEPS[((d % 7) + 7) % 7],
    octave: Math.floor(d / 7),
    alter: keyAlter(ms.attrs.key.fifths, STEPS[((d % 7) + 7) % 7]),
    d, mid, top,
    x: onEvent !== null ? eventX : x,
    y: top + 2 * SP - (d - mid) * (SP / 2),
    gapX: gapX(lay, ms, events, index),
  };
}

/** Semi-transparent preview of the figure that a click would place. */
export function ghostMarkup(t, duration, rest) {
  if (!t) return '';
  const baseIdx = BASES.indexOf(baseKey(duration.base));
  const out = [];
  const push = (s) => out.push(s);
  // Insertion marker (where the new event goes), unless adding to a chord.
  if (t.onEvent === null || rest) {
    push(`<line class="ins" x1="${t.gapX}" x2="${t.gapX}" y1="${t.top - 1.5 * SP}" y2="${t.top + 5.5 * SP}"/>`);
  }
  if (rest) {
    if (baseIdx <= 1) {
      push(`<rect x="${t.x - 0.6 * SP}" y="${t.top + (baseIdx === 0 ? SP : 1.5 * SP)}" width="${1.2 * SP}" height="${0.5 * SP}"/>`);
    } else {
      push(`<text class="glyph" x="${t.x - 0.5 * SP}" y="${t.top + 2.9 * SP}" font-size="${3.2 * SP}">${REST_GLYPH[baseKey(duration.base)]}</text>`);
    }
    drawDots(push, duration.dots, t.x + 0.9 * SP, t.top + 1.5 * SP);
  } else {
    const { x, y, d, mid } = t;
    const rx = baseIdx === 0 ? 0.78 * SP : 0.62 * SP;
    const yOf = (k) => t.top + 2 * SP - (k - mid) * (SP / 2);
    for (let k = mid + 6; k <= d; k += 2) push(`<line class="ledger" x1="${x - rx - 0.45 * SP}" x2="${x + rx + 0.45 * SP}" y1="${yOf(k)}" y2="${yOf(k)}"/>`);
    for (let k = mid - 6; k >= d; k -= 2) push(`<line class="ledger" x1="${x - rx - 0.45 * SP}" x2="${x + rx + 0.45 * SP}" y1="${yOf(k)}" y2="${yOf(k)}"/>`);
    const rot = baseIdx === 0 ? '' : ` transform="rotate(-20 ${x} ${y})"`;
    push(`<ellipse class="${baseIdx <= 1 ? 'hollow' : 'head'}" cx="${x}" cy="${y}" rx="${rx}" ry="${0.46 * SP}"${rot}/>`);
    if (baseIdx >= 1 && t.onEvent === null) {
      const up = d < mid;
      const sx = up ? x + rx - 0.6 : x - rx + 0.6;
      const yEnd = up ? y - 3.4 * SP : y + 3.4 * SP;
      push(`<line class="stem" x1="${sx}" x2="${sx}" y1="${y}" y2="${yEnd}"/>`);
      for (let f = 0; f < Math.max(0, baseIdx - 2); f++) {
        const fy = up ? yEnd + f * 0.8 * SP : yEnd - f * 0.8 * SP;
        const dir = up ? 1 : -1;
        push(`<path class="flag" d="M${sx} ${fy} c ${0.2 * SP} ${dir * 0.9 * SP}, ${1.3 * SP} ${dir * 1.2 * SP}, ${0.9 * SP} ${dir * 2.6 * SP}"/>`);
      }
    }
    const onLine = (d - mid) % 2 === 0;
    drawDots(push, duration.dots, x + rx + 0.55 * SP, onLine ? y - SP / 2 : y);
    // Pitch name next to the figure.
    push(`<text class="pname" x="${x + rx + 1.2 * SP}" y="${y - 0.8 * SP}">${t.step}${ALTER_TEXT[String(t.alter)]}${t.octave}${t.onEvent !== null ? ' +' : ''}</text>`);
  }
  return `<g class="ghost">${out.join('')}</g>`;
}

export { esc };
