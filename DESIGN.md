---
name: Desktop Pets
description: A pixel companion and its everyday tools.
colors:
  paper: "#f7f0dc"
  surface: "#fff8e8"
  sidebar: "#e7ecd8"
  ink: "#243b2e"
  muted: "#53644f"
  line: "#b6c09e"
  primary: "#b63c31"
  primary-hover: "#8f2d2b"
  primary-pale: "#f2dfc3"
  success: "#426348"
  danger: "#9f322c"
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
    fontFamily: "Silkscreen, monospace"
    fontSize: "30px"
    fontWeight: 400
    lineHeight: 1.22
    letterSpacing: "0"
  title:
    fontFamily: "Silkscreen, monospace"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Silkscreen, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "0"
  campsite-headline:
    fontFamily: "Silkscreen, sans-serif"
    fontSize: "clamp(24px, 2.35vw, 34px)"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "-0.025em"
  dialogue:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "19px"
    fontWeight: 500
    lineHeight: 1.6
  cloud-body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
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
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
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
    backgroundColor: "{colors.cream}"
    textColor: "{colors.forest}"
    rounded: "{rounded.control}"
    padding: "12px"
  campsite-forward:
    backgroundColor: "{colors.dialogue-primary}"
    textColor: "{colors.cream}"
    rounded: "{rounded.control}"
    padding: "13px 17px"
  campsite-dialogue:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.dialogue-ink}"
    typography: "{typography.dialogue}"
    rounded: "{rounded.control}"
    padding: "18px 20px 24px"
---

# Design System: Desktop Pets

## Overview

**Creative North Star: "A calm workspace for a playful little companion."**

Pace brings the play; the interface makes room for the task. The user’s GBA/8-bit direction spans the desktop companion, speech clouds, campsite introduction and supporting workspace. Cream paper, forest outlines, brick-red selections and the original yellow cheetah share one world.

Self-hosted pixel lettering and square controls carry the game character. Editable prose, explanations and transcripts use readable platform sans. The companion’s authored poses remain the focal art; the workspace supports real setup, settings and longer records.

**Key Characteristics:**

- One pixel world across the app
- Cream paper, forest frames and brick-red actions
- Readable long prose beside pixel controls
- Original sprite identity and calibrated new poses
- Explicit, reviewable native actions

## Colors

Warm paper and cream carry the interface; forest greens define frames and readable ink; brick red identifies the next action or selection. The frontmatter owns the exact values.

### Primary

- **Brick action:** primary and hover colors drive workspace actions; dialogue primary and hover supply the companion/campsite variant.
- **Pale brick:** a quiet selected-navigation ground, paired with a visible border and accent edge.

### Secondary

- **Forest:** companion outlines and navigation selection; success green marks actual readiness and provides workspace pixel depth.
- **Danger:** errors use a visible message as well as their red color.

### Neutral

- **Paper and surface:** workspace ground and controls; sidebar uses a pale sage ground.
- **Cream and dialogue paper:** speech clouds and campsite dialogue layering.
- **Ink and muted:** workspace reading hierarchy. Dialogue ink and muted supply the matching campsite/cloud hierarchy.
- **Line and dialogue line:** dividers for real rows and content boundaries.

**The One World Rule.** Carry the pixel vocabulary through the companion and workspace; the campsite is an expression of the shared world, not its boundary.

## Typography

**Display and control font:** self-hosted Silkscreen regular with monospace/sans fallbacks.
**Body font:** the platform sans stack. Monospace remains available for actual JSON and arguments.

The contrast is functional: short game-like labels identify actions; ordinary prose stays comfortable to edit and read.

### Hierarchy

- **Headline:** working page headings; the conversation welcome has its existing larger size (39px, line-height 1.15).
- **Title:** section headings and short grouped labels.
- **Body:** ordinary readable explanations; conversation messages use 13px with line-height 1.85, while cloud replies use the cloud-body role.
- **Label:** compact controls; cloud controls use smaller pixel labels (9–11px) within their fixed native window.
- **Campsite headline:** responsive pixel heading; compact desktop uses 25px, mobile 26px, and wide layouts 36px.
- **Dialogue:** quoted campsite speech; explanations remain smaller platform sans.

**The Readable Prose Rule.** Use Silkscreen for short display and control text; keep editable text, explanations and transcripts in platform sans.

## Layout

The everyday surface is Pace alone in a transparent native pet window. Hovering the sprite or using keyboard focus reveals the three-slot weapon selector beneath him; the idle pet has no visible toolbar. Sprite bounds are 128, 160 or 208px; the square window adds 64px for controls. Talk uses a 420×330 window beside Pace. Explicit autocomplete uses a 420×240 preview above the captured caret and clamps it to the monitor. Cloud content scrolls within persistent header/actions. These dimensions describe the current native surfaces, not a responsive web replacement.

