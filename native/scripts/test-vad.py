#!/usr/bin/env python3
"""Real Silero + Whisper checks on original audio, including long silent gaps."""
import json
import math
import pathlib
import queue
import random
import struct
import subprocess
import threading
import time
import wave

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/runtime/vad'
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'gate-summary.json').unlink(missing_ok=True)
RATE = 16000
results = []
responses = queue.Queue()
stderr = (OUT / 'worker-stderr.log').open('w')
worker = subprocess.Popen(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)', str(ROOT / 'native/bin/PaceNative')], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True, bufsize=1)


def read_output():
    for line in worker.stdout:
        try:
            responses.put(json.loads(line))
        except ValueError:
            responses.put({'fatal': line})
    responses.put({'fatal': 'Worker exited'})


threading.Thread(target=read_output, daemon=True).start()


def request(id, method, params):
    started = time.monotonic()
    worker.stdin.write(json.dumps({'id': id, 'method': method, 'params': params}, ensure_ascii=False) + '\n')
    worker.stdin.flush()
    while True:
        reply = responses.get(timeout=180)
        assert 'fatal' not in reply, reply
        if reply.get('id') == id:
            break
    results.append({'id': id, 'seconds': round(time.monotonic() - started, 3), 'reply': reply})
    (OUT / 'gate-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    assert 'error' not in reply, reply
    result = reply['result']
    print(json.dumps({'id': id, 'seconds': results[-1]['seconds'], 'text': result.get('text'), 'windows': result.get('windows'), 'speechWindows': result.get('speechWindows')}, ensure_ascii=False), flush=True)
    return result


def write_wave(name, data):
    path = OUT / (name + '.wav')
    with wave.open(str(path), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(data)
    return path


def read_wave(path):
    with wave.open(str(path), 'rb') as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, RATE)
        return wav.readframes(wav.getnframes())


def transcribe(name, path, language='en'):
    value = request(name, 'audio.transcribe', {'path': str(path), 'language': language})
    assert value['vad'] == 'silero-v6.2.0'
    previous = 0
    for segment in value['segments']:
        assert segment['start'] == segment['startMs'] / 1000
        assert segment['end'] == segment['endMs'] / 1000
        assert previous <= segment['start'] < segment['end'], segment
        previous = segment['start']
    return value


try:
    fixtures = {}
    specs = [
        ('en', 'Hello! I am Pace, your little desktop friend.', ['hello', 'little', 'desktop', 'friend'], 'roundtrip-16k.wav'),
        ('zh', '你好，我是佩斯，你的桌面小伙伴。', ['你好', '桌面', '小伙伴'], 'pace-zh-16k.wav'),
        ('ja', 'こんにちは。私はペース、あなたの小さなデスクトップの友達です。', ['こんにちは', 'デスクトップ', '友達'], 'pace-ja-16k.wav'),
        ('es', 'Hola, soy Pace, tu pequeño amigo del escritorio.', ['hola', 'pequeño', 'escritorio'], 'pace-es-16k.wav'),
    ]
    for language, text, required, existing in specs:
        path = ROOT / 'artifacts/runtime/native' / existing
        if not path.exists():
            voice = request('make-' + language, 'voice.speak', {'text': text, 'language': language, 'voice': 'Ono_Anna', 'play': False})
            path = OUT / ('generated-' + language + '.wav')
            subprocess.run(['/usr/bin/afconvert', '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', voice['path'], str(path)], check=True)
        fixtures[language] = path
    request('release-voice', 'voice.stop', {})
    for language, _, required, _ in specs:
        transcript = transcribe('speech-' + language, fixtures[language], language)
        normalized = transcript['text'].lower().replace(' ', '')
        for word in required:
            assert word.replace(' ', '') in normalized, (language, word, transcript)
        assert transcript['speechWindows'] == 1
    silence = bytes(3 * RATE * 2)
    tone = b''.join(struct.pack('<h', int(6000 * math.sin(2 * math.pi * 440 * n / RATE))) for n in range(10 * RATE))
    rng = random.Random(7)
    noise = b''.join(struct.pack('<h', rng.randint(-1200, 1200)) for _ in range(5 * RATE))
    for name, samples in [('silence', silence), ('tone', tone), ('noise', noise)]:
        transcript = transcribe(name, write_wave(name, samples))
        assert transcript['text'] == '' and transcript['segments'] == [] and transcript['speechWindows'] == 0, transcript
    speech = read_wave(fixtures['en'])
    quiet = b''.join(struct.pack('<h', int(sample[0] / 10)) for sample in struct.iter_unpack('<h', speech))
    transcript = transcribe('quiet-speech', write_wave('quiet-speech', quiet))
    assert all(word in transcript['text'].lower() for word in ['hello', 'desktop', 'friend']), transcript
    long_gap = bytes(3 * RATE * 2) + speech + bytes(65 * RATE * 2) + speech + bytes(2 * RATE * 2)
    second_start = 3 + len(speech) / (2 * RATE) + 65
    transcript = transcribe('long-gapped-speech', write_wave('long-gapped-speech', long_gap))
    assert transcript['windows'] == 3 and transcript['speechWindows'] == 2, transcript
    assert transcript['text'].lower().count('hello') == 2 and transcript['text'].lower().count('friend') == 2, transcript
    assert any(word['start'] >= second_start - 1 and 'hello' in word['text'].lower() for word in transcript['segments']), transcript
    assert not any(10 < word['start'] < second_start - 1 for word in transcript['segments']), transcript
    short_gap = bytes(3 * RATE * 2) + speech + bytes(5 * RATE * 2) + speech + bytes(2 * RATE * 2)
    transcript = transcribe('same-window-pause', write_wave('same-window-pause', short_gap))
    short_second_start = 3 + len(speech) / (2 * RATE) + 5
    assert transcript['windows'] == 1 and transcript['text'].lower().count('hello') == 2, transcript
    first_friend = next(word for word in transcript['segments'] if 'friend' in word['text'].lower())
    assert first_friend['end'] < 10, transcript
    assert any(word['start'] >= short_second_start - 1 and 'hello' in word['text'].lower() for word in transcript['segments']), transcript
    boundary = bytes(26 * RATE * 2) + speech + bytes(4 * RATE * 2)
    transcript = transcribe('boundary-speech', write_wave('boundary-speech', boundary))
    assert all(word in transcript['text'].lower() for word in ['hello', 'little', 'desktop', 'friend']), transcript
    assert transcript['text'].lower().count('hello') == 1, transcript
    (OUT / 'gate-summary.json').write_text(json.dumps({'passed': True, 'networkDenied': True, 'languages': ['en', 'zh', 'ja', 'es'], 'longSilenceSeconds': 65, 'secondUtteranceStartSeconds': second_start, 'cases': len(results)}, indent=2))
    print('Real VAD checks passed with network access denied.', flush=True)
finally:
    worker.stdin.close()
    try:
        worker.wait(timeout=10)
    except subprocess.TimeoutExpired:
        worker.terminate()
        worker.wait(timeout=10)
    stderr.close()
