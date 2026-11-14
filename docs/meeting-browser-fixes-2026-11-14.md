# Meeting, browser insertion and controls — 2026-11-14

## Fixes

The pet selector no longer stays open because WebKit retains `:focus-visible` after a click. Actual pet/tool hover and real keyboard input now control reveal; pointer exit, window blur and hiding clear it. Opening a tool also collapses it, including when a native window covers the nonfocusable pet before WebKit reports pointer exit. Dismissing recovery with the pointer cannot latch the selector open. Keyboard navigation remains available.

Shortcut pickers now follow native focus-loss and timeout resets. `shortcut.status` reports each saved binding’s actual registration and whether recording has temporarily suspended shortcuts. An unavailable binding shows “Unavailable—choose another combination”; suspension is not treated as failure. Native registration attempts all three bindings independently, so one OS conflict does not prevent the others. Only a real `shortcut.triggered` event marks a practice shortcut detected.

Browser insertion now handles Unicode offsets and preserves rich editable content. Target/context guards reject stale insertion; an uncertain post-insertion check tells the user to check existing text before explicitly copying, avoiding an automatic duplicate paste.

## Evidence

- Automated checks: **23 Swift tests passed; 103 Rust tests passed, 5 ignored; 99 Chromium and 99 WebKit tests passed.** After the final tool-opening adjustment, the four affected companion cases passed again in both engines. Browser tests use fixtures and do not establish native device behavior.
- Actual Chrome insertion: a payload longer than 20 UTF-16 units including emoji completed in about **201ms**; the rich-content preservation check passed with four markup nodes retained. A multilingual textarea payload including emoji completed in about **231ms**, with input events observed. These are insertion checks, not dictation latency measurements. Stale-target and no-Return safety checks passed.
- Actual ScreenCaptureKit capture: a Chrome-scoped, system-audio-only meeting using synthetic Kiki playback completed with **one transcript segment and 552 characters of notes**; expected words were recognized. This does not verify a live multi-speaker meeting or microphone hardware.
- An isolated real Tauri host passed **39 companion operations** without recording audio, including shortcut suspension, rebinding, restored registration, compact window behavior and adapter restart. The check now uses the current Chat action and immediate Quick Hide contract; it does not call the legacy Talk alias that starts dictation.

Evidence is retained under `artifacts/runtime/browser-insertion-live/` and `artifacts/runtime/companion-controls-current/`. This report intentionally excludes user recording contents, entered text and bridge credentials.

## Open limits and release identity

Three failed user microphone recordings contained only zero-valued audio samples. Only headers and numeric signal aggregates were inspected. A controlled comparison of native and portable microphone capture is waiting for the user's short spoken test; the successful synthetic system-audio test does not resolve that microphone failure.

The installed release matched the earlier `1a791da` build, so a failed hot reload was not the cause. Release applications contain bundled UI assets; Vite preview is a separate development process. Packaging and installation of the fixes were in progress when this report was written; this document does not claim the updated release is installed or that the reported user workflows now pass on hardware.
