# Continuous local voice session validation — 2026-11-14

Implemented `voicechat.start`, `voicechat.stop`, `voicechat.current`, `voicechat.state` and `voicechat.level`. Start requires an explicit user action; model installation remains explicit. A session owns one shared microphone capture at a time. Each detected turn is transcribed by the existing local ASR, answered through the shared chat/meeting helper, spoken with Kitten, and followed by another microphone turn. Speech generation and playback complete before listening resumes.

The first implementation is half duplex. It has no acoustic echo cancellation and cannot hear interruptions while replying. Endpointing uses the capture callback's actual RMS, an adapting quiet-noise floor, at least 250ms speech, 900ms silence and a 60-second turn bound. Noise/click tests and capture exclusivity tests pass; conversational timing in real rooms is not established. Missing callbacks are distinguished from true digital silence using the consumed PCM frame count.

Session epochs suppress late ASR/LLM/playback results. Per-session snapshot sequences suppress delayed start RPC snapshots. Bounded cancellation tombstones cover End arriving before the corresponding Start is dispatched; a cancelled voice request is checked again after waiting for the generation slot. Stop, close/hide and shutdown invalidate the session and release audio. Voice turns are removed after successful transcription or explicit cancellation; capture/ASR failures preserve audio and include its path. No model downloads occur in the voice session.

## Selected portable voice

The existing MLX-only Micro model cannot run in the slim native helper. The official Kitten Micro 0.8 ONNX checkpoint runs through Rust `kittentts` 0.4.1, reusing the ONNX Runtime 1.23 API already shipped with Moonshine. No additional ONNX runtime or Python interpreter is bundled.

