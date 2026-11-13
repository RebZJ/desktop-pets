#!/bin/bash
set -euo pipefail
native_dir="$(cd "$(dirname "$0")/.." && pwd)"
checkout="$native_dir/PaceNative/.build/checkouts/mlx-audio-swift"
if [ ! -d "$checkout" ]; then
  swift package --package-path "$native_dir/PaceNative" resolve
fi
if [ "$(git -C "$checkout" rev-parse HEAD)" != df2a2546705f50ca267037702a34cd63aa6e35a6 ]; then
  echo 'Revalidate the native audio patches against the new mlx-audio-swift revision.' >&2
  exit 1
fi
for patch_file in "$native_dir"/patches/mlx-audio-*.patch; do
  if git -C "$checkout" apply --reverse --check "$patch_file" >/dev/null 2>&1; then
    continue
  fi
  git -C "$checkout" apply --check "$patch_file"
  git -C "$checkout" apply "$patch_file"
done
