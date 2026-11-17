// The 128 General MIDI instruments, which the FluidR3 GM SoundFont plays.
// Each staff plays one of them (Staff.instrument is the program number).
// `label` is the sound's name in the list, `name` what the staff is called
// when the instrument is picked, `short` its abbreviation on later systems,
// `clef` the clef it usually reads (treble when not given) and
// `transposition` how its written notes sound. The texts are translated
// (instrument.N, family.N and staffname.* in locales/).

import { t, has } from './i18n.js';

// Staff name (a staffname.* key) and usual clef, in program order.
const PROGRAMS = [
  // Keyboards
  ['piano'], ['piano'], ['epiano'], ['piano'], ['epiano'], ['epiano'], ['harpsichord'], ['clavinet'],
  // Chromatic percussion
  ['celesta'], ['glockenspiel'], ['musicbox'], ['vibraphone'], ['marimba'], ['xylophone'], ['tubularbells'], ['dulcimer'],
  // Organs and accordions
  ['organ'], ['organ'], ['organ'], ['organ'], ['organ'], ['accordion'], ['harmonica'], ['bandoneon'],
  // Guitars
  ['guitar'], ['guitar'], ['eguitar'], ['eguitar'], ['eguitar'], ['eguitar'], ['eguitar'], ['guitar'],
  // Basses
  ['bass', 'bass'], ['bassguitar', 'bass'], ['bassguitar', 'bass'], ['fretless', 'bass'],
  ['bassguitar', 'bass'], ['bassguitar', 'bass'], ['synthbass', 'bass'], ['synthbass', 'bass'],
  // Strings
  ['violin'], ['viola', 'alto'], ['cello', 'bass'], ['contrabass', 'bass'], ['strings'], ['strings'], ['harp'], ['timpani', 'bass'],
  // Ensembles and voices
  ['strings'], ['strings'], ['synthstrings'], ['synthstrings'], ['choir'], ['voice'], ['voice'], ['orchestrahit'],
  // Brass
  ['trumpet'], ['trombone', 'bass'], ['tuba', 'bass'], ['trumpet'], ['horn'], ['brass'], ['synthbrass'], ['synthbrass'],
  // Reeds
  ['sopranosax'], ['altosax'], ['tenorsax'], ['baritonesax'], ['oboe'], ['englishhorn'], ['bassoon', 'bass'], ['clarinet'],
  // Pipes
  ['piccolo'], ['flute'], ['recorder'], ['panflute'], ['blownbottle'], ['shakuhachi'], ['whistle'], ['ocarina'],
  // Synth leads, pads and effects
  ...Array(8).fill(['synth']), ...Array(8).fill(['pad']), ...Array(8).fill(['synth']),
  // World
  ['sitar'], ['banjo'], ['shamisen'], ['koto'], ['kalimba'], ['bagpipe'], ['fiddle'], ['shanai'],
  // Percussive
  ['bells'], ['agogo'], ['steeldrums'], ['woodblock'], ['taiko'], ['toms'], ['synthdrum'], ['cymbal'],
  // Sound effects
  ...Array(8).fill(['effects']),
];
const FAMILY_COUNT = PROGRAMS.length / 8;

// Written → sounding intervals, in diatonic steps and semitones.
export const TRANSPOSITIONS = [
  { key: 'none', diatonic: 0, chromatic: 0 },
  { key: 'bb', diatonic: -1, chromatic: -2 },
  { key: 'a', diatonic: -2, chromatic: -3 },
  { key: 'g', diatonic: -3, chromatic: -5 },
  { key: 'f', diatonic: -4, chromatic: -7 },
  { key: 'eb-low', diatonic: -5, chromatic: -9 },
  { key: 'd', diatonic: 1, chromatic: 2 },
  { key: 'eb', diatonic: 2, chromatic: 3 },
  { key: 'bb-8vb', diatonic: -8, chromatic: -14 },
  { key: 'eb-8vb', diatonic: -12, chromatic: -21 },
  { key: '8va', diatonic: 7, chromatic: 12 },
  { key: '15ma', diatonic: 14, chromatic: 24 },
  { key: '8vb', diatonic: -7, chromatic: -12 },
].map((tr) => ({ ...tr, label: t(`transposition.${tr.key}`) }));
const T = Object.fromEntries(TRANSPOSITIONS.map((tr) => [tr.key, { diatonic: tr.diatonic, chromatic: tr.chromatic }]));

// Usual transposition by General MIDI program.
const USUAL_TRANSPOSITION = {
  8: '8va', 9: '15ma', 13: '8va', // celesta, glockenspiel, xylophone
  24: '8vb', 25: '8vb', 26: '8vb', 27: '8vb', 28: '8vb', 29: '8vb', 30: '8vb', 31: '8vb', // guitars
  32: '8vb', 33: '8vb', 34: '8vb', 35: '8vb', 36: '8vb', 37: '8vb', // basses
  43: '8vb', // contrabass
  56: 'bb', 59: 'bb', 60: 'f', // trumpets, horn
  64: 'bb', 65: 'eb-low', 66: 'bb-8vb', 67: 'eb-8vb', // saxophones
  69: 'f', 71: 'bb', 72: '8va', // English horn, clarinet, piccolo
};

// Instruments usually written on two braced staves (treble and bass).
const GRAND_STAFF = new Set([0, 1, 2, 3, 4, 5, 6, 8, 16, 17, 18, 19, 20, 46]);

/** [{ program, label, name, short, clef, transposition, staves, family }] in program order. */
export const INSTRUMENTS = PROGRAMS.map(([id, clef], program) => {
  const name = t(`staffname.${id}`);
  return {
    program,
    label: t(`instrument.${program}`),
    family: t(`family.${Math.floor(program / 8)}`),
    name,
    short: has(`staffname.${id}.short`) ? t(`staffname.${id}.short`) : `${name.slice(0, 3)}.`,
    clef: clef || 'treble',
    transposition: T[USUAL_TRANSPOSITION[program] || 'none'],
    staves: GRAND_STAFF.has(program) ? 2 : 1,
  };
});

/**
 * The short name for a staff name: the instrument's abbreviation plus
 * what follows its name ("Violin II" → "Vln. II"), or '' when the name
 * is not the instrument's.
 */
export function shortNameFor(name, inst) {
  const n = name.trim();
  if (!n.startsWith(inst.name)) return '';
  return `${inst.short}${n.slice(inst.name.length)}`;
}

/** The TRANSPOSITIONS entry for a { diatonic, chromatic } pair, if listed. */
export const transpositionKey = (tr) =>
  (TRANSPOSITIONS.find((x) => x.diatonic === (tr?.diatonic || 0) && x.chromatic === (tr?.chromatic || 0)) || {}).key;

export const instrumentByProgram = (p) => INSTRUMENTS[p] || INSTRUMENTS[0];

/** Options for a <select>, grouped by family. */
export function instrumentOptions(selected, esc) {
  return Array.from({ length: FAMILY_COUNT }, (_, f) => `<optgroup label="${esc(INSTRUMENTS[f * 8].family)}">${
    INSTRUMENTS.slice(f * 8, f * 8 + 8).map((i) =>
      `<option value="${i.program}"${i.program === selected ? ' selected' : ''}>${esc(i.label)}</option>`).join('')
  }</optgroup>`).join('');
}
