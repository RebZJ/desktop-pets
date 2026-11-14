# OpenWhispr attribution

The dictation startup and native paste adaptations draw on OpenWhispr's MIT-licensed source.

- Upstream: https://github.com/OpenWhispr/openwhispr
- Reviewed commit: `f178fa9fc359a44f43d3e2929dc560198e8addb9`
- Sources: `src/helpers/clipboard.js`, `src/hooks/useAudioRecording.js`, `resources/macos-fast-paste.swift`, and the Windows/Linux paste helpers.
- Adaptations: Tauri/Rust service boundary; target checks; one-shot typed outcomes; complete macOS pasteboard snapshots; explicit recovery for an unconfirmed paste.

The upstream copyright and MIT license are retained in [LICENSE](LICENSE). Pace does not include or require Electron.