The supporting desktop shell retains its 228px rail, 64px header and scrollable work area, with working content bounded at 1050px and conversation content narrower. At 820px the rail becomes icons; at 600px work columns and meeting layouts stack. Native utility routes have their own compact layouts; the old Writing route remains for compatibility rather than primary navigation.

The introduction has five named stops: **Pack, Meet, Keys, Access, Home**. Model choices come first and downloads remain optional. Its centered split frame is at most 1440px wide, with art left and dialogue right. The grid uses `minmax(0, 1.05fr) minmax(430px, 1fr)`; compact desktop preserves the working pane. At 760px the scene stacks above the dialogue with document scrolling and a scene at least 290px tall. Wide layouts begin at 1500px and cap the frame height at 900px. Stops and forward/back controls sit outside the dialogue’s scrolling body.

## Elevation & Depth

Crisp forest boundaries and layered paper establish the pixel material. Workspace buttons use a small hard offset (2px); working containers use a 3px offset. These literal pixel layers belong to the chosen game world. Companion clouds instead combine inset dialogue lines with a soft ambient shadow, preserving the speech-tail silhouette. Exact shadow values live in the sidecar. Rows and dividers carry information without adding a separate card around every item.

## Shapes

Controls, navigation selections, inputs and principal containers are square. Workspace boundaries are generally 2px; speech clouds use a 3px forest border, stepped corners and a downward pixel tail. The campsite frame is 4px, becoming 3px on mobile. Its current-stop markers are 24px squares. Existing icons keep a consistent stroke vocabulary; the sprite and campsite rasters use nearest-neighbor rendering.

## Components

### Buttons

Square, compact and tactile. Workspace primary/secondary controls use the frontmatter variants, a 2px forest-ink border and a minimum height of 36px. Hover changes the fill; visible keyboard focus uses the accent outline. Quiet controls remove the offset shadow. Campsite forward actions use pixel lettering, a 2px border and a base minimum height of 48px. Optional setup controls retain readable sans labels.

### Inputs / Fields

Square paper fields retain clear labels, nearby validation and visible keyboard focus. Main fields use a success-green boundary and accent outline. Cloud fields use the dialogue ink/paper variant. Copyable generated text remains available when the native target cannot accept an insertion.

### Navigation

The supporting rail uses pixel labels, with sage hover and pale-brick active state, an ink border and inset accent edge. Icon-only navigation retains accessible names. Five campsite stop buttons identify the current step; changing steps focuses the new heading.

### Cards / Containers

Principal work surfaces use square forest borders and pixel offset depth. Transcript turns, model downloads and permission choices remain actual rows. Long text wraps and scrolls within its own region.

### Companion and dialogue clouds

The hover/focus selector below Pace contains **Talk**, **Dictate** and **Write for me**. It fades and lifts into view; the active slot lifts 3px and scales to 1.1 while its neighbors lift 1px and scale to 1.03. Slot motion lasts 140ms; reduced motion removes transitions and transforms. Right-click opens Meeting notes, Pet settings, A tiny victory! and Hide Pace. Talk uses a simple title and Close header, a scrollable answer and a persistent composer with microphone and Send; it does not repeat the three-tool selector. Autocomplete captures nearby field context and optional saved style examples only when invoked; its editable preview offers Accept, Copy and Dismiss. Accept validates the original field before inserting. The legacy Writing route preserves old data/entry points without defining the primary writing experience.

The original twelve sprite actions retain their source timing. Talk, listen and big-ear dictate add eight 256px frames each at 8fps. Real playback drives talking; actual microphone recording drives the dictation pose. Global dictation checks Accessibility access before starting the microphone. Denial shows an explicit Open Accessibility settings action; granted recording uses the big-ear pose without an extra Talk panel, reserving a cloud for copy/error recovery. Imported packs preserve aspect ratio and fall back to idle for missing actions. Reduced motion freezes sprite animation and removes dialogue entrance motion. Sprite provenance and calibration live in `docs/sprite-quality-2026-11-13.md`.

**The Honest State Rule.** A pose, progress indicator or ready label must follow the actual operation; a preview never implies an insertion happened.

## Do's and Don'ts

### Do:

- Do preserve the original Pace artwork, colors and authored timing.
- Do use square controls, forest boundaries and brick-red selections throughout the app.
- Do keep generated prose scrollable, selectable and reviewable.
- Do preserve keyboard focus, accessible names and reduced-motion behavior.
- Do show real model, permission, recording and insertion states.

### Don't:

- Don’t put pixel lettering in long editable prose or transcripts.
- Don’t fabricate replies, transcripts, download completion or capture success.
- Don’t replace the companion’s explicit cursor continuation with a primary rewrite workbench.
- Don’t promise universal screen-capture exclusion or continuous background autocomplete.
