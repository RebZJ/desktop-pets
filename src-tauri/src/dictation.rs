use crate::{action, dictation_shortcut::Action, emit, set_pet_visible, stop_dictation, AppState};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};

async fn start(app: &AppHandle, state: &AppState, ui_epoch: u64) -> Result<Value, String> {
    if state.voicechat.active() {
        return Err("End voice chat before starting dictation.".into());
    }
    state.speech_epoch.fetch_add(1, Ordering::SeqCst);
    let settings = state.db.settings()?;
    let language = settings["dictationLanguage"]
        .as_str()
        .or_else(|| settings["language"].as_str())
        .unwrap_or("en");
    state.engine.require_dictation_model(language)?;
    if state.dictating.swap(true, Ordering::SeqCst) {
        return Err("Dictation is already recording".into());
    }
    if !request_is_current(&state.ui_epoch, ui_epoch) {
        state.dictating.store(false, Ordering::SeqCst);
        return Err("Dictation cancelled".into());
    }
    let result = state
        .engine
        .capture_request(
            app,
            "audio.start",
            json!({"outputDir":state.data_dir.join("recordings"),"language":language,"_speechEpoch":state.speech_epoch.load(Ordering::SeqCst)}),
        )
        .await;
    if result.is_err() {
        state.dictating.store(false, Ordering::SeqCst);
    } else {
        state.engine.warm(language.to_owned());
        action(app, "dictate");
        emit(app, "dictation.state", json!({"phase":"recording"}));
    }
    result
}

pub async fn start_review(app: &AppHandle, state: &AppState) -> Result<Value, String> {
    let ui_epoch = state.ui_epoch.load(Ordering::SeqCst);
    let _guard = state.dictation_lock.lock().await;
    let result = start(app, state, ui_epoch).await;
    if result.is_ok() && !request_is_current(&state.ui_epoch, ui_epoch) {
        let data = match finish_locked(app, state, false).await {
            Ok(data) => data,
            Err(error) => json!({"error":error}),
        };
        emit(app, "dictation.finished", data);
        return Err("Dictation cancelled".into());
    }
    result
}

pub fn shortcut(app: &AppHandle, pressed: bool) {
    let state = app.state::<AppState>();
    let busy = state.dictation_lock.try_lock().is_err();
    let action = state.dictation_gesture.lock().ok().and_then(|mut gesture| {
        if pressed {
            gesture.press(
                std::time::Instant::now(),
                state.dictating.load(Ordering::SeqCst),
                busy,
            )
        } else {
            gesture.release(std::time::Instant::now())
        }
    });
    if let Some(action) = action {
        if pressed {
            emit(app, "shortcut.triggered", json!({"action":"dictate"}));
        }
        run_shortcut(app, action);
    }
}

pub fn reset_shortcut(app: &AppHandle) {
    let action = app
        .state::<AppState>()
        .dictation_gesture
        .lock()
        .ok()
        .and_then(|mut gesture| gesture.reset());
    if let Some(action) = action {
        run_shortcut(app, action);
    }
}

fn run_shortcut(app: &AppHandle, action: Action) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let _guard = state.dictation_lock.lock().await;
        let id = match action {
            Action::Start(id) | Action::Stop(id) => id,
        };
        if !state
            .dictation_gesture
            .lock()
            .is_ok_and(|gesture| gesture.current(id))
        {
            return;
        }
        match action {
            Action::Start(_) => {
                if state.dictating.load(Ordering::SeqCst) {
                    if let Ok(mut gesture) = state.dictation_gesture.lock() {
                        gesture.finished(id);
                    }
                    return;
                }
                let result = start_global(&app, &state).await;
                let stop = state
                    .dictation_gesture
                    .lock()
                    .ok()
                    .and_then(|mut gesture| gesture.started(id, result.is_ok()));
                if stop.is_some() && state.dictating.load(Ordering::SeqCst) {
                    let _ = finish_locked(&app, &state, true).await;
                    if let Ok(mut gesture) = state.dictation_gesture.lock() {
                        gesture.finished(id);
                    }
                }
            }
            Action::Stop(_) => {
                if state.dictating.load(Ordering::SeqCst) {
                    let _ = finish_locked(&app, &state, true).await;
                }
                if let Ok(mut gesture) = state.dictation_gesture.lock() {
                    gesture.finished(id);
                }
            }
        }
    });
}

