# Pace / Desktop Pets reference

Use only for Pace in the `desk-pet` repository; paths below are relative to that checkout. Inspect current files before relying on these measurements.

- Manifest: `public/pets/pace/manifest.json`.
- Canonical original idle: `artifacts/sprite-review-20261113/idle-reference.png`.
- Original source review: `docs/sprite-quality-2026-11-13.md`; it accepted later generated poses using geometry and native-size appearance, but those poses retained a real source-style mismatch.
- Subsequent refinement: `docs/sprite-refinement-2026-11-13.md` and `artifacts/sprite-refinement-20261113/`.

Pace is the gold cheetah with dark brown outlines/spots, cream muzzle and belly, red headband, red-and-cream sneakers, and a curved tail. Preserve the original face and head/body proportions, not a generic cute-cat redraw.

The twelve original actions are idle, wave, think, type, create, review, schedule, sprint, celebrate, sleep, happy, and annoyed. Their original strips use a 128-square logical grid: 2×2 blocks in 256-square frames, or 4×4 blocks in sleep's 512-square frames. Standing idle occupies y=48–224, its floor is 87.5% of canvas height, and shoes center near x=151 on the 256 canvas. Most originals have binary alpha. Sleep's fading Zzz intentionally uses partial alpha while its body stays crisp. Seated states and sleep must not be enlarged to idle's occupied height; jumping states must retain their motion.

Canonical idle has 16 opaque RGB colors, dominated by:

| Role | Hex |
| --- | --- |
| Outline | `#160404` |
| Gold | `#f9a80c` |
| Cream | `#fbeec5` |
| Red | `#dc0c1f` |
| Brown | `#54270b` |
| Highlight | `#fec310` |

Extract the full palette from the canonical frame, rather than limiting artwork to the six colors above. Props in original states add legitimate colors. A palette-distance metric alone does not warrant recoloring those originals.

The first talk/listen/dictate assets were 8×256 strips at 8fps. Before refinement, a typical frame had roughly 11,000–12,000 RGBA colors and >99% partial-alpha visible pixels; this was qualitatively different from the original 16-color, hard-grid artwork even when foot position and height matched. Do not reuse those assets as style references. A dictation pose can be an action reference for the attached giant ear and cupped paw while the original idle remains the style reference.

The refinement adds versioned talk/listen/dictate and a hush privacy cue. It uses genuine imagegen source sheets, then one fixed per-state ImageMagick normalization to 128 logical pixels, canonical palette, binary alpha, and 256-square frames. Raw sources are intentionally softer than the final sprites. Exact transforms and alpha cutoff are retained in the refinement's `normalize.sh`.

Attribution for original art remains Outpaced / Desktop Pets; preserve the repository's license and attribution files. Newly generated source art must be identified as such. Changes to the manifest, sprite player, and starter package must agree before an asset is selected by the app.
