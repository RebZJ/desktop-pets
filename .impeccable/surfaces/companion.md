# Pace listens on the desktop

Mode: Operate for dictation, diarized meeting notes and the meeting copilot. Shipping surface: native Tauri utility windows; browser rendering verifies layout and bridge contracts.

## Current contract

Pace rests alone. Hover or keyboard focus reveals three icons in an upper semicircle: Dictate, Meet and Settings. There are no labels below the pet. Original pixel artwork, semantic Camp/Night/Handheld palettes and bundled lettering remain unchanged. Talk and Write are not product entries.

The shared bubble is DictationCloud at 300×200. Opening is passive. Actual current/state events determine recording/transcribing/draft/error; real microphone RMS drives the meter while recording. Start/Stop uses actual global dictation. Copy uses the official native clipboard capability with a browser fallback. Separate dictation draft/source keys retain edited recognized words across reopen without modifying previous chat draft keys. Accessibility insertion is optional; recognition stays copyable. Saved-audio retry is explicit and appears only when the backend reports recoverable audio.

MeetingCloud is 420×380, minimum 360×300. Explicit source choices and Start precede capture. Live turns, a quiet session tip, notes/editing and one transcript-scoped question/reply share the cloud. Ask sends meetingId, a meeting-specific conversationId, quiet=true and a request id. Stop remains reachable during inference. Reading content can scroll; late replies never leak into another meeting.

The original icon-reference provenance remains the Ring Commands section of the official Nintendo Secret of Mana manual, PDF page 8; all artwork is original. No new media or visual-world iteration is part of this scope.

## Boundaries

General chat, persona voice and writing controls are outside the current flow. Their existing data/preferences stay intact. The legacy command window is a paused notice with Close. Settings retains data inspection/delete and extension review/revoke. Quick Hide still covers all five native windows. Capture exclusion is best effort and platform-specific; no universal invisibility claim is made.

Verify native-sized pet windows 192/224/272 square, dictation 300×200 and meeting 420×380/360×300. Browser tests cover passive opening, actual level/state feedback, explicit retry, copy/error recovery, scope isolation, IME and preserved drafts. Earlier reports and captures remain historical evidence; this frontend work does not establish native audio or installer readiness.

2026-11-14 frontend verification: all 67 browser scenarios passed in a full Chromium run and a full WebKit run; the TypeScript/Vite build passed. Captures include the three-icon pet arc, listening/reviewable dictation at 300×200 and scoped meeting copilot at 420×380. These tests use explicit bridge fixtures and do not verify physical audio capture, recognition quality, OS grants or installed-app behavior.
