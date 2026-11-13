# Pace sprite quality review — 2026-11-13

The twelve original Pace strips are geometrically correct and retain consistent character scale. No original artwork was replaced. Two new conversation animations were generated and revised with the built-in imagegen tool, calibrated to Pace's existing scale and floor, then accepted after review at the 160px desktop size on light and dark backgrounds. They are saved as `public/pets/pace/talk.webp` and `listen.webp`: eight 256² frames each, intended for 8fps playback.

## Original artwork

Reviewed all 224 frames using RGBA bounding boxes, 8-connected component counts at alpha ≥32, partial-alpha counts, strip dimensions, and contact sheets. The native dimensions exactly match `public/pets/pace/manifest.json`; there is no frame-count or frame-canvas mismatch. Frame slicing in the existing `Pace` component agrees with these dimensions.

| Action | Frames | Canvas | Occupied width | Occupied height | Floor / lowest visible pixel edge |
| --- | ---: | ---: | ---: | ---: | ---: |
| idle | 24 | 256² | 132–136 | 176 | 224 |
| wave | 8 | 256² | 130–166 | 162–172 | 224 |
| think | 24 | 256² | 128–130 | 170 | 224 |
| type | 24 | 256² | 174 | 160 | 224 |
| create | 24 | 256² | 154–156 | 166 | 224 |
| review | 24 | 256² | 138 | 150 | 224 |
| schedule | 24 | 256² | 174 | 164 | 224 |
| sprint | 8 | 256² | 158–182 | 166–180 | 206–224 |
| celebrate | 8 | 256² | 142–176 | 144–198 | 216–224 |
| sleep | 8 | 512² | 436 | 244–256, including Zzz | 448 |
| happy | 24 | 256² | 128–132 | 182 | 224 |
| annoyed | 24 | 256² | 124–128 | 170 | 224 |

Every non-sleep frame is binary alpha and a single connected component. Sleep consists of the body and the intentional floating Zzz. Its 11,984 partial-alpha pixels are confined to that fading Zzz glyph; the cheetah body remains binary alpha. There is no evidence of detached stray artwork in any original frame.

At a common display size, sleep's body is 218×102 pixels, with a head scale visually consistent with idle; its lying-down width is intentional. Retain a sleep runtime scale multiplier of **1.0**. Do not enlarge seated poses to idle's occupied height or normalize jumping poses frame by frame: doing so changes anatomy scale and causes visible pumping. All resting foot positions are already at 87.5% of the frame height. Sprint and celebrate intentionally leave the floor.

The review did not reproduce a source-art size defect. A browser-level artifact may still result from CSS sizing, fractional animation steps, the surrounding layout, or a stale asset. Those are separate from this source-art audit.

Evidence under `artifacts/sprite-review-20261113/`:

- `original-audit.json`: measurements for every original frame.
- `original-first-frames.png`: all twelve actions at a common 256px display size, in alphabetic order.
- `originals/*-all-frames.png`: complete original contact sheets.
- `idle-sleep-scale.png`: direct scale comparison.
- `idle-reference.png`: original frame 0, extracted with no pixel changes.

## Conversation candidates

Built-in imagegen used the original idle frame as the identity reference. The brief preserves the yellow cheetah, dark brown outlines and spots, cream muzzle and belly, red headband, red/white sneakers, tail, stance and palette. Talk changes only the mouth; listen changes only the eyes for a gentle blink. The exact prompt set is saved in `artifacts/sprite-review-20261113/prompts.md`.

Each state received an initial generation and a targeted cleanup generation. All four source PNGs are retained in `candidates/`. The tool returned 1774×887 transparent sheets, arranged as 4×2 cells. ImageMagick cropped/repacked those cells and used nearest-neighbor resampling, transparent padding and canvas cropping to calibrate the frames. No Python image editing, palette painting or alpha thresholding was performed. Python was used for measurements only. Background composites and GIFs are review previews, not production artwork.

| Uncalibrated V2 candidate | Partial-alpha pixels across 8 frames | Body silhouette changes versus frame 0, max | Bottom edge | Initial strict-gate result |
| --- | ---: | ---: | ---: | --- |
| talk | 140,525 | 182 pixels | 224 | Withheld |
| listen | 150,636 | 146 pixels | 218 | Withheld |

Body silhouette comparison uses alpha ≥128 below y=140, excluding the intended eye/mouth expression region. That initial binary-alpha, pixel-identical-body gate was too strict for the requested lively character: a count of changed pixels measures the amount of contour variation, not how far the sprite moves. The listening baseline offset was a real calibration problem and was corrected before delivery.

The opacity assessment below uses the uncalibrated 256² V2 frames. Most partial-alpha pixels are near-opaque, and fully transparent pixels are omitted.

| Alpha range | Talk pixel count | Listen pixel count |
| --- | ---: | ---: |
| 1–15 | 19,017 | 22,827 |
| 16–64 | 2,250 | 1,934 |
| 65–192 | 3,291 | 4,083 |
| 193–239 | 3,088 | 2,916 |
| 240–254 | 112,879 | 118,876 |
| 255 | 447 | 336 |

Mean opacity loss for visible foreground pixels (alpha ≥128) is 1.82% for talk and 1.94% for listen. Within the near-opaque core (alpha ≥240), loss is 0.97% and 1.03%. The assets do retain antialiased/subtle-alpha edge pixels; they are not binary-alpha sprites. At 160px display size, no conspicuous pale or colored fringe was visible against either cream `#e9e7df` or dark `#171c24` backgrounds.

