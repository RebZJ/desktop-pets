//! Portable offline model management and the app-owned llama.cpp child process.
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, Command},
    sync::{oneshot, Mutex},
};
use uuid::Uuid;

type Emit = Arc<dyn Fn(Value) + Send + Sync>;
type Operations = HashMap<String, (String, oneshot::Sender<()>)>;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelFile {
    path: String,
    size: u64,
    sha256: String,
    #[serde(rename = "sourceURL")]
    source_url: String,
}
#[derive(Clone, Deserialize, Serialize)]
struct Model {
    id: String,
    name: String,
    role: String,
    directory: String,
    repository: String,
    revision: String,
    files: Vec<ModelFile>,
}

fn catalog() -> Vec<Model> {
    serde_json::from_str(include_str!("../../native/portable-models.json"))
        .expect("bundled model manifest")
}

pub fn enabled() -> bool {
    std::env::var("PACE_PORTABLE_RUNTIME").map_or(true, |v| v != "0")
}

pub fn models_dir(app: &AppHandle) -> PathBuf {
    std::env::var_os("PACE_MODELS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| app.state::<crate::AppState>().data_dir.join("models"))
}

pub fn binary_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let filename = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let mut candidates = vec![];
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("native").join(&filename));
        candidates.push(resource.join(&filename));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../native/bin")
            .join(filename),
    );
    candidates.into_iter().find(|p| p.is_file()).ok_or_else(|| {
        format!("The bundled {name} runtime is missing. Rebuild the portable native runtime.")
    })
}

#[derive(Default)]
pub struct PortableManager {
    server: Mutex<Option<Server>>,
    generation: Mutex<()>,
    operations: Mutex<Operations>,
    progress: Mutex<HashMap<String, f64>>,
}

impl PortableManager {
    pub async fn request(
        &self,
        app: &AppHandle,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let emit_app = app.clone();
        let emit: Emit = Arc::new(move |event| {
            let _ = emit_app.emit("pace-event", event);
        });
        let root = models_dir(app);
        match method {
            "models.status" => Ok(self.status(&root).await),
            "runtime.status" => Ok(json!({"busy": self.generation.try_lock().is_err(),
                "textLoaded": self.server.lock().await.as_mut().is_some_and(|s| matches!(s.child.try_wait(), Ok(None))),
                "voiceLoaded":false,"backend":"llama.cpp · local CPU/Metal","offline":true,
                "dataDirectory":app.state::<crate::AppState>().data_dir,"whisperAvailable":binary_path(app,"whisper-cli").is_ok()})),
            "runtime.cancel" => {
                let target = params["id"].as_str().or_else(|| params["requestId"].as_str());
                let count = self.cancel(target).await;
                Ok(json!({"cancelled":count}))
            }
            "voice.stop" | "runtime.releaseVoice" => Ok(json!({"stopped":true,"released":true})),
            "voice.speak" => Err("Voice playback is not available in the portable runtime. Dictation, meeting notes and text answers remain available.".into()),
            "apps.list" => Ok(json!([])),
            "permissions.status" => Ok(json!({"microphone":"on-recording","accessibility":"unsupported","screenRecording":"on-recording","systemAudio":"on-recording","automation":"unsupported","textInsertion":if cfg!(windows){"verified-native-edit-controls"}else{"copy-only"}})),
            "permissions.request" => Err("Audio access is requested when you start recording. Dictation insertion requires a verified supported text field; otherwise use Copy transcript and paste into your app.".into()),
            "models.install" | "chat.generate" => {
                // Hold the generation slot through cancellation cleanup so a new answer cannot be killed with the old child.
                let _generation = if method == "chat.generate" {
                    Some(self.generation.try_lock().map_err(|_| "Pace is already generating. Try again when it finishes.")?)
                } else {None};
                let id = params["_requestId"].as_str().or_else(|| params["clientRequestId"].as_str())
                    .filter(|v| !v.is_empty() && v.len() <= 128).map(str::to_owned).unwrap_or_else(|| Uuid::new_v4().to_string());
                let (cancel_tx, cancel_rx) = oneshot::channel();
                let install_id = if method == "models.install" {
                    let requested = params["id"].as_str().or_else(|| params["model"].as_str()).ok_or("Provide the model id.")?;
                    let canonical = if requested == "nemotron-3-diarization" { "nemotron-diarization" } else { requested };
                    if !catalog().iter().any(|m|m.id==canonical) {return Err("Unknown portable model id.".into());}
                    Some(canonical.to_string())
                } else {None};
                {
                    let mut operations = self.operations.lock().await;
                    if operations.contains_key(&id) { return Err("This request is already running.".into()); }
                    if let Some(model_id) = &install_id {
                        let mut progress = self.progress.lock().await;
                        if progress.contains_key(model_id) {return Err("This model is already downloading.".into());}
                        progress.insert(model_id.clone(),0.0);
                    }
                    operations.insert(id.clone(), (method.to_string(), cancel_tx));
                }
                let action = async {
                    if method == "models.install" {
                        let model_id = params["id"].as_str().or_else(|| params["model"].as_str()).ok_or("Provide the model id.")?;
                        self.install(&root, model_id, emit.clone()).await
                    } else {
                        self.generate(&root, &binary_path(app,"llama-server")?, &params, emit.clone()).await
                    }
                };
                let timeout = if method == "models.install" { 7200 } else { 900 };
                let (result, interrupted) = tokio::select! {
                    result = tokio::time::timeout(Duration::from_secs(timeout), action) => match result {
                        Ok(result) => (result,false),
                        Err(_) => (Err(format!("{method} took too long. Saved work was preserved; retry.")),true),
                    },
                    _ = cancel_rx => (Err("Request cancelled. Saved work was preserved.".into()),true)
                };
                self.operations.lock().await.remove(&id);
                if let Some(model_id) = &install_id {
                    self.progress.lock().await.remove(model_id);
                } else if interrupted {
                    // Closing an SSE connection alone does not guarantee an engine stopped decoding.
                    self.stop_server().await;
                }
                result
            }
            _ => Err(format!("{method} is unavailable on this platform. Copy text into Pace or paste its answer into your app.")),
        }
    }

