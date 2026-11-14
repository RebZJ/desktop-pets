# Companion and local-runtime validation — 13 November 2026

Test machine: Apple M1 Pro, 16 GB, macOS 26.6.2. The installer targets Apple Silicon and macOS 15+. This report extends the historical [alpha validation](validation.md); it does not repeat or re-label the earlier hour-long synthetic meeting soak.

## Current behavior

Pace rests alone. Hovering the sprite reveals Talk, Dictate and Write for me underneath, with a small slot lift/enlargement and neighbour response. Keyboard focus reveals the same controls; reduced motion disables movement. Right-click opens supporting actions. Talk has one compact header and composer. Global dictation uses the big-ear pose without opening a Talk panel on successful start. Missing Accessibility access produces an explicit recovery action before microphone capture starts.

Write for me is explicitly triggered cursor autocomplete: nearby field text and optional writing examples produce a short preview above the caret. Accept checks the original field, text and UTF-16 selection before insertion. A changed or unsupported target keeps a copyable preview; a rejected target disables Accept until a new suggestion. Continuous background autocomplete is not implemented.

## Checks

| Check | Result |
| --- | --- |
| Production frontend and Tauri app build | Passed |
| Chromium UI/contract suite | 51/51 passed |
| WebKit UI/contract suite | 51/51 passed after correcting the test's keyboard-modality setup |
| Rust host tests | 38/38 passed |
| Release Swift tests | 38 completed, 2 opt-in model-fixture skips, no failures |
| Lightweight native bridge/cancellation checks | 14/14 passed |
| Actual final-helper desktop integration | 55 operations passed using isolated data and actual models |
| Native UI handlers | Talk/Close/Write/Dismiss responded in the installed/bundled UI |
| Sprite starter | Reproducible ZIP, 25 files, 15 actions and 6 earcons checked |
| Visual finish review | `disposition: ship`; see the [fresh review](../.impeccable/review/companion/hover-finish-review.md) |
| Installer | Nested signatures and DMG checksums passed; final helper hash verified |

Browser tests use synthetic bridge fixtures. Native integration uses the actual Rust host, SQLite, Swift worker, installed weights, native windows and a synthetic two-speaker recording. It covers chat in four languages; factual compatibility editing; synthetic memory search/citations/deletion; MCP grants; pet-pack import/removal; hide/show; native Markdown export; worker failure and meeting recovery; ASR, anonymous speaker labels, notes/actions; and actual Kiki audio generation/unloading. Its debug bridge is excluded from release builds. Meeting recovery/finalization passed three factual checks; this is not a new live-meeting or long-duration soak.

Earlier candidate checks accidentally selected an older helper from debug resources. Those runs are not the final-helper evidence above. The final integration used helper SHA-256 `f704a567dffba23e2815fc98339d32a4d3ffdc054a1d58bd2e6922bedffb4888`, matching the installed release's native binary. A subsequent Rust-only accessibility preflight is covered by the 38-test host suite and included in the installed release.

## Tiny models and performance limits

Dictation can start with Moonshine English **45.4 MB**, or separate Chinese/Japanese/Spanish packs of about **32 MB** each. Kiki uses KittenTTS Micro 0.8, about **149 MB** including offline pronunciation assets. The **3.06 GB** Qwen3.5 4B language model is optional for chat/autocomplete; dictation does not need it. Whisper remains the meeting/Auto-language fallback. Custom vocabulary reaches the decoder but cannot guarantee a spelling.

The actual offline Moonshine comparison matched all 24 reference words in one 8.6-second human sample: warm decode **232 ms**, versus Whisper **1,945 ms**. Synthetic Kiki speech exposed more errors than Whisper (37 versus 27 normalized edits across 116 reference words). This tiny corpus is not a general WER or multilingual accuracy benchmark. Silence returned no words in all four packs. The native SDK was rebuilt for macOS 15, with a tested VAD buffer-clear patch and a fresh stream per dictation.

A Kitten ISTFT optimization preserved a seeded waveform exactly and reduced its warm synthesis from 4.27 seconds to 114 ms. Twenty-one offline clip checks had a 138 ms median synthesis time. Playback scheduling and cold loading are separate costs: the busy full-host integration took **16.92 seconds** for its fresh voice request. Do not present the warm synthesis number as first audible-response latency or promise instant cold starts. See [model research](snappy-models-research-2026-11-13.md) and [dictation/privacy research](dictation-privacy-research-2026-11-13.md).

The tested smaller language models responded faster but invented personal memories or meeting actions. The default remains 4B; size alone did not justify a quality regression. Newer Kitten 2 tiny variants were researched but have not been integrated into the pinned Swift runtime.

## Permission and hardware boundary

