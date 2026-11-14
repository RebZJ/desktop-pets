# Qwen3-ASR 1.7B provenance

- Original model: [Qwen/Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B/tree/7278e1e70fe206f11671096ffdd38061171dd6e5), Apache-2.0 as declared in its model card.
- Converted weights: [ggml-org/Qwen3-ASR-1.7B-GGUF](https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/tree/36a678687ba7d07a74ca70ccb0e36902e005fb80), decoder and audio projector Q8_0. Exact sizes and SHA-256 are pinned in `native/portable-models.json`.
- Apache-2.0 text is already bundled at `native/licenses/Qwen-Apache-2.0.txt`.
- Inference: existing MIT llama.cpp runtime; no Python package or hosted model is required. Conversion changes the weight representation, not the model identity.
