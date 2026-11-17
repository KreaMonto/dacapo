//! Musical data model.
//!
//! A [`Score`] is a grid: a list of global measures (columns, each with its
//! own time and key signature) crossed with a list of [`Staff`]s (rows).
//! Every cell is a [`StaffMeasure`] holding up to [`MAX_VOICES`] independent
//! voices, and every voice is an ordered list of [`Event`]s (notes, chords or
//! rests).

use serde::{Deserialize, Serialize};

/// Resolution of the internal time grid.
pub const TICKS_PER_QUARTER: u32 = 960;
/// Ticks in a whole note.
pub const TICKS_PER_WHOLE: u32 = TICKS_PER_QUARTER * 4;
/// Number of independent voices per staff.
pub const MAX_VOICES: usize = 4;

/// Unique identifier of an event inside a score.
pub type EventId = u64;
/// Unique identifier of a staff inside a score.
pub type StaffId = u64;

/// Diatonic note name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Step {
    C,
    D,
    E,
    F,
    G,
    A,
    B,
}

impl Step {
    const ALL: [Step; 7] = [
        Step::C,
        Step::D,
        Step::E,
        Step::F,
        Step::G,
        Step::A,
        Step::B,
    ];

    /// Position inside the octave (C = 0 … B = 6).
    pub fn index(self) -> i32 {
        self as i32
    }

    /// Inverse of [`Step::index`]; wraps around the octave.
    pub fn from_index(index: i32) -> Step {
        Step::ALL[index.rem_euclid(7) as usize]
    }

    /// Parses a note letter (case-insensitive).
    pub fn from_char(c: char) -> Option<Step> {
        match c.to_ascii_uppercase() {
            'C' => Some(Step::C),
            'D' => Some(Step::D),
            'E' => Some(Step::E),
            'F' => Some(Step::F),
            'G' => Some(Step::G),
            'A' => Some(Step::A),
            'B' => Some(Step::B),
            _ => None,
        }
    }

    /// Semitones above C for the natural note.
    pub fn semitones(self) -> i32 {
        [0, 2, 4, 5, 7, 9, 11][self as usize]
    }
}

/// A concrete pitch: step, chromatic alteration and octave (scientific
/// pitch notation, middle C = C4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Pitch {
    pub step: Step,
    /// -2 = double flat, -1 = flat, 0 = natural, 1 = sharp, 2 = double sharp.
    pub alter: i8,
    pub octave: i8,
}

impl Pitch {
    /// Natural pitch.
    pub fn new(step: Step, octave: i8) -> Self {
        Pitch {
            step,
            alter: 0,
            octave,
        }
    }

    /// Number of diatonic steps above C0. Used for vertical placement.
    pub fn diatonic_index(&self) -> i32 {
        self.octave as i32 * 7 + self.step.index()
    }

    /// Builds a natural pitch from a diatonic index.
    pub fn from_diatonic_index(index: i32) -> Self {
        Pitch::new(Step::from_index(index), index.div_euclid(7) as i8)
    }

    /// MIDI note number (C4 = 60).
    pub fn midi(&self) -> i32 {
        (self.octave as i32 + 1) * 12 + self.step.semitones() + self.alter as i32
    }

    /// Moves the pitch by diatonic steps, keeping its alteration.
    pub fn shifted(self, steps: i32) -> Self {
        let mut p = Pitch::from_diatonic_index(self.diatonic_index() + steps);
        p.alter = self.alter;
        p
    }
}

/// Base (undotted) note value.
///
/// New values are added at the end: the binary recovery journal (postcard)
/// stores variants by position, so reordering would break existing data.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DurationBase {
    Whole,
    Half,
    Quarter,
    Eighth,
    Sixteenth,
    ThirtySecond,
    SixtyFourth,
    /// 128th note (hemidemisemiquaver).
    HundredTwentyEighth,
    /// Double whole note.
    Breve,
}

impl DurationBase {
    /// Length in ticks.
    pub fn ticks(self) -> u32 {
        use DurationBase::*;
        match self {
            Breve => TICKS_PER_WHOLE * 2,
            Whole => TICKS_PER_WHOLE,
            Half => TICKS_PER_WHOLE / 2,
            Quarter => TICKS_PER_WHOLE / 4,
            Eighth => TICKS_PER_WHOLE / 8,
            Sixteenth => TICKS_PER_WHOLE / 16,
            ThirtySecond => TICKS_PER_WHOLE / 32,
            SixtyFourth => TICKS_PER_WHOLE / 64,
            HundredTwentyEighth => TICKS_PER_WHOLE / 128,
        }
    }

