# Selectable Qwen3-ASR and meeting audio overlap

## Recognition

Settings → Listening & typing → Speech recognition chooses Auto, Moonshine, Whisper Turbo, or Qwen3-ASR 1.7B for dictation, voice chat, and meetings. Explicit selection never silently substitutes a different engine. Auto preserves existing behavior: a supported installed Moonshine pack for dictation/voice, Whisper for meetings. Meeting language remains separately selectable; Moonshine requires an explicit supported language.

The 1.7B Q8_0 pack is pinned to [ggml-org revision 36a6786](https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/tree/36a678687ba7d07a74ca70ccb0e36902e005fb80). Decoder plus audio projector total 2,520,744,288 bytes, with exact hashes in `native/portable-models.json`. [Original Qwen model](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) provenance and Apache-2.0 notice are bundled under `native/licenses/`.

The existing [llama.cpp audio runtime](https://github.com/ggml-org/llama.cpp/blob/ae93877c8f3bf9f39f0ee4ffb3ef1697c416a7c3/docs/multimodal.md) runs an authenticated loopback ASR child separate from chat. There is no cloud inference, Python runtime, agent integration or new OS bridge. Recording starts before model warmup. A cold model can still take seconds to load; audio is already being captured. Qwen returns actual audio-window or diarized-turn bounds, not word alignment. Final meeting recognition uses speaker turns before ASR; overlapping mono turns cannot separate two simultaneous voices.

A single requested model trial used an existing synthetic Kiki clip, with no microphone, speaker playback or private meeting. The pinned runtime loaded in 11,912 ms and transcribed the clip in 985 ms: “Hello, I am Pace, your little desktop friend. What would you like to talk about?” This is a model/runtime result on one Mac, not a general accuracy or latency benchmark.

## Why the meeting appeared twice

System audio captures the remote call directly. With speakers instead of headphones, the microphone can capture the same remote voice through the room. Previously, the live path called all microphone speech “You” and all computer audio “Speaker 1”; finalized diarization clustered each track independently and appended both transcripts. A track source was being mistaken for a speaker identity, and repeated captures were counted twice.

Speaker IDs now remain track-scoped and separate from source badges. Unidentified voices stay unidentified; renaming one unknown passage does not rename everyone on that track. Independent “Speaker 1” clusters across tracks are not declared the same person.

## OpenWhispr reference

Reviewed [OpenWhispr f178fa9](https://github.com/OpenWhispr/openwhispr/tree/f178fa9fc359a44f43d3e2929dc560198e8addb9):

- [AEC processor](https://github.com/OpenWhispr/openwhispr/blob/f178fa9fc359a44f43d3e2929dc560198e8addb9/native/meeting-aec-helper/src/aec_processor.cc) feeds computer audio as the WebRTC reverse stream before processing microphone audio.
- [Echo evidence](https://github.com/OpenWhispr/openwhispr/blob/f178fa9fc359a44f43d3e2929dc560198e8addb9/src/helpers/meetingEchoLeakDetector.js) considers reference correlation and timing.
- [Microphone holdback](https://github.com/OpenWhispr/openwhispr/blob/f178fa9fc359a44f43d3e2929dc560198e8addb9/src/helpers/meetingMicHoldback.js) delays risky mic results, but audio similarity alone does not discard them. Double-talk can have strong correlation while containing real local speech.

Pace holds dual-source microphone passages briefly while system transcription catches up. Long, unique, time-aligned normalized matches can span system segment boundaries. Matching passages receive non-destructive `duplicateOf` metadata and are hidden from the default transcript, notes, and copilot context. “Show echoes” and exports retain original recognized words. Short replies, ambiguous repeated phrases, or microphone passages with extra local words remain visible. This conservative transcript handling alone is not acoustic echo cancellation. Before recognition and diarization, Pace also uses the pinned portable [aec3 Rust port](https://github.com/RubyBit/aec3-rs/tree/f999860f91998daeb6d051e6076eaff629356469) to feed time-aligned computer audio as the render reference and process microphone audio in 10 ms frames. Live chunks use up to one second of earlier captured audio to warm the adaptive filter. Processing streams into a temporary derivative with the same duration; raw tracks are untouched. Missing reference coverage or processing failure keeps raw input and records the reason. The transcript check remains necessary for residual echoes and uncertain audio. AEC can affect speech quality, and this change has not been calibrated in a physical room.

## Validation boundary

The user requested merging without another test run. Test suites were not executed for this change; production/compiler checks and the single requested Qwen inference trial are reported separately. Regression cases are included for future runs. No new live headphone-free meeting, Windows/Linux audio hardware, physical shortcuts or native insertion was exercised. Existing models and conversations remain intact.