pub async fn toggle(app: AppHandle) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let Ok(_guard) = state.dictation_lock.try_lock() else {
        let action = state
            .dictation_gesture
            .lock()
            .ok()
            .and_then(|mut gesture| gesture.stop());
        if let Some(action) = action {
            run_shortcut(&app, action);
        }
        return Ok(json!({"busy":true}));
    };
    if state.dictating.load(Ordering::SeqCst) {
        return finish_locked(&app, &state, true).await;
    }
    start_global(&app, &state).await
}

async fn start_global(app: &AppHandle, state: &AppState) -> Result<Value, String> {
    let _ = set_pet_visible(&app, true, true);
    let ui_epoch = state.ui_epoch.load(Ordering::SeqCst);
    emit(app, "dictation.state", json!({"phase":"starting"}));
    match start(app, state, ui_epoch).await {
        Ok(mut result) => {
            // Recording already runs; slow accessibility must not delay the microphone.
            let target = match tokio::time::timeout(
                std::time::Duration::from_millis(400),
                state.native.request(&app, "dictation.capture", json!({})),
            )
            .await
            {
                Ok(Ok(target)) => target,
                Ok(Err(error)) => json!({"captureError":error}),
                Err(_) => {
                    json!({"captureError":"The text field took too long to respond. Your words will be ready to copy."})
                }
            };
            *state.dictation_target.lock().map_err(|e| e.to_string())? = Some(target.clone());
            if !request_is_current(&state.ui_epoch, ui_epoch) {
                return finish_locked(&app, &state, false).await;
            }
            result["target"] = target;
            Ok(result)
        }
        Err(error) => {
            state
                .dictation_target
                .lock()
                .map_err(|e| e.to_string())?
                .take();
            emit(
                &app,
                "dictation.state",
                json!({"phase":"error","error":error}),
            );
            Err(error)
        }
    }
}

pub async fn finish(app: &AppHandle, state: &AppState, insert: bool) -> Result<Value, String> {
    let _guard = state.dictation_lock.lock().await;
    finish_locked(app, state, insert).await
}

async fn finish_locked(app: &AppHandle, state: &AppState, insert: bool) -> Result<Value, String> {
    let ui_epoch = state.ui_epoch.load(Ordering::SeqCst);
    if !state.dictating.load(Ordering::SeqCst) {
        return Err("Dictation is not recording".into());
    }
    if let Ok(mut gesture) = state.dictation_gesture.lock() {
        gesture.clear();
    }
    let target = state
        .dictation_target
        .lock()
        .map_err(|e| e.to_string())?
        .take();
    emit(app, "dictation.state", json!({"phase":"transcribing"}));
    let transcript = stop_dictation(app, state).await;
    let mut data = match transcript {
        Ok(data) => data,
        Err(error) => {
            let saved_audio = state
                .engine
                .saved_dictation
                .lock()
                .map(|saved| saved.is_some())
                .unwrap_or(false);
            discard_target(app, state, target.as_ref()).await;
            emit(
                app,
                "dictation.state",
                json!({"phase":"error","error":error,"savedAudio":saved_audio}),
            );
            if target.is_some() {
                emit(
                    app,
                    "dictation.finished",
                    json!({"error":error,"inserted":false,"savedAudio":saved_audio}),
                );
            }
            return Err(error);
        }
    };
    data["inserted"] = json!(false);
    if let Some(target) = target.as_ref() {
        if insert && request_is_current(&state.ui_epoch, ui_epoch) {
            if let Some(id) = target["targetId"].as_str() {
                if !data["text"].as_str().unwrap_or("").trim().is_empty() {
                    match state
                        .native
                        .request(
                            app,
                            "dictation.insert",
                            json!({"targetId":id,"text":data["text"]}),
                        )
                        .await
                    {
                        Ok(result) => data["inserted"] = result["inserted"].clone(),
                        Err(error) => data["insertionError"] = json!(error),
                    }
                } else {
                    data["insertionError"] =
                        json!("No speech was caught. Try the dictation shortcut again.");
                }
            } else {
                data["insertionError"] = target["captureError"].clone();
            }
        }
    }
    discard_target(app, state, target.as_ref()).await;
    let inserted = data["inserted"] == true;
    emit(
        app,
        "dictation.state",
        finished_state(&data["text"], inserted, &data["insertionError"]),
    );
    if target.is_some() {
        emit(app, "dictation.finished", data.clone());
    }
    Ok(data)
}

