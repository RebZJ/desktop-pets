# Portable Kitten voice notices

Kitten Micro 0.8 weights and voice embeddings are Apache-2.0, published by KittenML at revision `1ccf72b2c2048fd17efac7de2fab32d10e225084`. `model-card.md` is the unmodified pinned model card. Exact model sizes, SHA-256 and download URLs are in `native/portable-models.json`. The model download is 44,663,872 bytes and uses a separate directory from legacy MLX weights.

Rust inference uses `kittentts` 0.4.1 (Apache-2.0) without its optional eSpeak feature. ONNX Runtime is reused from the existing Moonshine bundle; its license and third-party notices remain under `native/licenses/moonshine`.

English pronunciation uses `piper-plus-g2p` 0.5.4 (MIT) with only `english` and `bundled-dicts`. Its CMU dictionary has the BSD-style terms preserved in `piper-plus-data-NOTICES.md`. This product includes data from the Carnegie Mellon Pronouncing Dictionary, which is freely available at <http://www.speech.cs.cmu.edu/cgi-bin/cmudict>.

No eSpeak or GPL phonemizer is linked. Unknown English names use the CMU engine's spelling fallback. Voice identity is the original Kitten Kiki embedding, while the English pronunciation front end differs from the historical MLX Misaki implementation.
