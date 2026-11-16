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

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Computes positions of systems, measures and events. */
export function layout(view, width) {
  const score = view.score;
  const nStaves = score.staves.length;
  const avail = Math.max(300, width - 2 * MARGIN_X);

  const measures = score.measures.map((attrs, m) => {
    let maxEvents = 0;
    let maxFill = 0;
    for (const staff of score.staves) {
      for (const voice of staff.measures[m].voices) {
        maxEvents = Math.max(maxEvents, voice.length);
        maxFill = Math.max(maxFill, voice.reduce((t, e) => t + durationTicks(e.duration), 0));
      }
    }
    const cap = Math.max(capacity(attrs), maxFill, 1);
    const prev = m > 0 ? score.measures[m - 1] : null;
    return {
      m, attrs, cap,
      overfull: maxFill > capacity(attrs),
      content: Math.max(9 * SP, maxEvents * 3.6 * SP + 2 * SP),
      timeChange: !prev || prev.time.beats !== attrs.time.beats || prev.time.beat_type !== attrs.time.beat_type,
      keyChange: !!prev && prev.key.fifths !== attrs.key.fifths,
    };
  });

  const keyWidth = (f) => Math.abs(f) * 0.9 * SP;
  const systems = [];
  let sys = null;
  for (const ms of measures) {
    const startPrefix = 3.8 * SP + keyWidth(ms.attrs.key.fifths) + (ms.timeChange ? 2.8 * SP : 0) + SP;
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
    systems, measures, nStaves,
    width: Math.max(width, avail + 2 * MARGIN_X),
    height: MARGIN_TOP + systems.length * (systemHeight + SYSTEM_GAP),
    staffTop: (ms, staff) => ms.system.y + staff * STAFF_GAP,
    tickX: (ms, tick) => ms.contentX + (tick / ms.cap) * ms.contentW,
  };
}

/** x of the caret gap before event `index` (or after the last one). */
function gapX(lay, ms, events, index) {
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
  const events = view.score.staves[staff].measures[ms.m].voices[voice];
  let index = 0;
  let tick = 0;
  for (const e of events) {
    if (x > lay.tickX(ms, tick) + 0.2 * SP) index++;
    tick += durationTicks(e.duration);
  }
  return { staff, measure: ms.m, voice, index };
}

/** Renders the whole document. Returns { svg, layout }. */
export function renderScore(view, width) {
  const lay = layout(view, width);
  const score = view.score;
  const out = [];
  const push = (s) => out.push(s);

  // Selection highlight (below everything).
  const sel = view.selection;
  if (sel) {
    for (const ms of lay.measures) {
      if (ms.m < sel.start.measure || ms.m > sel.end.measure) continue;
      const x0 = ms.m === sel.start.measure ? lay.tickX(ms, sel.start.tick) - 0.9 * SP : ms.x;
      const x1 = ms.m === sel.end.measure ? lay.tickX(ms, sel.end.tick) - 0.9 * SP : ms.x + ms.w;
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
    const lastMeasure = ms.m === score.measures.length - 1;
    for (let st = 0; st < lay.nStaves; st++) {
      const staff = score.staves[st];
      const top = lay.staffTop(ms, st);
      const mid = CLEF_MIDDLE[staff.clef];
      const yOf = (d) => top + 2 * SP - (d - mid) * (SP / 2);

      if (ms.overfull) {
        push(`<rect class="overfull" x="${ms.x + 2}" y="${top - 0.5 * SP}" width="${ms.w - 4}" height="${5 * SP}"><title>Too many beats for the time signature</title></rect>`);
      }

      // Prefix: clef, key, time.
      let px = ms.x + 0.6 * SP;
      if (ms.systemStart) {
        const clefY = { treble: top + 3 * SP, bass: top + SP, alto: top + 2 * SP, tenor: top + SP }[staff.clef];
        const size = staff.clef === 'treble' ? 4.4 * SP : 3.4 * SP;
        const dy = staff.clef === 'treble' ? 1.05 * SP : staff.clef === 'bass' ? 1.15 * SP : 1.25 * SP;
        push(`<text class="glyph" x="${px}" y="${clefY + dy}" font-size="${size}">${CLEF_GLYPH[staff.clef]}</text>`);
        px += 3.6 * SP;
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
        push(`<text class="tsig" x="${px + 1.1 * SP}" y="${top + 1.75 * SP}">${ms.attrs.time.beats}</text>`);
        push(`<text class="tsig" x="${px + 1.1 * SP}" y="${top + 3.75 * SP}">${ms.attrs.time.beat_type}</text>`);
      }

      // Barline.
      const bx = ms.x + ms.w;
      if (lastMeasure) {
        push(`<line class="bar" x1="${bx - 5}" x2="${bx - 5}" y1="${top}" y2="${top + 4 * SP}"/>`);
        push(`<rect class="barthick" x="${bx - 3}" y="${top}" width="3" height="${4 * SP}"/>`);
      } else {
        push(`<line class="bar" x1="${bx}" x2="${bx}" y1="${top}" y2="${top + 4 * SP}"/>`);
      }

      // Events.
      const voices = staff.measures[ms.m].voices;
      const multi = voices.filter((v) => v.length).length > 1;
      voices.forEach((events, v) => {
        let tick = 0;
        for (const e of events) {
          const x = lay.tickX(ms, tick);
          tick += durationTicks(e.duration);
          drawEvent(push, e, x, top, yOf, mid, v, multi, ms.attrs.key.fifths, view.caret.voice === v);
        }
      });
    }
  }

  // Caret.
  const c = view.caret;
  const cms = lay.measures[c.measure];
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

export { esc };