    async fn cancel(&self, target: Option<&str>) -> usize {
        let mut operations = self.operations.lock().await;
        let ids: Vec<_> = operations
            .keys()
            .filter(|id| target.is_none_or(|target| target == id.as_str()))
            .cloned()
            .collect();
        let mut count = 0;
        for id in ids {
            if let Some((_, sender)) = operations.remove(&id) {
                let _ = sender.send(());
                count += 1;
            }
        }
        count
    }

    async fn status(&self, root: &Path) -> Value {
        let progress = self.progress.lock().await;
        json!(catalog().iter().map(|model| {
            let installed = installed(root, model);
            let downloading = progress.get(&model.id);
            json!({"id":model.id,"name":model.name,"role":model.role,"sizeBytes":model.files.iter().map(|f| f.size).sum::<u64>(),
                "installed":installed,"status":if downloading.is_some() {"downloading"} else if installed {"installed"} else {"not-installed"},
                "progress":if installed {1.0} else {downloading.copied().unwrap_or(0.0)}})
        }).collect::<Vec<_>>())
    }

    async fn install(&self, root: &Path, id: &str, emit: Emit) -> Result<Value, String> {
        let canonical = if id == "nemotron-3-diarization" {
            "nemotron-diarization"
        } else {
            id
        };
        let model = catalog()
            .into_iter()
            .find(|m| m.id == canonical)
            .ok_or("Unknown portable model id.")?;
        let destination = root.join(&model.directory);
        tokio::fs::create_dir_all(&destination)
            .await
            .map_err(|e| e.to_string())?;
        let total: u64 = model.files.iter().map(|f| f.size).sum();
        let mut completed = 0;
        let client = reqwest::Client::builder()
            .https_only(true)
            .connect_timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()
            .map_err(|e| e.to_string())?;
        for file in &model.files {
            validate_file(file)?;
            let path = destination.join(&file.path);
            if verified(&path, file).await? {
                completed += file.size;
                continue;
            }
            let partial = path.with_extension(format!(
                "{}.partial",
                path.extension().and_then(|s| s.to_str()).unwrap_or("model")
            ));
            let result = download(&client, file, &partial, |received| {
                let fraction = (completed + received) as f64 / total as f64;
                emit(json!({"event":"models.progress","data":{"id":model.id,"progress":fraction,"receivedBytes":completed+received,"totalBytes":total}}));
            }).await;
            if let Err(error) = result {
                let _ = tokio::fs::remove_file(&partial).await;
                return Err(error);
            }
            // A verified model is never replaced by an incomplete download.
            if cfg!(windows) && path.exists() {
                tokio::fs::remove_file(&path)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            tokio::fs::rename(&partial, &path)
                .await
                .map_err(|e| e.to_string())?;
            completed += file.size;
            self.progress
                .lock()
                .await
                .insert(model.id.clone(), completed as f64 / total as f64);
        }
        let marker = destination.join(".installed.json.partial");
        tokio::fs::write(
            &marker,
            serde_json::to_vec(&model).map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;
        let final_marker = destination.join(".installed.json");
        if cfg!(windows) && final_marker.exists() {
            tokio::fs::remove_file(&final_marker)
                .await
                .map_err(|e| e.to_string())?;
        }
        tokio::fs::rename(marker, final_marker)
            .await
            .map_err(|e| e.to_string())?;
        emit(
            json!({"event":"models.progress","data":{"id":model.id,"progress":1.0,"installed":true}}),
        );
        Ok(json!({"id":model.id,"installed":true}))
    }

    async fn generate(
        &self,
        root: &Path,
        binary: &Path,
        params: &Value,
        emit: Emit,
    ) -> Result<Value, String> {
        let (mut messages, max_tokens, precise) = validate_chat(params)?;
        let model = catalog().remove(0);
        if !installed(root, &model) {
            return Err(
                "Install Qwen 3.5 4B from Local models before asking for meeting notes or answers."
                    .into(),
            );
        }
        let (endpoint, key, client) = {
            let mut slot = self.server.lock().await;
            if slot
                .as_mut()
                .is_some_and(|s| !matches!(s.child.try_wait(), Ok(None)))
            {
                *slot = None;
            }
            if slot.is_none() {
                emit(json!({"event":"runtime.loading","data":{"model":model.id}}));
                *slot = Some(
                    Server::start(
                        binary,
                        &root.join(&model.directory).join(&model.files[0].path),
                    )
                    .await?,
                );
            }
            let server = slot.as_ref().unwrap();
            (
                server.endpoint.clone(),
                server.key.clone(),
                server.client.clone(),
            )
        };
        let mut removed = 0;
        loop {
            let rendered = local_json(
                &client,
                &endpoint,
                &key,
                "apply-template",
                json!({"messages":messages}),
            )
            .await?;
            let prompt = rendered["prompt"]
                .as_str()
                .ok_or("The local model could not format the conversation.")?;
            let tokens = local_json(
                &client,
                &endpoint,
                &key,
                "tokenize",
                json!({"content":prompt,"add_special":true,"parse_special":true}),
            )
            .await?;
            let length = tokens["tokens"]
                .as_array()
                .ok_or("The local model tokenizer returned no tokens.")?
                .len();
            if length + max_tokens as usize <= 8192 {
                break;
            }
            let oldest = messages.iter().take(messages.len().saturating_sub(1)).position(|m|m["role"] != "system")
                .ok_or("Your system instructions and latest message exceed Pace's 8K context. Shorten the latest message or instructions.")?;
            messages.remove(oldest);
            removed += 1;
        }
        if removed > 0 {
            emit(json!({"event":"chat.contextTrimmed","data":{"removedMessages":removed}}));
        }
        let response = client.post(format!("{endpoint}/v1/chat/completions")).bearer_auth(&key)
            .json(&json!({"messages":messages,"max_tokens":max_tokens,"temperature":if precise {0.0} else {0.7},"top_p":0.9,"top_k":20,"repeat_penalty":1.1,"stream":true,"chat_template_kwargs":{"enable_thinking":false}}))
            .send().await.map_err(|e|format!("The local text engine disconnected: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Local text inference failed (HTTP {}). Retry the request.",
                response.status()
            ));
        }
        let client_id = params["clientRequestId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .map(str::to_owned);
        let text = read_sse(response, |delta| {
            let mut data = json!({"text":delta});
            if let Some(id) = &client_id {
                data["clientRequestId"] = json!(id);
            }
            emit(json!({"event":"chat.delta","data":data}));
        })
        .await?;
        Ok(json!({"text":text,"model":model.id}))
    }

    async fn stop_server(&self) {
        if let Some(mut server) = self.server.lock().await.take() {
            let _ = server.child.kill().await;
            let _ = server.child.wait().await;
        }
    }
    pub async fn stop(&self) {
        for (_, (_, sender)) in self.operations.lock().await.drain() {
            let _ = sender.send(());
        }
        self.stop_server().await;
    }
}

fn validate_chat(params: &Value) -> Result<(Vec<Value>, u64, bool), String> {
    let messages = params["messages"]
        .as_array()
        .filter(|m| !m.is_empty() && m.len() <= 100)
        .ok_or("Provide 1–100 chat messages.")?;
    let mut total = 0;
    for message in messages {
        let content = message["content"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 100_000)
            .ok_or("Messages require text content of 1–100,000 bytes.")?;
        total += content.len();
        if !matches!(
            message["role"].as_str(),
            Some("system" | "user" | "assistant")
        ) {
            return Err("Messages require a system, user or assistant role.".into());
        }
    }
    if total > 1_048_576 {
        return Err("The conversation exceeds the 1 MB request limit.".into());
    }
    let max_tokens = match params.get("maxTokens") {
        None => 512,
        Some(v) => v
            .as_u64()
            .filter(|n| (1..=2048).contains(n))
            .ok_or("maxTokens must be an integer between 1 and 2048.")?,
    };
    let precise = match params.get("precise") {
        None => false,
        Some(v) => v.as_bool().ok_or("precise must be a Boolean.")?,
    };
    // Rebuild objects so callers cannot inject tools, image URLs or server options.
    Ok((
        messages
            .iter()
            .map(|m| json!({"role":m["role"],"content":m["content"]}))
            .collect(),
        max_tokens,
        precise,
    ))
}

fn validate_file(file: &ModelFile) -> Result<(), String> {
    if file.path.is_empty()
        || Path::new(&file.path)
            .components()
            .any(|p| !matches!(p, std::path::Component::Normal(_)))
        || file.path.contains('\\')
        || file.path.contains(':')
        || file.size == 0
        || file.sha256.len() != 64
        || !file.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        || !file.source_url.starts_with("https://")
    {
        return Err("Invalid bundled model manifest.".into());
    }
    Ok(())
}

fn installed(root: &Path, model: &Model) -> bool {
    let directory = root.join(&model.directory);
    let Ok(marker) = std::fs::read(directory.join(".installed.json")) else {
        return false;
    };
    let Ok(saved) = serde_json::from_slice::<Value>(&marker) else {
        return false;
    };
    let Some(files) = saved["files"].as_array() else {
        return false;
    };
    model.files.iter().all(|file| {
        validate_file(file).is_ok()
            && files.iter().any(|s| {
                s["path"] == file.path && s["size"] == file.size && s["sha256"] == file.sha256
            })
            && std::fs::metadata(directory.join(&file.path))
                .is_ok_and(|m| m.is_file() && m.len() == file.size)
    })
}

async fn verified(path: &Path, file: &ModelFile) -> Result<bool, String> {
    if !std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() == file.size) {
        return Ok(false);
    }
    let path = path.to_path_buf();
    let expected = file.sha256.clone();
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut digest = Sha256::new();
        let mut buffer = vec![0; 1024 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        Ok(format!("{:x}", digest.finalize()) == expected)
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn download(
    client: &reqwest::Client,
    file: &ModelFile,
    path: &Path,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    let response = client
        .get(&file.source_url)
        .send()
        .await
        .map_err(|e| format!("Model download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Model download failed: {e}"))?;
    if response.content_length().is_some_and(|n| n != file.size) {
        return Err("Model download size did not match its pinned manifest.".into());
    }
    let mut output = tokio::fs::File::create(path)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut digest = Sha256::new();
    let mut received = 0;
    let mut last = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if received > file.size {
            return Err("Model download exceeded its pinned size.".into());
        }
        digest.update(&chunk);
        output.write_all(&chunk).await.map_err(|e| e.to_string())?;
        if last.elapsed() >= Duration::from_millis(250) {
            progress(received);
            last = std::time::Instant::now();
        }
    }
    output.sync_all().await.map_err(|e| e.to_string())?;
    drop(output);
    if received != file.size || format!("{:x}", digest.finalize()) != file.sha256 {
        return Err(
            "Model download failed SHA-256 verification. Retry to download a clean copy.".into(),
        );
    }
    progress(received);
    Ok(())
}

struct Server {
    child: Child,
    endpoint: String,
    key: String,
    client: reqwest::Client,
}
impl Server {
    async fn start(binary: &Path, model: &Path) -> Result<Self, String> {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        drop(listener);
        let endpoint = format!("http://127.0.0.1:{port}");
        let key = Uuid::new_v4().to_string();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(900))
            .build()
            .map_err(|e| e.to_string())?;
        let mut child = Command::new(binary)
            .arg("--model")
            .arg(model)
            .args([
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--ctx-size",
                "8192",
                "--parallel",
                "1",
                "--no-webui",
                "--reasoning",
                "off",
                "--no-context-shift",
            ])
            .env("LLAMA_API_KEY", &key)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Could not start the bundled local text engine: {e}"))?;
        for _ in 0..600 {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                return Err("The local text engine could not load the model. Reinstall Qwen from Local models or rebuild the runtime.".into());
            }
            if client
                .get(format!("{endpoint}/health"))
                .bearer_auth(&key)
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                return Ok(Self {
                    child,
                    endpoint,
                    key,
                    client,
                });
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let _ = child.kill().await;
        Err("Loading the local text model took too long. Retry after closing other large applications.".into())
    }
}

async fn local_json(
    client: &reqwest::Client,
    endpoint: &str,
    key: &str,
    path: &str,
    body: Value,
) -> Result<Value, String> {
    let response = client
        .post(format!("{endpoint}/{path}"))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "The local text engine rejected {path} (HTTP {}).",
            response.status()
        ));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("The local text engine returned too much data.".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|e| format!("Invalid response from the local text engine: {e}"))
}

