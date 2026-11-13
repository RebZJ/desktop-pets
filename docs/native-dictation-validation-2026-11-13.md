# Native dictation and completion validation — 13 November 2026

The cursor insertion paths passed real macOS Accessibility tests against disposable AppKit text windows. No installed Pace app, existing document, clipboard, or real user text was modified. The test hosts and helper processes were created for these checks and terminated afterward.

## Reproduce

From the repository root:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
sh native/scripts/test-bridge.sh
python3 native/scripts/test-cursor-insertion.py
```

The cursor test requires macOS, Swift, and Accessibility permission for the terminal or host running it. It opens two temporary synthetic app windows and compiles the production `Bridge.swift` and `Dictation.swift`. Unused meeting and diarization services are stubbed, so this test neither downloads models nor records audio. It does not request or change permissions.

The original temporary harnesses and observed output are preserved under the Git-ignored directory `artifacts/runtime/native-cursor-validation-20261113/`. The checked-in script is self-contained and does not depend on those artifacts.

## Observed results

- Rust: **33 passed**, including all four shortcut defaults, invalid binding rejection, equivalent-key conflict rejection, continuation prompt boundaries, and dictation language routing.
- Lightweight native harness: **11 passed** (8 bridge tests and 3 cursor/context tests), including UTF-16 emoji ranges, invalid half-surrogate rejection, changed text/cursor rejection, and clipped completion context.
- The initial full Swift build and 2 dictation unit tests passed before the separate Moonshine integration began. The later completion source was compiled and tested through the lightweight harness.
- Actual AX selection replacement changed synthetic `before 🐾 after` to `before Pace after` while preserving surrounding text.
- Actual AX cursor insertion produced `before Pace! after` without replacing the field.
- A consumed target refused another insertion.
- Changing the cursor or field text after capture caused acceptance to fail with the field untouched.
- Completion capture returned `before`, `selected`, `after`, source app name, and native caret bounds. An observed caret rectangle was `{x:254.359375,y:1018,width:0,height:14}` in macOS global logical points.
- After switching to a second synthetic app, explicit completion acceptance restored the original app's focus and inserted only the selected range.
- Completion capture and dismissal left the independent dictation target usable.
- Dictation refused insertion after switching to the second synthetic app and did not reactivate or edit the original app.

## Safety behavior exercised

Dictation and completion keep separate, opaque, single-use target IDs. Both validate the original field, value, UTF-16 selection range, and direct insertion capability. Both write through `AXSelectedText`; neither cursor path uses whole-field `AXValue` replacement. Successful writes are checked against the expected prefix + insertion + suffix.

Dictation requires the original app to remain frontmost. Completion may restore app focus only through explicit acceptance, after validating the captured target; it validates the field again after activation. Password-manager exclusions and secure-field detection passed existing bridge unit tests; an actual password field was not used.

Rust serializes microphone start/stop/hide operations. Global insertion refusal retains the transcript for a copyable preview. Completion previews carry a version, and dismiss/new requests invalidate older generated results. These lifecycle properties were inspected in source; the actual AX tests exercise the native insertion kernel rather than the Tauri event loop.

## Limits

This report does not establish recognition accuracy, model latency, vocabulary quality, generated continuation quality, physical hotkey delivery, or final Tauri caret-window placement. It does not test real microphone speech, actual hidden-window/start-permission races, or every third-party app's AX implementation. Unsupported or unconfirmed insertion remains a copy fallback, and an unconfirmed write must be checked before copying to avoid duplication.

## Follow-up race fixes and regressions

An independent review identified late microphone permission, stale automatic speech, and pending work reopening after Quick Hide. The backend now:

- Sends `runtime.cancel` scoped to the original native request ID after a timeout. If the cancellation cannot be written within two seconds, it terminates that worker. Native capture remembers its initiating request ID so cancellation also stops a matching capture whose startup completed just before the timeout.
- Checks task cancellation after permission and ScreenCapture awaits, before starting capture, and before committing the capture to active state. It stops pending microphone/system resources as well as committed capture resources when their request is cancelled.
- Cancels the real native request registry on parent-pipe EOF, rejects new requests, finishes active/pending captures, stops playback, and exits without waiting indefinitely for an unanswered permission dialog.
- Rechecks current speech settings and a stop epoch after acquiring the generation lock for automatic chat speech. Stop, mute, dictation, and meeting requests invalidate older queued automatic speech. Native epoch markers also reject an old automatic voice request arriving after a stop. Explicit voice preview remains independent of the automatic speech setting.
- Invalidates completion previews immediately on Quick Hide and tags pending dictation UI work with a hide epoch. An older capture/start/transcription cannot reopen its cloud after Hide; a new explicit shortcut may summon Pace again. A startup that finishes after Hide is stopped and its transcript is retained without reporting a new recording to its caller.

After these changes, the full Rust suite passed **37/37**. The release Swift suite completed **38 tests with 2 opt-in model-fixture skips and no failures**. The lightweight native suite passed **14/14**. New deterministic tests use the actual `RequestTasks` registry with suspended fake permission gates; cancelling one request prevents its capture callback after a late grant while an unrelated request proceeds. EOF shutdown prevents its pending callback and rejects new requests. Additional regressions exercise delayed completion/dictation hide epochs and automatic speech epochs.

The fake gates avoid recording audio or changing operating-system permissions. They establish the cancellation and invalidation guards, rather than reproducing an actual 60-second system permission dialog or a physical Quick Hide keypress.

The final `native/bin/PaceNative` was rebuilt with `bash native/build.sh`, signed, and passed `codesign --verify`. Its SHA-256 at validation was `f704a567dffba23e2815fc98339d32a4d3ffdc054a1d58bd2e6922bedffb4888`. A fresh worker with an empty temporary data directory passed three protocol checks without loading a model or recording audio: an old automatic speech epoch returned `skipped` after Stop; explicit voice preview with automatic speech muted reached normal input validation; closing the parent's output pipe followed by input EOF exited with status 0 rather than SIGPIPE. Native output writes tolerate the disconnected parent so capture cleanup can run.
