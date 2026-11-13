# Portable listening validation — 14 November 2026

Pace has three active jobs: explicit dictation, speaker-labeled meeting notes and a transcript-grounded copilot. General chat, persona voice, writing and cursor autocomplete are paused. Existing user data, models and preferences remain intact.

## Architecture

- Tauri/React owns the pet, compact dictation/meeting clouds, settings and records. Official Tauri plugins provide global shortcuts and explicit clipboard writes.
- Rust owns microphone capture, bounded buffering/chunks, resampling, WAV persistence, model installs, ASR dispatch and inference. Windows/Linux system capture uses CPAL/WASAPI/PipeWire.
- macOS system audio uses the narrow ScreenCaptureKit adapter. The CPAL Mac process tap stalled during a live all-system start, so that path is no longer selected. The same helper provides actual permission status and verified accessibility insertion; it has no MLX inference.
- Moonshine tiny packs handle supported dictation languages; Whisper/VAD and NeMo handle meeting words/speakers; an authenticated, app-owned llama.cpp child handles notes/questions. Model files install only after an explicit request and checksum verification.
- Meeting setup offers only Microphone and System audio. The unreliable per-application selector was removed.

## Observed checks

| Check | Result |
| --- | --- |
| Current Rust suite on the development Mac | 86 passed; four explicit model tests excluded from the ordinary suite and exercised separately. |
| Full Chromium / WebKit interface suites | 72 passed in each engine. |
| Slim native adapter tests | 16 passed, including the actual CMSampleBuffer callback path. |
| Real model-backed Tauri host fixture | Passed tiny dictation, Whisper timing, two recurring speakers, separate task deadlines, notes, grounded questions and safe recovery cleanup. |
| Installed cold microphone Start/Stop | One Start reached Listening and stayed active for three seconds; one Stop returned to off, still off after ten seconds. The successful processing cleared the old recovery pointer. This did not inspect recognition text or cross-app typing. |
| Installed live system meeting | Native `afplay` played the known 35-second two-voice fixture into an all-system ScreenCaptureKit session, microphone off. The recorded WAV had nonzero samples (peak 30194, RMS 3106 in the observed partial measurement). |
| Native meeting output | Two consistent anonymous voices; Amina's release notes due Friday, Daniel's installer test due Friday, tutorial without an agreed deadline, launch Monday. |
| Native copilot | Answered that launch is Monday with an actual transcript timestamp. |
| Native deletion | Only the three named synthetic meetings were deleted through confirmation. Their rows, own copilot messages and recording directories were verified gone. Other data/settings remained unchanged. |
| Local packaging | Tauri app built, deep signature checked, DMG checksum verified. The same stable signing requirement was retained across installed updates. This is not notarization/public-release validation. |

The fixture host observed warm tiny decoding in 0.412 seconds, meeting recovery/notes in 20.83 seconds and a copilot answer in 2.402 seconds. The live UI reached all-system recording in the next 1.34-second tool observation; native notes took roughly 45 seconds after stopping a longer capture containing lead-in silence. These are observed local fixtures/tool timings, not latency guarantees or general quality benchmarks.

