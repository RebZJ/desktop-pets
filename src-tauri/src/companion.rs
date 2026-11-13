pub const WINDOW_LABELS: [&str; 5] = ["main", "pet", "bubble", "command", "meeting"];
pub const COMPANION_LABELS: [&str; 3] = ["bubble", "command", "meeting"];

pub fn request_capture_cover(
    enabled: bool,
    mut request: impl FnMut(&str, bool) -> Result<(), String>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for label in WINDOW_LABELS {
        if let Err(error) = request(label, enabled) {
            errors.push(format!("{label}: {error}"));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

pub fn passive_meeting_allowed(
    pet_visible: bool,
    requested_epoch: u64,
    current_epoch: u64,
    talk_visible: bool,
    completion_visible: bool,
) -> bool {
    pet_visible && requested_epoch == current_epoch && !talk_visible && !completion_visible
}

pub fn settings_section(page: &str, section: &str) -> Option<&'static str> {
    if page != "settings" {
        return None;
    }
    match section {
        "shortcuts" => Some("shortcuts"),
        "appearance" => Some("appearance"),
        "privacy" => Some("privacy"),
        _ => None,
    }
}

pub fn panel_position(pet: [i32; 4], monitor: [i32; 4], panel: [i32; 2], gap: i32) -> (i32, i32) {
    let [px, py, pw, ph] = pet;
    let [mx, my, mw, mh] = monitor;
    let [w, h] = panel;
    let min_x = mx.saturating_add(gap);
    let min_y = my.saturating_add(gap);
    let max_x = mx
        .saturating_add(mw)
        .saturating_sub(w)
        .saturating_sub(gap)
        .max(min_x);
    let max_y = my
        .saturating_add(mh)
        .saturating_sub(h)
        .saturating_sub(gap)
        .max(min_y);
    let x = px
        .saturating_add(pw / 2)
        .saturating_sub(w / 2)
        .clamp(min_x, max_x);
    let above = py.saturating_sub(h).saturating_sub(gap);
    let y = if above >= min_y {
        above
    } else {
        py.saturating_add(ph).saturating_add(gap)
    }
    .clamp(min_y, max_y);
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cover_request_visits_all_five_windows_even_after_failure() {
        let mut requested = Vec::new();
        let result = request_capture_cover(false, |label, enabled| {
            requested.push((label.to_owned(), enabled));
            if label == "main" {
                Err("OS request failed".into())
            } else {
                Ok(())
            }
        });
        assert!(result.unwrap_err().contains("main: OS request failed"));
        assert_eq!(
            requested,
            WINDOW_LABELS.map(|label| (label.to_owned(), false))
        );
    }
    #[test]
    fn all_windows_are_covered_and_meeting_starts_hidden_without_focus() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = config["app"]["windows"].as_array().unwrap();
        let mut configured: Vec<_> = windows
            .iter()
            .map(|window| window["label"].as_str().unwrap())
            .collect();
        let mut expected = WINDOW_LABELS.to_vec();
        configured.sort();
        expected.sort();
        assert_eq!(configured, expected);
        assert!(windows
            .iter()
            .all(|window| window["contentProtected"] == true));
        let meeting = windows
            .iter()
            .find(|window| window["label"] == "meeting")
            .unwrap();
        assert_eq!(meeting["width"], 420);
        assert_eq!(meeting["height"], 380);
        assert_eq!(meeting["minWidth"], 360);
        assert_eq!(meeting["minHeight"], 300);
        assert_eq!(meeting["focus"], false);
        assert_eq!(meeting["visible"], false);
        assert_eq!(meeting["acceptFirstMouse"], true);
        assert!(COMPANION_LABELS.contains(&"meeting"));
    }

    #[test]
    fn passive_meeting_tips_cannot_reopen_after_hide_or_interrupt_work() {
        assert!(passive_meeting_allowed(true, 1, 1, false, false));
        assert!(!passive_meeting_allowed(false, 1, 1, false, false));
        assert!(!passive_meeting_allowed(true, 1, 2, false, false));
        assert!(!passive_meeting_allowed(true, 1, 1, true, false));
        assert!(!passive_meeting_allowed(true, 1, 1, false, true));
    }

    #[test]
    fn settings_navigation_sections_are_scoped_and_validated() {
        assert_eq!(settings_section("settings", "shortcuts"), Some("shortcuts"));
        assert_eq!(
            settings_section("settings", "appearance"),
            Some("appearance")
        );
        assert_eq!(settings_section("settings", "privacy"), Some("privacy"));
        assert_eq!(settings_section("settings", "untrusted"), None);
        assert_eq!(settings_section("chat", "shortcuts"), None);
    }
    #[test]
    fn clouds_follow_the_pet_and_stay_inside_each_monitor() {
        assert_eq!(
            panel_position([1100, 700, 224, 232], [0, 0, 1440, 1000], [420, 330], 12),
            (1002, 358)
        );
        assert_eq!(
            panel_position([2, 2, 224, 232], [0, 0, 800, 600], [480, 400], 12),
            (12, 188)
        );
        assert_eq!(
            panel_position(
                [-1900, 700, 224, 232],
                [-1920, 0, 1920, 1080],
                [420, 330],
                12
            ),
            (-1908, 358)
        );
    }
}
