//! MusicXML import and export, so scores can travel to and from other
//! notation programs (Finale, Sibelius, Dorico, MuseScore, Encore...).
//!
//! Export writes uncompressed `score-partwise` MusicXML 4.0, one part per
//! staff. Import reads `.musicxml` / `.xml` and compressed `.mxl` files.
//! A part with several staves (a piano) becomes several staves. What the
//! model cannot hold yet is simplified, and [`Import::notes`] says what:
//! tuplets keep their written value, grace notes are left out, voices
//! beyond four per staff are dropped, and only the first clef of a staff
//! is kept.

use std::collections::HashMap;
use std::fmt;
use std::fmt::Write as _;
use std::io::Read;
use std::path::Path;

use serde::Serialize;
use thiserror::Error;

use crate::model::*;

#[derive(Debug, Error)]
pub enum MusicXmlError {
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("not a valid MusicXML file: {0}")]
    Xml(String),
    #[error("not a MusicXML score")]
    NotAScore,
    #[error(
        "this MusicXML file is organized by time (score-timewise), which is not supported yet"
    )]
    Timewise,
    #[error("could not read the compressed MusicXML file: {0}")]
    Archive(String),
}

// ---------------------------------------------------------------- export

const BEAT_UNITS: [(BeatUnit, &str, bool); 5] = [
    (BeatUnit::Eighth, "eighth", false),
    (BeatUnit::Quarter, "quarter", false),
    (BeatUnit::DottedQuarter, "quarter", true),
    (BeatUnit::Half, "half", false),
    (BeatUnit::DottedHalf, "half", true),
];

/// The `<direction>` for the tempo at the start of measure `m`: its words
/// and metronome mark (hidden ones with `print-object="no"`) and the
/// playback tempo. The first measure always has one, for the opening tempo.
fn tempo_direction(score: &Score, m: usize) -> Option<String> {
    let mark = score.measures[m].tempo.as_ref();
    let bpm = if m == 0 {
        Some(score.tempo)
    } else {
        mark.and_then(|t| t.bpm)
    };
    if mark.is_none() && m > 0 {
        return None;
    }
    let hidden = |shown: bool| if shown { "" } else { " print-object=\"no\"" };
    let mut x = String::from("      <direction placement=\"above\">");
    if let Some(t) = mark.filter(|t| !t.text.is_empty()) {
        let _ = write!(
            x,
            "<direction-type><words font-weight=\"bold\"{}>{}</words></direction-type>",
            hidden(t.show_text),
            esc(&t.text)
        );
    }
    if let Some(bpm) = bpm {
        // Without a marking (older scores), the opening tempo plays but is not printed.
        let (beat, shown) = mark.map_or((BeatUnit::Quarter, false), |t| (t.beat, t.show_metronome));
        let (_, unit, dot) = BEAT_UNITS
            .iter()
            .find(|(b, _, _)| *b == beat)
            .copied()
            .unwrap_or(BEAT_UNITS[1]);
        let _ = write!(
            x,
            "<direction-type><metronome{}><beat-unit>{unit}</beat-unit>{}<per-minute>{}</per-minute></metronome></direction-type><sound tempo=\"{bpm}\"/>",
            hidden(shown),
            if dot { "<beat-unit-dot/>" } else { "" },
            beat.per_minute(bpm)
        );
    }
    x.push_str("</direction>\n");
    Some(x)
}