    /// Values added in file format 4 (older versions cannot read them).
    pub fn is_extended(self) -> bool {
        matches!(
            self,
            DurationBase::Breve | DurationBase::HundredTwentyEighth
        )
    }
}

/// A rhythmic value: base value plus augmentation dots.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Duration {
    pub base: DurationBase,
    pub dots: u8,
}

impl Duration {
    pub fn new(base: DurationBase) -> Self {
        Duration { base, dots: 0 }
    }

    pub fn dotted(base: DurationBase, dots: u8) -> Self {
        Duration { base, dots }
    }

    /// Length in ticks including dots.
    pub fn ticks(&self) -> u32 {
        let base = self.base.ticks();
        (0..=self.dots as u32).map(|d| base >> d).sum()
    }
}

/// What an event is: silence or one or more simultaneous pitches.
///
/// Externally tagged on purpose: the binary journal format (postcard) does
/// not support internally tagged enums.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Rest,
    /// A single note is a chord with one pitch.
    Chord {
        pitches: Vec<Pitch>,
    },
}

/// Articulation marks attached to a note or chord.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Articulation {
    Staccato,
    Staccatissimo,
    Accent,
    Tenuto,
    Marcato,
    Fermata,
}

/// Dynamic marking printed under an event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Dynamic {
    Ppp,
    Pp,
    P,
    Mp,
    Mf,
    F,
    Ff,
    Fff,
    Sfz,
    Fp,
}

/// How a lyric syllable connects to what follows it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LyricJoin {
    /// The word ends here.
    #[default]
    None,
    /// The word continues on a later note: a hyphen is drawn ("can-tar").
    Hyphen,
    /// The syllable is held over the following notes (a melisma): an
    /// extender line is drawn after it.
    Extender,
}

/// One syllable of lyrics, sung on an event.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Syllable {
    pub text: String,
    #[serde(default)]
    pub join: LyricJoin,
}

impl Syllable {
    /// No text: the event has nothing to sing in this verse.
    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }
}

/// Most verses (lines of lyrics) an event can carry.
pub const MAX_VERSES: usize = 8;
/// Longest syllable, in characters.
pub const MAX_SYLLABLE_CHARS: usize = 48;
/// Longest staff name, in characters.
pub const MAX_STAFF_NAME_CHARS: usize = 40;

/// One rhythmic event inside a voice.
///
/// Fields added after format version 1 use `#[serde(default)]` so older
/// `.partita` files still load. (`skip_serializing_if` must not be used: the
/// binary recovery format needs every field to be written.)
///
/// `Deserialize` is written by hand below, so that recovery data written
/// before a field existed can still be read (see [`reading_legacy`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Event {
    pub id: EventId,
    pub duration: Duration,
    pub kind: EventKind,
    /// Tied to the next event of the same voice (its matching pitches
    /// continue sounding instead of being struck again).
    #[serde(default)]
    pub tie: bool,
    /// Kept sorted and without duplicates.
    #[serde(default)]
    pub articulations: Vec<Articulation>,
    #[serde(default)]
    pub dynamic: Option<Dynamic>,
    /// Lyrics: one syllable per verse (index 0 is the first verse). An
    /// empty syllable means nothing is sung in that verse; there are no
    /// empty syllables at the end. Rests have no lyrics.
    #[serde(default)]
    pub lyrics: Vec<Syllable>,
}

/// The current fields of [`Event`], as read from JSON or binary data.
#[derive(Deserialize)]
struct EventFields {
    id: EventId,
    duration: Duration,
    kind: EventKind,
    #[serde(default)]
    tie: bool,
    #[serde(default)]
    articulations: Vec<Articulation>,
    #[serde(default)]
    dynamic: Option<Dynamic>,
    #[serde(default)]
    lyrics: Vec<Syllable>,
}

/// [`Event`] as written to recovery data up to Da Capo 0.2.1.
#[derive(Deserialize)]
struct EventPreLyrics {
    id: EventId,
    duration: Duration,
    kind: EventKind,
    tie: bool,
    articulations: Vec<Articulation>,
    dynamic: Option<Dynamic>,
}

