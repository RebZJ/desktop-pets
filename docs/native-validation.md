# Native inference validation — 13 November 2026

Historical implementation/research record. For the current three-feature portable architecture and its verified limits, see [portable validation](portable-native-validation-2026-11-14.md).
Test machine: Apple M1 Pro, **16 GB unified memory**, macOS 26.6.2. Native target: Apple Silicon, macOS 15+. No cloud inference or simulated model responses were used.

## Build and model pack

The Swift release build and **21 native tests passed**. The tests cover model-file checksums and corruption, path traversal, voice-language validation, legacy Whisper install upgrades, DTW timestamp units and Unicode grouping, partial WAV reads, window-boundary ownership, plus the bridge/capture fixtures. `native/build.sh` passes Bash syntax validation. The full build required installing the missing Xcode Metal Toolchain, then succeeded with MLX Swift 0.33.0. The native helper and Metal/resource bundles are copied to `native/bin` and ad-hoc signed for local development.

Installed models were downloaded using the actual resumable, checksum-validating ModelStore implementation:

| Model | Repository revision |
| --- | --- |
| Qwen3.5 4B uniform 4-bit MLX | `0e7ffd5c629ef7719d4cbc04069232580bfa9d9c` |
| Qwen3 TTS 0.6B CustomVoice 8-bit MLX | `049ef77fe8816b536193c0c25f9a214d17921282` |
| Whisper large-v3-turbo Q5_0 | `5359861c739e955e79d9a303bcbc70fb988958b1` |
| Silero VAD v6.2.0 | `9ffd54a1e1ee413ddf265af9913beaf518d1639b` |

The default model directory is `~/Library/Application Support/Desktop Pets/models`. Each model has a pinned manifest and installation marker; model weights are not committed to the source repository.

The text runtime uses mlx-swift-lm commit `6352907543270ae9c61fcaf59cb3e07b0b989ea1`; voice uses mlx-audio-swift v0.1.8. The native whisper.cpp CLI was built from `d2c6f05a46dacf663e357bcf0ed40f542a72825d`, statically linked with embedded Metal kernels and a macOS 15 deployment target. NeMo diarization runtime/model verification is recorded by the accompanying diarization scripts and evidence.

## Actual inference

Initial cold text-model loading and a short response took **13.44 s**, returning “Hi there, I'm Pace! 🐾”. Initial English TTS loading and generation took **14.35 s** for a **5.84 s, 24 kHz** WAV. Whisper transcribed the 11-second JFK fixture correctly in **10.69 s**. These are individual observed runs, not a statistical benchmark; the first native test build was also running on this machine.

Further checks launched the native worker under macOS `sandbox-exec` with **all network access denied**. Real chat, TTS and ASR continued to work. Warm English voice generation took **5.54 s** for **4.88 s** of audio. Whisper returned eight word segments in **1.81 s**, reproducing “Hello, I am Pace, your little desktop friend.”

The same `Ono_Anna` preset also generated Mandarin, Japanese and Spanish locally. Whisper round-tripped their content successfully:

| Language | Generation time | Audio duration | Example recognized text |
| --- | --- | --- | --- |
| Mandarin | 5.13 s | 4.24 s | 你好，我是佩斯，你的桌面小伙伴 |
| Japanese | 4.90 s | 6.80 s | こんにちは私はペースあなたの小さなデスクトップの友達です |
| Spanish | 3.46 s | 4.48 s | Hola, soy Pace, tu pequeño amigo del escritorio. |

Samples and raw evidence are under `artifacts/runtime/native`: `pace-en.wav`, `pace-zh.wav`, `pace-ja.wav`, `pace-es.wav`, `results.json`, `checks.json`, `checks-events.jsonl`, and `word-asr-seconds.json`. ASR agreement checks intelligibility; it does not establish whether a human finds the voice cute or likes its accent/prosody.

## Factual generation mode

