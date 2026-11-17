// The 128 General MIDI instruments, which the FluidR3 GM SoundFont plays.
// Each staff plays one of them (Staff.instrument is the program number).
// `name` is what the staff is called when the instrument is picked; `clef`
// is the clef it usually reads (treble when not given).

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
    ['Trumpet'], ['Trombone', 'Trombone', 'bass'], ['Tuba', 'Tuba', 'bass'], ['Muted Trumpet', 'Trumpet'],
    ['French Horn', 'Horn'], ['Brass Section', 'Brass'], ['Synth Brass 1', 'Synth Brass'], ['Synth Brass 2', 'Synth Brass'],
  ]],
  ['Reeds', [
    ['Soprano Sax', 'Soprano Saxophone'], ['Alto Sax', 'Alto Saxophone'], ['Tenor Sax', 'Tenor Saxophone'],
    ['Baritone Sax', 'Baritone Saxophone'], ['Oboe'], ['English Horn', 'English Horn'], ['Bassoon', 'Bassoon', 'bass'],
    ['Clarinet'],
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

/** [{ program, label, name, clef, family }] in program order. */
export const INSTRUMENTS = FAMILIES.flatMap(([family, list], f) =>
  list.map(([label, name, clef], i) => ({ program: f * 8 + i, label, name: name || label, clef: clef || 'treble', family })));

export const instrumentByProgram = (p) => INSTRUMENTS[p] || INSTRUMENTS[0];

/** Options for a <select>, grouped by family. */
export function instrumentOptions(selected, esc) {
  return FAMILIES.map(([family], f) => `<optgroup label="${esc(family)}">${
    INSTRUMENTS.slice(f * 8, f * 8 + 8).map((i) =>
      `<option value="${i.program}"${i.program === selected ? ' selected' : ''}>${esc(i.label)}</option>`).join('')
  }</optgroup>`).join('');
}