thread_local! {
    /// Binary recovery format being read; 0 means the current one.
    static LEGACY_FORMAT: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Runs `f` with the document types read in the binary layout of recovery
/// format `version`: 3 (Da Capo 0.2.0 and 0.2.1: no lyrics, no staff
/// instruments) or 4 (Da Capo 0.2.2: no staff instruments).
///
/// The binary recovery format is not self-describing, so a new field
/// cannot simply default to empty as it does in JSON. Recovery data from
/// the previous version must stay readable: an in-app update restarts the
/// program and gives unsaved work back through crash recovery.
pub(crate) fn reading_legacy<T>(version: u32, f: impl FnOnce() -> T) -> T {
    struct Restore(u32);
    impl Drop for Restore {
        fn drop(&mut self) {
            LEGACY_FORMAT.with(|c| c.set(self.0));
        }
    }
    let _restore = Restore(LEGACY_FORMAT.with(|c| c.replace(version)));
    f()
}

fn legacy_format() -> u32 {
    LEGACY_FORMAT.with(|c| c.get())
}

impl<'de> Deserialize<'de> for Event {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if legacy_format() == 3 {
            let e = EventPreLyrics::deserialize(deserializer)?;
            return Ok(Event {
                id: e.id,
                duration: e.duration,
                kind: e.kind,
                tie: e.tie,
                articulations: e.articulations,
                dynamic: e.dynamic,
                lyrics: Vec::new(),
            });
        }
        let e = EventFields::deserialize(deserializer)?;
        Ok(Event {
            id: e.id,
            duration: e.duration,
            kind: e.kind,
            tie: e.tie,
            articulations: e.articulations,
            dynamic: e.dynamic,
            lyrics: e.lyrics,
        })
    }
}

/// A phrase mark from one event to a later one in the same staff and voice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Slur {
    pub id: u64,
    pub start: EventId,
    pub end: EventId,
}

impl Event {
    /// A plain event with no tie, articulations, dynamic or lyrics.
    pub fn new(id: EventId, duration: Duration, kind: EventKind) -> Self {
        Event {
            id,
            duration,
            kind,
            tie: false,
            articulations: Vec::new(),
            dynamic: None,
            lyrics: Vec::new(),
        }
    }

    pub fn ticks(&self) -> u32 {
        self.duration.ticks()
    }

    pub fn is_rest(&self) -> bool {
        matches!(self.kind, EventKind::Rest)
    }

    /// Whether any verse has a syllable on this event.
    pub fn has_lyrics(&self) -> bool {
        !self.lyrics.is_empty()
    }

    /// Pitches of the event (empty for rests).
    pub fn pitches(&self) -> &[Pitch] {
        match &self.kind {
            EventKind::Rest => &[],
            EventKind::Chord { pitches } => pitches,
        }
    }
}

/// Whether a voice is a single *measure rest*: one rest that fills the
/// whole measure. By convention a plain whole rest means "rest for the whole
/// measure" in any time signature (3/4, 6/8, …), so it counts too.
pub fn is_measure_rest(events: &[Event], capacity: u32) -> bool {
    match events {
        [e] => {
            e.is_rest()
                && (e.ticks() == capacity
                    || (e.duration.base == DurationBase::Whole && e.duration.dots == 0))
        }
        _ => false,
    }
}

/// Clef of a staff.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Clef {
    Treble,
    Bass,
    Alto,
    Tenor,
}

impl Clef {
    /// Pitch sitting on the middle staff line.
    pub fn middle_line(self) -> Pitch {
        match self {
            Clef::Treble => Pitch::new(Step::B, 4),
            Clef::Bass => Pitch::new(Step::D, 3),
            Clef::Alto => Pitch::new(Step::C, 4),
            Clef::Tenor => Pitch::new(Step::A, 3),
        }
    }
}

/// Time signature, e.g. 3/4.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TimeSignature {
    pub beats: u8,
    pub beat_type: u8,
}

impl TimeSignature {
    pub const COMMON: TimeSignature = TimeSignature {
        beats: 4,
        beat_type: 4,
    };

    /// Capacity of a measure in ticks.
    pub fn measure_ticks(&self) -> u32 {
        self.beats as u32 * (TICKS_PER_WHOLE / self.beat_type.max(1) as u32)
    }

    /// Only powers of two up to 64 are valid beat types.
    pub fn is_valid(&self) -> bool {
        self.beats > 0 && self.beat_type.is_power_of_two() && self.beat_type <= 64
    }
}

/// Key signature as a number of fifths (negative = flats).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct KeySignature {
    pub fifths: i8,
}

/// Attributes shared by every staff in one measure column.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MeasureAttrs {
    pub time: TimeSignature,
    pub key: KeySignature,
}

impl Default for MeasureAttrs {
    fn default() -> Self {
        MeasureAttrs {
            time: TimeSignature::COMMON,
            key: KeySignature::default(),
        }
    }
}

