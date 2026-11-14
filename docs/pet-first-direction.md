# A companion that makes work feel alive

The desktop pet is the everyday interface. A person should reach for Pace when a task feels tangled, a sentence needs a continuation, or a meeting needs quiet help. Short dialogue, expressive poses and tools revealed on hover/focus make that help feel like an interaction with a character.

## Implemented interaction

- **Pet selector:** idle Pace stands alone. Hover the sprite or use keyboard focus to reveal Talk, Dictate and Write for me in a three-slot selector underneath. The hovered slot rises 3px at 1.1 scale; neighbors rise 1px at 1.03 scale. Reduced motion removes the animation. Right-click offers Meeting notes, Pet settings, A tiny victory! and Hide Pace.
- **Talk:** its selector slot opens a 420×330 local dialogue cloud. A simple title/Close header and microphone/Send composer keep the dialogue focused. Typed questions and reviewed dictation stay beside the pet; replies are short and can use the chosen local voice.
- **Write for me:** the selector slot beneath Pace or Alt+Shift+Enter explicitly captures nearby field context and optional local style examples. A 420×240 editable continuation preview opens above the caret. Accept validates the original field; Copy and Dismiss offer explicit recovery. There is no continuous background autocomplete, and the old Writing route is retained only for compatibility.
- **Dictate anywhere:** Alt+Shift+D starts and stops global dictation for the captured field. Accessibility access is checked before the microphone starts; denial offers an explicit Open Accessibility settings action. Granted recording uses only Pace’s oversized comic-ear pose, without opening a Talk panel. The result inserts only into the unchanged target; copy/error recovery opens a cloud when needed. Language packs and custom vocabulary live in setup and Settings.
- **Quiet meeting company:** recording starts deliberately; provisional transcription and final speaker labeling have distinct states. Useful tips can appear by Pace while speech stays muted during a meeting.
- **A tiny victory:** a deliberate celebration uses Pace's original action and respects mute/meeting settings.
- **A supporting workspace:** settings, model installation, memory controls and longer meeting records remain reachable from the pet.

The interface uses the same 8-bit vocabulary throughout. Silkscreen belongs on controls and display text; longer editable text stays easy to read. Original poses are preserved, and the new talking/listening/big-ear dictation art is aligned to the same floor and apparent character scale.

## Setup and everyday access

Onboarding runs Pack → Meet → Keys → Access → Home, putting optional model downloads first. The selected dictation pack is about 45 MB for English or 32 MB for Chinese, Japanese or Spanish; Kiki’s KittenTTS voice pack is 149 MB and the optional Qwen3.5 4B brain is 3.06 GB. Dictation does not require the 4B brain. Meeting extras remain optional. The four configurable shortcut defaults are Alt+Space (Talk), Alt+Shift+D (Dictate), Alt+Shift+Enter (Autocomplete), and Alt+Shift+Space (Quick Hide). After completed setup, normal startup shows Pace and leaves the main workspace hidden.

The transparent pet window adds 64px around the chosen 128/160/208px sprite bound. Content protection requests reduced capture visibility where supported; the controlled macOS 26 screenshot/stream results do not guarantee exclusion from every sharing application. Quick Hide remains available.

## Three product experiments to evaluate next

1. **Shrink the task.** Ask Pace for one concrete next step, then observe whether people take it. Evaluate useful outcomes and interruption cost rather than message volume.
2. **Mark a win.** Let someone acknowledge finishing work with a small authored celebration. Measure whether they voluntarily return to the companion without turning routine actions into a reward grind.
3. **Return from a meeting.** Present a small “what happens next” dialogue sourced from reviewed notes, with links to the actual decisions/actions. Evaluate factual correctness and follow-through.

These are testable directions. Their effects on retention or distribution have not been measured. A promising distribution artifact is a short screen recording showing the real cursor context → continuation preview → explicit Accept interaction with Pace visibly responding; another is a remixable pet pack with the same working tools.

## Models and evidence

Use measured end-to-end latency and small, explicit quality probes to choose models. The current research compares local models and preserves failed outputs instead of selecting by parameter count alone. See [the model research](snappy-models-research-2026-11-13.md), [sprite review](sprite-quality-2026-11-13.md), and the implementation validation report for the actual tested scope.
