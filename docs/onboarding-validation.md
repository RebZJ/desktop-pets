# Campsite onboarding validation — 2026-11-13

The GBA-style introduction is a four-stop, freely navigable setup: Meet, Pack, Access and Home. Pace’s actual sprite responds to petting. Model downloads and OS access remain separate, optional actions. Completion and Skip both save a durable boolean before leaving; Settings can replay the introduction without clearing preferences. Existing installations missing the setting see it once.

## Automated checks

- `npm run build`: passed TypeScript and production Vite build.
- `npm test`: **27/27 Chromium E2E tests passed**, including 13 onboarding cases and the 14 existing workspace/interaction regressions.
- WebKit 27.2 / Playwright v2388: **13/13 onboarding E2E tests passed**, using the same specs through a temporary WebKit project configuration.
- `cargo test --manifest-path src-tauri/Cargo.toml --offline`: **28/28 passed**, including legacy settings merge, boolean persistence, wrong-type rejection and concurrent settings preservation.
- Rust formatting and project-file Git whitespace checks passed. The upstream OFL notice is preserved verbatim, including its original trailing space.

Browser E2E coverage includes real bridge method/ID contracts, all four optional downloads, individual access requests, no passive capture/download/grant, petting, completion destinations with and without the chat model, browser reload persistence, Settings replay, failed writes/retry, disabled controls while saving, startup failure, utility-window exclusion, keyboard heading focus, narrow layout and reduced motion. Downloads and permission responses in these tests are explicitly synthetic fixtures; they do not certify OS grants or download throughput.

## Real desktop host

Built a fresh debug Tauri app and ran it against a new, isolated profile under ignored `artifacts/runtime/onboarding-native-20261113`, using the existing installed model directory. Actual host dispatch checks confirmed:

1. A fresh profile reports `onboardingCompleted=false` and memory off.
2. A string value is rejected without changing completion.
3. Saving `true` returns the complete settings object, preserving every other field.
4. A pet action reaches the actual desktop host.
5. After quitting and relaunching, completion remains true and all other settings still match.

The isolated test host was stopped. No synthetic meetings, memories or completion writes were added to the normal user profile.

## Visual review and assets

Reviewed all four stops at 1180×780, 800×560 and 390×844, with reduced motion settled and bundled fonts/images loaded. The final desktop layouts retain visible forward/back controls while longer dialogue scrolls internally. Narrow browser layouts scroll vertically without horizontal overflow. Captures and exact layout measurements are in [the review directory](../.impeccable/review/onboarding/).

An independent finish reviewer returned **ship**, with no material UI fixes. Its contrast checks include 10.55:1 body, 5.81:1 secondary text and 5.70:1 primary button text. The one manual design-detector run identified the intentional game-frame/dialogue-tail borders and the new, surface-scoped palette/type vocabulary; these are documented without replacing workspace styles. See [the review](../.impeccable/review/onboarding/finish-review.md) and [asset provenance and final prompt](onboarding-assets.md).

The campsite uses a locally bundled original generated raster. Silkscreen is self-hosted with its OFL notice. No runtime network fetch is needed to render the introduction.

## Packaged build and limits

The release Tauri app built successfully, was ad-hoc signed, passed deep signature verification, and was packaged into a verified DMG. Installed the update at `~/Applications/Desktop Pets.app` and observed the normal host and native worker remaining alive. The existing profile had no active meetings before the update; models and user data were preserved, with memory and spoken replies still off.

DMG SHA-256: `b67aea2adb5bb34d9a5dca2cc50697e4e0210bec3001699f65056258c4985d79`.

The Mac was locked when computer-use inspection was attempted, so the newly installed native GUI and actual permission dialogs were **not visually retested**. The screenshots establish browser rendering, including a WebKit functional run, rather than native window captures. No new inference or live audio test was required by this UI/settings change; the prior model and capture validation remains separately scoped in [validation.md](validation.md). The build remains an Apple Silicon Mac alpha and is not Apple-notarized.
