//! One explicit voice session: endpoint a microphone turn, answer locally, speak, then listen again.
use crate::{emit, AppState};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

pub struct VoiceChat {
    active: AtomicBool,
    running: AtomicBool,
    epoch: AtomicU64,
    view: Mutex<Value>,
    task: tokio::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    lifecycle: tokio::sync::Mutex<()>,
    cancelled_sessions: Mutex<VecDeque<String>>,
}
impl Default for VoiceChat {
    fn default() -> Self {
        Self {
            active: AtomicBool::new(false),
            running: AtomicBool::new(false),
            epoch: AtomicU64::new(0),
            view: Mutex::new(
                json!({"sessionId":null,"sequence":0,"phase":"idle","active":false,"meetingId":null}),
            ),
            task: tokio::sync::Mutex::new(None),
            lifecycle: tokio::sync::Mutex::new(()),
            cancelled_sessions: Mutex::new(VecDeque::new()),
        }
    }
}
impl VoiceChat {
    pub fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
    pub fn current(&self) -> Result<Value, String> {
        Ok(self.view.lock().map_err(|e| e.to_string())?.clone())
    }
    pub fn valid(&self, epoch: u64) -> bool {
        self.active() && self.epoch.load(Ordering::SeqCst) == epoch
    }
    pub fn cancelled(&self, id: &str) -> bool {
        self.cancelled_sessions
            .lock()
            .is_ok_and(|ids| ids.iter().any(|saved| saved == id))
    }
    fn update(&self, app: &AppHandle, epoch: u64, phase: &str, extra: Value) {
        if !self.valid(epoch) {
            return;
        }
        if let Ok(mut view) = self.view.lock() {
            if !self.valid(epoch) {
                return;
            }
            view["phase"] = json!(phase);
            view["sequence"] = json!(view["sequence"].as_u64().unwrap_or(0) + 1);
            if let Some(extra) = extra.as_object() {
                for (key, value) in extra {
                    view[key] = value.clone();
                }
            }
            emit(app, "voicechat.state", view.clone());
        }
    }
}

