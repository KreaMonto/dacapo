//! Audio playback: a SoundFont synthesizer (rustysynth) feeding the default
//! output device (cpal).
//!
//! The audio callback runs on cpal's thread and pulls samples from a shared
//! [`Player`]. Everything that can take time (reading the SoundFont,
//! building a timeline, downloading) happens outside the lock, so the
//! callback never waits long. Notes are scheduled to the exact sample.

use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use partita_core::playback::Timeline;
use rustysynth::{SoundFont, Synthesizer, SynthesizerSettings};
use serde::Serialize;

/// Where FluidR3_GM is downloaded from: a tagged GitHub release asset
/// (pianobooster/fluid-soundfont v3.1, MIT license by Frank Wen).
pub const SOUNDFONT_URL: &str =
    "https://github.com/pianobooster/fluid-soundfont/releases/download/v3.1/FluidR3_GM.sf2";
pub const SOUNDFONT_FILE: &str = "FluidR3_GM.sf2";
/// Exact size of that release asset, used to reject truncated downloads.
pub const SOUNDFONT_SIZE: u64 = 148_398_306;

/// What the About dialog says about the downloaded SoundFont.
#[derive(Clone, Debug, Serialize)]
pub struct SoundFontInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub author: &'static str,
    pub license: &'static str,
    pub homepage: &'static str,
    pub source_url: &'static str,
    pub installed: bool,
    pub path: String,
    pub size_bytes: u64,
    pub status: SoundStatus,
}

/// State of the sound engine, shown in the UI.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SoundStatus {
    /// No SoundFont yet: playback needs a download first.
    Missing,
    Downloading {
        received: u64,
        total: u64,
    },
    Loading,
    Ready,
    Error {
        message: String,
    },
    /// No audio output device could be opened.
    NoDevice {
        message: String,
    },
}

/// Current playback position, for the on-screen playhead.
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct PlaybackState {
    pub playing: bool,
    pub measure: usize,
    pub tick: u32,
}

#[derive(Clone, Copy)]
enum Msg {
    On {
        channel: i32,
        key: i32,
        velocity: i32,
    },
    Off {
        channel: i32,
        key: i32,
    },
    /// Selects the instrument (General MIDI program) of a channel.
    Program {
        channel: i32,
        program: i32,
    },
}

/// A scheduled MIDI message, in samples from the start of playback.
#[derive(Clone, Copy)]
struct Scheduled {
    at: u64,
    msg: Msg,
}

struct Player {
    synth: Option<Synthesizer>,
    sample_rate: u32,
    // Score playback.
    playing: bool,
    queue: Vec<Scheduled>,
    next: usize,
    pos: u64,
    end: u64,
    timeline: Timeline,
    origin_tick: u64,
    /// Seconds from the start of the score to `origin_tick`.
    origin_seconds: f64,
    // Note previews while editing: independent of playback.
    clock: u64,
    preview_offs: Vec<(u64, i32, i32)>,
    // Scratch buffers for rendering (reused, never shrunk).
    left: Vec<f32>,
    right: Vec<f32>,
}

/// MIDI channel for a staff: one per staff, skipping 9 (percussion).
fn channel_for(staff: usize) -> i32 {
    let c = (staff % 15) as i32;
    if c >= 9 {
        c + 1
    } else {
        c
    }
}

impl Player {
    fn apply(&mut self, msg: Msg) {
        if let Some(s) = self.synth.as_mut() {
            match msg {
                Msg::On {
                    channel,
                    key,
                    velocity,
                } => s.note_on(channel, key, velocity),
                Msg::Off { channel, key } => s.note_off(channel, key),
                Msg::Program { channel, program } => {
                    s.process_midi_message(channel, 0xC0, program, 0)
                }
            }
        }
    }

    fn stop_all(&mut self) {
        self.playing = false;
        self.queue.clear();
        self.next = 0;
        if let Some(s) = self.synth.as_mut() {
            s.note_off_all(false);
        }
    }

