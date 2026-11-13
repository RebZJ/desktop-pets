#!/usr/bin/env python3
"""Build the pinned llama.cpp server on macOS, Linux or Windows (CMake + C++17).

Python is a build tool only. The packaged app runs the resulting native binary.
Windows requires an MSVC developer shell. CPU is portable; macOS also uses Metal.
"""
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
REVISION = "ae93877c8f3bf9f39f0ee4ffb3ef1697c416a7c3"
SOURCE_SHA = "8f67ac11e4a4db0e3b7cdc722c779c2719fb415a7a55d0a0e86aaa4d156910c4"


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    system = platform.system()
    if system not in ("Darwin", "Linux", "Windows"):
        raise RuntimeError(f"Unsupported llama.cpp host: {system}")
    root = pathlib.Path(os.environ.get("PACE_LLAMA_BUILD_ROOT", str(NATIVE / "vendor/llama-portable")))
    root.mkdir(parents=True, exist_ok=True)
    archive = root / "source.tar.gz"
    if not archive.exists() or sha(archive) != SOURCE_SHA:
        temporary = archive.with_suffix(".partial")
        urllib.request.urlretrieve(f"https://codeload.github.com/ggml-org/llama.cpp/tar.gz/{REVISION}", temporary)
        if sha(temporary) != SOURCE_SHA:
            raise RuntimeError("llama.cpp source archive hash mismatch.")
        temporary.replace(archive)
    source = root / f"llama.cpp-{REVISION}"
    with tarfile.open(archive) as bundle:
        for item in bundle:
            target = root / item.name
            if not target.resolve().is_relative_to(root.resolve()):
                raise RuntimeError("Unsafe llama.cpp archive path.")
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif item.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(item) as data:
                    contents = data.read()
                if not target.is_file() or target.read_bytes() != contents:
                    target.write_bytes(contents)
    build = root / f"build-{system.lower()}-{platform.machine().lower()}"
    args = ["cmake", "-S", str(source), "-B", str(build), "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DLLAMA_BUILD_TESTS=OFF", "-DLLAMA_BUILD_EXAMPLES=OFF", "-DLLAMA_BUILD_SERVER=ON", "-DLLAMA_CURL=OFF", "-DLLAMA_OPENSSL=OFF", "-DGGML_NATIVE=OFF", "-DGGML_BACKEND_DL=OFF", "-DGGML_OPENMP=OFF", f"-DLLAMA_BUILD_COMMIT={REVISION}", "-DLLAMA_BUILD_NUMBER=0"]
    if system == "Darwin":
        args += ["-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON", "-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0"]
    else:
        args += ["-DGGML_METAL=OFF"]
    subprocess.run(args, check=True)
    subprocess.run(["cmake", "--build", str(build), "--config", "Release", "--target", "llama-server", "-j", str(min(os.cpu_count() or 2, 8))], check=True)
    name = "llama-server.exe" if system == "Windows" else "llama-server"
    candidates = [build / "bin" / name, build / "bin/Release" / name]
    binary = next((p for p in candidates if p.is_file()), None)
    if binary is None:
        raise RuntimeError("CMake did not produce llama-server.")
    (NATIVE / "bin").mkdir(exist_ok=True)
    destination = NATIVE / "bin" / name
    shutil.copy2(binary, destination)
    # MSVC's standard runtime is supplied by the normal Windows app prerequisite.
    licenses = NATIVE / "licenses/llama.cpp"
    licenses.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / "LICENSE", licenses / "LICENSE")
    for item in (source / "licenses").glob("*"):
        if item.is_file():
            shutil.copyfile(item, licenses / item.name)
    for item in (source / "vendor").rglob("*"):
        if item.is_file() and (item.name.upper().startswith("LICENSE") or item.name.upper() == "NOTICE"):
            target = licenses / item.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(item, target)
    metadata = dict(revision=REVISION, sourceSHA256=SOURCE_SHA, system=system, arch=platform.machine(), sha256=sha(destination))
    (NATIVE / "bin/llama-server.build.json").write_text(json.dumps(metadata, indent=2) + "\n")
    subprocess.run([str(destination), "--version"], check=True)
    print(f"Built {destination}")


if __name__ == "__main__":
    main()
