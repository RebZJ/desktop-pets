# Active local model selection

The current product has three jobs: dictation, diarized meeting notes and transcript-grounded meeting assistance. These models preserve that scope across the portable Rust runtime. There is no active general chat, voice-reply or writing model flow. Earlier downloaded MLX/voice files and preferences are retained.

| Job | Selected local artifact | Exact download bytes |
| --- | --- | ---: |
| English dictation | Moonshine Tiny streaming English | 45,398,523 |
| Chinese dictation | Moonshine Tiny streaming Chinese | 32,290,152 |
| Japanese dictation | Moonshine Tiny streaming Japanese | 32,319,961 |
| Spanish dictation | Moonshine Tiny streaming Spanish | 32,316,573 |
| Auto dictation / meeting transcription | Whisper large-v3-turbo Q5_0 plus Silero v6.2 VAD | 574,926,293 |
| Speaker labels | Nemotron 3 Diarization Q8_0 | 107,012,128 |
| Meeting notes / copilot | Qwen3.5 4B GGUF Q4_K_M | 3,032,091,584 |

`native/portable-models.json` is the executable source of truth for repository revisions, filenames, URLs, byte counts and SHA-256. Installs happen only after an explicit request. Models do not download on launch and are not bundled in installers. The GGUF text model uses `models/qwen3.5-4b-gguf`, preserving an earlier `models/qwen3.5-4b` MLX installation.

Moonshine's C ABI provides the explicit EN/ZH/JA/ES dictation path. Whisper and Silero handle automatic-language dictation and meeting speech with original timing. NeMo-Speech.cpp labels speakers without identifying their names. llama.cpp serves the shared 4B text model through an authenticated loopback child owned by Rust; users run no external server.

The portable Qwen artifact comes from [ggml-org's pinned conversion](https://huggingface.co/ggml-org/Qwen3.5-4B-GGUF/tree/8d43d974efc48399cb58957ad49c8b26bf5a109c). The app bounds context to 8K tokens and generation to 2048 new tokens, disables thinking, and uses greedy generation for factual extraction. Those controls and successful fixtures do not guarantee factual accuracy or establish superiority over other models.

The development Mac passed actual prerecorded speech and text runtime checks; see [portable validation](portable-native-validation-2026-11-14.md). Windows/Linux execution, real-device accuracy, accents/noise, overlap-heavy diarization and comparative model quality remain unverified. Download size is not peak working memory. Review actions and deadlines against the original transcript.
