#!/bin/bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
source_app="$project_root/src-tauri/target/release/bundle/macos/Desktop Pets.app"
output="$project_root/artifacts/release"
signing_identity="${PACE_CODESIGN_IDENTITY:--}"
test -d "$source_app/Contents/Resources/native"
mkdir -p "$output"
stage="$(mktemp -d "$output/macos-stage.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
app="$stage/Desktop Pets.app"
ditto "$source_app" "$app"
while IFS= read -r -d '' executable; do
  case "$(file -b "$executable")" in
    *Mach-O*) codesign --force --sign "$signing_identity" "$executable" ;;
  esac
done < <(find "$app/Contents/Resources" -type f -print0)
codesign --force --sign "$signing_identity" "$app"
codesign --verify --deep --strict --verbose=2 "$app"
ln -s /Applications "$stage/Applications"
cat > "$stage/Read me.txt" <<'TXT'
Desktop Pets 0.1.0 alpha — Apple Silicon, macOS 15+, 16 GB RAM recommended.

This is a locally signed build. It is not Apple-notarized and Gatekeeper
may prevent opening a copy downloaded from the internet. Source and build
instructions: https://github.com/RebZJ/desktop-pets

Drag Desktop Pets to Applications. Onboarding begins with model downloads:
about 45 MB for English dictation. Meeting notes and questions use the local
Qwen GGUF model; meeting transcription and diarization are separate downloads.
Inference runs offline after installation. Writing and ambient capture are paused.

Microphone, system-audio and cross-app insertion permissions need your review.
Read the validation report before relying on live meetings or screen sharing.
TXT
dmg="$output/Desktop-Pets_0.1.0_arm64.dmg"
hdiutil create -volname 'Desktop Pets' -srcfolder "$stage" -format UDZO -ov "$dmg"
hdiutil verify "$dmg"
# Replace only this script's generated app, using the freshly signed staging copy.
rm -rf "$output/Desktop Pets.app"
ditto "$app" "$output/Desktop Pets.app"
(cd "$output" && shasum -a 256 Desktop-Pets_0.1.0_arm64.dmg Pace-starter.zip > SHA256SUMS)
printf 'Packaged %s\n' "$dmg"
