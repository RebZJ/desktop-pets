# Pace sprite refinement — 2026-11-13

The reported mismatch was real. The original art uses coarse, regular pixel blocks and a small palette; the first talk/listen/dictate additions used smooth, partially transparent pixels and thousands of colors. Matching their bounding boxes and floor did not make their style consistent. This review corrects that limitation in the earlier [quality report](sprite-quality-2026-11-13.md).

The twelve original strips remain byte-for-byte unchanged. The selected additions are `public/pets/pace/talk-v2.webp`, `listen-v2.webp`, `dictate-v2.webp`, and the new `hush-v2.webp`. Each is an eight-frame 2048×256 horizontal strip with 256-square frames, intended for 8fps. The quiet pose is a friendly paw-to-muzzle privacy cue. Existing type/review states already cover note-taking, so another near-duplicate state was not added.

## What changed

Original idle is the identity and style reference: 16 opaque colors, exact 2×2 blocks on a 256-square canvas, and feet at y=224. The original sleep strip uses 4×4 blocks on its 512-square canvas, retaining the same logical resolution. Its fading Zzz is intentionally translucent. Seated poses, sleep, and jumping poses were not resized to idle's occupied height.

The new poses were created with the built-in imagegen tool, then normalized for the game's pixel format with ImageMagick. Five images were generated: talk, listen, dictate, hush, and one targeted dictate cleanup. The first dictate candidate had a visibly narrower head; cleanup improved it while preserving the body and foot anchors. No generation retries were spent trying to force the tool's output alpha to be binary.

Raw tool outputs remain soft. Preparation uses a 50% alpha cutoff, the complete canonical 16-color palette with no dithering, fixed per-state scale/translation, a 128-square logical canvas, and a nearest-neighbor 2× enlargement. The alpha mask is retained separately during RGB palette mapping. No Python image editing, anatomical painting, or per-frame bounding-box fitting was used. The exact preparation is in [normalize.sh](../artifacts/sprite-refinement-20261113/normalize.sh).

| State | Before: foreground RGB colors per frame | Before: partially transparent visible pixels | Final colors per frame | Final partial alpha | Final grid |
| --- | ---: | ---: | ---: | ---: | --- |
| Original idle | 16 | 0% | unchanged | 0% | exact 2×2 |
| Talk | 7,670–8,118 | 99.57–99.81% | 15–16 | 0% | exact 2×2 |
| Listen | 7,498–7,903 | 99.63–99.90% | 16 | 0% | exact 2×2 |
| Dictate | 8,309–8,477 | 99.75–99.85% | 16 | 0% | exact 2×2 |
| Hush | new | — | 16 | 0% | exact 2×2 |

Foreground RGB counts use alpha ≥128; the percentage counts all visible pixels with alpha 1–254. Most old foreground alpha was near-opaque, so the percentage alone does not describe visible softness. The old additions also had roughly half their color transitions off the original two-pixel grid; all final transitions align to it.

## Scale and motion checks

Every final frame has floor y=224. Shoe centers are x=149–151 versus idle's x=151. Native-size light/dark comparisons show consistent outline weight, color, head/body scale, and readable eyes, mouth, hands, and shoes. The giant ear remains an intentional dictation feature.

The headband width is a useful independent head-scale proxy, rather than a bounding box including the ear or raised paw. Idle is 90px; talk is 88px, listen 88–90px, hush 88–90px, and dictate 82–86px. Dictate's first frame improved from 78px to 84px after cleanup. A 4–9% width difference remains over that pose's loop; this is a visible-art judgment, not a claim of pixel-identical anatomy.

Adjacent lower-silhouette contour displacement below y=140 is at most 2 source pixels for talk/listen/hush, and 4 for dictate's ear-cupping motion. At 160px display size those are 1.25px and 2.5px. Last-to-first displacement is 2 source pixels for all four. The dictation measurement includes the moving raised paw; it does not imply the whole torso moves by that amount. No per-frame rescaling was used to hide motion.

Passed checks:

- Read-only audit of all 15 prior states and all 16 candidate states; zero strip geometry errors.
- All 32 new frames have binary alpha, exact 2×2 blocks, only canonical palette colors, no clipping, and the correct floor.
- Exact decoded RGBA equality between every final frame PNG and its lossless WebP frame.
- SHA-256 equality for all twelve original strips before/after.
- Both native-size contact sheets and all eight final dictate frames visually inspected; face and limbs remain legible.
- Installed and repository skill copies are identical; both skill validation and the audit script's assert-based self-check pass.

The animated preview is provided for playback review. This asset pass inspected frame sequences and measured adjacent/loop transitions; continuous in-app playback and integration checks belong to the app review. User artistic approval is not implied.

## Reusable skill and evidence

The shareable skill source is [docs/skills/desktop-pet-sprites/SKILL.md](skills/desktop-pet-sprites/SKILL.md). An identical discoverable copy is installed at `~/.codex/skills/desktop-pet-sprites`. It covers canonical identity/style, anatomy-based calibration, bounded imagegen iteration, deterministic pixel preparation, strip contracts, and native-size QA. Pace-specific values live in its optional reference; other pets are not forced into this palette or grid. It explicitly excludes ChatGPT Work Pets and its API.

Evidence is under `artifacts/sprite-refinement-20261113/`:

- [Compact QA summary](../artifacts/sprite-refinement-20261113/qa-summary.json), including final hashes and per-state checks.
- [Exact initial prompts](../artifacts/sprite-refinement-20261113/prompts.json), [dictate cleanup prompt](../artifacts/sprite-refinement-20261113/dictate-cleanup-prompt.txt), and [source provenance](../artifacts/sprite-refinement-20261113/provenance.json).
- `sources/`: all five raw PNGs. `dictate-initial-normalized.webp` retains the superseded first candidate.
- [Cream comparison](../artifacts/sprite-refinement-20261113/previews/native-160-cream.png), [dark comparison](../artifacts/sprite-refinement-20261113/previews/native-160-dark.png), and [8fps loop](../artifacts/sprite-refinement-20261113/previews/selected-states-8fps.gif).
- Complete local `before-audit.json` / `after-audit.json` and intermediate frames are ignored to avoid committing repetitive frame metrics. The compact summary, sources, prompts, preparation commands, and useful previews remain shareable.

Re-run the full final audit from the checkout:

```bash
python3 docs/skills/desktop-pet-sprites/scripts/audit_sprites.py \
  artifacts/sprite-refinement-20261113/candidate-manifest.json \
  --asset-root public/pets/pace \
  --reference artifacts/sprite-review-20261113/idle-reference.png \
  --grid 2 --nominal-size 256 \
  --out artifacts/sprite-refinement-20261113/after-audit.json --self-test
```

The script requires Pillow; preparation and preview scripts require ImageMagick. No app installation, user-profile mutation, external publishing, or model changes were part of this asset work.
