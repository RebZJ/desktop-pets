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
        let root = crate::portable::models_dir(app);
        let runtime = runtime_library(app)?;
        Self::ready(&root)?;
        let text = params["text"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.chars().count() <= 1500)
            .ok_or("Provide 1–1500 characters to speak.")?
            .to_owned();
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
            let mut audio = Vec::new();
            for chunk in chunks(&text) {
                if cancel.load(Ordering::SeqCst) != epoch { return Err("Voice cancelled".into()); }
                // shortcut: CMU's permissive dictionary spells unknown names; add a neural G2P if names need natural pronunciation.
                let ipa = loaded.g2p.phonemize_with_prosody(&chunk).map_err(|e| e.to_string())?.0.concat();
                if ipa.trim().is_empty() { continue; }
                let samples = loaded.model.generate_from_ipa(&ipa, &voice, rate, chunk.chars().count()).map_err(|e| format!("Kitten voice generation failed: {e:#}"))?;
                if samples.iter().any(|s| !s.is_finite()) { return Err("The voice model returned invalid audio".into()); }
                audio.extend(samples);
            }
            if audio.is_empty() { return Err("The voice model returned no audio".into()); }
            if cancel.load(Ordering::SeqCst) != epoch { return Err("Voice cancelled".into()); }
            let directory = app.state::<crate::AppState>().data_dir.join("generated");
            std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let path = directory.join(format!("voice-{}.wav", uuid::Uuid::new_v4()));
            write_wav(&path, &audio)?;
            let result = json!({"path":path,"duration":audio.len() as f64 / SAMPLE_RATE as f64,"sampleRate":SAMPLE_RATE,"voice":voice,"model":MODEL_ID,"cold":cold,"synthesisMs":started.elapsed().as_millis()});
            if play {
                crate::emit(&app, "voice.started", json!({"streaming":false}));
                let played = playback(audio, pitch, volume, cancel, epoch);
                crate::emit(&app, "voice.stopped", json!({}));
                played?;
            }
            crate::emit(&app, "voice.ready", result.clone());
            Ok(result)
        }).await.map_err(|e| e.to_string())?
    }
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
        if current.chars().count() + word.chars().count() > 220 && !current.is_empty() {
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
fn playback(
    audio: Vec<f32>,
    pitch: f32,
    volume: f32,
    epoch: Arc<AtomicU64>,
    current: u64,
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
    let duration = Duration::from_secs_f64(audio.len() as f64 / SAMPLE_RATE as f64 / pitch as f64);
    let (tx, rx) = std::sync::mpsc::channel();
    let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let done = finished.clone();
    let drain_ms = Arc::new(AtomicU64::new(200));
    let callback_drain = drain_ms.clone();
    let output_rate = config.sample_rate as f64;
    let stopped = epoch.clone();
    let mut position = 0.0_f64;
    macro_rules! stream {
        ($sample:ty) => {
            device.build_output_stream(
                config,
                move |data: &mut [$sample], info: &cpal::OutputCallbackInfo| {
                    for frame in data.chunks_mut(channels) {
                        let sample = if stopped.load(Ordering::SeqCst) != current {
                            0.0
                        } else {
                            let i = position as usize;
                            let frac = (position - i as f64) as f32;
                            audio.get(i).map_or(0.0, |s| {
                                let next = audio.get(i + 1).copied().unwrap_or(*s);
                                (*s + (next - *s) * frac) * volume
                            })
                        };
                        for output in frame {
                            *output = <$sample as cpal::FromSample<f32>>::from_sample_(
                                sample.clamp(-1.0, 1.0),
                            );
                        }
                        position += step;
                    }
                    if position >= audio.len() as f64 && !done.load(Ordering::Relaxed) {
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
    let deadline = Instant::now() + duration + Duration::from_secs(5);
    while !finished.load(Ordering::Acquire) {
        if epoch.load(Ordering::SeqCst) != current {
            return Err("Voice cancelled".into());
        }
        if let Ok(error) = rx.try_recv() {
            return Err(format!("Speaker disconnected: {error}"));
        }
        if Instant::now() > deadline {
            return Err("Speaker stopped responding".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    // Use the device's queued playback timestamp so Bluetooth output also drains before listening.
    let drained = Instant::now() + Duration::from_millis(drain_ms.load(Ordering::Relaxed));
    while Instant::now() < drained {
        if epoch.load(Ordering::SeqCst) != current {
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
