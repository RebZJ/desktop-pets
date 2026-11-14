//! Verified field writes where supported; guarded portable dispatch otherwise keeps an honest outcome.
use serde_json::{json, Value};

#[cfg(any(windows, test))]
#[path = "portable_paste.rs"]
mod portable_paste;

#[cfg(windows)]
use windows::Target;

#[cfg(windows)]
#[derive(Default)]
struct CaptureState {
    id: Option<String>,
    target: Option<Target>,
}

#[derive(Default)]
pub struct Insertion {
    #[cfg(windows)]
    state: std::sync::Mutex<CaptureState>,
    #[cfg(windows)]
    epoch: std::sync::atomic::AtomicU64,
    #[cfg(windows)]
    dispatch: std::sync::Mutex<()>,
}

impl Insertion {
    pub fn request(
        &self,
        method: &str,
        params: Value,
        current: impl Fn() -> bool,
    ) -> Result<Value, String> {
        if method == "dictation.clipboard.current" {
            return Ok(json!({"recoveries":[]}));
        }
        if method == "dictation.clipboard.restore" {
            return Ok(json!({"restored":false}));
        }
        #[cfg(windows)]
        {
            use std::sync::atomic::Ordering;
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            match method {
                "dictation.capture" => {
                    if !current() {
                        return Err(
                            "The dictation request expired. Use Copy transcript instead.".into(),
                        );
                    }
                    self.epoch.fetch_add(1, Ordering::SeqCst);
                    state.target = None;
                    state.id = None;
                    let target = Target::capture()?;
                    let result =
                        json!({"targetId":target.id,"app":"Focused application","canInsert":true});
                    state.id = Some(target.id.clone());
                    state.target = Some(target);
                    Ok(result)
                }
                "dictation.insert" => {
                    let text = insertion_text(&params)?;
                    if params["targetId"].as_str().is_none()
                        || params["targetId"].as_str() != state.id.as_deref()
                    {
                        return Err(
                            "The dictation target expired. Use Copy transcript instead.".into()
                        );
                    }
                    let target = state.target.take().ok_or("Capture the original text field before inserting. Use Copy transcript instead.")?;
                    let epoch = self.epoch.load(Ordering::SeqCst);
                    drop(state);
                    let _dispatch = self.dispatch.lock().map_err(|error| error.to_string())?;
                    let result = target.insert(text, || {
                        current() && self.epoch.load(Ordering::SeqCst) == epoch
                    });
                    let mut state = self.state.lock().map_err(|error| error.to_string())?;
                    if state.id.as_deref() == Some(target.id.as_str()) {
                        state.id = None;
                    }
                    result
                }
                "dictation.discard" => {
                    if params["targetId"]
                        .as_str()
                        .is_some_and(|id| state.id.as_deref() != Some(id))
                    {
                        return Ok(json!({"discarded":false}));
                    }
                    self.epoch.fetch_add(1, Ordering::SeqCst);
                    state.target = None;
                    state.id = None;
                    Ok(json!({"discarded":true}))
                }
                _ => Err("Unknown dictation insertion request.".into()),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (params, current);
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
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .is_ok_and(|value| value.eq_ignore_ascii_case("wayland"))
    {
        "Pace cannot safely verify the original text field on Wayland. Use Copy transcript, then paste into your app."
    } else {
        "Pace cannot verify the focused editable field on this desktop. Use Copy transcript, then paste into your app."
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
    use super::{portable_paste, unchanged, FieldState};
    use serde_json::{json, Value};
    use std::mem::size_of;
    use windows_sys::Win32::{
        Foundation::{HANDLE, HWND},
        UI::{
            Controls::{EM_GETSEL, EM_REPLACESEL},
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
            },
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
        verified: bool,
        field: Option<portable_paste::FocusedField>,
    }

    impl Target {
        pub fn capture() -> Result<Self, String> {
            let (state, verified) = current_field(true)?;
            let field = if verified {
                None
            } else {
                Some(current_uia_field(state.process)?)
            };
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
                verified,
                field,
            };
            if !unchanged(&target.state, &current_field(!verified)?.0) {
                return Err(STALE.into());
            }
            if let Some(field) = &target.field {
                if !portable_paste::same_editable_field(
                    field,
                    &current_uia_field(target.state.process)?,
                ) {
                    return Err(STALE.into());
                }
            }
            Ok(target)
        }

        fn alive(&self) -> bool {
            unsafe { GetPropW(self.state.focused as HWND, self.property.as_ptr()) as usize == 1 }
        }

        pub fn insert(&self, text: &str, valid: impl Fn() -> bool) -> Result<Value, String> {
            if !self.verified {
                return portable_paste::dispatch(text, || {
                    if !valid() || !self.alive() || !unchanged(&self.state, &current_field(true)?.0)
                    {
                        return Err(STALE.into());
                    }
                    let field = self.field.as_ref().ok_or(STALE)?;
                    if !portable_paste::same_editable_field(
                        field,
                        &current_uia_field(self.state.process)?,
                    ) {
                        return Err(STALE.into());
                    }
                    if [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN]
                        .iter()
                        .any(|key| unsafe { GetAsyncKeyState(*key as i32) } < 0)
                    {
                        return Err("Release modifier keys before dictating. Use Copy transcript for these words.".into());
                    }
                    Ok(())
                });
            }
            if !valid() || !self.alive() || !unchanged(&self.state, &current_field(false)?.0) {
                return Err(STALE.into());
            }
            let units: Vec<u16> = text.encode_utf16().collect();
            let (start, end) = self.state.selection;
            let mut expected = self.state.text.clone();
            expected.splice(start..end, units.iter().copied());
            let mut replacement = units;
            replacement.push(0);
            if !valid() || !self.alive() {
                return Err(STALE.into());
            }
            // EM_REPLACESEL is a system message; Windows marshals its string to this exact control.
            if send(
                self.state.focused as HWND,
                EM_REPLACESEL,
                1,
                replacement.as_ptr() as isize,
            )
            .is_err()
                || !valid()
                || !self.alive()
                || read_text(self.state.focused as HWND).ok().as_ref() != Some(&expected)
            {
                return Ok(
                    json!({"inserted":false,"dispatched":true,"verified":false,"insertionError":UNCONFIRMED}),
                );
            }
            Ok(json!({"inserted":true,"verified":true}))
        }
    }

    fn current_uia_field(process: u32) -> Result<portable_paste::FocusedField, String> {
        use ::windows::{
            core::{Error, Result as WindowsResult},
            Win32::{
                Foundation::E_INVALIDARG,
                System::{
                    Com::{
                        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                        COINIT_MULTITHREADED, SAFEARRAY,
                    },
                    Ole::{
                        SafeArrayDestroy, SafeArrayGetDim, SafeArrayGetElement,
                        SafeArrayGetElemsize, SafeArrayGetLBound, SafeArrayGetUBound,
                        SafeArrayGetVartype,
                    },
                    Variant::VT_I4,
                },
                UI::Accessibility::{
                    CUIAutomation8, IUIAutomation2, IUIAutomationValuePattern,
                    UIA_EditControlTypeId, UIA_ValuePatternId,
                },
            },
        };
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        struct RuntimeId(*mut SAFEARRAY);
        impl Drop for RuntimeId {
            fn drop(&mut self) {
                unsafe {
                    let _ = SafeArrayDestroy(self.0);
                }
            }
        }

        // Enigo cannot identify DOM fields; UI Automation must establish an editable, nonsecure target.
        let field = (|| -> WindowsResult<portable_paste::FocusedField> {
            unsafe {
                CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
                let _apartment = Apartment;
                let automation: IUIAutomation2 =
                    CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)?;
                automation.SetAutoSetFocus(false)?;
                automation.SetConnectionTimeout(250)?;
                automation.SetTransactionTimeout(250)?;
                let element = automation.GetFocusedElement()?;
                let secure = element.CurrentIsPassword()?.as_bool();
                let role = element.CurrentControlType()?;
                let editable = role == UIA_EditControlTypeId
                    && !element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)?
                        .CurrentIsReadOnly()?.as_bool();
                let runtime = RuntimeId(element.GetRuntimeId()?);
                if runtime.0.is_null() || SafeArrayGetDim(runtime.0) != 1
                    || SafeArrayGetElemsize(runtime.0) != 4
                    || SafeArrayGetVartype(runtime.0)? != VT_I4 {
                    return Err(Error::from_hresult(E_INVALIDARG));
                }
                let first = SafeArrayGetLBound(runtime.0, 1)?;
                let last = SafeArrayGetUBound(runtime.0, 1)?;
                let length = last.checked_sub(first).and_then(|length| length.checked_add(1))
                    .filter(|length| (1..=64).contains(length))
                    .ok_or_else(|| Error::from_hresult(E_INVALIDARG))?;
                let mut runtime_id = Vec::with_capacity(length as usize);
                for index in first..=last {
                    let mut value = 0_i32;
                    SafeArrayGetElement(runtime.0, &index, (&mut value as *mut i32).cast())?;
                    runtime_id.push(value);
                }
                Ok(portable_paste::FocusedField {
                    process: element.CurrentProcessId()? as u32,
                    runtime_id, role: role.0, editable,
                    enabled: element.CurrentIsEnabled()?.as_bool(),
                    focused: element.CurrentHasKeyboardFocus()?.as_bool(), secure,
                })
            }
        })().map_err(|_| "The focused editable field could not be verified with Windows Accessibility. Use Copy transcript instead.")?;
        if field.process != process || !portable_paste::same_editable_field(&field, &field) {
            return Err("The focused field is not a verified editable, nonsecure target. Use Copy transcript instead.".into());
        }
        Ok(field)
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

    fn current_field(allow_unverified: bool) -> Result<(FieldState, bool), String> {
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
            let verified = name == "edit" || name.starts_with("richedit");
            let style = GetWindowLongPtrW(focused, GWL_STYLE) as u32;
            if (!verified && !allow_unverified)
                || name.is_empty()
                || [
                    "button",
                    "static",
                    "listbox",
                    "syslistview32",
                    "systreeview32",
                    "toolbarwindow32",
                    "#32768",
                ]
                .contains(&name.as_str())
                || IsWindowUnicode(focused) == 0
                || IsWindowVisible(focused) == 0
                || style & (ES_PASSWORD as u32 | ES_READONLY as u32 | WS_DISABLED) != 0
            {
                return Err("This focused control cannot receive dictation safely. Use Copy transcript instead.".into());
            }
            let text = if verified {
                read_text(focused)?
            } else {
                vec![]
            };
            let selection = if verified {
                send(focused, EM_GETSEL, 0, 0)?
            } else {
                0
            };
            if verified && selection as u32 == u32::MAX {
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
            Ok((state, verified))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_free_backend_has_no_private_clipboard_recovery() {
        let insertion = Insertion::default();
        assert_eq!(
            insertion
                .request("dictation.clipboard.current", json!({}), || false)
                .unwrap(),
            json!({"recoveries":[]})
        );
        assert_eq!(
            insertion
                .request("dictation.clipboard.restore", json!({"id":"stale"}), || {
                    false
                })
                .unwrap(),
            json!({"restored":false})
        );
    }

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
            .request("dictation.capture", json!({}), || true)
            .unwrap_err()
            .contains("Copy transcript"));
        assert!(insertion
            .request(
                "dictation.insert",
                json!({"targetId":"stale","text":"safe"}),
                || true
            )
            .unwrap_err()
            .contains("Copy transcript"));
        assert_eq!(
            insertion
                .request("dictation.discard", json!({}), || true)
                .unwrap(),
            insertion
                .request("dictation.discard", json!({}), || true)
                .unwrap()
        );
    }
}
