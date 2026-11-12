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
rounded:
  control: "7px"
  input: "8px"
  panel: "12px"
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
---

# Design System: Desktop Pets

## Overview

**Creative North Star: "A calm workspace for a playful little companion."**

Pace brings the play; the workspace makes room for the task. Warm paper, brick red actions and the original cheetah artwork connect the desktop utility to its mascot without dressing up familiar controls.

The approved execution brief fixes the paper palette, orange/red character accents and quiet density. This is an operating interface: navigation, forms, transcripts, model downloads and explicit actions remain conventional. The signature interaction is the real sprite companion changing authored poses as it is petted, works and rests.

**Key Characteristics:**

- Warm paper surfaces
- Quiet task-focused density
- Original pixel sprite actions
- Explicit, reviewable operations

## Colors

Brick red identifies the primary action and current navigation state. Warm neutrals carry surfaces, boundaries and readable secondary text. Green marks a genuinely ready local capability. Permission failures and recording states use their own visible labels as well as color.

## Typography

Use the platform sans stack for headings and ordinary controls. The chat welcome has a larger fixed heading; working pages use a tighter hierarchy. Reserve monospace for actual JSON, arguments and data. Long generated text wraps, preserves its line breaks and stays within a readable measure.

## Layout

The desktop shell has a 228px navigation rail, a 64px header and a scrollable work area. Working content is bounded at 1050px; chat is narrower. The rail contracts to icons at 820px, keeping accessible names and hover titles. Writing columns stack below 600px. Native pet, writing and speech windows use separate URL routes and compact layouts.

## Elevation & Depth

Paper tone and single hairline borders establish hierarchy. The composer, transient speech bubble and notifications use soft, offset shadows. Working sections use dividers and rows rather than nested cards.

## Shapes

Controls use small rounded corners; larger panels use slightly softer corners. Pills are reserved for small state labels. Lucide icons share a consistent stroke vocabulary. Pixel edges belong to the sprite artwork, which always uses nearest-neighbor rendering.

## Components

Buttons have primary, secondary, quiet and destructive variants with visible keyboard focus. Ordinary buttons have a minimum height of 36px and can grow with their content. Toggle switches expose their checked state. Each form keeps its labels, validation, loading and error recovery near the action.

The writing flow separates the captured or pasted source from an editable suggestion. Apply stays explicit and unavailable when the source app cannot accept changes. Meeting transcripts, model downloads and tool results show actual returned data. Extension permissions and the reviewed-arguments confirmation are separate controls.

Sprite metadata owns frame counts and timing. Imported pet packs fall back to their idle action when an action is missing, preserve their frame aspect ratio and fit inside the chosen pet size. Reduced motion freezes sprites and removes transitions.

## Do's and Don'ts

- Do keep the original Pace artwork, colors and authored pose timing intact.
- Do use real native state and explain unavailable desktop capabilities.
- Do keep generated text reviewable before applying or running it.
- Do keep navigation and form controls familiar and keyboard accessible.
- Don't fabricate assistant replies, transcripts, download completion or capture success.
- Don't imply macOS screen-capture exclusion; expose quick hide clearly.
- Don't add decorative texture, fonts or repetitive dashboard tiles to the workspace.
