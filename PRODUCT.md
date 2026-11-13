# Desktop Pets

<!-- impeccable:product-schema 1 -->

## Platform

desktop

## Stack

Confirmed execution brief: React and TypeScript inside a Tauri desktop app. A browser build supports development and automated tests; native capture and local inference belong to the desktop host.

## Users

People who want a playful desktop companion that can help with writing, conversations and meeting notes. The first release targets Apple Silicon Macs with 16 GB or more memory and macOS 15 or newer; cross-platform architecture is required. Conversation languages are English, Chinese, Japanese and Spanish.

## Product Purpose

Pace is a small animated companion that stays nearby and offers useful local assistance without requiring a cloud account. The pet and its 8-bit tool clouds are the everyday interface: a semicircle icon selector above Pace for Talk, Dictate, Meeting, contextual Write and Settings. The workspace supports setup and longer records. Success means work feels tangible and fun, controls are understandable, and useful work has explicit, reviewable results.

## Capabilities and Constraints

The authorized implementation includes sprite actions, local chat and voice (Kiki is the chosen English voice), explicit caret autocomplete with an editable preview and Accept/Copy/Dismiss, meeting transcription and speaker labels, opt-in application memory, explicit model downloads, local MCP extensions, pet packs, and settings. Native capabilities and model availability must be shown honestly. Never manufacture assistant messages, transcripts, meeting notes, installed models or capture results. Speaker labels are not automatically known real identities. Quick hide removes all five windows (pet, Talk, autocomplete, meeting and main workspace) before screen sharing; there is no guarantee of screen-capture exclusion on macOS. Capture protection is best effort: controlled macOS 26 screenshot/stream probes cover only the tested capture paths, not every sharing app. Application memory is off by default. Browser pages are excluded from automatic memory collection in this release.

### Everyday flows

After completed setup, startup keeps the main workspace hidden and shows idle Pace alone. Hover or keyboard focus reveals five icon tools in a semicircle above him: Talk, Dictate, Meeting, Write and Settings. The pet has no labels underneath. The icon menu follows the ring-command interaction reference in Nintendo’s *Secret of Mana* manual; all artwork is original. Right-click offers Meeting notes, Controls & look, A tiny victory! and Hide Pace. The workspace opens only through an explicit action.

Talk opens a 300×200 speech bubble. Its portrait reflects actual listening, thinking and voice playback; microphone input becomes a draft to review before Send. Global dictation checks Accessibility before capture. Native audio starts after microphone permission and a cheap installed-pack file check; ASR weights must not load before recording begins. Audio buffers to WAV while the small Moonshine listener prepares. English uses a roughly 45 MB pack; Japanese, Chinese and Spanish each use roughly 32 MB packs. Custom vocabulary guides recognition without guaranteeing spelling. No optional 4B language model is needed for dictation. Global recording uses the big-ear pose, then inserts only into the unchanged captured field; refusal preserves copyable text. Voice cancellation and playback stop take priority over asynchronous model unloading.

Write for me and the autocomplete shortcut require a supported focused editable target. Explicit invocation captures nearby field text and optional local writing examples, then opens a 360×200 editable continuation preview (300×180 minimum) near the caret. Accept validates the original field; Copy and Dismiss remain available. There is no continuous background autocomplete. The old Writing route stays compatible with saved work and is absent from primary navigation.

Meeting live words, quiet tips and subsequent notes share one 420×380 cloud (360×300 minimum). Start and Stop are explicit; Close and Quick Hide leave an active recording running. Cover requested reflects the default best-effort capture request, with a visible explanation of macOS sharing limits. Settings displays Requested · Quick hide ready as status; there is no cover-off toggle in the product flow. The workspace holds full records and exports.

First setup has five stops: Pack, Meet, Keys, Access and Home. Pack comes first with optional downloads: the selected dictation pack, a 149 MB KittenTTS voice pack and the optional 3.06 GB Qwen3.5 4B brain; meeting extras remain separately installable. Keys configures and practices all four shortcuts with the same actual key recorder used in Settings, not preset dropdowns. Save waits for acknowledgement; Escape, blur and a 45-second timeout cancel unsaved capture. Native bindings unregister during recording and restore afterward. Defaults are Alt+Space (Talk), Alt+Shift+D (Dictate), Alt+Shift+Enter (Autocomplete), and Alt+Shift+Space (Quick Hide).

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
