# Desktop Pets

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Confirmed execution brief: React and TypeScript inside a Tauri desktop app. A browser build supports development and automated tests; native capture and local inference belong to the desktop host.

## Users

People who want a playful desktop companion that can help with dictation, diarized meeting notes and a meeting copilot. The first release targets Apple Silicon Macs with 16 GB or more memory and macOS 15 or newer; cross-platform architecture is required. Supported languages are English, Chinese, Japanese and Spanish.

## Product Purpose

Pace is a small animated companion that stays nearby and offers useful local assistance without requiring a cloud account. The pet and its 8-bit tool clouds are the everyday interface: a semicircle icon selector above Pace for Dictate, Meeting and Settings. The workspace supports setup and longer records. Success means work feels tangible and fun, controls are understandable, and useful work has explicit, reviewable results.

## Capabilities and Constraints

The current product has three jobs: explicit dictation into another application with a recoverable draft, diarized meeting transcription and notes, and a quiet copilot scoped to the selected meeting. General chat, persona voice, Write for me and cursor autocomplete are outside the current product flow. Stored chat rows, drafts and previous settings remain intact. Existing memory inspection/delete and extension review/revoke remain available through Settings → Data & extensions; their opt-ins are not changed.

Native capabilities and model availability must be shown honestly. Never manufacture assistant messages, transcripts, meeting notes, installed models or capture results. Speaker labels are not automatically known real identities. Quick hide covers all five native windows, including the inactive legacy command window. Capture protection is best effort across the tested capture paths, not a promise of universal invisibility. Core listening should have a portable capability boundary; native implementation and verification remain platform-specific.

### Everyday flows

After completed setup, startup keeps the main workspace hidden and shows idle Pace alone. Hover or keyboard focus reveals three icon tools in a semicircle above him: Dictate, Meeting and Settings. The pet has no labels underneath. The icon menu follows the ring-command interaction reference in Nintendo’s *Secret of Mana* manual; all artwork is original. Right-click offers Meeting notes, Controls & look, A tiny victory! and Hide Pace. The workspace opens only through an explicit action.

The shared bubble is a 300×200 dictation surface. Opening it is passive: it reads the actual `dictation.current` snapshot and subscribes to actual state and microphone levels. Start/Stop invokes global dictation explicitly. Real recording and transcription drive listening/thinking emotes; no greeting, general chat, spoken reply or synthetic level animation appears. Recognition remains editable and copyable when Accessibility insertion is unavailable. A separate session draft preserves reviewed words without touching existing chat draft keys. Failed recognition offers Retry saved audio only when the backend reports recoverable audio. Retry never automatically inserts into an old target.

Write for me and cursor autocomplete remain deferred. Their controls, shortcut binding, practice and style-example fields are unavailable. The old Chat and Writing pages open meeting records; legacy command windows show only a paused notice and Close.

Meeting live words, quiet tips and subsequent notes share one 420×380 cloud (360×300 minimum). Start and Stop are explicit; Close and Quick Hide leave an active recording running. Cover requested reflects the default best-effort capture request, with a visible explanation of macOS sharing limits. Settings displays Requested · Quick hide ready as status; there is no cover-off toggle in the product flow. A single question input and reply use only this meeting’s transcript and stay quiet. Stop remains available while a question is being answered; late replies cannot appear in a different meeting. The workspace holds full records and exports.

First setup has five stops: Pack, Meet, Keys, Access and Home. Pack comes first with optional downloads: the selected dictation pack and the optional 3.06 GB Qwen3.5 4B meeting brain; meeting extras remain separately installable. Keys configures and practices all three active shortcuts with the same actual key recorder used in Settings, not preset dropdowns. Save waits for acknowledgement; Escape, blur and a 45-second timeout cancel unsaved capture. Native bindings unregister during recording and restore afterward. Defaults are Alt+Space (open the dictation window), Alt+Shift+D (Dictate), and Alt+Shift+Space (Quick Hide).

## Brand Commitments

Product name: Desktop Pets. Mascot name in this project: Pace. Reuse the existing yellow pixel cheetah with red headband and shoes, whose source project names it Velo. Preserve the twelve original actions, artwork and timings, with refined v2 talking, listening, big-ear dictation and hush poses calibrated to the same identity, pixel grid, palette and floor. Dictate retains a documented 4–9% headband-width variation. The user explicitly expanded the 8-bit/GBA direction across the whole interface: cream dialogue, forest framing, brick-red selections, square controls, pixel lettering and speech clouds. Camp, Night and Handheld palettes use deterministic OKLCH seeds. The default pairs Pixelify Sans headings/controls with Inter prose; Inter and Fira Sans are optional shared-face settings. Active fonts are bundled with pinned sources and OFL licenses.

## Evidence on Hand

Twelve existing lossless WebP sprite strips and metadata from the user's Outpaced project, copied without pixel changes. No performance, audience, security audit or operating-system compatibility claims have been established by this UI work.

## Product Principles

- The companion is the everyday interface; tools feel like its 8-bit action selector.
- Local actions explain their permissions and show real state.
- Generate a result for review before applying it elsewhere.
- A missing capability has a useful explanation and recovery action.

## Licensing

The confirmed license choice is MIT for code and CC-BY-4.0 for the mascot artwork. Model weights retain their own upstream licenses.
