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

// ----- paper (page view) -----------------------------------------------------
// Pages are laid out in staff spaces assuming the common 7 mm staff
// (1 space = 1.75 mm), so a page keeps its real proportions on screen and in
// print, where it is scaled to the paper.
export const PAPER = { a4: { w: 210, h: 297 }, letter: { w: 215.9, h: 279.4 } };
const MM_PER_SP = 1.75;
const PAGE_MARGIN_MM = 15;
export const TITLE_BLOCK = 8 * SP; // room for title and composer on page 1

/** Page size and margin in layout units for a paper name. */
export function pageGeometry(paper) {
  const p = PAPER[paper] || PAPER.a4;
  const unit = SP / MM_PER_SP;
  return { w: p.w * unit, h: p.h * unit, margin: PAGE_MARGIN_MM * unit };
}

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
 * - `opts.multiRest`: merge runs of rest-only measures into one multi-measure rest.
 * - `opts.view`: 'wrap' (fill `width`, default), 'continuous' (one endless
 *   line) or 'page' (systems flow onto pages of `opts.paper`, as printed).
 */
export function layout(view, width, opts = {}) {
  const score = view.score;
  const nStaves = score.staves.length;
  const mode = opts.view || 'wrap';
  const geo = mode === 'page' ? pageGeometry(opts.paper) : null;
  const marginX = geo ? geo.margin : MARGIN_X;
  const avail = geo ? geo.w - 2 * geo.margin
    : mode === 'continuous' ? Infinity
      : Math.max(300, width - 2 * MARGIN_X);

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
  // Vertical placement. Page view flows systems onto pages (a system that
  // would cross the bottom margin starts the next page); the other views
  // stack them on one endless sheet.
  const pageTop = (p) => (geo ? p * geo.h : 0);
  let page = 0;
  let y = geo ? geo.margin + TITLE_BLOCK + MARGIN_TOP : MARGIN_TOP;
  systems.forEach((s, i) => {
    if (geo && i > 0 && y + systemHeight + 2 * SP > pageTop(page) + geo.h - geo.margin) {
      page++;
      y = pageTop(page) + geo.margin + MARGIN_TOP;
    }
    s.index = i;
    s.page = page;
    s.y = y;
    y += systemHeight + SYSTEM_GAP;
    // Justify every system but the last (unless it is already nearly full).
    const last = i === systems.length - 1;
    const stretch = Number.isFinite(avail) && (!last || s.width > avail * 0.75) ? (avail - s.width) / s.measures.length : 0;
    let x = marginX;
    for (const ms of s.measures) {
      ms.w += Math.max(0, stretch);
      ms.x = x;
      ms.system = s;
      ms.contentX = x + ms.prefix + 1.4 * SP;
      ms.contentW = ms.w - ms.prefix - 2.6 * SP;
      x += ms.w;
    }
    s.x0 = marginX;
    s.width = x - marginX;
  });

  const contentWidth = Math.max(...systems.map((s) => s.width), 0) + 2 * marginX;
  const totalWidth = geo ? geo.w : mode === 'continuous' ? Math.max(width, contentWidth) : Math.max(width, avail + 2 * marginX);
  const totalHeight = geo ? (page + 1) * geo.h : y - SYSTEM_GAP + MARGIN_TOP;
  // The regions drawn as separate SVGs: one per page, or one for the sheet.
  const pages = geo
    ? Array.from({ length: page + 1 }, (_, p) => ({ index: p, x: 0, y: pageTop(p), w: geo.w, h: geo.h }))
    : [{ index: 0, x: 0, y: 0, w: totalWidth, h: totalHeight }];

  return {
    systems, measures, byMeasure, nStaves, pages, mode, geo, marginX,
    width: totalWidth,
    height: totalHeight,
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

/**
 * Renders the whole document. Returns `{ pages: [svg…], svg, layout }`: one
 * SVG per page in page view (each showing its slice of the shared layout
 * coordinates through its viewBox), otherwise a single SVG (`svg`).
 */
export function renderScore(view, width, opts = {}) {
  const lay = layout(view, width, opts);
  const score = view.score;
  // Markup per page; `onPage` selects where the next pushes go.
  const outs = lay.pages.map(() => []);
  let cur = 0;
  const onPage = (p) => { cur = p || 0; };
  const push = (s) => outs[cur].push(s);

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
    // System bracket.
    if (lay.nStaves > 1) {
      push(`<line class="bar" x1="${s.x0}" x2="${s.x0}" y1="${s.y}" y2="${s.y + (lay.nStaves - 1) * STAFF_GAP + 4 * SP}"/>`);
    }
    for (let st = 0; st < lay.nStaves; st++) {
      const top = s.y + st * STAFF_GAP;
      for (let l = 0; l < 5; l++) {
        push(`<line class="staff" x1="${s.x0}" x2="${xEnd}" y1="${top + l * SP}" y2="${top + l * SP}"/>`);
      }
    }
  }
  // Page numbers from page 2 on, as in printed music.
  if (lay.geo) {
    for (const p of lay.pages.slice(1)) {
      onPage(p.index);
      push(`<text class="pnum" x="${p.w - lay.geo.margin}" y="${p.y + lay.geo.margin * 0.6}">${p.index + 1}</text>`);
    }
  }

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
        events.forEach((e, i) => {
          const info = drawEvent(push, e, xs[i], top, yOf, mid, v, multi, ms.attrs.key.fifths, cls);
          Object.assign(info, { e, ms, top, staff: st, voice: v, cls });
          drawAttachments(push, info);
          const key = `${st}:${v}`;
          if (!seqs.has(key)) seqs.set(key, []);
          seqs.get(key).push(info);
          byId.set(e.id, info);
        });
      });
    }
  }

  drawTies(push, seqs, onPage);
  drawSlurs(push, score.slurs || [], byId, seqs, onPage);

  // Caret.
  const c = view.caret;
  const cms = lay.byMeasure[c.measure];
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
  return { pages, svg: pages[0], layout: lay };
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
  const y2 = s.y + (lay.nStaves - 1) * STAFF_GAP + 5.5 * SP;
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
    return { x, left: x - w / 2, w, heads: [], up: true, hi: top + SP + shift, lo: top + 3 * SP + shift, rest: true };
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
  // down) and the flag glyph at its end. Whole notes have no stem, but the
  // direction still decides which side ties and articulations go.
  const up = multi ? voice % 2 === 0 : (lo + hi) / 2 < mid;
  let stemEnd = null;
  if (baseIdx >= 1 && opts.stem !== false) {
    const extra = Math.max(0, baseIdx - 4) * 0.5 * SP; // room for 32nd/64th flags
    const sx = up ? left + w - STEM_W / 2 : left + STEM_W / 2;
    const yStart = up ? yOf(lo) - 0.17 * SP : yOf(hi) + 0.17 * SP;
    stemEnd = up ? yOf(hi) - STEM_LEN - extra : yOf(lo) + STEM_LEN + extra;
    push(`<line class="stem" x1="${sx}" x2="${sx}" y1="${yStart}" y2="${stemEnd}"/>`);
    if (baseIdx >= 3) push(glyph((up ? FLAG_UP : FLAG_DOWN)[baseIdx - 3], sx - STEM_W / 2, stemEnd));
  }
  push('</g>');
  return {
    x, left, w, up, stemEnd, mid,
    heads: pitches.map((p) => ({ key: `${p.step}${p.octave}`, y: yOf(diatonic(p)), d: diatonic(p) })),
    hi: Math.min(yOf(hi) - 0.5 * SP, stemEnd ?? Infinity), // topmost ink
    lo: Math.max(yOf(lo) + 0.5 * SP, stemEnd ?? -Infinity), // lowest ink
  };
}

/** Is y on a staff line inside the staff? (Then a mark must move to a space.) */
const onStaffLine = (y, top) => {
  const k = (y - top) / SP;
  return k > -0.01 && k < 4.01 && Math.abs(k - Math.round(k)) < 0.01;
};

/** Articulations, fermata and dynamic of one drawn event. */
function drawAttachments(push, info) {
  const { e, top, x } = info;
  const arts = e.articulations || [];
  if (arts.length || e.dynamic) push(`<g class="${info.cls}">`);

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
  if (e.dynamic) {
    const dy = Math.max(top + 6.6 * SP, info.lo + 2.2 * SP, below ? y + 2 * SP : -Infinity);
    push(`<text class="m mark" x="${x}" y="${dy}">${DYNAMIC[e.dynamic]}</text>`);
  }
  if (arts.length || e.dynamic) push('</g>');
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
    staff, measure: ms.m, voice, index, onEvent, page: s.page || 0,
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
