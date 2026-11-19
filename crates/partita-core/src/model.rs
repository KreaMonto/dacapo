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

    /// The next way of writing the same sound: those with one accidental
    /// first, then double sharps and flats, then the natural one, and round
    /// again (F♯ → G♭ → E𝄪 → F♯; C → B♯ → D𝄫 → C).
    pub fn respelled(self) -> Self {
        let midi = self.midi();
        let mut options: Vec<Pitch> = Step::ALL
            .iter()
            .flat_map(|&step| (-2i8..=2).map(move |alter| (step, alter)))
            .filter(|&(step, alter)| (midi - step.semitones() - alter as i32).rem_euclid(12) == 0)
            .map(|(step, alter)| Pitch {
                step,
                alter,
                octave: ((midi - step.semitones() - alter as i32) / 12 - 1) as i8,
            })
            .collect();
        let rank = |a: i8| match a.abs() {
            1 => 0,
            2 => 1,
            _ => 2,
        };
        options.sort_by_key(|p| (rank(p.alter), -p.alter));
        match options.iter().position(|p| *p == self) {
            Some(i) => options[(i + 1) % options.len()],
            None => options.first().copied().unwrap_or(self),
        }
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
    /// The value twice as long (a quarter's is a half), if there is one.
    pub fn doubled(self) -> Option<Self> {
        use DurationBase::*;
        Some(match self {
            Breve => return None,
            Whole => Breve,
            Half => Whole,
            Quarter => Half,
            Eighth => Quarter,
            Sixteenth => Eighth,
            ThirtySecond => Sixteenth,
            SixtyFourth => ThirtySecond,
            HundredTwentyEighth => SixtyFourth,
        })
    }

    /// The value half as long, if there is one.
    pub fn halved(self) -> Option<Self> {
        use DurationBase::*;
        Some(match self {
            Breve => Whole,
            Whole => Half,
            Half => Quarter,
            Quarter => Eighth,
            Eighth => Sixteenth,
            Sixteenth => ThirtySecond,
            ThirtySecond => SixtyFourth,
            SixtyFourth => HundredTwentyEighth,
            HundredTwentyEighth => return None,
        })
    }

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

/// A tuplet: `actual` notes of `unit` in the time of `normal` (a triplet of
/// eighths is 3 eighths in the time of 2). Every note of the group carries
/// it; groups are read from the voice: a group is complete once its notes
/// fill `normal` × `unit`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Tuplet {
    pub actual: u8,
    pub normal: u8,
    pub unit: DurationBase,
}

impl Tuplet {
    /// The time a whole group takes, in ticks.
    pub fn span(self) -> u32 {
        self.unit.ticks() * self.normal as u32
    }
}

/// A grace note: drawn small before the note it ornaments, and played in
/// that note's time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Grace {
    /// Struck through, played as short as possible.
    Acciaccatura,
    /// Without the stroke, played as half of the main note.
    Appoggiatura,
}

/// Tremolo strokes on a note. On one note (`between` false) it is only
/// marked and played as repeated notes. Between two notes (both of them
/// carry it, one after the other) each is written with twice its time and
/// counts half: a tremolo lasting a half note is written as two halves.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Tremolo {
    /// 1 to 3 strokes: eighths, sixteenths, thirty-seconds.
    pub strokes: u8,
    pub between: bool,
}

/// A rhythmic value: base value plus augmentation dots, the tuplet it
/// belongs to, whether it is a grace note (which takes no time), and its
/// tremolo.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
pub struct Duration {
    pub base: DurationBase,
    pub dots: u8,
    /// Since file format 8 (recovery format 16).
    pub tuplet: Option<Tuplet>,
    /// Since file format 8 (recovery format 16).
    pub grace: Option<Grace>,
    /// Since file format 8 (recovery format 16).
    pub tremolo: Option<Tremolo>,
}

#[derive(Deserialize)]
struct DurationFields {
    base: DurationBase,
    dots: u8,
    #[serde(default)]
    tuplet: Option<Tuplet>,
    #[serde(default)]
    grace: Option<Grace>,
    #[serde(default)]
    tremolo: Option<Tremolo>,
}

/// [`Duration`] as written to recovery formats 3 to 15 (before tuplets).
#[derive(Deserialize)]
struct DurationPreTuplet {
    base: DurationBase,
    dots: u8,
}

impl<'de> Deserialize<'de> for Duration {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if matches!(legacy_format(), 3..=15) {
            let d = DurationPreTuplet::deserialize(deserializer)?;
            return Ok(Duration {
                base: d.base,
                dots: d.dots,
                tuplet: None,
                grace: None,
                tremolo: None,
            });
        }
        let d = DurationFields::deserialize(deserializer)?;
        Ok(Duration {
            base: d.base,
            dots: d.dots,
            tuplet: d.tuplet,
            grace: d.grace,
            tremolo: d.tremolo,
        })
    }
}

impl Duration {
    pub fn new(base: DurationBase) -> Self {
        Duration {
            base,
            dots: 0,
            tuplet: None,
            grace: None,
            tremolo: None,
        }
    }

    /// The same value as a grace note.
    pub fn as_grace(self, grace: Grace) -> Self {
        Duration {
            grace: Some(grace),
            tuplet: None,
            ..self
        }
    }

    /// The same value in a tuplet.
    pub fn in_tuplet(self, tuplet: Tuplet) -> Self {
        Duration {
            tuplet: Some(tuplet),
            ..self
        }
    }

    /// Without its tuplet if that would not come out in whole ticks (a
    /// septuplet, for one): Partita counts 960 ticks to the quarter, which
    /// divides by 2, 3, 4, 5 and 6 but not by 7.
    /// A grace note is never in a tuplet.
    pub fn exact(self) -> Self {
        match self.tuplet {
            Some(_) if self.grace.is_some() => Duration {
                tuplet: None,
                ..self
            },
            Some(t)
                if t.actual == 0
                    || t.normal == 0
                    || !(self.notated_ticks() * t.normal as u32)
                        .is_multiple_of(t.actual as u32) =>
            {
                Duration {
                    tuplet: None,
                    ..self
                }
            }
            _ => self,
        }
    }

    /// Length in ticks as written, before the tuplet.
    pub fn notated_ticks(&self) -> u32 {
        let base = self.base.ticks();
        (0..=self.dots as u32).map(|d| base >> d).sum()
    }

    pub fn dotted(base: DurationBase, dots: u8) -> Self {
        Duration {
            base,
            dots,
            tuplet: None,
            grace: None,
            tremolo: None,
        }
    }

