#!/usr/bin/env python3
"""Build pinned whisper.cpp/VAD and NeMo diarization with build-time Python + CMake.

No Git checkout, Python runtime, external model service, or model download is needed.
Windows builds require the x64 MSVC developer environment. All hosts need CMake >=3.26.
"""
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request

NATIVE = pathlib.Path(__file__).resolve().parents[1]
SOURCES = {
    "whisper": ("ggml-org/whisper.cpp", "d2c6f05a46dacf663e357bcf0ed40f542a72825d", "4723abc6d6cafb1ad89fe31e21053acd1f1968cc6db4a448b85051511f311f2f"),
    "nemo": ("NVIDIA/NeMo-Speech.cpp", "20999cc921d2b14aa58708f61756a8b2e787ba20", "2e02f2486a0ce9e5bcbd57d04721b849f9572857a6862c9daf5076549982d0c2"),
    "nemo-llama": ("ggml-org/llama.cpp", "bd4f514db14d87fded667787a7a963bfbaa98e89", "b02af830447d56db65f6579414dee3c06d9d116cc1765d2539417ee8a7ff1dfa"),
    "sentencepiece": ("google/sentencepiece", "31646a467d2051eb904e0b45de3a73e91fe1c1e3", "b4eb17e6bea5c9380ddd79d04d01d6aa5e280be8f3e3cef1f745a80e6d9451ce"),
}


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


def extract(archive, target):
    """Extract regular files only; source archives cannot write outside their root."""
    with tarfile.open(archive) as bundle:
        for item in bundle:
            destination = target / item.name
            if not destination.resolve().is_relative_to(target.resolve()):
                raise RuntimeError("Unsafe source archive path.")
            if item.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            elif item.isfile():
                destination.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(item) as data:
                    contents = data.read()
                if not destination.is_file() or destination.read_bytes() != contents:
                    destination.write_bytes(contents)


def source(root, name):
    repo, revision, expected = SOURCES[name]
    archive = root / f"{name}.tar.gz"
    if not archive.is_file() or sha(archive) != expected:
        temporary = archive.with_suffix(".partial")
        urllib.request.urlretrieve(f"https://codeload.github.com/{repo}/tar.gz/{revision}", temporary)
        if sha(temporary) != expected:
            raise RuntimeError(f"{name} source SHA-256 mismatch.")
        temporary.replace(archive)
    extract(archive, root)
    return root / f"{repo.split('/')[-1]}-{revision}"


def configure(source_dir, build, options):
    run("cmake", "-S", source_dir, "-B", build, "-DCMAKE_BUILD_TYPE=Release", *options)


def build(build_dir, *targets):
    run("cmake", "--build", build_dir, "--config", "Release", "--parallel", str(min(os.cpu_count() or 2, 6)), *( ["--target", *targets] if targets else [] ))


def copy_binary(build_dir, name, system):
    filename = name + (".exe" if system == "Windows" else "")
    candidate = next((p for p in [build_dir / "bin" / filename, build_dir / "bin/Release" / filename] if p.is_file()), None)
    if candidate is None:
        raise RuntimeError(f"Build did not produce {filename}.")
    shutil.copy2(candidate, NATIVE / "bin" / filename)


def copy_notices(source_dir, destination):
    for item in source_dir.rglob("*"):
        if item.is_file() and (item.name.upper().startswith(("LICENSE", "NOTICE", "COPYING")) or item.name == "THIRD_PARTY_NOTICES.md"):
            target = destination / item.relative_to(source_dir)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(item, target)


