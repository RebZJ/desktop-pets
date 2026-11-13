use crate::{action, emit, open_companion_for_request, set_pet_visible, stop_dictation, AppState};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager};

async fn start(app: &AppHandle, state: &AppState, ui_epoch: u64) -> Result<Value, String> {
    state.speech_epoch.fetch_add(1, Ordering::SeqCst);
    let settings = state.db.settings()?;
    let language = settings["dictationLanguage"]
        .as_str()
        .or_else(|| settings["language"].as_str())
        .unwrap_or("en");
    if state.dictating.swap(true, Ordering::SeqCst) {
        return Err("Dictation is already recording".into());
    }
    if !request_is_current(&state.ui_epoch, ui_epoch) {
        state.dictating.store(false, Ordering::SeqCst);
        return Err("Dictation cancelled".into());
    }
    let result = state
        .native
        .request(
            app,
            "audio.start",
            json!({"outputDir":state.data_dir.join("recordings"),"language":language,"_speechEpoch":state.speech_epoch.load(Ordering::SeqCst)}),
        )
        .await;
    if result.is_err() {
        state.dictating.store(false, Ordering::SeqCst);
    } else {
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

pub async fn toggle(app: AppHandle) -> Result<Value, String> {
    let state = app.state::<AppState>();
    // Ignore repeated presses while a start or transcription is in flight.
    let Ok(_guard) = state.dictation_lock.try_lock() else {
        return Ok(json!({"busy":true}));
    };
    if state.dictating.load(Ordering::SeqCst) {
        return finish_locked(&app, &state, true).await;
    }
    let ui_epoch = state.ui_epoch.load(Ordering::SeqCst);
    let _ = set_pet_visible(&app, true);
    let permission = state
        .native
        .request(&app, "permissions.status", json!({}))
        .await
        .and_then(|status| require_accessibility(&status));
    if !request_is_current(&state.ui_epoch, ui_epoch) {
        return Err("Dictation cancelled".into());
    }
    if let Err(error) = permission {
        open_companion_for_request(&app, "bubble", ui_epoch);
        emit(
            &app,
            "dictation.state",
            json!({"phase":"error","error":error}),
        );
        return Err(error);
    }
    let target = match state
        .native
        .request(&app, "dictation.capture", json!({}))
        .await
    {
        Ok(target) => target,
        Err(error) => json!({"captureError":error}),
    };
    *state.dictation_target.lock().map_err(|e| e.to_string())? = Some(target.clone());
    match start(&app, &state, ui_epoch).await {
        Ok(mut result) => {
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
            let _ = state
                .native
                .request(&app, "dictation.discard", json!({}))
                .await;
            if error != "Dictation cancelled" {
                open_companion_for_request(&app, "bubble", ui_epoch);
            }
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
            let _ = state
                .native
                .request(app, "dictation.discard", json!({}))
                .await;
            emit(
                app,
                "dictation.state",
                json!({"phase":"error","error":error}),
            );
            if target.is_some() {
                if insert {
                    open_companion_for_request(app, "bubble", ui_epoch);
                }
                emit(
                    app,
                    "dictation.finished",
                    json!({"error":error,"inserted":false}),
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
    let _ = state
        .native
        .request(app, "dictation.discard", json!({}))
        .await;
    let inserted = data["inserted"] == true;
    emit(
        app,
        "dictation.state",
        json!({"phase":if inserted {"inserted"} else {"draft"},"text":data["text"],"error":data["insertionError"]}),
    );
    if target.is_some() {
        if insert && !inserted {
            open_companion_for_request(app, "bubble", ui_epoch);
        }
        emit(app, "dictation.finished", data.clone());
    }
    Ok(data)
}

fn request_is_current(epoch: &AtomicU64, requested_epoch: u64) -> bool {
    epoch.load(Ordering::SeqCst) == requested_epoch
}

fn require_accessibility(status: &Value) -> Result<(), String> {
    if status["accessibility"] == "granted" {
        return Ok(());
    }
    Err("Enable Accessibility in System Settings to dictate into another app. Then return to your document and try again.".into())
}

#[cfg(test)]
mod tests {
    use super::{request_is_current, require_accessibility};
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };

    #[test]
    fn global_dictation_requires_explicit_accessibility_grant() {
        assert!(require_accessibility(&json!({"accessibility":"granted"})).is_ok());
        for status in [
            json!({"accessibility":"denied"}),
            json!({"accessibility":"unknown"}),
            json!({}),
            json!({"accessibility":true}),
        ] {
            assert!(require_accessibility(&status)
                .unwrap_err()
                .contains("Enable Accessibility in System Settings"));
        }
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