    /// Length in ticks, dots and tuplet included; none for a grace note;
    /// half its written value in a tremolo between two notes.
    pub fn ticks(&self) -> u32 {
        if self.grace.is_some() {
            return 0;
        }
        if self.tremolo.is_some_and(|t| t.between) {
            return self.notated_ticks() / 2;
        }
        let notated = self.notated_ticks();
        match self.tuplet {
            Some(t) if t.actual > 0 => notated * t.normal as u32 / t.actual as u32,
            _ => notated,
        }
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
    // Since file format 8 (added last: the recovery journal stores variants
    // by position).
    /// Upper mordent: the note, the step above, the note.
    Mordent,
    /// Lower mordent: the note, the step below, the note.
    MordentLower,
    /// Turn: the step above, the note, the step below, the note.
    Turn,
    /// The chord is played upwards, one note after another.
    Arpeggio,
    /// A breath (a comma over the staff after the note): a little shorter.
    BreathMark,
    /// A caesura (// after the note): a clear break.
    Caesura,
}

impl Articulation {
    /// Whether file format 8 is needed for it.
    pub fn is_ornament(self) -> bool {
        self >= Articulation::Mordent
    }
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
    /// Words attached to the event (an expression, a technique), at most one
    /// of each kind, in kind order. Since file format 7 (recovery format 8).
    #[serde(default)]
    pub texts: Vec<NoteText>,
    /// How the note is beamed to the one before it, when not as the time
    /// signature says. Since file format 8 (recovery format 16).
    #[serde(default)]
    pub beam: Option<Beam>,
}

/// A beam set by hand on a note, against the automatic beaming.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Beam {
    /// A new beam starts at this note.
    Break,
    /// Beamed to the note before, even across a beat.
    Join,
}

/// Where words attached to a note go, and how they look.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteTextKind {
    /// Under the staff, in italics: how to play (dolce, espressivo, cresc.).
    Expression,
    /// Over the staff: a playing technique (pizz., arco, con sord.).
    Technique,
}

/// Words attached to a note or rest: they move, copy and disappear with it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteText {
    pub kind: NoteTextKind,
    pub text: String,
}

/// Longest text attached to a note, in characters.
pub const MAX_NOTE_TEXT_CHARS: usize = 60;

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
    #[serde(default)]
    texts: Vec<NoteText>,
    #[serde(default)]
    beam: Option<Beam>,
}

/// [`Event`] as written to recovery data before manual beams (formats 8 to
/// 15).
#[derive(Deserialize)]
struct EventPreBeam {
    id: EventId,
    duration: Duration,
    kind: EventKind,
    tie: bool,
    articulations: Vec<Articulation>,
    dynamic: Option<Dynamic>,
    lyrics: Vec<Syllable>,
    texts: Vec<NoteText>,
}

/// [`Event`] as written to recovery data before note texts (formats 4 to 7).
#[derive(Deserialize)]
struct EventPreTexts {
    id: EventId,
    duration: Duration,
    kind: EventKind,
    tie: bool,
    articulations: Vec<Articulation>,
    dynamic: Option<Dynamic>,
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
/// instruments, no page texts), 4 (Da Capo 0.2.2: no staff instruments, no
/// page texts), 5 (Partita 0.3.0: no page texts), or 6 to 8 (development
/// builds before 0.4.0: no tempo markings in 6; no note texts or rehearsal
/// marks in 6 and 7; no text styles or text boxes in 6 to 8; no barline
/// types in 6 to 9; no repeats in 6 to 10; no endings in 6 to 11; no
/// jumps in 6 to 12; no measure lengths in 6 to 13; no layout breaks in
/// any of them), or 15 (Partita 0.3.14: no tuplets, grace notes, manual
/// beams or clef changes; so too all the older ones).
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
                texts: Vec::new(),
                beam: None,
            });
        }
        if matches!(legacy_format(), 4..=7) {
            let e = EventPreTexts::deserialize(deserializer)?;
            return Ok(Event {
                id: e.id,
                duration: e.duration,
                kind: e.kind,
                tie: e.tie,
                articulations: e.articulations,
                dynamic: e.dynamic,
                lyrics: e.lyrics,
                texts: Vec::new(),
                beam: None,
            });
        }
        if matches!(legacy_format(), 8..=15) {
            let e = EventPreBeam::deserialize(deserializer)?;
            return Ok(Event {
                id: e.id,
                duration: e.duration,
                kind: e.kind,
                tie: e.tie,
                articulations: e.articulations,
                dynamic: e.dynamic,
                lyrics: e.lyrics,
                texts: e.texts,
                beam: None,
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
            texts: e.texts,
            beam: e.beam,
        })
    }
}

/// What a line between two notes is. The octave lines move the drawing of
/// the notes under them (their pitch is kept as it sounds); hairpins and
/// rit. / accel. change the playback over their length.
///
/// New kinds are added at the end: the binary recovery journal (postcard)
/// stores variants by position.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LineKind {
    /// 8va: drawn an octave lower than they sound.
    #[serde(rename = "8va")]
    OttavaAlta,
    /// 8vb: drawn an octave higher than they sound.
    #[serde(rename = "8vb")]
    OttavaBassa,
    /// 15ma: drawn two octaves lower.
    #[serde(rename = "15ma")]
    QuindicesimaAlta,
    /// 15mb: drawn two octaves higher.
    #[serde(rename = "15mb")]
    QuindicesimaBassa,
    /// Hairpin opening: louder.
    #[serde(rename = "crescendo")]
    Crescendo,
    /// Hairpin closing: softer.
    #[serde(rename = "diminuendo")]
    Diminuendo,
    /// tr and a wavy line: the notes are trilled with the step above.
    #[serde(rename = "trill")]
    Trill,
    /// A line from one note to the next, sliding between them.
    #[serde(rename = "glissando")]
    Glissando,
    /// rit.: gradually slower.
    #[serde(rename = "rit")]
    Ritardando,
    /// accel.: gradually faster.
    #[serde(rename = "accel")]
    Accelerando,
}

/// Lines that cannot overlap on a staff: a new one replaces the others of
/// its family it overlaps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LineFamily {
    Octave,
    Hairpin,
    Trill,
    Glissando,
    Tempo,
}

impl LineKind {
    /// Octaves the notes sound above where they are drawn (0 for lines
    /// that are not octave lines).
    pub fn octaves(self) -> i8 {
        match self {
            LineKind::OttavaAlta => 1,
            LineKind::OttavaBassa => -1,
            LineKind::QuindicesimaAlta => 2,
            LineKind::QuindicesimaBassa => -2,
            _ => 0,
        }
    }

    pub fn family(self) -> LineFamily {
        match self {
            LineKind::OttavaAlta
            | LineKind::OttavaBassa
            | LineKind::QuindicesimaAlta
            | LineKind::QuindicesimaBassa => LineFamily::Octave,
            LineKind::Crescendo | LineKind::Diminuendo => LineFamily::Hairpin,
            LineKind::Trill => LineFamily::Trill,
            LineKind::Glissando => LineFamily::Glissando,
            LineKind::Ritardando | LineKind::Accelerando => LineFamily::Tempo,
        }
    }
}

