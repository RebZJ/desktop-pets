# Pace’s campsite onboarding

Requested 2026-11-13: “a stellar pixel style almost roguelike or sprite like GBA style onboarding experience.” The existing workspace stays in its established paper-and-brick world; this bounded introduction opens into an original warm GBA grassland campsite. No separate game system is needed.

## Direction contract

**THESIS:** Meet a real little companion at its pixel campsite, then take four optional setup stops. The first meeting carries the experience; a generic setup checklist does not.

**OWN-WORLD:** Original GBA-style grassland art, forest framing, cream dialogue paper, brick-red actions and self-hosted Silkscreen display lettering. Readable platform sans carries explanations. Square frames and speech tails belong only to this introduction; the workspace retains its established identity.

**STORY:** Meet → Pack → Access → Home, freely navigable. A real pat changes Pace’s authored pose and plays its earcon when sound is enabled. Explore optional downloads and access, then enter the workspace; replay is available in Settings.

**FIRST VIEWPORT:** A large campsite and Pace occupy the left half; stop navigation, a pixel heading, Pace’s greeting and one forward action occupy the cream right pane. Desktop keeps navigation and primary controls outside the scrolling dialogue body. Mobile stacks the scene above dialogue.

**FORM:** Direct code-led extension of the user’s precisely specified pixel/GBA request. No concept tournament, seed, decision card or approved comp was generated. The split frame, original scene and live companion are the implementation reference.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Product and verification boundaries

Truth boundaries: downloads are optional, use the actual model catalog/progress, and start only on a Download click. OS access is optional and requested separately. Memory and spoken replies keep the user’s existing settings. No invented inference, recording, grant, model readiness, or hidden screen-sharing claim. The only completion write is onboardingCompleted=true, acknowledged before exiting. A failed write stays retryable in the tour. Utility pet/writing/bubble windows never display onboarding. Replay from Settings does not reset stored preferences or the completion flag.

Required viewports: 1180×780 desktop, 800×560 native minimum, and 390×844 browser preview. Each of the four stops must fit horizontally; compact layouts can scroll vertically. Keyboard focus, semantic controls, visible progress/errors and reduced-motion support are required. All assets are bundled for offline rendering.

The dialogue has a short, restrained entrance; reduced motion freezes the sprite and entrance animation. First-round captures and the finish review are under `.impeccable/review/onboarding/`; behavioral validation is in `tests/e2e/onboarding.spec.ts`. Asset provenance and the complete generation prompt are in `docs/onboarding-assets.md`.

Manual detector ran once on the changed UI. Its split-frame and speech-tail side-border warnings are intentional game geometry. The new palette/type vocabulary is documented as scoped additions in `DESIGN.md` and `.impeccable/design.json`; it does not replace the incumbent workspace system.
