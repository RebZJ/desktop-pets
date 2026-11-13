# Moonshine redistribution notices

These unmodified license files accompany pinned Moonshine v0.1.6 code and streaming STT models. `sources.json` records the exact upstream sources. Moonshine code and all streaming STT models use the MIT terms in Section 1 of `Moonshine-LICENSE.txt`; the file also preserves distinct terms for legacy non-streaming models that Pace does not install.

The runtime includes ONNX Runtime 1.23.2 and bundled C++ dependencies. Their license texts and the upstream ONNX Runtime third-party notices are preserved here. The source build uses Eigen with `EIGEN_MPL2_ONLY=1`. No third-party source modifications are made by the compatibility build; a recorded three-line change to Moonshine itself clears VAD buffers between recordings.

The unified runtime includes TTS and diarization code because upstream does not compile its complete C API with TTS disabled. Embedded VCTK clips and community-1 parameters are attributed in `embedded-data-NOTICE.md`. Additional TTS model weights and lexicon downloads are not installed.
