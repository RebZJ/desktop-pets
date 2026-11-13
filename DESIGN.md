---
name: Desktop Pets
description: A pixel companion and its everyday tools.
colors:
  paper: "#f6eed8"
  surface: "#fff8e6"
  sidebar: "#dbe6ca"
  ink: "#1c3422"
  muted: "#445540"
  line: "#a7b395"
  accent: "#9e2e21"
  accent-hover: "#7c1e14"
  accent-pale: "#f8d9af"
  green: "#325033"
  danger: "#942318"
  on-accent: "#fff8e6"
  forest: "#203d2d"
  deep-forest: "#152b21"
  cream: "#fff5d9"
  dialogue-paper: "#faf0d6"
  dialogue-ink: "#233c2c"
  dialogue-muted: "#596046"
  dialogue-line: "#d4c9a5"
  dialogue-primary: "#a83e29"
  dialogue-primary-hover: "#8d2e1d"
typography:
  headline:
    fontFamily: "Pixelify Sans, sans-serif"
    fontSize: "32px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0"
  title:
    fontFamily: "Pixelify Sans, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "0"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Pixelify Sans, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "0"
  campsite-headline:
    fontFamily: "Pixelify Sans, sans-serif"
    fontSize: "clamp(24px, 2.35vw, 34px)"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "-0.025em"
  dialogue:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "19px"
    fontWeight: 500
    lineHeight: 1.6
  cloud-body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
rounded:
  control: "0px"
spacing:
  tight: "8px"
  control: "12px"
  group: "20px"
  section: "30px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  cloud:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px"
  campsite-forward:
    backgroundColor: "{colors.dialogue-primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "13px 17px"
  campsite-dialogue:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.dialogue-ink}"
    typography: "{typography.dialogue}"
    rounded: "{rounded.control}"
    padding: "18px 20px 24px"
---

# Design System: Desktop Pets

## Overview

**Creative North Star: "A calm workspace for a playful little companion."**

Pace brings the play; the interface makes room for the task. The user’s GBA/8-bit direction spans the native desktop pet, speech clouds, campsite introduction and supporting workspace. Square controls, crisp outlines and the original yellow cheetah share one world.

Three selected palettes change the scenery: Camp, Night and Handheld. Bundled Pixelify Sans gives short headings and controls their game character; Inter keeps prose comfortable to read. The companion’s authored poses remain the focal art. Setup, settings and longer records open through explicit workspace actions.

**Key Characteristics:**

- One pixel world across the app
- Three palettes with semantic color roles
- Readable prose beside pixel controls
- Original sprite identity and calibrated new poses
- Explicit, reviewable native actions

## Colors

The frontmatter records the current default Camp palette and the campsite’s scoped art/dialogue colors. Runtime theme roles come from `src/pixel-theme.css`, generated from deterministic OKLCH seeds by `scripts/generate-themes.mjs`. The script converts to sRGB, reduces out-of-gamut chroma and asserts readable text/action contrast. Its `--check` mode detects drift without writing.

### Primary

The accent and hover roles identify actions and selections; on-accent carries their text. Camp uses brick red, Night uses gold, and Handheld uses deep green. Pale accent grounds selected navigation and recovery messages.

### Secondary

Green identifies actual readiness and supplies pixel offset depth. Danger always accompanies a readable error. Handheld intentionally shares green tones across several roles; meaning must also survive in text and icons.

### Neutral

Paper, surface and sidebar distinguish work areas. Ink, muted and line establish reading hierarchy and real content boundaries. Night uses navy grounds; Handheld uses four greens. Camp is the default cream-and-forest world. Campsite scenery and its local forest/cream art colors remain authored assets, while shared font settings reach its controls and prose.

**The One World Rule.** Carry the pixel vocabulary through the companion and workspace; the campsite is an expression of the shared world, not its boundary.

## Typography

The default interface setting is **Pixel**: self-hosted Pixelify Sans for headings and short controls, Inter for explanations, editable text and transcripts. **Inter** and **Fira Sans** are selectable alternatives that use one face for both roles. The three active families ship locally with their OFL files and pinned source hashes in `public/fonts/SOURCES.md`; no font CDN is required. Retained Silkscreen assets are historical, not the active default.

The workspace headline is 32px/1.2, section titles 18px/1.35, ordinary prose 14px/1.65, and common controls 13px. Compact cloud controls use 9–11px labels; Dictation drafts use readable 13px/1.5 prose. Responsive campsite headings retain their own scale.

**The Readable Prose Rule.** Use the selected interface face for short headings and controls; keep editable text, explanations and transcripts in the selected body face.

## Layout

Pace rests alone in a transparent native Tauri window. Hover or keyboard focus reveals four compact icon tools in a semicircle **above** him: Dictate, Chat, Meeting and Settings. There are no labels beneath the pet. A focused/hovered icon supplies its own hint and accessible name. Dictate hints “Type into your app.” Sprite sizes are 128, 160 or 208px, with a square native window 64px larger.

Dictation uses a 240×76 bottom-center widget, expanding only for recovery. Meeting recording uses a 300×64 strip; full notes and transcript open in the workspace. Chat uses an explicit 300×200 speech bubble. Persistent controls surround scrolling content. These are native utility windows, not a web dashboard that opens on startup.