def main():
    if sys.argv[1:] == ["--self-test"]:
        import io
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            archive = root / "malicious.tar"
            with tarfile.open(archive, "w") as bundle:
                entry = tarfile.TarInfo("../escape")
                entry.size = 1
                bundle.addfile(entry, io.BytesIO(b"x"))
            try:
                extract(archive, root / "source")
            except RuntimeError:
                pass
            else:
                raise AssertionError("Source extraction accepted directory traversal")
        assert all(len(revision) == 40 and len(digest) == 64 for _, revision, digest in SOURCES.values())
        print("Portable source pins and archive traversal check passed.")
        return
    system = platform.system()
    if system not in ("Darwin", "Windows", "Linux"):
        raise RuntimeError(f"Unsupported build host: {system}")
    root = pathlib.Path(os.environ.get("PACE_SPEECH_BUILD_ROOT", str(NATIVE / "vendor/portable-speech")))
    root.mkdir(parents=True, exist_ok=True)
    for directory in ["bin", "lib", "share", "licenses"]:
        (NATIVE / directory).mkdir(exist_ok=True)
    host = f"{system.lower()}-{platform.machine().lower()}"
    common = ["-DBUILD_SHARED_LIBS=OFF", "-DGGML_NATIVE=OFF", "-DGGML_OPENMP=OFF", "-DGGML_BACKEND_DL=OFF", "-DGGML_METAL_EMBED_LIBRARY=ON"]
    common += ["-DGGML_METAL=ON", "-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0"] if system == "Darwin" and platform.machine().lower() == "arm64" else ["-DGGML_METAL=OFF"]
    whisper = source(root, "whisper")
    whisper_build = root / f"build-whisper-{host}"
    configure(whisper, whisper_build, common + ["-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_SERVER=OFF"])
    build(whisper_build, "whisper-cli", "whisper-vad-speech-segments")
    for name in ["whisper-cli", "whisper-vad-speech-segments"]:
        copy_binary(whisper_build, name, system)
    copy_notices(whisper, NATIVE / "licenses/whisper.cpp")

    nemo = source(root, "nemo")
    llama = source(root, "nemo-llama")
    sentencepiece = source(root, "sentencepiece")
    sp_build = root / f"build-sentencepiece-{host}"
    prefix = root / f"deps-{host}/sentencepiece"
    configure(sentencepiece, sp_build, ["-DSPM_ENABLE_SHARED=OFF", "-DSPM_BUILD_TEST=OFF", "-DSPM_ENABLE_TCMALLOC=OFF", "-DCMAKE_POSITION_INDEPENDENT_CODE=ON"] + (["-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0"] if system == "Darwin" else []))
    build(sp_build, "sentencepiece-static")
    (prefix / "lib").mkdir(parents=True, exist_ok=True)
    (prefix / "include").mkdir(exist_ok=True)
    archive_name = "sentencepiece.lib" if system == "Windows" else "libsentencepiece.a"
    candidates = list(sp_build.rglob(archive_name))
    if not candidates and system == "Windows":
        candidates = list(sp_build.rglob("sentencepiece-static.lib"))
    if not candidates:
        raise RuntimeError("SentencePiece static library was not produced.")
    shutil.copyfile(candidates[0], prefix / "lib" / archive_name)
    shutil.copyfile(sentencepiece / "src/sentencepiece_processor.h", prefix / "include/sentencepiece_processor.h")
    copy_notices(sentencepiece, NATIVE / "licenses/sentencepiece")
    # NeMo's install rules expect its submodule license, even when using an explicit source tree.
    (nemo / "llama.cpp").mkdir(exist_ok=True)
    shutil.copyfile(llama / "LICENSE", nemo / "llama.cpp/LICENSE")
    nemo_build = root / f"build-nemo-{host}"
    configure(nemo, nemo_build, common + [f"-DNEMO_SPEECH_LLAMA_CPP_SOURCE_DIR={llama}", f"-DNEMO_SPEECH_DEPENDENCY_PREFIX={prefix.parent}", f"-DCMAKE_PREFIX_PATH={prefix}", "-DNEMO_SPEECH_GGML_PATCHED=OFF", "-DNEMO_SPEECH_BUILD_ASR=OFF", "-DNEMO_SPEECH_BUILD_DIAR=ON", "-DNEMO_SPEECH_BUILD_TTS=OFF", "-DNEMO_SPEECH_BUILD_MIC_CAPTURE=OFF", "-DNEMO_SPEECH_BUILD_HTTP=OFF", "-DNEMO_SPEECH_BUILD_TESTS=OFF"])
    build(nemo_build)
    stage = root / f"stage-nemo-{host}"
    run("cmake", "--install", nemo_build, "--config", "Release", "--prefix", stage)
    shutil.copytree(stage / "bin", NATIVE / "bin", dirs_exist_ok=True)
    # Only runtime libraries belong in the app, not CMake exports or static link archives.
    runtime_libraries = [p for p in (stage / "lib").iterdir() if p.is_file() and (".so" in p.name or p.name.endswith((".dylib", ".dll")))]
    for item in runtime_libraries:
        shutil.copyfile(item, NATIVE / "lib" / item.name)
    if (stage / "share").is_dir():
        shutil.copytree(stage / "share", NATIVE / "share", dirs_exist_ok=True)
    copy_notices(nemo, NATIVE / "licenses/nemo-speech")
    copy_notices(llama, NATIVE / "licenses/nemo-speech/llama.cpp")
    metadata = {name: {"repository": repo, "revision": revision, "sourceSHA256": digest} for name, (repo, revision, digest) in SOURCES.items()}
    metadata["system"] = system
    metadata["arch"] = platform.machine()
    metadata["binaries"] = {p.name: sha(p) for p in (NATIVE / "bin").iterdir() if p.name in ("whisper-cli", "whisper-cli.exe", "whisper-vad-speech-segments", "whisper-vad-speech-segments.exe", "nemo-speech", "nemo-speech.exe")}
    (NATIVE / "bin/portable-speech.build.json").write_text(json.dumps(metadata, indent=2) + "\n")
    for name, option in [("nemo-speech", "--version"), ("whisper-cli", "--help"), ("whisper-vad-speech-segments", "--help")]:
        binary = NATIVE / "bin" / (name + (".exe" if system == "Windows" else ""))
        subprocess.run([str(binary), option], check=True, timeout=20)
    print("Built portable Whisper, VAD and NeMo diarization.")


if __name__ == "__main__":
    main()
