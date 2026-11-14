#[cfg(any(not(target_os = "macos"), test))]
#[path = "insertion.rs"]
mod insertion;

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    pin::Pin,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
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
    generation: Arc<AtomicU64>,
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
            let generations = self.generation.clone();
            let generation = generations.fetch_add(1, Ordering::SeqCst) + 1;
            let handle = app.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(output).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            if line.len() > 4 * 1024 * 1024 {
                                continue;
                            }
                            let Ok(mut message) = serde_json::from_str::<Value>(&line) else {
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
                                if generations.load(Ordering::SeqCst) != generation {
                                    continue;
                                }
                                if !message["data"].is_object() {
                                    message["data"] = json!({});
                                }
                                message["data"]["_workerGeneration"] = json!(generation);
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
                if generations.load(Ordering::SeqCst) != generation {
                    return;
                }
                let stopped =
                    json!({"event":"runtime.stopped","data":{"_workerGeneration":generation}});
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
            "dictation.capture"
                | "dictation.insert"
                | "dictation.discard"
                | "dictation.clipboard.current"
                | "dictation.clipboard.restore"
        ) {
            let insertion = self.insertion.clone();
            let method = method.to_owned();
            let inserting = method == "dictation.insert";
            let handle = app.clone();
            let epoch = params["_uiEpoch"].as_u64().unwrap_or_else(|| {
                app.state::<crate::AppState>()
                    .ui_epoch
                    .load(Ordering::SeqCst)
            });
            return tauri::async_runtime::spawn_blocking(move || {
                insertion.request(&method, params, || {
                    let state = handle.state::<crate::AppState>();
                    (!inserting || state.ui_epoch.load(Ordering::SeqCst) == epoch)
                        && !state.shutting_down.load(Ordering::SeqCst)
                })
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
        let insertion_epoch = (method == "dictation.insert").then(|| {
            params["_uiEpoch"].as_u64().unwrap_or_else(|| {
                app.state::<crate::AppState>()
                    .ui_epoch
                    .load(Ordering::SeqCst)
            })
        });
        let insertion_current = || {
            let state = app.state::<crate::AppState>();
            insertion_epoch.is_none_or(|epoch| state.ui_epoch.load(Ordering::SeqCst) == epoch)
                && !state.shutting_down.load(Ordering::SeqCst)
        };
        if insertion_epoch.is_some() && !insertion_current() {
            return Err(
                "Dictation insertion was cancelled. Your words are available to copy.".into(),
            );
        }
        let worker = self.connect(app).await?;
        if insertion_epoch.is_some() && !insertion_current() {
            return Err(
                "Dictation insertion was cancelled. Your words are available to copy.".into(),
            );
        }
        let id = Uuid::new_v4().to_string();
        let (tx, mut rx) = oneshot::channel();
        worker.pending.lock().await.insert(id.clone(), tx);
        let payload = format!("{}\n", json!({"id":id,"method":method,"params":params}));
        let input = acquire_input(&worker.input, Duration::from_secs(2), || {
            insertion_epoch.is_none() || insertion_current()
        })
        .await;
        let Some(mut input) = input else {
            worker.pending.lock().await.remove(&id);
            if insertion_epoch.is_some() {
                return Ok(undispatched_insertion(
                    "Input was cancelled or could not be queued.",
                ));
            }
            return Err("The local assistant input is busy.".into());
        };
        if insertion_epoch.is_some() && !insertion_current() {
            worker.pending.lock().await.remove(&id);
            return Ok(undispatched_insertion(
                "Input was cancelled before dispatch.",
            ));
        }
        // Finish a frame once writing starts; cancellation then uses the scoped reply path.
        let written = matches!(
            tokio::time::timeout(Duration::from_secs(2), async {
                input.write_all(payload.as_bytes()).await?;
                input.flush().await
            })
            .await,
            Ok(Ok(()))
        );
        drop(input);
        if !written {
            worker.pending.lock().await.remove(&id);
            // A partial JSON frame cannot safely share the next request's input stream.
            let _ = worker.child.lock().await.kill().await;
            if insertion_epoch.is_some() {
                return Ok(uncertain_insertion("The input connection stopped."));
            }
            return Err("The local assistant input stopped responding.".into());
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
        let response = if insertion_epoch.is_some() {
            tokio::select! {
                result = tokio::time::timeout(Duration::from_secs(seconds), &mut rx) => result,
                _ = wait_until_cancelled(insertion_current) => {
                    return settle_cancelled_insertion(&worker, &id, &mut rx, "Input was cancelled and may be partial.").await;
                }
            }
        } else {
            tokio::time::timeout(Duration::from_secs(seconds), &mut rx).await
        };
        match response {
            Ok(Ok(result)) => result,
            Ok(Err(_)) if insertion_epoch.is_some() => {
                Ok(uncertain_insertion("The input connection stopped."))
            }
            Ok(Err(_)) => Err("The local assistant disconnected".into()),
            Err(_) => {
                if insertion_epoch.is_some() {
                    return settle_cancelled_insertion(
                        &worker,
                        &id,
                        &mut rx,
                        "Input confirmation took too long.",
                    )
                    .await;
                }
                worker.pending.lock().await.remove(&id);
                // Cancellation is scoped to this request, including a capture that just committed.
                cancel_worker_request(&worker, &id).await;
                Err(format!(
                    "{method} took too long. Saved work was preserved; cancel or retry."
                ))
            }
        }
    }

    pub async fn stop(&self) {
        self.voice.release().await;
        self.portable.stop().await;
        self.stop_adapter().await;
    }

    pub async fn stop_adapter(&self) {
        if let Some(worker) = self.worker.lock().await.take() {
            let _ = worker.child.lock().await.kill().await;
        }
    }

    pub fn is_current_worker(&self, generation: u64) -> bool {
        generation != 0 && self.generation.load(Ordering::SeqCst) == generation
    }

    pub fn worker_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
}

fn uncertain_insertion(reason: &str) -> Value {
    json!({"inserted":false,"dispatched":true,"verified":false,"insertionError":format!("{reason} Check the field before copying; Pace will not retry automatically.")})
}

fn undispatched_insertion(reason: &str) -> Value {
    json!({"inserted":false,"dispatched":false,"verified":false,"insertionError":format!("{reason} Your words are available to copy.")})
}

async fn acquire_input<'a, T>(
    input: &'a Mutex<T>,
    timeout: Duration,
    current: impl FnMut() -> bool,
) -> Option<tokio::sync::MutexGuard<'a, T>> {
    tokio::select! {
        biased;
        _ = wait_until_cancelled(current) => None,
        guard = tokio::time::timeout(timeout, input.lock()) => guard.ok(),
    }
}

