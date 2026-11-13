# Small local dictation models and screen sharing privacy

Checked 13 November 2026 for Pace on Apple Silicon. The practical shortlist is Whisper Base or Tiny for the smallest implementation, Moonshine v2 Tiny Streaming for streaming and native custom terms across the four required languages, and Whistle for the smallest English and Spanish model. Recognition quality on this Mac must decide promotion; publisher benchmarks do not establish a reliable dictation default.

macOS does not provide a supported guarantee that an ordinary visible application window stays out of every screen capture. Tauri can request content protection, but the product must describe it as best effort and offer a quick hide action. A successful capture test applies to that OS and capture path, not every conferencing app.

## Three model options

| Option | Download and languages | Native integration and custom words | Decision |
| --- | --- | --- | --- |
| Whisper Base Q5_1 or Tiny Q5_1 | Base **59,707,625 bytes**; Tiny **32,152,673 bytes**. Multilingual checkpoints include EN, ZH, JA and ES. The similarly sized `.en` checkpoints are English only. | Reuses the already bundled whisper.cpp and Metal path. `--prompt` supplies vocabulary context; it is a hint, not guaranteed spelling or model training. Whisper code and weights use MIT. | Lowest integration cost. Evaluate Base before Tiny when accuracy matters; retain Turbo for meeting transcripts. |
| Moonshine v2 Tiny Streaming | **45,398,523 bytes** for current EN assets; ZH **32,290,152**, JA **32,319,961**, ES **32,316,573**. Four separate language packs total **142,325,209 bytes**. | Official C++ core with C and Swift APIs, plus ONNX Runtime. Streaming architectures support actual decoder key-term biasing and replaceable context. Current streaming models are MIT, including these non-English packs. | Most complete small streaming candidate. New runtime and model packaging require native checks; separate packs do not establish reliable code-switching. |
| Cactus Whistle | **16,919,407 bytes**. EN and ES plus German, French, Italian, Dutch and Polish; **no ZH or JA**. | macOS ARM64 runner **1,139,720 bytes** or static library **2,011,832 bytes**; C header exposes transcription, streaming and keyword arguments. Model and runtime are Apache-2.0. | Smallest native candidate found with real keyword biasing. Needs an explicit supported fallback for ZH/JA. |

