#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
    echo 'This release currently targets Apple Silicon macOS.' >&2
    exit 1
fi
version=0.3.0
archive="nemo-speech-$version-macos-aarch64-metal"
download_dir="$project_root/native/vendor/nemo-speech"
mkdir -p "$download_dir" "$project_root/native/bin" "$project_root/native/lib" "$project_root/native/share"
curl --fail --location --retry 3 --output "$download_dir/release.tar.gz" "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v$version/$archive.tar.gz"
actual=$(shasum -a 256 "$download_dir/release.tar.gz" | cut -d ' ' -f 1)
expected=2b972ed8b5dba07492212acf8cb75cbf34ecb141198ffa1997febe84b7c4d9ed
if [ "$actual" != "$expected" ]; then
    echo 'NeMo-Speech archive checksum mismatch.' >&2
    exit 1
fi
tar -xzf "$download_dir/release.tar.gz" -C "$download_dir"
cp "$download_dir/$archive/bin/nemo-speech" "$project_root/native/bin/nemo-speech"
cp -R "$download_dir/$archive/lib/." "$project_root/native/lib/"
cp -R "$download_dir/$archive/share/." "$project_root/native/share/"
"$project_root/native/bin/nemo-speech" --version
