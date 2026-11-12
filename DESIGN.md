---
name: Desktop Pets
description: A calm workspace for a playful little companion.
colors:
  paper: "#faf8f4"
  surface: "#fffdf9"
  sidebar: "#f0ece4"
  ink: "#332f29"
  secondary-text: "#756650"
  line: "#e5dfd5"
  primary: "#b74930"
  primary-hover: "#9d3823"
  primary-text: "#fff9f3"
  primary-pale: "#f5e4da"
  success: "#567259"
  onboarding-forest: "#203d2d"
  onboarding-deep: "#152b21"
  onboarding-cream: "#fff5d9"
  onboarding-paper: "#faf0d6"
  onboarding-ink: "#233c2c"
  onboarding-muted: "#596046"
  onboarding-line: "#d4c9a5"
  onboarding-primary: "#a83e29"
  onboarding-primary-hover: "#8d2e1d"
  onboarding-frame: "#9da87e"
  onboarding-control-border: "#8b9677"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "30px"
    fontWeight: 650
    lineHeight: 1.22
    letterSpacing: "-0.035em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 550
  onboarding-headline:
    fontFamily: "Silkscreen, sans-serif"
    fontSize: "clamp(24px, 2.35vw, 34px)"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "-0.025em"
  onboarding-lead:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.65
  onboarding-dialogue:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "19px"
    fontWeight: 500
    lineHeight: 1.6
  onboarding-label:
    fontFamily: "Silkscreen, sans-serif"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.5
  onboarding-action:
    fontFamily: "Silkscreen, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  control: "7px"
  input: "8px"
  panel: "12px"
  onboarding-control: "0px"
spacing:
  tight: "8px"
  control: "12px"
  group: "20px"
  section: "30px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.input}"
    padding: "10px 12px"
  onboarding-button-primary:
    backgroundColor: "{colors.onboarding-primary}"
    textColor: "{colors.onboarding-cream}"
    typography: "{typography.onboarding-action}"
    rounded: "{rounded.onboarding-control}"
    padding: "13px 17px"
  onboarding-button-primary-hover:
    backgroundColor: "{colors.onboarding-primary-hover}"
  onboarding-button-secondary:
    backgroundColor: "{colors.onboarding-cream}"
    textColor: "{colors.onboarding-ink}"
    rounded: "{rounded.onboarding-control}"
    padding: "8px 10px"
  onboarding-dialogue:
    backgroundColor: "{colors.onboarding-cream}"
    textColor: "{colors.onboarding-ink}"
    typography: "{typography.onboarding-dialogue}"
    rounded: "{rounded.onboarding-control}"
    padding: "18px 20px 24px"
  onboarding-stop:
    backgroundColor: "{colors.onboarding-paper}"
    textColor: "{colors.onboarding-forest}"
    rounded: "{rounded.onboarding-control}"
    size: "24px"
  onboarding-stop-current:
    backgroundColor: "{colors.onboarding-primary}"
    textColor: "{colors.onboarding-cream}"
---

# Design System: Desktop Pets

## Overview

**Creative North Star: "A calm workspace for a playful little companion."**

Pace brings the play; the workspace makes room for the task. Warm paper, brick red actions and the original cheetah artwork connect the desktop utility to its mascot without dressing up familiar controls.

The approved execution brief fixes the paper palette, orange/red character accents and quiet density. This is an operating interface: navigation, forms, transcripts, model downloads and explicit actions remain conventional. The signature interaction is the real sprite companion changing authored poses as it is petted, works and rests.

The first-run introduction has a bounded companion world: **Pace’s campsite**, the user's requested GBA-style pixel adventure. Forest framing, cream dialogue paper, Silkscreen lettering and the original campsite surround the unchanged Pace sprite. All `onboarding-*` tokens apply only to this introduction and its Settings replay; the workspace keeps its existing palette, platform typography and rounded controls.

**Key Characteristics:**

- Warm paper surfaces
- Quiet task-focused density
- Original pixel sprite actions
- Explicit, reviewable operations
- A pixel campsite for the first meeting

## Colors

Brick red identifies the primary action and current navigation state. Warm neutrals carry surfaces, boundaries and readable secondary text. Green marks a genuinely ready local capability. Permission failures and recording states use their own visible labels as well as color.

### Onboarding only

The `onboarding-*` palette is local to the campsite. Forest and deep green establish the frame and outer ground; cream and paper distinguish speech from the dialogue pane. Ink and muted green carry readable text, the line color divides real setup rows, and brick-red primary colors identify the current stop and forward action. The sage frame and control-border tokens edge the scene and optional setup controls.

**The Campsite Boundary Rule.** Apply the onboarding palette only inside the onboarding shell; workspace tokens retain their current roles.