Whisper sizes and hashes come from the [maintainer's model repository](https://huggingface.co/ggerganov/whisper.cpp/tree/main); language and license scope comes from [OpenAI Whisper](https://github.com/openai/whisper). The application's pinned [whisper.cpp CLI source](https://github.com/ggml-org/whisper.cpp/blob/d2c6f05a46dacf663e357bcf0ed40f542a72825d/examples/cli/cli.cpp) supports `--prompt`, `--carry-initial-prompt` and model-specific DTW presets. A smaller model must change the currently hardcoded `large.v3.turbo` DTW preset to the selected architecture, rather than merely substituting the weights.

Moonshine sizes are sums of the normal files in its [versioned native asset metadata](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/core/moonshine-model-file-metadata.generated.cpp), excluding the optional attention decoder. The [current model table](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/docs/models/available-models.md) lists Tiny Streaming as 34M parameters. Its English benchmark is a floating-point leaderboard average; the shipped quantized assets and non-English evaluation panels are different. Parameter count and download size are not measured working memory.

Whistle was released on 2 October 2026. Its [publisher's model description](https://cactuscompute.com/blog/whistle) documents keyword biasing, 16 kHz audio, windowing beyond 30 seconds and CPU inference. The quoted 11 ms first-token result uses an M4 Pro and an offline ten-second clip; it is not this M1 Pro's microphone-to-paste latency. The [model card](https://huggingface.co/Cactus-Compute/whistle) and [runtime distribution](https://huggingface.co/Cactus-Compute/cactus) specify the licenses and supported native targets.

## Moonshine integration details

The checked source revision is `d8d8fa29d05ca67441a7719e70099f9f48917a93`; the latest published runtime is [v0.1.6](https://github.com/moonshine-ai/moonshine/releases/tag/v0.1.6), published 6 November 2026. Its macOS ARM64 archive is 27,367,977 compressed bytes. That is a distribution size, not final linked application overhead. The core has a C interface and a native ONNX Runtime dependency; inference does not require a Python environment. See [building from source](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/docs/using/building-from-source.md).

The current [Swift package manifest](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/language-bindings/swift/Package.swift) expects a local XCFramework; its alternative remote manifest still points to v0.0.8. Do not combine that old binary with the latest binding sources. Use a matched current release or build the pinned source. The [C++ example](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/examples/c%2B%2B/README.md) includes native macOS library and rpath instructions.

The v0.1.6 tag resolves to the same source revision above; both context setters exist in that release's header. GitHub supplies SHA-256 `809555a4e2c9a6972c0960a4cbf08b95121763ca17bce69f817adaac3b804fd0` for its macOS ARM64 archive. Validate the downloaded archive and exported library symbols before linking.

The [C API](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/core/moonshine-c-api.h) loads a local model directory with `moonshine_load_transcriber_from_files`, accepts float PCM with `moonshine_transcribe_without_streaming`, and exposes streaming operations. The [Swift Transcriber](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/language-bindings/swift/Sources/MoonshineVoice/Transcriber.swift) exposes equivalent methods and `setKeyterms` / `setContext`. Low-level local-file loading avoids automatic network downloads.

For English Tiny, the catalog prefix is `https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_11_02/`. Required normal files are `adapter.ort`, `cross_kv.ort`, `decoder_kv.ort`, `encoder.ort`, `frontend.model.ort`, `frontend.weights.ort`, `streaming_config.json` and `tokenizer.bin`. ZH/ES use `quantized_26_08_24`; JA uses `quantized_26_08_23`. The source metadata supplies expected sizes and CRC32C values. Record SHA-256 hashes of the downloaded files before adding them to Pace's model manifest.

Moonshine's [domain customization guide](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/docs/models/domain-customization.md) supports multiword terms and updates while streaming. The default boost is 2.0; large lists and aggressive boosting can create incorrect terms. Its published biasing measurements use read English and do not prove accuracy for unusual product names or other languages. Swift rejects commas inside individual key terms because the C option uses a comma-delimited list. Keep validation and bounded input at the app boundary.

Sherpa-ONNX is not a transparent substitute for the vendor runtime here: its [hotword documentation](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html) limits hotwords to transducer models with modified beam search. Do not assume a Sherpa Moonshine wrapper inherits the vendor's streaming key-term implementation.

## Other current models

[Earlybird 29M](https://huggingface.co/sahilmahendrakar/Earlybird-29M) appeared on 10 November 2026 and is a useful research lead: 16.8 MB, English only, MIT. Its custom four-bit format currently loads through Python, PyTorch and Transformers 5 or later. It predicts partial words early and revises them more often. The [paper](https://arxiv.org/abs/2611.14421) reports audio-relative word timing, which excludes compute time; this is not end-to-end typing latency. The heavier shipping runtime and lack of a verified native integration make it a poor first implementation for this app.

[NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) has 600M parameters, CC-BY-4.0 licensing and 25 European languages including EN/ES, but no ZH/JA. Its current card links a native NeMo-Speech.cpp path. It is a broader accuracy candidate, not a tiny four-language replacement.

### Additional artifact pins

Whisper's multilingual Base Q5_1 SHA-256 is `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898`; Tiny Q5_1 is `818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7`, from the maintainer repository's LFS metadata.

Whistle model revision `ad73f1468dd5203791e0cc81d31544c553563645`, file `whistle.cact`, has SHA-256 `b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb`. The Cactus runtime's documented v4.0.0 artifact revision is `1a028f5a3972b67dd8d8752f882113d475e7ec4c`; its `releases/4.0.0/macos-arm64/cactus` runner has SHA-256 `39bd925a3759ad3dd18056918feffc82be43a92d4eb2ef5f8baf73a707ee3f3b`. These are metadata checks, not a claim that either binary has run in Pace.

## Screen sharing protection on macOS

[Apple's current NSWindow.SharingType.none documentation](https://developer.apple.com/documentation/appkit/nswindow/sharingtype-swift.enum/none) calls the constant legacy and explicitly tells developers not to rely on it to hide content from capture. The documentation also acknowledges it can suppress content in some sharing situations. This supports a best-effort feature, not either absolute claim that it always works or that it can never work on modern macOS.

[Tauri exposes set_content_protected](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindow.html#method.set_content_protected), but [upstream issue 14200](https://github.com/tauri-apps/tauri/issues/14200) remains open with a macOS upstream-blocked label and reports capture through ScreenCaptureKit. Set the flag before showing each protected window, handle errors, and cover workspace, pet, suggestion and dictation windows. A successful setter call proves only the request succeeded.

[ScreenCaptureKit content filters](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(display:excludingapplications:exceptingwindows:)) are chosen by the application doing the capture. Excluding Pace from Pace's own recording does not tell Zoom, Teams or another recorder to exclude it. Nor does the absence of an app from one window picker prove absence from a full-display recording.

[Cluely's marketing](https://cluely.com/undetectability) makes a broad invisibility claim, while its [own feature guide](https://docs.cluely.com/feature/liveinsights) lists device and capture-mode exceptions. Those statements are not proof that its technique transfers to this Tauri app. Windows has a documented [WDA_EXCLUDEFROMCAPTURE](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity) option on Windows 10 2004 and later; that is a different platform contract, and Microsoft does not describe it as a security boundary.

Suggested setting text: **Reduce visibility in screen sharing**. Supporting text: **Requests capture protection where supported. Some macOS recorders can still show Pace. Test your sharing app, or hide Pace before sharing.** A hide shortcut should actually hide the relevant windows; it should not merely toggle the protection flag.

## Release checks

1. Run the same saved consented or synthetic utterances through Turbo and the candidate: ordinary English, names, custom terms, dates, punctuation, silence and background noise. Include ZH/JA/ES and code-switching where supported. Compare output and inserted text, not just nonempty results.
2. Measure cold load, warm transcription, end-of-speech to final text, microphone-to-paste latency and memory with one model workload at a time. Test network-disabled inference after installation. Synthetic Kiki lines are a useful repeatable check, not evidence of human-accent robustness.
3. Test hotwords both present and absent in the audio. Record wrong insertions as well as correctly recovered names. Keep a deterministic silence check and preserve meeting-specific VAD and word-timing behavior.
4. For capture, place an ordinary colored control window beside a protected Pace window. Capture the complete display using `SCContentFilter(display:excludingWindows: [])`, with no application exclusion. Check an actual `SCStream` recording as well as `SCScreenshotManager`, then toggle protection off and repeat. The control must appear in both tests.
5. Repeat capture with each supported conferencing app's whole-screen and single-window modes; a local preview or self-test needs no message or call to another person. Record OS build, app versions and settings. Recheck after updates. No tested path should be generalized into universal invisibility.

Style examples can remain in the existing SQLite store; the deferred writing feature does not require a new memory model. This note does not select a production dictation model; recognition quality remains an independent acceptance check.

## Native compatibility and capture measurements

The test host reports **macOS 26.6.2, build 25G83**. These results do not establish runtime behavior on macOS 15 or another capture application.

### Moonshine deployment target

Inspecting the published v0.1.6 static archive with `otool -l` found 121 Moonshine and helper objects declaring macOS **26.0**, despite the Swift package's macOS 13 declaration. Its two architecture-specific ONNX objects declare **13.4**. Linking the unmodified archive into a macOS 15 app therefore produces deployment-target warnings; the package declaration is insufficient evidence of compatibility.

The pinned source was rebuilt with `CMAKE_OSX_DEPLOYMENT_TARGET=15.0`, using the existing verified ONNX static library, without compiling ONNX or rewriting Mach-O metadata. The ARM64 result contains 121 objects declaring **15.0** and one ONNX object declaring **13.4**. The archive is 55,484,432 bytes. Its C API exports include key-term setters and `OrtGetApiBase`; a linked native regression check runs on the current host. Actual execution on macOS 15 remains untested.

The reproducible [build helper](../native/scripts/build-moonshine-compatible.sh) pins the source archive, ONNX library and [three-line VAD patch](../native/patches/moonshine-vad-clear.patch). Its output manifest records compiler, input hashes, object deployment targets and the local output hash. The patch changes the VAD's intended buffer clearing from `resize` to `assign`: resizing an already equal-sized vector retains prior probabilities and audio. A [native regression checker](../artifacts/runtime/moonshine-compat-20261113/vad-reset-check.cpp) inspects both restart and speech-end clearing; [the paired result](../artifacts/runtime/moonshine-compat-20261113/vad-reset-check.json) compares the original publisher archive with the patched build.

The complete upstream C API does not compile with its TTS option disabled, so the compatibility build preserves the normal unified runtime. No additional TTS weights are downloaded. Its compiled VCTK reference clips and community-1 parameters are acknowledged alongside the code dependencies in [redistribution notices](../native/licenses/moonshine/README.md).

### Full-display capture probe

The [synthetic probe](../artifacts/runtime/moonshine-compat-20261113/capture-probe.swift) places a blue control window beside a magenta subject and captures the full display with an **empty exclusion list**. It switches the subject's sharing type through protected, unprotected, protected. Both windows close after the probe. Only their center RGBA samples and diagnostic counts are retained; no screenshot, recording file or desktop text is saved.

| Capture path | Protected | Unprotected | Protected again | Control |
| --- | --- | --- | --- | --- |
| SCScreenshotManager | Subject color absent | Subject color present | Subject color absent | Blue present throughout |
| SCStream | Subject color absent | Subject color present | Subject color absent | Blue present throughout |

The stream provided 27, 32 and 30 complete frames in the three phases; the sampled latest frame in each matched the expected transition. The protected subject remained listed in ScreenCaptureKit's shareable-window metadata. [Raw center samples](../artifacts/runtime/moonshine-compat-20261113/capture-probe.json) preserve the measurements. This verifies exclusion of the sampled center on these two local capture paths. It does not inspect every pixel, establish Tauri-specific window behavior, test Zoom/Teams/Meet, or override Apple's documented lack of a reliable capture-prevention guarantee.
