use crate::{action, dictation_shortcut::Action, emit, set_pet_visible, stop_dictation, AppState};
use serde_json::{json, Value};
use std::{
    future::Future,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};
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
        let _ = run_action(&app, &state, action).await;
    });
}

async fn run_action(app: &AppHandle, state: &AppState, action: Action) -> Result<Value, String> {
    let _guard = state.dictation_lock.lock().await;
    let id = match action {
        Action::Start(id) | Action::Stop(id) => id,
    };
    if !state
        .dictation_gesture
        .lock()
        .is_ok_and(|gesture| gesture.current(id))
    {
        return Ok(json!({"busy":true}));
    }
    match action {
        Action::Start(_) => {
            if state.dictating.load(Ordering::SeqCst) {
                if let Ok(mut gesture) = state.dictation_gesture.lock() {
                    gesture.finished(id);
                }
                return Ok(json!({"busy":true}));
            }
            let mut result = start_global(app, state).await;
            let recording = state.dictating.load(Ordering::SeqCst);
            if let Ok(value) = result.as_mut() {
                value["recording"] = json!(recording);
            }
            let stop = state
                .dictation_gesture
                .lock()
                .ok()
                .and_then(|mut gesture| gesture.started(id, result.is_ok() && recording));
            if stop.is_some() {
                let result = if state.dictating.load(Ordering::SeqCst) {
                    finish_locked(app, state, true).await
                } else {
                    result
                };
                if let Ok(mut gesture) = state.dictation_gesture.lock() {
                    gesture.finished(id);
                }
                return result;
            }
            result
        }
        Action::Stop(_) => {
            let result = if state.dictating.load(Ordering::SeqCst) {
                finish_locked(app, state, true).await
            } else {
                Ok(json!({"recording":false}))
            };
            if let Ok(mut gesture) = state.dictation_gesture.lock() {
                gesture.finished(id);
            }
            result
        }
    }
}

pub async fn toggle(app: AppHandle) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let busy = state.dictation_lock.try_lock().is_err();
    let action = state
        .dictation_gesture
        .lock()
        .map_err(|e| e.to_string())?
        .toggle(state.dictating.load(Ordering::SeqCst), busy);
    match action {
        Some(action) => run_action(&app, &state, action).await,
        None => Ok(json!({"busy":true})),
    }
}

async fn capture_during_start<T, S, F>(target: T, start: S) -> (Result<Value, String>, Value)
where
    T: Future<Output = Value>,
    S: FnOnce() -> F,
    F: Future<Output = Result<Value, String>>,
{
    tokio::pin!(target);
    // Dispatch target capture before UI changes, without waiting for slow AX or a cold helper.
    let ready = tokio::select! {
        biased;
        value = &mut target => Some(value),
        _ = tokio::task::yield_now() => None,
    };
    tokio::join!(start(), async {
        match ready {
            Some(value) => value,
            None => target.await,
        }
    })
}

