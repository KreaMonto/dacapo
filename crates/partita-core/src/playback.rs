//! Turns a score into a timeline of sounding notes for playback.
//!
//! The timeline is independent of any audio library: the application feeds
//! it to a synthesizer. Interpretation rules (kept deliberately simple and
//! predictable):
//!
//! - **Ties** join notes of the same pitch into one longer note, also across
//!   barlines.
//! - **Articulation** sets how long a note sounds within its written value:
//!   normal 92 %, under a slur or with tenuto 100 %, staccato 50 %,
//!   staccatissimo 25 %.
//! - **Dynamics** set the loudness from that event on, per voice (default
//!   mf). `sfz` accents only its note; `fp` plays forte, then piano.
//!   Accents and marcato add emphasis to their note.
//! - Measures take their time signature's length, or longer if they are
//!   overfull, so no written note is cut. Measure rests are silence.
//! - Fermatas do not change timing yet.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::model::{Articulation, Dynamic, Event, EventId, Score, MAX_VOICES, TICKS_PER_QUARTER};

/// One note to play, in absolute ticks from the start of the score.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Note {
    pub start: u64,
    pub end: u64,
    /// MIDI key number (60 = middle C).
    pub key: u8,
    /// MIDI velocity 1–127.
    pub velocity: u8,
    /// Staff the note belongs to (selects the instrument/channel).
    pub staff: usize,
}

/// Everything needed to play a score and follow it on screen.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Timeline {
    /// Sorted by start, then key.
    pub notes: Vec<Note>,
    /// Absolute tick at which each measure starts.
    pub measure_starts: Vec<u64>,
    /// Absolute tick of the end of the last measure.
    pub end: u64,
    /// Quarter notes per minute.
    pub tempo: u16,
    /// General MIDI program of each staff.
    pub instruments: Vec<u8>,
}

impl Timeline {
    /// Absolute tick of a position given as (measure, tick in measure).
    pub fn tick_at(&self, measure: usize, tick: u32) -> u64 {
        self.measure_starts
            .get(measure)
            .map(|s| s + tick as u64)
            .unwrap_or(self.end)
    }

    /// Inverse of [`Timeline::tick_at`]: (measure, tick in measure).
    pub fn position(&self, abs: u64) -> (usize, u32) {
        let m = match self.measure_starts.binary_search(&abs) {
            Ok(i) => i,
            Err(0) => 0,
            Err(i) => i - 1,
        };
        let start = self.measure_starts.get(m).copied().unwrap_or(0);
        (m, abs.saturating_sub(start) as u32)
    }

    /// Seconds per tick at this tempo.
    pub fn seconds_per_tick(&self) -> f64 {
        60.0 / (self.tempo.max(1) as f64 * TICKS_PER_QUARTER as f64)
    }
}

/// Default loudness before any dynamic marking.
const DEFAULT_VELOCITY: u8 = 84; // mf

fn dynamic_velocity(d: Dynamic) -> u8 {
    match d {
        Dynamic::Ppp => 30,
        Dynamic::Pp => 42,
        Dynamic::P => 56,
        Dynamic::Mp => 70,
        Dynamic::Mf => 84,
        Dynamic::F => 98,
        Dynamic::Ff => 112,
        Dynamic::Fff => 124,
        Dynamic::Sfz => 120,
        Dynamic::Fp => 98,
    }
}

/// Fraction (per mille) of the written length that actually sounds.
fn sounding_permille(e: &Event, slurred: bool) -> u64 {
    let arts = &e.articulations;
    if arts.contains(&Articulation::Staccatissimo) {
        250
    } else if arts.contains(&Articulation::Staccato) {
        500
    } else if slurred || e.tie || arts.contains(&Articulation::Tenuto) {
        1000
    } else {
        920
    }
}

/// Events covered by a slur (except the slur's last note, which ends the
/// legato phrase normally).
fn slurred_events(score: &Score) -> HashSet<EventId> {
    let mut out = HashSet::new();
    for slur in &score.slurs {
        let (Some(a), Some(b)) = (score.locate(slur.start), score.locate(slur.end)) else {
            continue;
        };
        if (a.0, a.2) != (b.0, b.2) {
            continue; // different staff or voice
        }
        let (staff, voice) = (a.0, a.2);
        let mut inside = false;
        'measures: for m in a.1..=b.1 {
            for e in &score.staves[staff].measures[m].voices[voice] {
                if e.id == slur.start {
                    inside = true;
                }
                if e.id == slur.end {
                    break 'measures;
                }
                if inside {
                    out.insert(e.id);
                }
            }
        }
    }
    out
}

