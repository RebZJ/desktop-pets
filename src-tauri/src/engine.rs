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
    pub fn native_stopped(&self) {
        self.native_meeting.store(false, Ordering::SeqCst);
    }

    pub async fn capture_request(
        &self,
        app: &AppHandle,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let _gate = self.capture_gate.lock().await;
        if matches!(method, "audio.start" | "meeting.start")
            && app.state::<AppState>().voicechat.active()
        {
            return Err("End voice chat before starting dictation or a meeting.".into());
        }
        if self.uses_native_capture() {
            match method {
                "meeting.status" => {
                    return app
                        .state::<AppState>()
                        .native
                        .request(app, method, params)
                        .await
                }
                "meeting.stop" => {
                    let result = app
                        .state::<AppState>()
                        .native
                        .request(app, method, params)
                        .await
                        .map(with_capture_errors);
                    if result.is_ok() {
                        self.native_meeting.store(false, Ordering::SeqCst);
                    }
                    return result;
                }
                "audio.start" | "meeting.start" | "voicechat.capture.start" => {
                    return Err("A meeting is already recording.".into())
                }
                _ => {}
            }
        }
        if method == "meeting.start" {
            for key in ["captureMicrophone", "captureSystem"] {
                if params.get(key).is_some_and(|value| !value.is_boolean()) {
                    return Err(format!("{key} must be a boolean"));
                }
            }
            let scoped = params["applicationBundleId"]
                .as_str()
                .is_some_and(|id| !id.is_empty());
            #[cfg(target_os = "macos")]
            if params["captureSystem"].as_bool().unwrap_or(true) || scoped {
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
        let portable_params = params.clone();
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
    async fn start_native(&self, app: &AppHandle, params: Value) -> Result<Value, String> {
        self.native_meeting.store(true, Ordering::SeqCst);
        let result = app
            .state::<AppState>()
            .native
            .request(app, "meeting.start", params)
            .await;
        match result {
            Ok(value) if self.uses_native_capture() => Ok(with_capture_errors(value)),
            Ok(_) => {
                let _ = app
                    .state::<AppState>()
                    .native
                    .request(app, "meeting.stop", json!({}))
                    .await;
                Err("The system audio adapter stopped during startup. Any captured audio is preserved; try again.".into())
            }
            Err(error) => {
                self.native_stopped();
                Err(error)
            }
        }
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
    fn preserves_track_failures_and_does_not_invent_errors_for_healthy_capture() {
        let capture = with_capture_errors(
            json!({"tracks":[{"track":"microphone"},{"track":"system","error":"disk full"}]}),
        );
        assert_eq!(capture["error"], "disk full");
        assert_eq!(with_capture_errors(capture)["error"], "disk full");
        assert!(with_capture_errors(json!({"tracks":[{}]}))["error"].is_null());
    }
}
