use tauri::{AppHandle, Manager};
use tauri_nspanel::objc2_app_kit::{NSWindowSharingType, NSWindowStyleMask};
use tauri_nspanel::{tauri_panel, TrackingAreaOptions, WebviewWindowExt};

tauri_panel! {
    panel!(PacePetPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            hides_on_deactivate: false
        }
        with: {
            tracking_area: {
                options: TrackingAreaOptions::new()
                    .active_always()
                    .mouse_entered_and_exited()
                    .mouse_moved(),
                auto_resize: true
            }
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
    panel.set_accepts_mouse_moved_events(true);
    debug_assert!(panel.as_panel().acceptsMouseMovedEvents());
    debug_assert!(!panel.can_become_key_window());
    debug_assert!(!panel.can_become_main_window());
    debug_assert!(panel
        .as_panel()
        .styleMask()
        .contains(NSWindowStyleMask::NonactivatingPanel));
    Ok(())
}

pub fn set_capture_protection(window: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    let _main =
        MainThreadMarker::new().ok_or("Capture cover must be requested on the main thread")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    // Tauri queues this setter; use the public AppKit property so acknowledgement follows application.
    let native = unsafe { &*(pointer as *const tauri_nspanel::NSWindow) };
    let requested = if enabled {
        NSWindowSharingType::None
    } else {
        NSWindowSharingType::ReadOnly
    };
    native.setSharingType(requested);
    if native.sharingType() != requested {
        return Err("macOS did not apply the window sharing request".into());
    }
    Ok(())
}

pub fn show_without_focus(window: &tauri::WebviewWindow) -> Result<(), String> {
    let _main =
        MainThreadMarker::new().ok_or("Passive windows must be shown on the main thread")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    // Tauri owns this live NSWindow; orderFront does not make it key or activate the app.
    let native = unsafe { &*(pointer as *const tauri_nspanel::NSWindow) };
    native.orderFront(None);
    Ok(())
}

#[cfg(debug_assertions)]
pub async fn inspect(app: &AppHandle, label: &str) -> Result<serde_json::Value, String> {
    use tauri_nspanel::objc2_app_kit::{NSEventModifierFlags, NSEventType};
    let window = app
        .get_webview_window(label)
        .ok_or("The requested window is missing")?;
    let (send, receive) = tokio::sync::oneshot::channel();
    window.with_webview(move |webview| {
        let result = (|| -> Result<serde_json::Value, String> {
            // Tauri supplies the live WKWebView on the main thread for this callback.
            let view = unsafe { &*(webview.inner() as *const tauri_nspanel::NSView) };
            let native = view.window().ok_or("The webview has no native window")?;
            let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                NSEventType::LeftMouseDown, NSPoint::new(0.0, 0.0), NSEventModifierFlags::empty(),
                0.0, native.windowNumber(), None, 0, 1, 0.0,
            );
            Ok(serde_json::json!({
                "class":native.class().name().to_string_lossy(),
                "isNSPanel":native.isKindOfClass(tauri_nspanel::NSPanel::class()),
                "nonactivating":native.styleMask().contains(NSWindowStyleMask::NonactivatingPanel),
                "canBecomeKey":native.canBecomeKeyWindow(),
                "canBecomeMain":native.canBecomeMainWindow(),
                "isKey":native.isKeyWindow(),
                "isMain":native.isMainWindow(),
                "acceptsFirstMouse":event.as_deref().map(|event|view.acceptsFirstMouse(Some(event))),
                "sharingType":native.sharingType().0,
                "collectionBehavior":native.collectionBehavior().0
            }))
        })();
        let _ = send.send(result);
    }).map_err(|error|error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}
