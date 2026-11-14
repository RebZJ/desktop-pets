# Desktop Pets

**Pace is a pixel companion for local voice conversations, dictation and speaker-labeled meeting notes.**

Home opens to Pace’s campsite, with Chat, Dictate, Meeting notes and summon/send-home controls. Hover over the desktop pet or give it keyboard focus to reveal the four-tool arc; no chat icon remains visible at rest. Chat opens an explicit 300×220 speech bubble. Type freely, or choose **Start voice conversation** once for automatic local listening, thinking and spoken replies. Opening Chat never records; Dictate explicitly starts capture. Writing and cursor autocomplete remain deferred; saved records, models and preferences are preserved.

Voice uses English ASR, the local Qwen text model and Kitten’s Kiki voice by default. It is half duplex: the microphone is released while Pace transcribes, thinks and speaks, then listening resumes automatically. Pace cannot hear interruptions during a reply. **End**, close and hide stop the voice session. The meeting copilot stays grounded in the selected transcript and has no general tool access.

This source uses a portable **Tauri 2 + React + Rust** application. Rust owns microphone capture, buffering, speech recognition, model management and text inference. Windows/Linux system audio uses CPAL; macOS system audio uses a small ScreenCaptureKit adapter because the CPAL process tap stalled in live testing. The same macOS adapter handles accessibility insertion. Local runtimes are bundled; the adapter contains no MLX inference.

## Current platform limits

| Platform | Implemented boundary and remaining verification |
| --- | --- |
| macOS 15+ | Earlier native microphone Start/Stop and system-audio meeting checks passed through speaker labels, notes and copilot. ScreenCaptureKit handles system capture; Rust handles microphone and local models. Dictation prefers AXSelectedText insertion, with an AXValue-and-caret fallback for supported fields that pass exact target checks. The user's Codex composer still requires a manual check; broader-editor support is not universal coverage. |
| Windows x64 | WASAPI capture and loopback. Direct insertion is restricted to native Edit/RichEdit controls; browser/custom controls use Copy. Rust tests and all bundled native runtime builds/smokes passed on Windows x64. Live device/insertion and installer testing remain. |
| Linux x64 | PipeWire microphone/system capture. Dictation offers Copy. Rust tests and bundled runtime builds/smokes passed; live devices and installers remain unverified. |

Windows ARM64 is excluded by the pinned Moonshine runtime's available ONNX binaries. Meeting setup offers microphone and **all system audio** consistently across platforms. Linux ARM64 is a source target without a CI/hardware result here. Desktop shortcuts and audio routing still need checks on the intended desktop/device, especially Wayland.

Capture exclusion is best effort and is never universal. Normal summon/send-home plays an eight-frame, 8fps pop-out/burrow action over one second. Quick Hide hides Pace’s windows immediately and ends voice chat; hiding a meeting cloud does not stop its recording. Review the selected audio source before starting a meeting. Speaker labels describe who spoke when; they do not identify real people automatically.

## Run from source

Install Node.js 22+, Rust 1.90+, Python 3, CMake 3.26+, and a C++17/20 compiler. Windows needs an x64 MSVC developer shell. macOS needs Xcode's Swift and Metal toolchains. Linux also needs the Tauri/WebKit, ALSA, PipeWire and SPA development packages listed in [the CI workflow](.github/workflows/checks.yml); its Linux runner uses Ubuntu 24.04.

```sh
npm ci
npm run native:build
npm run desktop
```

`npm run native:build` builds source-pinned Whisper/VAD, NeMo diarization, Moonshine and llama.cpp for the current host. On macOS it also builds the small platform helper. Source hashes, runtime notices and details live in [the native build guide](native/README.md).

Install only the needed models through **Local models**. Nothing downloads on launch. Verified downloads use pinned source URLs, exact sizes and SHA-256; incomplete downloads are never marked installed.