Actual native insertion-kernel tests passed in disposable AppKit fields, including surrounding text, emoji selections, explicit focus restoration, single-use targets and rejection after cursor/text changes. The final bundled identity initially lacked Accessibility access. User permission was requested only after installation; granted-access release UI verification is recorded separately below when complete. Handler activation is not proof of physical first-mouse focus behavior. A synthetic fixture can also lose focus while a person uses other applications; tests must reject that condition rather than insert elsewhere.

Scoped cancellation, late permission, EOF cleanup, mute epochs and Hide epochs have deterministic regressions. They do not replace a real delayed OS permission-dialog trial. Screen protection passed controlled full-display SCScreenshotManager and live SCStream probes on this Mac, with a visible unprotected control; it remains best effort across capture paths. Older macOS execution, every conferencing app, a clean Mac, real meeting audio and Apple notarization remain unverified.

### Installed-build permission diagnosis

The user enabled Accessibility, but a fresh process still reported denied access. Targeted macOS TCC logs showed that the stored grant required an older ad-hoc code hash, while the installed app had a different hash. Attribution correctly identified Desktop Pets as the responsible app; the Swift helper did not need a separate permission. The existing checked switch alone did not refresh the stale requirement. Refreshing only Desktop Pets’ entry reached a system Touch ID/password sheet, which requires the user’s authentication. No TCC database was edited.

A further native focus correction converts only the pet window to an actual non-activating NSPanel. `acceptFirstMouse` permits initial click delivery; it does not itself prevent a regular NSWindow from activating the app. The pinned panel plugin preserves the existing window and adds activation prevention, with key/main eligibility disabled. The [Tauri focus report](https://github.com/tauri-apps/tauri/issues/14102) and [maintainer discussion](https://github.com/orgs/tauri-apps/discussions/15251) explain this distinction. Runtime property checks and installation of this correction are recorded below when complete.

The corrected debug host was launched with isolated data and queried on its main thread. The live pet reported `class=PacePetPanel`, `isNSPanel=true`, `nonactivating=true`, `canBecomeKey=false`, `canBecomeMain=false`, `acceptsFirstMouse=true`, `sharingType=0`, `collectionBehavior=1`, and 224×224 size. The probe quit cleanly. The source review found no blocker; the adapter’s private activation selector remains a macOS compatibility risk and properties alone do not establish physical first-click behavior.

The user authenticated the OS prompt. Only Desktop Pets’ stale entry was removed and the corrected installed bundle was added through System Settings, where its switch was verified on. The resulting installed main executable has ad-hoc CDHash `fdc242a61cc9dab7c2d2b37eee97643ae86fe7e5`. Saved data and existing preferences remain preserved, with Kiki selected as requested. No TCC database was modified; this build will not be re-signed during granted-access testing.

### Granted-access release journey and follow-up fixes

The actual installed panel build captured a disposable AppKit field and generated a real model preview while the source application remained active. Accept closed the preview and returned focus. An edited replacement changed only the selected 🐾, producing `before Pace after`. Changing the source after capture caused Accept to reject it, keep `Changed synthetic field` untouched and disable retry. This used CUA actions and synthetic content, not real user documents.

The run exposed two defects. A generated result repeated the entire captured BEFORE prefix, and raw acceptance duplicated it. The shared host now removes only an exact repeated prefix when there is no selection, preserving the remaining spacing; selected replacements are untouched. Empty results become an error. Five additional Rust cases cover exactness, Unicode, partial words, selection and empty output; the suite passed 43/43. The second defect removed the editor when its text was cleared. A valid target now keeps its textarea even when empty; delete-all/retype regressions passed in both browser engines (15/15 focused companion checks each).

The Microphone grant also referenced the older ad-hoc signature. The real request reached an OS prompt and timed out safely without entering recording. Native cancellation prevents that timed-out request from starting capture after a late Allow. Recording/Stop verification awaits the current corrected signer’s microphone response. The timeout is not microphone recognition evidence. Final acceptance of the two fixes is recorded after reinstalling this batch.

The follow-up batch was built and installed with main CDHash `196d034774a7a45ae6c77666445f6087f9759a04`; its Accessibility entry was refreshed through the same authorized Settings workflow and verified on. The user profile remained unchanged. A valid global dictation target receiving an empty transcript now reports that no speech was caught; intentionally hidden/cancelled capture does not get that insertion error. Rust 43/43 and both 15-test companion runs passed for this batch. Final GUI scoring and microphone permission/lifecycle verification continue against this signer without rebuilding it.

Final installed GUI scoring passed both fixes: the preview contained only ` a giant leap for humanity.` and Accept produced `One small step is a giant leap for humanity.` once; clearing the preview kept its editor and disabled Accept, and retyping re-enabled Accept and inserted the edited continuation correctly. The source retained focus. The final-signer microphone request was made through Settings only, so it cannot begin recording. Targeted OS logs still show that request awaiting the user's response, with no grant result. The disposable fixture was closed; Pace and the OS prompt remain available. Microphone/Stop and recognition through the physical device remain open. The public installer release is held; source and test evidence are in draft PR #1.
