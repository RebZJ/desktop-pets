# Shared microphone capture and editor coverage

The working dictation/voice microphone and the failing meeting microphone used different implementations. Mac meetings with system audio previously opened an AVAudioEngine microphone in the helper. They now reuse the parent's portable Rust/CPAL microphone; ScreenCaptureKit captures system audio only. Mic-only meetings, voice chat and dictation keep the existing shared recorder.

Both meeting tracks share a validated UUID and a precise common time origin. Live status, levels, offsets and final tracks are merged at the existing Engine boundary. Startup failure, adapter failure and Stop release microphone ownership and retain recoverable full tracks. Old worker events cannot stop a replacement session. Canonical PCM16 WAV headers can be repaired after a failed adapter is stopped without replacing audio bytes. Meeting document updates use the same lock as transcript appends.

The widget now recognizes a healthy individual track even if aggregate levels are invalid. Existing transcript words also prevent a false never-received-audio warning after reopening the widget.

## Portability policy

[AGENTS.md](../AGENTS.md) now requires maintained Tauri plugins/shared Rust first and agent-independent repository commands. The existing official shortcut and clipboard plugins remain in use. Their APIs do not provide verified editor identity, text and caret insertion. [Enigo](https://github.com/enigo-rs/enigo) offers portable input simulation, but its [macOS implementation](https://github.com/enigo-rs/enigo/blob/main/src/macos/macos_impl.rs) uses global event posting rather than the current process-targeted insertion. It was not added as a dependency because it does not replace the verification requirements. The Mac AX/insertion and ScreenCaptureKit gaps remain narrow native exceptions rather than being described as portable plugins.

Messages and Codex insertion are not established by Chrome tests. Capture currently requires readable text, a valid selection and supported writable attributes; native composers can fail those requirements. A non-writing Messages diagnostic remains gated on actual foreground focus. The initial recipient-free draft was rejected before insertion; that alone does not characterize every Messages composer. No test text was inserted into a real conversation, and no message was sent. Codex is blocked by computer control and was not accessed through another route.

## Checks and remaining verification

- Rust: 109 passed, five explicit runtime/model fixtures ignored. Swift platform checks: 24 passed. TypeScript passed. Chromium and WebKit: 102 passed each, no skips.
- Fake-recorder checks cover shared identity/origin, offsets, exclusive modes, failed-stop recovery, chunk tails and retained full audio. Header checks reject unexpected formats without modifying them.
- A fresh system-only Chrome-scoped native recording contained zero PCM samples. All-system capture completed two segments and 587 note characters, but did not match the known playback words. These are **not** a successful controlled speech regression. The earlier pre-change controlled system-audio result is documented separately; these new results do not prove a microphone/device pass.
- No new microphone recording was opened. Combined microphone/system capture and Messages insertion still need the user's live check. The signed replacement was installed after the app was observed idle, with the same signing requirement. Existing access remained Allowed; the exact settings, documents and message-ID baseline matched afterward (four meetings, 30 messages). The native selector starts collapsed. Windows/Linux hardware remains unverified.

Private evidence stays under `artifacts/runtime/browser-insertion-live/` and the `shared-microphone-*` build/test logs. No recording contents or bridge credentials belong in committed documentation.