| Model | Active job | Download |
| --- | --- | --- |
| Moonshine Tiny EN/ZH/JA/ES | Dictation; English voice turns use Tiny EN | 45.4 MB English; about 32 MB each other language |
| Whisper large-v3-turbo Q5 + Silero VAD | Meeting transcription and Auto dictation | 574.9 MB |
| Nemotron 3 Diarization Q8 | Anonymous speaker labels | 107.0 MB |
| Qwen3.5 4B GGUF Q4_K_M | Chat, meeting notes and transcript-grounded questions | 3.03 GB |
| Kitten TTS Micro 0.8 ONNX | English voice conversations; Kiki by default | 44.7 MB |

Dictation does not require Qwen. The app starts its authenticated loopback llama.cpp child when generation needs it and stops it on cancellation/shutdown. Packaged users need no Python, Ollama, external model server, account or cloud inference service. Download size is separate from working memory; the development Mac has 16 GB.

`npm run dev` is a browser preview. It does not provide native audio or inference; browser contract tests use explicitly synthetic fixtures.

## Everyday use

- Choose Dictate, the tray dictation action or the window shortcut to start/stop capture. The configured global dictation shortcut also supports tap to start/stop or hold and release to finish. A nonfocusable 160×48 bottom-center indicator appears only during startup, recording and transcription, then disappears even on errors. Measured RMS drives pixel columns; a tiny notice above Pace offers Copy or saved-audio Retry when needed. It is not an editor. Insertion rechecks the original field; retry never inserts into an old target. Unsent drafts and failed-recognition audio remain available for recovery.
- Start a meeting with the selected microphone/system source. Live words, quiet suggestions and the meeting question field share one cloud. Stop recording before final notes are generated. Full records hold editable notes, action items and exports.
- Open Chat with Pace from Home or the pet's hover/focus selector. Start voice once to keep talking across turns; End stops it. Typing works without microphone access and preserves unsent drafts. Missing voice models offer Open Local models.
- Open Settings to choose language, dictation vocabulary, shortcuts, models and appearance. Existing chat/draft/settings data remains saved. Writing and cursor autocomplete stay deferred.

| Default action | Shortcut |
| --- | --- |
| Start/stop dictation | Alt/Option–Space |
| Start/finish global dictation | Alt/Option–Shift–D |
| Quick hide/show | Alt/Option–Shift–Space |

Permissions and shortcut availability depend on the OS. A macOS development signature change can invalidate an earlier accessibility grant; the UI reports actual access state. No build/test command above asks to record a real microphone or grants OS permissions automatically.

## Data and checks

Data stays in the app's local Desktop Pets directory, including SQLite, installed models and recordings retained for recovery. On macOS this is `~/Library/Application Support/Desktop Pets`; the runtime reports its actual data directory on other platforms. Existing records/preferences are not reset. Files use local account permissions; there is no separate encrypted vault. Review generated notes and actions against the transcript.

```sh
npm run build
npm test
npm run test:rust
# macOS adapter tests (no live capture): bash native/scripts/test-bridge.sh
python3 native/scripts/build-portable-speech.py --self-test
npm run tauri -- build
```

The Tauri packaging command builds the native runtimes and chooses the host's installer targets. Model weights are excluded. Signing, notarization and release publication are separate; there is no claim of a newly verified public installer.

See [the latest dictation and hover validation and limits](docs/dictation-hover-2026-11-14.md), [Pace’s habitat and sprite provenance](docs/pace-habitat-2026-11-14.md), [portable voice validation](docs/portable-voice-validation-2026-11-14.md), [the earlier compact interface research](docs/companion-ux-2026-11-14.md), [portable implementation and validation](docs/portable-native-validation-2026-11-14.md), [model selection](docs/model-selection.md), and [native architecture/builds](native/README.md). Earlier interface descriptions retain their historical scope. The historical [Swift validation](docs/native-validation.md) and [60-minute soak](docs/soak-validation.md) describe earlier implementations and do not establish the portable runtime's device behavior.

Code is **MIT**. Original Pace artwork is **CC BY 4.0**, credited to Outpaced / Desktop Pets. Model/runtime licenses remain separate; see [NOTICE](NOTICE.md). [Pet pack format](docs/pet-packs.md) and [contributing](CONTRIBUTING.md) remain available.
