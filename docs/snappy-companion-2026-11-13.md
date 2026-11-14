# Current companion contract — 13 November 2026

This note reconciles the latest requested behavior with the implementation. It records source, browser and native-host checks separately from the remaining installer permission check. `PRODUCT.md` records product truth, `DESIGN.md` and `.impeccable/design.json` record the current system, and `.impeccable/surfaces/` records each surface’s contract. Dated validation reports retain their original results; older counts and geometries are not rewritten as evidence for this revision.

## Everyday surfaces

The shipping product is a native Tauri desktop pet. After completed onboarding, Pace starts alone; the large workspace opens only on explicit request. Hover or keyboard focus reveals five icon tools in a semicircle **above** Pace: Talk, Dictate, Meeting, contextual Write and Settings. Nothing labels the pet underneath. Hints and accessible names explain each icon; arrow keys navigate the selector. The primary interaction reference is **Ring Commands**, PDF page 8, in the [official Nintendo Secret of Mana manual](https://www.nintendo.com/es-es/games/oms/snes-classic/manuals/secret-of-mana/manual.pdf). The semicircle is an original adaptation, not a claim that the manual prescribes this app’s layout or artwork. No comp, seed or concept tournament was required for the user-prescribed world.

| Surface | Native size | Contract |
| --- | --- | --- |
| Pet | 128/160/208px sprite; window adds 64px | Idle pet; icon arc appears on hover/focus. |
| Talk | 300×200 | Small speech bubble; real microphone/generation/playback states; draft before Send. |
| Autocomplete | 360×200; minimum 300×180 | Explicit contextual invocation at a supported focused editable target; editable preview; Accept/Copy/Dismiss. |
| Meeting | 420×380; minimum 360×300 | Live words and quiet session tip become notes in the same cloud. |
| Workspace | 1180×780; minimum 800×560 | Explicit setup, settings, archives and longer work. |

Autocomplete captures nearby text only on invocation and revalidates the captured target before insertion. There is no continuous background autocomplete. Unsupported, changed or unconfirmed targets preserve a copy fallback. Talk’s portrait and pet emotes follow real listening, thinking and speaking; browser previews cannot imply native recording or inference.

Quick Hide covers pet, Talk, autocomplete, meeting **and main workspace**. Pending older work must not reopen a cloud after Hide. Closing or hiding a meeting leaves recording active. **Cover requested** describes the default best-effort capture request; it does not guarantee invisibility to every macOS sharing application. Settings displays **Requested · Quick hide ready** as status. There is no product toggle to turn cover off; Quick Hide is the deterministic way to remove every Pace window from view.

## Appearance and shortcuts

Camp, Night and Handheld use semantic color roles generated from fixed OKLCH seeds by `scripts/generate-themes.mjs`. `node scripts/generate-themes.mjs --check` validates conversion, contrast assertions and generated CSS without writing. Default lettering pairs **Pixelify Sans** headings/controls with **Inter** prose. Inter and Fira Sans are optional shared-face settings. Active font files and OFL licenses are bundled locally; pinned URLs and hashes are in `public/fonts/SOURCES.md`. The campsite’s authored art colors remain scoped to its scene.

Settings and onboarding use the same actual key recorder for Talk, Dictate, Autocomplete and Quick Hide. Click and press a combination, then Save or Enter. Save waits for acknowledgement; Escape, blur and a 45-second capture timeout cancel unsaved input. Reserved combinations and conflicts are rejected. Native shortcuts unregister during capture and restore afterward; preset dropdowns do not define shortcuts. New binding validation applies to edited shortcuts, preserving valid legacy bindings that have not been changed.

Talk, listen, dictate and hush use the refined v2 sprite strips. The original twelve remain byte-for-byte unchanged. New strips preserve canonical colors, exact 2×2 pixel grid, binary alpha and foot anchors. Dictate’s headband remains 4–9% narrower over the loop; this is a documented artistic limit. The detailed report and reusable skill are [sprite refinement](sprite-refinement-2026-11-13.md) and [desktop-pet-sprites](skills/desktop-pet-sprites/SKILL.md).

## Dictation startup and cancellation

Capture must not wait for ASR weight loading. The native start boundary checks the installed language pack’s files cheaply and obtains microphone permission, then begins capture. WAV buffers retain audio while Moonshine prepares after capture starts. Model readiness is distinct from microphone readiness. A missing pack fails clearly instead of silently downloading it or claiming to record.

Voice cancellation and playback stop take priority; model unloading runs asynchronously. The Rust start path now delegates the cheap native pack preflight instead of placing broad `model_status` or blocking `voice.stop` work ahead of microphone startup. A stopped native runtime clears terminal dictation state and stale insertion targets. The native-host results below exercise the rebuilt worker; these source boundaries are not a measured promise of instant live recording.

## Measured evidence and limits

A fresh-process file fixture used an actual 12-second human speech WAV with **192,000 PCM frames**. Buffering/finalization preserved PCM bytes exactly. In that run, buffer/finalize took **2.62ms**, Moonshine preparation **145.73ms**, and decode **726.09ms**. These are file/worker measurements with filesystem caching; they do **not** measure physical microphone permission, first live audio frame, hotkey delivery or end-to-end insertion latency.

A rebuilt production worker (`native/bin/PaceNative`) passed build and signing verification; SHA-256 was `ce28dcf1dc0f904cf0f73d06d49fc697f341f62f2ee90bc3e7217308982858ad`. Its no-pack request rejected in **75.6ms** without creating audio. A separate human-file run measured cold tiny-English load **254.9ms** and decode **1068ms**. A concurrent `permissions.status` completed in **129ms** before decode finished, supporting worker responsiveness during that file test. Different runs measure different boundaries and must not be added together as a live latency result. The fixture also produced an imperfect final phrase, so this sample does not establish recognition accuracy. Owning evidence: [cold buffering test](../artifacts/runtime/instant-recording-20261113/cold-recording-tests.log), [production worker protocol](../artifacts/runtime/instant-recording-20261113/final-worker-protocol.json), [Swift suite](../artifacts/runtime/instant-recording-20261113/swift-tests.log), and [native build](../artifacts/runtime/instant-recording-20261113/native-build.log). Runtime evidence is local and Git-ignored.

The Swift checkpoint is **41 tests with one unrelated skip**; Rust passed **47 tests**, with formatting and diff checks passing. Earlier physical microphone start/stop evidence used an older worker and did not establish speech accuracy for this revision. The real final-installer permission check remains pending.

The earlier manual detector covered onboarding only. The new evidence below supersedes the pending browser/host status from the initial documentation pass without rewriting any dated report.

## Final source and native-host checks

`node scripts/test-desktop.mjs` passed **56 operations** with the rebuilt worker, including actual WKWebView Blob download, chat in four languages, memory/MCP/pack behavior, synthetic two-speaker meeting ASR, notes and interrupted-record recovery, and actual Kiki synthesis. The three expected rejections exercise MCP permission, explicit tool confirmation and meeting voice suppression; they are successful guards, not failed operations. Evidence: [results](../artifacts/runtime/desktop-integration/results.json) and [integration log](../artifacts/runtime/snappy-model-integration.log).

Observed timing depends strongly on state: initial cold chat **22.235s**, the last warm chat **1.694s**, and cold Kiki `voice.speak` **9.548s**. `voice.stop` returned in **0.051s** in this run. These figures establish actual completed work and its delay; they do not support an instant cold-response claim.

The Chromium full run passed **78 scenarios**. WebKit first passed **77/78**, exposing a real ring keyboard-entry defect. The fix gives ArrowUp, ArrowRight and Tab explicit entry behavior; focused confirmation passed **4/4 across both engines**. One additional meeting-permission recovery scenario then passed in both engines. **79 scenarios are covered across these runs**; there was no single final full 79-scenario run. The [fresh manual finish review](../.impeccable/review/companion/retro-finish-review.md) reached **ship for the two scored fixes**; its scope is static finish review, not an installer, continuous animation or operating-system certification.

Screen-share cover received causal native probes. A directly launched executable applied false/true cover requests to all five windows. On this machine, LaunchServices launches could not restore `readOnly` sharing type after `none`; the same behavior appeared in a minimal plain Swift window probe and a certificate-signed copy. These probes identify the local launch-path behavior; they do not establish an OS-wide rule or prove exclusion from every capture application. The explicit API reports rejected requests and rolls back settings instead of claiming success. The product therefore keeps the default requested-cover status and Quick Hide, without an unsolicited cover-off toggle. Evidence: [direct controls](../artifacts/runtime/snappy-companion-e2e/controls-results-direct.json), [plain Swift probe](../artifacts/runtime/cover-appkit-ls-probe/result.json), and [signed-copy probe](../artifacts/runtime/cert-cover-probe/result.json).

The final LaunchServices native controls run passed **35 operations**, with no recording started. It verified requested cover by default, all-five-window Quick Hide, native shortcut-registration suspension/restoration, missing meeting-tip rejection, hush, and worker-crash terminal-state/target cleanup. A separate directly launched 37-operation probe also exercised cover-off through the explicit API; that probe does not add an off toggle to the product UI. Evidence: [final controls log](../artifacts/runtime/snappy-controls-final.log) and [controls results](../artifacts/runtime/snappy-companion-e2e/controls-results.json).

The new-certificate packaged-app installer/permission GUI probe remains pending. Append that exact outcome below when complete; do not infer physical first-frame speech latency or broad sharing-app compatibility from the model/file tests.


### Final source check and installed-app handoff

The completed source revision passed the full **79-test WebKit suite**, including the explicit ring keyboard entry and visible permission-recovery actions. Chromium's full 78-test checkpoint and focused follow-ups passed; CI runs the complete current suite. The final Settings/status-only and permission-recovery changes also passed focused checks in both engines. The sprite skill was forward-tested against all 16 states / 256 frames; installed/repository copies match, and fully empty frames now fail its audit.

The locally development-signed app was installed with existing onboarding, Kiki, speech, memory and application preferences preserved. Its first installed CDHash is `32914e6d436db384e575d4e7244f4ce7fa9c3a88`. The final recovery-visibility patch is packaged separately with the same designated requirement; it awaits a controlled restart after the current macOS authorization handoff. No further signing-identity change is planned. Removing signatures from private copies of the tested and development-signed Swift worker produced identical bytes (SHA-256 `1ed6f4174deb4235fba4ff1610a9c4322c63415f888eac361ce174c0fc3c2d64`).

Final real-profile typing/recording/shortcut delivery is **not signed off**. macOS still denied Accessibility after the first authentication; selecting Add opened a separate system authentication sheet. Work is paused at that exact sheet with no capture or playback running. The prepared test uses only a disposable text field and provenance-recorded public speech sample; no simulated transcript will be presented as physical microphone evidence. Earlier source/model/control passes do not establish this pending permission or installed-GUI result. The public installer remains held.
