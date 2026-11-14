#!/usr/bin/env python3
"""Build only the AX/scoped ScreenCaptureKit helper; no Swift package or MLX."""
import json
import os
import select
import time
import pathlib
import platform
import subprocess

NATIVE = pathlib.Path(__file__).resolve().parents[1]


def main():
    if platform.system() != "Darwin":
        raise RuntimeError("The macOS platform adapter can only be built on macOS.")
    arch = platform.machine().lower()
    if arch not in ("arm64", "x86_64"):
        raise RuntimeError(f"Unsupported macOS architecture: {arch}")
    (NATIVE / "bin").mkdir(exist_ok=True)
    source = NATIVE / "PaceNative/Sources/PaceNative"
    output = NATIVE / "bin/PaceNative"
    temporary = output.with_suffix(".partial")
    subprocess.run(["xcrun", "swiftc", "-swift-version", "5", "-O", "-D", "PACE_PLATFORM_ONLY", "-target", f"{arch}-apple-macos15.0", *[str(source / name) for name in ("Bridge.swift", "Dictation.swift", "DictationPasteboard.swift", "Meetings.swift", "RequestTasks.swift")], str(NATIVE / "Platform/main.swift"), "-o", str(temporary)], check=True)
    # No capture or permission request: check JSON framing, cancellation and the narrowed method boundary.
    worker = subprocess.Popen([str(temporary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for request_id, method in [("cancel", "runtime.cancel"), ("unsupported", "models.status"), ("discard", "dictation.discard")]:
            worker.stdin.write((json.dumps({"id": request_id, "method": method, "params": {}}) + "\n").encode())
        worker.stdin.flush()
        pending, responses, deadline = b"", {}, time.monotonic() + 10
        while len(responses) < 3 and time.monotonic() < deadline:
            if not select.select([worker.stdout], [], [], 0.2)[0]:
                continue
            block = os.read(worker.stdout.fileno(), 65536)
            if not block:
                break
            pending += block
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                reply = json.loads(line)
                if "id" in reply:
                    responses[reply["id"]] = reply
        assert responses["cancel"]["result"]["cancelled"] == 0, responses
        assert responses["unsupported"]["error"]["code"] == "unsupported", responses
        assert responses["discard"]["result"]["discarded"] is True, responses
    finally:
        worker.stdin.close()
        try:
            worker.wait(timeout=5)
        except subprocess.TimeoutExpired:
            worker.kill()
            worker.wait()
    temporary.replace(output)
    subprocess.run(["xcrun", "swift-stdlib-tool", "--copy", "--scan-executable", str(output), "--destination", str(NATIVE / "bin"), "--platform", "macosx"], check=True)
    print(f"Built the macOS platform adapter: {output}")


if __name__ == "__main__":
    main()
