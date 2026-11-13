---
name: desktop-pet-sprites
description: Create, extend, or repair coherent raster sprite animations for Desktop Pets and other local pet apps, matching canonical identity, pixel style, scale, and playback. Use for sprite sheets, mismatched poses, or animation asset QA; not ChatGPT Work Pets or its pets API.
---

# Desktop pet sprites

Produce a coherent animation set at its actual display size. A correctly sized strip can still contain the wrong-looking character.

## Establish the art and runtime contract

Read the pet manifest, sprite player, styles, packaging references, and existing quality notes before changing assets. Identify where state names, dimensions, frame counts, frame rate, and paths are consumed. Preserve unrelated app behavior and source attribution.

Select an accepted existing frame as the identity and style reference; inspect it with `view_image`. Inspect every affected state at native display size, both alone and adjacent to the reference. If working on Pace in the desk-pet repository, read [references/pace.md](references/pace.md); its specific palette and measurements are not requirements for other characters.

Measure these separately:

- Canvas and strip geometry, clipping, and empty frames.
- Palette, alpha distribution, outline thickness, and actual pixel-block grid. A nearest-neighbor CSS rule cannot undo smooth source artwork.
- Apparent head and torso dimensions, foot position, center of mass, and props. Occupied bounding-box height is not character scale: a seated body, raised hand, giant ear, sleeping pose, and jump legitimately differ.
- Adjacent-frame and loop-boundary stability. Animation may change facial features or posture; global resizing must not make the whole character pulse.

Do not dismiss a reported style mismatch because a previous geometry audit passed. Use raw assets and the running player to distinguish artwork defects from fractional scaling, frame slicing, or stale asset problems.

## Create only the needed art

Reuse an existing appropriate state before inventing more. Preserve established artwork where it already works. For raster generation or creative edits, use the built-in `image_gen` route from the imagegen skill. Inspect local inputs first and label each input's role. Do not use the ChatGPT Pets plugin for other apps, and do not switch silently to paid API scripts or another image model.

Give each action a separate prompt with:

- Canonical identity reference, unchanged anatomy and costume, exact style and palette, intended display size.
- One readable action with an ordered frame sequence, stable contact points, and a loop-closing pose.
- Sheet rows/columns, frame padding, transparent background, no annotations or grid lines in production artwork.
- Explicit invariants and the small region allowed to change. For pixel art, state the logical grid and hard cluster size, not merely “pixel style.”

Start with one generation per action. Permit one targeted cleanup if a specific visible defect remains; retain a failed candidate and report the limitation when this bounded pass fails. More variants require a reason from the actual review or a new user request, not speculative retries. Do not claim a prompt guarantees pixel-identical anatomy or exact palette compliance.

Save exact prompts, raw tool outputs, tool mode and source filenames before preparation. Copy selected outputs from the tool's generated-images location into the workspace. Use sibling versioned filenames until integration chooses the replacement.

## Prepare the app assets

Use ImageMagick for deterministic crop, pack, padding, and nearest-neighbor resize. Creative painting or changes to anatomy belong in imagegen. For an explicitly pixel-art target, deterministic engine-format normalization can additionally quantize to its measured canonical palette and binary alpha; this is encoding of generated art, not a substitute for generating it. Preserve the raw output and record the palette, alpha cutoff, logical size, and transforms. Do not quantize smooth or translucent characters merely because this skill covers pixel sprites.

The image tool can emit soft alpha even after a binary-alpha prompt. When binary alpha and a palette are required, retain a thresholded alpha mask separately while mapping RGB to the palette, then restore the mask. Disable dithering. Reset ImageMagick's compose operator to `Over` after `CopyOpacity` before adding padding; otherwise the padding operation can erase RGB. Inspect the result for lost eyes, fingers, limbs, or outlines.

Apply one fixed scale and translation per state, calibrated against anatomy and contact points. Padding may repair unequal sheet cell dimensions. Do not independently fit every frame's occupied bounds. Keep authored jumps, stretching, and floating effects. Use per-frame corrections only for demonstrated sheet placement defects, record them, and verify they do not erase intended motion.

For Desktop Pets manifests, preserve this contract:

```json
{"id":"talk","src":"talk-v2.webp","frameWidth":256,"frameHeight":256,"frameCount":8,"fps":8}
```

`src` is relative to the manifest directory. The file is one horizontal strip of exactly `frameWidth × frameCount` by `frameHeight`; frames are in playback order. Keep each action's real dimensions and rate, not the example values. Encode WebP losslessly with `webp:lossless=true` and `webp:exact=true`; verify decoded RGBA matches the packed frames. For a different app, follow its existing contract rather than introducing this schema.

## Verify and deliver

Run the read-only geometry/style audit when the app uses the above manifest schema. Resolve `scripts/audit_sprites.py` relative to this `SKILL.md` directory, or run this command from that directory:

```bash
python3 scripts/audit_sprites.py /absolute/path/manifest.json \
  --reference /absolute/path/canonical.png --grid 2 --nominal-size 256 \
  --out /absolute/path/audit.json --self-test
```

The script requires Pillow. Set grid/nominal-size from the reference; the values shown are an example. An artifact-only candidate manifest can use `--asset-root /absolute/path/sprites` so no live manifest needs editing. It checks all frames and reports alpha, palette distance, and grid alignment. Its exit code covers geometry/input errors only. Style metrics describe differences, not artistic acceptance; prop colors, translucent effects, and authored motion can be intentional. Its bounding boxes use alpha ≥128, so inspect lower-alpha artwork separately.

Review native-size contact sheets on light and dark backgrounds, complete frame sequences, and a looping preview at the intended rate. Compare head/body scale, face legibility, action clarity, foot anchors, and the last-to-first transition. A contact sheet does not prove motion quality. In the actual app, check representative state changes at the real canvas size and device scale when runtime integration is in scope.

If integration is requested, update the manifest, player/state mapping, asset package/export, and relevant callers together, then run the affected checks. Otherwise hand off the exact candidate filenames and contract without changing runtime selection. Keep source art, preparation commands, audit evidence, and license provenance. Do not publish, upload, install into a user profile, or modify another pet product without task authorization.

Report what improved, which files are selected, how many image calls were made, which checks ran, and any remaining artistic or runtime uncertainty. Distinguish raw generated output from normalized production assets. Never describe unviewed animation or an unused candidate as approved.
