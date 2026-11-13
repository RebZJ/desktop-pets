//! Verified target insertion; unsupported surfaces keep the transcript available to copy.
use serde_json::{json, Value};

#[derive(Default)]
pub struct Insertion {
    #[cfg(windows)]
    target: std::sync::Mutex<Option<windows::Target>>,
}

impl Insertion {
    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        #[cfg(windows)]
        {
            let mut slot = self.target.lock().map_err(|error| error.to_string())?;
            match method {
                "dictation.capture" => {
                    *slot = None;
                    let target = windows::Target::capture()?;
                    let result =
                        json!({"targetId":target.id,"app":"Windows text field","canInsert":true});
                    *slot = Some(target);
                    Ok(result)
                }
                "dictation.insert" => {
                    let text = insertion_text(&params)?;
                    let target = slot.take().ok_or("Capture the original text field before inserting. Use Copy transcript instead.")?;
                    if params["targetId"].as_str() != Some(target.id.as_str()) {
                        return Err(
                            "The dictation target expired. Use Copy transcript instead.".into()
                        );
                    }
                    target.insert(text)?;
                    Ok(json!({"inserted":true}))
                }
                "dictation.discard" => {
                    if params["targetId"]
                        .as_str()
                        .is_some_and(|id| slot.as_ref().is_none_or(|target| target.id != id))
                    {
                        return Ok(json!({"discarded":false}));
                    }
                    *slot = None;
                    Ok(json!({"discarded":true}))
                }
                _ => Err("Unknown dictation insertion request.".into()),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = params;
            match method {
                "dictation.discard" => Ok(json!({"discarded":true})),
                "dictation.capture" | "dictation.insert" => Err(copy_fallback().into()),
                _ => Err("Unknown dictation insertion request.".into()),
            }
        }
    }
}

#[cfg(not(windows))]
fn copy_fallback() -> &'static str {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        "Pace cannot safely verify the original text field on Wayland. Use Copy transcript, then paste into your app."
    } else {
        "Automatic insertion is not available for this desktop. Use Copy transcript, then paste into your app."
    }
}

