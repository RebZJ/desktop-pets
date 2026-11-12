# Contributing

Desktop Pets starts with a Mac app and a small, explicit set of local capabilities. Keep changes focused on a complete user task. Include the failure behavior and a meaningful test when adding logic.

1. Follow the README to install and build.
2. Run `npm run build`, `npm test` and `npm run test:rust`.
3. For native changes, run `swift test --package-path native/PaceNative -c release -j 6`. Actual inference tests require the installed model pack: `python3 native/scripts/test-inference.py`.
4. Explain what changed, how it was checked and any remaining hardware or permission limits.

Do not commit model weights, local databases, recorded meetings, secrets, build outputs or generated runtime logs. Use synthetic fixtures in tests. Code contributions use MIT; contributions to the included Pace art use CC BY 4.0. Pet packs may choose their own clearly stated art/sound licenses.

Windows and Linux work should implement the existing native capability interfaces and expose unsupported features honestly. Do not silently replace local processing with a remote API.
