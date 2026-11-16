//! Text-editor style caret and selection.
//!
//! The caret sits *between* events of one voice, exactly like a text cursor
//! sits between characters: `index == 0` is before the first event of the
//! measure and `index == len` is after the last one.
//!
//! A selection is the region between an anchor caret and the current caret.
//! When it spans several staves it is interpreted by musical time, so a
//! rectangle dragged over a piano system selects the same beats in both
//! hands.

use serde::{Deserialize, Serialize};

use crate::model::{Event, Score};
use crate::ops::VoiceLoc;

/// Insertion point.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Caret {
    pub staff: usize,
    pub measure: usize,
    pub voice: usize,
    pub index: usize,
}

impl Caret {
    pub fn loc(&self) -> VoiceLoc {
        VoiceLoc {
            staff: self.staff,
            measure: self.measure,
            voice: self.voice,
        }
    }
}

/// Caret movements (all of them can extend the selection with Shift).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Move {
    Left,
    Right,
    /// Staff above.
    Up,
    /// Staff below.
    Down,
    MeasureStart,
    MeasureEnd,
    NextMeasure,
    PrevMeasure,
    ScoreStart,
    ScoreEnd,
}

/// A point in musical time: measure plus ticks from its start.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct TimePos {
    pub measure: usize,
    pub tick: u32,
}

/// The resolved selection region.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectionRange {
    pub staff_lo: usize,
    pub staff_hi: usize,
    pub voice: usize,
    /// Inclusive start.
    pub start: TimePos,
    /// Exclusive end.
    pub end: TimePos,
}

fn events<'a>(score: &'a Score, staff: usize, measure: usize, voice: usize) -> &'a [Event] {
    score
        .voice(staff, measure, voice)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// Number of events in the caret's voice.
pub fn voice_len(score: &Score, staff: usize, measure: usize, voice: usize) -> usize {
    events(score, staff, measure, voice).len()
}

/// Tick at which the event at `index` starts (or the end of the voice).
pub fn tick_at(score: &Score, staff: usize, measure: usize, voice: usize, index: usize) -> u32 {
    events(score, staff, measure, voice)
        .iter()
        .take(index)
        .map(Event::ticks)
        .sum()
}

/// First index whose event starts at or after `tick`.
pub fn index_at_tick(
    score: &Score,
    staff: usize,
    measure: usize,
    voice: usize,
    tick: u32,
) -> usize {
    let mut t = 0;
    for (i, e) in events(score, staff, measure, voice).iter().enumerate() {
        if t >= tick {
            return i;
        }
        t += e.ticks();
    }
    events(score, staff, measure, voice).len()
}

/// Musical time of a caret.
pub fn time_of(score: &Score, c: &Caret) -> TimePos {
    TimePos {
        measure: c.measure,
        tick: tick_at(score, c.staff, c.measure, c.voice, c.index),
    }
}

/// Clamps a caret into the current score layout.
pub fn clamp(score: &Score, mut c: Caret) -> Caret {
    c.staff = c.staff.min(score.staves.len().saturating_sub(1));
    c.measure = c.measure.min(score.measures.len().saturating_sub(1));
    c.voice = c.voice.min(crate::model::MAX_VOICES - 1);
    c.index = c.index.min(voice_len(score, c.staff, c.measure, c.voice));
    c
}

/// Computes where a caret ends up after a movement.
pub fn moved(score: &Score, c: Caret, mv: Move) -> Caret {
    let c = clamp(score, c);
    let len = |m: usize| voice_len(score, c.staff, m, c.voice);
    let last_measure = score.measures.len() - 1;
    let out = match mv {
        Move::Left if c.index > 0 => Caret {
            index: c.index - 1,
            ..c
        },
        Move::Left if c.measure > 0 => Caret {
            measure: c.measure - 1,
            index: len(c.measure - 1),
            ..c
        },
        Move::Left => c,
        Move::Right if c.index < len(c.measure) => Caret {
            index: c.index + 1,
            ..c
        },
        Move::Right if c.measure < last_measure => Caret {
            measure: c.measure + 1,
            index: 0,
            ..c
        },
        Move::Right => c,
        Move::Up | Move::Down => {
            let staff = if mv == Move::Up {
                c.staff.saturating_sub(1)
            } else {
                (c.staff + 1).min(score.staves.len() - 1)
            };
            let tick = tick_at(score, c.staff, c.measure, c.voice, c.index);
            Caret {
                staff,
                index: index_at_tick(score, staff, c.measure, c.voice, tick),
                ..c
            }
        }
        Move::MeasureStart => Caret { index: 0, ..c },
        Move::MeasureEnd => Caret {
            index: len(c.measure),
            ..c
        },
        Move::NextMeasure if c.measure < last_measure => Caret {
            measure: c.measure + 1,
            index: 0,
            ..c
        },
        Move::NextMeasure => Caret {
            index: len(c.measure),
            ..c
        },
        Move::PrevMeasure if c.index > 0 => Caret { index: 0, ..c },
        Move::PrevMeasure if c.measure > 0 => Caret {
            measure: c.measure - 1,
            index: 0,
            ..c
        },
        Move::PrevMeasure => c,
        Move::ScoreStart => Caret {
            measure: 0,
            index: 0,
            ..c
        },
        Move::ScoreEnd => Caret {
            measure: last_measure,
            index: len(last_measure),
            ..c
        },
    };
    clamp(score, out)
}

/// Resolves anchor + caret into a region. `None` when nothing is selected.
pub fn selection_range(score: &Score, anchor: &Caret, head: &Caret) -> Option<SelectionRange> {
    let a = time_of(score, anchor);
    let h = time_of(score, head);
    if a == h && anchor.staff == head.staff {
        return None;
    }
    let (start, end) = if a <= h { (a, h) } else { (h, a) };
    if start == end {
        // Same instant on different staves: nothing rhythmic is covered.
        return None;
    }
    Some(SelectionRange {
        staff_lo: anchor.staff.min(head.staff),
        staff_hi: anchor.staff.max(head.staff),
        voice: head.voice,
        start,
        end,
    })
}

/// Every event covered by a range, as (voice, index), in score order.
pub fn events_in_range(score: &Score, r: &SelectionRange) -> Vec<(VoiceLoc, usize)> {
    let mut out = Vec::new();
    for staff in r.staff_lo..=r.staff_hi.min(score.staves.len().saturating_sub(1)) {
        for measure in r.start.measure..=r.end.measure.min(score.measures.len().saturating_sub(1)) {
            let mut tick = 0;
            for (i, e) in events(score, staff, measure, r.voice).iter().enumerate() {
                let pos = TimePos { measure, tick };
                if pos >= r.start && pos < r.end {
                    out.push((
                        VoiceLoc {
                            staff,
                            measure,
                            voice: r.voice,
                        },
                        i,
                    ));
                }
                tick += e.ticks();
            }
        }
    }
    out
}
