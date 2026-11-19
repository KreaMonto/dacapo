# QA before a release

Hand tests in the **real app** (an installed or `cargo tauri build` build, not the browser preview: its backend is a stand-in and behaves differently). Each test has a code; report the ones that fail by code, with what happened.

Written for 0.4 (sections 0 and 1 of [NOTATION_PLAN.md](NOTATION_PLAN.md)); add a block for each new feature, and run them all before every release.

**Before you start:** a new score with two staves (treble and bass), and later a large one (see P1).

## A. Toolbars and layouts

- [ ] **A1** Every bar has a grip (⋮⋮). Drag the Figures bar to the right side, then back: it lands where the line shows, and the rest move aside.
- [ ] **A2** Drag a bar onto the dashed strip at the edge of a side: a new row or column opens. Empty it: it disappears.
- [ ] **A3** Make the window short: the last bars of a column go behind **»**; clicking » shows them and they work.
- [ ] **A4** **View → Toolbars**: hide the Dynamics bar; it stays hidden after closing and reopening Partita.
- [ ] **A5** Save the arrangement as a layout ("Test"), move a bar, choose **Partita**, then "Test" again: each comes back as it was. Delete "Test": the bars go back to Partita's layout.
- [ ] **A6** **Reset Toolbars**: everything as when installed.
- [ ] **A7** Every button shows a tooltip with its name, its bar's name and its shortcut; drop-downs (dynamics, ornaments, tuplet, grace note, 8va, rit., barline, ending, jumps) open beside the button, close with Esc, and remember the last choice.

## S. Structure

- [ ] **S1** Barlines: double, final, dashed on a measure and on a selection of measures; one undo step each.
- [ ] **S2** Repeats: start and end repeat, ×3 on the end repeat. Play: the passage sounds three times and the playhead goes back with it.
- [ ] **S3** First and second endings: 1. on a measure (it gets its end repeat), 2. on the next. Play: the first ending, then the second.
- [ ] **S4** D.C. al Fine, D.S. al Coda with segno, To Coda and coda: playback follows them.
- [ ] **S5** Pickup: **Score → Measure → Length…** on measure 1 to a quarter: it is not numbered, the next one is 1, and it plays only a quarter.
- [ ] **S6** System and page breaks: the line (or page) ends there in page view; the ↵ / ⇟ mark is not printed.

## R. Rhythm

- [ ] **R1** **Ctrl+3**, then C D E as eighths: a triplet with a 3 over its beam. The measure is not too full after a quarter's worth.
- [ ] **R2** A quarter and an eighth in a triplet of eighths (turn the triplet on with the eighth chosen, then choose the quarter): a bracket with 3.
- [ ] **R3** Quintuplet of sixteenths from the Tuplet drop-down; the status bar says "16th (quintuplet)".
- [ ] **R4** **Ctrl+G**, D, Ctrl+G, then a half C: a small struck-through eighth before the C; it takes no time in the measure. Play: a quick D before the C.
- [ ] **R5** **Ctrl+Shift+G**: appoggiaturas (no stroke); two or more short ones are beamed together. Play: the grace note takes half of the next note.
- [ ] **R6** Eight eighths in 4/4: two groups of four. **Break Beam** on the third: C D | E F, G A B C. **Join Beam** on the fifth (after a break): joined across the beat. **auto** brings it back.

## C. Clefs and pitch

- [ ] **C1** Caret in measure 3, Clef → Bass: a small bass clef at measure 3, notes there read in bass. The selector shows the clef at the caret. Clef → Treble at measure 3 again: the change goes away.
- [ ] **C2** Clef in measure 1 changes the staff's own clef.
- [ ] **C3** Select four notes, **8va**: dashed line with "8va" and a hook; the notes are drawn an octave lower and **sound the same** as before. The same again removes it. 8vb, 15ma, 15mb likewise.
- [ ] **C4** An 8va over two systems: the second starts with "(8va)".
- [ ] **C5** With the mouse, place a note under an 8va: it sounds an octave above where you clicked.
- [ ] **C6** **J** on an F♯: G♭, then E𝄪, then F♯ again. On a C: B♯ (an octave lower in the name), D𝄫, C. The sound never changes.

## L. Lines

- [ ] **L1** Select four notes, **crescendo** (Dynamics bar): a hairpin under them. Play: louder along it, and the next notes stay louder; with *p* on the note after, they are soft.
- [ ] **L2** **diminuendo** over the same notes replaces the crescendo.
- [ ] **L3** **tr** on one note: "tr"; over several: tr and a wavy line. Play: trilled with the note above (in the key).
- [ ] **L4** **Glissando** on the note before the caret: a line to the next note.
- [ ] **L5** **rit.** over a measure: "rit." and dashes. Play: slows down along it and stays slow; a tempo marking after it brings the tempo back. **accel.** likewise, faster.
- [ ] **L6** Delete the last note of any line: the line goes; undo brings both back.

## O. Ornaments and other marks

- [ ] **O1** From the Ornaments drop-down: mordent, lower mordent and turn above notes; play them.
- [ ] **O2** Tremolo 1, 2, 3 strokes on a quarter: strokes across the stem; play: eighths, sixteenths, thirty-seconds.
- [ ] **O3** Two quarters, **Tremolo Between Two Notes** (caret after the second): they become halves with three strokes between them; the measure still adds up. Again: back to quarters.
- [ ] **O4** Arpeggio on a chord: wavy line on its left; play: rolled upwards.
- [ ] **O5** Breath mark and caesura after a note: the comma and the // ; play: the note shorter.
- [ ] **O6** Choose an ornament with no selection, then click a note: it goes there (as with articulations).

## T. Texts (from 0.3.14, quick check)

- [ ] **T1** Titles, header and footer: click and change them on the page.
- [ ] **T2** Tempo marking, expression (Ctrl+E), technique, rehearsal mark, text box (T): all still drawn and editable.
- [ ] **T3** Lyrics (Ctrl+L): type a few syllables with hyphens; grace notes are skipped.

## X. MusicXML

- [ ] **X1** Export a score using everything above, import it again: everything is back (except manual beams, which are worked out again).
- [ ] **X2** Import a file from MuseScore or Finale with triplets, grace notes, clef changes, hairpins, 8va, trills: they come in; the message lists only what is really left out (septuplets, clef changes inside a measure, voices beyond four).
- [ ] **X3** Open the exported file in MuseScore: it looks right there too.

## F. Files and recovery

- [ ] **F1** Save, close, open: everything is as it was.
- [ ] **F2** A score with any of the new things (a triplet, an 8va…) saved by 0.4, opened in 0.3.14: a clear message that it needs a newer Partita (not a crash).
- [ ] **F3** A score with none of them saved by 0.4 opens in 0.3.14.
- [ ] **F4** Unsaved work, then end Partita from the Task Manager: on the next start it offers to bring the work back, and it is complete.
- [ ] **F5** Update from 0.3.14 with unsaved work open: after the update the work is brought back.

## P. Playback and performance

- [ ] **P1** A large score (an orchestral or choral MusicXML, 20+ staves, 100+ measures): typing a note feels immediate; scrolling and zooming are smooth. Note how long a keystroke takes to show if it is not.
- [ ] **P2** Play it from the start and from the middle (Space, Shift+Space): in time, the playhead follows, repeats and jumps work.

## E. Spanish

- [ ] **E1** **View → Language → Español**: every new button, tooltip, menu item and message is in Spanish (no English left, no key names like `line.trill` showing).
