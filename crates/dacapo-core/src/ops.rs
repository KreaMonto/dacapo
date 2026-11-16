//! Primitive, invertible edit operations.
//!
//! Every change to a [`Score`] goes through an [`Op`]. Applying an op returns
//! its exact inverse, which is what powers undo/redo. Ops are serializable so
//! they can be written to the crash-recovery journal and replayed later.
//! Replay is deterministic: ops carry every identifier they create.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::model::{
    Clef, Event, MeasureAttrs, Metadata, Score, Slur, Staff, StaffMeasure, MAX_VOICES,
};

/// Address of one voice inside one measure of one staff.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct VoiceLoc {
    pub staff: usize,
    pub measure: usize,
    pub voice: usize,
}

/// An atomic, invertible change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    InsertEvent {
        at: VoiceLoc,
        index: usize,
        event: Event,
    },
    RemoveEvent {
        at: VoiceLoc,
        index: usize,
    },
    ReplaceEvent {
        at: VoiceLoc,
        index: usize,
        event: Event,
    },
    /// Inserts a measure column. `contents` holds one cell per staff, or is
    /// empty to insert blank cells.
    InsertMeasure {
        index: usize,
        attrs: MeasureAttrs,
        contents: Vec<StaffMeasure>,
    },
    RemoveMeasure {
        index: usize,
    },
    SetMeasureAttrs {
        index: usize,
        attrs: MeasureAttrs,
    },
    InsertStaff {
        index: usize,
        staff: Staff,
    },
    RemoveStaff {
        index: usize,
    },
    SetStaffClef {
        staff: usize,
        clef: Clef,
    },
    SetStaffName {
        staff: usize,
        name: String,
    },
    SetMetadata {
        metadata: Metadata,
    },
    /// Inserts a slur at `index` in `Score::slurs`. Its events need not
    /// exist yet (undoing a deletion restores slurs before their events).
    AddSlur {
        index: usize,
        slur: Slur,
    },
    RemoveSlur {
        index: usize,
    },
    SetTempo {
        bpm: u16,
    },
}