    /// Fills `frames` stereo frames into `out(left, right)`, applying
    /// scheduled messages at their exact sample.
    fn render(&mut self, frames: usize, mut out: impl FnMut(&[f32], &[f32])) {
        if self.left.len() < frames {
            self.left.resize(frames, 0.0);
            self.right.resize(frames, 0.0);
        }
        let mut done = 0;
        while done < frames {
            // Apply everything due now.
            if self.playing {
                while self.next < self.queue.len() && self.queue[self.next].at <= self.pos {
                    let m = self.queue[self.next].msg;
                    self.next += 1;
                    self.apply(m);
                }
                if self.pos >= self.end {
                    self.stop_all();
                }
            }
            let mut i = 0;
            while i < self.preview_offs.len() {
                if self.preview_offs[i].0 <= self.clock {
                    let (_, channel, key) = self.preview_offs.swap_remove(i);
                    self.apply(Msg::Off { channel, key });
                } else {
                    i += 1;
                }
            }
            // Render up to the next scheduled message.
            let mut chunk = (frames - done) as u64;
            if self.playing {
                if let Some(s) = self.queue.get(self.next) {
                    chunk = chunk.min(s.at.saturating_sub(self.pos).max(1));
                }
                chunk = chunk.min(self.end.saturating_sub(self.pos).max(1));
            }
            if let Some(next_off) = self.preview_offs.iter().map(|p| p.0).min() {
                chunk = chunk.min(next_off.saturating_sub(self.clock).max(1));
            }
            let n = chunk as usize;
            let (l, r) = (&mut self.left[..n], &mut self.right[..n]);
            match self.synth.as_mut() {
                Some(s) => s.render(l, r),
                None => {
                    l.fill(0.0);
                    r.fill(0.0);
                }
            }
            out(l, r);
            done += n;
            self.clock += chunk;
            if self.playing {
                self.pos += chunk;
            }
        }
    }

    fn state(&self) -> PlaybackState {
        let elapsed = self.pos as f64 / self.sample_rate.max(1) as f64;
        let tick = self
            .timeline
            .tick_at_seconds(self.origin_seconds + elapsed)
            .max(self.origin_tick);
        let (measure, tick) = self.timeline.position(tick.min(self.timeline.end));
        PlaybackState {
            playing: self.playing,
            measure,
            tick,
        }
    }
}

/// The application's sound engine.
pub struct Engine {
    player: Arc<Mutex<Player>>,
    status: Arc<Mutex<SoundStatus>>,
    sample_rate: u32,
    soundfont_dir: PathBuf,
}

impl Engine {
    /// Opens the default output device and, if the SoundFont is already
    /// downloaded, starts loading it in the background.
    pub fn start(soundfont_dir: PathBuf) -> Engine {
        let player = Arc::new(Mutex::new(Player {
            synth: None,
            sample_rate: 44_100,
            playing: false,
            queue: Vec::new(),
            next: 0,
            pos: 0,
            end: 0,
            timeline: Timeline::default(),
            origin_tick: 0,
            origin_seconds: 0.0,
            clock: 0,
            preview_offs: Vec::new(),
            left: vec![0.0; 4096],
            right: vec![0.0; 4096],
        }));
        let status = Arc::new(Mutex::new(SoundStatus::Missing));
        let sample_rate = match open_output(player.clone()) {
            Ok(rate) => rate,
            Err(message) => {
                *status.lock().unwrap() = SoundStatus::NoDevice { message };
                44_100
            }
        };
        player.lock().unwrap().sample_rate = sample_rate;
        let engine = Engine {
            player,
            status,
            sample_rate,
            soundfont_dir,
        };
        if engine.soundfont_path().exists()
            && !matches!(engine.status(), SoundStatus::NoDevice { .. })
        {
            engine.load_in_background(engine.soundfont_path());
        }
        engine
    }

    pub fn soundfont_path(&self) -> PathBuf {
        self.soundfont_dir.join(SOUNDFONT_FILE)
    }

    pub fn status(&self) -> SoundStatus {
        self.status.lock().unwrap().clone()
    }

    /// Identity and install state of the SoundFont, for the About dialog.
    pub fn soundfont_info(&self) -> SoundFontInfo {
        let path = self.soundfont_path();
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        SoundFontInfo {
            name: "FluidR3 GM",
            version: "3.1",
            author: "Frank Wen",
            license: "MIT",
            homepage: "https://github.com/pianobooster/fluid-soundfont",
            source_url: SOUNDFONT_URL,
            installed: size > 0,
            path: path.display().to_string(),
            size_bytes: size,
            status: self.status(),
        }
    }

    pub fn soundfont_dir(&self) -> &Path {
        &self.soundfont_dir
    }

    fn set_status(&self, s: SoundStatus) {
        *self.status.lock().unwrap() = s;
    }

