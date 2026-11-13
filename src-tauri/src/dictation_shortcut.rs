use std::time::{Duration, Instant};

const HOLD: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Action {
    Start(u64),
    Stop(u64),
}

#[derive(Default)]
pub struct Gesture {
    down: Option<(Instant, bool)>,
    next: u64,
    session: Option<(u64, Stage)>,
}

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    Starting { stop: bool },
    Recording,
    Finishing,
}

impl Gesture {
    pub fn press(&mut self, now: Instant, recording: bool, busy: bool) -> Option<Action> {
        if self.down.is_some() {
            return None;
        }
        self.down = Some((now, false));
        match self.session {
            Some((id, Stage::Starting { .. })) => {
                self.session = Some((id, Stage::Starting { stop: true }));
                None
            }
            Some((_, Stage::Finishing)) => None,
            _ if recording => {
                self.next += 1;
                self.session = Some((self.next, Stage::Finishing));
                Some(Action::Stop(self.next))
            }
            _ if busy => None,
            _ => {
                self.next += 1;
                self.down = Some((now, true));
                self.session = Some((self.next, Stage::Starting { stop: false }));
                Some(Action::Start(self.next))
            }
        }
    }

    pub fn release(&mut self, now: Instant) -> Option<Action> {
        let (pressed, starts) = self.down.take()?;
        if !starts || now.saturating_duration_since(pressed) < HOLD {
            return None;
        }
        self.stop()
    }

    pub fn stop(&mut self) -> Option<Action> {
        let (id, stage) = self.session?;
        match stage {
            Stage::Starting { .. } => {
                self.session = Some((id, Stage::Starting { stop: true }));
                None
            }
            Stage::Recording => {
                self.session = Some((id, Stage::Finishing));
                Some(Action::Stop(id))
            }
            Stage::Finishing => None,
        }
    }

    pub fn started(&mut self, id: u64, success: bool) -> Option<Action> {
        let Some((current, Stage::Starting { stop })) = self.session else {
            return None;
        };
        if current != id {
            return None;
        }
        if !success {
            self.session = None;
        } else if stop {
            self.session = Some((id, Stage::Finishing));
            return Some(Action::Stop(id));
        } else {
            self.session = Some((id, Stage::Recording));
        }
        None
    }

    pub fn current(&self, id: u64) -> bool {
        self.session.is_some_and(|(current, _)| current == id)
    }

    pub fn finished(&mut self, id: u64) {
        if self.current(id) {
            self.session = None;
        }
    }

    pub fn clear(&mut self) {
        self.session = None;
    }

    pub fn reset(&mut self) -> Option<Action> {
        self.down = None;
        // Rebinding can lose key-up: finish the old gesture before removing its listener.
        self.stop()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tap_latches_and_next_press_stops_even_before_microphone_opens() {
        let now = Instant::now();
        let mut key = Gesture::default();
        assert_eq!(key.press(now, false, false), Some(Action::Start(1)));
        assert_eq!(key.release(now + Duration::from_millis(50)), None);
        assert_eq!(
            key.press(now + Duration::from_millis(100), false, true),
            None
        );
        assert_eq!(key.started(1, true), Some(Action::Stop(1)));
        assert_eq!(key.release(now + Duration::from_millis(150)), None);
        key.finished(1);
        assert_eq!(key.press(now + HOLD, false, false), Some(Action::Start(2)));
    }

    #[test]
    fn hold_release_is_remembered_during_startup_and_repeat_is_ignored() {
        let now = Instant::now();
        let mut key = Gesture::default();
        assert_eq!(key.press(now, false, false), Some(Action::Start(1)));
        assert_eq!(key.press(now + HOLD, true, true), None);
        assert_eq!(key.release(now + HOLD), None);
        assert_eq!(key.release(now + HOLD), None);
        assert_eq!(key.started(1, true), Some(Action::Stop(1)));
        assert_eq!(key.press(now + HOLD, false, true), None);
    }

    #[test]
    fn held_recording_stops_once_and_rebinding_cannot_strand_capture() {
        let now = Instant::now();
        let mut key = Gesture::default();
        key.press(now, false, false);
        assert_eq!(key.started(1, true), None);
        assert_eq!(key.release(now + HOLD), Some(Action::Stop(1)));
        assert_eq!(key.reset(), None);
        key.finished(1);
        key.press(now, false, false);
        assert_eq!(key.reset(), None);
        assert_eq!(key.started(2, true), Some(Action::Stop(2)));
        assert_eq!(key.started(1, false), None);
        assert!(key.current(2));
    }

    #[test]
    fn cancel_invalidates_pending_actions_and_waits_for_key_up() {
        let now = Instant::now();
        let mut key = Gesture::default();
        key.press(now, false, false);
        key.clear();
        assert!(!key.current(1));
        assert_eq!(key.started(1, true), None);
        assert_eq!(key.press(now + HOLD, false, false), None);
        assert_eq!(key.release(now + HOLD), None);
        assert_eq!(key.press(now + HOLD, false, false), Some(Action::Start(2)));
    }

    #[test]
    fn transcribing_or_failed_start_never_opens_another_microphone() {
        let now = Instant::now();
        let mut key = Gesture::default();
        assert_eq!(key.press(now, false, true), None);
        key.release(now + HOLD);
        assert_eq!(key.press(now, false, false), Some(Action::Start(1)));
        assert_eq!(key.started(1, false), None);
        key.release(now + HOLD);
        assert_eq!(key.press(now, true, false), Some(Action::Stop(2)));
        assert_eq!(key.release(now + HOLD), None);
    }
}