/// Builds the playback timeline of a score.
pub fn build(score: &Score) -> Timeline {
    // Measure lengths: the time signature, stretched if a voice overflows.
    let mut measure_starts = Vec::with_capacity(score.measures.len());
    let mut lengths = Vec::with_capacity(score.measures.len());
    let mut t = 0u64;
    for (m, attrs) in score.measures.iter().enumerate() {
        let capacity = attrs.time.measure_ticks();
        let longest = score
            .staves
            .iter()
            .flat_map(|s| s.measures[m].voices.iter())
            .filter(|v| !crate::model::is_measure_rest(v, capacity))
            .map(|v| v.iter().map(Event::ticks).sum::<u32>())
            .max()
            .unwrap_or(0);
        let len = capacity.max(longest) as u64;
        measure_starts.push(t);
        lengths.push(len);
        t += len;
    }

    let slurred = slurred_events(score);
    let mut notes: Vec<Note> = Vec::new();

    for (s, staff) in score.staves.iter().enumerate() {
        for v in 0..MAX_VOICES {
            let mut velocity = DEFAULT_VELOCITY;
            // Notes still tied into the next event: key -> index in `notes`.
            let mut open_ties: HashMap<u8, usize> = HashMap::new();
            for (m, cell) in staff.measures.iter().enumerate() {
                let events = &cell.voices[v];
                let capacity = score.measures[m].time.measure_ticks();
                if crate::model::is_measure_rest(events, capacity) {
                    open_ties.clear();
                    continue;
                }
                let mut at = measure_starts[m];
                for e in events {
                    let written = e.ticks() as u64;
                    let start = at;
                    at += written;
                    // Dynamics: sfz/fp affect this note specially.
                    let mut note_velocity = velocity;
                    if let Some(d) = e.dynamic {
                        note_velocity = dynamic_velocity(d);
                        velocity = match d {
                            Dynamic::Sfz => velocity,
                            Dynamic::Fp => dynamic_velocity(Dynamic::P),
                            other => dynamic_velocity(other),
                        };
                    }
                    if e.articulations.contains(&Articulation::Marcato) {
                        note_velocity = note_velocity.saturating_add(24);
                    } else if e.articulations.contains(&Articulation::Accent) {
                        note_velocity = note_velocity.saturating_add(16);
                    }
                    let note_velocity = note_velocity.clamp(1, 127);

                    if e.is_rest() {
                        open_ties.clear();
                        continue;
                    }
                    let sounding = written * sounding_permille(e, slurred.contains(&e.id)) / 1000;
                    let mut next_open = HashMap::new();
                    for p in e.pitches() {
                        let key = p.midi().clamp(0, 127) as u8;
                        let index = match open_ties.get(&key) {
                            // Continue the tied note instead of striking again.
                            Some(&i) => {
                                notes[i].end = start + sounding.max(1);
                                i
                            }
                            None => {
                                notes.push(Note {
                                    start,
                                    end: start + sounding.max(1),
                                    key,
                                    velocity: note_velocity,
                                    staff: s,
                                });
                                notes.len() - 1
                            }
                        };
                        if e.tie {
                            // A tied note sounds through to the next one.
                            notes[index].end = start + written;
                            next_open.insert(key, index);
                        }
                    }
                    open_ties = next_open;
                }
            }
        }
    }

    notes.sort_by_key(|n| (n.start, n.key, n.staff));
    Timeline {
        notes,
        measure_starts,
        end: t,
        tempo: score.tempo,
        instruments: score.staves.iter().map(|s| s.instrument).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn note(id: u64, step: Step, base: DurationBase) -> Event {
        Event::new(
            id,
            Duration::new(base),
            EventKind::Chord {
                pitches: vec![Pitch::new(step, 4)],
            },
        )
    }

    fn score_with(m0: Vec<Event>, m1: Vec<Event>) -> Score {
        let mut s = Score::new("t", 2);
        s.staves[0].measures[0].voices[0] = m0;
        s.staves[0].measures[1].voices[0] = m1;
        s
    }

    #[test]
    fn timing_and_measure_starts() {
        let s = score_with(
            vec![
                note(1, Step::C, DurationBase::Quarter),
                note(2, Step::D, DurationBase::Half),
            ],
            vec![note(3, Step::E, DurationBase::Whole)],
        );
        let t = build(&s);
        assert_eq!(t.measure_starts, vec![0, 3840]);
        assert_eq!(t.end, 7680);
        assert_eq!(t.notes.len(), 3);
        assert_eq!((t.notes[0].start, t.notes[0].key), (0, 60));
        assert_eq!(t.notes[1].start, 960);
        assert_eq!(t.notes[2].start, 3840);
        // Normal articulation: 92 % of the written length.
        assert_eq!(t.notes[0].end, 960 * 92 / 100);
        assert_eq!(t.position(4000), (1, 160));
        assert_eq!(t.tick_at(1, 160), 4000);
        assert_eq!(t.tempo, DEFAULT_TEMPO);
    }

    #[test]
    fn ties_merge_across_the_barline() {
        let mut a = note(1, Step::G, DurationBase::Half);
        let mut b = note(2, Step::G, DurationBase::Half);
        a.tie = true;
        b.tie = true;
        let s = score_with(
            vec![note(9, Step::C, DurationBase::Half), a],
            vec![b, note(3, Step::G, DurationBase::Half)],
        );
        let t = build(&s);
        // C, one long G (two tied halves + the last G joined too), no extra strikes.
        let gs: Vec<_> = t.notes.iter().filter(|n| n.key == 67).collect();
        assert_eq!(gs.len(), 1);
        assert_eq!(gs[0].start, 1920);
        assert_eq!(gs[0].end, 3840 + 1920 + 1920 * 92 / 100);
    }

    #[test]
    fn articulations_and_dynamics() {
        let mut a = note(1, Step::C, DurationBase::Quarter);
        a.articulations = vec![Articulation::Staccato];
        a.dynamic = Some(Dynamic::P);
        let mut b = note(2, Step::D, DurationBase::Quarter);
        b.articulations = vec![Articulation::Accent];
        let mut c = note(3, Step::E, DurationBase::Quarter);
        c.dynamic = Some(Dynamic::Sfz);
        let d = note(4, Step::F, DurationBase::Quarter);
        let s = score_with(vec![a, b, c, d], vec![]);
        let t = build(&s);
        assert_eq!(t.notes[0].end - t.notes[0].start, 480); // staccato: half
        assert_eq!(t.notes[0].velocity, 56); // p
        assert_eq!(t.notes[1].velocity, 56 + 16); // accent on p
        assert_eq!(t.notes[2].velocity, 120); // sfz only on its note
        assert_eq!(t.notes[3].velocity, 56); // back to p
    }

    #[test]
    fn slurred_notes_connect() {
        let mut s = score_with(
            vec![
                note(1, Step::C, DurationBase::Quarter),
                note(2, Step::D, DurationBase::Quarter),
                note(3, Step::E, DurationBase::Quarter),
            ],
            vec![],
        );
        s.slurs.push(Slur {
            id: 50,
            start: 1,
            end: 3,
        });
        let t = build(&s);
        assert_eq!(t.notes[0].end, 960);
        assert_eq!(t.notes[1].end, 1920);
        assert_eq!(t.notes[2].end, 1920 + 960 * 92 / 100); // last note of the slur
    }

    #[test]
    fn measure_rests_are_silent_and_overfull_measures_stretch() {
        let rest = Event::new(1, Duration::new(DurationBase::Whole), EventKind::Rest);
        let five: Vec<Event> = (0..5)
            .map(|i| note(10 + i, Step::A, DurationBase::Quarter))
            .collect();
        let mut s = score_with(vec![rest], five);
        s.measures[0].time = TimeSignature {
            beats: 3,
            beat_type: 4,
        };
        let t = build(&s);
        assert_eq!(t.measure_starts, vec![0, 2880]);
        assert_eq!(t.end, 2880 + 5 * 960);
        assert_eq!(t.notes.len(), 5);
    }
}