/// The content of one staff in one measure.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StaffMeasure {
    /// Always exactly [`MAX_VOICES`] entries.
    pub voices: Vec<Vec<Event>>,
}

impl Default for StaffMeasure {
    fn default() -> Self {
        StaffMeasure {
            voices: vec![Vec::new(); MAX_VOICES],
        }
    }
}

/// A horizontal line of music for one instrument or hand.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Staff {
    pub id: StaffId,
    /// Shown at the start of the staff (e.g. "Violin I", "Piano").
    pub name: String,
    pub clef: Clef,
    /// Sound for playback: General MIDI program 0-127 (0 = piano).
    #[serde(default)]
    pub instrument: u8,
    /// One entry per score measure.
    pub measures: Vec<StaffMeasure>,
}

#[derive(Deserialize)]
struct StaffFields {
    id: StaffId,
    name: String,
    clef: Clef,
    #[serde(default)]
    instrument: u8,
    measures: Vec<StaffMeasure>,
}

/// [`Staff`] as written to recovery data before instruments existed
/// (Da Capo 0.2.2 and older).
#[derive(Deserialize)]
struct StaffPreInstrument {
    id: StaffId,
    name: String,
    clef: Clef,
    measures: Vec<StaffMeasure>,
}

impl<'de> Deserialize<'de> for Staff {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if matches!(legacy_format(), 3 | 4) {
            let s = StaffPreInstrument::deserialize(deserializer)?;
            return Ok(Staff {
                id: s.id,
                name: s.name,
                clef: s.clef,
                instrument: 0,
                measures: s.measures,
            });
        }
        let s = StaffFields::deserialize(deserializer)?;
        Ok(Staff {
            id: s.id,
            name: s.name,
            clef: s.clef,
            instrument: s.instrument.min(127),
            measures: s.measures,
        })
    }
}

/// Score-level metadata.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Metadata {
    pub title: String,
    pub composer: String,
}

/// Problems detected by [`Score::validate`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Issue {
    /// A voice contains more music than the time signature allows.
    Overfull {
        staff: usize,
        measure: usize,
        voice: usize,
        ticks: u32,
        capacity: u32,
    },
    /// The staff/measure grid is inconsistent (should never happen).
    Structure { message: String },
}

/// A complete piece of music.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Score {
    pub metadata: Metadata,
    pub measures: Vec<MeasureAttrs>,
    pub staves: Vec<Staff>,
    /// Next free identifier for events and staves.
    pub next_id: u64,
    /// Phrase marks between events.
    #[serde(default)]
    pub slurs: Vec<Slur>,
    /// Playback tempo in quarter notes per minute.
    #[serde(default = "default_tempo")]
    pub tempo: u16,
}

/// Tempo of new scores and of files written before tempo existed.
pub const DEFAULT_TEMPO: u16 = 100;
fn default_tempo() -> u16 {
    DEFAULT_TEMPO
}
/// Accepted tempo range (quarter notes per minute).
pub const TEMPO_RANGE: std::ops::RangeInclusive<u16> = 20..=400;

impl Score {
    /// Ids of every event in the score.
    pub fn event_ids(&self) -> std::collections::HashSet<EventId> {
        self.staves
            .iter()
            .flat_map(|s| s.measures.iter())
            .flat_map(|m| m.voices.iter())
            .flatten()
            .map(|e| e.id)
            .collect()
    }

    /// Where an event lives: (staff, measure, voice, index).
    pub fn locate(&self, id: EventId) -> Option<(usize, usize, usize, usize)> {
        for (s, staff) in self.staves.iter().enumerate() {
            for (m, cell) in staff.measures.iter().enumerate() {
                for (v, events) in cell.voices.iter().enumerate() {
                    if let Some(i) = events.iter().position(|e| e.id == id) {
                        return Some((s, m, v, i));
                    }
                }
            }
        }
        None
    }

    /// Empty score: one treble staff with `measures` empty measures in 4/4.
    pub fn new(title: impl Into<String>, measures: usize) -> Self {
        let measures = measures.max(1);
        let mut score = Score {
            metadata: Metadata {
                title: title.into(),
                composer: String::new(),
            },
            measures: vec![MeasureAttrs::default(); measures],
            staves: Vec::new(),
            next_id: 1,
            slurs: Vec::new(),
            tempo: DEFAULT_TEMPO,
        };
        let staff = score.blank_staff("Staff 1", Clef::Treble);
        score.staves.push(staff);
        score
    }

