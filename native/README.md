# Pace native worker

Apple Silicon, macOS 15+. Build with `./native/build.sh` using Xcode and Swift 6.2 or newer. The script downloads the Xcode Metal toolchain when missing and builds pinned, static whisper.cpp transcription and Silero detection executables. Swift package revisions are locked in `PaceNative/Package.resolved`. This is the native Apple Silicon/macOS implementation; Windows support has not been ported or validated.

Before the Swift build, `native/build.sh` runs `scripts/bootstrap-moonshine.sh` and `scripts/patch-mlx-audio.sh`. The bootstrap checks the C header and builds a deployment-compatible Moonshine archive; do not substitute the published archive, whose Moonshine objects target macOS 26. The pinned MLX Audio checkout receives the three checked-in `patches/mlx-audio-*.patch` files. Reapply these scripts after dependency resolution; the patch script rejects an unreviewed upstream revision. See [the compatibility findings](../docs/dictation-privacy-research-2026-11-13.md).

Ship **all of `native/bin`, `native/lib`, and `native/share`**, preserving the Metal `.bundle` directories beside `PaceNative`. The native worker and its required resources run without a Python installation. The NeMo diarization bootstrap is documented in its accompanying scripts.

The build uses `swift-stdlib-tool` to copy required Swift compatibility libraries beside the helper, so the packaged app does not depend on an installed Xcode toolchain. Pinned Swift dependency and embedded-component notices are collected into `native/licenses/swift-packages`; ship `native/licenses` too.

The worker reads JSON lines from stdin and writes only JSON lines to stdout. Diagnostics go to stderr. Requests run concurrently; MLX generation rejects a second simultaneous inference with `busy`. Capture, status and cancellation remain responsive during generation and downloads.

```json
{"id":"status","method":"models.status","params":{}}
{"id":"install","method":"models.install","params":{"id":"qwen3.5-4b"}}
{"id":"chat","method":"chat.generate","params":{"messages":[{"role":"user","content":"Say hello in one sentence."}],"maxTokens":64}}
{"id":"voice","method":"voice.speak","params":{"text":"Hello! I am Pace.","language":"English","voice":"Kiki","voiceEngine":"kitten","play":false}}
{"id":"asr","method":"audio.transcribe","params":{"path":"/absolute/path/mono-16khz.wav","language":"en"}}
```

Replies are `{id,result}` or `{id,error:{code,message}}`. Events are `{event,data}`; `data.requestId` identifies the request. Events include `models.progress`, `runtime.loading`, `chat.delta`, and `voice.generating/ready/started/stopped`. `runtime.cancel` accepts `params.id` to cancel a request, or cancels all model/download/transcription requests when omitted. `voice.stop` cancels speech generation and playback.

Models install **only when explicitly requested**. Downloads use pinned manifests or a pinned Hugging Face revision, resume partial files and verify every file against its SHA-256 or Git blob SHA-1 before marking the model installed. Installed metadata and required file sizes are checked before inference; generation uses local directories. Resuming an install reuses its pinned revision. `models.status` lists the available model ids.

Default storage is `~/Library/Application Support/Desktop Pets`. `PACE_DATA_DIR` overrides this root; `PACE_MODELS_DIR` overrides the models directory; `PACE_BIN_DIR`, `PACE_WHISPER_BIN`, `PACE_VAD_BIN`, and `PACE_DIARIZE_BIN` select the bundled native binaries. Model weights, transcripts and generated audio are never uploaded. Model downloads contact their configured upstream hosts only during explicit installation. Build/bootstrap scripts also fetch their pinned dependencies.

`whisper-turbo` includes a pinned, checksum-verified Silero VAD model. Existing installations upgrade through the same install action and reuse the Whisper weights. Transcription fails clearly if the detector is unavailable. Silero skips speech-free windows and selects separate regions with one second of original context on both sides. Overlapping regions merge; separate utterances decode independently, with their original absolute offsets. Audio longer than 30 seconds uses 28-second cores with one second of original context on each side, retaining absolute DTW word timestamps and one owner per boundary word. Native DTW alignment requires disabling Whisper flash attention; CJK text is emitted in token units. Audio is never concatenated to remove silence. This limits silent-window hallucinations with generous context beyond detector boundaries; it does not establish accuracy for every real microphone, accent or background noise.

`chat.generate` accepts an optional strict Boolean `precise`. When true it uses greedy generation (temperature 0) for factual extraction; the default retains temperature 0.7. This improves repeatability without guaranteeing factual accuracy.

Kiki is the selected English voice using the 149 MB KittenTTS Micro 0.8 pack. Qwen voice presets remain a separate installed option. Explicit global dictation uses Moonshine Tiny language packs (English about 45 MB; Chinese, Japanese and Spanish about 32 MB each); automatic language detection uses the separately installed Whisper model. `dictationVocabulary` supplies optional local recognition terms; it does not guarantee a spelling.

Native caret autocomplete captures nearby field text only on invocation and uses optional local `writingExamples`. Accept revalidates the original app, field, text and selection before insertion. The 420×240 preview sits above the captured caret and provides Copy/Dismiss recovery; the old Writing route is compatibility UI. Global dictation preflights Accessibility before microphone startup. If denied, it returns an error with an explicit Open Accessibility settings action and starts no recording. If granted, recording uses the big-ear pose without an extra Talk panel; a cloud is reserved for copy/error recovery. Dictation needs its small speech pack, not the optional 4B language model. Talk’s microphone leaves a draft for review. Defaults are Alt+Space (Talk), Alt+Shift+D (Dictate), Alt+Shift+Enter (Autocomplete), and Alt+Shift+Space (Quick Hide), all configurable.

The idle native pet has no toolbar. Pointer hover or keyboard focus reveals a three-slot selector below Pace (Talk, Dictate, Write for me); right-click supplies Meeting notes, Pet settings, A tiny victory! and Hide Pace. Companion overlays set `acceptFirstMouse: true` so an inactive first click reaches the control while the pet remains non-focusable. Native first-click Talk/Write delivery was observed; the latest debug app identity was denied Accessibility, so full insertion through the final app’s granted identity remains pending. This is not a claim of complete native end-to-end validation.

Window content protection is best effort. The controlled macOS 26 screenshot/stream probes do not establish exclusion in every recorder or conferencing app; Quick Hide hides companion windows. See [capture measurements](../docs/dictation-privacy-research-2026-11-13.md) and [native insertion validation](../docs/native-dictation-validation-2026-11-13.md).

Text context is bounded to 8K tokens with at most 2048 new tokens. Speech accepts up to 1500 characters and ten supported Qwen languages. The 0.6B model uses named presets; it does not promise instruction-based emotional control. `pitch` (0.75–1.5), `rate` (0.5–1.5), and `volume` (0–1) customize local playback; defaults are 1.05, 1, and 0.65. `play:false` returns an unmodified WAV for inspection without playing sound.

Run `swift test --package-path native/PaceNative -c release -j 6` for model-boundary and bridge tests. Hardware inference evidence belongs in `docs/native-validation.md`; unit tests do not establish model quality, meeting accuracy, or microphone/screen-capture permissions.

The macOS pet window is converted to a pinned `tauri-nspanel` non-activating panel so pointer controls can preserve the writing application. Talk remains a normal explicitly focused window. The adapter uses a private AppKit activation tag after conversion; verify actual focus behavior after OS upgrades. Read-only debug inspection checks class, style, first-mouse delivery, sharing type and workspace flags; it does not replace a real click/cursor test.
