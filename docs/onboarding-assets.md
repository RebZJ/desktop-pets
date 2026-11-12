# Onboarding assets

Created 2026-11-13 for the Desktop Pets onboarding screen.

## Campsite background

- Production asset: `public/onboarding/pace-camp.webp`
- Source: `artifacts/onboarding/pace-camp-source.png`
- Resized intermediate: `artifacts/onboarding/pace-camp-768.png`
- Original generation: built-in imagegen tool, 1536 × 1024 PNG; no external reference image.
- Delivery: 768 × 512 (3:2), nearest-neighbor resize through ImageMagick, then lossless WebP through `cwebp -lossless -z 9`.
- Production size: 539,366 bytes (~527 KiB).
- Composition: open central clearing around 55% x / 60% y for the separately rendered Pace pet; path and stone gate upper left, tent/fire right, pond lower right.
- Visually inspected both the generated source and final WebP. No characters, labels, UI or watermarks appeared.
- Source SHA-256: `b6c5b8bc5836d93b165fc44eca045721390fd19f17b19a162ae67562dfa8e39c`
- WebP SHA-256: `a2d2f3f002e95ff93a3a0d0999765318b2a90084daea5be0bc6ad478b9e99316`

### Final generation prompt

```text
Use case: stylized-concept
Asset type: production background bitmap for a desktop-pet onboarding screen, never a UI mockup.
Primary request: one original wide 3:2 landscape pixel-art scene of a cozy grassland campsite at the forest edge, with the nostalgic visual craft of a 16-bit/GBA top-down adventure game. Render as a clean asset filling the whole image.
Scene/backdrop: rich mossy forest edges frame the left, upper and right sides. A light sage-green grassy clearing occupies most of the central and lower center area. The grass around 55% from left and 60% from top must be open, sparse and uncluttered so a separate yellow cheetah sprite can be overlaid there later. A small warm ochre tent and tiny contained campfire sit off to the right around 79% x, 45% y, comfortably away from the central clearing. A narrow ochre path winds from the clearing toward the upper-left and a small distant weathered stone gate. A small blue pond nestles into the bottom-right edge. Add a few restrained flowers, stones and grass tufts around the perimeter, preserving the clear center.
Style/medium: authored crisp pixel art on a strict visible square pixel grid; deliberately placed clusters, stepped silhouettes, limited richly harmonized palette, hard edges, subtle pixel dithering. Approximate a 384x256 pixel game scene enlarged with nearest-neighbor pixels, delivered at 1536x1024 or similar 3:2 landscape dimensions. This is actual environment art, no device or mockup around it.
Lighting/mood: cheerful, cozy warm morning. Bright friendly sage grass, forest and moss greens, cream highlights, ochre path and tent, restrained turquoise pond; no gloomy shadows.
Constraints: No characters, no people, no animals, no lettering, no UI elements, no borders, no frame, no logos, no watermark. Do not draw the cheetah; preserve its open placement space. No blur, no painterly brushwork, no soft gradients, no bloom or glowing effects, no isometric floating island.
```

## Silkscreen

The regular weight is self-hosted unchanged:

- `public/fonts/silkscreen/Silkscreen-Regular.ttf` (32,220 bytes)
- `public/fonts/silkscreen/OFL.txt` (copyright and complete SIL Open Font License 1.1)

Official Google Fonts metadata was checked before downloading. It identifies Silkscreen by Jason Kottke, regular weight 400, under OFL, with source repository [googlefonts/silkscreen](https://github.com/googlefonts/silkscreen).

Primary sources and download URLs:

- [Google Fonts metadata](https://raw.githubusercontent.com/google/fonts/main/ofl/silkscreen/METADATA.pb)
- [Regular font](https://raw.githubusercontent.com/google/fonts/main/ofl/silkscreen/Silkscreen-Regular.ttf)
- [OFL license](https://raw.githubusercontent.com/google/fonts/main/ofl/silkscreen/OFL.txt)

Downloaded 2026-11-13. Regular TTF SHA-256: `c845473330b94c2079ce9af01c51ac8ba2d99c24f4d14c039843bbb8e642ebd8`; license SHA-256: `86c5e9c9382cdcc5948704fdfe60f2aa164a719746931219a42736ecd9cefbd3`.