## Typography

Use the platform sans stack for headings and ordinary controls. The chat welcome has a larger fixed heading; working pages use a tighter hierarchy. Reserve monospace for actual JSON, arguments and data. Long generated text wraps, preserves its line breaks and stays within a readable measure.

### Onboarding only

Self-hosted Silkscreen regular supplies pixel headings, stop labels, sprite speech cues and the forward action. Platform sans carries explanations, model names, access details and spoken dialogue. The frontmatter records the base desktop hierarchy. At compact desktop height the heading becomes 25px and lead 13px; at mobile width they become 26px and 14px. Wide screens use a 36px heading. Keep pixel lettering out of long explanations.

## Layout

The desktop shell has a 228px navigation rail, a 64px header and a scrollable work area. Working content is bounded at 1050px; chat is narrower. The rail contracts to icons at 820px, keeping accessible names and hover titles. Writing columns stack below 600px. Native pet, writing and speech windows use separate URL routes and compact layouts.

### Onboarding only

The campsite uses a centered split frame up to 1440px wide: scene left, dialogue right. The desktop grid is `minmax(0, 1.05fr) minmax(430px, 1fr)`; compact desktop narrows the art to preserve the working pane. Stop navigation and forward/back controls remain outside the scrolling dialogue body. At 760px and below the scene stacks above the dialogue, with document scrolling and a scene at least 290px tall. At 1500px and above the frame is at most 900px tall. The base dialogue padding is 30px 34px 28px; native minimum and mobile layouts reduce it. The four stops are Meet, Pack, Access and Home, all directly navigable.

## Elevation & Depth

Paper tone and single hairline borders establish hierarchy. The composer, transient speech bubble and notifications use soft, offset shadows. Working sections use dividers and rows rather than nested cards.

The campsite adds a soft frame shadow and layered inset dialogue lines. Forest borders separate art, speech and setup without covering the scene. Optional models and access remain divided rows. Exact onboarding shadows live in the sidecar; they do not change workspace elevation.

## Shapes

Workspace controls use small rounded corners; larger panels use slightly softer corners. Pills are reserved for small state labels. Lucide icons share a consistent stroke vocabulary. Workspace pixel edges belong to the sprite artwork, which always uses nearest-neighbor rendering.

The campsite has square controls, stepped speech-tail geometry and crisp pixel art. Its outer frame is 4px, becoming 3px on mobile; speech borders are 3px and current-stop markers are 24px squares. Landscape and sprite rendering preserve pixel edges. This form language is scoped to onboarding.

## Components

Buttons have primary, secondary, quiet and destructive variants with visible keyboard focus. Ordinary buttons have a minimum height of 36px and can grow with their content. Toggle switches expose their checked state. Each form keeps its labels, validation, loading and error recovery near the action.

The writing flow separates the captured or pasted source from an editable suggestion. Apply stays explicit and unavailable when the source app cannot accept changes. Meeting transcripts, model downloads and tool results show actual returned data. Extension permissions and the reviewed-arguments confirmation are separate controls.

Sprite metadata owns frame counts and timing. Imported pet packs fall back to their idle action when an action is missing, preserve their frame aspect ratio and fit inside the chosen pet size. Reduced motion freezes sprites and removes transitions.

### Onboarding only

- **Forward action:** square brick-red button with pixel type, a 2px border and a base minimum height of 48px. Hover deepens its color; visible keyboard focus uses a 3px outline. Optional Download/Allow controls use platform sans and a base minimum height of 36px.
- **Dialogue:** cream speech inset inside the paper pane, a forest border, thin inset lines and readable platform text. The speaker name identifies actual quoted dialogue.
- **Stop navigation:** four named buttons with a current-step marker and connecting rule. Changing stops focuses the new heading. The dialogue entrance moves 5px over 250ms and is removed under reduced motion.
- **Live companion and setup:** petting uses Pace’s authored actions. Model readiness/progress and access states come from the application. Errors stay near the action, completion is acknowledged before leaving, and downloads and OS access each require their own click.

## Do's and Don'ts

- Do keep the original Pace artwork, colors and authored pose timing intact.
- Do use real native state and explain unavailable desktop capabilities.
- Do keep generated text reviewable before applying or running it.
- Do keep navigation and form controls familiar and keyboard accessible.
- Do keep the campsite palette, Silkscreen lettering and square frames scoped to onboarding and its replay.
- Do preserve readable sans explanations, optional setup and reduced-motion behavior in the campsite.
- Don't fabricate assistant replies, transcripts, download completion or capture success.
- Don't imply macOS screen-capture exclusion; expose quick hide clearly.
- Don't add decorative texture, fonts or repetitive dashboard tiles to the workspace.