pub fn finished_state(text: &Value, inserted: bool, error: &Value) -> Value {
    let empty = text.as_str().is_none_or(|text| text.trim().is_empty());
    let error = if empty && error.as_str().is_none_or(|error| error.trim().is_empty()) {
        json!("No speech was caught. Try the dictation shortcut again.")
    } else {
        error.clone()
    };
    json!({"phase":if empty {"error"} else if inserted {"inserted"} else {"draft"},"text":text,"error":error})
}

pub async fn cancel(app: &AppHandle, state: &AppState) -> Result<Value, String> {
    if let Ok(mut gesture) = state.dictation_gesture.lock() {
        gesture.clear();
    }
    let _guard = state.dictation_lock.lock().await;
    if !state.dictating.swap(false, Ordering::SeqCst) {
        emit(app, "dictation.state", json!({"phase":"idle"}));
        return Ok(json!({"cancelled":false}));
    }
    let target = state
        .dictation_target
        .lock()
        .map_err(|e| e.to_string())?
        .take();
    let result = state
        .engine
        .capture_request(app, "audio.stop", json!({}))
        .await;
    discard_target(app, state, target.as_ref()).await;
    action(app, "idle");
    match result {
        Ok(recording) => {
            if let Some(path) = recording["wavPath"]
                .as_str()
                .or_else(|| recording["path"].as_str())
            {
                // Cancellation discards only this capture, never saved recovery audio.
                let _ = std::fs::remove_file(path);
            }
            emit(app, "dictation.state", json!({"phase":"idle"}));
            Ok(json!({"cancelled":true}))
        }
        Err(error) => {
            emit(
                app,
                "dictation.state",
                json!({"phase":"error","error":error}),
            );
            Err(error)
        }
    }
}

async fn discard_target(app: &AppHandle, state: &AppState, target: Option<&Value>) {
    let Some(id) = target.and_then(|target| target["targetId"].as_str()) else {
        return;
    };
    // A delayed cleanup may only discard this target; it cannot clear a newer capture.
    let _ = tokio::time::timeout(
        std::time::Duration::from_millis(100),
        state
            .native
            .request(app, "dictation.discard", json!({"targetId":id})),
    )
    .await;
}

fn request_is_current(epoch: &AtomicU64, requested_epoch: u64) -> bool {
    epoch.load(Ordering::SeqCst) == requested_epoch
}

#[cfg(test)]
mod tests {
    use super::{finished_state, request_is_current};
    use serde_json::{json, Value};
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };

    #[test]
    fn empty_asr_is_never_a_copyable_or_inserted_result() {
        for text in [json!(""), json!(" \n\t"), Value::Null] {
            for inserted in [false, true] {
                let state = finished_state(&text, inserted, &Value::Null);
                assert_eq!(state["phase"], "error");
                assert_eq!(
                    state["error"],
                    "No speech was caught. Try the dictation shortcut again."
                );
            }
        }
        let state = finished_state(&json!(" "), false, &json!("Audio recovery warning"));
        assert_eq!(state["phase"], "error");
        assert_eq!(state["error"], "Audio recovery warning");
    }

    #[test]
    fn recognized_drafts_keep_insertion_errors_and_inserted_results_keep_their_state() {
        let text = json!("Please keep these words.");
        assert_eq!(
            finished_state(
                &text,
                false,
                &json!("Allow Accessibility to type into this app.")
            ),
            json!({"phase":"draft","text":text,"error":"Allow Accessibility to type into this app."})
        );
        assert_eq!(
            finished_state(&text, true, &Value::Null),
            json!({"phase":"inserted","text":text,"error":null})
        );
    }

    #[tokio::test]
    async fn hide_invalidates_delayed_dictation_start_even_after_show() {
        let epoch = Arc::new(AtomicU64::new(0));
        let (grant, permission) = tokio::sync::oneshot::channel();
        let pending_epoch = epoch.clone();
        let pending = tokio::spawn(async move {
            permission.await.unwrap();
            request_is_current(&pending_epoch, 0)
        });
        epoch.fetch_add(1, Ordering::SeqCst);
        grant.send(()).unwrap();
        assert!(!pending.await.unwrap());
        assert!(request_is_current(&epoch, 1));
    }
}