/// Writes `score` as MusicXML text.
pub fn export(score: &Score) -> String {
    let divisions = divisions_for(score);
    let to_div = |ticks: u32| ticks / (TICKS_PER_QUARTER / divisions);
    let mut x = String::new();
    x.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n");
    x.push_str("<!DOCTYPE score-partwise PUBLIC \"-//Recordare//DTD MusicXML 4.0 Partwise//EN\" \"http://www.musicxml.org/dtds/partwise.dtd\">\n");
    x.push_str("<score-partwise version=\"4.0\">\n");
    if !score.metadata.title.is_empty() {
        let _ = writeln!(
            x,
            "  <work><work-title>{}</work-title></work>",
            esc(&score.metadata.title)
        );
    }
    x.push_str("  <identification>\n");
    if !score.metadata.composer.is_empty() {
        let _ = writeln!(
            x,
            "    <creator type=\"composer\">{}</creator>",
            esc(&score.metadata.composer)
        );
    }
    if !score.metadata.lyricist.is_empty() {
        let _ = writeln!(
            x,
            "    <creator type=\"lyricist\">{}</creator>",
            esc(&score.metadata.lyricist)
        );
    }
    if !score.metadata.copyright.is_empty() {
        let _ = writeln!(x, "    <rights>{}</rights>", esc(&score.metadata.copyright));
    }
    let _ = writeln!(
        x,
        "    <encoding><software>Partita {}</software><supports element=\"accidental\" type=\"no\"/></encoding>",
        env!("CARGO_PKG_VERSION")
    );
    x.push_str("  </identification>\n");
    // Texts of page 1 that MusicXML names; the header, footer and page
    // numbers have no equivalent and stay in .partita files.
    for (kind, text) in [
        ("subtitle", &score.metadata.subtitle),
        ("part name", &score.metadata.part),
    ] {
        if !text.is_empty() {
            let _ = writeln!(
                x,
                "  <credit page=\"1\"><credit-type>{kind}</credit-type><credit-words>{}</credit-words></credit>",
                esc(text)
            );
        }
    }
    x.push_str("  <part-list>\n");
    let mut group_number = 0;
    for (s, staff) in score.staves.iter().enumerate() {
        let group = staff.group;
        let starts = group.is_some() && (s == 0 || score.staves[s - 1].group != group);
        let ends = group.is_some() && score.staves.get(s + 1).map(|n| n.group) != Some(group);
        let alone = starts && ends; // a group of one staff is no group
        if starts && !alone {
            group_number += 1;
            let symbol = match group.map(|g| g.kind) {
                Some(GroupKind::Brace) => "brace",
                _ => "bracket",
            };
            let _ = writeln!(
                x,
                "    <part-group type=\"start\" number=\"{group_number}\"><group-symbol>{symbol}</group-symbol><group-barline>yes</group-barline></part-group>"
            );
        }
        let _ = writeln!(x, "    <score-part id=\"P{}\">", s + 1);
        let _ = writeln!(x, "      <part-name>{}</part-name>", esc(&staff.name));
        if !staff.short_name.is_empty() {
            let _ = writeln!(
                x,
                "      <part-abbreviation>{}</part-abbreviation>",
                esc(&staff.short_name)
            );
        }
        let _ = writeln!(x, "      <score-instrument id=\"P{}-I1\"><instrument-name>{}</instrument-name></score-instrument>", s + 1, esc(&staff.name));
        let _ = writeln!(
            x,
            "      <midi-instrument id=\"P{}-I1\"><midi-channel>{}</midi-channel><midi-program>{}</midi-program></midi-instrument>",
            s + 1,
            midi_channel(s),
            staff.instrument as u16 + 1
        );
        x.push_str("    </score-part>\n");
        if ends && !alone {
            let _ = writeln!(
                x,
                "    <part-group type=\"stop\" number=\"{group_number}\"/>"
            );
        }
    }
    x.push_str("  </part-list>\n");

    // Slur numbers: a slur keeps its number from start to end.
    let mut slur_marks: HashMap<EventId, Vec<(&'static str, usize)>> = HashMap::new();
    for (i, slur) in score.slurs.iter().enumerate() {
        let n = i % 16 + 1;
        slur_marks.entry(slur.start).or_default().push(("start", n));
        slur_marks.entry(slur.end).or_default().push(("stop", n));
    }

    for (s, staff) in score.staves.iter().enumerate() {
        let _ = writeln!(x, "  <part id=\"P{}\">", s + 1);
        // Last event of each voice in the previous measure, for tie stops.
        let mut prev_in_voice: [Option<&Event>; MAX_VOICES] = [None; MAX_VOICES];
        // Whether the last syllable of each voice and verse asked for a hyphen.
        let mut hyphen_open = [[false; MAX_VERSES]; MAX_VOICES];
        for (m, cell) in staff.measures.iter().enumerate() {
            let attrs = &score.measures[m];
            let capacity = attrs.time.measure_ticks();
            let _ = writeln!(x, "    <measure number=\"{}\">", m + 1);
            if attrs.repeat_start {
                x.push_str("      <barline location=\"left\"><bar-style>heavy-light</bar-style><repeat direction=\"forward\"/></barline>\n");
            }
            let prev_attrs = m.checked_sub(1).map(|p| &score.measures[p]);
            // Transposing staves show their written key.
            let key = score.written_key(s, m);
            let prev_key = m.checked_sub(1).map(|p| score.written_key(s, p));
            if m == 0 || prev_key != Some(key) || prev_attrs.map(|p| p.time) != Some(attrs.time) {
                x.push_str("      <attributes>\n");
                if m == 0 {
                    let _ = writeln!(x, "        <divisions>{divisions}</divisions>");
                }
                if m == 0 || prev_key != Some(key) {
                    let _ = writeln!(x, "        <key><fifths>{}</fifths></key>", key.fifths);
                }
                if m == 0 || prev_attrs.map(|p| p.time) != Some(attrs.time) {
                    let _ = writeln!(
                        x,
                        "        <time><beats>{}</beats><beat-type>{}</beat-type></time>",
                        attrs.time.beats, attrs.time.beat_type
                    );
                }
                if m == 0 {
                    let (sign, line) = clef_sign(staff.clef);
                    let _ = writeln!(
                        x,
                        "        <clef><sign>{sign}</sign><line>{line}</line></clef>"
                    );
                    if !staff.transposition.is_none() {
                        let t = staff.transposition;
                        // MusicXML splits off whole octaves.
                        let octaves = t.diatonic.div_euclid(7) as i32;
                        let octaves = if t.diatonic < 0 && t.diatonic % 7 != 0 {
                            octaves + 1
                        } else {
                            octaves
                        };
                        let _ = writeln!(
                            x,
                            "        <transpose><diatonic>{}</diatonic><chromatic>{}</chromatic>{}</transpose>",
                            t.diatonic as i32 - 7 * octaves,
                            t.chromatic as i32 - 12 * octaves,
                            if octaves != 0 { format!("<octave-change>{octaves}</octave-change>") } else { String::new() }
                        );
                    }
                }
                x.push_str("      </attributes>\n");
            }
            if s == 0 {
                if let Some(mark) = &score.measures[m].rehearsal {
                    let _ = writeln!(
                        x,
                        "      <direction placement=\"above\"><direction-type><rehearsal>{}</rehearsal></direction-type></direction>",
                        esc(mark)
                    );
                }
                if let Some(direction) = tempo_direction(score, m) {
                    x.push_str(&direction);
                }
            }

            // Voices one after another, rewinding with <backup> in between.
            let voices: Vec<usize> = (0..MAX_VOICES)
                .filter(|&v| v == 0 || !cell.voices[v].is_empty())
                .collect();
            for (k, &v) in voices.iter().enumerate() {
                let events = &cell.voices[v];
                let mut written = 0u32;
                if events.is_empty() {
                    // An empty first voice is a whole-measure rest.
                    let _ = writeln!(
                        x,
                        "      <note><rest measure=\"yes\"/><duration>{}</duration><voice>{}</voice></note>",
                        to_div(capacity),
                        v + 1
                    );
                    written = capacity;
                } else if is_measure_rest(events, capacity) {
                    let _ = writeln!(
                        x,
                        "      <note><rest measure=\"yes\"/><duration>{}</duration><voice>{}</voice></note>",
                        to_div(capacity),
                        v + 1
                    );
                    written = capacity;
                    prev_in_voice[v] = events.last();
                } else {
                    for e in events {
                        for nt in &e.texts {
                            let (placement, style) = match nt.kind {
                                NoteTextKind::Expression => ("below", " font-style=\"italic\""),
                                NoteTextKind::Technique => ("above", ""),
                            };
                            let _ = writeln!(
                                x,
                                "      <direction placement=\"{placement}\"><direction-type><words{style}>{}</words></direction-type><voice>{}</voice></direction>",
                                esc(&nt.text),
                                v + 1
                            );
                        }
                        if let Some(d) = e.dynamic {
                            let _ = writeln!(
                                x,
                                "      <direction placement=\"below\"><direction-type><dynamics><{}/></dynamics></direction-type><voice>{}</voice></direction>",
                                dynamic_name(d),
                                v + 1
                            );
                        }
                        write_event(
                            &mut x,
                            e,
                            v,
                            to_div(e.ticks()),
                            prev_in_voice[v],
                            slur_marks.get(&e.id).map(Vec::as_slice).unwrap_or(&[]),
                            &mut hyphen_open[v],
                        );
                        written += e.ticks();
                        prev_in_voice[v] = Some(e);
                    }
                }
                if k + 1 < voices.len() && written > 0 {
                    let _ = writeln!(
                        x,
                        "      <backup><duration>{}</duration></backup>",
                        to_div(written)
                    );
                }
            }
            // The measure's barline; the last measure ends with a final one
            // unless it says otherwise.
            let last = m + 1 == staff.measures.len();
            if let Some(times) = score.measures[m].repeat_end {
                let times = if times == 2 {
                    String::new()
                } else {
                    format!(" times=\"{times}\"")
                };
                let _ = writeln!(
                    x,
                    "      <barline location=\"right\"><bar-style>light-heavy</bar-style><repeat direction=\"backward\"{times}/></barline>"
                );
            }
            let style = match score.measures[m].barline {
                _ if score.measures[m].repeat_end.is_some() => None,
                Barline::Single if last => Some("light-heavy"),
                Barline::Single => None,
                Barline::Double => Some("light-light"),
                Barline::Final => Some("light-heavy"),
                Barline::Dashed => Some("dashed"),
            };
            if let Some(style) = style {
                let _ = writeln!(
                    x,
                    "      <barline location=\"right\"><bar-style>{style}</bar-style></barline>"
                );
            }
            x.push_str("    </measure>\n");
        }
        x.push_str("  </part>\n");
    }
    x.push_str("</score-partwise>\n");
    x
}

/// Saves `score` as a MusicXML file (written atomically, like scores).
pub fn export_to(path: &Path, score: &Score) -> std::io::Result<()> {
    crate::file::atomic_write(path, export(score).as_bytes())
}

fn write_event(
    x: &mut String,
    e: &Event,
    v: usize,
    duration: u32,
    prev: Option<&Event>,
    slurs: &[(&'static str, usize)],
    hyphen_open: &mut [bool; MAX_VERSES],
) {
    let pitches: Vec<Option<Pitch>> = match &e.kind {
        EventKind::Rest => vec![None],
        EventKind::Chord { pitches } if pitches.is_empty() => vec![None],
        EventKind::Chord { pitches } => pitches.iter().copied().map(Some).collect(),
    };
    for (i, p) in pitches.iter().enumerate() {
        x.push_str("      <note>");
        if i > 0 {
            x.push_str("<chord/>");
        }
        match p {
            None => x.push_str("<rest/>"),
            Some(p) => {
                let _ = write!(x, "<pitch><step>{:?}</step>", p.step);
                if p.alter != 0 {
                    let _ = write!(x, "<alter>{}</alter>", p.alter);
                }
                let _ = write!(x, "<octave>{}</octave></pitch>", p.octave);
            }
        }
        let _ = write!(x, "<duration>{duration}</duration>");
        let tie_stop = p.is_some_and(|p| {
            prev.is_some_and(|q| q.tie && q.pitches().iter().any(|o| o.midi() == p.midi()))
        });
        let tie_start = p.is_some() && e.tie;
        if tie_stop {
            x.push_str("<tie type=\"stop\"/>");
        }
        if tie_start {
            x.push_str("<tie type=\"start\"/>");
        }
        let _ = write!(
            x,
            "<voice>{}</voice><type>{}</type>",
            v + 1,
            type_name(e.duration.base)
        );
        for _ in 0..e.duration.dots {
            x.push_str("<dot/>");
        }

        let mut notations = String::new();
        if tie_stop {
            notations.push_str("<tied type=\"stop\"/>");
        }
        if tie_start {
            notations.push_str("<tied type=\"start\"/>");
        }
        if i == 0 {
            for (kind, n) in slurs {
                let _ = write!(notations, "<slur type=\"{kind}\" number=\"{n}\"/>");
            }
            let marks: String = e
                .articulations
                .iter()
                .filter_map(|a| articulation_name(*a))
                .map(|n| format!("<{n}/>"))
                .collect();
            if !marks.is_empty() {
                let _ = write!(notations, "<articulations>{marks}</articulations>");
            }
            if e.articulations.contains(&Articulation::Fermata) {
                notations.push_str("<fermata type=\"upright\"/>");
            }
        }
        if !notations.is_empty() {
            let _ = write!(x, "<notations>{notations}</notations>");
        }

        if i == 0 {
            for (verse, syl) in e.lyrics.iter().enumerate().take(MAX_VERSES) {
                if syl.is_empty() {
                    continue;
                }
                let open = hyphen_open[verse];
                let joins = syl.join == LyricJoin::Hyphen;
                let syllabic = match (open, joins) {
                    (false, false) => "single",
                    (false, true) => "begin",
                    (true, true) => "middle",
                    (true, false) => "end",
                };
                hyphen_open[verse] = joins;
                let _ =
                    write!(
                    x,
                    "<lyric number=\"{}\"><syllabic>{syllabic}</syllabic><text>{}</text>{}</lyric>",
                    verse + 1,
                    esc(&syl.text),
                    if syl.join == LyricJoin::Extender { "<extend/>" } else { "" }
                );
            }
        }
        x.push_str("</note>\n");
    }
}

/// Divisions per quarter note: as coarse as every duration allows.
fn divisions_for(score: &Score) -> u32 {
    let mut g = TICKS_PER_QUARTER;
    let mut add = |t: u32| g = gcd(g, t);
    for staff in &score.staves {
        for (m, cell) in staff.measures.iter().enumerate() {
            add(score.measures[m].time.measure_ticks());
            for e in cell.voices.iter().flatten() {
                add(e.ticks());
            }
        }
    }
    TICKS_PER_QUARTER / g.max(1)
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

/// MIDI channels 1-16 without 10, which is for percussion.
fn midi_channel(staff: usize) -> usize {
    let c = staff % 15 + 1;
    if c >= 10 {
        c + 1
    } else {
        c
    }
}

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

fn clef_sign(clef: Clef) -> (&'static str, u8) {
    match clef {
        Clef::Treble => ("G", 2),
        Clef::Bass => ("F", 4),
        Clef::Alto => ("C", 3),
        Clef::Tenor => ("C", 4),
    }
}

const TYPES: [(DurationBase, &str); 9] = [
    (DurationBase::Breve, "breve"),
    (DurationBase::Whole, "whole"),
    (DurationBase::Half, "half"),
    (DurationBase::Quarter, "quarter"),
    (DurationBase::Eighth, "eighth"),
    (DurationBase::Sixteenth, "16th"),
    (DurationBase::ThirtySecond, "32nd"),
    (DurationBase::SixtyFourth, "64th"),
    (DurationBase::HundredTwentyEighth, "128th"),
];

fn type_name(base: DurationBase) -> &'static str {
    TYPES
        .iter()
        .find(|(b, _)| *b == base)
        .map(|(_, n)| *n)
        .unwrap_or("quarter")
}

fn articulation_name(a: Articulation) -> Option<&'static str> {
    match a {
        Articulation::Staccato => Some("staccato"),
        Articulation::Staccatissimo => Some("staccatissimo"),
        Articulation::Accent => Some("accent"),
        Articulation::Tenuto => Some("tenuto"),
        Articulation::Marcato => Some("strong-accent"),
        Articulation::Fermata => None, // a notation of its own
    }
}

const DYNAMICS: [(Dynamic, &str); 10] = [
    (Dynamic::Ppp, "ppp"),
    (Dynamic::Pp, "pp"),
    (Dynamic::P, "p"),
    (Dynamic::Mp, "mp"),
    (Dynamic::Mf, "mf"),
    (Dynamic::F, "f"),
    (Dynamic::Ff, "ff"),
    (Dynamic::Fff, "fff"),
    (Dynamic::Sfz, "sfz"),
    (Dynamic::Fp, "fp"),
];

fn dynamic_name(d: Dynamic) -> &'static str {
    DYNAMICS
        .iter()
        .find(|(x, _)| *x == d)
        .map(|(_, n)| *n)
        .unwrap_or("mf")
}

// ---------------------------------------------------------------- import

/// A score read from MusicXML, with notes on what had to be simplified.
#[derive(Debug)]
pub struct Import {
    pub score: Score,
    /// What had to be simplified, for the user to read. Empty when nothing
    /// was lost.
    pub notes: Vec<ImportNote>,
    /// Staves the file gave no name, called "Staff 1", "Staff 2"… here;
    /// the app may rename them in the user's language.
    pub unnamed_staves: Vec<usize>,
}

/// Something an import simplified, `count` times. The app words it in the
/// user's language from `kind`; `Display` gives the English text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ImportNote {
    pub kind: ImportNoteKind,
    pub count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportNoteKind {
    /// Tuplet notes kept their written values.
    Tuplets,
    /// Grace notes were left out.
    GraceNotes,
    /// Notes beyond the fourth voice of a staff were left out.
    ExtraVoices,
    /// Clef changes after the first clef were left out.
    ClefChanges,
    /// Notes overlapping the previous one were moved after it.
    Overlaps,
}

impl fmt::Display for ImportNote {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let n = self.count;
        let plural = |one: &str, many: &str| {
            if n == 1 {
                one.to_string()
            } else {
                format!("{n} {many}")
            }
        };
        match self.kind {
            ImportNoteKind::Tuplets => write!(
                f,
                "{} kept their written values, because tuplets are not supported yet. Those measures may show as too full.",
                plural("One tuplet note", "tuplet notes")
            ),
            ImportNoteKind::GraceNotes => write!(
                f,
                "{} left out (not supported yet).",
                plural("One grace note was", "grace notes were")
            ),
            ImportNoteKind::ExtraVoices => write!(
                f,
                "{} beyond the fourth voice of a staff left out.",
                plural("One note was", "notes were")
            ),
            ImportNoteKind::ClefChanges => write!(
                f,
                "Staves kept the clef they start with; {} left out.",
                plural("one clef change was", "clef changes were")
            ),
            ImportNoteKind::Overlaps => write!(
                f,
                "{} overlapped the previous note in their voice and were placed right after it.",
                plural("One note", "notes")
            ),
        }
    }
}

