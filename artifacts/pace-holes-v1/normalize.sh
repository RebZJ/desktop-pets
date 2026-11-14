#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
work=artifacts/pace-holes-v1
mkdir -p "$work/frames"
magick artifacts/sprite-review-20261113/idle-reference.png -background '#160404' -alpha remove -alpha off -unique-colors "$work/canonical-palette.png"
for action in summon burrow; do
  case "$action" in
    summon) logical=118; dx=11; dy=6; row_offset=0; source="$work/sources/summon-v1-source.png" ;;
    # The second generated row places the hole 23 source pixels too high.
    burrow) logical=116; dx=8; dy=7; row_offset=6; source="$work/sources/burrow-v2-source.png" ;;
  esac
  for frame in 0 1 2 3 4 5 6 7; do
    column=$((frame % 4)); row=$((frame / 4))
    case "$column" in
      0) x=0; width=444 ;;
      1) x=444; width=443 ;;
      2) x=887; width=443 ;;
      3) x=1330; width=444 ;;
    esac
    y=$((row * 444)); height=$((444 - row)); frame_dy=$((dy + row * row_offset))
    magick "$source" \
      -crop "${width}x${height}+${x}+${y}" +repage \
      -background none -gravity northwest -extent 444x444 \
      -filter point -resize "${logical}x${logical}!" \
      -channel A -threshold 50% +channel \
      \( +clone -alpha extract -write mpr:mask +delete \) \
      -alpha off -dither None -remap "$work/canonical-palette.png" \
      mpr:mask -alpha off -compose CopyOpacity -composite -compose Over \
      -background none -gravity northwest -splice "${dx}x${frame_dy}" -extent 128x128 \
      -filter point -resize 256x256! "$work/frames/$action-v1-$frame.png"
  done
  # Reuse the accepted idle keyframe for a seamless runtime handoff.
  case "$action" in summon) anchor=7 ;; burrow) anchor=0 ;; esac
  cp artifacts/sprite-review-20261113/idle-reference.png "$work/frames/$action-v1-$anchor.png"
  magick "$work/frames/$action-v1-"[0-7].png +append -define webp:lossless=true -define webp:exact=true "public/pets/pace/$action-v1.webp"
done
for action in summon burrow; do
  magick -dispose background \
    -delay 12 "$work/frames/$action-v1-0.png" -delay 13 "$work/frames/$action-v1-1.png" \
    -delay 12 "$work/frames/$action-v1-2.png" -delay 13 "$work/frames/$action-v1-3.png" \
    -delay 12 "$work/frames/$action-v1-4.png" -delay 13 "$work/frames/$action-v1-5.png" \
    -delay 12 "$work/frames/$action-v1-6.png" -delay 13 "$work/frames/$action-v1-7.png" \
    -filter point -resize 160x160! -background '#fff5dd' -alpha remove -alpha off \
    -loop 0 "$work/previews/$action-native-160-8fps.gif"
done
for theme in cream dark; do
  case "$theme" in cream) color='#fff5dd' ;; dark) color='#242025' ;; esac
  magick montage artifacts/sprite-review-20261113/idle-reference.png "$work/frames/summon-v1-"[0-7].png artifacts/sprite-review-20261113/idle-reference.png "$work/frames/burrow-v1-"[0-7].png -filter point -geometry 160x160+0+0 -tile 9x2 -background "$color" "$work/previews/native-160-$theme.png"
done