/// A line over the notes of a staff (every voice) from the event `start` to
/// the event `end`, both in that staff: an octave line, a hairpin, a trill,
/// a glissando, rit. or accel. Since file format 8 (recovery format 16).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Line {
    pub id: u64,
    pub start: EventId,
    pub end: EventId,
    pub kind: LineKind,
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
            texts: Vec::new(),
            beam: None,
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
/// The tuplet groups of a voice, as (first, last) event indexes: notes in
/// the same tuplet that follow each other, until they fill its span.
pub fn tuplet_groups(events: &[Event]) -> Vec<(usize, usize)> {
    let mut groups = Vec::new();
    let mut open: Option<(usize, Tuplet, u32)> = None;
    for (i, e) in events.iter().enumerate() {
        // Grace notes inside a group take no time: they do not end it.
        if e.duration.grace.is_some() {
            continue;
        }
        let Some(t) = e.duration.tuplet else {
            if let Some((start, _, _)) = open.take() {
                groups.push((start, i - 1));
            }
            continue;
        };
        match open {
            Some((start, ot, filled)) if ot == t && filled < ot.span() => {
                let filled = filled + e.ticks();
                if filled >= t.span() {
                    groups.push((start, i));
                    open = None;
                } else {
                    open = Some((start, ot, filled));
                }
            }
            _ => {
                if let Some((start, _, _)) = open.take() {
                    groups.push((start, i - 1));
                }
                if e.ticks() >= t.span() {
                    groups.push((i, i));
                } else {
                    open = Some((i, t, e.ticks()));
                }
            }
        }
    }
    if let Some((start, _, _)) = open {
        groups.push((start, events.len() - 1));
    }
    groups
}

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

/// The barline at the end of a measure.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Barline {
    /// One thin line. The last measure of a score is drawn with a final
    /// barline anyway.
    #[default]
    Single,
    /// Two thin lines: the end of a section.
    Double,
    /// A thin and a thick line: the end of the piece (or of a movement).
    Final,
    /// A dashed line: a subdivision inside a long measure, or a phrase.
    Dashed,
}

/// Attributes shared by every staff in one measure column.
///
/// `time` and `key` are in force in the measure (repeated in every measure
/// until they change); `tempo` is a marking printed at the start of this
/// measure only, `barline` the line that closes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MeasureAttrs {
    pub time: TimeSignature,
    pub key: KeySignature,
    /// Since file format 7 (recovery format 7).
    pub tempo: Option<TempoMark>,
    /// A rehearsal mark at the start of this measure ("A", "12"), printed
    /// in a box. Since file format 7 (recovery format 8).
    pub rehearsal: Option<String>,
    /// The barline at the end of this measure. Since file format 7
    /// (recovery format 10).
    pub barline: Barline,
    /// A repeated passage starts at the beginning of this measure. Since
    /// file format 7 (recovery format 11).
    pub repeat_start: bool,
    /// A repeated passage ends with this measure, played this many times in
    /// all (2 for an ordinary repeat). Drawn instead of the barline. Since
    /// file format 7 (recovery format 11).
    pub repeat_end: Option<u8>,
    /// The endings ("1.", "2.", "1., 2.") this measure belongs to, in order,
    /// or empty. Consecutive measures with the same numbers form one ending
    /// bracket; on the n-th time through a repeat, measures whose ending
    /// does not include n are skipped. Since file format 7 (recovery
    /// format 12).
    pub ending: Vec<u8>,
    /// A segno (𝄋) at the start of this measure: where a D.S. goes back to.
    /// Since file format 7 (recovery format 13).
    pub segno: bool,
    /// The coda (𝄌) begins with this measure. Since file format 7
    /// (recovery format 13).
    pub coda: bool,
    /// Fine, To Coda, D.C. or D.S. at the end of this measure. Since file
    /// format 7 (recovery format 13).
    pub jump: Option<Jump>,
    /// How long the measure really is, in ticks, when it is shorter than its
    /// time signature: a pickup (anacrusis) at the start, or the measure
    /// that completes it at the end. Since file format 7 (recovery format
    /// 14).
    pub length: Option<u32>,
    /// A system or page break after this measure. Since file format 7
    /// (recovery format 15).
    pub break_after: Option<LayoutBreak>,
}

impl MeasureAttrs {
    /// The ticks the measure holds: its own length, or the time
    /// signature's.
    pub fn capacity(&self) -> u32 {
        let full = self.time.measure_ticks();
        self.length.filter(|&l| l > 0 && l < full).unwrap_or(full)
    }
}

/// The highest ending number.
pub const MAX_ENDING: u8 = 8;

/// Where a line or a page of music is made to end.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayoutBreak {
    /// The next measure starts a new system.
    System,
    /// The next measure starts a new page (in page view; a new system
    /// otherwise).
    Page,
}

/// An instruction at the end of a measure that changes where the music
/// goes: where it ends (*Fine*), where it leaves for the coda (*To Coda*),
/// or a jump back to the beginning (*D.C.*) or to the segno (*D.S.*).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Jump {
    /// The end of the piece after a D.C. or D.S. al Fine.
    Fine,
    /// After a D.C. or D.S. al Coda, the music goes on at the coda.
    ToCoda,
    DaCapo,
    DaCapoAlFine,
    DaCapoAlCoda,
    DalSegno,
    DalSegnoAlFine,
    DalSegnoAlCoda,
}

impl Jump {
    /// The words printed for it.
    pub fn text(self) -> &'static str {
        match self {
            Jump::Fine => "Fine",
            Jump::ToCoda => "To Coda",
            Jump::DaCapo => "D.C.",
            Jump::DaCapoAlFine => "D.C. al Fine",
            Jump::DaCapoAlCoda => "D.C. al Coda",
            Jump::DalSegno => "D.S.",
            Jump::DalSegnoAlFine => "D.S. al Fine",
            Jump::DalSegnoAlCoda => "D.S. al Coda",
        }
    }

    /// Whether it sends the music back (D.C., D.S.).
    pub fn is_jump(self) -> bool {
        !matches!(self, Jump::Fine | Jump::ToCoda)
    }
}

/// How many times a repeated passage can be played in all.
pub const REPEAT_TIMES: std::ops::RangeInclusive<u8> = 2..=10;

impl Default for MeasureAttrs {
    fn default() -> Self {
        MeasureAttrs {
            time: TimeSignature::COMMON,
            key: KeySignature::default(),
            tempo: None,
            rehearsal: None,
            barline: Barline::Single,
            repeat_start: false,
            repeat_end: None,
            ending: Vec::new(),
            segno: false,
            coda: false,
            jump: None,
            length: None,
            break_after: None,
        }
    }
}

