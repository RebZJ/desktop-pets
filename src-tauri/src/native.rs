#[cfg(any(not(target_os = "macos"), test))]
#[path = "insertion.rs"]
mod insertion;

use serde_json::{json, Value};
use std::{
    collections::HashMap, future::Future, path::PathBuf, pin::Pin, process::Stdio, sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
};
use uuid::Uuid;

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

struct Worker {
    input: Mutex<ChildStdin>,
    pending: Pending,
    child: Mutex<Child>,
}

#[derive(Default)]
pub struct NativeManager {
    worker: Mutex<Option<Arc<Worker>>>,
    portable: crate::portable::PortableManager,
    pub voice: crate::voice::Voice,
    #[cfg(not(target_os = "macos"))]
    insertion: Arc<insertion::Insertion>,
}

impl NativeManager {
    fn connect<'a>(
        &'a self,
        app: &'a AppHandle,
    ) -> Pin<Box<dyn Future<Output = Result<Arc<Worker>, String>> + Send + 'a>> {
        Box::pin(async move {
            let mut slot = self.worker.lock().await;
            if let Some(worker) = slot.as_ref() {
                if worker
                    .child
                    .lock()
                    .await
                    .try_wait()
                    .map_err(|e| e.to_string())?
                    .is_none()
                {
                    return Ok(worker.clone());
                }
                *slot = None;
            }
            let binary = worker_path(app)?;
            let data_dir = app.state::<crate::AppState>().data_dir.clone();
            let mut child = Command::new(&binary)
                .env("PACE_DATA_DIR", &data_dir)
                .env(
                    "PACE_MODELS_DIR",
                    std::env::var_os("PACE_MODELS_DIR")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| data_dir.join("models")),
                )
                .env("PACE_BIN_DIR", binary.parent().unwrap_or(&data_dir))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| {
                    format!("Could not start the local assistant: {e}. Run npm run native:build.")
                })?;
            let input = child.stdin.take().ok_or("Native input unavailable")?;
            let output = child.stdout.take().ok_or("Native output unavailable")?;
            let stderr = child.stderr.take();
            let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
            let reader_pending = pending.clone();
            let handle = app.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(output).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            if line.len() > 4 * 1024 * 1024 {
                                continue;
                            }
                            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                                continue;
                            };
                            if let Some(id) = message.get("id").and_then(Value::as_str) {
                                if let Some(sender) = reader_pending.lock().await.remove(id) {
                                    let result = if let Some(error) =
                                        message.get("error").filter(|v| !v.is_null())
                                    {
                                        Err(error
                                            .get("message")
                                            .and_then(Value::as_str)
                                            .unwrap_or("Native operation failed")
                                            .to_string())
                                    } else {
                                        Ok(message.get("result").cloned().unwrap_or(Value::Null))
                                    };
                                    let _ = sender.send(result);
                                }
                            } else if message.get("event").is_some() {
                                let _ = handle.emit("pace-event", &message);
                                let event_handle = handle.clone();
                                tokio::spawn(async move {
                                    crate::handle_native_event(event_handle, message).await;
                                });
                            }
                        }
                        _ => break,
                    }
                }
                for (_, sender) in reader_pending.lock().await.drain() {
                    let _=sender.send(Err("The local assistant stopped. Your saved work is intact; retry to restart it.".into()));
                }
                let stopped = json!({"event":"runtime.stopped","data":{}});
                let _ = handle.emit("pace-event", &stopped);
                crate::handle_native_event(handle, stopped).await;
            });
            if let Some(stderr) = stderr {
                tokio::spawn(async move {
                    let mut lines = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        eprintln!("[PaceNative] {line}");
                    }
                });
            }
            let worker = Arc::new(Worker {
                input: Mutex::new(input),
                pending,
                child: Mutex::new(child),
            });
            *slot = Some(worker.clone());
            Ok(worker)
        })
    }

    pub async fn request(
        &self,
        app: &AppHandle,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        match method {
            "voice.speak" => return self.voice.speak(app, params).await,
            "voice.stop" => {
                self.voice.stop();
                return Ok(json!({"stopped":true}));
            }
            "runtime.releaseVoice" => {
                self.voice.release().await;
                return Ok(json!({"released":true}));
            }
            _ => {}
        }
        #[cfg(not(target_os = "macos"))]
        if matches!(
            method,
            "dictation.capture" | "dictation.insert" | "dictation.discard"
        ) {
            let insertion = self.insertion.clone();
            let method = method.to_owned();
            return tauri::async_runtime::spawn_blocking(move || {
                insertion.request(&method, params)
            })
            .await
            .map_err(|error| error.to_string())?;
        }
        if crate::portable::enabled()
            && (!cfg!(target_os = "macos")
                || matches!(
                    method,
                    "models.status"
                        | "models.install"
                        | "chat.generate"
                        | "runtime.status"
                        | "runtime.cancel"
                ))
        {
            return self.portable.request(app, method, params).await;
        }
        let worker = self.connect(app).await?;
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        worker.pending.lock().await.insert(id.clone(), tx);
        let payload = format!("{}\n", json!({"id":id,"method":method,"params":params}));
        let write = async {
            let mut input = worker.input.lock().await;
            input.write_all(payload.as_bytes()).await?;
            input.flush().await
        }
        .await;
        if let Err(e) = write {
            worker.pending.lock().await.remove(&id);
            return Err(format!("The local assistant disconnected: {e}"));
        }
        let seconds = if method == "models.install" {
            7200
        } else if method == "chat.generate"
            || method == "audio.transcribe"
            || method == "audio.diarize"
        {
            900
        } else if method == "voice.speak" {
            300
        } else {
            60
        };
        match tokio::time::timeout(Duration::from_secs(seconds), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The local assistant disconnected".into()),
            Err(_) => {
                worker.pending.lock().await.remove(&id);
                // Cancellation is scoped to this request, including a capture that just committed.
                let cancel = async {
                    let payload = format!("{}\n", cancellation_message(&id));
                    let mut input = worker.input.lock().await;
                    input.write_all(payload.as_bytes()).await?;
                    input.flush().await
                };
                if !matches!(
                    tokio::time::timeout(Duration::from_secs(2), cancel).await,
                    Ok(Ok(()))
                ) {
                    let _ = worker.child.lock().await.kill().await;
                }
                Err(format!(
                    "{method} took too long. Saved work was preserved; cancel or retry."
                ))
            }
        }
    }

    pub async fn stop(&self) {
        self.voice.release().await;
        self.portable.stop().await;
        if let Some(worker) = self.worker.lock().await.take() {
            let _ = worker.child.lock().await.kill().await;
        }
    }
}