`chat.generate` now accepts the optional strict Boolean `precise`. True selects greedy decoding (temperature 0); omitted/false retains the existing temperature 0.7. The 21-test release suite rejects numeric JSON 1, strings, null and other non-Boolean values. The actual network-denied helper check also rejected numeric/string values, then generated two separate factual tasks in 3.38 seconds: release notes due Friday and tutorial with no agreed deadline. Evidence is `artifacts/runtime/native/precise-check.json`. Greedy decoding improves repeatability; it does not guarantee factual accuracy.

## Silence and long-gap regression

A real integration check found Whisper hallucinating “Thank you.” on three seconds of digital silence. The transcription pack now includes the **885,098-byte Silero VAD v6.2.0** model with SHA-256 `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`. Existing installations upgrade through the same explicit install action, retaining their original Whisper revision and weights.

The native worker runs the official whisper.cpp speech detector first, with threshold 0.2 and 800 ms speech padding. It adds 200 ms more context, merges overlapping regions and decodes each padded region independently from its **original audio**. Speech-free windows are skipped. Separate decoding also avoids Whisper collapsing repeated utterances across a pause into one phrase; each region retains its absolute offset. The CLI's speech concatenation path was rejected after actual tests clipped words and stretched timestamps across removed silence. Long audio uses 28-second cores and one second of context on either side; WAV frames are accumulated because AVAudioFile can return partial reads before EOF. Each boundary word has one owner.

Ordinary Whisper word offsets also spread leading words across silence. The worker therefore enables the native `large.v3.turbo` DTW preset with flash attention disabled, grouping real DTW token alignment points into words (or CJK token units). Word offsets retain the original recording timeline. These remain model-estimated alignments rather than ground-truth forced alignment.

`native/scripts/test-vad.py` passed with all network access denied:

- Three seconds of zero PCM, ten seconds of a 440 Hz tone, and five seconds of seeded white noise each returned no words, without running Whisper.
- English at 10% amplitude preserved the complete phrase. Full English, Mandarin, Japanese and Spanish phrases survived VAD plus DTW.
- Two utterances separated by **65 seconds of silence** both survived; the silent middle window was skipped and the second utterance retained its original offset.
- Two identical phrases separated by a five-second pause inside one window both survived independently, with the first final word ending before the pause.
- Speech crossing a 28-second core boundary retained the full phrase and one “Hello”.

Observed complete speech calls took 2.0–2.6 seconds for the short language fixtures; the 79.76-second long-gap fixture took 4.52 seconds. A standalone Japanese DTW CLI check reported about 831 MB peak memory footprint. These are individual synthetic runs on this machine, not microphone-noise, accent, performance or diarization benchmarks. Raw results are `artifacts/runtime/vad/gate-results.json`, `gate-summary.json` and `swift-tests.log`.

## Behavior checks

`native/scripts/test-inference.py` passed with actual installed models and network access denied. It verifies short chat, generated speech, local speech-to-text, fine-grained timestamps, rejection of excessive output budgets, rejection of a latest Chinese message exceeding the 8K context, and removal of old history while retaining system instructions and the latest request.

It also confirms that `runtime.status` responds while a real generation is busy, `runtime.cancel` aborts that generation, and `voice.stop` clears the cached TTS model. The final word-timestamp contract returns positive-duration `start`/`end` seconds and compatible `startMs`/`endMs`; zero-duration tokens merge into adjacent timed text without inventing times or dropping words.

To reproduce after model installation:

```sh
swift test --package-path native/PaceNative -c release -j 6
python3 native/scripts/test-inference.py
python3 native/scripts/test-vad.py
```

This evidence does not establish live meeting diarization accuracy, long-call thermal behavior, third-party screen-sharing exclusion, microphone/screen permissions, or artistic voice approval. Those require their own integration or human checks.

## Distribution files

Ship the helper with its `.bundle` directories, `whisper-cli`, `whisper-vad-speech-segments`, the NeMo binary and dylibs, and the notices under `native/licenses` and `native/share`. The native model/runtime licenses are separate from the application license. Local ad-hoc signing is not Apple notarization; release signing and notarization remain part of public distribution.