#[derive(Deserialize)]
struct MeasureAttrsFields {
    time: TimeSignature,
    key: KeySignature,
    #[serde(default)]
    tempo: Option<TempoMark>,
    #[serde(default)]
    rehearsal: Option<String>,
    #[serde(default)]
    barline: Barline,
    #[serde(default)]
    repeat_start: bool,
    #[serde(default)]
    repeat_end: Option<u8>,
    #[serde(default)]
    ending: Vec<u8>,
    #[serde(default)]
    segno: bool,
    #[serde(default)]
    coda: bool,
    #[serde(default)]
    jump: Option<Jump>,
    #[serde(default)]
    length: Option<u32>,
    #[serde(default)]
    break_after: Option<LayoutBreak>,
}

/// [`MeasureAttrs`] as written to recovery format 14 (before layout breaks).
#[derive(Deserialize)]
struct MeasureAttrsPreBreak {
    time: TimeSignature,
    key: KeySignature,
    tempo: Option<TempoMark>,
    rehearsal: Option<String>,
    barline: Barline,
    repeat_start: bool,
    repeat_end: Option<u8>,
    ending: Vec<u8>,
    segno: bool,
    coda: bool,
    jump: Option<Jump>,
    length: Option<u32>,
}

/// [`MeasureAttrs`] as written to recovery format 13 (before measure lengths).
#[derive(Deserialize)]
struct MeasureAttrsPreLength {
    time: TimeSignature,
    key: KeySignature,
    tempo: Option<TempoMark>,
    rehearsal: Option<String>,
    barline: Barline,
    repeat_start: bool,
    repeat_end: Option<u8>,
    ending: Vec<u8>,
    segno: bool,
    coda: bool,
    jump: Option<Jump>,
}

/// [`MeasureAttrs`] as written to recovery format 12 (before jumps).
#[derive(Deserialize)]
struct MeasureAttrsPreJump {
    time: TimeSignature,
    key: KeySignature,
    tempo: Option<TempoMark>,
    rehearsal: Option<String>,
    barline: Barline,
    repeat_start: bool,
    repeat_end: Option<u8>,
    ending: Vec<u8>,
}

/// [`MeasureAttrs`] as written to recovery format 11 (before endings).
#[derive(Deserialize)]
struct MeasureAttrsPreEnding {
    time: TimeSignature,
    key: KeySignature,
    tempo: Option<TempoMark>,
    rehearsal: Option<String>,
    barline: Barline,
    repeat_start: bool,
    repeat_end: Option<u8>,
}

/// [`MeasureAttrs`] as written to recovery format 10 (before repeats).
#[derive(Deserialize)]
struct MeasureAttrsPreRepeat {
    time: TimeSignature,
    key: KeySignature,
    tempo: Option<TempoMark>,
    rehearsal: Option<String>,
    barline: Barline,
}

/// [`MeasureAttrs`] as written to recovery formats 8 and 9 (before barlines).
#[derive(Deserialize)]
struct MeasureAttrsPreBarline {
    time: TimeSignature,
    key: KeySignature,
    tempo: Option<TempoMark>,
    rehearsal: Option<String>,
}

/// [`MeasureAttrs`] as written to recovery format 7 (before rehearsal marks).
#[derive(Deserialize)]
struct MeasureAttrsPreRehearsal {
    time: TimeSignature,
    key: KeySignature,
    tempo: Option<TempoMark>,
}

/// [`MeasureAttrs`] as written to recovery data before tempo marks
/// (recovery formats 3 to 6).
#[derive(Deserialize)]
struct MeasureAttrsPreTempo {
    time: TimeSignature,
    key: KeySignature,
}

impl<'de> Deserialize<'de> for MeasureAttrs {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if matches!(legacy_format(), 3..=6) {
            let a = MeasureAttrsPreTempo::deserialize(deserializer)?;
            return Ok(MeasureAttrs {
                time: a.time,
                key: a.key,
                ..MeasureAttrs::default()
            });
        }
        if legacy_format() == 7 {
            let a = MeasureAttrsPreRehearsal::deserialize(deserializer)?;
            return Ok(MeasureAttrs {
                time: a.time,
                key: a.key,
                tempo: a.tempo,
                ..MeasureAttrs::default()
            });
        }
        if matches!(legacy_format(), 8 | 9) {
            let a = MeasureAttrsPreBarline::deserialize(deserializer)?;
            return Ok(MeasureAttrs {
                time: a.time,
                key: a.key,
                tempo: a.tempo,
                rehearsal: a.rehearsal,
                ..MeasureAttrs::default()
            });
        }
        if legacy_format() == 10 {
            let a = MeasureAttrsPreRepeat::deserialize(deserializer)?;
            return Ok(MeasureAttrs {
                time: a.time,
                key: a.key,
                tempo: a.tempo,
                rehearsal: a.rehearsal,
                barline: a.barline,
                ..MeasureAttrs::default()
            });
        }
        if legacy_format() == 11 {
            let a = MeasureAttrsPreEnding::deserialize(deserializer)?;
            return Ok(MeasureAttrs {
                time: a.time,
                key: a.key,
                tempo: a.tempo,
                rehearsal: a.rehearsal,
                barline: a.barline,
                repeat_start: a.repeat_start,
                repeat_end: a.repeat_end,
                ..MeasureAttrs::default()
            });
        }
        if legacy_format() == 12 {
            let a = MeasureAttrsPreJump::deserialize(deserializer)?;
            return Ok(MeasureAttrs {
                time: a.time,
                key: a.key,
                tempo: a.tempo,
                rehearsal: a.rehearsal,
                barline: a.barline,
                repeat_start: a.repeat_start,
                repeat_end: a.repeat_end,
                ending: a.ending,
                ..MeasureAttrs::default()
            });
        }
        if legacy_format() == 13 {
            let a = MeasureAttrsPreLength::deserialize(deserializer)?;
            return Ok(MeasureAttrs {
                time: a.time,
                key: a.key,
                tempo: a.tempo,
                rehearsal: a.rehearsal,
                barline: a.barline,
                repeat_start: a.repeat_start,
                repeat_end: a.repeat_end,
                ending: a.ending,
                segno: a.segno,
                coda: a.coda,
                jump: a.jump,
                length: None,
                break_after: None,
            });
        }
        if legacy_format() == 14 {
            let a = MeasureAttrsPreBreak::deserialize(deserializer)?;
            return Ok(MeasureAttrs {
                time: a.time,
                key: a.key,
                tempo: a.tempo,
                rehearsal: a.rehearsal,
                barline: a.barline,
                repeat_start: a.repeat_start,
                repeat_end: a.repeat_end,
                ending: a.ending,
                segno: a.segno,
                coda: a.coda,
                jump: a.jump,
                length: a.length,
                break_after: None,
            });
        }
        let a = MeasureAttrsFields::deserialize(deserializer)?;
        Ok(MeasureAttrs {
            time: a.time,
            key: a.key,
            tempo: a.tempo,
            rehearsal: a.rehearsal,
            barline: a.barline,
            repeat_start: a.repeat_start,
            repeat_end: a.repeat_end,
            ending: a.ending,
            segno: a.segno,
            coda: a.coda,
            jump: a.jump,
            length: a.length,
            break_after: a.break_after,
        })
    }
}

