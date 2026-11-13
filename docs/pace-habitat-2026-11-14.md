# Pace’s habitat and live conversation — 2026-11-14

Home now defaults to Pace’s campsite, reusing `public/onboarding/pace-camp.webp`. The resident Pace can be petted, summoned or sent home. Chat, Dictate and Meeting notes stay visible in the clearing. A persistent little chat icon above the desktop pet opens the same 300×220 conversation bubble; hover/focus reveals the other tools. The implementation lives in `src/PaceHome.tsx`, `src/pace-home.css`, `src/PetCompanion.tsx` and `src/ChatCloud.tsx`.

Opening chat is passive. Typing preserves drafts and IME composition and displays actual reply deltas. One explicit **Start voice conversation** begins automatic local Listen → Think → Speak → Listen turns, with English ASR, Qwen and Kitten’s Kiki voice by default. The microphone is released during transcription, thinking and playback, so Pace cannot hear interruptions during a reply. End remains reachable during work/errors; End, close and hide stop the session. See [portable voice validation](portable-voice-validation-2026-11-14.md) for installed model, actual inference evidence and hardware limits. Writing and cursor autocomplete remain deferred; dictation and meeting workflows remain available.

## Selected transition assets

| Action | Production strip | Timing |
| --- | --- | --- |
| Summon / pop out | `public/pets/pace/summon-v1.webp` | Eight 256×256 frames, 8fps, one second, one shot |
| Send home / burrow | `public/pets/pace/burrow-v1.webp` | Eight 256×256 frames, 8fps, one second, one shot |

Normal send-home finishes the burrow before hiding the native pet window and leaves the campsite open. Quick Hide covers the app’s windows immediately and stops voice chat. The summon final frame and burrow first frame reuse `artifacts/sprite-review-20261113/idle-reference.png` exactly. Original actions retain their artwork and timing; reduced motion freezes sprite playback.

## Provenance and reproduction

Three built-in ImageGen calls produced one summon source, one burrow source and a targeted burrow cleanup restoring the gold paws. No CLI/API generation fallback was used. The selected sources are `artifacts/pace-holes-v1/sources/summon-v1-source.png` and `artifacts/pace-holes-v1/sources/burrow-v2-source.png`. Original Pace artwork is credited to Outpaced / Desktop Pets, CC BY 4.0; these are generated derivatives.

The complete prompts are in [`prompts.json`](../artifacts/pace-holes-v1/prompts.json) and [`burrow-cleanup-prompt.txt`](../artifacts/pace-holes-v1/burrow-cleanup-prompt.txt). [`provenance.json`](../artifacts/pace-holes-v1/provenance.json) records original output paths, source hashes, selected sources, palette/alpha processing, translations and exact idle anchors. To reproduce normalization from the retained sources, run `bash artifacts/pace-holes-v1/normalize.sh` with ImageMagick, then `python3 artifacts/pace-holes-v1/verify.py` with Pillow. Generation itself is nondeterministic; these commands reproduce the prepared assets from saved sources.

[`qa-summary.json`](../artifacts/pace-holes-v1/qa-summary.json) and [`audit.json`](../artifacts/pace-holes-v1/audit.json) retain checks for the canonical palette, binary alpha, exact 2px grid, clipping, decoded frames and idle anchors. Native-size cream/dark contact sheets and 160px, 8fps review GIFs are under `artifacts/pace-holes-v1/previews/`; the GIFs loop for review only.

## Validation and limits

The integrated browser suite passed 91 Chromium and 91 WebKit tests, including campsite routing, visible chat access, transition timing contracts, voice lifecycle, actual stream handling and stale-session/context guards. Browser fixtures do not establish physical microphone or playback behavior. Generated intermediate facial pixels/head proportions vary slightly from the original, and the hole rim varies by one logical pixel. The Mac was locked, so the actual native interface and native animation playback could not be inspected. No live microphone/speaker conversation or new permission grants were used for this work.