fn cancellation_message(request_id: &str) -> Value {
    json!({"id":Uuid::new_v4().to_string(),"method":"runtime.cancel","params":{"id":request_id}})
}

#[cfg(test)]
mod tests {
    #[test]
    fn timeout_cancellation_targets_only_the_original_request() {
        let message = super::cancellation_message("pending-microphone-permission");
        assert_eq!(message["method"], "runtime.cancel");
        assert_eq!(
            message["params"],
            serde_json::json!({"id":"pending-microphone-permission"})
        );
        assert_ne!(message["id"], message["params"]["id"]);
    }
}

fn worker_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("native/PaceNative"));
        candidates.push(resource.join("PaceNative"));
    }
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    candidates.push(project.join("native/bin/PaceNative"));
    candidates.push(project.join("native/PaceNative/.build/release/PaceNative"));
    candidates.into_iter().find(|p| p.is_file()).ok_or("The native assistant has not been built. Run npm run native:build, then restart Desktop Pets.".into())
}

pub fn model_catalog() -> Value {
    json!([
        {"id":"qwen3.5-4b","name":"Qwen 3.5 · 4B","role":"Meeting notes & questions","sizeBytes":3060000000_u64,"installed":false,"status":"not-installed"},
        {"id":"kitten-tts-micro-0.8-onnx","name":"Kitten Micro · portable voice","role":"voice","sizeBytes":44663872_u64,"installed":false,"status":"not-installed"},
        {"id":"qwen3-tts-0.6b","name":"Qwen 3 · Voice","role":"Multilingual voice","sizeBytes":1970000000_u64,"installed":false,"status":"not-installed"},
        {"id":"moonshine-tiny-en","name":"Moonshine Tiny · English","role":"Quick dictation","sizeBytes":45398523,"installed":false,"status":"not-installed"},
        {"id":"moonshine-tiny-zh","name":"Moonshine Tiny · Chinese","role":"Quick dictation","sizeBytes":32290152,"installed":false,"status":"not-installed"},
        {"id":"moonshine-tiny-ja","name":"Moonshine Tiny · Japanese","role":"Quick dictation","sizeBytes":32319961,"installed":false,"status":"not-installed"},
        {"id":"moonshine-tiny-es","name":"Moonshine Tiny · Spanish","role":"Quick dictation","sizeBytes":32316573,"installed":false,"status":"not-installed"},
        {"id":"whisper-turbo","name":"Whisper · Turbo","role":"Transcription & dictation","sizeBytes":574000000_u64,"installed":false,"status":"not-installed"},
        {"id":"nemotron-diarization","name":"Nemotron 3 · Speakers","role":"Speaker diarization","sizeBytes":107012128_u64,"installed":false,"status":"not-installed"}
    ])
}