/// The note value a metronome mark counts (♩ = 76, ♩. = 60…).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BeatUnit {
    Eighth,
    #[default]
    Quarter,
    DottedQuarter,
    Half,
    DottedHalf,
}

impl BeatUnit {
    /// Length in eighth notes (a dotted quarter is 3).
    pub fn eighths(self) -> u32 {
        match self {
            BeatUnit::Eighth => 1,
            BeatUnit::Quarter => 2,
            BeatUnit::DottedQuarter => 3,
            BeatUnit::Half => 4,
            BeatUnit::DottedHalf => 6,
        }
    }

    /// The number a metronome mark shows for a tempo in quarter notes per
    /// minute (♩ = 90 is ♩. = 60).
    pub fn per_minute(self, quarter_bpm: u16) -> u16 {
        ((quarter_bpm as u32 * 2 + self.eighths() / 2) / self.eighths()) as u16
    }

    /// Quarter notes per minute for `beats` of this unit per minute.
    pub fn to_quarter_bpm(self, beats: u16) -> u16 {
        (beats as u32 * self.eighths()).div_ceil(2) as u16
    }
}

/// A tempo marking at the start of a measure: words ("Andante con moto"),
/// a metronome mark (♩ = 76), or both. What is printed is chosen apart from
/// what plays: a hidden marking still sets the playback tempo.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TempoMark {
    /// The words, or empty.
    pub text: String,
    /// Quarter notes per minute from this measure on, or `None` for words
    /// alone that do not change the tempo ("dolce", "a tempo"…). Ignored in
    /// the first measure, whose tempo is [`Score::tempo`].
    pub bpm: Option<u16>,
    /// The note value the metronome mark shows.
    pub beat: BeatUnit,
    pub show_text: bool,
    pub show_metronome: bool,
}

impl Default for TempoMark {
    fn default() -> Self {
        TempoMark {
            text: String::new(),
            bpm: None,
            beat: BeatUnit::Quarter,
            show_text: true,
            show_metronome: true,
        }
    }
}

/// The content of one staff in one measure.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StaffMeasure {
    /// Always exactly [`MAX_VOICES`] entries.
    pub voices: Vec<Vec<Event>>,
    /// A clef change at the start of this measure (never in the first
    /// measure: that is the staff's own clef). Since file format 8
    /// (recovery format 16).
    pub clef: Option<Clef>,
}

impl Default for StaffMeasure {
    fn default() -> Self {
        StaffMeasure {
            voices: vec![Vec::new(); MAX_VOICES],
            clef: None,
        }
    }
}

#[derive(Deserialize)]
struct StaffMeasureFields {
    voices: Vec<Vec<Event>>,
    #[serde(default)]
    clef: Option<Clef>,
}

/// [`StaffMeasure`] as written to recovery formats 3 to 15 (before clef
/// changes).
#[derive(Deserialize)]
struct StaffMeasurePreClef {
    voices: Vec<Vec<Event>>,
}

impl<'de> Deserialize<'de> for StaffMeasure {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if matches!(legacy_format(), 3..=15) {
            let m = StaffMeasurePreClef::deserialize(deserializer)?;
            return Ok(StaffMeasure {
                voices: m.voices,
                clef: None,
            });
        }
        let m = StaffMeasureFields::deserialize(deserializer)?;
        Ok(StaffMeasure {
            voices: m.voices,
            clef: m.clef,
        })
    }
}

/// A horizontal line of music for one instrument or hand.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Staff {
    pub id: StaffId,
    /// Shown at the start of the staff on the first system (e.g. "Violin I").
    pub name: String,
    /// Shown on the following systems (e.g. "Vln. I"); empty for none.
    #[serde(default)]
    pub short_name: String,
    pub clef: Clef,
    /// Sound for playback: General MIDI program 0-127 (0 = piano).
    #[serde(default)]
    pub instrument: u8,
    /// How the written notes sound: a B-flat clarinet sounds a major
    /// second lower than written. Pitches are stored as written.
    #[serde(default)]
    pub transposition: Transposition,
    /// Bracket or brace joining this staff with its neighbours: consecutive
    /// staves with the same group are joined.
    #[serde(default)]
    pub group: Option<StaffGroup>,
    /// One entry per score measure.
    pub measures: Vec<StaffMeasure>,
}

/// Interval from written to sounding pitch, in diatonic steps and
/// semitones: (-1, -2) is a major second down (B-flat instruments),
/// (-4, -7) a perfect fifth down (F horn), (7, 12) an octave up (piccolo).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Transposition {
    pub diatonic: i8,
    pub chromatic: i8,
}

impl Transposition {
    pub const NONE: Transposition = Transposition {
        diatonic: 0,
        chromatic: 0,
    };

    pub fn is_none(&self) -> bool {
        *self == Transposition::NONE
    }

    /// The interval as a number of fifths (+2 for a major second up),
    /// which is how much it moves a key signature.
    pub fn fifths(&self) -> i32 {
        7 * self.chromatic as i32 - 12 * self.diatonic as i32
    }

    /// The written key for a concert-pitch key: the key moves the other
    /// way from the sound. Kept within seven sharps or flats.
    pub fn written_key(&self, concert: KeySignature) -> KeySignature {
        let mut f = concert.fifths as i32 - self.fifths();
        while f > 7 {
            f -= 12;
        }
        while f < -7 {
            f += 12;
        }
        KeySignature { fifths: f as i8 }
    }

    /// The concert key for a written key.
    pub fn concert_key(&self, written: KeySignature) -> KeySignature {
        Transposition {
            diatonic: -self.diatonic,
            chromatic: -self.chromatic,
        }
        .written_key(written)
    }

    /// MIDI key of a written pitch.
    pub fn sounding_midi(&self, written: Pitch) -> i32 {
        written.midi() + self.chromatic as i32
    }
}

impl Pitch {
    /// The pitch moved by an interval of `diatonic` steps and `chromatic`
    /// semitones, spelled accordingly (C + major second = D, E + minor
    /// second = F).
    pub fn transposed(self, diatonic: i32, chromatic: i32) -> Pitch {
        let mut p = Pitch::from_diatonic_index(self.diatonic_index() + diatonic);
        let natural_shift = p.midi() - Pitch::new(self.step, self.octave).midi();
        p.alter = (self.alter as i32 + chromatic - natural_shift).clamp(-2, 2) as i8;
        p
    }
}

