# Meeting acoustic echo cancellation

Pace uses `aec3 = 0.4.0`, a portable Rust port of WebRTC AEC3, for derivative
microphone WAV preprocessing. No additional OS capture bridge, model pack,
Python installation or native sidecar is required.

- Upstream: https://github.com/RubyBit/aec3-rs
- Published source commit: `f999860f91998daeb6d051e6076eaff629356469`
- Crates.io package SHA256: `95b94681e57494d8d3933597fbf49c3537be1f2f33647e41317aab3dfc3d6fc8`
- License: MIT for new contributions plus BSD-3-Clause and the WebRTC patent
  grant for derived WebRTC portions; see accompanying LICENSE and PATENT.

The implementation feeds 10ms render-reference frames into adaptive AEC3 before
processing the matching microphone frames. It retains AEC3's double-talk handling;
it does not subtract tracks or suppress microphone audio merely because system
audio is present. Raw recordings remain intact. Incomplete reference coverage
skips preprocessing, and small reference tails may be padded with silence.

OpenWhispr's pinned MIT source at
`f178fa9fc359a44f43d3e2929dc560198e8addb9/native/meeting-aec-helper` informed the
render/capture processing order. Pace does not copy that C++ helper or its build
system; it calls the Rust crate directly.
