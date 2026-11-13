# Portable local runtimes

`npm run native:build` builds the native components for the current host. Build scripts target macOS 15+ (Apple Silicon or Intel), Windows x64, and Linux x64/arm64. Source builds and runtime smokes have passed on macOS ARM64, Windows x64 and Linux x64 in CI. Live Windows/Linux devices and installers remain unverified. Windows ARM64 is currently excluded because the pinned Moonshine archive contains only Windows x64 ONNX Runtime.

Build prerequisites are Node, Python 3, CMake 3.26+, and a C++17/20 compiler. Windows needs an x64 MSVC developer shell. macOS also needs Xcode's Swift and Metal toolchains. Python and the compilers are build tools; the packaged app uses native binaries and libraries.

The launcher builds:

- whisper.cpp and its Silero VAD executable, pinned to `d2c6f05a46dacf663e357bcf0ed40f542a72825d`.
- NeMo-Speech.cpp 0.3.0 diarization, its pinned llama.cpp dependency and static SentencePiece. Transcription, voice, HTTP serving and CLI microphone capture are disabled in this component.
- The Moonshine C SDK with the checked VAD reset patch and ABI version 30000.
- llama.cpp's local text server, pinned to `ae93877c8f3bf9f39f0ee4ffb3ef1697c416a7c3`.
- On macOS only, a small `PaceNative` adapter for accessibility-based dictation insertion, permission status and ScreenCaptureKit system audio. This helper has no Swift-package or MLX dependency. Rust owns normal microphone capture, Windows/Linux system capture and model inference. Mac system capture uses ScreenCaptureKit after a live CPAL process-tap stall.

Source archives are pinned by commit and SHA-256 in the build scripts. No Git checkout is required by the portable speech builders. The Moonshine macOS ARM64 compatibility builder reuses its existing pinned bootstrap. Build metadata is written beside generated runtimes. Ship `native/bin`, `native/lib`, `native/share` and `native/licenses`; Tauri's resource mappings preserve these directories. `npm run tauri build` runs the native builder before packaging and selects the current platform's installers. Model files are not included in the app bundle.

Models download only after an explicit install request in Local models. The portable catalog is `portable-models.json`; every file has a source URL, exact byte count and SHA-256. A download is marked installed only after verification. There are no model downloads on launch or cloud inference calls. Qwen GGUF uses `models/qwen3.5-4b-gguf`, keeping an existing MLX directory intact.

The Rust runtime owns an authenticated `127.0.0.1` llama.cpp child and starts it only when generation needs it. It bounds context and output, checks streamed completion, and kills/reaps the child on interrupted generation or shutdown. It requires no user-managed server. Text models serve meeting notes and questions grounded in the supplied transcript. Dictation uses Moonshine language packs or Whisper. NeMo provides speaker labels; labels do not identify a person's real name.

Linux builds require Tauri/WebKit development packages, ALSA, PipeWire >=0.3.53 and SPA headers. The CI host uses Ubuntu 24.04 because Ubuntu 22.04's default PipeWire is older than CPAL requires. CI lists the complete Ubuntu package set and compiles/tests the Rust host on macOS, Windows and Linux. Those host tests do not establish microphone permissions, device compatibility, diarization accuracy or native installer success.

Build checks:

```sh
python3 native/scripts/build-portable-speech.py --self-test
npm run test:rust
```

The legacy full Swift package and its historical experiments remain in `PaceNative/` for reference. They are not built or bundled by the portable entry point. Legacy `scripts/bootstrap-diarization.sh` downloads an old macOS-only release; use `npm run native:diarization` for the source-pinned portable build instead.

Portable voice chat uses Kitten Micro 0.8 ONNX in the Rust host, with the existing Moonshine bundle's ONNX Runtime 1.23 API, `kittentts` 0.4.1 and MIT `piper-plus-g2p` 0.5.4 English pronunciation. The explicitly installed `kitten-tts-micro-0.8-onnx` pack is 44.7 MB and preserves legacy MLX files. Kiki is the default. No Python, system voice, cloud service or separately running user server is needed. Notices are under `licenses/kitten`.

One Start begins a continuous local session. The shared capture owner excludes dictation and meetings. RMS endpointing ignores short clicks and ends after 900ms silence following at least 250ms speech; turns are bounded at 60 seconds. The microphone is released for transcription, answer generation and CPAL playback, then resumes automatically. This is half duplex: there is no echo cancellation or interruption during spoken playback. Ending, hiding or quitting invalidates queued turns and stops playback/capture. Unknown names can be spelled rather than naturally pronounced. Microphone/speaker hardware and conversational timing still need live validation on each platform.
