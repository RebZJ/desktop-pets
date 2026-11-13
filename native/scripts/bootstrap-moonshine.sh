#!/bin/bash
set -euo pipefail
native_dir="$(cd "$(dirname "$0")/.." && pwd)"
header="$native_dir/PaceNative/Sources/CMoonshine/moonshine-c-api.h"
echo "e24c1006b65a9ed7fd8ad801af644105a120342196a884f52ebbfb0d30071867  $header" | shasum -a 256 -c -
bash "$native_dir/scripts/build-moonshine-compatible.sh" "$native_dir/vendor/moonshine/moonshine-voice-macos-arm64/lib/libmoonshine.a"