    /// Allocates a fresh identifier.
    pub fn alloc_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Makes sure future allocations never reuse `id`.
    pub(crate) fn reserve_id(&mut self, id: u64) {
        if id >= self.next_id {
            self.next_id = id + 1;
        }
    }

    /// Builds an empty staff sized to this score (does not insert it).
    pub fn blank_staff(&mut self, name: impl Into<String>, clef: Clef) -> Staff {
        Staff {
            id: self.alloc_id(),
            name: name.into(),
            clef,
            instrument: 0,
            measures: vec![StaffMeasure::default(); self.measures.len()],
        }
    }

    pub fn voice(&self, staff: usize, measure: usize, voice: usize) -> Option<&Vec<Event>> {
        self.staves
            .get(staff)?
            .measures
            .get(measure)?
            .voices
            .get(voice)
    }

    pub fn voice_mut(
        &mut self,
        staff: usize,
        measure: usize,
        voice: usize,
    ) -> Option<&mut Vec<Event>> {
        self.staves
            .get_mut(staff)?
            .measures
            .get_mut(measure)?
            .voices
            .get_mut(voice)
    }

    /// Total ticks used by a voice in a measure.
    pub fn voice_ticks(&self, staff: usize, measure: usize, voice: usize) -> u32 {
        self.voice(staff, measure, voice)
            .map(|events| events.iter().map(Event::ticks).sum())
            .unwrap_or(0)
    }

    /// Checks structural consistency and rhythmic completeness.
    pub fn validate(&self) -> Vec<Issue> {
        let mut issues = Vec::new();
        for (s, staff) in self.staves.iter().enumerate() {
            if staff.measures.len() != self.measures.len() {
                issues.push(Issue::Structure {
                    message: format!(
                        "staff {s} has {} measures, score has {}",
                        staff.measures.len(),
                        self.measures.len()
                    ),
                });
                continue;
            }
            for (m, cell) in staff.measures.iter().enumerate() {
                if cell.voices.len() != MAX_VOICES {
                    issues.push(Issue::Structure {
                        message: format!("staff {s} measure {m} has {} voices", cell.voices.len()),
                    });
                }
                let capacity = self.measures[m].time.measure_ticks();
                for (v, events) in cell.voices.iter().enumerate() {
                    let ticks: u32 = events.iter().map(Event::ticks).sum();
                    if ticks > capacity && !is_measure_rest(events, capacity) {
                        issues.push(Issue::Overfull {
                            staff: s,
                            measure: m,
                            voice: v,
                            ticks,
                            capacity,
                        });
                    }
                }
            }
        }
        issues
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_in_ticks() {
        assert_eq!(Duration::new(DurationBase::Quarter).ticks(), 960);
        assert_eq!(Duration::dotted(DurationBase::Quarter, 1).ticks(), 1440);
        assert_eq!(
            Duration::dotted(DurationBase::Half, 2).ticks(),
            1920 + 960 + 480
        );
        assert_eq!(Duration::new(DurationBase::SixtyFourth).ticks(), 60);
        assert_eq!(Duration::new(DurationBase::HundredTwentyEighth).ticks(), 30);
        assert_eq!(
            Duration::dotted(DurationBase::HundredTwentyEighth, 1).ticks(),
            45
        );
        assert_eq!(Duration::new(DurationBase::Breve).ticks(), 7680);
        assert_eq!(Duration::dotted(DurationBase::Breve, 1).ticks(), 11520);
    }

    #[test]
    fn pitch_math() {
        let c4 = Pitch::new(Step::C, 4);
        assert_eq!(c4.midi(), 60);
        assert_eq!(c4.shifted(-1), Pitch::new(Step::B, 3));
        assert_eq!(c4.shifted(7), Pitch::new(Step::C, 5));
        let fis = Pitch {
            step: Step::F,
            alter: 1,
            octave: 4,
        };
        assert_eq!(fis.midi(), 66);
        assert_eq!(fis.shifted(1).alter, 1);
    }

    #[test]
    fn time_signature_capacity() {
        assert_eq!(TimeSignature::COMMON.measure_ticks(), 3840);
        assert_eq!(
            TimeSignature {
                beats: 6,
                beat_type: 8
            }
            .measure_ticks(),
            2880
        );
        assert!(!TimeSignature {
            beats: 3,
            beat_type: 3
        }
        .is_valid());
    }

    #[test]
    fn new_score_is_valid() {
        let score = Score::new("Test", 4);
        assert_eq!(score.staves.len(), 1);
        assert_eq!(score.staves[0].measures.len(), 4);
        assert!(score.validate().is_empty());
    }
}
