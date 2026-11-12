# Alpha validation — 13 November 2026

Machine: Apple M1 Pro, 16 GB unified memory, macOS 26.6.2. The release targets Apple Silicon and macOS 15+, but this run does not establish compatibility with every supported OS version.

| Check | Result |
| --- | --- |
| Production frontend build | Passed |
| Browser interaction/contract tests | 14 passed, with explicitly synthetic bridge fixtures |
| Rust host/unit tests | 25 passed |
| Swift/native tests | 21 passed |
| Real local text, voice and ASR without network access | Passed; see [native evidence](native-validation.md) |
| Actual packaged desktop chat through its UI | Passed |
| Actual host integration | 55 operations passed; includes variable recovery polling and three factual notes checks |
| Native WebView Markdown download | File content verified in Downloads; fixture removed |
| Timed 60-minute synthetic meeting workload | Started 03:14:54 Melbourne; final result will be recorded here |
| Release packaging and CI | In progress |

The desktop integration drives the debug app's authenticated loopback test bridge. It uses the actual Rust dispatch, SQLite storage, Swift worker, installed models and native windows, rather than substituting model responses. The bridge is excluded from release builds. This is deeper backend/native evidence; it does not substitute for every human interaction or permission dialog.

The real integration covers English, Mandarin, Japanese and Spanish chat; a factual grammar edit; four-language memory search and cited recall; retrieval/deletion of a saved source; MCP discovery, denied ungranted/unconfirmed calls and an approved arithmetic call; pet-pack import/activation/removal; hide/return window visibility; quiet meeting speech guard; worker termination and recoverable meeting retry; actual ASR plus two anonymous diarized speakers; notes/actions and Markdown export; meeting-context questions; generated voice and voice-model unloading. Synthetic recordings contain no user meeting audio.

Real runs found and fixed numeric citation variants, nested action metadata becoming separate tasks, silence hallucinations, and word timing across long pauses. Factual writing, notes and tips now use greedy generation; ordinary conversation keeps its sampled personality. Three repeated notes checks preserved the fixture's Friday release-note deadline and the tutorial's lack of an agreed deadline. The complete starter ZIP also passed actual host import/removal.

To reproduce, launch a debug app with `PACE_E2E_PORT=18972`, `PACE_E2E_DATA_DIR="$PWD/artifacts/runtime/e2e-app"`, and `PACE_MODELS_DIR` pointing to an installed pack. Keep ambient memory disabled in that isolated profile. Generate the fixture with `python3 scripts/create-meeting-fixture.py`, then run `node scripts/test-desktop.mjs`. `PACE_SOAK_SECONDS=3600 node scripts/soak.mjs` runs the paced workload and full finalization; short runs do not count as 60-minute evidence. Evidence stays under ignored `artifacts/runtime`.

## Remaining human/hardware checks

The Mac locked during unattended work. Final cross-app Accessibility replacement, physical shortcuts, native window resizing, real microphone and ScreenCaptureKit audio capture, permissions under the release identity, and a real meeting/screen-sharing app remain unverified. Native resize requests stalled while the Mac was locked; the isolated profile was reset to its default size and the test host restarted. Unrelated settings no longer invoke native resize/cursor APIs. Native capture/resampling and stale-edit protection have fixture/unit coverage. Voice intelligibility has ASR round-trip evidence; a human voice audition remains open. Headphones are recommended to reduce microphone/system echo.

The app provides a manual hide shortcut. It does not promise exclusion from all full-display recording or sharing. Window sharing is the reliable product guidance. Local ad-hoc signing is not Developer ID signing or Apple notarization, and the installer will be labelled accordingly.
