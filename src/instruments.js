// The 128 General MIDI instruments, which the FluidR3 GM SoundFont plays.
// Each staff plays one of them (Staff.instrument is the program number).
// `name` is what the staff is called when the instrument is picked, `short`
// its abbreviation on later systems, `clef` the clef it usually reads
// (treble when not given) and `transposition` how its written notes sound.

const FAMILIES = [
  ['Keyboards', [
    ['Acoustic Grand Piano', 'Piano'], ['Bright Acoustic Piano', 'Piano'], ['Electric Grand Piano', 'Electric Piano'],
    ['Honky-tonk Piano', 'Piano'], ['Electric Piano 1', 'Electric Piano'], ['Electric Piano 2', 'Electric Piano'],
    ['Harpsichord'], ['Clavinet'],
  ]],
  ['Chromatic percussion', [
    ['Celesta'], ['Glockenspiel'], ['Music Box'], ['Vibraphone'], ['Marimba'], ['Xylophone'], ['Tubular Bells'], ['Dulcimer'],
  ]],
  ['Organs and accordions', [
    ['Drawbar Organ', 'Organ'], ['Percussive Organ', 'Organ'], ['Rock Organ', 'Organ'], ['Church Organ', 'Organ'],
    ['Reed Organ', 'Organ'], ['Accordion'], ['Harmonica'], ['Tango Accordion', 'Bandoneon'],
  ]],
  ['Guitars', [
    ['Acoustic Guitar (nylon)', 'Guitar'], ['Acoustic Guitar (steel)', 'Guitar'], ['Electric Guitar (jazz)', 'Electric Guitar'],
    ['Electric Guitar (clean)', 'Electric Guitar'], ['Electric Guitar (muted)', 'Electric Guitar'], ['Overdriven Guitar', 'Electric Guitar'],
    ['Distortion Guitar', 'Electric Guitar'], ['Guitar Harmonics', 'Guitar'],
  ]],
  ['Basses', [
    ['Acoustic Bass', 'Bass', 'bass'], ['Electric Bass (finger)', 'Bass Guitar', 'bass'], ['Electric Bass (pick)', 'Bass Guitar', 'bass'],
    ['Fretless Bass', 'Fretless Bass', 'bass'], ['Slap Bass 1', 'Bass Guitar', 'bass'], ['Slap Bass 2', 'Bass Guitar', 'bass'],
    ['Synth Bass 1', 'Synth Bass', 'bass'], ['Synth Bass 2', 'Synth Bass', 'bass'],
  ]],
  ['Strings', [
    ['Violin'], ['Viola', 'Viola', 'alto'], ['Cello', 'Violoncello', 'bass'], ['Contrabass', 'Contrabass', 'bass'],
    ['Tremolo Strings', 'Strings'], ['Pizzicato Strings', 'Strings'], ['Orchestral Harp', 'Harp'], ['Timpani', 'Timpani', 'bass'],
  ]],
  ['Ensembles and voices', [
    ['String Ensemble 1', 'Strings'], ['String Ensemble 2', 'Strings'], ['Synth Strings 1', 'Synth Strings'],
    ['Synth Strings 2', 'Synth Strings'], ['Choir Aahs', 'Choir'], ['Voice Oohs', 'Voice'], ['Synth Voice', 'Voice'],
    ['Orchestra Hit'],
  ]],
  ['Brass', [
    ['Trumpet', 'Trumpet in B♭'], ['Trombone', 'Trombone', 'bass'], ['Tuba', 'Tuba', 'bass'], ['Muted Trumpet', 'Trumpet in B♭'],
    ['French Horn', 'Horn in F'], ['Brass Section', 'Brass'], ['Synth Brass 1', 'Synth Brass'], ['Synth Brass 2', 'Synth Brass'],
  ]],
  ['Reeds', [
    ['Soprano Sax', 'Soprano Saxophone'], ['Alto Sax', 'Alto Saxophone'], ['Tenor Sax', 'Tenor Saxophone'],
    ['Baritone Sax', 'Baritone Saxophone'], ['Oboe'], ['English Horn', 'English Horn'], ['Bassoon', 'Bassoon', 'bass'],
    ['Clarinet', 'Clarinet in B♭'],
  ]],
  ['Pipes', [
    ['Piccolo'], ['Flute'], ['Recorder'], ['Pan Flute'], ['Blown Bottle'], ['Shakuhachi'], ['Whistle'], ['Ocarina'],
  ]],
  ['Synth leads', [
    ['Lead 1 (square)', 'Synth'], ['Lead 2 (sawtooth)', 'Synth'], ['Lead 3 (calliope)', 'Synth'], ['Lead 4 (chiff)', 'Synth'],
    ['Lead 5 (charang)', 'Synth'], ['Lead 6 (voice)', 'Synth'], ['Lead 7 (fifths)', 'Synth'], ['Lead 8 (bass + lead)', 'Synth'],
  ]],
  ['Synth pads', [
    ['Pad 1 (new age)', 'Pad'], ['Pad 2 (warm)', 'Pad'], ['Pad 3 (polysynth)', 'Pad'], ['Pad 4 (choir)', 'Pad'],
    ['Pad 5 (bowed)', 'Pad'], ['Pad 6 (metallic)', 'Pad'], ['Pad 7 (halo)', 'Pad'], ['Pad 8 (sweep)', 'Pad'],
  ]],
  ['Synth effects', [
    ['FX 1 (rain)', 'Synth'], ['FX 2 (soundtrack)', 'Synth'], ['FX 3 (crystal)', 'Synth'], ['FX 4 (atmosphere)', 'Synth'],
    ['FX 5 (brightness)', 'Synth'], ['FX 6 (goblins)', 'Synth'], ['FX 7 (echoes)', 'Synth'], ['FX 8 (sci-fi)', 'Synth'],
  ]],
  ['World', [
    ['Sitar'], ['Banjo'], ['Shamisen'], ['Koto'], ['Kalimba'], ['Bagpipe'], ['Fiddle'], ['Shanai'],
  ]],
  ['Percussive', [
    ['Tinkle Bell', 'Bells'], ['Agogo'], ['Steel Drums'], ['Woodblock'], ['Taiko Drum', 'Taiko'], ['Melodic Tom', 'Toms'],
    ['Synth Drum', 'Synth Drum'], ['Reverse Cymbal', 'Cymbal'],
  ]],
  ['Sound effects', [
    ['Guitar Fret Noise', 'Effects'], ['Breath Noise', 'Effects'], ['Seashore', 'Effects'], ['Bird Tweet', 'Effects'],
    ['Telephone Ring', 'Effects'], ['Helicopter', 'Effects'], ['Applause', 'Effects'], ['Gunshot', 'Effects'],
  ]],
];