pub async fn start(app: &AppHandle, state: &AppState, params: Value) -> Result<Value, String> {
    let _guard = state.voicechat.lifecycle.lock().await;
    if !app
        .get_webview_window("command")
        .is_some_and(|window| window.is_visible().unwrap_or(false))
    {
        return Err("Open Chat with Pace before starting a voice conversation.".into());
    }
    if state.shutting_down.load(Ordering::SeqCst) {
        return Err("Pace is shutting down".into());
    }
    if state.pet.lock().map_err(|e| e.to_string())?["visible"] == false {
        return Err("Show Pace before starting voice chat.".into());
    }
    if state.voicechat.active() || state.voicechat.running.load(Ordering::SeqCst) {
        return Err("The previous voice chat is still stopping. Try again in a moment.".into());
    }
    if state.dictating.load(Ordering::SeqCst)
        || state.meeting_silent.load(Ordering::SeqCst)
        || state.engine.uses_native_capture()
    {
        return Err("Stop dictation or the meeting recording before starting voice chat.".into());
    }
    if state
        .db
        .list("meeting")?
        .iter()
        .any(|meeting| meeting["status"] == "recording" || meeting["status"] == "finalizing")
    {
        return Err("Wait for the current meeting to finish before starting voice chat.".into());
    }
    state.engine.require_dictation_model("en")?;
    crate::voice::Voice::ready(&crate::portable::models_dir(app))?;
    let meeting = params["meetingId"].as_str().map(str::to_owned);
    if let Some(id) = &meeting {
        state.db.get("meeting", id)?;
    }
    let id = match params.get("clientSessionId") {
        None | Some(Value::Null) => uuid::Uuid::new_v4().to_string(),
        Some(value) => value
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or("Invalid voice session id")?
            .to_owned(),
    };
    let epoch = state.voicechat.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    if state
        .voicechat
        .cancelled_sessions
        .lock()
        .map_err(|e| e.to_string())?
        .contains(&id)
    {
        return Err("Voice chat cancelled".into());
    }
    state.voicechat.active.store(true, Ordering::SeqCst);
    let view = json!({"sessionId":id,"sequence":1,"meetingId":meeting,"phase":"starting","active":true,"userText":"","text":"","error":null});
    *state.voicechat.view.lock().map_err(|e| e.to_string())? = view.clone();
    emit(app, "voicechat.state", view.clone());
    state.speech_epoch.fetch_add(1, Ordering::SeqCst);
    state.native.voice.stop();
    let prepared = async {
        let capture = state.engine.capture_status().await?;
        if capture["recording"] == true {
            return Err("Stop the current recording before starting voice chat.".to_owned());
        }
        let models = state
            .native
            .request(app, "models.status", json!({}))
            .await?;
        if !models.as_array().is_some_and(|models| {
            models
                .iter()
                .any(|model| model["id"] == "qwen3.5-4b" && model["installed"] == true)
        }) {
            return Err("Install Qwen in Local models before starting voice chat.".into());
        }
        if !state.voicechat.valid(epoch) || state.voicechat.cancelled(&id) {
            return Err("Voice chat cancelled".into());
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = prepared {
        if state.voicechat.valid(epoch) {
            state
                .voicechat
                .update(app, epoch, "error", json!({"error":error,"active":false}));
            state.voicechat.active.store(false, Ordering::SeqCst);
        }
        return Err(error);
    }
    state.engine.warm("en".into());
    let mut task_slot = state.voicechat.task.lock().await;
    state.voicechat.running.store(true, Ordering::SeqCst);
    let handle = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        let result = run(&handle, &state, epoch, &id, meeting.as_deref()).await;
        let _ = stop_capture(&handle, &state).await;
        if state.voicechat.valid(epoch) {
            if let Err(error) = result {
                state.voicechat.update(
                    &handle,
                    epoch,
                    "error",
                    json!({"error":error,"active":false}),
                );
            } else {
                state
                    .voicechat
                    .update(&handle, epoch, "idle", json!({"active":false}));
            }
            state.voicechat.active.store(false, Ordering::SeqCst);
        }
        crate::action(&handle, "idle");
        state.voicechat.task.lock().await.take();
        state.voicechat.running.store(false, Ordering::SeqCst);
    });
    *task_slot = Some(task);
    state.voicechat.current()
}
/// Immediate invalidation is safe on the main thread; stop() completes capture/process cleanup.
pub fn cancel_now(app: &AppHandle, state: &AppState) {
    if !state.voicechat.active.swap(false, Ordering::SeqCst) {
        return;
    }
    state.voicechat.epoch.fetch_add(1, Ordering::SeqCst);
    state.native.voice.stop();
    state.engine.cancelled.store(true, Ordering::SeqCst);
    if let Ok(mut view) = state.voicechat.view.lock() {
        view["active"] = json!(false);
        view["phase"] = json!("idle");
        view["sequence"] = json!(view["sequence"].as_u64().unwrap_or(0) + 1);
        emit(app, "voicechat.state", view.clone());
    }
}
/// Hide/focus changes never leave an invisible voice session recording.
pub fn stop_on_hide(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.voicechat.active() && !state.voicechat.running.load(Ordering::SeqCst) {
        return;
    }
    let id = state
        .voicechat
        .current()
        .ok()
        .and_then(|view| view["sessionId"].as_str().map(str::to_owned));
    cancel_now(app, &state);
    if let Some(id) = id {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = stop(&handle, &handle.state::<AppState>(), Some(&id)).await;
        });
    }
}

