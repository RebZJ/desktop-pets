//! Portable Kitten Micro inference and CPAL playback. No microphone is held while speaking.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use kittentts::model::{KittenTtsOnnx, SAMPLE_RATE};
use piper_plus_g2p::{english::EnglishPhonemizer, phonemizer::Phonemizer};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, TryRecvError},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

pub const MODEL_ID: &str = "kitten-tts-micro-0.8-onnx";
const MODEL_FILE: &str = "kitten_tts_micro_v0_8.onnx";
const VOICES: [&str; 8] = [
    "Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo",
];

struct Loaded {
    root: PathBuf,
    model: KittenTtsOnnx,
    g2p: EnglishPhonemizer,
}
#[derive(Default)]
pub struct Voice {
    model: Arc<Mutex<Option<Loaded>>>,
    epoch: Arc<AtomicU64>,
    loaded: Arc<AtomicBool>,
}
impl Voice {
    pub fn stop(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }
    pub fn is_loaded(&self) -> bool {
        self.loaded.load(Ordering::SeqCst)
    }
    pub fn ready(root: &Path) -> Result<(), String> {
        let directory = root.join(MODEL_ID);
        if !directory.join(MODEL_FILE).is_file() || !directory.join("voices.npz").is_file() {
            return Err(
                "Install Kitten Micro · portable voice in Local models before starting voice chat."
                    .into(),
            );
        }
        Ok(())
    }
    pub async fn release(&self) {
        self.stop();
        let model = self.model.clone();
        let loaded = self.loaded.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Ok(mut slot) = model.lock() {
                *slot = None;
                loaded.store(false, Ordering::SeqCst);
            }
        })
        .await;
    }
    pub async fn speak(&self, app: &AppHandle, params: Value) -> Result<Value, String> {
        let text = params["text"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.chars().count() <= 1500)
            .ok_or("Provide 1–1500 characters to speak.")?;
        let (sender, receiver) = mpsc::channel();
        for chunk in chunks(text) {
            let _ = sender.send(chunk);
        }
        drop(sender);
        self.speak_stream(app, params, receiver).await
    }
    pub(crate) async fn speak_stream(
        &self,
        app: &AppHandle,
        params: Value,
        text: Receiver<String>,
    ) -> Result<Value, String> {
        let root = crate::portable::models_dir(app);
        let runtime = runtime_library(app)?;
        Self::ready(&root)?;
        let voice = params["voice"].as_str().unwrap_or("Kiki").to_owned();
        if !VOICES.contains(&voice.as_str()) {
            return Err(
                "Choose a Kitten voice: Kiki, Bella, Rosie, Luna, Jasper, Bruno, Hugo or Leo."
                    .into(),
            );
        }
        if params["voiceEngine"]
            .as_str()
            .is_some_and(|v| !["auto", "kitten"].contains(&v))
        {
            return Err(
                "The portable voice engine is KittenTTS. Choose Kitten in Voice settings.".into(),
            );
        }
        if params["language"]
            .as_str()
            .is_some_and(|v| !["English", "en", "Auto", "auto"].contains(&v))
        {
            return Err("Kitten Micro speaks English. Choose English for voice chat.".into());
        }
        let rate = number(&params, "rate", 1.0, 0.5, 1.5)? as f32;
        let pitch = number(&params, "pitch", 1.05, 0.75, 1.5)? as f32;
        let volume = number(&params, "volume", 0.65, 0.0, 1.0)? as f32;
        let play = params["play"].as_bool().unwrap_or(true);
        let epoch = params["_voiceEpoch"]
            .as_u64()
            .unwrap_or_else(|| self.epoch());
        let cancel = self.epoch.clone();
        let cache = self.model.clone();
        let loaded_flag = self.loaded.clone();
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let started = Instant::now();
            let mut slot = cache.lock().map_err(|e| e.to_string())?;
            if cancel.load(Ordering::SeqCst) != epoch { return Err("Voice cancelled".into()); }
            let cold = slot.as_ref().is_none_or(|loaded| loaded.root != root);
            if cold { initialize(&runtime)?; *slot = Some(load(&root)?); loaded_flag.store(true,Ordering::SeqCst); }
            let loaded = slot.as_ref().ok_or("The voice model did not load")?;
            let (sender, receiver) = mpsc::channel();
            let phrases = Arc::new(Mutex::new(Vec::<String>::new()));
            let failed = Arc::new(AtomicBool::new(false));
            let first_audio_ms = Arc::new(AtomicU64::new(0));
            let player = if play {
                let (app, cancel, failed, phrases) = (app.clone(), cancel.clone(), failed.clone(), phrases.clone());
                let first_audio_ms = first_audio_ms.clone();
                let chat_epoch = params["_voiceChatEpoch"].as_u64();
                Some(std::thread::spawn(move || {
                    let result = playback(receiver, pitch, volume, &cancel, epoch, &failed, |index| {
                        if index == 0 { first_audio_ms.store(started.elapsed().as_millis() as u64, Ordering::Relaxed); crate::emit(&app, "voice.started", json!({"streaming":true})); }
                        if let Some(chat_epoch) = chat_epoch {
                            if let Some(text) = phrases.lock().ok().and_then(|p| p.get(index).cloned()) {
                                app.state::<crate::AppState>().voicechat.spoken_chunk(&app, chat_epoch, &text);
                            }
                        }
                    });
                    if result.is_err() { failed.store(true, Ordering::SeqCst); }
                    crate::emit(&app, "voice.stopped", json!({}));
                    result
                }))
            } else { drop(receiver); None };
            let generated = (|| -> Result<Vec<f32>, String> {
                let mut audio = Vec::new();
                let mut characters = 0;
                loop {
                    if cancel.load(Ordering::SeqCst) != epoch || failed.load(Ordering::SeqCst) { return Err("Voice cancelled".into()); }
                    let chunk = match text.recv_timeout(Duration::from_millis(50)) {
                        Ok(text) => text,
                        Err(RecvTimeoutError::Timeout) => continue,
                        Err(RecvTimeoutError::Disconnected) => break,
                    };
                    characters += chunk.chars().count();
                    if characters > 1500 || chunk.chars().count() > 220 { return Err("Voice reply exceeded the speech limit".into()); }
                    let samples = render_phrase(loaded, &chunk, &voice, rate)?;
                    if samples.is_empty() { continue; }
                    if cancel.load(Ordering::SeqCst) != epoch || failed.load(Ordering::SeqCst) { return Err("Voice cancelled".into()); }
                    audio.extend_from_slice(&samples);
                    if play {
                        let mut phrases = phrases.lock().map_err(|e| e.to_string())?;
                        let index = phrases.len(); phrases.push(chunk); drop(phrases);
                        sender.send(AudioChunk { samples, index }).map_err(|_| "Speaker stopped before the reply finished")?;
                    }
                }
                if audio.is_empty() { return Err("The voice model returned no audio".into()); }
                Ok(audio)
            })();
            let synthesis_ms = started.elapsed().as_millis();
            drop(sender);
            if generated.is_err() { failed.store(true, Ordering::SeqCst); }
            drop(slot);
            let played = player.map(|p| p.join().map_err(|_| "Voice playback stopped unexpectedly".to_owned()).and_then(|r| r)).unwrap_or(Ok(()));
            let audio = match generated {
                Err(error) if error != "Voice cancelled" => return Err(error),
                result => { played?; result? }
            };
            if cancel.load(Ordering::SeqCst) != epoch { return Err("Voice cancelled".into()); }
            let directory = app.state::<crate::AppState>().data_dir.join("generated");
            std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let path = directory.join(format!("voice-{}.wav", uuid::Uuid::new_v4()));
            write_wav(&path, &audio)?;
            let result = json!({"path":path,"duration":audio.len() as f64 / SAMPLE_RATE as f64,"sampleRate":SAMPLE_RATE,"voice":voice,"model":MODEL_ID,"cold":cold,"streaming":play,"synthesisMs":synthesis_ms,"firstAudioMs":if play {Some(first_audio_ms.load(Ordering::Relaxed))} else {None},"elapsedMs":started.elapsed().as_millis()});
            crate::emit(&app, "voice.ready", result.clone());
            Ok(result)
        }).await.map_err(|e| e.to_string())?
    }
}
fn render_phrase(loaded: &Loaded, text: &str, voice: &str, rate: f32) -> Result<Vec<f32>, String> {
    // shortcut: CMU's permissive dictionary spells unknown names; add a neural G2P if names need natural pronunciation.
    let ipa = loaded
        .g2p
        .phonemize_with_prosody(text)
        .map_err(|e| e.to_string())?
        .0
        .concat();
    if ipa.trim().is_empty() {
        return Ok(Vec::new());
    }
    let samples = loaded
        .model
        .generate_from_ipa(&ipa, voice, rate, text.chars().count())
        .map_err(|e| format!("Kitten voice generation failed: {e:#}"))?;
    if samples.is_empty() || samples.iter().any(|s| !s.is_finite()) {
        return Err("The voice model returned invalid audio".into());
    }
    Ok(samples)
}
fn runtime_library(app: &AppHandle) -> Result<PathBuf, String> {
    let names: &[&str] = if cfg!(target_os = "macos") {
        &["libmoonshine.dylib"]
    } else if cfg!(windows) {
        &["onnxruntime.dll", "libonnxruntime.dll"]
    } else {
        &["libonnxruntime.so.1", "libonnxruntime.so"]
    };
    let mut roots = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../native/lib")];
    if let Ok(resource) = app.path().resource_dir() {
        roots.insert(0, resource.join("lib"));
    }
    roots
        .iter()
        .flat_map(|root| names.iter().map(move |name| root.join(name)))
        .find(|path| path.is_file())
        .ok_or("The bundled ONNX voice runtime is missing. Rebuild the native runtime.".into())
}
fn initialize(library: &Path) -> Result<(), String> {
    ort::init_from(library)
        .map_err(|e| format!("Could not open the local ONNX runtime: {e}"))?
        .with_name("Pace voice")
        .commit();
    Ok(())
}
fn load(root: &Path) -> Result<Loaded, String> {
    Voice::ready(root)?;
    let directory = root.join(MODEL_ID);
    let aliases: HashMap<_, _> = VOICES
        .iter()
        .enumerate()
        .map(|(i, name)| {
            (
                name.to_string(),
                format!(
                    "expr-voice-{}-{}",
                    2 + i / 2,
                    if i % 2 == 0 { "f" } else { "m" }
                ),
            )
        })
        .collect();
    Ok(Loaded {
        root: root.to_owned(),
        model: KittenTtsOnnx::load(
            &directory.join(MODEL_FILE),
            &directory.join("voices.npz"),
            HashMap::new(),
            aliases,
        )
        .map_err(|e| format!("Could not load Kitten: {e:#}"))?,
        g2p: EnglishPhonemizer::new_bundled().map_err(|e| e.to_string())?,
    })
}
fn number(params: &Value, key: &str, default: f64, min: f64, max: f64) -> Result<f64, String> {
    let n = match params.get(key) {
        None | Some(Value::Null) => default,
        Some(v) => v
            .as_f64()
            .ok_or_else(|| format!("{key} must be a number"))?,
    };
    if n.is_finite() && (min..=max).contains(&n) {
        Ok(n)
    } else {
        Err(format!("{key} must be between {min} and {max}"))
    }
}
fn chunks(text: &str) -> Vec<String> {
    let mut chunks = vec![];
    let mut current = String::new();
    for word in text.split_whitespace() {
        if word.chars().count() > 220 {
            if !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            chunks.extend(
                word.chars()
                    .collect::<Vec<_>>()
                    .chunks(220)
                    .map(|part| part.iter().collect()),
            );
            continue;
        }
        let limit = if chunks.is_empty() { 80 } else { 160 };
        if current.chars().count() + word.chars().count() + 1 > limit && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
        if word.ends_with(['.', '?', '!']) {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}
fn write_wav(path: &Path, audio: &[f32]) -> Result<(), String> {
    let mut writer = hound::WavWriter::create(
        path,
        hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .map_err(|e| e.to_string())?;
    for sample in audio {
        writer
            .write_sample((sample.clamp(-1.0, 1.0) * 32767.0) as i16)
            .map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())
}
struct AudioChunk {
    samples: Vec<f32>,
    index: usize,
}
struct PlaybackQueue {
    receiver: Receiver<AudioChunk>,
    chunk: Option<AudioChunk>,
    position: f64,
    finished: bool,
}
impl PlaybackQueue {
    fn sample(&mut self, step: f64, reached: &AtomicU64) -> f32 {
        while self
            .chunk
            .as_ref()
            .is_none_or(|chunk| self.position >= chunk.samples.len() as f64)
        {
            match self.receiver.try_recv() {
                Ok(next) => {
                    if let Some(previous) = &self.chunk {
                        self.position -= previous.samples.len() as f64;
                    }
                    self.chunk = Some(next);
                }
                Err(TryRecvError::Empty) => return 0.0,
                Err(TryRecvError::Disconnected) => {
                    self.finished = true;
                    return 0.0;
                }
            }
        }
        let chunk = self.chunk.as_ref().unwrap();
        reached.store(chunk.index as u64 + 1, Ordering::Release);
        let i = self.position as usize;
        let fraction = (self.position - i as f64) as f32;
        let sample = chunk.samples[i];
        let next = chunk.samples.get(i + 1).copied().unwrap_or(sample);
        self.position += step;
        sample + (next - sample) * fraction
    }
}
fn playback(
    audio: Receiver<AudioChunk>,
    pitch: f32,
    volume: f32,
    epoch: &Arc<AtomicU64>,
    current: u64,
    failed: &Arc<AtomicBool>,
    mut on_chunk: impl FnMut(usize),
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let host = cpal::host_from_id(cpal::HostId::PipeWire)
        .map_err(|e| format!("PipeWire audio is unavailable: {e}"))?;
    #[cfg(not(target_os = "linux"))]
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("No speaker output is available")?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let channels = config.channels as usize;
    if channels == 0 || config.sample_rate == 0 {
        return Err("Speaker returned an invalid audio format".into());
    }
    let step = SAMPLE_RATE as f64 * pitch as f64 / config.sample_rate as f64;
    let (tx, rx) = std::sync::mpsc::channel();
    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let done = finished.clone();
    let drain_ms = Arc::new(AtomicU64::new(200));
    let callback_drain = drain_ms.clone();
    let output_rate = config.sample_rate as f64;
    let stopped = epoch.clone();
    let aborted = failed.clone();
    let reached = Arc::new(AtomicU64::new(0));
    let callback_reached = reached.clone();
    let callbacks = Arc::new(AtomicU64::new(0));
    let callback_count = callbacks.clone();
    let mut audio = PlaybackQueue {
        receiver: audio,
        chunk: None,
        position: 0.0,
        finished: false,
    };
    macro_rules! stream {
        ($sample:ty) => {
            device.build_output_stream(
                config,
                move |data: &mut [$sample], info: &cpal::OutputCallbackInfo| {
                    for frame in data.chunks_mut(channels) {
                        let sample = if stopped.load(Ordering::SeqCst) != current
                            || aborted.load(Ordering::SeqCst)
                        {
                            0.0
                        } else {
                            audio.sample(step, &callback_reached) * volume
                        };
                        for output in frame {
                            *output = <$sample as cpal::FromSample<f32>>::from_sample_(
                                sample.clamp(-1.0, 1.0),
                            );
                        }
                    }
                    callback_count.fetch_add(1, Ordering::Release);
                    if audio.finished && !done.load(Ordering::Relaxed) {
                        let timestamp = info.timestamp();
                        let queued = timestamp.playback.duration_since(timestamp.callback)
                            + Duration::from_secs_f64(
                                data.len() as f64 / channels as f64 / output_rate,
                            )
                            + Duration::from_millis(100);
                        callback_drain
                            .store(queued.as_millis().min(5000) as u64, Ordering::Relaxed);
                        done.store(true, Ordering::Release);
                    }
                },
                move |error| {
                    let _ = tx.send(error.to_string());
                },
                Some(Duration::from_secs(3)),
            )
        };
    }
    let stream = match format {
        cpal::SampleFormat::F32 => stream!(f32),
        cpal::SampleFormat::F64 => stream!(f64),
        cpal::SampleFormat::I8 => stream!(i8),
        cpal::SampleFormat::I16 => stream!(i16),
        cpal::SampleFormat::I24 => stream!(cpal::I24),
        cpal::SampleFormat::I32 => stream!(i32),
        cpal::SampleFormat::I64 => stream!(i64),
        cpal::SampleFormat::U8 => stream!(u8),
        cpal::SampleFormat::U16 => stream!(u16),
        cpal::SampleFormat::U24 => stream!(cpal::U24),
        cpal::SampleFormat::U32 => stream!(u32),
        cpal::SampleFormat::U64 => stream!(u64),
        _ => return Err("Speaker audio format is unsupported".into()),
    }
    .map_err(|e| format!("Could not open speaker: {e}"))?;
    stream
        .play()
        .map_err(|e| format!("Could not play voice: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(180);
    let mut shown = 0;
    let mut last_callback = Instant::now();
    let mut last_count = 0;
    loop {
        if epoch.load(Ordering::SeqCst) != current || failed.load(Ordering::SeqCst) {
            return Err("Voice cancelled".into());
        }
        let playing = reached.load(Ordering::Acquire) as usize;
        while shown < playing {
            on_chunk(shown);
            shown += 1;
        }
        if let Ok(error) = rx.try_recv() {
            return Err(format!("Speaker disconnected: {error}"));
        }
        if finished.load(Ordering::Acquire) {
            break;
        }
        let count = callbacks.load(Ordering::Acquire);
        if count != last_count {
            last_count = count;
            last_callback = Instant::now();
        }
        if Instant::now() > deadline || last_callback.elapsed() > Duration::from_secs(5) {
            return Err("Speaker stopped responding".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // Use the device's queued playback timestamp so Bluetooth output also drains before listening.
    let drained = Instant::now() + Duration::from_millis(drain_ms.load(Ordering::Relaxed));
    while Instant::now() < drained {
        if epoch.load(Ordering::SeqCst) != current || failed.load(Ordering::SeqCst) {
            return Err("Voice cancelled".into());
        }
        if let Ok(error) = rx.try_recv() {
            return Err(format!("Speaker disconnected: {error}"));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(stream);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn playback_starts_before_input_finishes_and_never_skips_audio_during_a_gap() {
        let (sender, receiver) = mpsc::channel();
        let reached = AtomicU64::new(0);
        let mut queue = PlaybackQueue {
            receiver,
            chunk: None,
            position: 0.0,
            finished: false,
        };
        assert_eq!(queue.sample(1.0, &reached), 0.0);
        sender
            .send(AudioChunk {
                samples: vec![0.1, 0.2],
                index: 0,
            })
            .unwrap();
        assert_eq!(
            reached.load(Ordering::Relaxed),
            0,
            "Queued text must not appear before playback"
        );
        assert_eq!(queue.sample(1.0, &reached), 0.1);
        assert_eq!(reached.load(Ordering::Relaxed), 1);
        assert_eq!(queue.sample(1.0, &reached), 0.2);
        for _ in 0..20 {
            assert_eq!(queue.sample(1.0, &reached), 0.0);
        }
        assert!(
            !queue.finished,
            "Waiting for generation is not the end of speech"
        );
        sender
            .send(AudioChunk {
                samples: vec![0.3, 0.4],
                index: 1,
            })
            .unwrap();
        drop(sender);
        assert_eq!(queue.sample(1.0, &reached), 0.3);
        assert_eq!(reached.load(Ordering::Relaxed), 2);
        assert!(!queue.finished);
        assert_eq!(queue.sample(1.0, &reached), 0.4);
        assert_eq!(queue.sample(1.0, &reached), 0.0);
        assert!(queue.finished);
    }
    #[test]
    fn pitch_cursor_carries_the_fractional_position_between_phrases() {
        let (sender, receiver) = mpsc::channel();
        for (index, samples) in [vec![0.0, 0.1, 0.2], vec![0.3, 0.4, 0.5]]
            .into_iter()
            .enumerate()
        {
            sender.send(AudioChunk { samples, index }).unwrap();
        }
        drop(sender);
        let mut queue = PlaybackQueue {
            receiver,
            chunk: None,
            position: 0.0,
            finished: false,
        };
        let reached = AtomicU64::new(0);
        assert_eq!(queue.sample(1.5, &reached), 0.0);
        assert!((queue.sample(1.5, &reached) - 0.15).abs() < 1e-6);
        assert_eq!(queue.sample(1.5, &reached), 0.3);
        assert!((queue.sample(1.5, &reached) - 0.45).abs() < 1e-6);
        assert_eq!(reached.load(Ordering::Relaxed), 2);
    }
    #[test]
    fn validates_and_chunks_without_losing_words() {
        assert!(number(&json!({"rate":"fast"}), "rate", 1.0, 0.5, 1.5).is_err());
        let input = "Hello Pace! ".repeat(80);
        assert_eq!(chunks(&input).join(" "), input.trim());
        assert!(chunks(&"a".repeat(1500))
            .iter()
            .all(|chunk| chunk.chars().count() <= 220));
        let g2p = EnglishPhonemizer::new_bundled().unwrap();
        let ipa = g2p
            .phonemize_with_prosody("Hello Pace, I am ready to listen.")
            .unwrap()
            .0
            .concat();
        assert!(ipa.contains('h') && ipa.contains('p') && ipa.contains('l'));
    }
    #[test]
    #[ignore = "requires PACE_KITTEN_FIXTURE; generates real phrase audio without opening microphone or speakers"]
    fn actual_kiki_streaming_fixture() {
        let source =
            PathBuf::from(std::env::var_os("PACE_KITTEN_FIXTURE").expect("PACE_KITTEN_FIXTURE"));
        let library = std::env::var_os("PACE_ORT_FIXTURE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../native/lib/libmoonshine.dylib")
            });
        initialize(&library).unwrap();
        let loading = Instant::now();
        let loaded = load(&source).unwrap();
        let load_ms = loading.elapsed().as_millis();
        let text = "Choose one small task. Give it ten quiet minutes, then come back and tell me how it went.";
        for pass in ["cold", "warm"] {
            let start = Instant::now();
            let mut audio = Vec::new();
            let mut first_ms = 0;
            let phrases = chunks(text);
            assert!(phrases.len() >= 2);
            for (index, phrase) in phrases.iter().enumerate() {
                let samples = render_phrase(&loaded, phrase, "Kiki", 1.0).unwrap();
                assert!(samples.iter().any(|s| s.abs() > 0.01));
                audio.extend(samples);
                if index == 0 {
                    first_ms = start.elapsed().as_millis();
                }
            }
            let full_ms = start.elapsed().as_millis();
            assert!(
                first_ms < full_ms,
                "The first phrase must be ready before the complete reply"
            );
            assert!(audio.len() > SAMPLE_RATE as usize);
            write_wav(&source.join(format!("kiki-streaming-{pass}.wav")), &audio).unwrap();
            eprintln!("Kiki {pass}: model_load_ms={load_ms}, first_phrase_ms={first_ms}, full_reply_ms={full_ms}, audio_seconds={:.2}, phrases={}", audio.len() as f64 / SAMPLE_RATE as f64, phrases.len());
        }
    }
    #[test]
    #[ignore = "requires PACE_KITTEN_FIXTURE pointing at the pinned portable model directory; no microphone or playback"]
    fn actual_kiki_fixture() {
        let source =
            PathBuf::from(std::env::var_os("PACE_KITTEN_FIXTURE").expect("PACE_KITTEN_FIXTURE"));
        let library = std::env::var_os("PACE_ORT_FIXTURE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../native/lib/libmoonshine.dylib")
            });
        initialize(&library).unwrap();
        let loaded = load(&source).unwrap();
        let text =
            "Hello! I am Pace, your little desktop friend. What would you like to talk about?";
        let ipa = loaded.g2p.phonemize_with_prosody(text).unwrap().0.concat();
        let audio = loaded
            .model
            .generate_from_ipa(&ipa, "Kiki", 1.0, text.chars().count())
            .unwrap();
        assert!(audio.len() > SAMPLE_RATE as usize && audio.iter().all(|v| v.is_finite()));
        assert!(audio.iter().any(|v| v.abs() > 0.01));
        write_wav(&source.join("kiki-fixture.wav"), &audio).unwrap();
        eprintln!(
            "Kiki fixture: {:.2}s, IPA={ipa}",
            audio.len() as f64 / SAMPLE_RATE as f64
        );
        if let Some(models) = std::env::var_os("PACE_KITTEN_ASR_MODEL_ROOT") {
            let native = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../native");
            let pcm: Vec<i16> = (0..audio.len() * 2 / 3)
                .map(|index| {
                    let position = index as f64 * 1.5;
                    let at = position as usize;
                    let frac = (position - at as f64) as f32;
                    let a = audio[at];
                    let b = audio.get(at + 1).copied().unwrap_or(a);
                    ((a + (b - a) * frac).clamp(-1.0, 1.0) * 32767.0) as i16
                })
                .collect();
            let path = source.join("kiki-fixture-16k.wav");
            let mut writer = hound::WavWriter::create(
                &path,
                hound::WavSpec {
                    channels: 1,
                    sample_rate: 16000,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
            )
            .unwrap();
            for sample in pcm {
                writer.write_sample(sample).unwrap();
            }
            writer.finalize().unwrap();
            let mut runtime = crate::asr::AsrRuntime::new(crate::asr::RuntimePaths {
                moonshine_library: library,
                model_root: models.into(),
                whisper_cli: native.join("bin/whisper-cli"),
                vad_cli: native.join("bin/whisper-vad-speech-segments"),
                diarization_cli: native.join("bin/nemo-speech"),
            });
            let decoded = runtime
                .transcribe(&json!({"path":path,"purpose":"dictation","language":"en"}))
                .unwrap();
            eprintln!("Kiki actual ASR: {decoded}");
            let decoded = decoded["text"].as_str().unwrap().to_ascii_lowercase();
            assert!(decoded.contains("desktop friend") && decoded.contains("talk about"));
        }
    }
}