/// Reads a `.musicxml`, `.xml` or `.mxl` file.
pub fn import_file(path: &Path) -> Result<Import, MusicXmlError> {
    let bytes = std::fs::read(path)?;
    let fallback_title = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let text = if bytes.starts_with(b"PK") {
        unzip_score(&bytes)?
    } else {
        decode_text(&bytes)
    };
    import(&text, &fallback_title)
}

/// Whether `path` looks like a MusicXML file, judging by its extension.
pub fn is_musicxml_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("musicxml" | "mxl" | "xml")
    )
}

fn decode_text(bytes: &[u8]) -> String {
    let utf16 = |be: bool| {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| {
                if be {
                    u16::from_be_bytes([c[0], c[1]])
                } else {
                    u16::from_le_bytes([c[0], c[1]])
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    };
    match bytes {
        [0xFF, 0xFE, ..] => utf16(false),
        [0xFE, 0xFF, ..] => utf16(true),
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// The score inside an `.mxl` archive: the root file named by
/// META-INF/container.xml, or else the first MusicXML file in it.
fn unzip_score(bytes: &[u8]) -> Result<String, MusicXmlError> {
    let archive_err = |e: zip::result::ZipError| MusicXmlError::Archive(e.to_string());
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(archive_err)?;
    let mut read = |name: &str| -> Result<Vec<u8>, MusicXmlError> {
        let mut f = zip.by_name(name).map_err(archive_err)?;
        let mut out = Vec::new();
        f.read_to_end(&mut out)?;
        Ok(out)
    };
    let root = read("META-INF/container.xml").ok().and_then(|c| {
        let text = decode_text(&c);
        let doc = roxmltree::Document::parse(&text).ok()?;
        doc.descendants()
            .find(|n| n.has_tag_name("rootfile"))
            .and_then(|n| n.attribute("full-path"))
            .map(str::to_string)
    });
    let name = match root {
        Some(r) => r,
        None => (0..zip.len())
            .filter_map(|i| {
                zip.name_for_index(i)
                    .and_then(Result::ok)
                    .map(|n| n.into_owned())
            })
            .find(|n| {
                !n.starts_with("META-INF") && (n.ends_with(".xml") || n.ends_with(".musicxml"))
            })
            .ok_or(MusicXmlError::NotAScore)?,
    };
    let mut f = zip.by_name(&name).map_err(archive_err)?;
    let mut out = Vec::new();
    f.read_to_end(&mut out)?;
    Ok(decode_text(&out))
}

/// Reads MusicXML text. `fallback_title` is used when the file has none.
pub fn import(text: &str, fallback_title: &str) -> Result<Import, MusicXmlError> {
    let options = roxmltree::ParsingOptions {
        allow_dtd: true,
        ..Default::default()
    };
    let doc = roxmltree::Document::parse_with_options(text, options)
        .map_err(|e| MusicXmlError::Xml(e.to_string()))?;
    let root = doc.root_element();
    match root.tag_name().name() {
        "score-partwise" => {}
        "score-timewise" => return Err(MusicXmlError::Timewise),
        _ => return Err(MusicXmlError::NotAScore),
    }
    Importer::default().run(root, fallback_title)
}

/// A direction's metronome mark: its beat unit (if Partita has it), the
/// number per minute, and whether it is printed.
fn metronome_of(direction: roxmltree::Node) -> Option<(Option<BeatUnit>, Option<u16>, bool)> {
    let mt = direction
        .descendants()
        .find(|n| n.has_tag_name("metronome"))?;
    let unit = text_of(mt, "beat-unit");
    let dot = child(mt, "beat-unit-dot").is_some();
    let beat = BEAT_UNITS
        .iter()
        .find(|(_, u, d)| unit.as_deref() == Some(*u) && *d == dot)
        .map(|(b, _, _)| *b);
    let per_minute = text_of(mt, "per-minute")
        .and_then(|t| t.parse::<f64>().ok())
        .map(|n| n.round() as u16);
    Some((beat, per_minute, mt.attribute("print-object") != Some("no")))
}

/// A tempo marking from a `<direction>` with a metronome mark or a playback
/// tempo (words alone are not tempo markings). In the first measure the
/// value is the opening tempo, so a direction there with nothing printed
/// adds no marking.
fn tempo_mark_of(direction: roxmltree::Node, m: usize, bpm: Option<u16>) -> Option<TempoMark> {
    let printed = |n: roxmltree::Node| n.attribute("print-object") != Some("no");
    let bpm = bpm?;
    let metronome = direction
        .descendants()
        .find(|n| n.has_tag_name("metronome"));
    let beat = metronome_of(direction).and_then(|(b, _, _)| b);
    let words: Vec<roxmltree::Node> = direction
        .descendants()
        .filter(|n| n.has_tag_name("words"))
        .collect();
    let text = words
        .iter()
        .filter_map(|w| w.text())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let mark = TempoMark {
        show_text: words.iter().any(|w| printed(*w)),
        show_metronome: metronome.is_some_and(printed) && beat.is_some(),
        text,
        bpm: (m > 0).then_some(bpm.clamp(*TEMPO_RANGE.start(), *TEMPO_RANGE.end())),
        beat: beat.unwrap_or_default(),
    };
    let printed_anything = (mark.show_text && !mark.text.is_empty()) || mark.show_metronome;
    (m > 0 || printed_anything).then_some(mark)
}

fn child<'a, 'i>(n: roxmltree::Node<'a, 'i>, name: &str) -> Option<roxmltree::Node<'a, 'i>> {
    n.children().find(|c| c.has_tag_name(name))
}

fn children<'a, 'i>(
    n: roxmltree::Node<'a, 'i>,
    name: &'a str,
) -> impl Iterator<Item = roxmltree::Node<'a, 'i>> + 'a
where
    'i: 'a,
{
    n.children().filter(move |c| c.has_tag_name(name))
}

fn text_of(n: roxmltree::Node, name: &str) -> Option<String> {
    child(n, name)
        .and_then(|c| c.text())
        .map(|t| t.trim().to_string())
}

fn number_of(n: roxmltree::Node, name: &str) -> Option<f64> {
    text_of(n, name).and_then(|t| t.parse().ok())
}

/// What the part list says about a part.
#[derive(Clone, Default)]
struct PartInfo {
    name: String,
    short_name: String,
    program: u8,
    group: Option<StaffGroup>,
}

/// Where a part's staff ended up in the score.
#[derive(Default)]
struct StaffSlot {
    index: usize,
    clef_set: bool,
    /// MusicXML voice names in order of appearance → voice 0-3.
    voices: Vec<String>,
}

#[derive(Default)]
struct Importer {
    score_staves: Vec<Staff>,
    measures: Vec<Option<MeasureAttrs>>,
    slurs: Vec<Slur>,
    tempo: Option<u16>,
    next_id: u64,
    tuplets: usize,
    grace: usize,
    dropped_voices: usize,
    extra_clefs: usize,
    overlaps: usize,
    /// Staves named "Staff N" because the file gave them no name.
    unnamed: Vec<usize>,
    /// Tempo markings by measure, from the first part's directions.
    tempo_marks: HashMap<usize, TempoMark>,
    /// Rehearsal marks by measure, from the first part.
    rehearsals: HashMap<usize, String>,
    /// Barlines other than single at the end of measures, from the first part.
    barlines: HashMap<usize, Barline>,
    /// Measures where a repeat starts, and those where one ends (with the
    /// times it is played), from the first part.
    repeat_starts: std::collections::HashSet<usize>,
    repeat_ends: HashMap<usize, u8>,
}

impl Importer {
    fn alloc(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn run(mut self, root: roxmltree::Node, fallback_title: &str) -> Result<Import, MusicXmlError> {
        let title = child(root, "work")
            .and_then(|w| text_of(w, "work-title"))
            .or_else(|| text_of(root, "movement-title"))
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| fallback_title.to_string());
        let composer = child(root, "identification")
            .and_then(|i| {
                children(i, "creator")
                    .find(|c| c.attribute("type") == Some("composer"))
                    .and_then(|c| c.text())
                    .map(|t| t.trim().to_string())
            })
            .unwrap_or_default();
        let creator = |kind: &str| {
            child(root, "identification").and_then(|i| {
                children(i, "creator")
                    .find(|c| c.attribute("type") == Some(kind))
                    .and_then(|c| c.text())
                    .map(|t| t.trim().to_string())
            })
        };
        let lyricist = creator("lyricist")
            .or_else(|| creator("arranger"))
            .unwrap_or_default();
        let copyright = child(root, "identification")
            .and_then(|i| text_of(i, "rights"))
            .unwrap_or_default();
        // Page 1 texts by their credit type; a movement title next to a
        // work title is a subtitle ("II. Andante").
        let credit = |kind: &str| {
            children(root, "credit")
                .find(|c| {
                    children(*c, "credit-type").any(|t| t.text().map(str::trim) == Some(kind))
                })
                .map(|c| {
                    children(c, "credit-words")
                        .filter_map(|w| w.text())
                        .collect::<Vec<_>>()
                        .join(" ")
                        .trim()
                        .to_string()
                })
                .filter(|t| !t.is_empty())
        };
        let movement = text_of(root, "movement-title").filter(|m| !m.is_empty() && *m != title);
        let subtitle = credit("subtitle")
            .or(if child(root, "work").is_some() {
                movement
            } else {
                None
            })
            .unwrap_or_default();
        let part = credit("part name").unwrap_or_default();

        // Part names, abbreviations, instruments and groups from the part
        // list. A part keeps the innermost bracket or brace around it.
        let mut part_info: HashMap<String, PartInfo> = HashMap::new();
        let mut open_groups: Vec<(String, Option<GroupKind>, u64)> = Vec::new();
        if let Some(list) = child(root, "part-list") {
            for el in list.children().filter(|c| c.is_element()) {
                if el.has_tag_name("part-group") {
                    let number = el.attribute("number").unwrap_or("1").to_string();
                    match el.attribute("type") {
                        Some("start") => {
                            let kind = match text_of(el, "group-symbol").as_deref() {
                                Some("brace") => Some(GroupKind::Brace),
                                Some("bracket" | "square") => Some(GroupKind::Bracket),
                                _ => None,
                            };
                            let id = self.alloc();
                            open_groups.push((number, kind, id));
                        }
                        Some("stop") => {
                            if let Some(i) = open_groups.iter().rposition(|g| g.0 == number) {
                                open_groups.remove(i);
                            }
                        }
                        _ => {}
                    }
                    continue;
                }
                if !el.has_tag_name("score-part") {
                    continue;
                }
                let sp = el;
                let id = sp.attribute("id").unwrap_or_default().to_string();
                let name = text_of(sp, "part-name").unwrap_or_default();
                let short_name = text_of(sp, "part-abbreviation").unwrap_or_default();
                let group = open_groups
                    .iter()
                    .rev()
                    .find_map(|(_, kind, id)| kind.map(|kind| StaffGroup { id: *id, kind }));
                let program = sp
                    .descendants()
                    .find(|n| n.has_tag_name("midi-program"))
                    .and_then(|n| n.text())
                    .and_then(|t| t.trim().parse::<u16>().ok())
                    .map(|p| p.clamp(1, 128) as u8 - 1)
                    .unwrap_or(0);
                part_info.insert(
                    id,
                    PartInfo {
                        name,
                        short_name,
                        program,
                        group,
                    },
                );
            }
        }

        let parts: Vec<_> = children(root, "part").collect();
        if parts.is_empty() {
            return Err(MusicXmlError::NotAScore);
        }
        for (p, part) in parts.iter().enumerate() {
            let info = part
                .attribute("id")
                .and_then(|id| part_info.get(id).cloned())
                .unwrap_or_default();
            self.read_part(*part, p == 0, &info);
        }
        // A group of one staff is no group.
        let n = self.score_staves.len();
        for s in 0..n {
            let g = self.score_staves[s].group;
            let joined = g.is_some()
                && ((s > 0 && self.score_staves[s - 1].group == g)
                    || (s + 1 < n && self.score_staves[s + 1].group == g));
            if !joined {
                self.score_staves[s].group = None;
            }
        }

        // Assemble: every staff gets the same number of measures.
        let count = self
            .score_staves
            .iter()
            .map(|s| s.measures.len())
            .chain(std::iter::once(self.measures.len()))
            .max()
            .unwrap_or(1)
            .max(1);
        let mut attrs = Vec::with_capacity(count);
        let mut last = MeasureAttrs::default();
        for m in 0..count {
            if let Some(Some(a)) = self.measures.get(m) {
                last = a.clone();
            }
            attrs.push(MeasureAttrs {
                tempo: self.tempo_marks.remove(&m),
                rehearsal: self.rehearsals.remove(&m),
                // A barline belongs to its measure: it is not carried on.
                barline: self.barlines.remove(&m).unwrap_or_default(),
                repeat_start: self.repeat_starts.remove(&m),
                repeat_end: self.repeat_ends.remove(&m),
                ..last.clone()
            });
        }
        // The last measure is drawn with a final barline anyway: one written
        // there is the usual ending, not a choice to keep.
        if let Some(end) = attrs.last_mut() {
            if end.barline == Barline::Final {
                end.barline = Barline::Single;
            }
        }
        for staff in &mut self.score_staves {
            staff.measures.resize_with(count, StaffMeasure::default);
        }

        let notes: Vec<ImportNote> = [
            (ImportNoteKind::Tuplets, self.tuplets),
            (ImportNoteKind::GraceNotes, self.grace),
            (ImportNoteKind::ExtraVoices, self.dropped_voices),
            (ImportNoteKind::ClefChanges, self.extra_clefs),
            (ImportNoteKind::Overlaps, self.overlaps),
        ]
        .into_iter()
        .filter(|&(_, count)| count > 0)
        .map(|(kind, count)| ImportNote { kind, count })
        .collect();

        let mut score = Score {
            metadata: Metadata {
                title,
                composer,
                subtitle,
                lyricist,
                part,
                copyright,
                ..Metadata::default()
            },
            measures: attrs,
            staves: self.score_staves,
            next_id: self.next_id + 1,
            slurs: self.slurs,
            tempo: self
                .tempo
                .map(|t| t.clamp(*TEMPO_RANGE.start(), *TEMPO_RANGE.end()))
                .unwrap_or(DEFAULT_TEMPO),
            text_styles: Default::default(),
            text_boxes: Vec::new(),
        };
        let mut unnamed_staves = self.unnamed;
        if score.staves.is_empty() {
            let staff = score.blank_staff("Staff 1", Clef::Treble);
            score.staves.push(staff);
            unnamed_staves = vec![0];
        }
        Ok(Import {
            score,
            notes,
            unnamed_staves,
        })
    }

    fn read_part(&mut self, part: roxmltree::Node, first_part: bool, info: &PartInfo) {
        let name = info.name.as_str();
        // One instrument on several staves (a piano) is braced, unless the
        // part list says otherwise.
        let staves_here = part
            .descendants()
            .find(|n| n.has_tag_name("staves"))
            .and_then(|n| n.text())
            .and_then(|t| t.trim().parse::<u32>().ok())
            .unwrap_or(1);
        let group = if staves_here > 1 {
            Some(StaffGroup {
                id: self.alloc(),
                kind: GroupKind::Brace,
            })
        } else {
            info.group
        };
        let mut transposition = Transposition::NONE;
        // Staff number (1-based) → slot in the score.
        let mut slots: HashMap<u32, StaffSlot> = HashMap::new();
        let staves_in_part = part
            .descendants()
            .find(|n| n.has_tag_name("staves"))
            .and_then(|n| n.text())
            .and_then(|t| t.trim().parse::<u32>().ok())
            .unwrap_or(1)
            .max(1);
        for n in 1..=staves_in_part {
            let index = self.score_staves.len();
            let label = if name.is_empty() {
                self.unnamed.push(index);
                format!("Staff {}", index + 1)
            } else {
                name.to_string()
            };
            let id = self.alloc();
            self.score_staves.push(Staff {
                id,
                name: label,
                short_name: info.short_name.clone(),
                clef: if n == 1 { Clef::Treble } else { Clef::Bass },
                instrument: info.program,
                transposition: Transposition::NONE,
                group,
                measures: Vec::new(),
            });
            slots.insert(
                n,
                StaffSlot {
                    index,
                    ..Default::default()
                },
            );
        }

        let mut divisions = 1.0f64;
        let mut open_slurs: HashMap<String, EventId> = HashMap::new();
        let mut pending_dynamic: HashMap<u32, Dynamic> = HashMap::new();
        // Words waiting for the next note of their staff.
        let mut pending_texts: HashMap<u32, Vec<NoteText>> = HashMap::new();
        let mut capacity = MeasureAttrs::default().time.measure_ticks();
        let mut current_attrs = MeasureAttrs::default();

        for (m, measure) in children(part, "measure").enumerate() {
            for slot in slots.values() {
                let staff = &mut self.score_staves[slot.index];
                if staff.measures.len() <= m {
                    staff.measures.resize_with(m + 1, StaffMeasure::default);
                }
            }
            // Position in the measure, in ticks.
            let mut pos: i64 = 0;
            // Where each (staff, voice) has been filled up to, in ticks.
            let mut filled: HashMap<(u32, usize), i64> = HashMap::new();
            // Last event of each (staff, voice), for chord notes.
            let mut last_event: HashMap<(u32, String), (usize, usize)> = HashMap::new();
            let ticks_of =
                |d: f64, divisions: f64| (d * TICKS_PER_QUARTER as f64 / divisions).round() as i64;

            for el in measure.children().filter(|c| c.is_element()) {
                match el.tag_name().name() {
                    "attributes" => {
                        if let Some(d) = number_of(el, "divisions") {
                            if d > 0.0 {
                                divisions = d;
                            }
                        }
                        if let Some(t) = child(el, "transpose") {
                            let octaves = number_of(t, "octave-change").unwrap_or(0.0) as i32;
                            let d = number_of(t, "diatonic").unwrap_or(0.0) as i32 + 7 * octaves;
                            let c = number_of(t, "chromatic").unwrap_or(0.0).round() as i32
                                + 12 * octaves;
                            transposition = Transposition {
                                diatonic: d.clamp(-28, 28) as i8,
                                chromatic: c.clamp(-48, 48) as i8,
                            };
                            for slot in slots.values() {
                                self.score_staves[slot.index].transposition = transposition;
                            }
                        }
                        if let Some(k) = child(el, "key").and_then(|k| number_of(k, "fifths")) {
                            // The score keeps the concert key; a transposing
                            // part shows its written key.
                            let written = KeySignature {
                                fifths: (k as i8).clamp(-7, 7),
                            };
                            current_attrs.key = transposition.concert_key(written);
                        }
                        if let Some(t) = child(el, "time") {
                            let beats: u32 = text_of(t, "beats")
                                .map(|b| {
                                    b.split('+')
                                        .filter_map(|x| x.trim().parse::<u32>().ok())
                                        .sum()
                                })
                                .unwrap_or(0);
                            let beat_type = number_of(t, "beat-type").unwrap_or(0.0) as u32;
                            let ts = TimeSignature {
                                beats: beats.min(255) as u8,
                                beat_type: beat_type.min(255) as u8,
                            };
                            if ts.is_valid() {
                                current_attrs.time = ts;
                            }
                        }
                        for c in children(el, "clef") {
                            let number = c
                                .attribute("number")
                                .and_then(|n| n.parse().ok())
                                .unwrap_or(1);
                            if let Some(slot) = slots.get_mut(&number) {
                                if slot.clef_set {
                                    self.extra_clefs += 1;
                                    continue;
                                }
                                slot.clef_set = true;
                                let sign = text_of(c, "sign").unwrap_or_default();
                                let line = number_of(c, "line").map(|l| l as u8);
                                self.score_staves[slot.index].clef = match (sign.as_str(), line) {
                                    ("F", _) => Clef::Bass,
                                    ("C", Some(4)) => Clef::Tenor,
                                    ("C", _) => Clef::Alto,
                                    _ => Clef::Treble,
                                };
                            }
                        }
                        capacity = current_attrs.time.measure_ticks();
                    }
                    "backup" => {
                        pos -= ticks_of(number_of(el, "duration").unwrap_or(0.0), divisions)
                    }
                    // The line closing the measure (on the right, which is
                    // where a barline goes when it does not say).
                    "barline" if first_part => {
                        // A repeat sign: forward on the left, backward on the
                        // right (where a barline goes when it does not say).
                        let right = el.attribute("location").unwrap_or("right") == "right";
                        if let Some(rep) = el.children().find(|n| n.has_tag_name("repeat")) {
                            match rep.attribute("direction") {
                                Some("forward") => {
                                    self.repeat_starts.insert(m);
                                }
                                Some("backward") => {
                                    let times = rep
                                        .attribute("times")
                                        .and_then(|t| t.trim().parse::<u8>().ok())
                                        .unwrap_or(2)
                                        .clamp(*REPEAT_TIMES.start(), *REPEAT_TIMES.end());
                                    self.repeat_ends.insert(m, times);
                                }
                                _ => {}
                            }
                            continue;
                        }
                        if !right {
                            continue;
                        }
                        let style = el
                            .children()
                            .find(|n| n.has_tag_name("bar-style"))
                            .and_then(|n| n.text())
                            .map(str::trim);
                        let kind = match style {
                            Some("light-light") => Some(Barline::Double),
                            Some("light-heavy" | "heavy-heavy") => Some(Barline::Final),
                            Some("dashed" | "dotted") => Some(Barline::Dashed),
                            _ => None,
                        };
                        if let Some(kind) = kind {
                            self.barlines.insert(m, kind);
                        }
                    }
                    "forward" => {
                        pos += ticks_of(number_of(el, "duration").unwrap_or(0.0), divisions)
                    }
                    "direction" => {
                        let staff_no = number_of(el, "staff").map(|n| n as u32).unwrap_or(1);
                        for d in el.descendants().filter(|n| n.has_tag_name("dynamics")) {
                            if let Some(dynamic) =
                                d.children().filter(|c| c.is_element()).find_map(|c| {
                                    DYNAMICS
                                        .iter()
                                        .find(|(_, n)| *n == c.tag_name().name())
                                        .map(|(d, _)| *d)
                                })
                            {
                                pending_dynamic.insert(staff_no, dynamic);
                            }
                        }
                        let sound_tempo = el
                            .descendants()
                            .find(|n| n.has_tag_name("sound"))
                            .and_then(|s| s.attribute("tempo"))
                            .and_then(|t| t.parse::<f64>().ok())
                            .map(|t| t.round() as u16);
                        // The tempo it sets: the playback tempo, or else
                        // what the metronome mark says.
                        let bpm = sound_tempo.or_else(|| {
                            metronome_of(el).and_then(|(b, n, _)| Some(b?.to_quarter_bpm(n?)))
                        });
                        if self.tempo.is_none() {
                            self.tempo = bpm;
                        }
                        if first_part {
                            if let Some(mark) = tempo_mark_of(el, m, bpm) {
                                self.tempo_marks.entry(m).or_insert(mark);
                            }
                            if let Some(r) = el
                                .descendants()
                                .find(|n| n.has_tag_name("rehearsal"))
                                .and_then(|r| r.text())
                                .map(str::trim)
                                .filter(|r| !r.is_empty())
                            {
                                self.rehearsals.entry(m).or_insert_with(|| r.to_string());
                            }
                        }
                        // Words that are not a tempo marking go on the next
                        // note: italic or below the staff is an expression,
                        // otherwise a technique.
                        if bpm.is_none() {
                            let words: Vec<roxmltree::Node> = el
                                .descendants()
                                .filter(|n| n.has_tag_name("words"))
                                .collect();
                            let text = words
                                .iter()
                                .filter_map(|w| w.text())
                                .map(str::trim)
                                .filter(|t| !t.is_empty())
                                .collect::<Vec<_>>()
                                .join(" ");
                            if !text.is_empty() {
                                let italic = words
                                    .iter()
                                    .any(|w| w.attribute("font-style") == Some("italic"));
                                let kind = if italic || el.attribute("placement") == Some("below") {
                                    NoteTextKind::Expression
                                } else {
                                    NoteTextKind::Technique
                                };
                                let list = pending_texts.entry(staff_no).or_default();
                                list.retain(|t| t.kind != kind);
                                list.push(NoteText {
                                    kind,
                                    text: text.chars().take(MAX_NOTE_TEXT_CHARS).collect(),
                                });
                            }
                        }
                    }
                    "note" => {
                        if child(el, "grace").is_some() {
                            self.grace += 1;
                            continue;
                        }
                        if child(el, "cue").is_some() {
                            continue;
                        }
                        let staff_no = number_of(el, "staff").map(|n| n as u32).unwrap_or(1);
                        let Some(slot) = slots.get_mut(&staff_no) else {
                            continue;
                        };
                        let voice_name = text_of(el, "voice").unwrap_or_else(|| "1".into());
                        let is_chord = child(el, "chord").is_some();
                        let dur = ticks_of(number_of(el, "duration").unwrap_or(0.0), divisions);
                        let pitch = child(el, "pitch")
                            .map(|p| Pitch {
                                step: text_of(p, "step")
                                    .and_then(|s| s.chars().next())
                                    .and_then(Step::from_char)
                                    .unwrap_or(Step::C),
                                alter: number_of(p, "alter")
                                    .unwrap_or(0.0)
                                    .round()
                                    .clamp(-2.0, 2.0) as i8,
                                octave: number_of(p, "octave").unwrap_or(4.0) as i8,
                            })
                            .or_else(|| {
                                child(el, "unpitched").map(|p| {
                                    Pitch::new(
                                        text_of(p, "display-step")
                                            .and_then(|s| s.chars().next())
                                            .and_then(Step::from_char)
                                            .unwrap_or(Step::B),
                                        number_of(p, "display-octave").unwrap_or(4.0) as i8,
                                    )
                                })
                            });
                        let tie_start =
                            children(el, "tie").any(|t| t.attribute("type") == Some("start"));

                        if is_chord {
                            if let (Some(p), Some(&(meas, idx))) =
                                (pitch, last_event.get(&(staff_no, voice_name.clone())))
                            {
                                let staff = &mut self.score_staves[slot.index];
                                let v = slot
                                    .voices
                                    .iter()
                                    .position(|n| *n == voice_name)
                                    .unwrap_or(0);
                                if let Some(e) = staff.measures[meas].voices[v].get_mut(idx) {
                                    if let EventKind::Chord { pitches } = &mut e.kind {
                                        if !pitches.contains(&p) {
                                            pitches.push(p);
                                        }
                                    }
                                    e.tie |= tie_start;
                                }
                            }
                            continue;
                        }

                        let start = pos;
                        pos += dur;
                        let v = match slot.voices.iter().position(|n| *n == voice_name) {
                            Some(v) => v,
                            None if slot.voices.len() < MAX_VOICES => {
                                slot.voices.push(voice_name.clone());
                                slot.voices.len() - 1
                            }
                            None => {
                                self.dropped_voices += 1;
                                continue;
                            }
                        };
                        let fill = filled.entry((staff_no, v)).or_insert(0);
                        if start > *fill {
                            // A gap in this voice (e.g. after <forward>): rests.
                            for d in durations_for((start - *fill) as u32) {
                                let id = self.next_id + 1;
                                self.next_id = id;
                                self.score_staves[slot.index].measures[m].voices[v]
                                    .push(Event::new(id, d, EventKind::Rest));
                            }
                        } else if start < *fill {
                            self.overlaps += 1;
                        }
                        *fill = (*fill).max(start) + dur;

                        let measure_rest = child(el, "rest")
                            .is_some_and(|r| r.attribute("measure") == Some("yes"))
                            || (pitch.is_none()
                                && child(el, "type").is_none()
                                && dur as u32 == capacity);
                        let duration = if measure_rest {
                            Duration::new(DurationBase::Whole)
                        } else if let Some(base) = text_of(el, "type")
                            .and_then(|t| TYPES.iter().find(|(_, n)| *n == t).map(|(b, _)| *b))
                        {
                            Duration::dotted(base, children(el, "dot").count().min(3) as u8)
                        } else {
                            durations_for(dur.max(1) as u32)
                                .into_iter()
                                .next()
                                .unwrap_or(Duration::new(DurationBase::Quarter))
                        };
                        if child(el, "time-modification").is_some() {
                            self.tuplets += 1;
                        }

                        let id = self.alloc();
                        let kind = match pitch {
                            Some(p) if child(el, "rest").is_none() => {
                                EventKind::Chord { pitches: vec![p] }
                            }
                            _ => EventKind::Rest,
                        };
                        let mut e = Event::new(id, duration, kind);
                        e.tie = tie_start;

                        for n in children(el, "notations") {
                            for c in n.children().filter(|c| c.is_element()) {
                                match c.tag_name().name() {
                                    "tied" if c.attribute("type") == Some("start") => e.tie = true,
                                    "slur" => {
                                        let key = c.attribute("number").unwrap_or("1").to_string();
                                        match c.attribute("type") {
                                            Some("start") => {
                                                open_slurs.insert(key, id);
                                            }
                                            Some("stop") => {
                                                if let Some(start) = open_slurs.remove(&key) {
                                                    if start != id {
                                                        let sid = self.next_id + 1;
                                                        self.next_id = sid;
                                                        self.slurs.push(Slur {
                                                            id: sid,
                                                            start,
                                                            end: id,
                                                        });
                                                    }
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                    "articulations" => {
                                        for a in c.children().filter(|a| a.is_element()) {
                                            let art = match a.tag_name().name() {
                                                "staccato" => Some(Articulation::Staccato),
                                                "staccatissimo" | "spiccato" => {
                                                    Some(Articulation::Staccatissimo)
                                                }
                                                "accent" => Some(Articulation::Accent),
                                                "tenuto" => Some(Articulation::Tenuto),
                                                "strong-accent" => Some(Articulation::Marcato),
                                                _ => None,
                                            };
                                            if let Some(a) = art {
                                                if !e.articulations.contains(&a) {
                                                    e.articulations.push(a);
                                                }
                                            }
                                        }
                                    }
                                    "fermata" => {
                                        if !e.articulations.contains(&Articulation::Fermata) {
                                            e.articulations.push(Articulation::Fermata);
                                        }
                                    }
                                    "dynamics" => {
                                        if let Some(d) =
                                            c.children().filter(|x| x.is_element()).find_map(|x| {
                                                DYNAMICS
                                                    .iter()
                                                    .find(|(_, n)| *n == x.tag_name().name())
                                                    .map(|(d, _)| *d)
                                            })
                                        {
                                            e.dynamic = Some(d);
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                        e.articulations.sort();
                        if e.dynamic.is_none() && !e.is_rest() {
                            e.dynamic = pending_dynamic.remove(&staff_no);
                        }
                        if let Some(mut texts) = pending_texts.remove(&staff_no) {
                            texts.sort_by_key(|t| t.kind);
                            e.texts = texts;
                        }

                        for (i, l) in children(el, "lyric").enumerate() {
                            let verse = l
                                .attribute("number")
                                .and_then(|n| n.parse::<usize>().ok())
                                .map(|n| n.saturating_sub(1))
                                .unwrap_or(i);
                            if verse >= MAX_VERSES {
                                continue;
                            }
                            let text: Vec<String> = children(l, "text")
                                .filter_map(|t| t.text())
                                .map(str::to_string)
                                .collect();
                            let text: String = text
                                .join(" ")
                                .trim()
                                .chars()
                                .take(MAX_SYLLABLE_CHARS)
                                .collect();
                            if text.is_empty() {
                                continue;
                            }
                            let syllabic = text_of(l, "syllabic").unwrap_or_default();
                            let join = if matches!(syllabic.as_str(), "begin" | "middle") {
                                LyricJoin::Hyphen
                            } else if child(l, "extend").is_some() {
                                LyricJoin::Extender
                            } else {
                                LyricJoin::None
                            };
                            if e.lyrics.len() <= verse {
                                e.lyrics.resize_with(verse + 1, Syllable::default);
                            }
                            e.lyrics[verse] = Syllable { text, join };
                        }

                        let voice = &mut self.score_staves[slot.index].measures[m].voices[v];
                        voice.push(e);
                        last_event.insert((staff_no, voice_name), (m, voice.len() - 1));
                    }
                    _ => {}
                }
            }
            if first_part {
                if self.measures.len() <= m {
                    self.measures.resize(m + 1, None);
                }
                self.measures[m] = Some(current_attrs.clone());
            }
        }
    }
}

/// Splits a length in ticks into note values, longest first (dotted
/// where that fits), for rests that fill gaps.
fn durations_for(mut ticks: u32) -> Vec<Duration> {
    let mut out = Vec::new();
    let bases = [
        DurationBase::Whole,
        DurationBase::Half,
        DurationBase::Quarter,
        DurationBase::Eighth,
        DurationBase::Sixteenth,
        DurationBase::ThirtySecond,
        DurationBase::SixtyFourth,
        DurationBase::HundredTwentyEighth,
    ];
    while ticks >= DurationBase::HundredTwentyEighth.ticks() {
        let Some(&base) = bases.iter().find(|b| b.ticks() <= ticks) else {
            break;
        };
        let dotted = Duration::dotted(base, 1);
        let d = if dotted.ticks() <= ticks {
            dotted
        } else {
            Duration::new(base)
        };
        ticks -= d.ticks();
        out.push(d);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(score: &mut Score, base: DurationBase, pitches: &[(Step, i8, i8)]) -> Event {
        let id = score.alloc_id();
        let kind = if pitches.is_empty() {
            EventKind::Rest
        } else {
            EventKind::Chord {
                pitches: pitches
                    .iter()
                    .map(|&(step, alter, octave)| Pitch {
                        step,
                        alter,
                        octave,
                    })
                    .collect(),
            }
        };
        Event::new(id, Duration::new(base), kind)
    }

    fn sample() -> Score {
        let mut score = Score::new("Round & Trip", 2);
        score.metadata.composer = "Anon".into();
        score.tempo = 88;
        score.measures[1].key = KeySignature { fifths: -2 };
        let bass = score.blank_staff("Cello", Clef::Bass);
        score.staves.push(bass);
        score.staves[0].name = "Clarinet in B♭".into();
        score.staves[0].short_name = "Cl.".into();
        score.staves[0].instrument = 71;
        score.staves[0].transposition = Transposition {
            diatonic: -1,
            chromatic: -2,
        };
        let g = Some(StaffGroup {
            id: 999,
            kind: GroupKind::Bracket,
        });
        score.staves[0].group = g;
        score.staves[1].group = g;

        let mut a = note(&mut score, DurationBase::Quarter, &[(Step::C, 0, 5)]);
        a.tie = true;
        a.articulations = vec![Articulation::Staccato];
        a.dynamic = Some(Dynamic::Mf);
        a.lyrics = vec![Syllable {
            text: "Al".into(),
            join: LyricJoin::Hyphen,
        }];
        let mut b = note(&mut score, DurationBase::Quarter, &[(Step::C, 0, 5)]);
        b.lyrics = vec![Syllable {
            text: "le".into(),
            join: LyricJoin::None,
        }];
        let mut c = note(
            &mut score,
            DurationBase::Half,
            &[(Step::E, 0, 4), (Step::G, 1, 4)],
        );
        c.duration.dots = 0;
        c.articulations = vec![Articulation::Accent, Articulation::Fermata];
        let ids = (a.id, c.id);
        score.staves[0].measures[0].voices[0] = vec![a, b, c];
        let r = note(&mut score, DurationBase::Whole, &[]);
        score.staves[0].measures[1].voices[0] = vec![r];
        let low = note(&mut score, DurationBase::Whole, &[(Step::B, -1, 2)]);
        score.staves[1].measures[1].voices[0] = vec![low];
        let v2 = note(&mut score, DurationBase::Half, &[(Step::G, 0, 3)]);
        score.staves[1].measures[0].voices[1] = vec![v2];
        let sid = score.alloc_id();
        score.slurs.push(Slur {
            id: sid,
            start: ids.0,
            end: ids.1,
        });
        score
    }

    /// Everything but ids, which are allocated anew on import.
    fn shape(score: &Score) -> String {
        let mut out = format!(
            "{}|{}|{}|{:?}\n",
            score.metadata.title, score.metadata.composer, score.tempo, score.measures
        );
        for s in &score.staves {
            let _ = writeln!(
                out,
                "{} {} {:?} {} {:?} {:?}",
                s.name,
                s.short_name,
                s.clef,
                s.instrument,
                s.transposition,
                s.group.map(|g| g.kind)
            );
            for (m, cell) in s.measures.iter().enumerate() {
                for (v, events) in cell.voices.iter().enumerate() {
                    for e in events {
                        let _ = writeln!(
                            out,
                            "  m{m} v{v} {:?} {:?} tie={} {:?} {:?} {:?}",
                            e.duration, e.kind, e.tie, e.articulations, e.dynamic, e.lyrics
                        );
                    }
                }
            }
        }
        let _ = write!(out, "slurs={}", score.slurs.len());
        out
    }

    #[test]
    fn round_trip_keeps_the_music() {
        let score = sample();
        let xml = export(&score);
        assert!(xml.contains("<work-title>Round &amp; Trip</work-title>"));
        // The clarinet reads D major and E-flat... its own key: concert C
        // (measure 1) is written D (2 sharps); concert B-flat is written C.
        assert!(xml.contains("<key><fifths>2</fifths></key>"));
        assert!(
            xml.contains("<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose>")
        );
        assert!(xml.contains("<group-symbol>bracket</group-symbol>"));
        assert!(xml.contains("<part-abbreviation>Cl.</part-abbreviation>"));
        let back = import(&xml, "fallback").unwrap();
        assert!(back.notes.is_empty(), "{:?}", back.notes);
        assert!(back.score.validate().is_empty());
        // The empty second voice of measure 2 and the whole-measure rest of
        // the cello's first measure come back as written.
        let mut expected = score.clone();
        let rest = Event::new(0, Duration::new(DurationBase::Whole), EventKind::Rest);
        expected.staves[1].measures[0].voices[0] = vec![rest];
        let normalize = |s: &str| s.to_string();
        assert_eq!(normalize(&shape(&back.score)), normalize(&shape(&expected)));
        // The slur connects the same notes.
        let slur = back.score.slurs[0];
        let (s1, m1, v1, i1) = back.score.locate(slur.start).unwrap();
        let (s2, m2, v2, i2) = back.score.locate(slur.end).unwrap();
        assert_eq!((s1, m1, v1, i1, s2, m2, v2, i2), (0, 0, 0, 0, 0, 0, 0, 2));
    }

    #[test]
    fn page_one_texts_round_trip() {
        let mut score = sample();
        score.metadata.subtitle = "for clarinet & cello".into();
        score.metadata.lyricist = "Arr. J. Doe".into();
        score.metadata.part = "Score".into();
        score.metadata.copyright = "© 2026 Anon".into();
        // No MusicXML equivalent: not exported.
        score.metadata.footer = "{page}".into();
        let xml = export(&score);
        assert!(xml.contains("<rights>© 2026 Anon</rights>"));
        assert!(xml.contains("<credit-type>subtitle</credit-type><credit-words>for clarinet &amp; cello</credit-words>"));
        let m = import(&xml, "x").unwrap().score.metadata;
        assert_eq!(
            (m.title.as_str(), m.subtitle.as_str(), m.composer.as_str()),
            ("Round & Trip", "for clarinet & cello", "Anon")
        );
        assert_eq!(
            (m.lyricist.as_str(), m.part.as_str()),
            ("Arr. J. Doe", "Score")
        );
        assert_eq!(m.copyright, "© 2026 Anon");
        assert!(m.footer.is_empty());
    }

    #[test]
    fn barlines_round_trip() {
        let mut score = sample();
        score.measures[0].barline = Barline::Double;
        let xml = export(&score);
        assert!(xml.contains("<bar-style>light-light</bar-style>"));
        // The last measure still ends with a final barline.
        assert!(xml.contains("<bar-style>light-heavy</bar-style>"));
        let back = import(&xml, "x").unwrap().score;
        assert_eq!(back.measures[0].barline, Barline::Double);
        assert_eq!(
            back.measures[1].barline,
            Barline::Single,
            "the usual ending"
        );

        score.measures[0].barline = Barline::Dashed;
        let back = import(&export(&score), "x").unwrap().score;
        assert_eq!(back.measures[0].barline, Barline::Dashed);
    }

    #[test]
    fn repeats_round_trip() {
        let mut score = sample();
        score.measures[0].repeat_start = true;
        score.measures[1].repeat_end = Some(3);
        let xml = export(&score);
        assert!(xml.contains("<repeat direction=\"forward\"/>"));
        assert!(xml.contains("<repeat direction=\"backward\" times=\"3\"/>"));
        let back = import(&xml, "x").unwrap().score;
        assert!(back.measures[0].repeat_start);
        assert_eq!(back.measures[1].repeat_end, Some(3));
        assert_eq!(
            back.measures[1].barline,
            Barline::Single,
            "the repeat sign is not a final barline"
        );
        assert!(
            !back.measures[1].repeat_start,
            "not carried on to the next measure"
        );
    }

    #[test]
    fn tempo_markings_round_trip() {
        let mut score = sample();
        score.tempo = 76;
        score.measures[0].tempo = Some(TempoMark {
            text: "Andante con moto".into(),
            ..TempoMark::default()
        });
        score.measures[1].tempo = Some(TempoMark {
            text: "Più mosso".into(),
            bpm: Some(90),
            beat: BeatUnit::DottedQuarter,
            show_text: true,
            show_metronome: false,
        });
        let xml = export(&score);
        assert!(xml.contains("<words font-weight=\"bold\">Andante con moto</words>"));
        assert!(xml.contains("<metronome print-object=\"no\"><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>60</per-minute></metronome></direction-type><sound tempo=\"90\"/>"));
        let back = import(&xml, "x").unwrap().score;
        assert_eq!(back.tempo, 76);
        assert_eq!(back.measures[0].tempo, score.measures[0].tempo);
        assert_eq!(back.measures[1].tempo, score.measures[1].tempo);
    }

    #[test]
    fn note_texts_and_rehearsal_marks_round_trip() {
        let mut score = sample();
        let e = &mut score.staves[0].measures[0].voices[0][0];
        e.texts = vec![
            NoteText {
                kind: NoteTextKind::Expression,
                text: "dolce".into(),
            },
            NoteText {
                kind: NoteTextKind::Technique,
                text: "con sord.".into(),
            },
        ];
        score.measures[1].rehearsal = Some("A".into());
        let xml = export(&score);
        assert!(xml.contains("<words font-style=\"italic\">dolce</words>"));
        assert!(xml.contains("<rehearsal>A</rehearsal>"));
        let back = import(&xml, "x").unwrap().score;
        assert_eq!(
            back.staves[0].measures[0].voices[0][0].texts,
            score.staves[0].measures[0].voices[0][0].texts
        );
        assert_eq!(back.measures[1].rehearsal.as_deref(), Some("A"));
    }

    #[test]
    fn words_from_other_programs_become_expressions_or_techniques() {
        let xml = r#"<score-partwise>
  <part-list><score-part id="P1"><part-name>Violin</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>
    <direction placement="above"><direction-type><words>pizz.</words></direction-type></direction>
    <direction placement="below"><direction-type><words>espressivo</words></direction-type></direction>
    <note><pitch><step>A</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
  </measure></part>
</score-partwise>"#;
        let s = import(xml, "x").unwrap().score;
        let texts = &s.staves[0].measures[0].voices[0][0].texts;
        assert_eq!(texts.len(), 2);
        assert_eq!(
            (texts[0].kind, texts[0].text.as_str()),
            (NoteTextKind::Expression, "espressivo")
        );
        assert_eq!(
            (texts[1].kind, texts[1].text.as_str()),
            (NoteTextKind::Technique, "pizz.")
        );
    }

    #[test]
    fn scores_without_markings_export_a_hidden_opening_tempo() {
        let score = sample();
        let xml = export(&score);
        assert!(xml.contains("<metronome print-object=\"no\">"));
        let back = import(&xml, "x").unwrap().score;
        assert_eq!(back.tempo, score.tempo);
        assert!(!back.has_tempo_marks(), "nothing printed, nothing added");
    }

    #[test]
    fn imports_words_and_a_dotted_beat_from_other_programs() {
        let xml = r#"<score-partwise>
  <part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1"><attributes><divisions>2</divisions><time><beats>6</beats><beat-type>8</beat-type></time></attributes>
      <direction placement="above"><direction-type><words>Allegretto</words></direction-type>
        <direction-type><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>60</per-minute></metronome></direction-type></direction>
      <note><rest/><duration>6</duration></note></measure>
    <measure number="2">
      <direction><direction-type><words>dolce</words></direction-type></direction>
      <direction><direction-type><words>rit.</words></direction-type><sound tempo="72"/></direction>
      <note><rest/><duration>6</duration></note></measure>
  </part>
</score-partwise>"#;
        let s = import(xml, "x").unwrap().score;
        assert_eq!(s.tempo, 90, "♩. = 60 is ♩ = 90");
        let first = s.measures[0].tempo.clone().unwrap();
        assert_eq!(
            (first.text.as_str(), first.beat, first.show_metronome),
            ("Allegretto", BeatUnit::DottedQuarter, true)
        );
        // Words alone are not tempo markings; with a playback tempo they are.
        let second = s.measures[1].tempo.clone().unwrap();
        assert_eq!(
            (second.text.as_str(), second.bpm, second.show_metronome),
            ("rit.", Some(72), false)
        );
    }

    #[test]
    fn a_movement_title_under_a_work_title_is_a_subtitle() {
        let xml = r#"<score-partwise>
  <work><work-title>Sonata</work-title></work><movement-title>II. Andante</movement-title>
  <identification><creator type="arranger">Arr. X</creator></identification>
  <part-list><score-part id="P1"><part-name>Flute</part-name></score-part></part-list>
  <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>
    <note><rest/><duration>4</duration><type>whole</type></note></measure></part>
</score-partwise>"#;
        let m = import(xml, "x").unwrap().score.metadata;
        assert_eq!(
            (m.title.as_str(), m.subtitle.as_str()),
            ("Sonata", "II. Andante")
        );
        assert_eq!(m.lyricist, "Arr. X");
    }

    #[test]
    fn divisions_are_as_coarse_as_possible() {
        let score = sample();
        assert_eq!(divisions_for(&score), 1);
        assert!(export(&score).contains("<divisions>1</divisions>"));
    }

    #[test]
    fn piano_part_with_two_staves_and_voices() {
        let xml = r#"<?xml version="1.0"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <movement-title>Prelude</movement-title>
  <part-list><score-part id="P1"><part-name>Piano</part-name>
    <midi-instrument id="P1-I1"><midi-program>1</midi-program></midi-instrument></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><key><fifths>1</fifths></key>
        <time><beats>3</beats><beat-type>4</beat-type></time><staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef></attributes>
      <direction><direction-type><dynamics><p/></dynamics></direction-type><staff>1</staff><sound tempo="72"/></direction>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>half</type><staff>1</staff>
        <notations><slur type="start" number="1"/></notations></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff>
        <notations><slur type="stop" number="1"/></notations></note>
      <backup><duration>6</duration></backup>
      <forward><duration>2</duration></forward>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><voice>2</voice><type>half</type><staff>1</staff></note>
      <backup><duration>6</duration></backup>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>6</duration><voice>5</voice><type>half</type><dot/><staff>2</staff></note>
      <note><chord/><pitch><step>D</step><octave>3</octave></pitch><duration>6</duration><voice>5</voice><type>half</type><dot/><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><rest measure="yes"/><duration>6</duration><voice>1</voice><staff>1</staff></note>
      <backup><duration>6</duration></backup>
      <note><grace/><pitch><step>A</step><octave>2</octave></pitch><voice>5</voice><type>eighth</type><staff>2</staff></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>2</duration><voice>5</voice><type>eighth</type><staff>2</staff>
        <time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>
    </measure>
  </part>
</score-partwise>"#;
        let imp = import(xml, "x").unwrap();
        let s = &imp.score;
        assert_eq!(s.metadata.title, "Prelude");
        assert_eq!(s.tempo, 72);
        assert_eq!(s.staves.len(), 2);
        assert_eq!(
            (s.staves[0].clef, s.staves[1].clef),
            (Clef::Treble, Clef::Bass)
        );
        assert_eq!(s.staves[0].name, "Piano");
        assert_eq!(
            s.measures[0].time,
            TimeSignature {
                beats: 3,
                beat_type: 4
            }
        );
        assert_eq!(s.measures[1].key.fifths, 1);
        let m0 = &s.staves[0].measures[0];
        assert_eq!(m0.voices[0].len(), 2);
        assert_eq!(m0.voices[0][0].dynamic, Some(Dynamic::P));
        // Voice 2 starts after a quarter: a rest fills the gap.
        assert!(m0.voices[1][0].is_rest());
        assert_eq!(m0.voices[1][1].pitches()[0], Pitch::new(Step::B, 4));
        // Voice 5 on staff 2 is that staff's first voice; the chord holds.
        let low = &s.staves[1].measures[0].voices[0][0];
        assert_eq!(low.pitches().len(), 2);
        assert_eq!(low.duration, Duration::dotted(DurationBase::Half, 1));
        assert_eq!(s.slurs.len(), 1);
        assert!(s.staves[0].measures[1].voices[0][0].is_rest());
        assert_eq!(
            imp.notes,
            [
                ImportNote {
                    kind: ImportNoteKind::Tuplets,
                    count: 1
                },
                ImportNote {
                    kind: ImportNoteKind::GraceNotes,
                    count: 1
                },
            ]
        );
        assert_eq!(
            imp.notes[1].to_string(),
            "One grace note was left out (not supported yet)."
        );
        assert!(imp.unnamed_staves.is_empty(), "the part is named Piano");
        assert!(s.validate().is_empty());
    }

    #[test]
    fn names_unnamed_parts_and_says_which() {
        let xml = r#"<score-partwise>
  <part-list><score-part id="P1"><part-name></part-name></score-part></part-list>
  <part id="P1"><measure number="1"><attributes><divisions>1</divisions></attributes>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
  </measure></part>
</score-partwise>"#;
        let imp = import(xml, "x").unwrap();
        assert_eq!(imp.score.staves[0].name, "Staff 1");
        assert_eq!(imp.unnamed_staves, [0]);
        let notes = ImportNote {
            kind: ImportNoteKind::Overlaps,
            count: 3,
        };
        assert_eq!(
            serde_json::to_value(notes).unwrap(),
            serde_json::json!({ "kind": "overlaps", "count": 3 })
        );
    }

    #[test]
    fn rejects_other_xml() {
        assert!(matches!(
            import("<html/>", "x"),
            Err(MusicXmlError::NotAScore)
        ));
        assert!(matches!(
            import("<score-timewise/>", "x"),
            Err(MusicXmlError::Timewise)
        ));
        assert!(matches!(import("not xml", "x"), Err(MusicXmlError::Xml(_))));
    }

    #[test]
    fn gaps_become_rests() {
        let d: Vec<u32> = durations_for(960 * 3).iter().map(Duration::ticks).collect();
        assert_eq!(d, vec![2880]); // dotted half
        let d: Vec<u32> = durations_for(960 * 5).iter().map(Duration::ticks).collect();
        assert_eq!(d, vec![3840, 960]);
    }
}
