# Desktop Pets engineering rules

- Keep the product cross-platform and independent of any coding agent, editor, browser extension or MCP runtime. Setup, builds and checks must be runnable with documented repository commands.
- Prefer maintained Tauri plugins and existing shared Rust libraries for desktop capabilities. Check their supported platforms and actual capabilities before writing an OS-specific bridge.
- Reuse the same capture, transcription and lifecycle code for dictation, voice chat and meetings wherever possible. Avoid separate implementations of the same microphone feature.
- Use a native adapter only when a required capability has no suitable portable implementation. Keep it narrow, behind the shared interface, and document the missing plugin capability and supported platforms. Do not claim that wrapping OS code in a plugin makes it portable.
- Keep product behavior in the repository; agent-specific plugins may assist development but must not become runtime requirements.
- For text insertion, preserve the original app, field, selection, existing content and clipboard. Never submit a message or retry an uncertain write automatically. Keep recognized words available to copy when the platform or editor cannot support insertion safely.
- Verify real desktop behavior separately from browser fixtures and compilation. State which operating systems, editors, audio sources and devices were actually exercised.
- Preserve installed models, user recordings, conversations, settings and stable application signing identity during updates. Do not reset permissions as a routine debugging step.