pub async fn stop(
    app: &AppHandle,
    state: &AppState,
    target: Option<&str>,
) -> Result<Value, String> {
    if let Some(target) = target {
        if target.is_empty() || target.len() > 128 {
            return Err("Invalid voice session id".into());
        }
        let mut cancelled = state
            .voicechat
            .cancelled_sessions
            .lock()
            .map_err(|e| e.to_string())?;
        if !cancelled.iter().any(|id| id == target) {
            cancelled.push_back(target.to_owned());
        }
        while cancelled.len() > 32 {
            cancelled.pop_front();
        }
    }
    let current = state.voicechat.current()?;
    if target.is_some_and(|id| current["sessionId"].as_str() != Some(id)) {
        return Ok(current);
    }
    cancel_now(app, state);
    let _guard = state.voicechat.lifecycle.lock().await;
    if target.is_some_and(|id| {
        state
            .voicechat
            .current()
            .ok()
            .is_some_and(|v| v["sessionId"].as_str() != Some(id))
    }) {
        return state.voicechat.current();
    }
    let capture_result = stop_capture(app, state).await;
    let id = current["sessionId"].as_str();
    if let Some(id) = id {
        let _ = tokio::time::timeout(
            Duration::from_millis(250),
            state
                .native
                .request(app, "runtime.cancel", json!({"id":id})),
        )
        .await;
    }
    let task = state.voicechat.task.lock().await.take();
    let owner_result = match task {
        Some(task) => finish_owner(task, Duration::from_secs(2)).await,
        None => Ok(false),
    };
    state.voicechat.running.store(false, Ordering::SeqCst);
    if owner_result.as_ref().map_or(true, |aborted| *aborted) {
        if let Some(id) = id {
            let _ = tokio::time::timeout(
                Duration::from_millis(250),
                state
                    .native
                    .request(app, "runtime.cancel", json!({"id":id})),
            )
            .await;
        }
    }
    crate::action(app, "idle");
    match (capture_result, owner_result) {
        (Err(capture), Err(owner)) => return Err(format!("{capture}; {owner}")),
        (Err(error), _) | (_, Err(error)) => return Err(error),
        _ => {}
    }
    state.voicechat.current()
}

async fn finish_owner(
    mut task: tauri::async_runtime::JoinHandle<()>,
    grace: Duration,
) -> Result<bool, String> {
    match tokio::time::timeout(grace, &mut task).await {
        Ok(result) => result.map(|_| false).map_err(|error| error.to_string()),
        Err(_) => {
            // Dropping a join handle detaches its future; abort and join so model guards and children drop.
            task.abort();
            match task.await {
                Ok(()) => Ok(true),
                Err(tauri::Error::JoinError(error)) if error.is_cancelled() => Ok(true),
                Err(error) => Err(error.to_string()),
            }
        }
    }
}
async fn stop_capture(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let status = state.engine.capture_status().await?;
    if status["mode"] == "voice" && status["recording"] == true {
        let stopped = state
            .engine
            .capture_request(app, "voicechat.capture.stop", json!({}))
            .await?;
        if let Some(error) = stopped["error"].as_str() {
            return Err(format!(
                "{error}. Your turn is preserved at {}",
                stopped["wavPath"]
                    .as_str()
                    .unwrap_or("the recordings directory")
            ));
        }
    }
    Ok(())
}

