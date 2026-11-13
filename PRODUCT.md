# Desktop Pets

<!-- impeccable:product-schema 1 -->

## Platform

desktop

## Stack

Confirmed execution brief: React and TypeScript inside a Tauri desktop app. A browser build supports development and automated tests; native capture and local inference belong to the desktop host.

## Users

People who want a playful desktop companion that can help with writing, conversations and meeting notes. The first release targets Apple Silicon Macs with 16 GB or more memory and macOS 15 or newer; cross-platform architecture is required. Conversation languages are English, Chinese, Japanese and Spanish.

## Product Purpose

Pace is a small animated companion that stays nearby and offers useful local assistance without requiring a cloud account. The pet and its 8-bit tool clouds are the everyday interface: a hover/focus selector beneath Pace for Talk, Dictate and Write for me, plus quiet meeting help. The workspace supports setup and longer records. Success means work feels tangible and fun, controls are understandable, and useful work has explicit, reviewable results.

## Capabilities and Constraints

The authorized implementation includes sprite actions, local chat and voice (Kiki is the chosen English voice), explicit caret autocomplete with an editable preview and Accept/Copy/Dismiss, meeting transcription and speaker labels, opt-in application memory, explicit model downloads, local MCP extensions, pet packs, and settings. Native capabilities and model availability must be shown honestly. Never manufacture assistant messages, transcripts, meeting notes, installed models or capture results. Speaker labels are not automatically known real identities. Quick hide removes Pace and companion windows before screen sharing; there is no guarantee of screen-capture exclusion on macOS. Capture protection is best effort: controlled macOS 26 screenshot/stream probes cover only the tested capture paths, not every sharing app. Application memory is off by default. Browser pages are excluded from automatic memory collection in this release.

### Everyday flows

After completed setup, startup keeps the main workspace hidden and shows idle Pace alone. Hovering Pace or using keyboard focus reveals the three-slot selector below him; there is no always-visible toolbar or Write button above him. Right-click offers Meeting notes, Pet settings, A tiny victory! and Hide Pace. Talk opens a 420×330 cloud with a simple title/Close header and microphone/Send composer; its microphone creates a draft to review before Send. Global dictation first checks Accessibility access; denial prevents microphone startup and offers Open Accessibility settings. With access, recording uses the big-ear pose without an extra Talk panel, then inserts into the unchanged captured field. A cloud appears only for copy/error recovery. English uses a roughly 45 MB Moonshine pack; Japanese, Chinese and Spanish each use roughly 32 MB packs. Custom vocabulary guides recognition without guaranteeing exact spelling. Dictation needs its small speech pack, not the optional 4B language model.

Write for me, or the autocomplete shortcut, explicitly captures nearby field text and optional local writing examples, then shows a 420×240 continuation preview above the caret. Accept validates the original field before insertion; Copy and Dismiss remain explicit. There is no continuous background autocomplete. The old Writing route remains for compatibility and is absent from primary navigation.

First setup has five stops: Pack, Meet, Keys, Access and Home. Pack comes first with optional downloads: the selected dictation pack, a 149 MB KittenTTS voice pack and the optional 3.06 GB Qwen3.5 4B brain; meeting extras remain separately installable. Keys configures and practices all four shortcuts. Defaults are Alt+Space (Talk), Alt+Shift+D (Dictate), Alt+Shift+Enter (Autocomplete), and Alt+Shift+Space (Quick Hide).

## Brand Commitments

Product name: Desktop Pets. Mascot name in this project: Pace. Reuse the existing yellow pixel cheetah with red headband and shoes, whose source project names it Velo. Preserve the twelve original actions, artwork and timings, with new talking, listening and big-ear dictation poses calibrated to the same identity and floor. The user explicitly expanded the 8-bit/GBA direction across the whole interface: cream dialogue, forest framing, brick-red selections, square controls, pixel lettering and speech clouds.

## Evidence on Hand

Twelve existing lossless WebP sprite strips and metadata from the user's Outpaced project, copied without pixel changes. No performance, audience, security audit or operating-system compatibility claims have been established by this UI work.

## Product Principles

- The companion is the everyday interface; tools feel like its 8-bit action selector.
- Local actions explain their permissions and show real state.
- Generate a result for review before applying it elsewhere.
- A missing capability has a useful explanation and recovery action.

## Licensing

The confirmed license choice is MIT for code and CC-BY-4.0 for the mascot artwork. Model weights retain their own upstream licenses.
