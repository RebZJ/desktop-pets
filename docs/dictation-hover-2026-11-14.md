# Dictation indicator and hover selector — 14 November 2026

This update replaces the persistent desktop Chat icon and expanding dictation editor described in earlier interface reports. The campsite, onboarding camp, Kitten/Kiki voice conversation and meeting flows keep their existing scope. Earlier validation remains historical evidence, not proof of this revision's hardware behavior.

## Current behavior

The complete Dictate, Chat, Meeting and Settings arc appears only on pet hover or keyboard focus. Every tool is hidden at rest. The revealed arc uses a stepped 2px float and short pixel reveal/lift; reduced motion removes those animations and transforms. There is no persistent desktop Chat icon.

Dictation has a fixed 160×48 native indicator at the bottom center of the pet's display. It appears only for `starting`, `recording` and `transcribing`, and hides for idle, inserted, draft and error states. Native visibility reads the latest phase and pet visibility on the main thread, preventing an older queued completion from hiding a newer active capture. The indicator is nonfocusable and uses `show_without_focus` so displaying it does not steal the editor target.

Recording status comes from actual capture. Measured RMS lights pixel columns with 8× visual gain; the accessible 0–1 meter retains the raw RMS value. Without fresh level events, it returns to zero. Startup and transcription show stepped work dots instead of synthetic audio activity. Stop is available during recording; cancellation follows the native lifecycle.

Terminal recovery appears in a short 160×48 notice above Pace, replacing the selector while it is shown. It offers explicit **Copy words**, **Retry audio** when saved audio exists, or model recovery when needed. It is not an editor. Action-free notices may dismiss after a short delay; useful recovery actions remain available until dismissed or superseded. Existing unsent draft keys are preserved, and failed recognition retains audio for explicit retry. A retry produces copyable text and does not silently insert into an old field.

Dictate, the tray dictation action and the window shortcut now start/stop capture directly. The onboarding action says **Start dictation**. The separate configured dictation shortcut keeps its existing gesture: key-down starts capture, a tap latches recording, a later tap stops, and a hold finishes on release. Existing user shortcut preferences are unchanged.

## Insertion boundary

The shared macOS adapter prefers writable `AXSelectedText`. If that is unavailable, it accepts `AXValue` only when both the full value and selected range are writable. Insertion requires the captured app to remain frontmost, the same focused accessibility element, unchanged full text and unchanged valid UTF-16 selection. The target is consumed before writing so an uncertain result cannot trigger automatic duplicate insertion. The fallback verifies the full resulting value and restores/verifies the caret. A failure explains that the user should check the field before copying.

This path uses neither clipboard paste nor Enter. It supports additional fields that expose those accessibility operations; it does not establish universal editor compatibility. Windows insertion remains restricted to native Edit/RichEdit controls, and Linux remains copy-only.

## Validation and limits

| Check | Evidence for this revision |
| --- | --- |
| Browser contracts | The 94-test suite ran in Chromium and WebKit: 93 passed per engine; the stale idle-widget expectation was corrected and passed on targeted rerun in both. A subsequently added uncertain-insertion recovery case also passed in both. |
| RMS visual gain | The targeted quiet-input fixture (`rms=0.01`) passed in Chromium and WebKit with visual gain; the raw semantic meter remains unchanged. |
| Rust | 103 passed; 5 ignored. Includes active-phase visibility and fixed indicator configuration checks. |
| macOS adapter unit tests | 18 passed, including selected-text preference and value/caret fallback requirements. |
| Synthetic native host fixture | Passed: the active bubble was 160×48, visible, unable to become key and not key; terminal states hid it. Quick Hide plus late synthetic activity kept it hidden. No microphone opened, insertion was not requested, no external application was inspected, and no WAV files were produced. The isolated host quit with code 0 and an empty process group. |
| User's exact composer | Appears to be Codex. The computer-control tool blocked access, so it was not tested through another route or alias. A manual user check is still required. |
| Live microphone and editor coverage | These unit/browser results do not establish device behavior or insertion in every editor. |

The pass counts above summarize the current implementation work; documentation editing did not rerun those suites. Native fixture metadata is in `artifacts/runtime/dictation-hover-native/synthetic-native-results.json`. It establishes native window behavior under synthetic state changes, not live recording or insertion. No actual recording was performed in this new fixture. There is no claim that Codex insertion works. The exact composer must be checked manually by the user, without bypassing the computer-use restriction.

Earlier evidence: [native dictation validation](native-dictation-validation-2026-11-13.md), [compact interface research](companion-ux-2026-11-14.md), [portable runtime validation](portable-native-validation-2026-11-14.md) and [portable voice validation](portable-voice-validation-2026-11-14.md). Their prior layouts, fixture results and hardware checks remain scoped to the versions they describe.