// Written → sounding intervals, in diatonic steps and semitones.
export const TRANSPOSITIONS = [
  { key: 'none', label: 'None (sounds as written)', diatonic: 0, chromatic: 0 },
  { key: 'bb', label: 'In B♭: sounds a major 2nd lower', diatonic: -1, chromatic: -2 },
  { key: 'a', label: 'In A: sounds a minor 3rd lower', diatonic: -2, chromatic: -3 },
  { key: 'g', label: 'In G: sounds a perfect 4th lower', diatonic: -3, chromatic: -5 },
  { key: 'f', label: 'In F: sounds a perfect 5th lower', diatonic: -4, chromatic: -7 },
  { key: 'eb-low', label: 'In E♭: sounds a major 6th lower', diatonic: -5, chromatic: -9 },
  { key: 'd', label: 'In D: sounds a major 2nd higher', diatonic: 1, chromatic: 2 },
  { key: 'eb', label: 'In E♭: sounds a minor 3rd higher', diatonic: 2, chromatic: 3 },
  { key: 'bb-8vb', label: 'In B♭: sounds a major 9th lower', diatonic: -8, chromatic: -14 },
  { key: 'eb-8vb', label: 'In E♭: sounds a major 13th lower', diatonic: -12, chromatic: -21 },
  { key: '8va', label: 'Sounds an octave higher', diatonic: 7, chromatic: 12 },
  { key: '15ma', label: 'Sounds two octaves higher', diatonic: 14, chromatic: 24 },
  { key: '8vb', label: 'Sounds an octave lower', diatonic: -7, chromatic: -12 },
];
const T = Object.fromEntries(TRANSPOSITIONS.map((t) => [t.key, { diatonic: t.diatonic, chromatic: t.chromatic }]));

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

// Usual abbreviations for later systems, by staff name.
const SHORT = {
  Piano: 'Pno.', 'Electric Piano': 'E. Pno.', Harpsichord: 'Hpd.', Clavinet: 'Clav.', Celesta: 'Cel.',
  Glockenspiel: 'Glk.', Vibraphone: 'Vib.', Marimba: 'Mar.', Xylophone: 'Xyl.', 'Tubular Bells': 'T. Bells',
  Organ: 'Org.', Accordion: 'Acc.', Harmonica: 'Hmc.', Guitar: 'Gtr.', 'Electric Guitar': 'E. Gtr.',
  Bass: 'Bass', 'Bass Guitar': 'B. Gtr.', Violin: 'Vln.', Viola: 'Vla.', Violoncello: 'Vc.', Contrabass: 'Cb.',
  Strings: 'Str.', Harp: 'Hp.', Timpani: 'Timp.', Choir: 'Ch.', Voice: 'V.',
  'Trumpet in B♭': 'Tpt.', Trombone: 'Tbn.', Tuba: 'Tba.', 'Horn in F': 'Hn.', Brass: 'Br.',
  'Soprano Saxophone': 'S. Sax.', 'Alto Saxophone': 'A. Sax.', 'Tenor Saxophone': 'T. Sax.', 'Baritone Saxophone': 'B. Sax.',
  Oboe: 'Ob.', 'English Horn': 'E. Hn.', Bassoon: 'Bsn.', 'Clarinet in B♭': 'Cl.', Piccolo: 'Picc.', Flute: 'Fl.',
  Recorder: 'Rec.',
};

/** [{ program, label, name, short, clef, transposition, family }] in program order. */
export const INSTRUMENTS = FAMILIES.flatMap(([family, list], f) =>
  list.map(([label, name, clef], i) => {
    const program = f * 8 + i;
    const n = name || label;
    return {
      program, label, family,
      name: n,
      short: SHORT[n] || `${n.slice(0, 3)}.`,
      clef: clef || 'treble',
      transposition: T[USUAL_TRANSPOSITION[program] || 'none'],
    };
  }));

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
export const transpositionKey = (t) =>
  (TRANSPOSITIONS.find((x) => x.diatonic === (t?.diatonic || 0) && x.chromatic === (t?.chromatic || 0)) || {}).key;

export const instrumentByProgram = (p) => INSTRUMENTS[p] || INSTRUMENTS[0];

/** Options for a <select>, grouped by family. */
export function instrumentOptions(selected, esc) {
  return FAMILIES.map(([family], f) => `<optgroup label="${esc(family)}">${
    INSTRUMENTS.slice(f * 8, f * 8 + 8).map((i) =>
      `<option value="${i.program}"${i.program === selected ? ' selected' : ''}>${esc(i.label)}</option>`).join('')
  }</optgroup>`).join('');
}
