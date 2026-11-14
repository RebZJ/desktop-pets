# OpenWhispr dictation port — 2026-11-14

Pace keeps its Tauri shell and shared Rust microphone, ASR and shortcut services. This change adapts OpenWhispr's dictation startup and paste transaction, rather than embedding Electron or making an agent/plugin service a runtime dependency.

## Reviewed upstream

OpenWhispr commit [`f178fa9fc359a44f43d3e2929dc560198e8addb9`](https://github.com/OpenWhispr/openwhispr/tree/f178fa9fc359a44f43d3e2929dc560198e8addb9), MIT:

- [`src/helpers/clipboard.js`](https://github.com/OpenWhispr/openwhispr/blob/f178fa9fc359a44f43d3e2929dc560198e8addb9/src/helpers/clipboard.js): serialized paste transactions and platform dispatch.
- [`resources/macos-fast-paste.swift`](https://github.com/OpenWhispr/openwhispr/blob/f178fa9fc359a44f43d3e2929dc560198e8addb9/resources/macos-fast-paste.swift): transient promised clipboard text, read acknowledgement, paste and restoration.
- [`src/hooks/useAudioRecording.js`](https://github.com/OpenWhispr/openwhispr/blob/f178fa9fc359a44f43d3e2929dc560198e8addb9/src/hooks/useAudioRecording.js) and window management: foreground target capture before recording UI, recording before model warmup and stop requests during startup.

The upstream MIT notice is retained under `native/licenses/openwhispr/`. The port preserves arbitrary readable pasteboard formats/items, rather than only the upstream's selected text/image formats. A clipboard read alone does not prove insertion; Pace restores the original automatically only after the expected target text is verified. It never retries uncertain input or presses Return.

## Behavior and boundaries

- Starting dictation dispatches target capture before showing tools, opens the existing shared microphone without waiting for AX/model warmup, and bounds target resolution. A second toggle during startup is remembered. A cold helper still cannot guarantee a synchronous press-time foreground snapshot.
- macOS accepts enabled native text fields without requiring writable AX value/range attributes. Native editors receive one process-targeted Cmd+V. Known web fields retain guarded Unicode insertion; opaque fields use it only under a safe plain keyboard layout. Changed targets, secure fields, held modifiers and control/newline input are refused.
- Clipboard transactions preserve all readable types/items within explicit size bounds. A newer user copy is never overwritten. An unconfirmed paste retains the original only in helper RAM, with an explicit Restore action; closing/restarting the helper loses that snapshot. A failed Restore keeps the action available. Explicit Copy retires the old recovery action.
- Windows keeps verified Edit/RichEdit insertion and adds a clipboard-free Enigo Unicode path only for a writable, enabled, nonpassword UI Automation Edit field with a stable identity. Target/current-session checks run between chunks. Dispatch remains distinct from verified insertion.
- Linux is deliberately Copy-only until writable, nonsecure fields can be checked through AT-SPI; a focused X11 window alone is insufficient. There is no automatic Wayland typing claim.
- Tauri plugins provide shortcuts, windows and clipboard commands. The existing narrow macOS adapter and Windows accessibility APIs cover guarded cross-app insertion, which the clipboard plugin does not provide. Wrapping these APIs does not make their capabilities portable.
- Recognition/model choices are unchanged. This port adds no cloud account, model download or larger model. Meeting capture continues using the same shared listening module; no new live meeting/audio-device result is claimed here.

## Verification

- The isolated frontend production build passed. The full Chromium/WebKit UI suite passed 212 checks before the final recovery fix; all 10 focused recovery checks passed afterward, including retryable restore failure and late replies.
- Locked Rust tests passed 125 checks, with five explicit model/runtime fixtures ignored; 36 Swift bridge tests also passed. The Swift tests use private named pasteboards, including a separate reader process, complete format snapshots, ownership races, cancellation and restore failure injection.
- A real, owned AppKit text editor received `Pace pastes café 日本語 🐾 once.` through the real Tauri→helper insertion route in approximately 520 ms. Its paste handler ran exactly once and the expected surrounding text remained. Reusing its token and switching to its other field were rejected. This was insertion testing, without microphone, ASR or a real conversation.
- The real debug NativeManager was exercised with a synthetic STDIO adapter: a blocked 100 KB write returned conservatively in about two seconds without retry, and scoped hide cancellation retained dispatched/recovery metadata. Neither case accessed audio, AX, clipboard or another application's text field.
- The Windows adapter compiled for `x86_64-pc-windows-msvc` in a standalone check crate. This is not Windows hardware or installer validation.

Messages, the Codex composer, physical global hotkeys, Linux automatic typing and a new live microphone/system-audio meeting were not verified in this port. Codex computer control is unavailable in this environment. The actual AppKit test proves the native paste path, not universal application compatibility.

Repository checks, independent of any coding agent:

```sh
npm ci
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked --all-targets
bash native/scripts/test-bridge.sh
npx playwright test tests/e2e/portable-dictation.spec.ts
# macOS only; requires a local packaged app template under artifacts/release:
cargo build --manifest-path src-tauri/Cargo.toml --locked
python3 scripts/test-native-transport.py
```

Ordinary Playwright configuration runs Chromium. The validation run used an isolated Vite server and an additional WebKit project. Browser fixtures do not establish desktop permission, clipboard or physical shortcut delivery. New pinned Windows notices are included separately; the existing broad runtime-notice index predates unrelated voice dependencies and its whole-graph audit still needs regeneration.