async fn start_global(app: &AppHandle, state: &AppState) -> Result<Value, String> {
    let target = async {
        match tokio::time::timeout(
            std::time::Duration::from_secs(1),
            state.native.request(app, "dictation.capture", json!({})),
        )
        .await
        {
            Ok(Ok(target)) => target,
            Ok(Err(error)) => json!({"captureError":error}),
            Err(_) => {
                json!({"captureError":"The text field took too long to respond. Your words will be ready to copy."})
            }
        }
    };
    let mut ui_epoch = 0;
    let (result, target) = capture_during_start(target, || {
        let _ = set_pet_visible(app, true, true);
        ui_epoch = state.ui_epoch.load(Ordering::SeqCst);
        emit(app, "dictation.state", json!({"phase":"starting"}));
        start(app, state, ui_epoch)
    })
    .await;
    match result {
        Ok(mut result) => {
            *state.dictation_target.lock().map_err(|e| e.to_string())? = Some(target.clone());
            if !request_is_current(&state.ui_epoch, ui_epoch) {
                return finish_locked(app, state, false).await;
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
            discard_target(app, state, Some(&target)).await;
            emit(
                app,
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
    data["dispatched"] = json!(false);
    data["verified"] = json!(false);
    if let Some(target) = target.as_ref() {
        if insert && request_is_current(&state.ui_epoch, ui_epoch) {
            if let Some(id) = target["targetId"].as_str() {
                if !data["text"].as_str().unwrap_or("").trim().is_empty() {
                    match state
                        .native
                        .request(
                            app,
                            "dictation.insert",
                            json!({"targetId":id,"text":data["text"],"_uiEpoch":ui_epoch}),
                        )
                        .await
                    {
                        Ok(result) => merge_insertion_outcome(&mut data, &result),
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
    if let Err(error) = state.db.put("dictation", "last", &data) {
        data["storageError"] = json!(format!("The last dictation could not be saved: {error}"));
    }
    emit(app, "dictation.state", finished_result(&data));
    if target.is_some() {
        emit(app, "dictation.finished", data.clone());
    }
    Ok(data)
}

fn merge_insertion_outcome(data: &mut Value, result: &Value) {
    for key in ["inserted", "dispatched", "verified", "clipboardRecoveryId"] {
        if let Some(value) = result.get(key) {
            data[key] = value.clone();
        }
    }
    data["insertionError"] = result
        .get("insertionError")
        .filter(|error| !error.is_null())
        .or_else(|| result.get("error"))
        .cloned()
        .unwrap_or(Value::Null);
}

fn finished_result(data: &Value) -> Value {
    let mut state = finished_state(
        &data["text"],
        data["inserted"] == true,
        &data["insertionError"],
    );
    for key in [
        "inserted",
        "dispatched",
        "verified",
        "insertionError",
        "clipboardRecoveryId",
        "storageError",
    ] {
        if let Some(value) = data.get(key) {
            state[key] = value.clone();
        }
    }
    if state["phase"] != "error" && data["inserted"] != true && data["dispatched"] == true {
        state["phase"] = json!(if data["insertionError"]
            .as_str()
            .is_some_and(|error| !error.trim().is_empty())
        {
            "error"
        } else {
            "dispatched"
        });
    }
    state
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

pub async fn recover_capture_failure(
    lock: &tokio::sync::Mutex<()>,
    dictating: &AtomicBool,
    observed: &Value,
    current: impl Future<Output = Result<Value, String>>,
    recover: impl FnOnce(Value),
) {
    let _guard = lock.lock().await;
    if !dictating.load(Ordering::SeqCst) {
        return;
    }
    // A status read before startup can still describe the previous failed capture.
    let Ok(current) = current.await else { return };
    if current["mode"] == "dictation"
        && current["recording"] != true
        && current["error"].as_str().is_some()
        && current["sessionId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
        && current["sessionId"] == observed["sessionId"]
        && dictating.swap(false, Ordering::SeqCst)
    {
        recover(current);
    }
}

fn request_is_current(epoch: &AtomicU64, requested_epoch: u64) -> bool {
    epoch.load(Ordering::SeqCst) == requested_epoch
}

#[cfg(test)]
mod tests {
    use super::{
        capture_during_start, finished_result, finished_state, merge_insertion_outcome,
        recover_capture_failure, request_is_current,
    };
    use crate::dictation_shortcut::{Action, Gesture};
    use serde_json::{json, Value};
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
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

    #[test]
    fn dispatched_and_uncertain_outcomes_never_claim_verified_insertion() {
        let mut result = json!({"text":"Words kept for recovery.","inserted":false,"dispatched":true,"verified":false,"clipboardRecoveryId":"clipboard-1"});
        let state = finished_result(&result);
        assert_eq!(state["phase"], "dispatched");
        assert_eq!(state["inserted"], false);
        assert_eq!(state["verified"], false);
        assert_eq!(state["text"], result["text"]);
        assert_eq!(state["clipboardRecoveryId"], "clipboard-1");
        assert!(state["error"].is_null());
        result["insertionError"] =
            json!("The text may have been inserted. Check your text before copying.");
        let state = finished_result(&result);
        assert_eq!(state["phase"], "error");
        assert_eq!(state["dispatched"], true);
        assert_eq!(state["verified"], false);
        assert_eq!(state["clipboardRecoveryId"], "clipboard-1");
        assert_eq!(state["error"], result["insertionError"]);
        result["inserted"] = json!(true);
        result["verified"] = json!(true);
        result["insertionError"] = Value::Null;
        assert_eq!(finished_result(&result)["phase"], "inserted");
        result["text"] = json!("");
        assert_eq!(finished_result(&result)["phase"], "error");
    }

    #[test]
    fn native_error_aliases_keep_dispatched_uncertainty_without_retrying() {
        for key in ["insertionError", "error"] {
            let mut result = json!({"inserted":false,"dispatched":true,"verified":false,"clipboardRecoveryId":"original-clipboard"});
            result[key] = json!("Check the original text before copying.");
            let mut data = json!({"text":"Recognized words."});
            merge_insertion_outcome(&mut data, &result);
            let state = finished_result(&data);
            assert_eq!(state["phase"], "error");
            assert_eq!(state["error"], result[key]);
            assert_eq!(state["clipboardRecoveryId"], "original-clipboard");
            assert_eq!(state["inserted"], false);
        }
    }

    #[test]
    fn latest_dispatch_preserves_saved_audio_recovery_record() {
        let directory = tempfile::tempdir().unwrap();
        let db = crate::db::Database::open(&directory.path().join("test.sqlite")).unwrap();
        let audio = json!({"wavPath":"keep.wav","sessionId":"recovery-session"});
        db.put("dictation", "recovery", &audio).unwrap();
        db.put("dictation", "last", &json!({"text":"Old words."}))
            .unwrap();
        let latest = json!({"text":"New words.","dispatched":true,"verified":false});
        db.put("dictation", "last", &latest).unwrap();
        assert_eq!(db.get("dictation", "last").unwrap()["text"], latest["text"]);
        assert_eq!(
            db.get("dictation", "recovery").unwrap()["wavPath"],
            "keep.wav"
        );
    }

    #[tokio::test]
    async fn target_starts_before_ui_and_slow_target_does_not_delay_mic_or_lose_toggle_stop() {
        let requested = Arc::new(AtomicBool::new(false));
        let pending_target = requested.clone();
        let gesture = Arc::new(Mutex::new(Gesture::default()));
        assert_eq!(
            gesture.lock().unwrap().toggle(false, false),
            Some(Action::Start(1))
        );
        let (release_target, target) = tokio::sync::oneshot::channel();
        let (mic_opened, microphone) = tokio::sync::oneshot::channel();
        let pending_gesture = gesture.clone();
        let pending = tokio::spawn(async move {
            let (recording, target) = capture_during_start(
                async move {
                    pending_target.store(true, Ordering::SeqCst);
                    target.await.unwrap()
                },
                || {
                    // This is the point where production shows the pet/starting indicator.
                    assert!(requested.load(Ordering::SeqCst));
                    async move {
                        mic_opened.send(()).unwrap();
                        Ok(json!({"recording":true}))
                    }
                },
            )
            .await;
            assert_eq!(target["targetId"], "original-target");
            pending_gesture
                .lock()
                .unwrap()
                .started(1, recording.is_ok())
        });
        microphone.await.unwrap();
        assert!(!pending.is_finished());
        assert_eq!(gesture.lock().unwrap().toggle(true, true), None);
        release_target
            .send(json!({"targetId":"original-target"}))
            .unwrap();
        assert_eq!(pending.await.unwrap(), Some(Action::Stop(1)));
        assert_eq!(gesture.lock().unwrap().toggle(true, true), None);
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

    #[tokio::test]
    async fn previous_capture_error_waits_for_startup_and_cannot_clear_the_new_attempt() {
        let lock = tokio::sync::Mutex::new(());
        let starting = lock.lock().await;
        let dictating = AtomicBool::new(true);
        let old = json!({"mode":"dictation","sessionId":"old","recording":false,"error":"Device stopped"});
        let current = Mutex::new(old.clone());
        let target = Mutex::new(json!("original target"));
        let status_read = AtomicBool::new(false);
        let recovery = recover_capture_failure(
            &lock,
            &dictating,
            &old,
            async {
                status_read.store(true, Ordering::SeqCst);
                Ok(current.lock().unwrap().clone())
            },
            |_| *target.lock().unwrap() = Value::Null,
        );
        let startup = async {
            tokio::task::yield_now().await;
            assert!(!status_read.load(Ordering::SeqCst));
            // The old poll condition would clear this flag while startup owns the lock.
            assert_eq!(old["mode"], "dictation");
            assert!(dictating.load(Ordering::SeqCst));
            *current.lock().unwrap() =
                json!({"mode":"dictation","sessionId":"new","recording":true});
            *target.lock().unwrap() = json!("new target");
            drop(starting);
        };
        tokio::join!(recovery, startup);
        assert!(status_read.load(Ordering::SeqCst));
        assert!(dictating.load(Ordering::SeqCst));
        assert_eq!(*target.lock().unwrap(), "new target");
    }

    #[tokio::test]
    async fn only_the_current_failed_session_is_recovered_under_the_attempt_lock() {
        let lock = tokio::sync::Mutex::new(());
        let dictating = AtomicBool::new(true);
        let target = Mutex::new(json!("new target"));
        let old = json!({"mode":"dictation","sessionId":"old","recording":false,"error":"Old device error"});
        let failed = json!({"mode":"dictation","sessionId":"new","recording":false,"error":"New device error","wavPath":"preserved.wav"});
        for current in [
            failed.clone(),
            json!({"mode":"dictation","recording":false,"error":"Missing identity"}),
            json!({"mode":"dictation","sessionId":"old","recording":true,"error":"Still active"}),
        ] {
            recover_capture_failure(&lock, &dictating, &old, async { Ok(current) }, |_| {
                panic!("A stale or incomplete status cannot recover a new attempt")
            })
            .await;
            assert!(dictating.load(Ordering::SeqCst));
        }
        let saved = Mutex::new(Value::Null);
        recover_capture_failure(
            &lock,
            &dictating,
            &failed,
            async { Ok(failed.clone()) },
            |status| {
                assert!(lock.try_lock().is_err());
                assert!(!dictating.load(Ordering::SeqCst));
                *saved.lock().unwrap() = status;
                *target.lock().unwrap() = Value::Null;
            },
        )
        .await;
        assert_eq!(saved.lock().unwrap()["wavPath"], "preserved.wav");
        assert_eq!(saved.lock().unwrap()["error"], "New device error");
        assert!(target.lock().unwrap().is_null());
    }
}
