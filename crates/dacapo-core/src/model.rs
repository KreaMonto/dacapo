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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DurationBase {
    Whole,
    Half,
    Quarter,
    Eighth,
    Sixteenth,
    ThirtySecond,
    SixtyFourth,
}

impl DurationBase {
    /// Length in ticks.
    pub fn ticks(self) -> u32 {
        TICKS_PER_WHOLE >> (self as u32)
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

/// One rhythmic event inside a voice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub id: EventId,
    pub duration: Duration,
    pub kind: EventKind,
}

impl Event {
    pub fn ticks(&self) -> u32 {
        self.duration.ticks()
    }

    pub fn is_rest(&self) -> bool {
        matches!(self.kind, EventKind::Rest)
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Staff {
    pub id: StaffId,
    pub name: String,
    pub clef: Clef,
    /// One entry per score measure.
    pub measures: Vec<StaffMeasure>,
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
}

impl Score {
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
