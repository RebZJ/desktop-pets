# Combined Pace build — 2026-11-14

This build combines the dictation reliability branch with the pending voice-delay, chat UI and pet interaction work. It keeps the Tauri shell, existing tiny local models and shared microphone service.

- Dictation preserves startup stop requests, checks its captured target and recovers from previous-session errors without clearing a new recording. Consecutive acknowledged pastes no longer block behind an unverified clipboard lease.
- Kitten prepares short phrases while one output stream plays earlier audio. Voice captions follow playback progress; typed chat continues streaming text. Voice chat remains half duplex and resumes listening only after output drains.
- Chat uses pixel speech bubbles with a compact bottom input/control dock. Scrolling back through a reply does not force the view to the bottom. Hover wakes Pace; gentle and fast pointer strokes produce local reactions without interrupting work states. Companion panels track pet movement while the dictation indicator keeps its bottom position.

## Checks on the combined source

- Production frontend build and Rust formatting passed.
- Locked Rust suite: 134 passed, six explicit model/runtime fixtures ignored.
- Chromium and WebKit UI contracts: 226 passed, including chat state/order, caption sequencing, scroll behavior, hover controls, dictation recovery and meeting records.
- Swift bridge suite: 37 passed, using private test pasteboards for clipboard cases.
- The real pinned Kiki fixture passed without opening a microphone or speaker. After an 841 ms model load, its first phrase was synthesized in 504 ms and 487 ms on two passes; complete supplied-text replies took 1,495 ms and 1,812 ms. These are synthesis timings, excluding LLM generation, endpointing, output-device latency and human listening.
- The existing runtime notice collector was regenerated and verified: 368 dependency entries and 655 exact upstream notice files. The packaged app includes these notices alongside the separate Windows insertion and model notices.

The build does not establish physical Bluetooth behavior, live Windows/Linux audio-device performance, new meeting-recording results or insertion into the exact Codex composer. Linux automatic insertion remains Copy-only. No larger model or cloud service was added.

The update replaces only the signed application bundle. Existing models, settings, recordings and conversations live in the normal application-support directory and are retained. Backups and native deployment checks are recorded separately from source-only and browser validation; interactive test apps must have distinct identities and profiles.
