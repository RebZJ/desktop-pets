//! Clipboard-free text dispatch. An accepted key event is not a verified editor write.
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct FocusedField {
    pub process: u32,
    pub runtime_id: Vec<i32>,
    pub role: i32,
    pub editable: bool,
    pub enabled: bool,
    pub focused: bool,
    pub secure: bool,
}

pub(super) fn same_editable_field(original: &FocusedField, current: &FocusedField) -> bool {
    original == current
        && current.process != 0
        && !current.runtime_id.is_empty()
        && current.editable
        && current.enabled
        && current.focused
        && !current.secure
}

pub(super) fn validate_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty()
        || text.encode_utf16().count() > 100_000
        || text
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
    {
        return Err("Automatic text dispatch accepts one line without control characters. Use Copy transcript for this text.".into());
    }
    Ok(())
}

fn dispatch_with(
    text: &str,
    mut current: impl FnMut() -> Result<(), String>,
    mut send: impl FnMut(&str) -> Result<(), String>,
) -> Result<Value, String> {
    validate_text(text)?;
    let mut attempted = false;
    let mut remaining = text;
    while !remaining.is_empty() {
        if let Err(error) = current() {
            if !attempted {
                return Err(error);
            }
            return Ok(uncertain());
        }
        let end = remaining
            .char_indices()
            .nth(8)
            .map_or(remaining.len(), |(index, _)| index);
        let (chunk, rest) = remaining.split_at(end);
        attempted = true;
        // Once an emitter is called, even its error may follow a partial write. Never retry.
        if send(chunk).is_err() || current().is_err() {
            return Ok(uncertain());
        }
        remaining = rest;
    }
    Ok(json!({"inserted":false,"dispatched":true,"verified":false}))
}

fn uncertain() -> Value {
    json!({"inserted":false,"dispatched":true,"verified":false,"uncertain":true,"insertionError":"Text input may be partial. Check the field before copying; Pace will not retry automatically."})
}

#[cfg(windows)]
pub(super) fn dispatch(
    text: &str,
    current: impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    use enigo::Keyboard;
    validate_text(text)?;
    let mut keyboard = enigo::Enigo::new(&enigo::Settings::default())
        .map_err(|_| "Automatic text dispatch is unavailable. Use Copy transcript instead.")?;
    dispatch_with(text, current, |chunk| {
        keyboard.text(chunk).map_err(|error| error.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn field() -> FocusedField {
        FocusedField {
            process: 123,
            runtime_id: vec![42, 10],
            role: 50004,
            editable: true,
            enabled: true,
            focused: true,
            secure: false,
        }
    }

    #[test]
    fn changed_or_secure_field_in_the_same_window_is_refused_before_input() {
        let original = field();
        assert!(same_editable_field(&original, &original));
        for mutation in 0..7 {
            let mut focused = original.clone();
            match mutation {
                0 => focused.runtime_id[1] += 1,
                1 => focused.secure = true,
                2 => focused.editable = false,
                3 => focused.enabled = false,
                4 => focused.focused = false,
                5 => focused.runtime_id.clear(),
                _ => focused.role += 1,
            }
            assert!(dispatch_with(
                "safe words",
                || {
                    if same_editable_field(&original, &focused) {
                        Ok(())
                    } else {
                        Err("Focused field changed within the same window".into())
                    }
                },
                |_| panic!("An unverified field must never receive input")
            )
            .is_err());
        }
    }

    #[test]
    fn field_change_after_a_chunk_returns_uncertain_without_typing_into_the_new_field() {
        let original = field();
        let field_number = Cell::new(10);
        let writes = Cell::new(0);
        let result = dispatch_with(
            "one safe chunk and the rest",
            || {
                let mut focused = original.clone();
                focused.runtime_id[1] = field_number.get();
                if same_editable_field(&original, &focused) {
                    Ok(())
                } else {
                    Err("changed field".into())
                }
            },
            |_| {
                writes.set(writes.get() + 1);
                field_number.set(11);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(writes.get(), 1);
        assert_eq!(result["dispatched"], true);
        assert_eq!(result["verified"], false);
        assert!(result["insertionError"]
            .as_str()
            .unwrap()
            .contains("Check the field"));
    }

    #[test]
    fn invalid_controls_are_rejected_before_any_target_check_or_event() {
        for text in [
            "",
            "hello\n",
            "hello\r",
            "hello\t",
            "hello\0",
            "hello\u{7f}",
            "hello\u{2028}",
        ] {
            assert!(dispatch_with(
                text,
                || panic!("must validate first"),
                |_| panic!("must not send")
            )
            .is_err());
        }
    }
    #[test]
    fn stale_target_never_receives_input_and_unicode_chunks_remain_exact() {
        assert!(
            dispatch_with("safe", || Err("stale".into()), |_| panic!("must not send")).is_err()
        );
        let text = "Hello 世界 😀a👩‍💻é plus more";
        let mut sent = String::new();
        let result = dispatch_with(
            text,
            || Ok(()),
            |chunk| {
                assert!(chunk.chars().count() <= 8);
                sent.push_str(chunk);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(sent, text);
        assert_eq!(
            result,
            json!({"inserted":false,"dispatched":true,"verified":false})
        );
    }
    #[test]
    fn partial_failure_or_cancel_is_dispatched_uncertain_and_never_retried() {
        let calls = Cell::new(0);
        let result = dispatch_with(
            "first and more",
            || Ok(()),
            |_| {
                calls.set(calls.get() + 1);
                Err("partial events".into())
            },
        )
        .unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(result["dispatched"], true);
        assert_eq!(result["uncertain"], true);
        let checks = Cell::new(0);
        let mut sent = String::new();
        let result = dispatch_with(
            "first and more",
            || {
                checks.set(checks.get() + 1);
                if checks.get() > 1 {
                    Err("cancelled".into())
                } else {
                    Ok(())
                }
            },
            |chunk| {
                sent.push_str(chunk);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(sent, "first an");
        assert_eq!(result["dispatched"], true);
        assert_eq!(result["uncertain"], true);
    }
}