#[derive(Default)]
struct Sse {
    pending: Vec<u8>,
    text: String,
    done: bool,
}
impl Sse {
    fn push(&mut self, chunk: &[u8], emit: &mut impl FnMut(&str)) -> Result<(), String> {
        self.pending.extend_from_slice(chunk);
        if self.pending.len() > 256 * 1024 {
            return Err("The local text engine sent an oversized stream event.".into());
        }
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<_> = self.pending.drain(..=end).collect();
            let line = std::str::from_utf8(&line)
                .map_err(|_| "The local text engine returned invalid UTF-8.")?
                .trim();
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data == "[DONE]" {
                self.done = true;
                break;
            }
            let event: Value = serde_json::from_str(data)
                .map_err(|_| "The local text engine returned an invalid stream event.")?;
            if event.get("error").is_some() {
                return Err("The local text engine failed while generating the answer.".into());
            }
            if let Some(text) = event["choices"][0]["delta"]["content"].as_str() {
                if self.text.len() + text.len() > 128 * 1024 {
                    return Err("The generated answer exceeded its size limit.".into());
                }
                self.text.push_str(text);
                emit(text);
            }
        }
        Ok(())
    }
    fn finish(self) -> Result<String, String> {
        if !self.done {
            return Err(
                "The local text engine disconnected before completing its answer. Retry.".into(),
            );
        }
        if self.text.trim().is_empty() {
            return Err("The model returned no answer. Try again.".into());
        }
        Ok(self.text)
    }
}
async fn read_sse(
    response: reqwest::Response,
    mut emit: impl FnMut(&str),
) -> Result<String, String> {
    let mut stream = response.bytes_stream();
    let mut parser = Sse::default();
    while let Some(chunk) = stream.next().await {
        parser.push(&chunk.map_err(|e| e.to_string())?, &mut emit)?;
        if parser.done {
            break;
        }
    }
    parser.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_handles_utf8_split_across_reads_and_requires_completion() {
        let wire="data: {\"choices\":[{\"delta\":{\"content\":\"Hello 世界\"}}]}\r\n\r\ndata: [DONE]\n\n";
        let mut parser = Sse::default();
        let mut deltas = String::new();
        for byte in wire.as_bytes() {
            parser.push(&[*byte], &mut |s| deltas.push_str(s)).unwrap();
        }
        assert_eq!(parser.finish().unwrap(), "Hello 世界");
        assert_eq!(deltas, "Hello 世界");
        let mut truncated = Sse::default();
        truncated
            .push(
                b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n",
                &mut |_| {},
            )
            .unwrap();
        assert!(truncated.finish().unwrap_err().contains("disconnected"));
    }

    #[test]
    fn chat_validates_types_and_strips_injected_tools() {
        let base =
            json!({"messages":[{"role":"user","content":"hello","tool_calls":[{"name":"run"}]}]});
        assert!(validate_chat(&base).unwrap().0[0]
            .get("tool_calls")
            .is_none());
        for value in [json!(1), json!("true"), Value::Null] {
            let mut p = base.clone();
            p["precise"] = value;
            assert!(validate_chat(&p).is_err());
        }
        for value in [json!(0), json!(2049), json!(1.5), json!("8")] {
            let mut p = base.clone();
            p["maxTokens"] = value;
            assert!(validate_chat(&p).is_err());
        }
        assert!(validate_chat(&json!({"messages":[{"role":"tool","content":"hello"}]})).is_err());
    }

    #[test]
    fn manifest_is_pinned_and_cannot_escape_model_directory() {
        let models = catalog();
        assert_eq!(models.len(), 7);
        for model in models {
            assert_eq!(model.revision.len(), 40);
            for file in model.files {
                validate_file(&file).unwrap();
            }
        }
        let mut file = catalog()[0].files[0].clone();
        for path in [
            "../outside",
            "/tmp/outside",
            "C:\\outside",
            "a/../../outside",
        ] {
            file.path = path.into();
            assert!(validate_file(&file).is_err());
        }
    }

    #[tokio::test]
    async fn download_hash_failure_never_installs_corrupt_file() {
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = server.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut peer, _) = server.accept().await.unwrap();
            use tokio::io::AsyncReadExt;
            let mut request = [0; 4096];
            let _ = peer.read(&mut request).await;
            peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbad")
                .await
                .unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("model.partial");
        let file = ModelFile {
            path: "model".into(),
            size: 3,
            sha256: format!("{:x}", Sha256::digest(b"yes")),
            source_url: format!("http://{address}/model"),
        };
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        assert!(download(&client, &file, &target, |_| {})
            .await
            .unwrap_err()
            .contains("SHA-256"));
        assert!(!directory.path().join(".installed.json").exists());
    }

    #[tokio::test]
    async fn sse_http_stream_accepts_only_answer_content() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut peer, _) = listener.accept().await.unwrap();
            use tokio::io::AsyncReadExt;
            let mut request = [0; 4096];
            let _ = peer.read(&mut request).await;
            let body="data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"private\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\ndata: [DONE]\n\n";
            peer.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = client
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        assert_eq!(read_sse(response, |_| {}).await.unwrap(), "answer");
    }

    #[tokio::test]
    async fn cancellation_is_scoped_and_does_not_complete_other_requests() {
        let manager = PortableManager::default();
        let (a_tx, a_rx) = oneshot::channel();
        let (b_tx, mut b_rx) = oneshot::channel();
        manager
            .operations
            .lock()
            .await
            .insert("a".into(), ("chat.generate".into(), a_tx));
        manager
            .operations
            .lock()
            .await
            .insert("b".into(), ("models.install".into(), b_tx));
        assert_eq!(manager.cancel(Some("a")).await, 1);
        assert_eq!(manager.cancel(Some("missing")).await, 0);
        a_rx.await.unwrap();
        assert!(matches!(
            b_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        manager.stop().await;
        b_rx.await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires the explicitly installed pinned Qwen GGUF and bundled llama-server"]
    async fn actual_portable_qwen_answers_from_supplied_meeting_source() {
        assert!(
            enabled(),
            "Run with PACE_PORTABLE_RUNTIME=1 to select the portable backend on Mac"
        );
        let root = std::env::var_os("PACE_MODELS_DIR")
            .map(PathBuf::from)
            .expect("PACE_MODELS_DIR");
        let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../native/bin")
            .join(if cfg!(windows) {
                "llama-server.exe"
            } else {
                "llama-server"
            });
        let manager = PortableManager::default();
        let params = json!({"messages":[{"role":"system","content":"Answer only from the supplied meeting transcript. Be concise. Do not invent a deadline."},{"role":"user","content":"Meeting transcript: Amina: I will prepare release notes by Friday. Jules: I will write a tutorial; no deadline has been agreed. Question: Who owns release notes and when are they due?"}],"maxTokens":100,"precise":true});
        let result = manager
            .generate(&root, &binary, &params, Arc::new(|_| {}))
            .await
            .unwrap();
        let text = result["text"].as_str().unwrap();
        println!("portable Qwen answer: {text}");
        assert!(text.contains("Amina"));
        assert!(text.contains("Friday"));
        assert!(!text.contains("<think>"));
        let endpoint = manager
            .server
            .lock()
            .await
            .as_ref()
            .unwrap()
            .endpoint
            .clone();
        let no_auth = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!("{endpoint}/v1/chat/completions"))
            .json(&json!({"messages":[{"role":"user","content":"hello"}]}))
            .send()
            .await
            .unwrap();
        assert_eq!(no_auth.status(), reqwest::StatusCode::UNAUTHORIZED);
        let notes = json!({"messages":[
            {"role":"system","content":"Summarize only the supplied meeting transcript. Use exactly these Markdown headings in order: ## Summary, ## Decisions, ## Action items, ## Open questions. Never invent facts, owners or deadlines. Write one action bullet per task, with owner and that task's own deadline. A task with no agreed deadline must still have its own action bullet. Never apply one task's date to another task. Preserve timestamps. Be concise."},
            {"role":"user","content":"[0.0s] Amina: I will prepare release notes by Friday. [4.0s] Amina: I will also write a tutorial; no deadline has been agreed for the tutorial."}
        ],"maxTokens":512,"precise":true});
        let result = manager
            .generate(&root, &binary, &notes, Arc::new(|_| {}))
            .await
            .unwrap();
        let text = result["text"].as_str().unwrap();
        println!("portable Qwen meeting notes:\n{text}");
        for heading in [
            "## Summary",
            "## Decisions",
            "## Action items",
            "## Open questions",
        ] {
            assert!(text.contains(heading));
        }
        let actions = text
            .split("## Action items")
            .nth(1)
            .unwrap()
            .split("## Open questions")
            .next()
            .unwrap();
        let bullets: Vec<_> = actions
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("- ") || line.starts_with("* "))
            .collect();
        assert_eq!(bullets.len(), 2);
        let release = bullets
            .iter()
            .find(|line| line.to_lowercase().contains("release notes"))
            .unwrap();
        let tutorial = bullets
            .iter()
            .find(|line| line.to_lowercase().contains("tutorial"))
            .unwrap();
        assert!(release.contains("Friday"));
        assert!(release.contains("Amina"));
        assert!(tutorial.contains("Amina"));
        assert!(!tutorial.contains("Friday"));
        manager.stop().await;
        assert!(manager.server.lock().await.is_none());
    }
}
