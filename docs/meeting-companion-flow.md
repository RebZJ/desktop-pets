# Meeting with Pace

Meeting notes and quiet live assistance share one 420×380 companion cloud beside Pace. The workspace keeps full transcripts, speaker edits, action items and exports. The cloud also fits the native 360×300 minimum; its reading area scrolls while the header, cover status and primary action remain visible.

Choose a title, audio application, microphone and system audio, then explicitly Start meeting. The existing native gate requires Qwen3.5 4B, Whisper turbo and Nemotron diarization; a missing kit links to Local models without starting downloads. Recording consent is visible. No capture, transcript, installed model, note or suggestion is synthesized by the UI.

During recording, the cloud shows the latest four actual transcript turns and one quiet suggestion. Native `meeting.tip` carries `{sessionId,text}` and is displayed only for the current recording; tips from another meeting never appear. After subscribing, `meeting.tip.current {id}` restores the latest real suggestion when reopening; a newer live event takes priority over that snapshot. The existing native meeting voice guard stays responsible for muting speech. Stop calls the existing native lifecycle. `finalizing` explicitly says recording has stopped while the provisional transcript remains available.

Completed records display actual notes and action items. Add/Edit opens a readable notes field; unsaved drafts use the existing `pace.notes-draft.<id>` session-storage convention and survive close/reopen or a failed save. Save calls `meeting.update`. Make notes and interrupted-record Retry use the existing native RPCs. Full record opens the supporting meeting archive. New meeting returns to explicit setup.

The cover chip says **Cover requested** or **Cover off**, reflecting `captureProtectionEnabled`. Its keyboard-accessible description explains that macOS capture exclusion is best effort and some sharing applications may still show Pace. The chip can reflect a retained/API-off state, but Settings offers status rather than a cover-off toggle: **Requested · Quick hide ready** is the default. Quick hide calls `pet.toggle {visible:false}`; it hides all five windows but does not stop recording. The current configured hide shortcut is shown in setup and the cover description. Closing the cloud likewise leaves an active recording running.

## Contracts and verification

- Props: `MeetingCloud({state: AppState, refresh: () => Promise<void>})`.
- Source listing: `apps.list`, accepting the existing array or `{apps}` response.
- Start: `meeting.start {title,language,captureMicrophone,captureSystem,applicationBundleId?}`.
- Lifecycle/content: `meeting.stop {id}`, `meeting.summarize {id,language}`, `meeting.retry {id,language}`, `meeting.update {id,notes}`.
- Navigation: `window.main {page:'models'|'meetings'}`, `window.close {label:'meeting'}`.
- App owns `meeting.updated` state updates; this component subscribes for session-scoped suggestions and restores them with `meeting.tip.current {id}`.

`tests/e2e/meeting-cloud.spec.ts` uses an explicit synthetic native bridge. Browser screenshots prove layout and UI/RPC behavior; they do not prove microphone/system capture, local inference quality, native positioning or exclusion from a real sharing app. Evidence is saved under `.impeccable/review/companion/meeting-*.png`; test runtime output belongs in `artifacts/runtime/meeting-cloud-tests`.

## Current companion integration — 13 November 2026

Meeting is one icon in the semicircle above Pace, beside Talk, Dictate, contextual Write and Settings. No labels sit underneath the pet. Live words, the session-scoped quiet suggestion and subsequent notes stay in the same 420×380 cloud, including its 360×300 minimum. The selected Camp, Night or Handheld palette and current interface/body fonts apply here.

Quick Hide covers **all five windows**, including the main workspace; it still leaves an active recording running. **Cover requested** remains a best-effort capture-protection request. Opening the workspace/archive is explicit. Earlier screenshots and counts in validation documents describe their dated revisions; the current manual finish disposition is ship for the two scored fixes, and the rebuilt-worker host integration passed 56 operations. The final-installer permission check remains pending. The current contract and latency evidence boundaries are in [the companion integration note](snappy-companion-2026-11-13.md).