The supporting workspace uses 1180×780 with an 800×560 minimum, a 228px rail and a 64px header. At 820px the rail becomes icons; at 600px work columns stack. The 390×844 browser layout is a development/test viewport, not a mobile release. Writing surfaces are deferred; old Chat and Writing pages open meeting records, and legacy command windows show only a paused notice and Close. Stored preferences remain intact.

Onboarding has five stops: **Pack, Meet, Keys, Access, Home**. Its split frame places art left and dialogue right, capped at 1440px; at 760px the scene stacks above the dialogue. Stops and forward/back controls remain outside the scrolling dialogue body. Downloads and access are explicit and optional.

## Elevation & Depth

Crisp boundaries and layered paper establish the pixel material. Workspace controls use a small hard offset (2px); principal working containers use 3px. Companion clouds combine inset dialogue lines and a soft ambient shadow around a stepped speech tail. Selector icons use quiet ambient depth. Exact shadow and motion values live in the sidecar. Rows carry information without a separate card around every item.

## Shapes

Controls, navigation selections, fields and principal containers are square. Workspace boundaries are generally 2px; clouds have a 3px ink border and a downward pixel tail. Campsite framing uses its original 4px boundary, reducing to 3px on mobile. Icons use consistent strokes; pet and campsite rasters use nearest-neighbor rendering.

## Components

### Buttons

Compact square controls have explicit hover, disabled and visible keyboard-focus states. Primary actions use accent/on-accent roles, a 2px ink boundary and the shared interface face. Quiet controls omit offset depth. Native utility controls fit their fixed compact windows without removing accessible names.

### Inputs / Fields

Paper fields retain labels, nearby validation and visible focus. Longer text uses the body face. The shared shortcut recorder serves all four bindings in both Settings and onboarding: click, press a real key combination, then Save or Enter. Escape, blur and a 45-second recording timeout cancel unsaved capture. Native shortcuts unregister during recording and restore afterward; validation rejects reserved keys and conflicts for edited bindings while preserving unchanged legacy bindings. Save waits for acknowledgement. No preset dropdown defines a shortcut.

### Navigation

The primary rail exposes Meeting notes, Local models and Settings. Saved memory and extension access remain manageable through Settings → Data & extensions. Explicit text chat uses a small speech bubble; persona voice remains paused. The supporting rail uses the selected interface face, sidebar hover and pale-accent selection with an ink border and inset accent edge. Icon-only destinations retain accessible names. Five onboarding stop buttons identify the current step.

### Cards / Containers

Principal work surfaces use square boundaries and pixel offset depth. Transcript turns, downloads and permission choices are actual rows. Long text wraps and scrolls inside its reading region.

### Companion and dialogue clouds

The compact four-icon arc above Pace follows the ring-command interaction reference in Nintendo’s *Secret of Mana* manual, **Ring Commands** section. It is an original tool selector, with explicit activation, keyboard navigation and no Nintendo artwork. Icons reveal in three short pixel steps; hover lifts the active icon by 2px and scales it to 1.10, with quieter neighboring lift. Reduced motion removes transitions and transforms. The [official manual](https://www.nintendo.com/es-es/games/oms/snes-classic/manuals/secret-of-mana/manual.pdf) is the primary reference.

The dictation bubble has a compact portrait/status header, Copy, Close, an editable recognized draft and one persistent Start/Stop control. Actual recording/transcription state drives listening/thinking emotes. A real RMS meter appears only during recording. Opening the window never records. Recognition remains reviewable/copyable without Accessibility. Saved-audio retry appears only when actual backend state permits it. Existing chat draft keys remain untouched.

Cursor autocomplete has no active control, shortcut, onboarding practice or style-example field. Meeting assistance keeps actual live words, one quiet session-scoped tip, a transcript-scoped question/reply, final notes and note editing in the same cloud. The question composer and Stop remain reachable; reading content scrolls inside the cloud. Answers never speak or cross meeting boundaries. **Cover requested** is the default best-effort state, not a guarantee. Settings displays Requested · Quick hide ready without an off toggle. Quick Hide covers all five windows without stopping an active meeting.

The twelve original sprite strips retain their artwork and timing. Talk, listen, dictate and hush use refined v2 eight-frame strips at 8fps with the canonical palette, exact pixel grid and binary alpha. Dictate’s headband remains 4–9% narrower over its loop; do not describe anatomical identity as pixel-exact. Provenance, measurements and the reusable skill are in `docs/sprite-refinement-2026-11-13.md` and `docs/skills/desktop-pet-sprites/SKILL.md`. Reduced motion freezes animation.

**The Honest State Rule.** A pose, progress indicator or ready label must follow the actual operation; a preview never implies an insertion happened.

## Do's and Don'ts

### Do:

- Do preserve the original Pace artwork, colors and authored timing.
- Do use the selected palette’s semantic roles across the workspace and clouds.
- Do keep generated prose scrollable, selectable and reviewable.
- Do preserve keyboard focus, accessible names and reduced-motion behavior.
- Do show real model, permission, recording and insertion states.

### Don't:

- Don’t put pixel lettering in long editable prose or transcripts.
- Don’t fabricate replies, transcripts, download completion or capture success.
- Don’t place persistent labels or a tool strip beneath Pace.
- Keep deferred writing controls and shortcut bindings out of current product flows.
- Don’t promise universal screen-capture exclusion or continuous background autocomplete.
