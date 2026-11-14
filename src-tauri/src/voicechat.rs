//! One explicit voice session: endpoint a microphone turn, answer locally, speak, then listen again.
use crate::{emit, AppState};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Listener, Manager};

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
    pub(crate) fn spoken_chunk(&self, app: &AppHandle, epoch: u64, text: &str) {
        if !self.valid(epoch) {
            return;
        }
        if let Ok(mut view) = self.view.lock() {
            if !self.valid(epoch) {
                return;
            }
            let previous = view["text"].as_str().unwrap_or("");
            let text = if previous.is_empty() {
                text.to_owned()
            } else {
                format!("{previous} {text}")
            };
            view["text"] = json!(text);
            view["phase"] = json!("speaking");
            view["sequence"] = json!(view["sequence"].as_u64().unwrap_or(0) + 1);
            emit(app, "voicechat.state", view.clone());
        }
        crate::action(app, "talk");
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
    let settings = state.db.settings()?;
    let language = settings["dictationLanguage"]
        .as_str()
        .or_else(|| settings["language"].as_str())
        .unwrap_or("en");
    state
        .engine
        .require_dictation_model(language, settings["asrModel"].as_str().unwrap_or("auto"))?;
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
        let asr_settings = state.db.settings()?;
        let language = asr_settings["dictationLanguage"]
            .as_str()
            .or_else(|| asr_settings["language"].as_str())
            .unwrap_or("en");
        let transcript = crate::transcribe_audio(
            app,
            state,
            json!({"path":path,"language":language,"purpose":"dictation"}),
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
        let mut settings = state.db.settings()?;
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
        let (sender, receiver) = mpsc::channel();
        let phrases = Arc::new(Mutex::new(ReplyPhrases::default()));
        let final_sender = sender.clone();
        let (handle, stream, request_id) = (app.clone(), phrases.clone(), id.to_owned());
        let listener = app.listen("pace-event", move |event| {
            let Ok(event) = serde_json::from_str::<Value>(event.payload()) else {
                return;
            };
            if event["event"] != "chat.delta"
                || event["data"]["clientRequestId"].as_str() != Some(&request_id)
                || !handle.state::<AppState>().voicechat.valid(epoch)
            {
                return;
            }
            if let Some(delta) = event["data"]["text"].as_str() {
                if let Ok(mut phrases) = stream.lock() {
                    for phrase in phrases.push(delta) {
                        let _ = sender.send(phrase);
                    }
                }
            }
        });
        let listener = ReplyListener {
            app: app.clone(),
            id: listener,
        };
        let generation = async {
            let answer = crate::chat_send(
                app,
                state,
                json!({"text":text,"meetingId":meeting,"clientRequestId":id,"_voice":true}),
            )
            .await?;
            if !state.voicechat.valid(epoch) {
                return Err("Voice chat cancelled".to_owned());
            }
            let reply = answer["text"].as_str().ok_or("Pace returned no reply")?;
            // Unregistering releases the sender, closing the speech input after the final fragment.
            drop(listener);
            let tail = phrases.lock().map_err(|e| e.to_string())?.finish(reply)?;
            for phrase in tail {
                final_sender
                    .send(phrase)
                    .map_err(|_| "Voice playback stopped")?;
            }
            drop(final_sender);
            if state.voicechat.current()?["phase"] == "speaking" {
                crate::action(app, "talk");
            }
            Ok::<_, String>(())
        };
        // Text and Kitten use separate models: run them together without the general generation lock.
        let speech = state.native.voice.speak_stream(app, settings, receiver);
        let spoken = match speak_reply(generation, speech, &state.native.voice).await {
            Ok(spoken) => spoken,
            Err(error) => {
                let _ = tokio::time::timeout(
                    Duration::from_millis(250),
                    state
                        .native
                        .request(app, "runtime.cancel", json!({"id":id})),
                )
                .await;
                return Err(error);
            }
        };
        if let Some(path) = spoken["path"].as_str() {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}
struct ReplyListener {
    app: AppHandle,
    id: tauri::EventId,
}
impl Drop for ReplyListener {
    fn drop(&mut self) {
        self.app.unlisten(self.id);
    }
}
async fn speak_reply(
    generation: impl std::future::Future<Output = Result<(), String>>,
    speech: impl std::future::Future<Output = Result<Value, String>>,
    voice: &crate::voice::Voice,
) -> Result<Value, String> {
    match tokio::try_join!(generation, speech) {
        Ok(((), spoken)) => Ok(spoken),
        Err(error) => {
            voice.stop();
            Err(error)
        }
    }
}
#[derive(Default)]
struct ReplyPhrases {
    received: String,
    pending: String,
    sent: usize,
}
impl ReplyPhrases {
    fn push(&mut self, delta: &str) -> Vec<String> {
        // Bound malformed/model output even when it has no punctuation or spaces.
        if self.received.chars().count() + delta.chars().count() > 1500 {
            return Vec::new();
        }
        self.received.push_str(delta);
        self.pending.push_str(delta);
        let mut ready = Vec::new();
        loop {
            let limit = if self.sent == 0 { 80 } else { 160 };
            let mut boundary = None;
            for (count, (byte, ch)) in self.pending.char_indices().enumerate() {
                if count >= limit {
                    break;
                }
                let following = &self.pending[byte + ch.len_utf8()..];
                if matches!(ch, '.' | '?' | '!')
                    && following.starts_with(char::is_whitespace)
                    && count >= 12
                {
                    boundary = Some(byte + ch.len_utf8());
                    break;
                }
            }
            if boundary.is_none() && self.pending.chars().count() >= limit {
                let end = self
                    .pending
                    .char_indices()
                    .nth(limit)
                    .map_or(self.pending.len(), |(i, _)| i);
                boundary = Some(
                    self.pending[..end]
                        .rfind(char::is_whitespace)
                        .filter(|i| *i > 0)
                        .unwrap_or(end),
                );
            }
            let Some(end) = boundary else {
                break;
            };
            let phrase = self.pending[..end].trim().to_owned();
            self.pending = self.pending[end..].trim_start().to_owned();
            if !phrase.is_empty() {
                self.sent += 1;
                ready.push(phrase);
            }
        }
        ready
    }
    fn finish(&mut self, reply: &str) -> Result<Vec<String>, String> {
        if reply.chars().count() > 1500 {
            return Err("Pace's reply was too long to speak".into());
        }
        let mut ready = if let Some(tail) = reply.strip_prefix(&self.received) {
            self.push(tail)
        } else if reply.trim() == self.received.trim() {
            Vec::new()
        } else {
            return Err("Pace's streamed reply changed. Please try again.".into());
        };
        if !self.pending.trim().is_empty() {
            ready.push(std::mem::take(&mut self.pending).trim().to_owned());
        }
        Ok(ready)
    }
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
    if state.voicechat.valid(epoch) {
        let settings = state.db.settings()?;
        let language = settings["dictationLanguage"]
            .as_str()
            .or_else(|| settings["language"].as_str())
            .unwrap_or("en");
        state.engine.warm(
            language.to_owned(),
            settings["asrModel"].as_str().unwrap_or("auto").to_owned(),
        );
    }
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
    #[test]
    fn reply_phrases_release_the_first_sentence_before_the_answer_finishes() {
        let mut phrases = ReplyPhrases::default();
        assert!(phrases.push("Choose one small task.").is_empty());
        assert_eq!(phrases.push(" Then"), ["Choose one small task."]);
        assert!(phrases.push(" give it ten quiet minutes.").is_empty());
        assert_eq!(
            phrases
                .finish("Choose one small task. Then give it ten quiet minutes.")
                .unwrap(),
            ["Then give it ten quiet minutes."]
        );
        assert!(phrases.finish("A different answer").is_err());
    }
    #[test]
    fn fragmented_unicode_and_unpunctuated_replies_stay_bounded_without_repeating() {
        let text = "Café time is a small break before the next task ".repeat(12);
        let mut phrases = ReplyPhrases::default();
        let mut spoken = Vec::new();
        for ch in text.chars() {
            spoken.extend(phrases.push(&ch.to_string()));
        }
        spoken.extend(phrases.finish(&text).unwrap());
        assert!(spoken[0].chars().count() <= 80);
        assert!(spoken.iter().all(|p| p.chars().count() <= 160));
        assert_eq!(
            spoken.join(" ").split_whitespace().collect::<Vec<_>>(),
            text.split_whitespace().collect::<Vec<_>>()
        );
        let mut no_deltas = ReplyPhrases::default();
        assert_eq!(
            no_deltas.finish("A short answer.").unwrap(),
            ["A short answer."]
        );
        assert!(no_deltas.finish(&"a".repeat(1501)).is_err());
    }
    #[tokio::test]
    async fn generation_and_speech_overlap_instead_of_waiting_for_the_full_answer() {
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        let (started, audible) = tokio::sync::oneshot::channel();
        let generation = async move {
            sender.send("First phrase.").await.unwrap();
            audible.await.unwrap();
            sender.send("Second phrase.").await.unwrap();
            Ok(())
        };
        let speech = async move {
            assert_eq!(receiver.recv().await, Some("First phrase."));
            started.send(()).unwrap();
            assert_eq!(receiver.recv().await, Some("Second phrase."));
            assert!(receiver.recv().await.is_none());
            Ok(json!({"streaming":true}))
        };
        assert!(
            tokio::time::timeout(
                Duration::from_millis(250),
                speak_reply(generation, speech, &crate::voice::Voice::default())
            )
            .await
            .unwrap()
            .unwrap()["streaming"]
                == true
        );
    }
    #[tokio::test]
    async fn a_speech_failure_cancels_a_stalled_generation_and_invalidates_audio() {
        let voice = crate::voice::Voice::default();
        let generation = std::future::pending::<Result<(), String>>();
        let speech = async { Err("Speaker disconnected".to_owned()) };
        assert_eq!(
            speak_reply(generation, speech, &voice).await.unwrap_err(),
            "Speaker disconnected"
        );
        assert_eq!(voice.epoch(), 1);
    }
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
