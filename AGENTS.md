# Desktop Pets engineering rules

- Keep the product cross-platform and independent of any coding agent, editor, browser extension or MCP runtime. Setup, builds and checks must be runnable with documented repository commands.
- Prefer maintained Tauri plugins and existing shared Rust libraries for desktop capabilities. Check their supported platforms and actual capabilities before writing an OS-specific bridge.
- Reuse the same capture, transcription and lifecycle code for dictation, voice chat and meetings wherever possible. Avoid separate implementations of the same microphone feature.
- Use a native adapter only when a required capability has no suitable portable implementation. Keep it narrow, behind the shared interface, and document the missing plugin capability and supported platforms. Do not claim that wrapping OS code in a plugin makes it portable.
- Keep product behavior in the repository; agent-specific plugins may assist development but must not become runtime requirements.
- Capture the insertion target before opening tools. Verify the original app/window and focused field wherever the platform exposes it; refuse a known changed target. Distinguish dispatched input from verified insertion. Preserve existing content and clipboard formats, never overwrite a newer user copy, and never submit a message or retry uncertain input automatically. Keep recognized words available to copy when insertion is unavailable.
- Verify real desktop behavior separately from browser fixtures and compilation. State which operating systems, editors, audio sources and devices were actually exercised.
- Preserve installed models, user recordings, conversations, settings and stable application signing identity during updates. Do not reset permissions as a routine debugging step.