    /// Reads a SoundFont and swaps it into the player, off the audio thread.
    pub fn load_in_background(&self, path: PathBuf) {
        self.set_status(SoundStatus::Loading);
        let (player, status, rate) = (self.player.clone(), self.status.clone(), self.sample_rate);
        std::thread::spawn(move || {
            let result = (|| -> Result<Synthesizer, String> {
                let mut file = BufReader::new(File::open(&path).map_err(|e| e.to_string())?);
                let font = Arc::new(
                    SoundFont::new(&mut file)
                        .map_err(|e| format!("not a valid SoundFont: {e:?}"))?,
                );
                let settings = SynthesizerSettings::new(rate as i32);
                Synthesizer::new(&font, &settings).map_err(|e| format!("{e:?}"))
            })();
            match result {
                Ok(synth) => {
                    player.lock().unwrap().synth = Some(synth);
                    *status.lock().unwrap() = SoundStatus::Ready;
                }
                Err(message) => *status.lock().unwrap() = SoundStatus::Error { message },
            }
        });
    }

    /// Downloads FluidR3_GM (with progress in [`Engine::status`]), checks
    /// it, then loads it.
    pub fn download_soundfont(self: &Arc<Self>) {
        if matches!(
            self.status(),
            SoundStatus::Downloading { .. } | SoundStatus::Loading | SoundStatus::Ready
        ) {
            return;
        }
        self.set_status(SoundStatus::Downloading {
            received: 0,
            total: SOUNDFONT_SIZE,
        });
        let engine = self.clone();
        std::thread::spawn(move || {
            let target = engine.soundfont_path();
            match download(&target, |received, total| {
                engine.set_status(SoundStatus::Downloading { received, total });
            }) {
                Ok(()) => engine.load_in_background(target),
                Err(message) => engine.set_status(SoundStatus::Error { message }),
            }
        });
    }

    /// Plays a timeline from an absolute tick.
    pub fn play(&self, timeline: Timeline, from_tick: u64) -> Result<(), String> {
        if !matches!(self.status(), SoundStatus::Ready) {
            return Err("the SoundFont is not loaded yet".into());
        }
        // Samples from the start of playback; the tempo may change on the way.
        let origin_seconds = timeline.seconds_at(from_tick);
        let rate = self.sample_rate as f64;
        let at =
            |tick: u64| ((timeline.seconds_at(tick.max(from_tick)) - origin_seconds) * rate) as u64;
        let mut queue = Vec::with_capacity(timeline.notes.len() * 2);
        for n in timeline.notes.iter().filter(|n| n.start >= from_tick) {
            let channel = channel_for(n.staff);
            let key = n.key as i32;
            queue.push(Scheduled {
                at: at(n.start),
                msg: Msg::On {
                    channel,
                    key,
                    velocity: n.velocity as i32,
                },
            });
            queue.push(Scheduled {
                at: at(n.end),
                msg: Msg::Off { channel, key },
            });
        }
        // At the same instant, release before striking (repeated notes).
        queue.sort_by_key(|s| (s.at, matches!(s.msg, Msg::On { .. })));
        let end = at(timeline.end) + self.sample_rate as u64 / 4; // let the last note ring briefly
        let mut p = self.player.lock().unwrap();
        p.stop_all();
        for (staff, &program) in timeline.instruments.iter().enumerate() {
            p.apply(Msg::Program {
                channel: channel_for(staff),
                program: program as i32,
            });
        }
        p.queue = queue;
        p.next = 0;
        p.pos = 0;
        p.end = end;
        p.origin_tick = from_tick;
        p.origin_seconds = origin_seconds;
        p.timeline = timeline;
        p.playing = true;
        Ok(())
    }

    /// Stops playback; returns where it was.
    pub fn stop(&self) -> PlaybackState {
        let mut p = self.player.lock().unwrap();
        let state = p.state();
        p.stop_all();
        PlaybackState {
            playing: false,
            ..state
        }
    }

    pub fn state(&self) -> PlaybackState {
        self.player.lock().unwrap().state()
    }