/// How a group of staves is joined at the left edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupKind {
    /// A square bracket: an instrument family (woodwinds, strings...).
    Bracket,
    /// A curly brace: one instrument on several staves (piano, harp).
    Brace,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct StaffGroup {
    pub id: u64,
    pub kind: GroupKind,
}

#[derive(Deserialize)]
struct StaffFields {
    id: StaffId,
    name: String,
    #[serde(default)]
    short_name: String,
    clef: Clef,
    #[serde(default)]
    instrument: u8,
    #[serde(default)]
    transposition: Transposition,
    #[serde(default)]
    group: Option<StaffGroup>,
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
                short_name: String::new(),
                clef: s.clef,
                instrument: 0,
                transposition: Transposition::NONE,
                group: None,
                measures: s.measures,
            });
        }
        let s = StaffFields::deserialize(deserializer)?;
        Ok(Staff {
            id: s.id,
            name: s.name,
            short_name: s.short_name,
            clef: s.clef,
            instrument: s.instrument.min(127),
            transposition: s.transposition,
            group: s.group,
            measures: s.measures,
        })
    }
}

/// The texts around the music: the headings of page 1, the running header
/// and footer of the printed pages, and how pages are numbered. A text left
/// empty is not printed. `header`, `footer` and the page number `format`
/// may contain `{page}`, `{pages}`, `{title}` and `{composer}`.
///
/// Everything after `composer` exists since file format 7 (recovery
/// format 6); older files get the defaults.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Metadata {
    pub title: String,
    pub composer: String,
    /// Under the title.
    pub subtitle: String,
    /// Above the title, in small italics ("To my teacher").
    pub dedication: String,
    /// Left of page 1, across from the composer: the lyricist or the
    /// arranger, as the user writes it ("Words: …", "Arr. …").
    pub lyricist: String,
    /// Top left of page 1: the part, in a set of parts ("Violin I").
    pub part: String,
    /// Bottom of page 1.
    pub copyright: String,
    /// Top of every page but the first (which has the title).
    pub header: String,
    /// Bottom of every page.
    pub footer: String,
    pub page_numbers: PageNumbers,
}

/// Where and how page numbers are printed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PageNumbers {
    pub show: bool,
    pub edge: PageEdge,
    pub align: PageAlign,
    /// Also on page 1 (usually not: it has the title).
    pub first_page: bool,
    /// The text, with `{page}` (and `{pages}`) for the numbers.
    pub format: String,
}

/// The top or the bottom margin of a page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageEdge {
    Top,
    Bottom,
}

/// Where across a page: `Outside` is right on odd pages and left on even
/// ones, as in a bound book.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageAlign {
    Left,
    Center,
    Right,
    Outside,
}

/// As Partita always numbered pages: top right, from page 2 on.
impl Default for PageNumbers {
    fn default() -> Self {
        PageNumbers {
            show: true,
            edge: PageEdge::Top,
            align: PageAlign::Right,
            first_page: false,
            format: "{page}".to_string(),
        }
    }
}

impl Metadata {
    /// Whether anything beyond the title and composer is set (which needs
    /// file format 7).
    pub fn uses_page_texts(&self) -> bool {
        let Metadata {
            title: _,
            composer: _,
            subtitle,
            dedication,
            lyricist,
            part,
            copyright,
            header,
            footer,
            page_numbers,
        } = self;
        [
            subtitle, dedication, lyricist, part, copyright, header, footer,
        ]
        .iter()
        .any(|s| !s.is_empty())
            || *page_numbers != PageNumbers::default()
    }
}

#[derive(Deserialize)]
#[serde(default)]
struct MetadataFields {
    title: String,
    composer: String,
    subtitle: String,
    dedication: String,
    lyricist: String,
    part: String,
    copyright: String,
    header: String,
    footer: String,
    page_numbers: PageNumbers,
}

impl Default for MetadataFields {
    fn default() -> Self {
        let m = Metadata::default();
        MetadataFields {
            title: m.title,
            composer: m.composer,
            subtitle: m.subtitle,
            dedication: m.dedication,
            lyricist: m.lyricist,
            part: m.part,
            copyright: m.copyright,
            header: m.header,
            footer: m.footer,
            page_numbers: m.page_numbers,
        }
    }
}

/// [`Metadata`] as written to recovery data before page texts (Partita
/// 0.3.0 and older).
#[derive(Deserialize)]
struct MetadataPrePageTexts {
    title: String,
    composer: String,
}

impl<'de> Deserialize<'de> for Metadata {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if matches!(legacy_format(), 3..=5) {
            let m = MetadataPrePageTexts::deserialize(deserializer)?;
            return Ok(Metadata {
                title: m.title,
                composer: m.composer,
                ..Metadata::default()
            });
        }
        let m = MetadataFields::deserialize(deserializer)?;
        Ok(Metadata {
            title: m.title,
            composer: m.composer,
            subtitle: m.subtitle,
            dedication: m.dedication,
            lyricist: m.lyricist,
            part: m.part,
            copyright: m.copyright,
            header: m.header,
            footer: m.footer,
            page_numbers: m.page_numbers,
        })
    }
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

/// The kinds of text in a score. Each is drawn in its own style (see
/// [`Score::text_styles`]), so changing one changes every text of that kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextKind {
    Title,
    Subtitle,
    Composer,
    Lyricist,
    Dedication,
    Part,
    Copyright,
    Header,
    Footer,
    PageNumber,
    Tempo,
    Expression,
    Technique,
    Rehearsal,
    Lyrics,
    StaffName,
}

/// How a text looks. What is left at its default keeps Partita's look for
/// that kind of text (a bold title, an italic expression…).
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(default)]
pub struct TextStyle {
    /// Font family, or empty for the default.
    pub font: String,
    /// Size in tenths of a point, or 0 for the default.
    pub size: u16,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
}

/// Font sizes accepted, in tenths of a point (4 to 72 pt).
pub const TEXT_SIZE_RANGE: std::ops::RangeInclusive<u16> = 40..=720;

/// How the lines of a text box line up.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

/// A text placed freely on a page. It stays where it was put, whatever the
/// music does.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextBox {
    pub id: u64,
    /// The page, from 0.
    pub page: u32,
    /// Where it is on the page, in tenths of a millimetre from the top left
    /// corner: `x` is where its lines align (left edge, centre or right
    /// edge), `y` the baseline of its first line.
    pub x: i32,
    pub y: i32,
    /// The words; lines are separated by `\n`.
    pub text: String,
    #[serde(default)]
    pub style: TextStyle,
    #[serde(default)]
    pub align: TextAlign,
    /// Drawn with a frame around it.
    #[serde(default)]
    pub frame: bool,
}

