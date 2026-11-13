# Compact companion update — 14 November 2026

The interface research used official product pages and screenshots, visually inspected in Chrome:

- [Granola](https://www.granola.ai/): a dedicated notepad with a small bottom transcription indicator; structured notes after the conversation.
- [Notion's meeting guide](https://www.notion.com/help/guides/preserve-perfect-meeting-memory-with-ai-meeting-notes): live Notes/Transcript controls beside waveform and Stop; Summary/Notes/Transcript after processing, with readable sections and actions.
- [Wispr Flow updates](https://wisprflow.ai/whats-new): a narrow waveform widget near the Dock, with secondary controls revealed on demand.
- [Wispr's dictation guide](https://docs.wisprflow.ai/articles/6409258247-starting-your-first-dictation): hold/release and double-press hands-free. Pace intentionally follows the user's requested **single tap** toggle instead of claiming identical shortcut behavior.

Pace keeps its original artwork, bundled fonts, cream/forest palette and pixel borders. The four hover tools are 28px with a short stepped reveal and hover lift. Reduced motion removes these transitions. Nothing opens a full meeting transcript or note editor above the pet automatically.

## Applied behavior

- Dictation uses a nonactivating 240×76 native window at the bottom-center of the pet's monitor. Starting, Listening and Transcribing are distinct real states. Only real RMS input drives its meter. Recoverable text or audio can expand the widget; Copy and explicit Retry remain available. Cancellation during startup discards only that capture and cannot type afterward.
- The configured dictation shortcut starts capture on key-down. Release before 250ms leaves recording active; a longer hold finishes on release. A second tap finishes latched recording. Repeat events, release during startup, rebinding and cancellation have explicit tests. The threshold is a Pace design choice.
- Meeting setup is explicit. Recording is a 300×64 status strip with real input level, elapsed time, Open notes, Ask, Stop and Hide. Notes and transcript live in the workspace, defaulting to notes. Headings and bullets render as a document. Window actions cannot block Stop.
- Eight seconds of measured zero input produces an actionable warning. A real peak during the session prevents an ordinary later pause from being reported as capture never working. Levels and questions are scoped to their actual meeting.
- Chat with Pace is an explicitly opened 300×200 speech bubble with an actual local-model reply and a retained unsent draft. It reuses the installed text model, has no voice, screen access, ambient collection or tool actions. Meeting questions remain scoped; late replies cannot appear in a different context.

## Meeting failure found

All four tracks in the two preserved interrupted user recordings were exact digital zeros: valid WAV duration, but peak/RMS/nonzero-sample count all zero. No user audio was listened to or transcribed during diagnosis. This establishes missing input, not an ASR recognition error. The new meter and warning expose the problem during recording rather than only after Stop.

Blank transcripts can no longer become completed notes. Summary errors persist interrupted/recoverable state. Speech recognized before a later diarization/track failure is saved, with the original audio retained. Synthetic real-host regression tests verify these boundaries.

Existing user records, models, voice selection and custom shortcuts are preserved. UI screenshots are explicitly synthetic fixtures; native capture and model results are recorded separately in private runtime evidence. Build success does not establish live Windows/Linux hardware behavior, and screen-share cover remains best effort.

## Verification record

The compact interface passed all 82 tests in Chromium and all 82 in WebKit. The final integrated Rust suite passed 94 tests with 4 explicit model tests ignored. The native adapter suite passed 17 tests, including actual stereo callback/RMS handling. Actual Whisper/NeMo synthetic recognition and isolated real-host recovery checks passed separately.

Model readiness now keeps the generation budget unchanged, bounds each health request to 2 seconds and total startup to 90 seconds, and kills failed owned children. Both the deadline and stalled-request/retry regressions passed, and all targets compile.

An initial host-wide localhost HTTP payload stall was independently reproduced in Rust and Python/curl; no OS/network/security settings were changed. After transport recovered, the actual general-chat test passed: cold answer 4.762 seconds, follow-up 1.049 seconds, and exactly four saved messages in user/assistant/user/assistant order. The fixture used no audio, voice, tools, window or permission operations and exited cleanly with no children left behind. Earlier stalled attempts are not counted as successful model runs.

The signed local build was rebuilt and installed at the canonical application path. Its signing requirement, existing settings hash and two existing interrupted-meeting records were verified unchanged. Final live recording, physical shortcut and installed-window interaction checks remain pending because the Mac locked during CUA verification. Cross-platform CI was started separately; no latest-head green claim is made without its result.