async fn wait_until_cancelled(mut current: impl FnMut() -> bool) {
    while current() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn settle_cancelled_insertion(
    worker: &Worker,
    id: &str,
    reply: &mut oneshot::Receiver<Result<Value, String>>,
    reason: &str,
) -> Result<Value, String> {
    cancel_worker_request(worker, id).await;
    let result = tokio::time::timeout(Duration::from_secs(2), reply).await;
    worker.pending.lock().await.remove(id);
    match result {
        Ok(Ok(Ok(value))) => Ok(value),
        _ => Ok(uncertain_insertion(reason)),
    }
}

async fn cancel_worker_request(worker: &Worker, id: &str) {
    let Some(mut input) = acquire_input(&worker.input, Duration::from_secs(2), || true).await
    else {
        // A queued cancel has not changed the stream and must not destroy another turn's recovery.
        return;
    };
    let payload = format!("{}\n", cancellation_message(id));
    let cancel = async {
        input.write_all(payload.as_bytes()).await?;
        input.flush().await
    };
    let written = matches!(
        tokio::time::timeout(Duration::from_secs(2), cancel).await,
        Ok(Ok(()))
    );
    drop(input);
    if !written {
        let _ = worker.child.lock().await.kill().await;
    }
}

fn cancellation_message(request_id: &str) -> Value {
    json!({"id":Uuid::new_v4().to_string(),"method":"runtime.cancel","params":{"id":request_id}})
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn cancelled_request_waiting_for_input_never_acquires_or_writes() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let input = Arc::new(tokio::sync::Mutex::new(Vec::<u8>::new()));
        let held = input.lock().await;
        let current = Arc::new(AtomicBool::new(true));
        let queued_input = input.clone();
        let queued_current = current.clone();
        let queued = tokio::spawn(async move {
            if let Some(mut guard) =
                super::acquire_input(&queued_input, std::time::Duration::from_secs(2), || {
                    queued_current.load(Ordering::SeqCst)
                })
                .await
            {
                guard.push(1);
                return true;
            }
            false
        });
        tokio::task::yield_now().await;
        current.store(false, Ordering::SeqCst);
        assert!(
            !tokio::time::timeout(std::time::Duration::from_millis(200), queued)
                .await
                .unwrap()
                .unwrap()
        );
        assert!(held.is_empty());
        drop(held);
        assert!(input.lock().await.is_empty());
        assert_eq!(
            super::undispatched_insertion("cancelled")["dispatched"],
            false
        );
    }

    #[tokio::test]
    async fn input_lock_timeout_preserves_owner_and_later_requests_can_write() {
        let input = tokio::sync::Mutex::new(vec![7_u8]);
        let held = input.lock().await;
        assert!(
            super::acquire_input(&input, std::time::Duration::from_millis(10), || true)
                .await
                .is_none()
        );
        assert_eq!(&*held, &[7]);
        drop(held);
        assert!(
            super::acquire_input(&input, std::time::Duration::from_millis(10), || false)
                .await
                .is_none()
        );
        super::acquire_input(&input, std::time::Duration::from_millis(10), || true)
            .await
            .unwrap()
            .push(8);
        assert_eq!(&*input.lock().await, &[7, 8]);
    }

    #[tokio::test]
    async fn insertion_guard_stops_waiting_when_the_owner_cancels() {
        let current = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let watched = current.clone();
        let task = tokio::spawn(super::wait_until_cancelled(move || {
            watched.load(std::sync::atomic::Ordering::SeqCst)
        }));
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        current.store(false, std::sync::atomic::Ordering::SeqCst);
        tokio::time::timeout(std::time::Duration::from_millis(200), task)
            .await
            .unwrap()
            .unwrap();
    }
    #[test]
    fn queued_events_from_a_previous_worker_are_stale() {
        use std::sync::atomic::Ordering;
        let manager = super::NativeManager::default();
        assert!(!manager.is_current_worker(0));
        manager.generation.store(1, Ordering::SeqCst);
        assert!(manager.is_current_worker(1));
        manager.generation.store(2, Ordering::SeqCst);
        assert!(!manager.is_current_worker(1));
        assert!(manager.is_current_worker(2));
    }
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