/// Longest text box, in characters.
pub const MAX_TEXT_BOX_CHARS: usize = 2000;

/// A complete piece of music.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
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
    /// The styles changed from their default, by kind of text. Since file
    /// format 7 (recovery format 9).
    pub text_styles: std::collections::BTreeMap<TextKind, TextStyle>,
    /// Texts placed freely on the pages. Since file format 7 (recovery
    /// format 9).
    pub text_boxes: Vec<TextBox>,
    /// Lines between notes: octave lines, hairpins, trills, glissandos,
    /// rit. and accel. Since file format 8 (recovery format 16).
    pub lines: Vec<Line>,
}

#[derive(Deserialize)]
struct ScoreFields {
    metadata: Metadata,
    measures: Vec<MeasureAttrs>,
    staves: Vec<Staff>,
    next_id: u64,
    #[serde(default)]
    slurs: Vec<Slur>,
    #[serde(default = "default_tempo")]
    tempo: u16,
    #[serde(default)]
    text_styles: std::collections::BTreeMap<TextKind, TextStyle>,
    #[serde(default)]
    text_boxes: Vec<TextBox>,
    #[serde(default)]
    lines: Vec<Line>,
}

/// [`Score`] as written to recovery data before lines (formats 9 to
/// 15).
#[derive(Deserialize)]
struct ScorePreLines {
    metadata: Metadata,
    measures: Vec<MeasureAttrs>,
    staves: Vec<Staff>,
    next_id: u64,
    slurs: Vec<Slur>,
    tempo: u16,
    text_styles: std::collections::BTreeMap<TextKind, TextStyle>,
    text_boxes: Vec<TextBox>,
}

/// [`Score`] as written to recovery data before text styles and text boxes
/// (formats 3 to 8).
#[derive(Deserialize)]
struct ScorePreStyles {
    metadata: Metadata,
    measures: Vec<MeasureAttrs>,
    staves: Vec<Staff>,
    next_id: u64,
    slurs: Vec<Slur>,
    tempo: u16,
}

