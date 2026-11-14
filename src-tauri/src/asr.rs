//! Portable adapters for the bundled Moonshine C SDK, whisper.cpp and NeMo CLIs.
use libloading::Library;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    ffi::{c_char, CStr, CString},
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

pub struct RuntimePaths {
    pub moonshine_library: PathBuf,
    pub model_root: PathBuf,
    pub whisper_cli: PathBuf,
    pub vad_cli: PathBuf,
    pub diarization_cli: PathBuf,
}

pub struct AsrRuntime {
    paths: RuntimePaths,
    moonshine: Option<Moonshine>,
    pub cancelled: Arc<AtomicBool>,
}

impl AsrRuntime {
    pub fn new(paths: RuntimePaths) -> Self {
        Self {
            paths,
            moonshine: None,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn prepare_dictation(&mut self, language: &str) -> Result<Option<Value>, String> {
        let language = normalize_language(language);
        if !["en", "zh", "ja", "es"].contains(&language.as_str())
            || !self.moonshine_installed(&language)
        {
            return Ok(None);
        }
        let (cold, load_ms) = self.load_moonshine(&language)?;
        Ok(Some(
            json!({ "model": format!("moonshine-tiny-{language}"), "cold": cold, "loadMs": load_ms }),
        ))
    }

    pub fn transcribe(&mut self, params: &Value) -> Result<Value, String> {
        self.cancelled.store(false, Ordering::SeqCst);
        let path = input_path(params)?;
        let samples = read_pcm(&path)?;
        let dictation = params["purpose"].as_str() == Some("dictation");
        let choice = params["asrModel"].as_str().unwrap_or("auto");
        if !matches!(choice, "auto" | "moonshine" | "whisper-turbo") {
            return Err("Unknown speech recognition model.".into());
        }
        let raw_language = params["language"].as_str().unwrap_or("auto");
        let language = if dictation {
            normalize_language(raw_language)
        } else {
            raw_language.to_owned()
        };
        if language != "auto"
            && !(language.len() >= 2
                && language.len() <= 3
                && language.bytes().all(|c| c.is_ascii_lowercase()))
        {
            return Err("Use an ISO language code such as en, zh, ja or es.".into());
        }
        let terms = if dictation {
            vocabulary(params.get("dictationVocabulary"))?
        } else {
            vec![]
        };
        if choice == "moonshine"
            && (!matches!(language.as_str(), "en" | "zh" | "ja" | "es")
                || !self.moonshine_installed(&language))
        {
            return Err("Moonshine needs an installed English, Chinese, Japanese or Spanish pack and an explicit dictation language. Choose a language or another ASR model.".into());
        }
        if (choice == "moonshine" || (choice == "auto" && dictation))
            && ["en", "zh", "ja", "es"].contains(&language.as_str())
            && self.moonshine_installed(&language)
        {
            let (cold, load_ms) = self.load_moonshine(&language)?;
            check_cancel(&self.cancelled)?;
            let mut result = self
                .moonshine
                .as_ref()
                .unwrap()
                .transcribe(&samples, &language, &terms)?;
            check_cancel(&self.cancelled)?;
            result["cold"] = json!(cold);
            result["loadMs"] = json!(load_ms);
            return Ok(result);
        }
        self.whisper(&samples, &language, &terms)
    }

    fn moonshine_installed(&self, language: &str) -> bool {
        let root = self
            .paths
            .model_root
            .join(format!("moonshine-tiny-{language}"));
        [
            "adapter.ort",
            "cross_kv.ort",
            "decoder_kv.ort",
            "encoder.ort",
            "frontend.model.ort",
            "frontend.weights.ort",
            "streaming_config.json",
            "tokenizer.bin",
        ]
        .iter()
        .all(|name| root.join(name).is_file())
    }

    fn load_moonshine(&mut self, language: &str) -> Result<(bool, f64), String> {
        let started = Instant::now();
        let cold = self.moonshine.as_ref().map(|m| m.language.as_str()) != Some(language);
        if cold {
            self.moonshine = None;
            self.moonshine = Some(Moonshine::load(
                &self.paths.moonshine_library,
                &self
                    .paths
                    .model_root
                    .join(format!("moonshine-tiny-{language}")),
                language,
            )?);
        }
        Ok((cold, started.elapsed().as_secs_f64() * 1000.0))
    }

    fn whisper(&self, samples: &[i16], language: &str, terms: &[String]) -> Result<Value, String> {
        let model = self.paths.model_root.join("whisper-turbo");
        let weights = model.join("ggml-large-v3-turbo-q5_0.bin");
        let vad_model = model.join("ggml-silero-v6.2.0.bin");
        if !weights.is_file() || !vad_model.is_file() {
            return Err("Install Whisper Turbo and its Silero VAD model before transcribing this language or using automatic language detection.".into());
        }
        let work = tempfile::Builder::new()
            .prefix("pace-transcribe-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let windows = windows(samples.len());
        let mut segments = vec![];
        let mut detected = language.to_owned();
        let mut speech_windows = 0;
        for (index, window) in windows.iter().enumerate() {
            check_cancel(&self.cancelled)?;
            let window_audio = work.path().join("window.wav");
            write_pcm(&window_audio, &samples[window.start..window.end])?;
            let vad = run(
                &self.paths.vad_cli,
                &[
                    "-vm".into(),
                    arg(&vad_model)?,
                    "-f".into(),
                    arg(&window_audio)?,
                    "-np".into(),
                    "-vt".into(),
                    "0.2".into(),
                    "-vp".into(),
                    "800".into(),
                    "-vsd".into(),
                    "500".into(),
                ],
                work.path(),
                "vad",
                &self.cancelled,
            )?;
            let regions = speech_regions(&vad, window.end - window.start)?;
            if regions.is_empty() {
                continue;
            }
            speech_windows += 1;
            for (start, end) in regions {
                let region = Window {
                    start: window.start + start,
                    end: window.start + end,
                    core_start: window.core_start,
                    core_end: window.core_end,
                };
                let speech_audio = work.path().join("speech.wav");
                write_pcm(&speech_audio, &samples[region.start..region.end])?;
                let output = work.path().join("words");
                let mut arguments = vec![
                    "-m".into(),
                    arg(&weights)?,
                    "-f".into(),
                    arg(&speech_audio)?,
                    "-l".into(),
                    language.into(),
                    "-ojf".into(),
                    "-of".into(),
                    arg(&output)?,
                    "-np".into(),
                    "-t".into(),
                    "4".into(),
                    "-dtw".into(),
                    "large.v3.turbo".into(),
                    "-nfa".into(),
                ];
                if !terms.is_empty() {
                    arguments.extend(["--prompt".into(), terms.join(", ")]);
                }
                run(
                    &self.paths.whisper_cli,
                    &arguments,
                    work.path(),
                    "whisper",
                    &self.cancelled,
                )?;
                let object: Value = serde_json::from_slice(
                    &fs::read(output.with_extension("json")).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
                if let Some(value) = object["result"]["language"].as_str() {
                    detected = value.to_owned();
                }
                for mut word in aligned_segments(&object)? {
                    let shift = region.start as i64 * 1000 / 16000;
                    let start = word["startMs"].as_i64().unwrap() + shift;
                    let end = word["endMs"].as_i64().unwrap() + shift;
                    let midpoint = start + (end - start) / 2;
                    if midpoint < region.core_start as i64 * 1000 / 16000
                        || !(midpoint < region.core_end as i64 * 1000 / 16000
                            || (index + 1 == windows.len()
                                && midpoint == region.core_end as i64 * 1000 / 16000))
                    {
                        continue;
                    }
                    word["startMs"] = json!(start);
                    word["endMs"] = json!(end);
                    word["start"] = json!(start as f64 / 1000.0);
                    word["end"] = json!(end as f64 / 1000.0);
                    segments.push(word);
                }
            }
        }
        let text = segments
            .iter()
            .filter_map(|word| word["text"].as_str())
            .collect::<String>();
        Ok(
            json!({"text": text.trim(), "segments": segments, "language": detected, "model": "whisper-turbo", "vad": "silero-v6.2.0", "granularity": "word", "windows": windows.len(), "speechWindows": speech_windows}),
        )
    }

    pub fn diarize(&self, params: &Value) -> Result<Value, String> {
        self.cancelled.store(false, Ordering::SeqCst);
        let path = input_path(params)?;
        validate_pcm(&path)?;
        let model = self
            .paths
            .model_root
            .join("nemotron-diarization/Nemotron-3-Diarization.q8_0.gguf");
        if !model.is_file() {
            return Err(
                "Install the Nemotron diarization model before recognizing speakers.".into(),
            );
        }
        let work = tempfile::Builder::new()
            .prefix("pace-diarize-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let output = work.path().join("segments.json");
        run(
            &self.paths.diarization_cli,
            &[
                "diarize".into(),
                arg(&path)?,
                "--model".into(),
                arg(&model)?,
                "--format".into(),
                "json".into(),
                "--output".into(),
                arg(&output)?,
            ],
            work.path(),
            "diarization",
            &self.cancelled,
        )?;
        let json: Value = serde_json::from_slice(&fs::read(output).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        parse_diarization(&json)
    }
}

pub(crate) fn normalize_language(language: &str) -> String {
    language
        .to_lowercase()
        .replace('_', "-")
        .split('-')
        .next()
        .unwrap_or("")
        .into()
}
pub(crate) fn vocabulary(value: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(vec![]);
    };
    let text = value.as_str().ok_or("Custom vocabulary must be text.")?;
    if text.chars().count() > 4000 || text.contains('\0') {
        return Err(
            "Custom vocabulary must contain at most 4000 characters and no NUL bytes.".into(),
        );
    }
    let mut seen = HashSet::new();
    Ok(text
        .split(|c: char| {
            matches!(
                c,
                ',' | '\n' | '\r' | '\u{000b}' | '\u{000c}' | '\u{0085}' | '\u{2028}' | '\u{2029}'
            )
        })
        .map(str::trim)
        .filter(|s| !s.is_empty() && seen.insert((*s).to_owned()))
        .map(str::to_owned)
        .collect())
}
pub(crate) fn input_path(params: &Value) -> Result<PathBuf, String> {
    let path = PathBuf::from(
        params["path"]
            .as_str()
            .ok_or("Provide an existing absolute WAV path.")?,
    );
    if !path.is_absolute()
        || !path.is_file()
        || !path
            .extension()
            .is_some_and(|s| s.eq_ignore_ascii_case("wav"))
    {
        return Err("Provide an existing absolute WAV path.".into());
    }
    Ok(path)
}
fn arg(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "Speech runtime paths must contain valid Unicode.".into())
}
fn pcm_reader(path: &Path) -> Result<hound::WavReader<std::io::BufReader<File>>, String> {
    let reader = hound::WavReader::open(path).map_err(|e| format!("Invalid WAV: {e}"))?;
    let spec = reader.spec();
    if spec.sample_rate != 16000
        || spec.channels != 1
        || spec.bits_per_sample != 16
        || spec.sample_format != hound::SampleFormat::Int
        || reader.len() == 0
    {
        return Err("Audio must be nonempty mono 16 kHz PCM16 WAV.".into());
    }
    Ok(reader)
}
fn validate_pcm(path: &Path) -> Result<(), String> {
    pcm_reader(path)?.samples::<i16>().try_for_each(|sample| {
        sample
            .map(|_| ())
            .map_err(|e| format!("Incomplete WAV: {e}"))
    })
}
pub(crate) fn read_pcm(path: &Path) -> Result<Vec<i16>, String> {
    pcm_reader(path)?
        .samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Incomplete WAV: {e}"))
}
fn write_pcm(path: &Path, samples: &[i16]) -> Result<(), String> {
    let mut writer = hound::WavWriter::create(
        path,
        hound::WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .map_err(|e| e.to_string())?;
    for sample in samples {
        writer.write_sample(*sample).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())
}
fn check_cancel(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        Err("Speech processing cancelled.".into())
    } else {
        Ok(())
    }
}
fn run(
    executable: &Path,
    arguments: &[String],
    directory: &Path,
    name: &str,
    cancelled: &AtomicBool,
) -> Result<String, String> {
    check_cancel(cancelled)?;
    let stdout_path = directory.join(format!("{name}.stdout"));
    let stderr_path = directory.join(format!("{name}.stderr"));
    let mut child = Command::new(executable)
        .args(arguments)
        .stdout(Stdio::from(
            File::create(&stdout_path).map_err(|e| e.to_string())?,
        ))
        .stderr(Stdio::from(
            File::create(&stderr_path).map_err(|e| e.to_string())?,
        ))
        .spawn()
        .map_err(|e| format!("Could not start {name}: {e}"))?;
    let started = Instant::now();
    loop {
        if cancelled.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(3600) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "{name} cancelled or exceeded its one-hour processing limit."
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let detail = fs::read_to_string(&stderr_path).unwrap_or_default();
                    let tail: String = detail
                        .chars()
                        .rev()
                        .take(2000)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect();
                    return Err(format!("{name} failed: {tail}"));
                }
                return fs::read_to_string(stdout_path).map_err(|e| e.to_string());
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    }
}

#[repr(C)]
struct OptionPair {
    name: *const c_char,
    value: *const c_char,
}
#[repr(C)]
struct TranscriptLine {
    text: *const c_char,
    audio_data: *const f32,
    audio_data_count: usize,
    start_time: f32,
    duration: f32,
    id: u64,
    is_complete: i8,
    is_updated: i8,
    is_new: i8,
    has_text_changed: i8,
    have_speakers_changed: i8,
    speaker_spans: *const std::ffi::c_void,
    speaker_span_count: u64,
    last_transcription_latency_ms: u32,
    words: *const std::ffi::c_void,
    word_count: u64,
}
#[repr(C)]
struct Transcript {
    lines: *const TranscriptLine,
    line_count: u64,
}
type Load = unsafe extern "C" fn(*const c_char, u32, *const OptionPair, u64, i32) -> i32;
type Free = unsafe extern "C" fn(i32);
type Keyterms = unsafe extern "C" fn(i32, *const c_char) -> i32;
type Create = unsafe extern "C" fn(i32, u32) -> i32;
type Stream = unsafe extern "C" fn(i32, i32) -> i32;
type Add = unsafe extern "C" fn(i32, i32, *const f32, u64, i32, u32) -> i32;
type Transcribe = unsafe extern "C" fn(i32, i32, u32, *mut *const Transcript) -> i32;
type ErrorText = unsafe extern "C" fn(i32) -> *const c_char;
struct Moonshine {
    _library: Library,
    handle: i32,
    language: String,
    free: Free,
    keyterms: Keyterms,
    create: Create,
    free_stream: Stream,
    start: Stream,
    stop: Stream,
    add: Add,
    transcribe: Transcribe,
    error_text: ErrorText,
}
impl Moonshine {
    fn load(library: &Path, model: &Path, language: &str) -> Result<Self, String> {
        // The checked-in header's ABI is version 30000, tiny streaming architecture 2.
        unsafe {
            #[cfg(windows)]
            let loaded = libloading::os::windows::Library::load_with_flags(
                library,
                libloading::os::windows::LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR
                    | libloading::os::windows::LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
            )
            .map(Library::from);
            #[cfg(not(windows))]
            let loaded = Library::new(library);
            let library = loaded
                .map_err(|e| format!("Moonshine runtime is missing or cannot be loaded: {e}"))?;
            let version = library
                .get::<unsafe extern "C" fn() -> i32>(b"moonshine_get_version\0")
                .map_err(|e| e.to_string())?();
            if version != 30000 {
                return Err(format!(
                    "Moonshine ABI mismatch: expected 30000, got {version}."
                ));
            }
            let load = *library
                .get::<Load>(b"moonshine_load_transcriber_from_files\0")
                .map_err(|e| e.to_string())?;
            let free = *library
                .get::<Free>(b"moonshine_free_transcriber\0")
                .map_err(|e| e.to_string())?;
            let keyterms = *library
                .get::<Keyterms>(b"moonshine_transcriber_set_keyterms\0")
                .map_err(|e| e.to_string())?;
            let create = *library
                .get::<Create>(b"moonshine_create_stream\0")
                .map_err(|e| e.to_string())?;
            let free_stream = *library
                .get::<Stream>(b"moonshine_free_stream\0")
                .map_err(|e| e.to_string())?;
            let start = *library
                .get::<Stream>(b"moonshine_start_stream\0")
                .map_err(|e| e.to_string())?;
            let stop = *library
                .get::<Stream>(b"moonshine_stop_stream\0")
                .map_err(|e| e.to_string())?;
            let add = *library
                .get::<Add>(b"moonshine_transcribe_add_audio_to_stream\0")
                .map_err(|e| e.to_string())?;
            let transcribe = *library
                .get::<Transcribe>(b"moonshine_transcribe_stream\0")
                .map_err(|e| e.to_string())?;
            let error_text = *library
                .get::<ErrorText>(b"moonshine_error_to_string\0")
                .map_err(|e| e.to_string())?;
            let values = [
                ("return_audio_data", "false"),
                (
                    "max_tokens_per_second",
                    if ["zh", "ja"].contains(&language) {
                        "13.0"
                    } else {
                        "6.5"
                    },
                ),
                ("vad_threshold", "0.2"),
                ("vad_window_duration", "0.1"),
                ("vad_look_behind_sample_count", "32000"),
            ];
            let strings: Vec<_> = values
                .iter()
                .map(|(k, v)| (CString::new(*k).unwrap(), CString::new(*v).unwrap()))
                .collect();
            let options: Vec<_> = strings
                .iter()
                .map(|(k, v)| OptionPair {
                    name: k.as_ptr(),
                    value: v.as_ptr(),
                })
                .collect();
            let model = CString::new(arg(model)?).map_err(|e| e.to_string())?;
            let handle = load(
                model.as_ptr(),
                2,
                options.as_ptr(),
                options.len() as u64,
                30000,
            );
            if handle < 0 {
                return Err(moonshine_error(error_text, handle));
            }
            Ok(Self {
                _library: library,
                handle,
                language: language.into(),
                free,
                keyterms,
                create,
                free_stream,
                start,
                stop,
                add,
                transcribe,
                error_text,
            })
        }
    }
    fn status(&self, status: i32) -> Result<(), String> {
        if status == 0 {
            Ok(())
        } else {
            Err(unsafe { moonshine_error(self.error_text, status) })
        }
    }
    fn transcribe(&self, pcm: &[i16], language: &str, terms: &[String]) -> Result<Value, String> {
        let started = Instant::now();
        let samples: Vec<_> = pcm.iter().map(|s| *s as f32 / 32768.0).collect();
        let terms_c = CString::new(terms.join(",")).map_err(|e| e.to_string())?;
        unsafe {
            self.status((self.keyterms)(self.handle, terms_c.as_ptr()))?;
            let stream = (self.create)(self.handle, 0);
            if stream < 0 {
                return Err(moonshine_error(self.error_text, stream));
            }
            // Every request owns a fresh SDK stream, including after errors.
            let result = (|| {
                self.status((self.start)(self.handle, stream))?;
                self.status((self.add)(
                    self.handle,
                    stream,
                    samples.as_ptr(),
                    samples.len() as u64,
                    16000,
                    0,
                ))?;
                self.status((self.stop)(self.handle, stream))?;
                let mut transcript = std::ptr::null();
                self.status((self.transcribe)(self.handle, stream, 0, &mut transcript))?;
                let transcript = transcript
                    .as_ref()
                    .ok_or("Moonshine returned a missing transcript.")?;
                if transcript.line_count > (samples.len() / 1600 + 1) as u64
                    || (transcript.line_count > 0 && transcript.lines.is_null())
                {
                    return Err("Moonshine returned invalid transcript lines.".into());
                }
                let lines = if transcript.line_count == 0 {
                    &[][..]
                } else {
                    std::slice::from_raw_parts(transcript.lines, transcript.line_count as usize)
                };
                let mut segments = vec![];
                for line in lines {
                    if line.text.is_null() {
                        return Err("Moonshine returned missing transcript text.".into());
                    }
                    let text = CStr::from_ptr(line.text)
                        .to_str()
                        .map_err(|e| e.to_string())?
                        .trim();
                    if text.is_empty() {
                        continue;
                    }
                    let start = line.start_time as f64;
                    let end = start + line.duration as f64;
                    if !start.is_finite()
                        || !end.is_finite()
                        || start < 0.0
                        || end <= start
                        || end > samples.len() as f64 / 16000.0 + 1.0
                    {
                        return Err("Moonshine returned invalid phrase timestamps.".into());
                    }
                    segments.push(json!({ "text": text, "start": start, "end": end, "startMs": (start * 1000.0).round() as i64, "endMs": (end * 1000.0).round() as i64 }));
                }
                let text = segments
                    .iter()
                    .filter_map(|s| s["text"].as_str())
                    .collect::<Vec<_>>()
                    .join(if ["zh", "ja"].contains(&language) {
                        ""
                    } else {
                        " "
                    });
                Ok(
                    json!({ "text": text, "segments": segments, "language": language, "model": format!("moonshine-tiny-{language}"), "granularity": "phrase", "vad": "moonshine-embedded", "vocabularyTerms": terms.len(), "transcriptionMs": started.elapsed().as_secs_f64() * 1000.0, "duration": samples.len() as f64 / 16000.0 }),
                )
            })();
            let _ = (self.free_stream)(self.handle, stream);
            result
        }
    }
}
impl Drop for Moonshine {
    fn drop(&mut self) {
        unsafe {
            (self.free)(self.handle);
        }
    }
}
unsafe fn moonshine_error(error: ErrorText, code: i32) -> String {
    let pointer = error(code);
    let message = if pointer.is_null() {
        "Unknown speech error.".into()
    } else {
        CStr::from_ptr(pointer).to_string_lossy()
    };
    format!("Moonshine: {message}")
}

#[derive(Debug)]
struct Window {
    start: usize,
    end: usize,
    core_start: usize,
    core_end: usize,
}
fn windows(frames: usize) -> Vec<Window> {
    if frames <= 30 * 16000 {
        return vec![Window {
            start: 0,
            end: frames,
            core_start: 0,
            core_end: frames,
        }];
    }
    (0..frames)
        .step_by(28 * 16000)
        .map(|start| {
            let end = (start + 28 * 16000).min(frames);
            Window {
                start: start.saturating_sub(16000),
                end: (end + 16000).min(frames),
                core_start: start,
                core_end: end,
            }
        })
        .collect()
}
fn speech_regions(output: &str, frames: usize) -> Result<Vec<(usize, usize)>, String> {
    let count = output
        .lines()
        .find_map(|line| {
            line.strip_prefix("Detected ")
                .and_then(|s| s.strip_suffix(" speech segments:"))
                .and_then(|s| s.parse::<usize>().ok())
        })
        .ok_or("Silero did not return a valid speech detection result.")?;
    if count == 0 {
        return Ok(vec![]);
    }
    let mut regions: Vec<(usize, usize)> = vec![];
    let mut found = 0;
    for line in output
        .lines()
        .filter(|line| line.starts_with("Speech segment "))
    {
        let (_, times) = line
            .split_once(": start = ")
            .ok_or("Silero returned invalid speech regions.")?;
        let (start, end) = times
            .split_once(", end = ")
            .ok_or("Silero returned invalid speech regions.")?;
        let start: f64 = start.parse().map_err(|_| "Invalid VAD start.")?;
        let end: f64 = end.parse().map_err(|_| "Invalid VAD end.")?;
        if !start.is_finite()
            || !end.is_finite()
            || start < 0.0
            || end <= start
            || end * 160.0 > usize::MAX as f64
        {
            return Err("Silero returned invalid speech regions.".into());
        }
        // The pinned detector prints centiseconds; add 200 ms to its 800 ms pad.
        let first = (start * 160.0).round() as usize;
        let first = first.saturating_sub(3200);
        let last = ((end * 160.0).round() as usize)
            .saturating_add(3200)
            .min(frames);
        if first >= last {
            return Err("Silero returned out-of-range speech regions.".into());
        }
        if let Some(previous) = regions.last_mut().filter(|r| first <= r.1) {
            previous.1 = previous.1.max(last);
        } else {
            regions.push((first, last));
        }
        found += 1;
    }
    if found != count {
        return Err("Silero did not return all detected speech regions.".into());
    }
    Ok(regions)
}

fn aligned_segments(object: &Value) -> Result<Vec<Value>, String> {
    struct Word {
        text: String,
        points: Vec<i64>,
        original_end: i64,
        item: usize,
    }
    let items = object["transcription"]
        .as_array()
        .ok_or("Whisper returned an invalid transcript.")?;
    let mut words: Vec<Word> = vec![];
    for (item, segment) in items.iter().enumerate() {
        let tokens = segment["tokens"]
            .as_array()
            .ok_or("Whisper did not return DTW token alignment.")?;
        let original_end = segment["offsets"]["to"]
            .as_i64()
            .ok_or("Whisper returned invalid segment offsets.")?;
        for token in tokens {
            let Some(id) = token["id"].as_i64() else {
                continue;
            };
            let Some(text) = token["text"].as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            if !(0..50257).contains(&id) {
                continue;
            }
            let point = token["t_dtw"]
                .as_f64()
                .filter(|v| v.is_finite() && *v >= 0.0 && *v < i64::MAX as f64 / 10.0)
                .map(|v| v.round() as i64 * 10);
            let points: Vec<_> = point.into_iter().collect();
            let cjk = text
                .chars()
                .any(|c| matches!(c as u32, 0x3400..=0x9fff | 0x3040..=0x30ff | 0xac00..=0xd7af));
            if words.is_empty() || text.starts_with(char::is_whitespace) || cjk {
                words.push(Word {
                    text: text.into(),
                    points,
                    original_end,
                    item,
                });
            } else {
                let word = words.last_mut().unwrap();
                word.text.push_str(text);
                word.points.extend(points);
                word.original_end = original_end;
                word.item = item;
            }
        }
    }
    if words.iter().any(|w| w.points.is_empty()) {
        return Err("Whisper did not return usable DTW word alignment.".into());
    }
    let mut result: Vec<Value> = vec![];
    let mut pending = String::new();
    for (index, word) in words.iter().enumerate() {
        let start = word.points[0];
        let last = *word.points.last().unwrap();
        let end = if let Some(next) = words.get(index + 1) {
            if next.item == word.item {
                next.points[0]
            } else {
                next.points[0].min(last.max(word.original_end))
            }
        } else {
            last.max(word.original_end)
        };
        if end < start {
            return Err("Whisper returned nonmonotonic DTW alignment.".into());
        }
        if start == end {
            if index + 1 < words.len() || result.is_empty() {
                pending.push_str(&word.text);
            } else {
                let previous = result.last_mut().unwrap();
                previous["text"] = json!(format!(
                    "{}{}",
                    previous["text"].as_str().unwrap(),
                    word.text
                ));
            }
            continue;
        }
        result.push(json!({"text": format!("{pending}{}", word.text), "startMs": start, "endMs": end, "start": start as f64 / 1000.0, "end": end as f64 / 1000.0}));
        pending.clear();
    }
    if !pending.is_empty() {
        return Err("Whisper did not return positive-duration DTW alignment.".into());
    }
    Ok(result)
}
fn parse_diarization(object: &Value) -> Result<Value, String> {
    let raw = object
        .get("segments")
        .unwrap_or(object)
        .as_array()
        .ok_or("The diarizer returned an unsupported response.")?;
    let mut speakers = HashSet::new();
    let mut segments = vec![];
    for segment in raw {
        let start = segment["start"]
            .as_f64()
            .ok_or("Invalid diarization start.")?;
        let end = segment["end"].as_f64().ok_or("Invalid diarization end.")?;
        let speaker = segment["speaker"]
            .as_f64()
            .filter(|v| (1.0..=8.0).contains(v) && v.fract() == 0.0)
            .ok_or("Invalid diarization speaker.")? as u64;
        if !start.is_finite()
            || !end.is_finite()
            || start < 0.0
            || end < start
            || end >= i64::MAX as f64 / 1000.0
        {
            return Err("Invalid diarization timestamps.".into());
        }
        speakers.insert(speaker);
        segments.push(json!({"start": start, "end": end, "speaker": speaker, "startMs": (start * 1000.0).round() as i64, "endMs": (end * 1000.0).round() as i64}));
    }
    Ok(
        json!({"segments": segments, "model": "nemotron-diarization", "speakerCount": speakers.len()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_can_be_owned_by_tauri_mutex_without_unsafe_send() {
        fn assert_send<T: Send>() {}
        assert_send::<AsrRuntime>();
    }
    #[test]
    fn vocabulary_and_language_match_existing_dictation() {
        assert_eq!(normalize_language("ZH_cn"), "zh");
        assert_eq!(
            vocabulary(Some(&json!("Pace,hello\nPace,  world  "))).unwrap(),
            ["Pace", "hello", "world"]
        );
        assert!(vocabulary(Some(&json!("bad\0term"))).is_err());
        assert!(vocabulary(Some(&json!("x".repeat(4001)))).is_err());
    }
    #[test]
    fn vad_rejects_missing_output_and_preserves_silent_gaps() {
        assert!(speech_regions("", 160000).is_err());
        assert_eq!(
            speech_regions("Detected 0 speech segments:\n", 160000).unwrap(),
            []
        );
        assert_eq!(speech_regions("Detected 2 speech segments:\nSpeech segment 0: start = 0.00, end = 100.00\nSpeech segment 1: start = 400.00, end = 500.00\n", 160000).unwrap(), [(0, 19200), (60800, 83200)]);
        assert!(speech_regions(
            "Detected 1 speech segments:\nSpeech segment 0: start = NaN, end = 100",
            160000
        )
        .is_err());
    }
    #[test]
    fn overlap_windows_own_each_boundary_once() {
        let windows = windows(60 * 16000);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].end, 29 * 16000);
        assert_eq!(windows[1].start, 27 * 16000);
        assert_eq!(windows[0].core_end, windows[1].core_start);
    }
    #[test]
    fn alignment_ends_words_before_silent_gap() {
        let input = json!({"transcription": [
            {"offsets":{"to": 700},"tokens":[{"id":1,"text":" hello","t_dtw":10}]},
            {"offsets":{"to": 2500},"tokens":[{"id":2,"text":" world","t_dtw":200}]}]});
        let result = aligned_segments(&input).unwrap();
        assert_eq!(result[0]["endMs"], 700);
        assert_eq!(result[1]["startMs"], 2000);
        assert!(aligned_segments(
            &json!({"transcription":[{"offsets":{"to": 1},"tokens":[{"id":1,"text":" bad"}]}]})
        )
        .is_err());
    }
    #[test]
    fn speakers_are_anonymous_valid_numbers() {
        assert_eq!(parse_diarization(&json!({"segments":[{"start":0.1,"end":1.0,"speaker":1},{"start":1.0,"end":2.0,"speaker":2}]})).unwrap()["speakerCount"], 2);
        assert!(parse_diarization(&json!([{"start":0,"end":1,"speaker":0}])).is_err());
        assert_eq!(
            parse_diarization(&json!([{"start":0,"end":1,"speaker":1.0}])).unwrap()["speakerCount"],
            1
        );
        assert!(parse_diarization(&json!([{"start":2,"end":1,"speaker":1}])).is_err());
    }
    #[test]
    fn wav_reader_rejects_wrong_rate_and_empty_recordings() {
        let work = tempfile::tempdir().unwrap();
        let path = work.path().join("test.wav");
        write_pcm(&path, &[]).unwrap();
        assert!(read_pcm(&path).is_err());
        write_pcm(&path, &[0, i16::MIN, i16::MAX]).unwrap();
        assert_eq!(read_pcm(&path).unwrap(), [0, i16::MIN, i16::MAX]);
        let writer = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 1,
                sample_rate: 8000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        writer.finalize().unwrap();
        assert!(read_pcm(&path).is_err());
    }
    #[test]
    fn streaming_validation_keeps_pcm_format_and_truncation_checks() {
        let work = tempfile::tempdir().unwrap();
        let path = work.path().join("validation.wav");
        write_pcm(&path, &[0, i16::MIN, i16::MAX]).unwrap();
        validate_pcm(&path).unwrap();
        let length = fs::metadata(&path).unwrap().len();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(length - 1)
            .unwrap();
        assert!(validate_pcm(&path)
            .unwrap_err()
            .starts_with("Incomplete WAV:"));
        assert!(read_pcm(&path).is_err());
        write_pcm(&path, &[]).unwrap();
        assert!(validate_pcm(&path).is_err());
        for (rate, channels, bits, format) in [
            (8000, 1, 16, hound::SampleFormat::Int),
            (16000, 2, 16, hound::SampleFormat::Int),
            (16000, 1, 24, hound::SampleFormat::Int),
            (16000, 1, 32, hound::SampleFormat::Float),
        ] {
            let mut writer = hound::WavWriter::create(
                &path,
                hound::WavSpec {
                    channels,
                    sample_rate: rate,
                    bits_per_sample: bits,
                    sample_format: format,
                },
            )
            .unwrap();
            for _ in 0..channels {
                if format == hound::SampleFormat::Float {
                    writer.write_sample(0.5_f32).unwrap();
                } else {
                    writer.write_sample(1_i32).unwrap();
                }
            }
            writer.finalize().unwrap();
            assert_eq!(
                validate_pcm(&path).unwrap_err(),
                "Audio must be nonempty mono 16 kHz PCM16 WAV."
            );
        }
    }
    #[test]
    #[ignore = "requires bundled Whisper/Silero/NeMo CLIs and installed models; public human speech fixture only"]
    fn actual_public_whisper_and_diarization_backends() {
        let native = PathBuf::from(std::env::var_os("PACE_TEST_NATIVE_DIR").unwrap());
        let mut runtime = AsrRuntime::new(RuntimePaths {
            moonshine_library: PathBuf::new(),
            model_root: std::env::var_os("PACE_TEST_MODEL_ROOT").unwrap().into(),
            whisper_cli: native.join("bin/whisper-cli"),
            vad_cli: native.join("bin/whisper-vad-speech-segments"),
            diarization_cli: native.join("bin/nemo-speech"),
        });
        let path = std::env::var("PACE_TEST_PUBLIC_WAV").unwrap();
        let result = runtime
            .transcribe(&json!({"path": path,"purpose":"dictation","language":"auto"}))
            .unwrap();
        eprintln!("Whisper: {result}");
        assert_eq!(result["model"], "whisper-turbo");
        assert!(result["text"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("country"));
        assert!(result["segments"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["end"].as_f64().unwrap() > s["start"].as_f64().unwrap()));
        let work = tempfile::tempdir().unwrap();
        let silence = work.path().join("silence.wav");
        write_pcm(&silence, &vec![0; 16000 * 3]).unwrap();
        let silent = runtime
            .transcribe(&json!({"path": silence,"language":"auto"}))
            .unwrap();
        assert_eq!(silent["text"], "");
        assert_eq!(silent["speechWindows"], 0);
        let speakers = runtime.diarize(&json!({"path": path})).unwrap();
        eprintln!("NeMo: {speakers}");
        assert_eq!(speakers["speakerCount"], 1);
        assert!(!speakers["segments"].as_array().unwrap().is_empty());
    }
    #[test]
    #[ignore = "requires bundled Whisper/NeMo CLIs, installed models and the labelled synthetic meeting fixture"]
    fn actual_labelled_two_speaker_meeting() {
        let native = PathBuf::from(std::env::var_os("PACE_TEST_NATIVE_DIR").unwrap());
        let mut runtime = AsrRuntime::new(RuntimePaths {
            moonshine_library: native.join("lib/libmoonshine.dylib"),
            model_root: std::env::var_os("PACE_TEST_MODEL_ROOT").unwrap().into(),
            whisper_cli: native.join("bin/whisper-cli"),
            vad_cli: native.join("bin/whisper-vad-speech-segments"),
            diarization_cli: native.join("bin/nemo-speech"),
        });
        let path = std::env::var("PACE_TEST_MEETING_WAV").unwrap();
        let truth: Value = serde_json::from_slice(
            &fs::read(std::env::var("PACE_TEST_MEETING_TRUTH").unwrap()).unwrap(),
        )
        .unwrap();
        let transcript = runtime
            .transcribe(&json!({"path":path,"language":"en"}))
            .unwrap();
        let text = transcript["text"].as_str().unwrap().to_lowercase();
        eprintln!("Meeting Whisper: {transcript}");
        assert!(text.contains("monday") && text.contains("friday"));
        let result = runtime.diarize(&json!({"path":path})).unwrap();
        eprintln!("Meeting NeMo: {result}");
        let predicted = result["segments"].as_array().unwrap();
        let mut overlap = [[0.0_f64; 8]; 2];
        let mut reference_duration = 0.0;
        let mut dominant = vec![];
        for reference in truth.as_array().unwrap() {
            let start = reference["start"].as_f64().unwrap();
            let end = reference["end"].as_f64().unwrap();
            let expected = reference["speaker"].as_u64().unwrap() as usize - 1;
            reference_duration += end - start;
            let mut turn = [0.0_f64; 8];
            for segment in predicted {
                let seconds = (end.min(segment["end"].as_f64().unwrap())
                    - start.max(segment["start"].as_f64().unwrap()))
                .max(0.0);
                let speaker = segment["speaker"].as_u64().unwrap() as usize - 1;
                overlap[expected][speaker] += seconds;
                turn[speaker] += seconds;
            }
            dominant.push(
                turn.iter()
                    .enumerate()
                    .max_by(|a, b| a.1.total_cmp(b.1))
                    .unwrap()
                    .0
                    + 1,
            );
        }
        let assigned: f64 = overlap.iter().flatten().sum();
        let mut correct = 0.0_f64;
        for first in 0..8 {
            for second in 0..8 {
                if first != second {
                    correct = correct.max(overlap[0][first] + overlap[1][second]);
                }
            }
        }
        let accuracy = correct / assigned;
        let coverage = assigned / reference_duration;
        eprintln!(
            "Meeting separation: {}",
            json!({"dominantSpeakersByTurn":dominant,"assignedSpeechSpeakerAccuracy":accuracy,"referenceTurnCoverage":coverage,"referenceTurnSeconds":reference_duration,"assignedSpeechSeconds":assigned,"note":"Synthetic voices; turn references include silence. These overlap metrics are not DER."})
        );
        assert_eq!(result["speakerCount"], 2);
        assert_eq!(dominant.len(), 4);
        assert_ne!(dominant[0], dominant[1]);
        assert_eq!(dominant[0], dominant[2]);
        assert_eq!(dominant[1], dominant[3]);
        assert!(accuracy >= 0.9, "speaker assignment accuracy {accuracy}");
        assert!(coverage >= 0.6, "reference turn coverage {coverage}");
    }
    #[test]
    #[ignore = "requires the bundled native speech SDK and installed models; public human speech fixture only"]
    fn actual_public_speech_backend() {
        let mut runtime = AsrRuntime::new(RuntimePaths {
            moonshine_library: std::env::var_os("PACE_TEST_MOONSHINE_LIBRARY")
                .unwrap()
                .into(),
            model_root: std::env::var_os("PACE_TEST_MODEL_ROOT").unwrap().into(),
            whisper_cli: std::env::var_os("PACE_TEST_WHISPER_CLI")
                .unwrap_or_default()
                .into(),
            vad_cli: std::env::var_os("PACE_TEST_VAD_CLI")
                .unwrap_or_default()
                .into(),
            diarization_cli: PathBuf::new(),
        });
        let path = std::env::var("PACE_TEST_PUBLIC_WAV").unwrap();
        let result = runtime.transcribe(&json!({"path": path,"purpose":"dictation","language":"en","dictationVocabulary":"Americans"})).unwrap();
        eprintln!("{}", result);
        let text = result["text"].as_str().unwrap().to_lowercase();
        let reference: Vec<_> = "and so my fellow americans ask not what your country can do for you ask what you can do for your country".split_whitespace().collect();
        let actual: Vec<_> = text
            .split_whitespace()
            .map(|s| s.trim_matches(|c: char| !c.is_alphanumeric()))
            .collect();
        let mut costs: Vec<usize> = (0..=actual.len()).collect();
        for (i, expected) in reference.iter().enumerate() {
            let mut previous = costs[0];
            costs[0] = i + 1;
            for (j, found) in actual.iter().enumerate() {
                let diagonal = previous;
                previous = costs[j + 1];
                costs[j + 1] = (diagonal + usize::from(expected != found))
                    .min(costs[j] + 1)
                    .min(previous + 1);
            }
        }
        let word_error_rate = costs[actual.len()] as f64 / reference.len() as f64;
        eprintln!("JFK word error rate: {word_error_rate:.3}");
        assert!(
            word_error_rate <= 0.3,
            "Public JFK speech WER exceeded 30%: {text}"
        );
        assert_eq!(result["model"], "moonshine-tiny-en");
        assert_eq!(result["granularity"], "phrase");
        let work = tempfile::tempdir().unwrap();
        let silence = work.path().join("silence.wav");
        write_pcm(&silence, &vec![0; 16000 * 3]).unwrap();
        let silent = runtime
            .transcribe(&json!({"path": silence,"purpose":"dictation","language":"en"}))
            .unwrap();
        assert_eq!(silent["text"], "");
        assert_eq!(silent["segments"], json!([]));
    }
}
