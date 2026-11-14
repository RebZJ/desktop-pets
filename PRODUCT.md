# Desktop Pets

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Confirmed execution brief: React and TypeScript inside a Tauri desktop app. A browser build supports development and automated tests; native capture and local inference belong to the desktop host.

## Users

People who want a playful desktop companion for spoken conversation, dictation, diarized meeting notes and a meeting copilot. The first release targets Apple Silicon Macs with 16 GB or more memory and macOS 15 or newer; cross-platform architecture is required. Dictation supports English, Chinese, Japanese and Spanish; live voice conversation currently uses English.

## Product Purpose

Pace is a small animated companion that stays nearby and offers useful local assistance without requiring a cloud account. The default Home is Pace’s campsite, with a resident Pace and clear Chat, Dictate, Meeting notes and summon/send-home controls. Hover or keyboard focus reveals the desktop pet's complete four-tool arc; every tool, including Chat, is hidden at rest. The workspace also supports setup and longer records. Success means work feels tangible and fun, controls are understandable, and useful work has explicit, reviewable results.

## Capabilities and Constraints

Pace offers local voice conversation, dictation, diarized meeting notes and a transcript-grounded meeting copilot. Writing and cursor autocomplete remain deferred. Stored data and opt-ins remain intact. Chat reuses the local text model and has no tool actions, screen access or ambient collection.

The main window defaults to the campsite. Hover/focus reveals the desktop pet's 28px Dictate, Chat, Meeting and Settings controls in one arc, with no labels underneath. The stepped reveal, 2px floating motion and hover lift respect reduced motion. Chat is an explicitly opened 300×220 speech bubble with actual streamed text, delivered replies and preserved drafts. Opening it never records. **Start voice conversation** is one explicit opt-in for automatic Listen → Think → Speak → Listen turns, using English local ASR and Kitten’s Kiki voice by default. It is half duplex: the microphone is released during transcription, thinking and playback, so there is no barge-in. End remains reachable during work or errors; End, close and hide stop the session.

Summon and send-home use eight-frame one-shot pop-out/burrow strips at 8fps, lasting one second. Quick Hide remains immediate. Reduced motion freezes sprite playback. See [habitat implementation and provenance](docs/pace-habitat-2026-11-14.md) and [portable voice evidence and limits](docs/portable-voice-validation-2026-11-14.md).

Dictation uses a nonfocusable 160×48 bottom-center native indicator only while starting, recording or transcribing. It disappears on every terminal state, including errors, and passive display preserves the original editor's focus. Actual RMS drives pixel columns with 8× visual gain; the accessible meter retains the raw value. A short 160×48 recovery notice above Pace offers explicit Copy or saved-audio Retry instead of an editor. Unsent drafts and failed-recognition audio are preserved. Cancellation cannot insert afterward.

Dictate, the tray action and the window shortcut start/stop capture directly. The separate configured dictation gesture is unchanged: key-down starts capture, a tap latches it, a subsequent tap stops, and a hold finishes on release. Settings and onboarding keep the same custom shortcut preferences; the onboarding action says **Start dictation**.

The shared macOS adapter prefers AXSelectedText. Its AXValue-and-caret fallback applies only to fields with the required writable attributes and unchanged captured app, focused element, full value and UTF-16 selection; it verifies the resulting value and caret. It does not use clipboard paste or Enter. Windows remains limited to native Edit/RichEdit insertion, and Linux offers Copy. The user's apparent Codex composer was blocked from computer-use testing and still needs a manual user check; do not claim Codex compatibility or universal editor support. See [latest dictation validation and limits](docs/dictation-hover-2026-11-14.md).

Meeting setup is explicit. Live recording is a 300×64 strip with real audio input, elapsed time, Stop, Open notes, scoped Ask and Hide. Eight seconds of measured zero input produces an actionable warning. Full records default to formatted notes, with Transcript available separately. Closing or hiding the window leaves the meeting recording. Window requests cannot block Stop. Blank speech cannot become completed notes, and failures preserve captured audio and recognized words.

Native capabilities and model availability must be shown honestly. Never manufacture responses, transcripts, speaker identities or model installs. Quick Hide immediately covers all five windows and ends voice chat; capture exclusion remains best effort. Core capture/inference is portable Rust with the narrow macOS adapter only where the OS requires it. Hardware validation and public installer support must be reported separately from cross-platform builds.

First setup keeps model downloads first, custom shortcut selection/practice, explicit access checks and Home. Existing memory and extension inspection/revoke controls remain in Settings without changing their opt-ins. See [current interface research](docs/companion-ux-2026-11-14.md) for observed references and current flows.

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
