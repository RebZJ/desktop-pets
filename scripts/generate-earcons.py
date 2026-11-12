#!/usr/bin/env python3
"""Generate Pace's six original, quiet critter sounds; --check verifies shipped PCM."""
import hashlib
import json
import math
from pathlib import Path
import random
import struct
import sys
import wave

RATE = 24_000
ROOT = Path(__file__).resolve().parents[1] / 'public/pets/pace/sounds'
CLIPS = {
    'happy-chirp': .25,
    'curious-trill': .34,
    'sleepy-purr': .48,
    'surprised-squeak': .18,
    'celebration': .42,
    'attention': .25,
}


def envelope(t, duration, attack=.012, release=.05):
    return math.sin(min(1, t / attack) * math.pi / 2) ** 2 * math.sin(min(1, (duration - t) / release) * math.pi / 2) ** 2


def render(name, duration):
    noise = random.Random(20261113 + list(CLIPS).index(name))
    phase = 0.0
    previous_noise = 0.0
    samples = []
    for frame in range(round(duration * RATE)):
        t = frame / RATE
        p = t / duration
        breath = noise.uniform(-1, 1)
        airy = breath - previous_noise
        previous_noise = breath
        if name == 'happy-chirp':
            frequency = 660 + 550 * p + 65 * math.sin(2 * math.pi * 9 * t)
            amplitude = .065 * (.55 + .45 * math.sin(2 * math.pi * 5 * t) ** 2)
            modulation = .45 * math.sin(2 * math.pi * 62 * t)
        elif name == 'curious-trill':
            frequency = 470 + 390 * p + 55 * math.sin(2 * math.pi * 20 * t)
            amplitude = .062 * (.35 + .65 * math.sin(2 * math.pi * 12 * t) ** 2)
            modulation = .5 * math.sin(2 * math.pi * 83 * t)
        elif name == 'sleepy-purr':
            frequency = 100 - 25 * p + 4 * math.sin(2 * math.pi * 24 * t)
            amplitude = .072 * (.5 + .5 * math.sin(2 * math.pi * 26 * t) ** 2)
            modulation = .85 * math.sin(2 * math.pi * 51 * t)
        elif name == 'surprised-squeak':
            frequency = 1050 + 1050 * math.sin(math.pi * p)
            amplitude = .06
            modulation = .8 * math.sin(2 * math.pi * 105 * t)
        elif name == 'celebration':
            note = min(2, int(t / .14))
            local = t % .14
            frequency = [580, 780, 1040][note] + local * 1500
            amplitude = .07 * envelope(local, .14, .008, .035)
            modulation = .5 * math.sin(2 * math.pi * 75 * t)
        else:
            frequency = 430 + 290 * p + 25 * math.sin(2 * math.pi * 16 * t)
            amplitude = .062 * (.4 + .6 * math.sin(2 * math.pi * 6 * t) ** 2)
            modulation = .55 * math.sin(2 * math.pi * 67 * t)
        phase += 2 * math.pi * frequency / RATE
        voice = math.sin(phase + modulation) + .19 * math.sin(2 * phase + .3) + .055 * math.sin(3 * phase)
        signal = (voice * .8 + airy * .035) * amplitude * envelope(t, duration, .025 if name == 'sleepy-purr' else .008, .08 if name == 'sleepy-purr' else .04)
        samples.append(round(max(-1, min(1, signal)) * 32767))
    return struct.pack(f'<{len(samples)}h', *samples)


def check():
    total = 0
    manifest = json.loads((ROOT.parent / 'manifest.json').read_text())
    assert set(manifest['sounds']) == {action['id'] for action in manifest['actions']}
    assert set(manifest['sounds'].values()) == {f'sounds/{name}.wav' for name in CLIPS}
    for name, duration in CLIPS.items():
        path = ROOT / f'{name}.wav'
        raw = path.read_bytes()
        assert raw[:4] == b'RIFF' and raw[8:12] == b'WAVE', name
        assert struct.unpack('<I', raw[4:8])[0] == len(raw) - 8, name
        with wave.open(str(path), 'rb') as clip:
            assert (clip.getnchannels(), clip.getsampwidth(), clip.getframerate(), clip.getcomptype()) == (1, 2, RATE, 'NONE'), name
            assert clip.getnframes() == round(duration * RATE) < RATE, name
            pcm = clip.readframes(clip.getnframes())
        assert hashlib.sha256(pcm).digest() == hashlib.sha256(render(name, duration)).digest(), name
        levels = struct.unpack(f'<{len(pcm) // 2}h', pcm)
        assert .01 < max(abs(value) for value in levels) / 32768 < .1, name
        assert levels[0] == 0 and abs(levels[-1]) < 30, name
        total += len(raw)
    assert len(list(ROOT.glob('*.wav'))) == 6, 'Expected exactly six original clips'
    assert total < 120_000, total
    print(f'Checked six original PCM16 mono {RATE} Hz earcons: {total:,} bytes total; all below one second and -20 dBFS peak. No audio played.')


if __name__ == '__main__':
    if sys.argv[1:] not in ([], ['--check']):
        raise SystemExit('Usage: python3 scripts/generate-earcons.py [--check]')
    if not sys.argv[1:]:
        ROOT.mkdir(parents=True, exist_ok=True)
        for name, duration in CLIPS.items():
            with wave.open(str(ROOT / f'{name}.wav'), 'wb') as clip:
                clip.setnchannels(1)
                clip.setsampwidth(2)
                clip.setframerate(RATE)
                clip.writeframes(render(name, duration))
    check()
