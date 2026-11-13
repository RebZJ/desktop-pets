use tauri::{AppHandle, Manager};
use tauri_nspanel::objc2_app_kit::NSWindowStyleMask;
use tauri_nspanel::{tauri_panel, WebviewWindowExt};

tauri_panel! {
    panel!(PacePetPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            hides_on_deactivate: false
        }
    })
}

pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("pet")
        .ok_or("Pace pet window is missing")?;
    // shortcut: the adapter uses a private activation tag; recheck focus on macOS upgrades.
    let panel = window.to_panel::<PacePetPanel>()?;
    // Keep Tauri's existing borderless, protected, positioned window and add activation prevention.
    panel.add_style_mask(NSWindowStyleMask::NonactivatingPanel)?;
    panel.set_released_when_closed(false);
    debug_assert!(!panel.can_become_key_window());
    debug_assert!(!panel.can_become_main_window());
    debug_assert!(panel
        .as_panel()
        .styleMask()
        .contains(NSWindowStyleMask::NonactivatingPanel));
    Ok(())
}

#[cfg(debug_assertions)]
pub async fn inspect(app: &AppHandle) -> Result<serde_json::Value, String> {
    use tauri_nspanel::objc2_app_kit::{NSEventModifierFlags, NSEventType};
    use tauri_nspanel::ManagerExt;
    let window = app
        .get_webview_window("pet")
        .ok_or("Pace pet window is missing")?;
    let handle = app.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    window.with_webview(move |webview| {
        let result = handle.get_webview_panel("pet").map_err(|error| format!("{error:?}")).map(|panel| {
            let native = panel.as_panel();
            // Tauri supplies the live WKWebView on the main thread for this callback.
            let view = unsafe { &*(webview.inner() as *const tauri_nspanel::NSView) };
            let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                NSEventType::LeftMouseDown, NSPoint::new(0.0, 0.0), NSEventModifierFlags::empty(),
                0.0, native.windowNumber(), None, 0, 1, 0.0,
            );
            serde_json::json!({
                "class":native.class().name().to_string_lossy(),
                "isNSPanel":native.isKindOfClass(tauri_nspanel::NSPanel::class()),
                "nonactivating":native.styleMask().contains(NSWindowStyleMask::NonactivatingPanel),
                "canBecomeKey":panel.can_become_key_window(),
                "canBecomeMain":panel.can_become_main_window(),
                "acceptsFirstMouse":event.as_deref().map(|event|view.acceptsFirstMouse(Some(event))),
                "sharingType":native.sharingType().0,
                "collectionBehavior":native.collectionBehavior().0
            })
        });
        let _ = send.send(result);
    }).map_err(|error|error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}
