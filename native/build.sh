#!/bin/bash
set -euo pipefail
native_dir="$(cd "$(dirname "$0")" && pwd)"
whisper_revision=d2c6f05a46dacf663e357bcf0ed40f542a72825d
whisper_source="${TMPDIR:-/tmp}/desktop-pets-whisper-${whisper_revision}"
mkdir -p "$native_dir/bin" "$native_dir/licenses"
chmod -R u+w "$native_dir/bin" "$native_dir/licenses"
if ! xcrun metal -v >/dev/null 2>&1; then
  xcodebuild -downloadComponent MetalToolchain
fi
if [ ! -d "$whisper_source/.git" ]; then
  git clone https://github.com/ggml-org/whisper.cpp.git "$whisper_source"
fi
git -C "$whisper_source" checkout "$whisper_revision"
cmake -S "$whisper_source" -B "$whisper_source/build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET=15.0 \
  -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF
cmake --build "$whisper_source/build" --config Release -j 4 --target whisper-cli whisper-vad-speech-segments
cp "$whisper_source/build/bin/whisper-cli" "$native_dir/bin/whisper-cli"
cp "$whisper_source/build/bin/whisper-vad-speech-segments" "$native_dir/bin/whisper-vad-speech-segments"
cp "$whisper_source/LICENSE" "$native_dir/licenses/whisper.cpp.txt"
curl --fail --location --silent --show-error \
  https://raw.githubusercontent.com/snakers4/silero-vad/be95df9152c0d7618fa1edfeb296fc3dae32376f/LICENSE \
  -o "$native_dir/licenses/Silero-VAD.txt"
bash "$native_dir/scripts/bootstrap-moonshine.sh"
bash "$native_dir/scripts/patch-mlx-audio.sh"
swift build --package-path "$native_dir/PaceNative" -c release -j 6
checkout_dir="$native_dir/PaceNative/.build/checkouts"
while IFS= read -r -d '' license_file; do
  destination="$native_dir/licenses/swift-packages/${license_file#"$checkout_dir/"}"
  mkdir -p "$(dirname "$destination")"
  cp "$license_file" "$destination"
done < <(find "$checkout_dir" -type f \( -iname 'LICENSE*' -o -iname 'NOTICE*' -o -name COPYING \) ! -path '*/.git/*' -print0)
build_dir="$(swift build --package-path "$native_dir/PaceNative" -c release --show-bin-path)"
cp "$build_dir/PaceNative" "$native_dir/bin/PaceNative"
xcrun swift-stdlib-tool --copy --scan-executable "$native_dir/bin/PaceNative" \
  --destination "$native_dir/bin" --platform macosx --sign -
for bundle in "$build_dir/"*.bundle; do
  [ -d "$bundle" ] && ditto "$bundle" "$native_dir/bin/$(basename "$bundle")"
done
codesign --force --sign - "$native_dir/bin/PaceNative"
chmod -R u+w "$native_dir/bin" "$native_dir/licenses"
