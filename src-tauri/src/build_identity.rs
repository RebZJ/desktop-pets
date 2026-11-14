//! Visible build provenance and an isolated development identity.
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn is_dev(app: &AppHandle) -> bool {
    cfg!(debug_assertions) || app.config().identifier.ends_with(".dev")
}

pub fn shortcuts_enabled(app: &AppHandle) -> bool {
    !is_dev(app) || std::env::var("PACE_DEV_SHORTCUTS").is_ok_and(|value| value == "1")
}

pub fn label(app: &AppHandle) -> String {
    format!(
        "{} · {}{}",
        if is_dev(app) { "DEV" } else { "INSTALLED" },
        env!("PACE_BUILD_REVISION"),
        if env!("PACE_BUILD_DIRTY") == "true" {
            "+"
        } else {
            ""
        }
    )
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(root.parent().unwrap_or(&root).join(if is_dev(app) {
        "Desktop Pets Dev"
    } else {
        "Desktop Pets"
    }))
}

pub fn current(app: &AppHandle) -> Value {
    json!({"channel":if is_dev(app) {"dev"}else{"installed"},"label":label(app),
        "revision":env!("PACE_BUILD_REVISION"),"dirty":env!("PACE_BUILD_DIRTY")=="true",
        "version":app.package_info().version.to_string(),"identifier":app.config().identifier,
        "globalShortcutsEnabled":shortcuts_enabled(app)})
}

pub fn configure_windows(app: &AppHandle) {
    for config in &app.config().app.windows {
        if let Some(window) = app.get_webview_window(&config.label) {
            let _ = window.set_title(&format!("{} · {}", config.title, label(app)));
        }
    }
}