#[cfg(any(windows, test))]
fn insertion_text(params: &Value) -> Result<&str, String> {
    let text = params["text"].as_str().ok_or("Provide dictation text.")?;
    if text.trim().is_empty() || text.contains('\0') || text.encode_utf16().count() > 100_000 {
        return Err("Dictation text must be nonempty, at most 100,000 UTF-16 units and contain no NUL bytes.".into());
    }
    Ok(text)
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct FieldState {
    foreground: usize,
    focused: usize,
    process: u32,
    thread: u32,
    text: Vec<u16>,
    selection: (usize, usize),
}

#[cfg(any(windows, test))]
fn unchanged(original: &FieldState, current: &FieldState) -> bool {
    let (start, end) = current.selection;
    let boundary = |index: usize| {
        index == 0
            || index == current.text.len()
            || !((0xd800..=0xdbff).contains(&current.text[index - 1])
                && (0xdc00..=0xdfff).contains(&current.text[index]))
    };
    original == current
        && start <= end
        && end <= current.text.len()
        && boundary(start)
        && boundary(end)
}

#[cfg(windows)]
mod windows {
    use super::{unchanged, FieldState};
    use std::mem::size_of;
    use windows_sys::Win32::{
        Foundation::{HANDLE, HWND},
        UI::{
            Controls::{EM_GETSEL, EM_REPLACESEL},
            WindowsAndMessaging::*,
        },
    };

    // shortcut: packed EM_GETSEL offsets are 16-bit; use UI Automation before supporting larger fields.
    const MAX_FIELD_UNITS: usize = 60_000;
    const STALE: &str =
        "The original app, text field or cursor changed. Use Copy transcript instead.";
    const UNCONFIRMED: &str = "The app did not confirm insertion. Check the field before copying; Pace will not retry automatically.";

    pub struct Target {
        pub id: String,
        state: FieldState,
        property: Vec<u16>,
    }

    impl Target {
        pub fn capture() -> Result<Self, String> {
            let state = current_field()?;
            let id = uuid::Uuid::new_v4().to_string();
            let property: Vec<u16> = format!("Pace.Dictation.{id}")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            // The property belongs to this HWND lifetime, preventing reuse of a destroyed handle.
            if unsafe { SetPropW(state.focused as HWND, property.as_ptr(), 1_usize as HANDLE) } == 0
            {
                return Err("This text field cannot be verified at its privilege level. Use Copy transcript instead.".into());
            }
            let target = Self {
                id,
                state,
                property,
            };
            if !unchanged(&target.state, &current_field()?) {
                return Err(STALE.into());
            }
            Ok(target)
        }

        fn alive(&self) -> bool {
            unsafe { GetPropW(self.state.focused as HWND, self.property.as_ptr()) as usize == 1 }
        }

        pub fn insert(&self, text: &str) -> Result<(), String> {
            if !self.alive() || !unchanged(&self.state, &current_field()?) {
                return Err(STALE.into());
            }
            let units: Vec<u16> = text.encode_utf16().collect();
            let (start, end) = self.state.selection;
            let mut expected = self.state.text.clone();
            expected.splice(start..end, units.iter().copied());
            let mut replacement = units;
            replacement.push(0);
            if !self.alive() {
                return Err(STALE.into());
            }
            // EM_REPLACESEL is a system message; Windows marshals its string to this exact control.
            send(
                self.state.focused as HWND,
                EM_REPLACESEL,
                1,
                replacement.as_ptr() as isize,
            )
            .map_err(|_| UNCONFIRMED.to_string())?;
            if !self.alive()
                || read_text(self.state.focused as HWND).ok().as_ref() != Some(&expected)
            {
                return Err(UNCONFIRMED.into());
            }
            Ok(())
        }
    }

    impl Drop for Target {
        fn drop(&mut self) {
            if self.alive() {
                unsafe {
                    RemovePropW(self.state.focused as HWND, self.property.as_ptr());
                }
            }
        }
    }

    fn send(window: HWND, message: u32, wparam: usize, lparam: isize) -> Result<usize, String> {
        let mut result = 0;
        // All callers use system messages (< WM_USER), synchronous buffers, and a specific HWND.
        let sent = unsafe {
            SendMessageTimeoutW(
                window,
                message,
                wparam,
                lparam,
                SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT,
                500,
                &mut result,
            )
        };
        if sent == 0 {
            Err("The text field did not respond. Use Copy transcript instead.".into())
        } else {
            Ok(result)
        }
    }

    fn read_text(window: HWND) -> Result<Vec<u16>, String> {
        let length = send(window, WM_GETTEXTLENGTH, 0, 0)?;
        if length > MAX_FIELD_UNITS {
            return Err(
                "This text field is too large to verify safely. Use Copy transcript instead."
                    .into(),
            );
        }
        let mut text = vec![0_u16; length + 1];
        let copied = send(window, WM_GETTEXT, text.len(), text.as_mut_ptr() as isize)?;
        if copied != length {
            return Err(STALE.into());
        }
        text.truncate(copied);
        Ok(text)
    }

    fn current_field() -> Result<FieldState, String> {
        unsafe {
            let foreground = GetForegroundWindow();
            if foreground.is_null() {
                return Err(STALE.into());
            }
            let mut process = 0;
            let thread = GetWindowThreadProcessId(foreground, &mut process);
            if thread == 0 || process == 0 || process == std::process::id() {
                return Err(STALE.into());
            }
            let mut gui: GUITHREADINFO = std::mem::zeroed();
            gui.cbSize = size_of::<GUITHREADINFO>() as u32;
            if GetGUIThreadInfo(thread, &mut gui) == 0
                || gui.hwndFocus.is_null()
                || GetAncestor(gui.hwndFocus, GA_ROOT) != foreground
            {
                return Err(STALE.into());
            }
            let focused = gui.hwndFocus;
            let mut focused_process = 0;
            if GetWindowThreadProcessId(focused, &mut focused_process) != thread
                || focused_process != process
            {
                return Err(STALE.into());
            }
            let mut class = [0_u16; 256];
            let length = GetClassNameW(focused, class.as_mut_ptr(), class.len() as i32);
            let name =
                String::from_utf16_lossy(&class[..length.max(0) as usize]).to_ascii_lowercase();
            let style = GetWindowLongPtrW(focused, GWL_STYLE) as u32;
            if !(name == "edit" || name.starts_with("richedit"))
                || IsWindowUnicode(focused) == 0
                || IsWindowVisible(focused) == 0
                || style & (ES_PASSWORD as u32 | ES_READONLY as u32 | WS_DISABLED) != 0
            {
                return Err("This field does not support verified Windows cursor insertion. Password, browser and custom fields remain available through Copy transcript.".into());
            }
            let text = read_text(focused)?;
            let selection = send(focused, EM_GETSEL, 0, 0)?;
            if selection as u32 == u32::MAX {
                return Err(STALE.into());
            }
            let state = FieldState {
                foreground: foreground as usize,
                focused: focused as usize,
                process,
                thread,
                text,
                selection: (selection & 0xffff, (selection >> 16) & 0xffff),
            };
            if GetForegroundWindow() != foreground
                || GetGUIThreadInfo(thread, &mut gui) == 0
                || gui.hwndFocus != focused
                || !unchanged(&state, &state)
            {
                return Err(STALE.into());
            }
            Ok(state)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field() -> FieldState {
        FieldState {
            foreground: 1,
            focused: 2,
            process: 3,
            thread: 4,
            text: "hello world".encode_utf16().collect(),
            selection: (5, 5),
        }
    }

    #[test]
    fn insertion_rejects_changed_window_control_process_thread_text_or_selection() {
        let original = field();
        assert!(unchanged(&original, &original));
        for mutation in 0..6 {
            let mut current = original.clone();
            match mutation {
                0 => current.foreground += 1,
                1 => current.focused += 1,
                2 => current.process += 1,
                3 => current.thread += 1,
                4 => current.text.push(32),
                _ => current.selection = (0, 0),
            }
            assert!(!unchanged(&original, &current));
        }
    }

    #[test]
    fn insertion_rejects_invalid_selection_and_split_surrogates() {
        for selection in [(12, 12), (5, 4)] {
            let mut invalid = field();
            invalid.selection = selection;
            assert!(!unchanged(&invalid, &invalid));
        }
        let mut unicode = field();
        unicode.text = "a😀b".encode_utf16().collect();
        unicode.selection = (1, 3);
        assert!(unchanged(&unicode, &unicode));
        unicode.selection = (2, 2);
        assert!(!unchanged(&unicode, &unicode));
    }

    #[test]
    fn insertion_text_must_be_bounded_nonempty_and_not_nul_terminated_early() {
        for invalid in [
            json!({}),
            json!({"text": "  "}),
            json!({"text":"hi\0wrong"}),
            json!({"text":"😀".repeat(50_001)}),
        ] {
            assert!(insertion_text(&invalid).is_err());
        }
        assert_eq!(
            insertion_text(&json!({"text":"Hello 世界 😀"})).unwrap(),
            "Hello 世界 😀"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn unsupported_desktops_keep_copy_fallback_and_discard_is_idempotent() {
        let insertion = Insertion::default();
        assert!(insertion
            .request("dictation.capture", json!({}))
            .unwrap_err()
            .contains("Copy transcript"));
        assert!(insertion
            .request(
                "dictation.insert",
                json!({"targetId":"stale","text":"safe"})
            )
            .unwrap_err()
            .contains("Copy transcript"));
        assert_eq!(
            insertion.request("dictation.discard", json!({})).unwrap(),
            insertion.request("dictation.discard", json!({})).unwrap()
        );
    }
}
