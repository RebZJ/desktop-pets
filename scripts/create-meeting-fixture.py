#!/usr/bin/env python3
"""Generate a labelled synthetic meeting with macOS voices; records no live audio."""
import argparse
import json
import pathlib
import subprocess
import wave

parser = argparse.ArgumentParser()
parser.add_argument('--output', default='artifacts/runtime/meeting-fixture')
args = parser.parse_args()
directory = pathlib.Path(args.output).resolve()
directory.mkdir(parents=True, exist_ok=True)
turns = [
    ('Samantha', 'Hello everyone. This is a synthetic test meeting. We need a date for the desktop pets launch. I am Amina. I will prepare the release notes by Friday.'),
    ('Daniel', 'Thanks Amina. We decided to launch on Monday. I am Daniel. I will test the Mac installer by Friday. The open question is whether we should add more pet sounds.'),
    ('Samantha', 'That sounds good. I will write the tutorial too. There is no agreed deadline for the tutorial. Please keep the pet muted during meetings.'),
    ('Daniel', 'Agreed. Daniel owns the installer test. The launch remains Monday. We have not decided on the extra sounds.'),
]
pcm = bytearray()
truth = []
for index, (voice, text) in enumerate(turns):
    aiff = directory / f'{index}.aiff'
    wav = directory / f'{index}.wav'
    subprocess.run(['/usr/bin/say', '-v', voice, '-r', '155', '-o', str(aiff), text], check=True)
    subprocess.run(['/usr/bin/afconvert', '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', str(aiff), str(wav)], check=True)
    with wave.open(str(wav)) as source:
        assert (source.getnchannels(), source.getsampwidth(), source.getframerate()) == (1, 2, 16000)
        audio = source.readframes(source.getnframes())
    start = len(pcm) / 32000
    pcm.extend(audio)
    truth.append({'start': start, 'end': len(pcm) / 32000, 'speaker': index % 2 + 1, 'text': text})
    pcm.extend(bytes(12800))
output = directory / 'meeting.wav'
with wave.open(str(output), 'wb') as target:
    target.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
    target.writeframes(pcm)
(directory / 'truth.json').write_text(json.dumps(truth, indent=2))
print(json.dumps({'path': str(output), 'duration': len(pcm) / 32000, 'turns': len(truth)}))
