# Local model selection

Research checked **13 November 2026** against publisher model cards and repositories. This is a practical selection for the current Apple Silicon, 16 GB Mac prototype. It is not an exhaustive leaderboard or a claim that the shipped models are the newest or highest quality in every task. The app's actual checks are recorded in [native validation](native-validation.md); alternatives below have not been benchmarked inside Desktop Pets.

## Shipped pack

| Job | Selected artifact | Approximate download | Why it is here |
| --- | --- | --- | --- |
| Chat, writing, memory answers, notes and tips | [Qwen3.5-4B, MLX uniform 4-bit](https://huggingface.co/mlx-community/Qwen3.5-4B-4bit) | 3.06 GB | One shared text model, with the current native runtime and real four-language checks. |
| Spoken replies | [Qwen3-TTS 0.6B CustomVoice, MLX 8-bit](https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit) | 1.97 GB | Preset voices and English, Mandarin, Japanese and Spanish in one local engine. |
| Dictation and meeting transcription | Whisper large-v3-turbo Q5, plus Silero VAD | 575 MB | Existing native whisper.cpp integration, speech gating and word timing. |
| Anonymous speaker labels | Nemotron 3 Diarization Q8 | 107 MB | Small separate diarizer, up to eight speakers, through native NeMo-Speech.cpp. |

The total is about 5.7 GB, excluding runtime/application files. Download size is not peak working memory. Text/voice generation is serialized, voice is unloaded for meetings, and long transcripts are summarized in bounded passages. Installs save the resolved model revision and verify files; model licenses remain separate from the application's MIT license.

## Text: quality within a small budget

**4B is relatively small, not the tiniest option.** Qwen publishes [0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B), [2B](https://huggingface.co/Qwen/Qwen3.5-2B) and [4B](https://huggingface.co/Qwen/Qwen3.5-4B) checkpoints under Apache-2.0. Its cards include instruction-following and multilingual evaluations. Our engineering judgment is to spend more of the budget on a single text model because preserving names, dates and decisions matters across several features. Those upstream evaluations do not establish the quality of our quantized package or prove it beats the smaller models on these tasks.

Current alternatives worth a controlled comparison:

| Candidate | Relevant tradeoff |
| --- | --- |
| Qwen3.5 0.8B / 2B | The most direct candidates for a lighter preset. Require the same multilingual writing, factual recall and notes checks before replacing 4B. |
| [Gemma 4 E2B / E4B](https://ai.google.dev/gemma/docs/core) | Current Google edge models with system prompts, function calling and multimodal input. “Effective” parameter counts differ from total stored weights; Google documents separate memory estimates for different quantizations. This prototype has not validated their Swift runtime path. |
| [Liquid LFM2.5-1.2B](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct) and newer [LFM3-1.7B](https://huggingface.co/LiquidAI/LFM3-1.7B) | Both cover the initial four languages. LFM3 targets local agents/structured outputs and advertises about 1 GB at 4-bit; its card cautions against complex multi-step reasoning. Separate LFM license and runtime validation are required. |

Newer family names alone are insufficient: the current [Qwen publisher listing](https://huggingface.co/Qwen/models) includes larger Qwen3.8 releases, which do not automatically replace a 4B laptop choice.

## Voice: cute, multilingual and offline

[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) publishes 0.6B/1.7B variants and ten languages, including all four launch languages. Pace currently uses named voices and local pitch/rate/volume processing. It does not ship voice cloning or promise reliable emotional instruction control. Publisher streaming latency claims are not measurements of this Mac app.

[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) is a much smaller Apache-licensed candidate. Its [voice catalog](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md) includes Mandarin, Japanese and Spanish, with uneven publisher quality grades and language-specific front ends. It should be auditioned rather than rejected solely on parameter count.

[KittenTTS](https://github.com/KittenML/KittenTTS) now includes **Kitten-TTS 2**, a 1.7B, 1-bit multilingual model, alongside 15M–80M legacy CPU models. Its listed 492 MB speech model is not the complete runtime/decoder footprint. Kitten-TTS 2 is a current candidate for reducing downloads; it has not been integrated or compared here. Human preference for Pace's voice remains unverified.

## Speech recognition and speakers

[Whisper's publisher](https://github.com/openai/whisper) describes turbo as an 809M optimized large-v3 model for faster transcription, with some accuracy tradeoff. It is not a diarizer. Our selection favors the implemented native path and timing checks, rather than a claim of current ASR superiority.

Two newer alternatives cover the initial languages: [Qwen3-ASR 0.6B / 1.7B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B), with a separate forced aligner for timestamps, and [Nemotron 3.5 ASR Streaming 0.6B](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b), with cache-aware streaming and native NeMo-Speech.cpp support. NVIDIA places Mandarin in its broad-coverage tier and English/Japanese/Spanish in transcription-ready tiers. [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) covers English/Spanish but its 25-language list excludes Mandarin/Japanese. No publisher GPU throughput number establishes local Mac latency.

[Nemotron 3 Diarization](https://huggingface.co/nvidia/Nemotron-3-Diarization) is a 100M model with eight speaker channels under OpenMDW-1.1. NVIDIA's older [four-speaker Sortformer card](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1) points to it as the newer version. [Pyannote Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) remains a strong comparison candidate with exclusive diarization and offline use, but its documented setup requires accepting access conditions, a Hugging Face token and Python. The shipped native path avoids those user setup steps. Labels describe who spoke when; they do not identify people.

Before changing defaults, compare these candidates on the same consented four-language meetings: factual edits/notes, WER or CER, diarization error, timestamp alignment, silence, latency, memory and a human voice audition. Synthetic fixture success is evidence that the pipeline runs, not a comparative quality benchmark or a real-microphone accuracy guarantee.