/// Why an op could not be applied. The score is left untouched.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum OpError {
    #[error("no such voice: {0:?}")]
    NoSuchVoice(VoiceLoc),
    #[error("event index {index} out of range (voice has {len} events)")]
    EventIndex { index: usize, len: usize },
    #[error("measure index {0} out of range")]
    MeasureIndex(usize),
    #[error("staff index {0} out of range")]
    StaffIndex(usize),
    #[error("a score needs at least one {0}")]
    LastOne(&'static str),
    #[error("inserted data does not match the score layout: {0}")]
    Shape(&'static str),
    #[error("invalid time signature")]
    InvalidTime,
    #[error("slur index {0} out of range")]
    SlurIndex(usize),
    #[error("tempo {0} is outside 20–400 quarter notes per minute")]
    InvalidTempo(u16),
}

fn voice_mut(score: &mut Score, at: VoiceLoc) -> Result<&mut Vec<Event>, OpError> {
    if at.voice >= MAX_VOICES {
        return Err(OpError::NoSuchVoice(at));
    }
    score
        .voice_mut(at.staff, at.measure, at.voice)
        .ok_or(OpError::NoSuchVoice(at))
}

fn check_staff_measure(cell: &StaffMeasure) -> Result<(), OpError> {
    if cell.voices.len() == MAX_VOICES {
        Ok(())
    } else {
        Err(OpError::Shape("wrong number of voices"))
    }
}

impl Op {
    /// Applies the op and returns the op that undoes it.
    pub fn apply(&self, score: &mut Score) -> Result<Op, OpError> {
        match self {
            Op::InsertEvent { at, index, event } => {
                let id = event.id;
                let voice = voice_mut(score, *at)?;
                if *index > voice.len() {
                    return Err(OpError::EventIndex {
                        index: *index,
                        len: voice.len(),
                    });
                }
                voice.insert(*index, event.clone());
                score.reserve_id(id);
                Ok(Op::RemoveEvent {
                    at: *at,
                    index: *index,
                })
            }
            Op::RemoveEvent { at, index } => {
                let voice = voice_mut(score, *at)?;
                if *index >= voice.len() {
                    return Err(OpError::EventIndex {
                        index: *index,
                        len: voice.len(),
                    });
                }
                let event = voice.remove(*index);
                Ok(Op::InsertEvent {
                    at: *at,
                    index: *index,
                    event,
                })
            }
            Op::ReplaceEvent { at, index, event } => {
                let id = event.id;
                let voice = voice_mut(score, *at)?;
                let len = voice.len();
                let slot = voice
                    .get_mut(*index)
                    .ok_or(OpError::EventIndex { index: *index, len })?;
                let old = std::mem::replace(slot, event.clone());
                score.reserve_id(id);
                Ok(Op::ReplaceEvent {
                    at: *at,
                    index: *index,
                    event: old,
                })
            }
            Op::InsertMeasure {
                index,
                attrs,
                contents,
            } => {
                if *index > score.measures.len() {
                    return Err(OpError::MeasureIndex(*index));
                }
                if !attrs.time.is_valid() {
                    return Err(OpError::InvalidTime);
                }
                if !contents.is_empty() {
                    if contents.len() != score.staves.len() {
                        return Err(OpError::Shape("one cell per staff expected"));
                    }
                    contents.iter().try_for_each(check_staff_measure)?;
                }
                for (s, staff) in score.staves.iter_mut().enumerate() {
                    let cell = contents.get(s).cloned().unwrap_or_default();
                    staff.measures.insert(*index, cell);
                }
                score.measures.insert(*index, *attrs);
                let max_id = contents
                    .iter()
                    .flat_map(|c| c.voices.iter().flatten())
                    .map(|e| e.id)
                    .max();
                if let Some(id) = max_id {
                    score.reserve_id(id);
                }
                Ok(Op::RemoveMeasure { index: *index })
            }
            Op::RemoveMeasure { index } => {
                if *index >= score.measures.len() {
                    return Err(OpError::MeasureIndex(*index));
                }
                if score.measures.len() == 1 {
                    return Err(OpError::LastOne("measure"));
                }
                let attrs = score.measures.remove(*index);
                let contents = score
                    .staves
                    .iter_mut()
                    .map(|staff| staff.measures.remove(*index))
                    .collect();
                Ok(Op::InsertMeasure {
                    index: *index,
                    attrs,
                    contents,
                })
            }
            Op::SetMeasureAttrs { index, attrs } => {
                if !attrs.time.is_valid() {
                    return Err(OpError::InvalidTime);
                }
                let slot = score
                    .measures
                    .get_mut(*index)
                    .ok_or(OpError::MeasureIndex(*index))?;
                let old = std::mem::replace(slot, *attrs);
                Ok(Op::SetMeasureAttrs {
                    index: *index,
                    attrs: old,
                })
            }
            Op::InsertStaff { index, staff } => {
                if *index > score.staves.len() {
                    return Err(OpError::StaffIndex(*index));
                }
                if staff.measures.len() != score.measures.len() {
                    return Err(OpError::Shape("staff must have one cell per measure"));
                }
                staff.measures.iter().try_for_each(check_staff_measure)?;
                let max_id = staff
                    .measures
                    .iter()
                    .flat_map(|c| c.voices.iter().flatten())
                    .map(|e| e.id)
                    .chain(std::iter::once(staff.id))
                    .max();
                score.staves.insert(*index, staff.clone());
                if let Some(id) = max_id {
                    score.reserve_id(id);
                }
                Ok(Op::RemoveStaff { index: *index })
            }
            Op::RemoveStaff { index } => {
                if *index >= score.staves.len() {
                    return Err(OpError::StaffIndex(*index));
                }
                if score.staves.len() == 1 {
                    return Err(OpError::LastOne("staff"));
                }
                let staff = score.staves.remove(*index);
                Ok(Op::InsertStaff {
                    index: *index,
                    staff,
                })
            }
            Op::SetStaffClef { staff, clef } => {
                let s = score
                    .staves
                    .get_mut(*staff)
                    .ok_or(OpError::StaffIndex(*staff))?;
                let old = std::mem::replace(&mut s.clef, *clef);
                Ok(Op::SetStaffClef {
                    staff: *staff,
                    clef: old,
                })
            }
            Op::SetStaffName { staff, name } => {
                let s = score
                    .staves
                    .get_mut(*staff)
                    .ok_or(OpError::StaffIndex(*staff))?;
                let old = std::mem::replace(&mut s.name, name.clone());
                Ok(Op::SetStaffName {
                    staff: *staff,
                    name: old,
                })
            }
            Op::SetMetadata { metadata } => {
                let old = std::mem::replace(&mut score.metadata, metadata.clone());
                Ok(Op::SetMetadata { metadata: old })
            }
            Op::AddSlur { index, slur } => {
                if *index > score.slurs.len() {
                    return Err(OpError::SlurIndex(*index));
                }
                score.slurs.insert(*index, *slur);
                score.reserve_id(slur.id);
                Ok(Op::RemoveSlur { index: *index })
            }
            Op::RemoveSlur { index } => {
                if *index >= score.slurs.len() {
                    return Err(OpError::SlurIndex(*index));
                }
                let slur = score.slurs.remove(*index);
                Ok(Op::AddSlur {
                    index: *index,
                    slur,
                })
            }
            Op::SetTempo { bpm } => {
                if !crate::model::TEMPO_RANGE.contains(bpm) {
                    return Err(OpError::InvalidTempo(*bpm));
                }
                let old = std::mem::replace(&mut score.tempo, *bpm);
                Ok(Op::SetTempo { bpm: old })
            }
        }
    }
}

/// Applies ops in order. If one fails, every op already applied is rolled
/// back and the score is left exactly as it was. On success returns the
/// inverse ops in the order they must be applied to undo the whole batch.
pub fn apply_all(score: &mut Score, ops: &[Op]) -> Result<Vec<Op>, OpError> {
    let mut inverses = Vec::with_capacity(ops.len());
    for op in ops {
        match op.apply(score) {
            Ok(inv) => inverses.push(inv),
            Err(e) => {
                for inv in inverses.iter().rev() {
                    inv.apply(score)
                        .expect("rollback of a just-applied op cannot fail");
                }
                return Err(e);
            }
        }
    }
    inverses.reverse();
    Ok(inverses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn note(id: u64, step: Step) -> Event {
        Event::new(
            id,
            Duration::new(DurationBase::Quarter),
            EventKind::Chord {
                pitches: vec![Pitch::new(step, 4)],
            },
        )
    }

    const V0: VoiceLoc = VoiceLoc {
        staff: 0,
        measure: 0,
        voice: 0,
    };

    #[test]
    fn every_op_round_trips() {
        let mut score = Score::new("t", 2);
        let staff = score.blank_staff("Bass", Clef::Bass);
        let original = score.clone();
        let ops = vec![
            Op::InsertEvent {
                at: V0,
                index: 0,
                event: note(100, Step::C),
            },
            Op::InsertEvent {
                at: V0,
                index: 1,
                event: note(101, Step::D),
            },
            Op::ReplaceEvent {
                at: V0,
                index: 0,
                event: note(102, Step::E),
            },
            Op::RemoveEvent { at: V0, index: 1 },
            Op::InsertStaff { index: 1, staff },
            Op::InsertMeasure {
                index: 1,
                attrs: MeasureAttrs::default(),
                contents: vec![],
            },
            Op::SetMeasureAttrs {
                index: 0,
                attrs: MeasureAttrs {
                    time: TimeSignature {
                        beats: 3,
                        beat_type: 4,
                    },
                    key: KeySignature { fifths: 2 },
                },
            },
            Op::SetStaffClef {
                staff: 0,
                clef: Clef::Alto,
            },
            Op::SetStaffName {
                staff: 0,
                name: "Violin".into(),
            },
            Op::SetMetadata {
                metadata: Metadata {
                    title: "x".into(),
                    composer: "y".into(),
                },
            },
            Op::RemoveMeasure { index: 2 },
            Op::RemoveStaff { index: 0 },
            Op::AddSlur {
                index: 0,
                slur: Slur {
                    id: 900,
                    start: 1,
                    end: 2,
                },
            },
            Op::AddSlur {
                index: 0,
                slur: Slur {
                    id: 901,
                    start: 3,
                    end: 4,
                },
            },
            Op::RemoveSlur { index: 1 },
            Op::SetTempo { bpm: 132 },
        ];
        let inverses = apply_all(&mut score, &ops).unwrap();
        assert!(score.validate().is_empty());
        assert_ne!(score, original);
        apply_all(&mut score, &inverses).unwrap();
        // next_id is a high-water mark and intentionally never goes back.
        score.next_id = original.next_id;
        assert_eq!(score, original);
    }

    #[test]
    fn failed_batch_rolls_back() {
        let mut score = Score::new("t", 1);
        let before = score.clone();
        let ops = vec![
            Op::InsertEvent {
                at: V0,
                index: 0,
                event: note(100, Step::C),
            },
            Op::RemoveEvent { at: V0, index: 5 },
        ];
        assert!(apply_all(&mut score, &ops).is_err());
        score.next_id = before.next_id;
        assert_eq!(score, before);
    }

    #[test]
    fn cannot_remove_last_staff_or_measure() {
        let mut score = Score::new("t", 1);
        assert_eq!(
            Op::RemoveStaff { index: 0 }.apply(&mut score),
            Err(OpError::LastOne("staff"))
        );
        assert_eq!(
            Op::RemoveMeasure { index: 0 }.apply(&mut score),
            Err(OpError::LastOne("measure"))
        );
    }

    #[test]
    fn inserted_ids_are_reserved() {
        let mut score = Score::new("t", 1);
        Op::InsertEvent {
            at: V0,
            index: 0,
            event: note(500, Step::C),
        }
        .apply(&mut score)
        .unwrap();
        assert!(score.alloc_id() > 500);
    }
}
