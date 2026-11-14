//! Shared portable listening and speech processing; OS adapters are limited to scoped capture.
use crate::{
    asr::{AsrRuntime, RuntimePaths},
    listening::Listening,
    AppState,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager};

pub struct Engine {
    pub capture: Arc<Listening>,
    speech: Arc<Mutex<AsrRuntime>>,
    pub cancelled: Arc<AtomicBool>,
    models: PathBuf,
    library: PathBuf,
    native_meeting: AtomicBool,
    native_capture: Mutex<Option<Value>>,
    capture_gate: tokio::sync::Mutex<()>,
    pub dictation_view: Mutex<Value>,
    pub saved_dictation: Mutex<Option<Value>>,
}

impl Engine {
    pub fn new(app: &AppHandle, data: &std::path::Path) -> Result<Self, String> {
        let models = std::env::var_os("PACE_MODELS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| data.join("models"));
        let library_name = if cfg!(windows) {
            "moonshine.dll"
        } else if cfg!(target_os = "macos") {
            "libmoonshine.dylib"
        } else {
            "libmoonshine.so"
        };
        let resource = app
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?;
        let bundled = resource.join("lib").join(library_name);
        let library = if bundled.is_file() {
            bundled
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../native/lib")
                .join(library_name)
        };
        let binary = |name: &str| {
            crate::portable::binary_path(app, name).unwrap_or_else(|_| {
                resource.join("native").join(if cfg!(windows) {
                    format!("{name}.exe")
                } else {
                    name.to_owned()
                })
            })
        };
        let speech = AsrRuntime::new(RuntimePaths {
            moonshine_library: library.clone(),
            model_root: models.clone(),
            whisper_cli: binary("whisper-cli"),
            vad_cli: binary("whisper-vad-speech-segments"),
            diarization_cli: binary("nemo-speech"),
        });
        let cancelled = speech.cancelled.clone();
        Ok(Self {
            capture: Arc::new(Listening::new()?),
            speech: Arc::new(Mutex::new(speech)),
            cancelled,
            models,
            library,
            native_meeting: AtomicBool::new(false),
            native_capture: Mutex::new(None),
            capture_gate: tokio::sync::Mutex::new(()),
            dictation_view: Mutex::new(json!({"phase":"idle"})),
            saved_dictation: Mutex::new(None),
        })
    }

    pub fn require_dictation_model(&self, language: &str) -> Result<(), String> {
        let language = language
            .split(['-', '_'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        let tiny = self.models.join(format!("moonshine-tiny-{language}"));
        let tiny_ready = [
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
        .all(|name| tiny.join(name).is_file());
        if ["en", "zh", "ja", "es"].contains(&language.as_str())
            && tiny_ready
            && self.library.is_file()
        {
            return Ok(());
        }
        let whisper = self.models.join("whisper-turbo");
        if whisper.join("ggml-large-v3-turbo-q5_0.bin").is_file()
            && whisper.join("ggml-silero-v6.2.0.bin").is_file()
        {
            return Ok(());
        }
        Err(
            "Install the dictation language pack or Whisper in Local models before recording."
                .into(),
        )
    }

    pub fn warm(&self, language: String) {
        let speech = self.speech.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Ok(mut runtime) = speech.lock() {
                let _ = runtime.prepare_dictation(&language);
            }
        });
    }

    pub async fn transcribe(&self, params: Value) -> Result<Value, String> {
        let speech = self.speech.clone();
        tauri::async_runtime::spawn_blocking(move || {
            speech
                .lock()
                .map_err(|e| e.to_string())?
                .transcribe(&params)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    pub async fn diarize(&self, params: Value) -> Result<Value, String> {
        let speech = self.speech.clone();
        tauri::async_runtime::spawn_blocking(move || {
            speech.lock().map_err(|e| e.to_string())?.diarize(&params)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub fn uses_native_capture(&self) -> bool {
        self.native_meeting.load(Ordering::SeqCst)
    }
    pub async fn adapter_stopped(
        &self,
        app: &AppHandle,
        generation: u64,
    ) -> Result<Option<Value>, String> {
        let _gate = self.capture_gate.lock().await;
        if !app.state::<AppState>().native.is_current_worker(generation)
            || !self.uses_native_capture()
        {
            return Ok(None);
        }
        app.state::<AppState>().native.stop_adapter().await;
        self.finish_native(
            app,
            Err("The system audio adapter stopped. Saved audio is preserved for retry.".into()),
        )
        .await
        .map(Some)
    }

    pub async fn capture_request(
        &self,
        app: &AppHandle,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let _gate = self.capture_gate.lock().await;
        if matches!(
            method,
            "audio.start" | "meeting.start" | "voicechat.capture.start"
        ) && app.state::<AppState>().shutting_down.load(Ordering::SeqCst)
        {
            return Err("Pace is shutting down".into());
        }
        if matches!(method, "audio.start" | "meeting.start")
            && app.state::<AppState>().voicechat.active()
        {
            return Err("End voice chat before starting dictation or a meeting.".into());
        }
        if self.uses_native_capture() {
            match method {
                "meeting.status" => {
                    let base = self.native_snapshot()?;
                    let system = tokio::time::timeout(std::time::Duration::from_secs(2), app
                        .state::<AppState>()
                        .native
                        .request(app, method, params))
                        .await.unwrap_or_else(|_| Err("The system audio adapter stopped responding. Saved audio is preserved.".into())).map(with_capture_errors);
                    let microphone = if self.native_snapshot()?["captureMicrophone"] == true {
                        Some(self.capture_status().await)
                    } else {
                        None
                    };
                    let failed = system.as_ref().map_or(true, |value| {
                        value["recording"] != true
                            || value["error"].as_str().is_some()
                            || value["sessionId"] != base["sessionId"]
                    }) || microphone.as_ref().is_some_and(|result| {
                        result.as_ref().map_or(true, |value| {
                            value["recording"] != true
                                || value["error"].as_str().is_some()
                                || value["sessionId"] != base["sessionId"]
                        })
                    });
                    if failed {
                        let failed = merge_meeting_capture(
                            self.native_snapshot()?,
                            system,
                            microphone,
                            false,
                        );
                        let error = failed["error"].as_str().unwrap_or("A meeting audio track stopped unexpectedly. Saved audio is preserved.").to_owned();
                        let stopped = self.stop_adapter(app).await;
                        let mut result = self.finish_native(app, stopped).await?;
                        append_capture_error(&mut result, &error);
                        return self.save_native(result, false);
                    }
                    let result =
                        merge_meeting_capture(self.native_snapshot()?, system, microphone, true);
                    return self.save_native(result, true);
                }
                "meeting.stop" => {
                    let stopped = self.stop_adapter(app).await;
                    return self.finish_native(app, stopped).await;
                }
                "audio.start" | "meeting.start" | "voicechat.capture.start" => {
                    return Err("A meeting is already recording.".into())
                }
                _ => {}
            }
        }
        if method == "meeting.status" || method == "meeting.stop" {
            if let Some(capture) = self
                .native_capture
                .lock()
                .map_err(|e| e.to_string())?
                .as_ref()
            {
                return Ok(capture.clone());
            }
        }
        if matches!(
            method,
            "audio.start" | "meeting.start" | "voicechat.capture.start"
        ) {
            self.native_capture
                .lock()
                .map_err(|e| e.to_string())?
                .take();
        }
        if method == "meeting.start" {
            for key in ["captureMicrophone", "captureSystem"] {
                if params.get(key).is_some_and(|value| !value.is_boolean()) {
                    return Err(format!("{key} must be a boolean"));
                }
            }
            #[cfg(not(target_os = "macos"))]
            let scoped = params["applicationBundleId"]
                .as_str()
                .is_some_and(|id| !id.is_empty());
            #[cfg(target_os = "macos")]
            if params["captureSystem"].as_bool().unwrap_or(true) {
                // CPAL's Mac process tap can stall during startup; ScreenCaptureKit owns Mac system audio.
                let status = self.capture_status().await?;
                if status["recording"] == true {
                    return Err("Stop the active recording first.".into());
                }
                let mut request = params;
                request["outputDir"] = json!(app.state::<AppState>().data_dir.join("recordings"));
                return self.start_native(app, request).await;
            }
            #[cfg(not(target_os = "macos"))]
            if scoped {
                return Err("Application-specific capture is unavailable on this platform. Choose all system audio.".into());
            }
        }
        let capture = self.capture.clone();
        let directory = app.state::<AppState>().data_dir.join("recordings");
        let operation = method.to_string();
        let mut portable_params = params.clone();
        if method == "meeting.start" && portable_params["captureSystem"] == false {
            // Application scope only selects system audio; microphone-only capture uses the shared input.
            portable_params
                .as_object_mut()
                .map(|params| params.remove("applicationBundleId"));
        }
        let result = tauri::async_runtime::spawn_blocking(move || match operation.as_str() {
            "audio.start" => capture.start_dictation(directory),
            "audio.stop" => capture.stop_dictation(),
            "voicechat.capture.start" => capture.start_voice(directory.join("voicechat")),
            "voicechat.capture.stop" => capture.stop_voice(),
            "meeting.start" => capture.start_meeting(directory, portable_params),
            "meeting.stop" => capture.stop_meeting(),
            "meeting.status" => capture.status(),
            _ => Err("Unknown capture request".into()),
        })
        .await
        .map_err(|e| e.to_string())?;
        result
    }

    #[cfg(target_os = "macos")]
    async fn start_native(&self, app: &AppHandle, mut params: Value) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let origin = std::time::Instant::now();
        let origin_ms = chrono::Utc::now().timestamp_millis();
        let microphone = params["captureMicrophone"].as_bool().unwrap_or(true);
        let directory = app.state::<AppState>().data_dir.join("recordings");
        self.save_native(json!({"sessionId":id,"mode":"meeting","recording":true,"directory":directory.join(&id),"startedAt":chrono::Utc::now().to_rfc3339(),"captureMicrophone":microphone,"captureSystem":true,"trackOffsets":{},"tracks":[]}), true)?;
        if microphone {
            let capture = self.capture.clone();
            let session_id = id.clone();
            let started = tauri::async_runtime::spawn_blocking(move || {
                capture.start_meeting_at(
                    directory,
                    json!({"captureMicrophone":true,"captureSystem":false}),
                    session_id,
                    origin,
                )
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|value| value);
            if let Err(error) = started {
                let _ = self.finish_native(app, Err(error.clone())).await;
                // Failed startup has no meeting record; drain derived chunks while keeping the WAVs.
                let _ = self.chunks().await;
                return Err(error);
            }
        }
        params["captureMicrophone"] = json!(false);
        params["_sessionId"] = json!(id);
        params["_originUnixMs"] = json!(origin_ms);
        self.native_meeting.store(true, Ordering::SeqCst);
        let result = if app.state::<AppState>().shutting_down.load(Ordering::SeqCst) {
            Err("Pace is shutting down".into())
        } else {
            app.state::<AppState>()
                .native
                .request(app, "meeting.start", params)
                .await
        };
        if result
            .as_ref()
            .is_ok_and(|value| value["sessionId"] == id && value["recording"] == true)
            && !app.state::<AppState>().shutting_down.load(Ordering::SeqCst)
        {
            let mic = if microphone {
                Some(self.capture_status().await)
            } else {
                None
            };
            let value = merge_meeting_capture(self.native_snapshot()?, result, mic, true);
            return self.save_native(value, true);
        }
        let error = result.err().unwrap_or_else(|| "The system audio adapter returned a different session during startup. Saved audio is preserved.".into());
        let stopped = self.stop_adapter(app).await;
        let _ = self.finish_native(app, stopped).await;
        let _ = self.chunks().await;
        Err(format!(
            "{error} Recording files are preserved in {}",
            app.state::<AppState>()
                .data_dir
                .join("recordings")
                .join(id)
                .display()
        ))
    }

    fn native_snapshot(&self) -> Result<Value, String> {
        self.native_capture
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or("No system audio meeting is active".into())
    }
    fn save_native(&self, capture: Value, active: bool) -> Result<Value, String> {
        *self.native_capture.lock().map_err(|e| e.to_string())? = Some(capture.clone());
        self.native_meeting.store(active, Ordering::SeqCst);
        Ok(capture)
    }
    async fn stop_adapter(&self, app: &AppHandle) -> Result<Value, String> {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(4),
            app.state::<AppState>()
                .native
                .request(app, "meeting.stop", json!({})),
        )
        .await
        .unwrap_or_else(|_| {
            Err("The system audio adapter did not stop in time. Saved audio is preserved.".into())
        });
        if result.is_err() {
            app.state::<AppState>().native.stop_adapter().await;
        }
        result
    }
    async fn finish_native(
        &self,
        app: &AppHandle,
        system: Result<Value, String>,
    ) -> Result<Value, String> {
        let base = self.native_snapshot()?;
        let repair_system = system.is_err();
        let microphone = if base["captureMicrophone"] == true {
            let capture = self.capture.clone();
            Some(
                tauri::async_runtime::spawn_blocking(move || capture.stop_meeting())
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|value| value),
            )
        } else {
            None
        };
        let mut result = merge_meeting_capture(base, system, microphone, false);
        // A dead adapter cannot finalize its response; retain every existing full track for recovery.
        for track in ["microphone", "system"] {
            let path = app
                .state::<AppState>()
                .data_dir
                .join("recordings")
                .join(
                    result["sessionId"]
                        .as_str()
                        .ok_or("Missing meeting session")?,
                )
                .join(format!("{track}.wav"));
            if track == "system" && repair_system && path.is_file() {
                match repair_native_wav(&path) {
                    Ok(frames) => {
                        if let Some(track) = result["tracks"].as_array_mut().and_then(|tracks| {
                            tracks.iter_mut().find(|track| track["track"] == "system")
                        }) {
                            track["frames"] = json!(frames);
                            track["durationMs"] = json!(frames * 1000 / 16000);
                        }
                    }
                    Err(error) => append_capture_error(
                        &mut result,
                        &format!("The system recording header needs recovery: {error}"),
                    ),
                }
            }
            if path.is_file()
                && !result["tracks"]
                    .as_array()
                    .is_some_and(|tracks| tracks.iter().any(|value| value["track"] == track))
            {
                let offset = result["trackOffsets"][track].as_u64().unwrap_or(0);
                result["tracks"]
                    .as_array_mut()
                    .ok_or("Invalid meeting tracks")?
                    .push(json!({"track":track,"path":path,"wavPath":path,"offsetMs":offset}));
            }
        }
        self.save_native(result, false)
    }

    pub async fn capture_status(&self) -> Result<Value, String> {
        let capture = self.capture.clone();
        tauri::async_runtime::spawn_blocking(move || capture.status())
            .await
            .map_err(|e| e.to_string())?
    }
    pub async fn chunks(&self) -> Result<Vec<Value>, String> {
        let capture = self.capture.clone();
        tauri::async_runtime::spawn_blocking(move || capture.take_chunks())
            .await
            .map_err(|e| e.to_string())?
    }
}

fn append_capture_error(capture: &mut Value, error: &str) {
    capture["error"] = json!(match capture["error"].as_str() {
        Some(existing) if existing != error => format!("{existing}; {error}"),
        _ => error.to_owned(),
    });
}

pub(crate) fn merge_meeting_capture(
    mut base: Value,
    system: Result<Value, String>,
    microphone: Option<Result<Value, String>>,
    recording: bool,
) -> Value {
    for (name, result) in
        std::iter::once(("system", system)).chain(microphone.map(|result| ("microphone", result)))
    {
        match result {
            Err(error) => append_capture_error(&mut base, &error),
            Ok(value) => {
                if value["sessionId"]
                    .as_str()
                    .is_some_and(|id| base["sessionId"] != id)
                {
                    append_capture_error(&mut base, "An audio track returned a different meeting session. Saved files are preserved.");
                    continue;
                }
                if let Some(error) = value["error"].as_str() {
                    append_capture_error(&mut base, &format!("{name}: {error}"));
                }
                if let Some(duration) = value["durationMs"].as_u64() {
                    base["durationMs"] =
                        json!(base["durationMs"].as_u64().unwrap_or(0).max(duration));
                }
                if name == "system" && !value["systemAudioScope"].is_null() {
                    base["systemAudioScope"] = value["systemAudioScope"].clone();
                }
                if let Some(offsets) = value["trackOffsets"].as_object() {
                    for (track, offset) in offsets {
                        if offset.is_u64() {
                            base["trackOffsets"][track] = offset.clone();
                        }
                    }
                }
                if let Some(tracks) = value["tracks"].as_array() {
                    for track in tracks.iter().filter(|track| track["track"] == name) {
                        let saved = base["tracks"]
                            .as_array_mut()
                            .expect("Meeting tracks are initialized at startup");
                        saved.retain(|saved| saved["track"] != name);
                        saved.push(track.clone());
                    }
                }
            }
        }
    }
    let mut tracks = base["tracks"].as_array().cloned().unwrap_or_default();
    let mut rms = 0.0_f64;
    let mut peak = 0.0_f64;
    for track in &mut tracks {
        if track["path"].as_str().is_none() {
            if let (Some(directory), Some(name)) = (
                base["directory"].as_str(),
                track["track"]
                    .as_str()
                    .filter(|name| ["microphone", "system"].contains(name)),
            ) {
                track["path"] = json!(std::path::Path::new(directory).join(format!("{name}.wav")));
                track["wavPath"] = track["path"].clone();
            }
        }
        if let (Some(name), Some(offset)) = (track["track"].as_str(), track["offsetMs"].as_u64()) {
            base["trackOffsets"][name] = json!(offset);
        }
        rms = rms.max(track["level"]["rms"].as_f64().unwrap_or(0.0));
        peak = peak.max(track["level"]["peak"].as_f64().unwrap_or(0.0));
    }
    base["tracks"] = json!(tracks);
    base["recording"] = json!(recording);
    base["level"] = if recording {
        json!({"rms":rms,"peak":peak})
    } else {
        json!({"rms":0,"peak":0})
    };
    with_capture_errors(base)
}

fn repair_native_wav(path: &std::path::Path) -> Result<u64, String> {
    use std::io::{Read, Seek, SeekFrom, Write};
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let mut header = [0_u8; 44];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    if &header[..4] != b"RIFF"
        || &header[8..16] != b"WAVEfmt "
        || &header[16..36]
            != [
                16, 0, 0, 0, 1, 0, 1, 0, 128, 62, 0, 0, 0, 125, 0, 0, 2, 0, 16, 0,
            ]
        || &header[36..40] != b"data"
    {
        return Err("Unexpected WAV format; the recording was left intact".into());
    }
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    let bytes = length.saturating_sub(44) / 2 * 2;
    let bytes = u32::try_from(bytes)
        .ok()
        .filter(|bytes| *bytes <= u32::MAX - 36)
        .ok_or("Recording exceeds WAV size limits")?;
    file.seek(SeekFrom::Start(4))
        .and_then(|_| file.write_all(&(bytes + 36).to_le_bytes()))
        .map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(40))
        .and_then(|_| file.write_all(&bytes.to_le_bytes()))
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(bytes as u64 / 2)
}

/// The platform adapter reports errors on individual tracks; preserve them at the shared boundary.
pub fn with_capture_errors(mut capture: Value) -> Value {
    let mut errors = Vec::new();
    if let Some(error) = capture["error"].as_str() {
        errors.push(error.to_owned());
    }
    if let Some(tracks) = capture["tracks"].as_array() {
        for track in tracks {
            if let Some(error) = track["error"].as_str() {
                if !errors.iter().any(|seen| seen == error) {
                    errors.push(error.to_owned());
                }
            }
        }
    }
    if !errors.is_empty() {
        capture["error"] = json!(errors.join("; "));
    }
    capture
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_track_identity_cannot_replace_current_meeting_audio() {
        let merged = merge_meeting_capture(
            json!({"sessionId":"current","directory":"recordings/current","trackOffsets":{},"tracks":[]}),
            Ok(json!({"sessionId":"old","tracks":[{"track":"system","path":"old.wav"}]})),
            None,
            false,
        );
        assert_eq!(merged["sessionId"], "current");
        assert!(merged["tracks"].as_array().unwrap().is_empty());
        assert!(merged["error"]
            .as_str()
            .unwrap()
            .contains("different meeting"));
    }
    #[test]
    fn adapter_crash_header_recovery_exposes_all_preserved_pcm_without_changing_samples() {
        use std::io::{Seek, SeekFrom, Write};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("system.wav");
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
        for sample in [0_i16, 200, -300, 400] {
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
        let original = std::fs::read(&path).unwrap();
        let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start(4)).unwrap();
        file.write_all(&36_u32.to_le_bytes()).unwrap();
        file.seek(SeekFrom::Start(40)).unwrap();
        file.write_all(&0_u32.to_le_bytes()).unwrap();
        drop(file);
        assert_eq!(hound::WavReader::open(&path).unwrap().duration(), 0);
        assert_eq!(repair_native_wav(&path).unwrap(), 4);
        assert_eq!(
            hound::WavReader::open(&path)
                .unwrap()
                .samples::<i16>()
                .map(Result::unwrap)
                .collect::<Vec<_>>(),
            [0, 200, -300, 400]
        );
        assert_eq!(std::fs::read(&path).unwrap(), original);
        let invalid = directory.path().join("other.wav");
        std::fs::write(&invalid, [7_u8; 60]).unwrap();
        assert!(repair_native_wav(&invalid).is_err());
        assert_eq!(std::fs::read(invalid).unwrap(), [7_u8; 60]);
    }
    #[test]
    fn preserves_track_failures_and_does_not_invent_errors_for_healthy_capture() {
        let capture = with_capture_errors(
            json!({"tracks":[{"track":"microphone"},{"track":"system","error":"disk full"}]}),
        );
        assert_eq!(capture["error"], "disk full");
        assert_eq!(with_capture_errors(capture)["error"], "disk full");
        assert!(with_capture_errors(json!({"tracks":[{}]}))["error"].is_null());
    }
}
