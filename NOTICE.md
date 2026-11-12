# Attribution and third-party components

Application code is MIT licensed. The original Pace mascot artwork, including the app icon and twelve strips under `public/pets/pace`, is **CC BY 4.0**: credit **Outpaced / Desktop Pets**, link to the project and the [license](https://creativecommons.org/licenses/by/4.0/), and identify changes. Its original source name was Velo. The source artwork revision is `84a38c2879b08a2b298b523d2670c44d45d18739` in Outpaced. This repository reuses that artwork with the owner's permission.

The six original procedural critter sounds are also CC BY 4.0, credited to Desktop Pets. Their deterministic generator is MIT licensed.

Model weights are downloaded separately and retain their own licenses:

- Qwen3.5 and Qwen3-TTS: Apache-2.0. Notices are included in the installed models and `native/licenses/Qwen-Apache-2.0.txt`.
- Whisper / whisper.cpp and Silero VAD: MIT. The VAD model is installed with Whisper; its notice is in `native/licenses/Silero-VAD.txt`.
- Nemotron-3 Diarization: OpenMDW-1.1; consult the pinned model's license before redistributing weights.
- NeMo-Speech.cpp runtime: Apache-2.0, with its bundled third-party notices under generated `native/share/licenses`.
- MLX Swift, MLX Swift LM and MLX Audio Swift: MIT. Hugging Face and tokenizer components retain their respective MIT/Apache notices in `native/licenses`.
- Pinned Swift transitive dependencies and MLX's embedded native components retain their original notices in `native/licenses/swift-packages`, preserving upstream paths. Apple's required Swift compatibility runtime is copied from the selected Xcode toolchain alongside the helper.
- React, Vite, Tauri and Lucide retain their upstream licenses. Package lockfiles identify the exact dependencies.

Bundled Rust and production frontend dependency notices are in `native/licenses/app-dependencies`. Its index lists exact versions, license identifiers, notice hashes and source locations, including the unmodified MPL-2.0 `selectors` crate. Regenerate them with `python3 scripts/collect-runtime-licenses.py` after installing the locked dependencies. Missing archive notices use pinned upstream files; the MPL-2.0 text comes from Mozilla.

Model files, compiled native dependencies and generated test recordings are not included in the source repository. The native build scripts fetch pinned sources/releases and copy required notices into the application bundle.