impl<'de> Deserialize<'de> for Score {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if matches!(legacy_format(), 3..=8) {
            let s = ScorePreStyles::deserialize(deserializer)?;
            return Ok(Score {
                metadata: s.metadata,
                measures: s.measures,
                staves: s.staves,
                next_id: s.next_id,
                slurs: s.slurs,
                tempo: s.tempo,
                text_styles: Default::default(),
                text_boxes: Vec::new(),
                lines: Vec::new(),
            });
        }
        if matches!(legacy_format(), 9..=15) {
            let s = ScorePreLines::deserialize(deserializer)?;
            return Ok(Score {
                metadata: s.metadata,
                measures: s.measures,
                staves: s.staves,
                next_id: s.next_id,
                slurs: s.slurs,
                tempo: s.tempo,
                text_styles: s.text_styles,
                text_boxes: s.text_boxes,
                lines: Vec::new(),
            });
        }
        let s = ScoreFields::deserialize(deserializer)?;
        Ok(Score {
            metadata: s.metadata,
            measures: s.measures,
            staves: s.staves,
            next_id: s.next_id,
            slurs: s.slurs,
            tempo: s.tempo,
            text_styles: s.text_styles,
            text_boxes: s.text_boxes,
            lines: s.lines,
        })
    }
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

    /// Absolute tick where an event starts (measures one after another, at
    /// their length), for comparing positions across measures and voices.
    pub fn event_start(&self, id: EventId) -> Option<u64> {
        let (s, m, v, i) = self.locate(id)?;
        let before: u64 = self.measures[..m].iter().map(|a| a.capacity() as u64).sum();
        let within: u64 = self.staves[s].measures[m].voices[v][..i]
            .iter()
            .map(|e| e.ticks() as u64)
            .sum();
        Some(before + within)
    }

    /// Absolute tick where an event ends (see [`Score::event_start`]).
    pub fn event_end(&self, id: EventId) -> Option<u64> {
        let (s, m, v, i) = self.locate(id)?;
        let e = &self.staves[s].measures[m].voices[v][i];
        Some(self.event_start(id)? + (e.ticks() as u64).max(1))
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

    /// Playback tempo (quarter notes per minute) in measure `m`: from the
    /// last tempo marking with a metronome value at or before it, or the
    /// opening tempo.
    pub fn tempo_at(&self, m: usize) -> u16 {
        self.measures
            .iter()
            .take(m + 1)
            .skip(1)
            .rev()
            .find_map(|a| a.tempo.as_ref()?.bpm)
            .unwrap_or(self.tempo)
    }

    /// Whether the first measure is a pickup (shorter than its time
    /// signature): then it is not numbered, and the next one is measure 1.
    pub fn has_pickup(&self) -> bool {
        self.measures
            .first()
            .is_some_and(|a| a.capacity() < a.time.measure_ticks())
    }

    /// Whether any note or rest is in a tuplet, is a grace note, has a
    /// tremolo, an ornament or a beam set by hand (which need file format 8).
    pub fn has_rhythm_marks(&self) -> bool {
        self.staves
            .iter()
            .flat_map(|s| s.measures.iter())
            .flat_map(|m| m.voices.iter())
            .flatten()
            .any(|e| {
                e.duration.tuplet.is_some()
                    || e.duration.grace.is_some()
                    || e.duration.tremolo.is_some()
                    || e.beam.is_some()
                    || e.articulations.iter().any(|a| a.is_ornament())
            })
    }

    /// Whether any measure has a tempo marking.
    pub fn has_tempo_marks(&self) -> bool {
        self.measures.iter().any(|a| a.tempo.is_some())
    }

    /// Whether the score has tempo markings, rehearsal marks, texts on
    /// notes, text styles, text boxes, barlines other than single or
    /// repeats (which need file format 7).
    pub fn has_markings(&self) -> bool {
        self.has_tempo_marks()
            || !self.text_styles.is_empty()
            || !self.text_boxes.is_empty()
            || self.measures.iter().any(|a| {
                a.rehearsal.is_some()
                    || a.barline != Barline::Single
                    || a.repeat_start
                    || a.repeat_end.is_some()
                    || !a.ending.is_empty()
                    || a.segno
                    || a.coda
                    || a.jump.is_some()
                    || a.length.is_some()
                    || a.break_after.is_some()
            })
            || self
                .staves
                .iter()
                .flat_map(|s| s.measures.iter())
                .flat_map(|m| m.voices.iter())
                .flatten()
                .any(|e| !e.texts.is_empty())
    }

    /// Empty score: one treble staff with `measures` empty measures in 4/4.
    pub fn new(title: impl Into<String>, measures: usize) -> Self {
        let measures = measures.max(1);
        let mut score = Score {
            metadata: Metadata {
                title: title.into(),
                ..Metadata::default()
            },
            measures: vec![MeasureAttrs::default(); measures],
            staves: Vec::new(),
            next_id: 1,
            slurs: Vec::new(),
            tempo: DEFAULT_TEMPO,
            text_styles: Default::default(),
            text_boxes: Vec::new(),
            lines: Vec::new(),
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
            short_name: String::new(),
            clef,
            instrument: 0,
            transposition: Transposition::NONE,
            group: None,
            measures: vec![StaffMeasure::default(); self.measures.len()],
        }
    }

    /// The key signature a staff shows in a measure: the score's key,
    /// moved for transposing instruments.
    /// The clef in force on a staff at a measure: the last change at or
    /// before it, else the staff's own clef.
    pub fn clef_at(&self, staff: usize, measure: usize) -> Clef {
        let Some(s) = self.staves.get(staff) else {
            return Clef::Treble;
        };
        s.measures
            .iter()
            .take(measure + 1)
            .skip(1)
            .rev()
            .find_map(|m| m.clef)
            .unwrap_or(s.clef)
    }

    /// Whether any staff changes clef after its start (file format 8).
    pub fn has_clef_changes(&self) -> bool {
        self.staves
            .iter()
            .any(|s| s.measures.iter().any(|m| m.clef.is_some()))
    }

    pub fn written_key(&self, staff: usize, measure: usize) -> KeySignature {
        let concert = self
            .measures
            .get(measure)
            .map(|a| a.key)
            .unwrap_or_default();
        self.staves
            .get(staff)
            .map_or(concert, |s| s.transposition.written_key(concert))
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
                let capacity = self.measures[m].capacity();
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
    fn metronome_marks_count_their_beat() {
        assert_eq!(BeatUnit::DottedQuarter.per_minute(90), 60);
        assert_eq!(BeatUnit::DottedQuarter.to_quarter_bpm(60), 90);
        assert_eq!(BeatUnit::Half.per_minute(120), 60);
        assert_eq!(BeatUnit::Eighth.to_quarter_bpm(160), 80);
        assert_eq!(BeatUnit::Quarter.per_minute(76), 76);
    }

    #[test]
    fn tempo_in_force_comes_from_the_last_marking_with_a_value() {
        let mut s = Score::new("t", 4);
        s.tempo = 80;
        s.measures[2].tempo = Some(TempoMark {
            bpm: Some(132),
            ..TempoMark::default()
        });
        s.measures[3].tempo = Some(TempoMark::default()); // words alone
        assert_eq!(
            (0..4).map(|m| s.tempo_at(m)).collect::<Vec<_>>(),
            vec![80, 80, 132, 132]
        );
    }

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
    fn transposing_instruments() {
        let b_flat = Transposition {
            diatonic: -1,
            chromatic: -2,
        };
        let horn = Transposition {
            diatonic: -4,
            chromatic: -7,
        };
        let piccolo = Transposition {
            diatonic: 7,
            chromatic: 12,
        };
        // Concert C major: B-flat instruments read D major, horn G major.
        assert_eq!(b_flat.written_key(KeySignature { fifths: 0 }).fifths, 2);
        assert_eq!(horn.written_key(KeySignature { fifths: 0 }).fifths, 1);
        assert_eq!(piccolo.written_key(KeySignature { fifths: -3 }).fifths, -3);
        // Concert E major (4 sharps) would be F-sharp major: 6 sharps.
        assert_eq!(b_flat.written_key(KeySignature { fifths: 4 }).fifths, 6);
        // Concert B major (5 sharps): C-sharp would be 7, then D-flat (-5).
        assert_eq!(b_flat.written_key(KeySignature { fifths: 6 }).fifths, -4);
        assert_eq!(b_flat.concert_key(KeySignature { fifths: 2 }).fifths, 0);
        // Written D sounds C.
        let d = Pitch::new(Step::D, 5);
        assert_eq!(b_flat.sounding_midi(d), Pitch::new(Step::C, 5).midi());
        // Spelling: E + minor second up = F, C + major second down = B-flat.
        assert_eq!(
            Pitch::new(Step::E, 4).transposed(1, 1),
            Pitch::new(Step::F, 4)
        );
        let bb = Pitch::new(Step::C, 4).transposed(-1, -2);
        assert_eq!((bb.step, bb.alter, bb.octave), (Step::B, -1, 3));
    }

    #[test]
    fn time_signature_capacity() {
        assert_eq!(TimeSignature::COMMON.measure_ticks(), 3840);
        // Respelling keeps the sound: F♯ → G♭ → E𝄪 → F♯, B♯3 is C4.
        let fs = Pitch {
            step: Step::F,
            alter: 1,
            octave: 4,
        };
        let gb = fs.respelled();
        assert_eq!((gb.step, gb.alter, gb.octave), (Step::G, -1, 4));
        let ess = gb.respelled();
        assert_eq!((ess.step, ess.alter), (Step::E, 2));
        assert_eq!(ess.respelled(), fs);
        let c = Pitch::new(Step::C, 4);
        let bs = c.respelled();
        assert_eq!(
            (bs.step, bs.alter, bs.octave, bs.midi()),
            (Step::B, 1, 3, 60)
        );
        // Tuplets: three eighths of a triplet make a quarter.
        let triplet = Tuplet {
            actual: 3,
            normal: 2,
            unit: DurationBase::Eighth,
        };
        assert_eq!(
            Duration::new(DurationBase::Eighth)
                .in_tuplet(triplet)
                .ticks(),
            320
        );
        let quintuplet = Tuplet {
            actual: 5,
            normal: 4,
            unit: DurationBase::Sixteenth,
        };
        assert_eq!(
            Duration::new(DurationBase::Sixteenth)
                .in_tuplet(quintuplet)
                .ticks(),
            192
        );
        // A septuplet does not come out in whole ticks: it is dropped.
        let septuplet = Tuplet {
            actual: 7,
            normal: 4,
            unit: DurationBase::Sixteenth,
        };
        assert!(Duration::new(DurationBase::Sixteenth)
            .in_tuplet(septuplet)
            .exact()
            .tuplet
            .is_none());
        assert!(Duration::new(DurationBase::Eighth)
            .in_tuplet(triplet)
            .exact()
            .tuplet
            .is_some());
        // Grace notes take no time, and are never in a tuplet.
        let grace = Duration::new(DurationBase::Eighth).as_grace(Grace::Acciaccatura);
        assert_eq!(grace.ticks(), 0);
        assert_eq!(grace.notated_ticks(), 480);
        assert!(grace.in_tuplet(triplet).exact().tuplet.is_none());
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
