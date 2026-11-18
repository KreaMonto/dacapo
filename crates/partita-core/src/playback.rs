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
//! - Tempo markings with a metronome value change the tempo from their
//!   measure on (no gradual changes yet).
//! - **Repeats** are played: at an end repeat the music goes back to the
//!   last start repeat (or to the beginning, or to just after the previous
//!   end repeat) until the passage has sounded the times it says. Ties and
//!   dynamics carry on in the order the measures are played. **Endings**
//!   ("1.", "2.") are played on their time through only: the n-th time,
//!   measures whose ending does not include n are skipped.
//! - **D.C. and D.S.** go back, once each, to the beginning or to the
//!   segno. After the jump, repeats are not taken again and of a group of
//!   endings only the last is played; *al Fine* stops at Fine, *al Coda*
//!   goes on from To Coda to the coda.
//! - Fermatas do not change timing yet.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::model::{
    Articulation, Dynamic, Event, EventId, Jump, Score, MAX_VOICES, TICKS_PER_QUARTER,
};

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
///
/// Ticks count along the music as it is played, repeats included: a
/// measure played twice has two stretches of time.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Timeline {
    /// Sorted by start, then key.
    pub notes: Vec<Note>,
    /// Absolute tick at which each measure is first played.
    pub measure_starts: Vec<u64>,
    /// Every measure played, in order: (absolute start tick, measure).
    pub plays: Vec<(u64, usize)>,
    /// Absolute tick of the end of the last measure.
    pub end: u64,
    /// Quarter notes per minute at the start.
    pub tempo: u16,
    /// Where the tempo changes: (absolute tick, quarter notes per minute),
    /// from tick 0, in order.
    pub tempos: Vec<(u64, u16)>,
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

    /// Where the music is at an absolute tick: (measure, tick in measure).
    /// Inside a repeat this goes back with the music.
    pub fn position(&self, abs: u64) -> (usize, u32) {
        let i = match self.plays.binary_search_by_key(&abs, |&(start, _)| start) {
            Ok(i) => i,
            Err(0) => 0,
            Err(i) => i - 1,
        };
        let (start, m) = self.plays.get(i).copied().unwrap_or((0, 0));
        (m, abs.saturating_sub(start) as u32)
    }

    /// The tempo segments: (first tick, seconds per tick).
    fn segments(&self) -> impl Iterator<Item = (u64, f64)> + '_ {
        let opening = std::iter::once((0, self.tempo))
            .filter(|_| self.tempos.first().is_none_or(|&(t, _)| t > 0));
        opening
            .chain(self.tempos.iter().copied())
            .map(|(t, bpm)| (t, 60.0 / (bpm.max(1) as f64 * TICKS_PER_QUARTER as f64)))
    }

    /// Seconds from the start of the score to an absolute tick.
    pub fn seconds_at(&self, tick: u64) -> f64 {
        let segs: Vec<(u64, f64)> = self.segments().collect();
        let mut secs = 0.0;
        for (i, &(start, per_tick)) in segs.iter().enumerate() {
            if start >= tick {
                break;
            }
            let end = segs.get(i + 1).map_or(tick, |&(next, _)| next.min(tick));
            secs += (end - start) as f64 * per_tick;
        }
        secs
    }

    /// Inverse of [`Timeline::seconds_at`]: the tick reached after `secs`.
    pub fn tick_at_seconds(&self, secs: f64) -> u64 {
        let segs: Vec<(u64, f64)> = self.segments().collect();
        let mut left = secs.max(0.0);
        for (i, &(start, per_tick)) in segs.iter().enumerate() {
            match segs.get(i + 1) {
                Some(&(next, _)) if left >= (next - start) as f64 * per_tick => {
                    left -= (next - start) as f64 * per_tick;
                }
                _ => return start + (left / per_tick) as u64,
            }
        }
        0
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

/// The measures in the order they are played, repeats unfolded.
///
/// An end repeat sends the music back to the most recent start repeat, or
/// else to just after the previous end repeat (the beginning, for the
/// first one), until the passage has been played the times it says. A
/// passage is never repeated more than [`crate::model::REPEAT_TIMES`]
/// allows, so the order always ends.
pub fn play_order(score: &Score) -> Vec<usize> {
    let n = score.measures.len();
    let mut order = Vec::with_capacity(n);
    // The last ending number of each group of endings, by measure: after a
    // D.C. or D.S. only that ending is played.
    let mut last_ending = vec![0u8; n];
    let mut i = 0;
    while i < n {
        if score.measures[i].ending.is_empty() {
            i += 1;
            continue;
        }
        let j = (i..n)
            .find(|&k| score.measures[k].ending.is_empty())
            .unwrap_or(n);
        let top = (i..j)
            .flat_map(|k| score.measures[k].ending.iter().copied())
            .max()
            .unwrap_or(0);
        last_ending[i..j].fill(top);
        i = j;
    }
    let segno = score.measures.iter().position(|a| a.segno);
    let coda = score.measures.iter().position(|a| a.coda);
    // After a D.C. or D.S.: whether it was al Fine or al Coda.
    let mut jumped: Option<Jump> = None;
    let mut jumps_taken: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut start = 0;
    // How many times each end repeat has sent the music back.
    let mut sent_back: HashMap<usize, u8> = HashMap::new();
    // Which time through the current repeated passage this is (1, 2…), for
    // the endings; back to 1 once the music is past them.
    let mut pass: u8 = 1;
    let mut in_endings = false;
    let mut m = 0;
    while m < n {
        let attrs = &score.measures[m];
        if attrs.ending.is_empty() {
            if in_endings {
                // Past the endings: what follows starts afresh.
                in_endings = false;
                pass = 1;
                start = m;
            }
        } else {
            in_endings = true;
            let wanted = if jumped.is_some() {
                last_ending[m]
            } else {
                pass
            };
            if !attrs.ending.contains(&wanted) {
                // Not this time through: skipped, end repeat and all.
                m += 1;
                continue;
            }
        }
        if attrs.repeat_start && !sent_back.contains_key(&m) {
            start = m;
        }
        order.push(m);
        // Where the music ends or leaves for the coda, after a jump.
        match (attrs.jump, jumped) {
            (Some(Jump::Fine), Some(Jump::DaCapoAlFine | Jump::DalSegnoAlFine)) => break,
            (Some(Jump::ToCoda), Some(Jump::DaCapoAlCoda | Jump::DalSegnoAlCoda)) => {
                if let Some(c) = coda.filter(|&c| c > m) {
                    jumped = Some(Jump::DaCapo); // in the coda: no more jumps
                    m = c;
                    continue;
                }
            }
            (Some(j), _) if j.is_jump() && !jumps_taken.contains(&m) => {
                jumps_taken.insert(m);
                jumped = Some(j);
                in_endings = false;
                m = match j {
                    Jump::DalSegno | Jump::DalSegnoAlFine | Jump::DalSegnoAlCoda => {
                        segno.unwrap_or(0)
                    }
                    _ => 0,
                };
                continue;
            }
            _ => {}
        }
        // After a jump, repeats are not taken again.
        if jumped.is_some() {
            m += 1;
            continue;
        }
        if let Some(times) = attrs.repeat_end {
            let done = sent_back.entry(m).or_insert(0);
            if *done + 1 < times.max(1) {
                *done += 1;
                pass = pass.saturating_add(1);
                // Back to the start of the passage, out of the endings.
                in_endings = false;
                m = start;
                continue;
            }
            // Played enough: what follows can be repeated on its own.
            start = m + 1;
            if !in_endings {
                pass = 1;
            }
        }
        m += 1;
    }
    order
}

/// Builds the playback timeline of a score.
pub fn build(score: &Score) -> Timeline {
    // Measure lengths: the time signature, stretched if a voice overflows.
    let mut lengths = Vec::with_capacity(score.measures.len());
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
        lengths.push(capacity.max(longest) as u64);
    }
    // The measures as played, each with its start.
    let order = play_order(score);
    let mut plays = Vec::with_capacity(order.len());
    let mut measure_starts: Vec<Option<u64>> = vec![None; score.measures.len()];
    let mut t = 0u64;
    for &m in &order {
        plays.push((t, m));
        measure_starts[m].get_or_insert(t);
        t += lengths[m];
    }
    let measure_starts: Vec<u64> = measure_starts.into_iter().map(|s| s.unwrap_or(t)).collect();

    let slurred = slurred_events(score);
    let mut notes: Vec<Note> = Vec::new();

    for (s, staff) in score.staves.iter().enumerate() {
        for v in 0..MAX_VOICES {
            let mut velocity = DEFAULT_VELOCITY;
            // Notes still tied into the next event: key -> index in `notes`.
            let mut open_ties: HashMap<u8, usize> = HashMap::new();
            for &(play_start, m) in &plays {
                let events = &staff.measures[m].voices[v];
                let capacity = score.measures[m].time.measure_ticks();
                if crate::model::is_measure_rest(events, capacity) {
                    open_ties.clear();
                    continue;
                }
                let mut at = play_start;
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
                        // Transposing instruments sound away from the written note.
                        let key = staff.transposition.sounding_midi(*p).clamp(0, 127) as u8;
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
    // Tempo changes where the tempo of the measure played differs from the
    // one before (going back to a repeat brings back its tempo).
    let mut tempos: Vec<(u64, u16)> = Vec::new();
    for &(start, m) in &plays {
        let bpm = score.tempo_at(m);
        if tempos.last().is_none_or(|&(_, last)| last != bpm) {
            tempos.push((start, bpm));
        }
    }
    Timeline {
        notes,
        measure_starts,
        plays,
        end: t,
        tempo: score.tempo,
        tempos,
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
    fn repeats_are_played_and_the_playhead_goes_back() {
        // | 0 | 1 :| 2 |: 3 :|x3 4 |
        let mut s = Score::new("t", 5);
        for m in 0..5 {
            s.staves[0].measures[m].voices[0] =
                vec![note(m as u64 + 1, Step::C, DurationBase::Whole)];
        }
        s.measures[1].repeat_end = Some(2);
        s.measures[3].repeat_start = true;
        s.measures[3].repeat_end = Some(3);
        assert_eq!(play_order(&s), vec![0, 1, 0, 1, 2, 3, 3, 3, 4]);
        let tl = build(&s);
        let bar = TimeSignature::COMMON.measure_ticks() as u64;
        assert_eq!(tl.notes.len(), 9, "one note per measure played");
        assert_eq!(tl.end, 9 * bar);
        // The third measure played is measure 0 again; playback from the
        // caret starts where a measure is first played.
        assert_eq!(tl.position(2 * bar + 10), (0, 10));
        assert_eq!(tl.position(6 * bar), (3, 0));
        assert_eq!(tl.tick_at(4, 0), 8 * bar);
    }

    #[test]
    fn first_and_second_endings_are_played_on_their_time() {
        // |: 0 | 1 |1.[ 2 :|] 2.[ 3 ] | 4
        let mut s = Score::new("t", 5);
        s.measures[0].repeat_start = true;
        s.measures[2].ending = vec![1];
        s.measures[2].repeat_end = Some(2);
        s.measures[3].ending = vec![2];
        assert_eq!(play_order(&s), vec![0, 1, 2, 0, 1, 3, 4]);
        // 1.–2. then 3.: the first ending is played twice.
        let mut s = Score::new("t", 4);
        s.measures[1].ending = vec![1, 2];
        s.measures[1].repeat_end = Some(3);
        s.measures[2].ending = vec![3];
        assert_eq!(play_order(&s), vec![0, 1, 0, 1, 0, 2, 3]);
        // A later repeat after the endings starts afresh.
        let mut s = Score::new("t", 5);
        s.measures[1].ending = vec![1];
        s.measures[1].repeat_end = Some(2);
        s.measures[2].ending = vec![2];
        s.measures[4].repeat_end = Some(2);
        assert_eq!(play_order(&s), vec![0, 1, 0, 2, 3, 4, 3, 4]);
    }

    #[test]
    fn jumps_are_followed() {
        // 0 | 1 Fine | 2 | 3 D.C. al Fine  →  0 1 2 3 0 1
        let mut s = Score::new("t", 4);
        s.measures[1].jump = Some(Jump::Fine);
        s.measures[3].jump = Some(Jump::DaCapoAlFine);
        assert_eq!(play_order(&s), vec![0, 1, 2, 3, 0, 1]);
        // 0 | 𝄋1 | 2 To Coda | 3 D.S. al Coda | 𝄌4 | 5  →  0 1 2 3 1 2 4 5
        let mut s = Score::new("t", 6);
        s.measures[1].segno = true;
        s.measures[2].jump = Some(Jump::ToCoda);
        s.measures[3].jump = Some(Jump::DalSegnoAlCoda);
        s.measures[4].coda = true;
        assert_eq!(play_order(&s), vec![0, 1, 2, 3, 1, 2, 4, 5]);
        // Without "al Coda", To Coda is played through and the coda follows.
        s.measures[3].jump = Some(Jump::DalSegno);
        assert_eq!(play_order(&s), vec![0, 1, 2, 3, 1, 2, 3, 4, 5]);
    }

    #[test]
    fn after_a_jump_repeats_are_not_taken_and_the_last_ending_plays() {
        // |: 0 |1.[ 1 :|] 2.[ 2 ] | 3 D.C.  →  0 1 0 2 3, then 0 2 3
        let mut s = Score::new("t", 4);
        s.measures[0].repeat_start = true;
        s.measures[1].ending = vec![1];
        s.measures[1].repeat_end = Some(2);
        s.measures[2].ending = vec![2];
        s.measures[3].jump = Some(Jump::DaCapo);
        assert_eq!(play_order(&s), vec![0, 1, 0, 2, 3, 0, 2, 3]);
    }

    #[test]
    fn an_end_repeat_without_a_start_goes_back_to_the_beginning() {
        let mut s = Score::new("t", 3);
        s.measures[2].repeat_end = Some(2);
        assert_eq!(play_order(&s), vec![0, 1, 2, 0, 1, 2]);
        // Without repeats, the order is the score's.
        s.measures[2].repeat_end = None;
        assert_eq!(play_order(&s), vec![0, 1, 2]);
    }

    #[test]
    fn a_tie_carries_on_into_the_repeat() {
        let mut s = Score::new("t", 2);
        let mut tied = note(1, Step::C, DurationBase::Whole);
        tied.tie = true;
        s.staves[0].measures[0].voices[0] = vec![note(2, Step::E, DurationBase::Whole)];
        s.staves[0].measures[1].voices[0] = vec![tied];
        s.measures[1].repeat_end = Some(2);
        // Measures played: 0 1 0 1. The tie of measure 1 goes on to what is
        // played next (measure 0's E), which is another pitch: no merge.
        let tl = build(&s);
        assert_eq!(tl.notes.len(), 4);
    }

    #[test]
    fn tempo_markings_change_the_tempo_from_their_measure() {
        let mut s = Score::new("t", 3);
        s.tempo = 60; // one quarter per second
        s.measures[1].tempo = Some(TempoMark {
            text: "Allegro".into(),
            bpm: Some(120),
            ..TempoMark::default()
        });
        // Words alone keep the tempo.
        s.measures[2].tempo = Some(TempoMark {
            text: "dolce".into(),
            ..TempoMark::default()
        });
        let t = build(&s);
        let (bar2, bar3) = (t.measure_starts[1], t.measure_starts[2]);
        assert_eq!(t.tempos, vec![(0, 60), (bar2, 120)]);
        // 4/4: the first measure lasts 4 s, the others 2 s each.
        assert!((t.seconds_at(bar2) - 4.0).abs() < 1e-9);
        assert!((t.seconds_at(bar3) - 6.0).abs() < 1e-9);
        assert!((t.seconds_at(t.end) - 8.0).abs() < 1e-9);
        assert_eq!(t.tick_at_seconds(5.0), bar2 + 2 * TICKS_PER_QUARTER as u64);
        assert_eq!(t.tick_at_seconds(2.0), 2 * TICKS_PER_QUARTER as u64);
        // In the first measure the opening tempo rules.
        s.measures[0].tempo = Some(TempoMark {
            bpm: Some(200),
            ..TempoMark::default()
        });
        assert_eq!(build(&s).tempos[0], (0, 60));
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