    /// Sounds a few keys briefly with the staff's instrument (feedback
    /// while entering notes).
    pub fn preview(&self, staff: usize, instrument: u8, keys: &[u8]) {
        if !matches!(self.status(), SoundStatus::Ready) {
            return;
        }
        let channel = channel_for(staff);
        let mut p = self.player.lock().unwrap();
        p.apply(Msg::Program {
            channel,
            program: instrument as i32,
        });
        let off_at = p.clock + (self.sample_rate as u64 * 45 / 100);
        for &k in keys {
            let key = k as i32;
            p.apply(Msg::On {
                channel,
                key,
                velocity: 90,
            });
            p.preview_offs.push((off_at, channel, key));
        }
    }
}

/// Opens the default output device on a dedicated thread that keeps the
/// stream alive for the whole session. Returns the device's sample rate.
fn open_output(player: Arc<Mutex<Player>>) -> Result<u32, String> {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("partita-audio".into())
        .spawn(move || {
            let result = (|| -> Result<(cpal::Stream, u32), String> {
                let host = cpal::default_host();
                let device = host
                    .default_output_device()
                    .ok_or("no audio output device")?;
                let config = device.default_output_config().map_err(|e| e.to_string())?;
                let rate = config.sample_rate().0;
                let channels = config.channels() as usize;
                let err = |e| eprintln!("[partita] audio stream error: {e}");
                let stream = match config.sample_format() {
                    cpal::SampleFormat::F32 => device.build_output_stream(
                        &config.into(),
                        move |data: &mut [f32], _| fill(&player, data, channels, |x| x),
                        err,
                        None,
                    ),
                    cpal::SampleFormat::I16 => device.build_output_stream(
                        &config.into(),
                        move |data: &mut [i16], _| {
                            fill(&player, data, channels, |x| {
                                (x.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
                            })
                        },
                        err,
                        None,
                    ),
                    cpal::SampleFormat::U16 => device.build_output_stream(
                        &config.into(),
                        move |data: &mut [u16], _| {
                            fill(&player, data, channels, |x| {
                                ((x.clamp(-1.0, 1.0) + 1.0) * 0.5 * u16::MAX as f32) as u16
                            })
                        },
                        err,
                        None,
                    ),
                    other => return Err(format!("unsupported sample format {other:?}")),
                }
                .map_err(|e| e.to_string())?;
                stream.play().map_err(|e| e.to_string())?;
                Ok((stream, rate))
            })();
            match result {
                Ok((stream, rate)) => {
                    let _ = tx.send(Ok(rate));
                    // The stream lives as long as this thread.
                    let _keep = stream;
                    loop {
                        std::thread::park();
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "audio device did not respond".to_string())?
}

/// Audio callback: renders stereo and spreads it over the device channels.
fn fill<T: Copy>(
    player: &Mutex<Player>,
    data: &mut [T],
    channels: usize,
    convert: impl Fn(f32) -> T,
) {
    let frames = data.len() / channels.max(1);
    let mut p = player.lock().unwrap();
    let mut frame = 0;
    p.render(frames, |l, r| {
        for i in 0..l.len() {
            let base = (frame + i) * channels;
            for c in 0..channels {
                data[base + c] = convert(if c % 2 == 0 { l[i] } else { r[i] });
            }
        }
        frame += l.len();
    });
}

/// Downloads the SoundFont to `target` via a temporary `.part` file and
/// checks size and file signature before putting it in place.
fn download(target: &Path, progress: impl Fn(u64, u64)) -> Result<(), String> {
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let part = target.with_extension("sf2.part");
    let response = ureq::get(SOUNDFONT_URL)
        .timeout(Duration::from_secs(60 * 30))
        .call()
        .map_err(|e| format!("download failed: {e}"))?;
    let total = response
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(SOUNDFONT_SIZE);
    let mut reader = response.into_reader();
    let mut file = File::create(&part).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut received = 0u64;
    let mut last_report = 0u64;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        received += n as u64;
        if received - last_report > 1024 * 1024 {
            progress(received, total);
            last_report = received;
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    // A SoundFont is a RIFF file of type "sfbk".
    let mut head = [0u8; 12];
    File::open(&part)
        .and_then(|mut f| f.read_exact(&mut head))
        .map_err(|e| e.to_string())?;
    if received != SOUNDFONT_SIZE || &head[0..4] != b"RIFF" || &head[8..12] != b"sfbk" {
        let _ = fs::remove_file(&part);
        return Err(format!(
            "downloaded file is not the expected SoundFont ({received} bytes)"
        ));
    }
    fs::rename(&part, target).map_err(|e| e.to_string())?;
    progress(received, total);
    Ok(())
}
