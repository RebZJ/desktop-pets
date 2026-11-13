#!/usr/bin/env python3
"""Build the pinned, VAD-patched Moonshine C SDK for this host into native/lib.

Requires Python 3, CMake and a C++20 compiler; Windows requires an x64 MSVC
build environment. macOS arm64 reuses the existing verified macOS 15 archive.
"""
import ctypes
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import tarfile
import urllib.request

NATIVE = pathlib.Path(__file__).resolve().parents[1]
REVISION = "d8d8fa29d05ca67441a7719e70099f9f48917a93"
SOURCE_SHA = "857f04ed504d24e5b3fff4a0ce7066d57429a30d54714d39a587aa15e950ff30"
PATCH_SHA = "94d69a25630eb30e96cdff3fc0259836d8502273ab3860c7985c10507af2b264"


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() if hasattr(hashlib, "file_digest") else hashlib.sha256(stream.read()).hexdigest()


def run(*arguments):
    subprocess.run([str(value) for value in arguments], check=True)


def main():
    system, arch = platform.system(), platform.machine().lower()
    if system not in ("Darwin", "Linux", "Windows"):
        raise RuntimeError(f"Unsupported Moonshine host: {system}/{arch}")
    if arch in ("amd64", "x86_64"):
        arch = "x86_64"
    elif arch in ("arm64", "aarch64"):
        arch = "arm64"
    else:
        raise RuntimeError(f"Unsupported Moonshine architecture: {arch}")
    if system == "Windows" and arch != "x86_64":
        raise RuntimeError("The pinned Moonshine SDK provides Windows x64 ONNX Runtime only.")
    patch = NATIVE / "patches/moonshine-vad-clear.patch"
    if sha(patch) != PATCH_SHA:
        raise RuntimeError("Moonshine VAD patch hash mismatch.")
    output_dir = NATIVE / "lib"
    output_dir.mkdir(parents=True, exist_ok=True)
    dependencies = []
    if system == "Darwin" and arch == "arm64":
        # Reuse the pinned source, ONNX hash and deployment checks in this builder.
        run("bash", NATIVE / "scripts/bootstrap-moonshine.sh")
        archive = NATIVE / "vendor/moonshine/moonshine-voice-macos-arm64/lib/libmoonshine.a"
        output = output_dir / "libmoonshine.dylib"
        run("c++", "-dynamiclib", "-arch", "arm64", "-mmacosx-version-min=15.0", f"-Wl,-force_load,{archive}", "-framework", "Foundation", "-framework", "CoreFoundation", "-install_name", "@rpath/libmoonshine.dylib", "-o", str(output) + ".partial")
        pathlib.Path(str(output) + ".partial").replace(output)
    else:
        root = pathlib.Path(os.environ.get("PACE_MOONSHINE_PORTABLE_BUILD_ROOT", str(NATIVE / "vendor/moonshine" / f"build-{system.lower()}-{arch}")))
        root.mkdir(parents=True, exist_ok=True)
        archive = root / "source.tar.gz"
        cached = NATIVE.parent / "artifacts/runtime/moonshine-compat-20261113/source.tar.gz"
        if not archive.exists() and cached.exists() and sha(cached) == SOURCE_SHA:
            shutil.copyfile(cached, archive)
        if not archive.exists() or sha(archive) != SOURCE_SHA:
            temporary = archive.with_suffix(".partial")
            urllib.request.urlretrieve(f"https://codeload.github.com/moonshine-ai/moonshine/tar.gz/{REVISION}", temporary)
            if sha(temporary) != SOURCE_SHA:
                raise RuntimeError("Moonshine source archive hash mismatch.")
            temporary.replace(archive)
        source = root / f"moonshine-{REVISION}"
        # All required platform ONNX binaries are included in this hashed archive.
        with tarfile.open(archive) as bundle:
            prefix = f"moonshine-{REVISION}/"
            for item in bundle:
                if not (item.name.startswith(prefix + "core/") or item.name == prefix + "LICENSE"):
                    continue
                destination = root / item.name
                if not destination.resolve().is_relative_to(root.resolve()):
                    raise RuntimeError("Unsafe Moonshine archive path.")
                if item.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                elif item.isfile():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.extractfile(item) as data, destination.open("wb") as target:
                        shutil.copyfileobj(data, target)
        (source / "test-assets").mkdir(exist_ok=True)
        vad = source / "core/voice-activity-detector.cpp"
        text = vad.read_text()
        replacements = {
            "look_behind_audio_buffer.resize(look_behind_sample_count, 0.0f);": ("look_behind_audio_buffer.assign(look_behind_sample_count, 0.0f);", 2),
            "probability_window.resize(window_size, 0.0f);": ("probability_window.assign(window_size, 0.0f);", 1),
        }
        for old, (new, expected) in replacements.items():
            if text.count(old) != expected:
                raise RuntimeError("Pinned Moonshine VAD source no longer matches its reset patch.")
            text = text.replace(old, new)
        vad.write_text(text)
        build = root / "build"
        arguments = ["cmake", "-S", source / "core", "-B", build, "-DCMAKE_BUILD_TYPE=Release", "-DMOONSHINE_BUILD_SHARED=ON", "-DMOONSHINE_TTS_BUILD_ONNX=ON"]
        if system == "Darwin":
            arguments += [f"-DCMAKE_OSX_ARCHITECTURES={arch}", "-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0"]
        run(*arguments)
        run("cmake", "--build", build, "--config", "Release", "--target", "moonshine", "--parallel", "2")
        name = {"Linux": "libmoonshine.so", "Windows": "moonshine.dll", "Darwin": "libmoonshine.dylib"}[system]
        built = next(build.rglob(name), None)
        if built is None:
            raise RuntimeError(f"CMake did not produce {name}.")
        output = output_dir / name
        shutil.copyfile(built, output)
        ort_arch = "aarch64" if arch == "arm64" and system == "Linux" else arch
        ort = source / "core/third-party/onnxruntime/lib" / {"Linux": "linux", "Windows": "windows", "Darwin": "macos"}[system] / ort_arch
        for dependency in ort.iterdir():
            if dependency.name.endswith((".dll", ".dylib", ".so.1")):
                destination = output_dir / dependency.name
                shutil.copyfile(dependency, destination)
                dependencies.append(destination)
    dll_directory = os.add_dll_directory(str(output_dir)) if system == "Windows" else None
    try:
        library = ctypes.CDLL(str(output))
        for symbol in ("moonshine_transcriber_set_keyterms", "moonshine_create_stream", "moonshine_transcribe_stream"):
            getattr(library, symbol)
        version = library.moonshine_get_version()
        if version != 30000:
            raise RuntimeError(f"Moonshine ABI mismatch: expected 30000, got {version}.")
    finally:
        if dll_directory:
            dll_directory.close()
    metadata = dict(revision=REVISION, sourceSHA256=SOURCE_SHA, patchSHA256=PATCH_SHA, system=system, arch=arch, abiVersion=version, sha256=sha(output), dependencies={p.name: sha(p) for p in dependencies})
    output.with_suffix(output.suffix + ".build.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({"library": str(output), **metadata}))


if __name__ == "__main__":
    main()
