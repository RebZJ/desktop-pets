#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
work=artifacts/sprite-refinement-20261113
mkdir -p "$work/previews/tiles" "$work/previews/playback"
for background in cream dark; do
  if [[ "$background" == cream ]]; then color='#e9e7df'; ink='#222222'; else color='#171c24'; ink='#efefe7'; fi
  for action in idle wave think type create review schedule sprint celebrate sleep happy annoyed talk listen dictate; do
    size=256
    if [[ "$action" == sleep ]]; then size=512; fi
    magick "public/pets/pace/$action.webp" -crop "${size}x${size}+0+0" +repage -filter point -resize 160x160! -background "$color" -alpha remove -alpha off -gravity south -splice 0x24 -font Helvetica -pointsize 12 -fill "$ink" -annotate +0+5 "$action (existing)" "$work/previews/tiles/$action-old-$background.png"
  done
  for action in talk listen dictate hush; do
    for frame in 0 1 2 3 4 5 6 7; do
      magick "$work/frames/$action-v2-$frame.png" -filter point -resize 160x160! -background "$color" -alpha remove -alpha off -gravity south -splice 0x24 -font Helvetica -pointsize 12 -fill "$ink" -annotate +0+5 "$action v2 / $frame" "$work/previews/tiles/$action-v2-$frame-$background.png"
    done
  done
  magick montage \
    "$work/previews/tiles/idle-old-$background.png" "$work/previews/tiles/talk-old-$background.png" "$work/previews/tiles/talk-v2-0-$background.png" "$work/previews/tiles/talk-v2-2-$background.png" \
    "$work/previews/tiles/idle-old-$background.png" "$work/previews/tiles/listen-old-$background.png" "$work/previews/tiles/listen-v2-0-$background.png" "$work/previews/tiles/listen-v2-3-$background.png" \
    "$work/previews/tiles/idle-old-$background.png" "$work/previews/tiles/dictate-old-$background.png" "$work/previews/tiles/dictate-v2-0-$background.png" "$work/previews/tiles/dictate-v2-3-$background.png" \
    "$work/previews/tiles/idle-old-$background.png" "$work/previews/tiles/hush-v2-0-$background.png" "$work/previews/tiles/hush-v2-3-$background.png" "$work/previews/tiles/hush-v2-7-$background.png" \
    -tile 4x4 -geometry +0+0 -background "$color" "$work/previews/native-160-$background.png"
  magick montage "$work/previews/tiles/idle-old-$background.png" "$work/previews/tiles/wave-old-$background.png" "$work/previews/tiles/think-old-$background.png" "$work/previews/tiles/type-old-$background.png" "$work/previews/tiles/create-old-$background.png" "$work/previews/tiles/review-old-$background.png" "$work/previews/tiles/schedule-old-$background.png" "$work/previews/tiles/sprint-old-$background.png" "$work/previews/tiles/celebrate-old-$background.png" "$work/previews/tiles/sleep-old-$background.png" "$work/previews/tiles/happy-old-$background.png" "$work/previews/tiles/annoyed-old-$background.png" -tile 4x3 -geometry +0+0 -background "$color" "$work/previews/originals-native-160-$background.png"
  for frame in 0 1 2 3 4 5 6 7; do
    magick "$work/previews/tiles/idle-old-$background.png" "$work/previews/tiles/talk-v2-$frame-$background.png" "$work/previews/tiles/listen-v2-$frame-$background.png" "$work/previews/tiles/dictate-v2-$frame-$background.png" "$work/previews/tiles/hush-v2-$frame-$background.png" +append "$work/previews/playback/$background-$frame.png"
  done
done
for frame in 0 1 2 3 4 5 6 7; do
  magick "$work/previews/playback/cream-$frame.png" "$work/previews/playback/dark-$frame.png" -append "$work/previews/playback/pair-$frame.png"
done
magick -delay 12 "$work/previews/playback/pair-0.png" -delay 13 "$work/previews/playback/pair-1.png" -delay 12 "$work/previews/playback/pair-2.png" -delay 13 "$work/previews/playback/pair-3.png" -delay 12 "$work/previews/playback/pair-4.png" -delay 13 "$work/previews/playback/pair-5.png" -delay 12 "$work/previews/playback/pair-6.png" -delay 13 "$work/previews/playback/pair-7.png" -loop 0 "$work/previews/selected-states-8fps.gif"
