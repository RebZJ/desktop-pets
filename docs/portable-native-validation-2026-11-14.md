# Portable implementation and validation — 14 November 2026

This is the current architecture/build record. The product is limited to explicit dictation, diarized meeting notes and a meeting copilot. General chat, persona voice, writing and cursor autocomplete are paused; saved records and preferences remain intact.

## Ownership

- Tauri/React: pet, dictation cloud, meeting cloud, settings and archive.
- Rust `audio.rs` / `listening.rs` / `engine.rs`: CPAL capture, bounded buffering, resampling, WAV persistence, listening state, cancellation and ASR dispatch.
- Rust `asr.rs`: Moonshine C ABI plus the bundled Whisper/VAD and NeMo processes. Native-library/CLI failures are reported; they do not fabricate transcripts.
- Rust `portable.rs`: explicit checksum-verified model installs, local llama.cpp lifecycle, exact model tokenization, bounded generation and answer streaming.
- macOS `native/Platform`: accessibility-based dictation insertion, actual permission state and scoped/fallback ScreenCaptureKit audio only. No Swift package or MLX model inference is built into this adapter.
- Official Tauri clipboard/global-shortcut plugins: explicit Copy and configured desktop shortcuts.

`npm run native:build` invokes platform-neutral build scripts through Node. Build-time Python downloads source archives pinned by commit/SHA-256, then CMake produces Whisper/VAD, NeMo diarization, Moonshine and llama.cpp. NeMo's GGML and static SentencePiece sources are pinned too. The packaged app needs none of Python, developer tools, Ollama or a user-managed model service.

Tauri packages `native/bin`, `native/lib`, `native/share` and notices. Its build hook creates these runtimes before the frontend/package step; installer targets follow the host OS. Model weights stay outside the bundle and install only after an explicit request.

## Directly observed local checks

The following checks ran on the development Apple Silicon Mac without starting a live audio capture or requesting OS permissions:

| Check | Observed result |
| --- | --- |
| `npm run native:build` | Passed: source-built Whisper/VAD and NeMo, Moonshine ABI 30000, pinned llama.cpp and the small platform adapter. |
| Portable inference unit suite | Six tests passed: stream framing/UTF-8/completion, bounded request validation, manifest paths/pins, bad download hash rejection, HTTP SSE content handling and scoped cancellation. |
| Actual Qwen GGUF generation | Returned the correct release-note owner and Friday deadline from a supplied synthetic transcript. |
| Actual notes generation | Kept two tasks assigned to the same owner on separate bullets; applied Friday only to release notes and left the tutorial deadline unspecified. |
| Local engine authentication | An unauthenticated inference request returned HTTP 401. |
| Process shutdown | The Rust test stopped/reaped its owned llama.cpp child. |
| Source-built NeMo fixture | Processed an existing 46.6-second two-speaker WAV into four segments, alternating speaker labels 1/2/1/2. |
| macOS platform adapter smoke | JSONL cancellation and discard succeeded; model/inference methods returned an explicit unsupported error. |
| Build/config checks | Python syntax and archive-traversal self-check, Node/shell syntax, Info.plist lint and the three-OS workflow YAML passed. |

Local evidence is intentionally excluded from Git under `artifacts/runtime/`: `portable-native-build.log`, `portable-inference-tests.log`, `portable-actual-qwen-test.log` and `portable-speech-build.log`. These checks establish the tested fixture/build behavior, not broad model quality or complete device support. Integrated host/fixture validation is maintained separately by the current integration run.

## Integrated portable host checks

The real debug Tauri host passed `scripts/test-portable-features.mjs` using prerecorded synthetic audio and the actual installed model files. The assertions checked Moonshine dictation, Whisper word timestamps, two recurring speaker identities across four turns, preserved task owners/deadlines, meeting recovery and cleanup, and a quiet transcript-grounded copilot answer. Stopping the optional platform manager did not discard the loaded Rust speech runtime.

This test exposed DTW word endings stretching across a pause into the next speaker. Word-level diarization now prefers a labelled word onset and falls back to overlap when its onset is unlabelled; a regression test preserves the final deadline word with its speaker.

On the observed run, warm dictation decoded the fixture in 0.412 seconds; meeting recovery/notes took 20.83 seconds for a 35.28-second one-track, two-voice fixture, and its copilot answer took 2.402 seconds. These are local fixture timings, not streaming latency or hardware benchmarks. The fixture had one system track containing both speakers; it did not exercise simultaneous live input tracks.