- Model ID/directory: `kitten-tts-micro-0.8-onnx`, separate from existing legacy MLX files.
- Official checkpoint: [KittenML/kitten-tts-micro-0.8](https://huggingface.co/KittenML/kitten-tts-micro-0.8/tree/1ccf72b2c2048fd17efac7de2fab32d10e225084).
- Total download: 44,663,872 bytes. Exact file SHA-256 and URLs are checked into `native/portable-models.json`.
- Original voice embeddings, including default Kiki, are preserved.
- English G2P: `piper-plus-g2p` 0.5.4, MIT, with the BSD-style CMU dictionary. Unknown names can be spelled. This differs from historical MLX Misaki pronunciation; it is not a claim of identical audio.
- The optional GPL eSpeak feature is disabled. Kitten, G2P and dictionary notices ship under `native/licenses/kitten`.

Official [Kitten documentation](https://github.com/KittenML/KittenTTS) identifies the Micro ONNX checkpoint and Kiki preset. [NeMo-Speech.cpp's supported models](https://github.com/NVIDIA/NeMo-Speech.cpp) do not include Kitten; its bundled build disables TTS, so it was not substituted. [kittentts Rust source](https://github.com/eugenehp/kittentts-rs) supplies ONNX/NPZ inference; [piper-plus G2P](https://github.com/ayutaz/piper-plus) supplies English IPA without eSpeak.

## Actual inference evidence

Ran `voice::tests::actual_kiki_fixture` against the pinned files in `/tmp/pace-kitten-fixture`, with the real bundled Moonshine library and installed English ASR weights. No microphone or speaker was opened. Output copies are under `artifacts/runtime/portable-voice-20261114/`.

Input: “Hello! I am Pace, your little desktop friend. What would you like to talk about?”

Kitten generated 5.4666 seconds of nonempty, finite, nonsilent 24kHz PCM. The synthetic fixture was converted to mono 16kHz PCM for the actual Moonshine dictation path. Moonshine recognized: “Hello, I am Pace, your little desktop friend. What would you like to talk about?”

One observed cold test process, including TTS and ASR, finished in 1.94 seconds (1.96 seconds wall time under `/usr/bin/time`). ASR took 132.6ms with 142.7ms model load. Maximum RSS was 415,465,472 bytes; peak reported memory footprint was 340,231,032 bytes. Those figures include the Rust test host, Kitten and Moonshine, and exclude the Qwen model; they are not live full-conversation latency or memory measurements.

Reproduce after explicitly obtaining the pinned model files:

```sh
PACE_KITTEN_FIXTURE=/tmp/pace-kitten-fixture \
PACE_KITTEN_ASR_MODEL_ROOT='/path/to/existing/models' \
cargo test --manifest-path src-tauri/Cargo.toml --lib \
  voice::tests::actual_kiki_fixture -- --ignored --nocapture
```

`PACE_KITTEN_FIXTURE` must contain the `kitten-tts-micro-0.8-onnx/` directory. Set `PACE_ORT_FIXTURE` to the bundled ONNX runtime library when running off macOS ARM64. Omitting `PACE_KITTEN_ASR_MODEL_ROOT` checks synthesis alone.

Not checked: real microphone/speaker sessions, echo behavior, playback device switching, human Kiki quality review, Windows/Linux hardware or native installers. This change uses portable Rust/CPAL APIs and existing Moonshine runtime assets; the newly added TTS path still needs the platform CI matrix and live hardware validation.

## Installed pack and actual app backend

The 44,663,872-byte portable Kitten pack is now installed in the user's normal shared model directory, `~/Library/Application Support/Desktop Pets/models/kitten-tts-micro-0.8-onnx/`, including the canonical `.installed.json` marker. The existing 13 legacy MLX files retained their sizes and modification timestamps.

A fresh isolated debug host used a separate database under `/private/tmp/pace-voice-bundle-khi1nr5g/profile` and the normal shared model root. Its real `models.install` route verified both cached pinned files and wrote the marker; `models.status` reported installed. The first native HTTPS request failed before downloading, so the previously downloaded exact SHA-256-verified fixture files were staged first. This verifies the canonical installer's existing-file verification and marker path, rather than claiming the native HTTPS download succeeded.

Through the app's real `voice.speak` route, Kiki produced 179,400 frames of mono 24kHz PCM (7.475 seconds) in 1,944ms from a cold voice model, with `play:false`. The actual route chunks the input into sentences; it therefore differs from the earlier single-chunk inference fixture. Output is `artifacts/runtime/portable-voice-20261114/kiki-backend-installed.wav`, with details and checksums in `installed-backend-results.json`.

No microphone or speaker was opened. The isolated host exited with code 0 and its process group was empty afterward. The original installed app process remained running; its database and app bundle were not used for this test. Launching the temporary host through `/tmp` initially failed because Tauri rejects symlinks in a macOS executable's original path; the resolved `/private/tmp` path worked without code or permission changes.

## Final integration checks

The final browser contract suite passed 91 Chromium and 91 WebKit tests. Rust passed 100 tests with five explicit model/runtime fixtures ignored in the ordinary suite; the Kitten/Moonshine fixture above was run separately. Coverage includes capture ownership, endpointing, stale events, same-context chat reopening, quiet pet earcons during conversation and session cancellation. These browser fixtures use synthetic events, not a microphone.

End invalidates the session immediately, finalizes its microphone capture before runtime cancellation, and bounds each scoped cancellation request to 250ms. The owner gets two seconds to finish; a stalled owner is then aborted and joined, releasing its process/lock guards before a replacement session starts. A regression uses a deliberately stalled task holding a mutex and a drop marker to verify cleanup; a second verifies healthy owners are not aborted.

A real isolated app host also rejected `voicechat.start` after its command window was hidden, leaving voice inactive, capture idle and no new audio file. Native desktop inspection and a live microphone/speaker conversation remain blocked by the locked Mac. No OS permission reset or new grant was requested.

## Follow-up after the Mac was unlocked

The installed signed app's little Chat button opened the native bubble, and Start reached real microphone capture, English recognition and a local generated reply. End returned the bubble to Start; a read-only process/file check found no open WAV handles or remaining voice-turn WAV files. Two message IDs were added and none removed. No transcript bodies or recordings were retained in the validation artifacts.

Native settings navigation, campsite routing, send-home and summon controls responded. Opening the rebuilt chat remained passive and closing it returned to the pet. Kiki's physical audibility and automatic listening resumption still await the user's listening confirmation. Synthetic Quick Hide key injection did not establish a physical shortcut result, so that check remains unverified. The existing bindings and OS grants were left unchanged.

The check exposed an empty-dictation status bug: blank recognition was marked as a copyable draft. Both normal completion and saved-audio retry now share terminal-state construction that reports an error for empty/whitespace text. Recognized drafts, insertion warnings and existing recovery behavior are preserved. The fix passed 102 Rust tests (five explicit fixtures ignored) and a new browser regression in Chromium and WebKit. The signed fix was installed with the same signing requirement; exact settings, document and message-ID baselines matched after replacement. No new meeting was recorded during this follow-up.

Core voice commit `2f57802` passed interface checks, Rust tests and bundled native runtime build/smoke checks on all three desktop CI hosts: [Windows, macOS and Linux run](https://github.com/RebZJ/desktop-pets/actions/runs/43491187839). This does not establish live Windows/Linux audio-device behavior.
