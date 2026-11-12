# Pace native worker

Apple Silicon, macOS 15+. Build with `./native/build.sh` using Xcode and Swift 6.2 or newer. The script downloads the Xcode Metal toolchain when missing and builds pinned, static whisper.cpp transcription and Silero detection executables. Swift package revisions are locked in `PaceNative/Package.resolved`.

Ship **all of `native/bin`, `native/lib`, and `native/share`**, preserving the Metal `.bundle` directories beside `PaceNative`. The native worker and its required resources run without a Python installation. The NeMo diarization bootstrap is documented in its accompanying scripts.

The build uses `swift-stdlib-tool` to copy required Swift compatibility libraries beside the helper, so the packaged app does not depend on an installed Xcode toolchain. Pinned Swift dependency and embedded-component notices are collected into `native/licenses/swift-packages`; ship `native/licenses` too.

The worker reads JSON lines from stdin and writes only JSON lines to stdout. Diagnostics go to stderr. Requests run concurrently; MLX generation rejects a second simultaneous inference with `busy`. Capture, status and cancellation remain responsive during generation and downloads.

```json
{"id":"status","method":"models.status","params":{}}
{"id":"install","method":"models.install","params":{"id":"qwen3.5-4b"}}
{"id":"chat","method":"chat.generate","params":{"messages":[{"role":"user","content":"Say hello in one sentence."}],"maxTokens":64}}
{"id":"voice","method":"voice.speak","params":{"text":"Hello! I am Pace.","language":"English","voice":"Ono_Anna","play":false}}
{"id":"asr","method":"audio.transcribe","params":{"path":"/absolute/path/mono-16khz.wav","language":"en"}}
```

Replies are `{id,result}` or `{id,error:{code,message}}`. Events are `{event,data}`; `data.requestId` identifies the request. Events include `models.progress`, `runtime.loading`, `chat.delta`, and `voice.generating/ready/started/stopped`. `runtime.cancel` accepts `params.id` to cancel a request, or cancels all model/download/transcription requests when omitted. `voice.stop` cancels speech generation and playback.

Models install **only when explicitly requested**. Downloads pin a Hugging Face revision, resume partial files and verify every file against SHA-256 (LFS) or Git blob SHA-1 (small files) before marking the model installed. Installed metadata and required file sizes are checked before inference; generation uses local directories. Resuming an install reuses its pinned revision. `models.status` lists the available model ids.

Default storage is `~/Library/Application Support/Desktop Pets`. `PACE_DATA_DIR` overrides this root; `PACE_MODELS_DIR` overrides the models directory; `PACE_BIN_DIR`, `PACE_WHISPER_BIN`, `PACE_VAD_BIN`, and `PACE_DIARIZE_BIN` select the bundled native binaries. Model weights, transcripts and generated audio are never uploaded. Hugging Face is contacted only during installation.

`whisper-turbo` includes a pinned, checksum-verified Silero VAD model. Existing installations upgrade through the same install action and reuse the Whisper weights. Transcription fails clearly if the detector is unavailable. Silero skips speech-free windows and selects separate regions with one second of original context on both sides. Overlapping regions merge; separate utterances decode independently, with their original absolute offsets. Audio longer than 30 seconds uses 28-second cores with one second of original context on each side, retaining absolute DTW word timestamps and one owner per boundary word. Native DTW alignment requires disabling Whisper flash attention; CJK text is emitted in token units. Audio is never concatenated to remove silence. This limits silent-window hallucinations with generous context beyond detector boundaries; it does not establish accuracy for every real microphone, accent or background noise.

`chat.generate` accepts an optional strict Boolean `precise`. When true it uses greedy generation (temperature 0) for factual extraction; the default retains temperature 0.7. This improves repeatability without guaranteeing factual accuracy.

Text context is bounded to 8K tokens with at most 2048 new tokens. Speech accepts up to 1500 characters and ten supported Qwen languages. The 0.6B model uses named presets; it does not promise instruction-based emotional control. `pitch` (0.75–1.5), `rate` (0.5–1.5), and `volume` (0–1) customize local playback; defaults are 1.05, 1, and 0.65. `play:false` returns an unmodified WAV for inspection without playing sound.

Run `swift test --package-path native/PaceNative -c release -j 6` for model-boundary and bridge tests. Hardware inference evidence belongs in `docs/native-validation.md`; unit tests do not establish model quality, meeting accuracy, or microphone/screen-capture permissions.
