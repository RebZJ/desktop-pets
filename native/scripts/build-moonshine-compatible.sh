#!/bin/bash
set -euo pipefail
native_dir="$(cd "$(dirname "$0")/.." && pwd)"
revision=d8d8fa29d05ca67441a7719e70099f9f48917a93
source_sha=857f04ed504d24e5b3fff4a0ce7066d57429a30d54714d39a587aa15e950ff30
ort_sha=eac8b1c9a25c3eb048ddcbba6b01559ec7e5d8115b7e9a03a847be9db3fcc366
patch_sha=94d69a25630eb30e96cdff3fc0259836d8502273ab3860c7985c10507af2b264
root="${PACE_MOONSHINE_BUILD_ROOT:-$native_dir/vendor/moonshine/build-macos15}"
output="${1:-$native_dir/vendor/moonshine/moonshine-voice-macos-arm64/lib/libmoonshine.a}"
patch_file="$native_dir/patches/moonshine-vad-clear.patch"
echo "$patch_sha  $patch_file" | shasum -a 256 -c -

# Local hashes cache this compiler's output; input and patch revisions are portable.
if python3 - "$output" "$revision" "$patch_sha" "$source_sha" "$ort_sha" <<'PY'
import hashlib, json, pathlib, sys
p = pathlib.Path(sys.argv[1])
try:
    data = json.loads(pathlib.Path(str(p) + '.build.json').read_text())
    valid = (data['revision'] == sys.argv[2] and data['patchSHA256'] == sys.argv[3]
             and data['deploymentTarget'] == '15.0'
             and data['sourceSHA256'] == sys.argv[4] and data['onnxSHA256'] == sys.argv[5]
             and data['sha256'] == hashlib.sha256(p.read_bytes()).hexdigest())
except (OSError, ValueError, KeyError):
    valid = False
sys.exit(0 if valid else 1)
PY
then
  exit 0
fi

mkdir -p "$root" "$(dirname "$output")"
download() {
  local url="$1" path="$2" expected="$3"
  if [ ! -f "$path" ] || [ "$(shasum -a 256 "$path" | cut -d ' ' -f 1)" != "$expected" ]; then
    curl --fail --location --silent --show-error --retry 3 "$url" --output "$path.partial"
    echo "$expected  $path.partial" | shasum -a 256 -c -
    mv "$path.partial" "$path"
  fi
}
download "https://codeload.github.com/moonshine-ai/moonshine/tar.gz/$revision" "$root/source.tar.gz" "$source_sha"
download "https://media.githubusercontent.com/media/moonshine-ai/moonshine/$revision/core/third-party/onnxruntime/lib/macos/arm64/libonnxruntime.a" "$root/onnxruntime.a" "$ort_sha"
tar -xzf "$root/source.tar.gz" -C "$root" "moonshine-$revision/core" "moonshine-$revision/LICENSE"
source_dir="$root/moonshine-$revision"
cp "$root/onnxruntime.a" "$source_dir/core/third-party/onnxruntime/lib/macos/arm64/libonnxruntime.a"
mkdir -p "$source_dir/test-assets"
patch --batch --forward -p1 -d "$source_dir" < "$patch_file"
# The unified C API requires the TTS code, even when only STT is used.
cmake -S "$source_dir/core" -B "$root/build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0 -DMOONSHINE_BUILD_SWIFT=ON \
  -DMOONSHINE_TTS_BUILD_ONNX=ON
cmake --build "$root/build" --target moonshine -j 2
lipo "$root/build/moonshine.framework/Versions/A/moonshine" -thin arm64 -output "$output.partial"
python3 - "$output.partial" "$output" "$revision" "$patch_sha" "$source_sha" "$ort_sha" <<'PY'
import collections, hashlib, json, pathlib, re, subprocess, sys
temporary, output = map(pathlib.Path, sys.argv[1:3])
loads = subprocess.check_output(['otool', '-l', str(temporary)], text=True)
versions = collections.Counter(re.findall(r'\bminos ([0-9.]+)', loads))
assert versions and all(tuple(map(int, v.split('.'))) <= (15, 0) for v in versions), versions
assert subprocess.check_output(['lipo', '-archs', str(temporary)], text=True).strip() == 'arm64'
symbols = subprocess.check_output(['nm', '-g', str(temporary)], text=True)
assert '_moonshine_transcriber_set_keyterms' in symbols and '_OrtGetApiBase' in symbols
data = dict(revision=sys.argv[3], patchSHA256=sys.argv[4], sourceSHA256=sys.argv[5],
            onnxSHA256=sys.argv[6], deploymentTarget='15.0', minOSObjectCounts=dict(versions),
            sha256=hashlib.sha256(temporary.read_bytes()).hexdigest(), bytes=temporary.stat().st_size,
            compiler=subprocess.check_output(['c++', '--version'], text=True).splitlines()[0])
temporary.replace(output)
pathlib.Path(str(output) + '.build.json').write_text(json.dumps(data, indent=2) + '\n')
print(json.dumps(data))
PY