The complete Chromium and WebKit interface suites each passed 70 checks. The current Rust suite passed 81 tests, with four explicitly installed-model tests excluded from the ordinary suite and exercised separately. Targeted review fixed quit/recovery state, per-track failure propagation, explicit audio deletion, bounded scoped insertion cleanup and platform-adapter startup/crash ordering.

Evidence: `artifacts/runtime/portable-features-ac692130-1e90-4024-9fed-dbdc6b17ab77/results.json`, `portable-core-e2e-final2.log`, `integrated-portable-rust.log`, `portable-ui-chromium.log`, `portable-ui-webkit.log`. No live capture or global-shortcut delivery is established by these fixture/interface checks.

## Installed native smoke check

The new macOS app was packaged, deeply signature-verified and installed at the existing path with the same stable signing requirement. The real profile had no active meetings, was backed up privately, and was preserved. No permission entries were reset or replaced.

CUA observed the real microphone level and Listening state. A controlled pet Dictate toggle then stopped capture with one click: Listening disappeared, Dictate returned to off within the next 0.62-second tool observation, and remained off after ten seconds. This establishes the pet Start/Stop path; it does not establish speech recognition quality or exact capture latency. Earlier draft text was not proof of live transcription. The separate dictation-cloud Stop button and physical hotkey delivery remain unverified by this check.

The first system-only meeting targeted to the synthetic Chrome fixture was blocked before recording by: “Enable Screen & System Audio Recording in System Settings before capturing meeting audio.” No permission prompt was operated, no fixture was played, and no test meeting was created. The app was left idle with Pace visible. Current content protection excluded its screenshots from this capture tool; that observation does not imply exclusion from every sharing application.

Evidence: `artifacts/runtime/portable-native-smoke/native-smoke-report.md` and `portable-macos-package.log`. The private microphone draft/audio was not reproduced in the report.

The user confirmed the Screen & System Audio Recording switch was already on. Read-only macOS logs showed that grant still required an old temporary build's exact cdhash, rejecting the stable signed app. One normal request, restart and existing-switch off/on refresh did not repair it. Replacing only that entry through System Settings with the exact installed signed app restored actual recording, without authentication. Accessibility and microphone grants stayed intact. The Settings view now refreshes access state on focus; its external-grant regression passed in Chromium and WebKit.

That first live Chrome test then exposed a second issue: there were two separately launched Chrome instances, while the scoped capture selected only the first matching process. The adapter now includes every running application with the selected bundle identity. Silent finalization now preserves the WAV and reports a recoverable error instead of declaring an empty recording completed and deleting its source. A regression test covers the empty-speech boundary. Live confirmation of this fix is tracked separately below.

## Platform limits and pending checks

macOS uses the shared Rust core with the narrow OS adapter only where scoped/fallback ScreenCaptureKit or accessibility is needed. The pet microphone Start/Stop path was checked above. Live system routing, permission denial/revocation, device changes and accessibility insertion need their own authorized device checks. A successful prerecorded test does not cover them.

Windows direct insertion is restricted to native Edit/RichEdit controls. Browser/custom controls keep a Copy result. Linux dictation is Copy-only until target insertion is verified. Windows/Linux system capture is whole-system, not per-application filtering. Windows ARM64 is excluded by the pinned Moonshine runtime's available ONNX binaries.

The Checks workflow compiles/tests Rust targets on `macos-15`, `windows-2022` and `ubuntu-24.04`. Linux includes ALSA, PipeWire/SPA, clang and Tauri/WebKit development dependencies. CPAL requires PipeWire >=0.3.53; Ubuntu 22.04's default 0.3.48 is insufficient. This record does not claim that Windows/Linux CI, native runtime execution or installers have passed; those results must be checked after the source is pushed.

Screen-capture exclusion is best effort across every OS and sharing application, never universal. Quick Hide remains a visible fallback. Signing/notarization and public release installation have not been validated by this build work.

The earlier [Swift-native validation](native-validation.md), [model research](snappy-models-research-2026-11-13.md), [migration plan](portable-tauri-plan-2026-11-13.md) and [60-minute soak](soak-validation.md) are historical evidence, not proof that the portable implementation passed those earlier checks.
