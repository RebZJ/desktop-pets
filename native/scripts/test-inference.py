#!/usr/bin/env python3
"""Real local models, no network: chat, voice, ASR, context limits and cancellation."""
import json
import pathlib
import queue
import subprocess
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "artifacts/runtime/native"
OUT.mkdir(parents=True, exist_ok=True)
events = []
results = []
messages = queue.Queue()
stderr = (OUT / "checks-stderr.log").open("w")
worker = subprocess.Popen(
    ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)(deny network*)", str(ROOT / "native/bin/PaceNative")],
    cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, bufsize=1,
)


def read_output():
    for line in worker.stdout:
        try:
            event = json.loads(line)
            events.append(event)
            messages.put(event)
        except ValueError:
            messages.put({"fatal": "Native stdout was not JSON: " + line})
    messages.put({"fatal": "Native worker exited."})


threading.Thread(target=read_output, daemon=True).start()


def send(id, method, params):
    worker.stdin.write(json.dumps({"id": id, "method": method, "params": params}) + "\n")
    worker.stdin.flush()


def receive(id):
    while True:
        item = messages.get(timeout=180)
        assert "fatal" not in item, item
        if item.get("id") == id:
            return item


def request(id, method, params, error=None):
    started = time.monotonic()
    send(id, method, params)
    reply = receive(id)
    results.append({"id": id, "seconds": round(time.monotonic() - started, 3), "reply": reply})
    print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    (OUT / "checks.json").write_text(json.dumps(results, indent=2, ensure_ascii=False))
    if error:
        assert reply.get("error", {}).get("code") == error, reply
    else:
        assert "error" not in reply, reply
    return reply.get("result")


try:
    status = request("models", "models.status", {})
    baseline = {"qwen3.5-4b", "qwen3-tts-0.6b", "whisper-turbo", "nemotron-diarization"}
    assert all(item["installed"] for item in status if item["id"] in baseline), "Install the baseline model pack first."
    request("chat", "chat.generate", {"messages": [{"role": "user", "content": "Say hello as Pace, a little desktop pet."}], "maxTokens": 48})
    request("precise-invalid", "chat.generate", {"messages": [{"role": "user", "content": "Hello"}], "precise": 1, "maxTokens": 16}, "invalid_params")
    request("precise-invalid-string", "chat.generate", {"messages": [{"role": "user", "content": "Hello"}], "precise": "true", "maxTokens": 16}, "invalid_params")
    request("precise", "chat.generate", {"messages": [{"role": "user", "content": "Amina will prepare release notes by Friday. She will write a tutorial with no agreed deadline. List these two tasks separately, preserving each deadline."}], "precise": True, "maxTokens": 128})
    voice = request("voice", "voice.speak", {"text": "Hello! I am Pace, your little desktop friend.", "voiceEngine": "qwen", "voice": "Ono_Anna", "language": "en", "play": False})
    assert pathlib.Path(voice["path"]).stat().st_size > 10000
    wav = OUT / "roundtrip-16k.wav"
    subprocess.run(["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", voice["path"], str(wav)], check=True)
    transcript = request("asr", "audio.transcribe", {"path": str(wav), "language": "en"})
    assert "hello" in transcript["text"].lower(), transcript
    assert len(transcript["segments"]) >= 5, "Whisper must return word segments for diarization."
    previous = 0
    for segment in transcript["segments"]:
        assert 0 <= previous <= segment["startMs"] <= segment["endMs"], segment
        assert segment["end"] > segment["start"] >= 0, segment
        assert segment["start"] == segment["startMs"] / 1000, segment
        previous = segment["startMs"]
    request("invalid", "chat.generate", {"messages": [{"role": "user", "content": "hello"}], "maxTokens": 999999}, "invalid_params")
    request("long", "chat.generate", {"messages": [{"role": "system", "content": "Be concise."}, {"role": "user", "content": "你好，世界。" * 5000}], "maxTokens": 16}, "context_too_long")
    request("trim", "chat.generate", {"messages": [{"role": "system", "content": "You are Pace. Introduce yourself in one short sentence."}, {"role": "user", "content": "old context " * 8000}, {"role": "assistant", "content": "An old answer."}, {"role": "user", "content": "Say hello as Pace."}], "maxTokens": 48})
    assert any(item.get("event") == "chat.contextTrimmed" for item in events)
    send("cancel-chat", "chat.generate", {"messages": [{"role": "user", "content": "Write a very long detailed story, at least 2000 words."}], "maxTokens": 2048})
    while True:
        item = messages.get(timeout=60)
        assert "fatal" not in item, item
        if item.get("event") == "chat.delta":
            break
    request("responsive", "runtime.status", {})
    send("cancel", "runtime.cancel", {"id": "cancel-chat"})
    remaining = {"cancel", "cancel-chat"}
    while remaining:
        item = messages.get(timeout=60)
        if item.get("id") in remaining:
            remaining.remove(item["id"])
            if item["id"] == "cancel-chat":
                assert item.get("error", {}).get("code") == "cancelled", item
    request("stop", "voice.stop", {})
    released = request("released", "runtime.status", {})
    assert released["voiceLoaded"] is False
    print("Real inference checks passed with network access denied.", flush=True)
finally:
    (OUT / "checks-events.jsonl").write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in events))
    worker.stdin.close()
    try:
        worker.wait(timeout=10)
    except subprocess.TimeoutExpired:
        worker.terminate()
        worker.wait(timeout=10)
    stderr.close()