async fn run(
    app: &AppHandle,
    state: &AppState,
    epoch: u64,
    id: &str,
    meeting: Option<&str>,
) -> Result<(), String> {
    while state.voicechat.valid(epoch) {
        state.voicechat.update(app, epoch, "starting", json!({}));
        let recording = listen_turn(app, state, epoch, id).await?;
        if !state.voicechat.valid(epoch) {
            return Ok(());
        }
        let path = recording["wavPath"]
            .as_str()
            .ok_or("Voice capture returned no audio path")?;
        if let Some(error) = recording["error"].as_str() {
            return Err(format!("{error}. Your turn is preserved at {path}"));
        }
        if recording["speech"] != true {
            remove_turn(path);
            continue;
        }
        state
            .voicechat
            .update(app, epoch, "transcribing", json!({}));
        let transcript = crate::transcribe_audio(
            app,
            state,
            json!({"path":path,"language":"en","purpose":"dictation"}),
        )
        .await;
        if !state.voicechat.valid(epoch) {
            remove_turn(path);
            return Ok(());
        }
        let transcript =
            transcript.map_err(|e| format!("{e}. Your turn is preserved at {path}"))?;
        let text = transcript["text"].as_str().unwrap_or("").trim();
        remove_turn(path);
        if text.is_empty() {
            continue;
        }
        state.voicechat.update(
            app,
            epoch,
            "thinking",
            json!({"userText":text,"text":"","error":null}),
        );
        let answer = crate::chat_send(
            app,
            state,
            json!({"text":text,"meetingId":meeting,"clientRequestId":id,"_voice":true}),
        )
        .await?;
        if !state.voicechat.valid(epoch) {
            return Ok(());
        }
        let reply = answer["text"].as_str().ok_or("Pace returned no reply")?;
        state
            .voicechat
            .update(app, epoch, "speaking", json!({"text":reply}));
        let mut settings = state.db.settings()?;
        settings["text"] = json!(reply);
        settings["_voiceChatEpoch"] = json!(epoch);
        settings["_voiceEpoch"] = json!(state.native.voice.epoch());
        settings["voiceEngine"] = json!("kitten");
        settings["language"] = json!("English");
        if ![
            "Kiki", "Bella", "Rosie", "Luna", "Jasper", "Bruno", "Hugo", "Leo",
        ]
        .contains(&settings["voice"].as_str().unwrap_or("Kiki"))
        {
            settings["voice"] = json!("Kiki");
        }
        let spoken = crate::speak(app, state, settings, None).await?;
        if let Some(path) = spoken["path"].as_str() {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}
async fn listen_turn(
    app: &AppHandle,
    state: &AppState,
    epoch: u64,
    id: &str,
) -> Result<Value, String> {
    let recording = state
        .engine
        .capture_request(app, "voicechat.capture.start", json!({}))
        .await?;
    state.voicechat.update(app, epoch, "listening", json!({}));
    if state.voicechat.valid(epoch) {
        crate::action(app, "listen");
    }
    let mut endpoint = Endpoint::default();
    let started = Instant::now();
    let mut last_frame = Instant::now();
    let mut last_frames = 0;
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if !state.voicechat.valid(epoch) {
            break;
        }
        let status = state.engine.capture_status().await?;
        if status["recording"] != true {
            return Err(format!(
                "{}. Any audio is preserved at {}",
                status["error"]
                    .as_str()
                    .unwrap_or("Microphone stopped unexpectedly"),
                recording["wavPath"]
                    .as_str()
                    .unwrap_or("the recordings directory")
            ));
        }
        let rms = status["level"]["rms"].as_f64().unwrap_or(0.0);
        let frames = status["capturedFrames"].as_u64().unwrap_or(0);
        if frames > last_frames {
            last_frame = Instant::now();
            last_frames = frames;
        }
        if last_frame.elapsed() > Duration::from_secs(5) {
            return Err(format!("The microphone stopped delivering audio. Reconnect it and start voice chat again. Any audio is preserved at {}",recording["wavPath"].as_str().unwrap_or("the recordings directory")));
        }
        emit(
            app,
            "voicechat.level",
            json!({"sessionId":id,"level":(rms*8.0).clamp(0.0,1.0),"rawRms":rms}),
        );
        if endpoint.observe(rms, 100) || started.elapsed() > Duration::from_secs(60) {
            break;
        }
    }
    let mut stopped = state
        .engine
        .capture_request(app, "voicechat.capture.stop", json!({}))
        .await?;
    stopped["speech"] = json!(endpoint.speech_ms >= 250);
    if !state.voicechat.valid(epoch) {
        if let Some(path) = stopped["wavPath"]
            .as_str()
            .or_else(|| recording["wavPath"].as_str())
        {
            remove_turn(path);
        }
    }
    Ok(stopped)
}
fn remove_turn(path: &str) {
    let path = PathBuf::from(path);
    let _ = std::fs::remove_file(&path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::remove_dir(parent);
    }
}

struct Endpoint {
    noise: f64,
    speech_ms: u64,
    silence_ms: u64,
}
impl Default for Endpoint {
    fn default() -> Self {
        Self {
            noise: 0.002,
            speech_ms: 0,
            silence_ms: 0,
        }
    }
}
impl Endpoint {
    fn observe(&mut self, rms: f64, ms: u64) -> bool {
        let threshold = (self.noise * 3.0).max(0.008);
        if rms.is_finite() && rms > threshold {
            self.speech_ms += ms;
            self.silence_ms = 0;
        } else {
            self.noise = self.noise * 0.95 + rms.max(0.0).min(0.03) * 0.05;
            if self.speech_ms > 0 {
                self.silence_ms += ms;
            }
        }
        // Ignore taps/breaths; a brief pause within a sentence must not end a turn.
        if self.speech_ms < 250 && self.silence_ms >= 600 {
            self.speech_ms = 0;
            self.silence_ms = 0;
        }
        self.speech_ms >= 250 && self.silence_ms >= 900
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stalled_owner_is_aborted_and_releases_its_guard_and_resource() {
        struct Resource(std::sync::Arc<AtomicBool>);
        impl Drop for Resource {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let gate = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let dropped = std::sync::Arc::new(AtomicBool::new(false));
        let owner_gate = gate.clone();
        let owner_dropped = dropped.clone();
        let (ready, started) = tokio::sync::oneshot::channel();
        let owner = tauri::async_runtime::JoinHandle::Tokio(tokio::spawn(async move {
            let _guard = owner_gate.lock().await;
            let _resource = Resource(owner_dropped);
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        }));
        started.await.unwrap();
        assert!(gate.try_lock().is_err());
        let aborted = tokio::time::timeout(
            Duration::from_millis(250),
            finish_owner(owner, Duration::from_millis(20)),
        )
        .await
        .expect("End must not wait for the stalled model")
        .unwrap();
        assert!(aborted);
        assert!(dropped.load(Ordering::SeqCst));
        assert!(
            gate.try_lock().is_ok(),
            "A new session must acquire the generation guard"
        );
    }
    #[tokio::test]
    async fn healthy_owner_finishes_without_abort() {
        let owner = tauri::async_runtime::JoinHandle::Tokio(tokio::spawn(async {}));
        assert!(!finish_owner(owner, Duration::from_secs(2)).await.unwrap());
    }
    #[test]
    fn endpoint_ignores_noise_clicks_and_short_pauses() {
        let mut e = Endpoint::default();
        for _ in 0..50 {
            assert!(!e.observe(0.002, 100));
        }
        assert!(!e.observe(0.05, 100));
        for _ in 0..8 {
            assert!(!e.observe(0.001, 100));
        }
        assert_eq!(e.speech_ms, 0);
        for _ in 0..5 {
            assert!(!e.observe(0.06, 100));
        }
        for _ in 0..5 {
            assert!(!e.observe(0.001, 100));
        }
        assert!(!e.observe(0.05, 100));
        for _ in 0..8 {
            assert!(!e.observe(0.001, 100));
        }
        assert!(e.observe(0.001, 100));
    }
    #[test]
    fn stale_epoch_never_updates_live_state() {
        let session = VoiceChat::default();
        session.active.store(true, Ordering::SeqCst);
        session.epoch.store(5, Ordering::SeqCst);
        assert!(session.valid(5));
        assert!(!session.valid(4));
        session.active.store(false, Ordering::SeqCst);
        assert!(!session.valid(5));
    }
}