The source-pinned native runtimes built and smoke-tested on **macOS ARM64, Windows x64 and Linux x64** in [CI for 4e13fa9](https://github.com/RebZJ/desktop-pets/actions/runs/43441659009). That run passed interface 71 tests, Mac/Linux 81 Rust tests each and Windows 79 (platform-gated tests differ), followed by Whisper/VAD, NeMo, Moonshine ABI 30000 and llama.cpp executable checks. Later application fixes have their current local checks above and a fresh CI run; do not treat the earlier run as the latest-head result. The next run also corrected an Xcode 16.4 test-harness framework lookup and disabled the unused llama web-UI download, keeping that build input source-pinned.

## Actual external insertion check

A temporary signed debug host used the same installed app identity with an isolated temporary data directory. The known public 8.6-second speech clip was decoded by `moonshine-tiny-en` (612 ms in the observed run), then passed unchanged to the actual native insertion service. Capture identified only the disposable `Pace Synthetic Cursor Fixture`; the app, field, text and caret were rechecked before writing. Native insertion took 14 ms. Both the fixture's state and a read-only CUA observation confirmed its original prefix followed by the complete ASR text, inserted once at the intended caret. The clipboard and user documents were not used.

The manual driver is `scripts/test-dictation-insertion.mjs`; its two bridge routes exist only in the already token-protected debug test host, excluded from release builds. It aborts on any unexpected target/focus/text, uses a pinned fixture hash and never retries insertion automatically. An earlier attempt safely aborted while opening a test clip from the protected project directory; the successful run staged that clip and profile in temporary storage without asking for Documents access.

Evidence: `artifacts/runtime/dictation-insertion-c3d7bf61-e761-40ad-abe4-79d2e133d831/results.json` and `dictation-insertion-temp-e2e.log`. This verifies Mac AppKit insertion; browser/custom controls and Windows/Linux typing are not established by this check.

## Bugs covered by the changes

- Recording starts before model warming. Accessibility lookup has a bounded wait and cannot delay opening the microphone. An unsupported target keeps a Copy draft.
- Live chunks have a bounded queue. Copilot generation cannot hold up transcription; stopping the optional helper does not discard the loaded Rust speech runtime.
- Word-level diarization uses a labeled word onset before overlap: DTW endings can stretch across a pause and previously gave a final deadline word to the next speaker.
- A silent final transcript reports a recoverable error and retains its WAV instead of declaring completion and deleting the source.
- A cold-start microphone test exposed recoverable CPAL buffer overruns being treated as fatal. Xrun, automatic DeviceChanged and RealtimeDenied notifications now leave capture running and accumulate bounded diagnostic counts; true device/permission/format/queue errors remain fatal. Tests cover continued PCM after notifications and preserved audio after a real disconnect.
- Actual callback regression tests found that the Mac converter discarded the right stereo channel. Explicit downmix now preserves left-only, right-only and combined signals in both planar and interleaved layouts, with duration and level checks.
- Quit/recovery guards preserve interrupted recordings without rewriting already completed meetings. Per-track capture errors propagate to the shared boundary.
- Meeting deletion removes its own chat thread atomically; a delayed copilot result cannot recreate that thread. Filesystem deletion failures preserve the record and surface an error.
- Settings refreshes permission state when Pace regains focus. Scoped target cleanup is bounded and cannot clear a newer insertion target.

## Permission/signing migration observed

The user correctly had Screen & System Audio Recording switched on. Read-only macOS logs showed that entry still required an old temporary build's exact cdhash and rejected the stable signed app. A normal request, restart and one existing-switch refresh did not repair it. Replacing only that entry through supported System Settings controls with the exact installed signed app restored recording without authentication. Later signed updates retained access. Accessibility and microphone grants were preserved.

This follows Apple's explanation that authorization retains the original signing requirement: [TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements). Repeatedly asking the user to enable an already-on switch is not a valid diagnosis.

## Limits

- Live Windows/Linux capture, model-backed inference on those hosts, native installers and permission/revocation/device-change scenarios have not been exercised here. Build/smoke success is separate from hardware support.
- Windows direct insertion supports verified native Edit/RichEdit controls; custom/browser fields use Copy. Linux uses Copy. Physical global-shortcut delivery remains unverified by CUA. Actual Mac native-field insertion was verified separately below.
- Windows ARM64 is excluded by the pinned Moonshine ONNX binaries. Linux ARM64 is a source target without a CI/hardware result here. Linux requires PipeWire >=0.3.53; CI uses Ubuntu 24.04.
- Scoped Chrome capture produced zero samples during the controlled browser tests; its cause was not established. It is no longer offered in the UI. The successful live baseline used all-system capture and the native player; the downmix fix has separate actual-callback regression coverage.
- Capture exclusion is best effort across OSes and sharing apps. This capture tool omitted protected app screenshots, but that does not guarantee invisibility everywhere. Quick Hide remains available.

The exact release-source CI run [ccbee19](https://github.com/RebZJ/desktop-pets/actions/runs/43452456444) subsequently passed interface 72, Rust Mac/Linux 86 and Windows 84 (four model tests ignored per OS), all three source-built native runtime/smoke suites, and all 16 Mac bridge regressions on Xcode 16.4. No physical Windows/Linux devices or installers were exercised.

Evidence is private/ignored under `artifacts/runtime/`: `portable-features-ac692130-1e90-4024-9fed-dbdc6b17ab77/results.json`, `portable-native-smoke/native-smoke-report.md`, `integrated-portable-rust.log`, `stereo-fixed-native-tests.log`, `listening-final-{chromium,webkit}.log`, packaging logs and `ci-4e13fa9-*` logs. No private microphone transcript is reproduced in this report.
