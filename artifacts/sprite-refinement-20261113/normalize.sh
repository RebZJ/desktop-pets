#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
work=artifacts/sprite-refinement-20261113
mkdir -p "$work/frames"
magick artifacts/sprite-review-20261113/idle-reference.png -background '#160404' -alpha remove -alpha off -unique-colors "$work/canonical-palette.png"
for action in talk listen dictate hush; do
  source="$work/sources/$action-v2-source.png"
  case "$action" in
    talk) logical=100; dx=16; dy=18 ;;
    listen) logical=100; dx=17; dy=20 ;;
    dictate) logical=113; dx=16; dy=12; source="$work/sources/dictate-v3-source.png" ;;
    hush) logical=103; dx=16; dy=18 ;;
  esac
  for frame in 0 1 2 3 4 5 6 7; do
    column=$((frame % 4))
    row=$((frame / 4))
    case "$column" in
      0) x=0; width=444 ;;
      1) x=444; width=443 ;;
      2) x=887; width=443 ;;
      3) x=1330; width=444 ;;
    esac
    y=$((row * 444))
    height=$((444 - row))
    magick "$source" \
      -crop "${width}x${height}+${x}+${y}" +repage \
      -background none -gravity northwest -extent 444x444 \
      -filter point -resize "${logical}x${logical}!" \
      -channel A -threshold 50% +channel \
      \( +clone -alpha extract -write mpr:mask +delete \) \
      -alpha off -dither None -remap "$work/canonical-palette.png" \
      mpr:mask -alpha off -compose CopyOpacity -composite -compose Over \
      -background none -gravity northwest -splice "${dx}x${dy}" -extent 128x128 \
      -filter point -resize 256x256! "$work/frames/$action-v2-$frame.png"
  done
  magick "$work/frames/$action-v2-"[0-7].png +append -define webp:lossless=true -define webp:exact=true "public/pets/pace/$action-v2.webp"
done