The final calibration uses a fixed transform for every frame within each state, preserving relative expression motion. Talk frames use nearest-neighbor 255² sizing and a +7/+1 canvas offset. Listen frames use nearest-neighbor 251² sizing and a +10/+10 offset. The final canvas is 256². Both states reach a maximum visible height of 176px and floor y=224, matching idle. Shoe centers stay within 1px of idle's x=151 center. Maximum adjacent-frame body-contour displacement is 2 source pixels, or **1.25 displayed pixels at 160px**, including the loop transition. Slight head/body variation remains as breathing motion; it is not a pixel-identical edit of the original body.

Final artifact checks passed: 2048×256 horizontal strip geometry, eight frames, baseline consistency, native-size contour-displacement bound, and exact RGBA lossless WebP roundtrip for all sixteen final frames. WebP encoding uses `lossless=true` and `exact=true`, preserving even RGB values under zero alpha. The original strips remain untouched.

The earlier packed `talk-v2-strip.webp` and `listen-v2-strip.webp` remain review artifacts and are not the calibrated final artwork. `candidate-audit.json` preserves the initial strict assessment; `candidate-opacity-assessment.json` and `calibrated/qa.json` record the meaningful final checks. `calibrated/native-160-{cream,dark,transparent}.png` contains original idle, talking closed mouth, talking open mouth, and listening blink. `calibrated/idle-talk-listen-8fps.gif` compares idle/talk/listen on both backgrounds in a two-second loop, with alternating 120/130ms GIF delays for an average 8fps.

Generated source provenance, also retained in the workspace:

| Asset | Built-in generated source filename |
| --- | --- |
| talk v1 | `exec-e38d5ae6-88e1-43bb-a9be-9c35db4ff8db.png` |
| listen v1 | `exec-58da74ae-9694-48c1-9225-263f5742cae4.png` |
| talk v2 | `exec-7e189255-5aaf-4457-a38c-f39d965b9975.png` |
| listen v2 | `exec-59dc6523-859b-493e-863c-51e7e43060ee.png` |

Original generation directory: `/Users/rebzj/.codex/generated_images/01a1d3c5-d484-7962-9542-0ac6cf9512c6/`.

Application wiring and independent in-app motion review belong to the frontend integration. This asset review validates geometry, opacity appearance and motion bounds; it does not claim pixel-identical body preservation or final user artistic approval.

## Dictation: the big listening ear

The later explicit brief adds a distinct global-dictation pose: one oversized comic cheetah ear, properly attached to Pace's head, with a raised paw cupping it and a small sound-wave cue. The mouth stays closed. This state is intended for actual active dictation recording; application behavior determines when to show it.

One built-in imagegen call used the original idle frame and approved listen frame 0 as identity references. The resulting 1774×887, 4×2 source sheet is preserved at `candidates/dictate-v1-source.png`. Full prompt: `dictate-prompt.md`. Generated source filename: `exec-5c615561-fea4-4c03-8772-e869251b0582.png`, in the same original generation directory listed above. No extra cleanup generation was needed after native-size review.

The generation centered the wider ear composition, so fixed geometric calibration restores the original body scale and shoe position. Each extracted 256² cell is nearest-neighbor resized to 235², offset +30px horizontally, and positioned with its feet at y=224; transparent padding restores a 256² canvas. The source's lower row needs a 14px vertical offset and its upper row a 15px offset. The safe small-wave source frames are sequenced **0, 1, 5, 7, 5, 1, 0, 0**, creating an eight-frame receptive ear/paw motion without clipping the larger-wave variants after body centering.

Final artwork: `public/pets/pace/dictate.webp`, 2048×256, eight 256² frames, intended for **8fps**, 155,778 bytes. The existing twelve original strips and the accepted talk/listen artwork remain untouched by this addition.

- Every frame's floor is y=224 and shoe center is x=151–151.5.
- Visible height including the large ear is 184–186px, only 8–10px above the canonical 176px body height; the body itself is not enlarged to fill the ear's bounding box.
- All visible art stays within x=68–245 and y=38–224, leaving canvas margins.
- Maximum adjacent body-contour displacement below y=140 is 3 source pixels, or **1.875 pixels at 160px**; this includes the loop transition.
- Exact RGBA lossless WebP roundtrip passed all eight frames.
- Native 160px review on cream and dark backgrounds showed no conspicuous colored or pale fringe. The cue is intentionally subtle on the dark background because it retains the mascot's dark outline color.

The final alpha distribution is 24,952 pixels at 1–15, 3,097 at 16–64, 3,914 at 65–192, 3,631 at 193–239, 135,635 at 240–254, and 366 fully opaque pixels. Mean opacity loss is 1.89% in visible foreground (alpha ≥128) and 1.05% in the near-opaque core (alpha ≥240). As with talk/listen, the generated artwork is not binary-alpha.

Measurements: `calibrated/dictate-qa.json`. Native-size comparisons: `calibrated/dictate-native-160-{cream,dark}.png` (idle, listen, and two dictation frames). Motion preview: `calibrated/dictate-8fps.gif` (idle/listen/dictate, cream above dark, one-second 8fps loop). The frontend owns recording-state wiring, metadata and starter-pack inclusion.
