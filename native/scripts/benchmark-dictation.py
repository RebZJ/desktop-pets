#!/usr/bin/env python3
"""Compare local dictation pipelines on identical synthetic Kiki speech, offline."""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import time
import wave

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/runtime/dictation-benchmark-20261113'
spec = importlib.util.spec_from_file_location('audition', ROOT / 'native/scripts/audition-kitten.py')
audition = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audition)


def words(text):
    text = text.lower().replace('’', "'")
    for left, right in [("i'm", 'i am'), ("let's", 'let us'), ("you're", 'you are'),
                        ('$12.50', 'twelve dollars fifty cents'), ('12 dollars and 50 cents', 'twelve dollars fifty cents'),
                        ('twelve dollars and fifty cents', 'twelve dollars fifty cents'),
                        ('2:30', 'two thirty'), ('13th', 'thirteen'), ('thirteenth', 'thirteen'),
                        ('13', 'thirteen'), ('1, 2, 3', 'one two three'), ('1 2 3', 'one two three'),
                        ('p.m.', 'p m'), ('pm', 'p m'), ('typescript', 'type script'), ('readme', 'read me'),
                        ('api', 'a p i'), ('cpu', 'c p u')]:
        text = text.replace(left, right)
    return re.findall(r"[a-z]+|[0-9]+", text)


def errors(reference, hypothesis):
    previous = list(range(len(hypothesis) + 1))
    for i, expected in enumerate(reference, 1):
        current = [i]
        for j, actual in enumerate(hypothesis, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (expected != actual)))
        previous = current
    return previous[-1]


def convert(source, target):
    if not target.exists():
        subprocess.run(['/usr/bin/afconvert', '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', str(source), str(target)], check=True)


def main():
    assert errors(['one', 'two'], ['one', 'two']) == 0
    assert errors(['one', 'two'], ['one', 'three']) == 1
    OUT.mkdir(parents=True, exist_ok=True)
    audio = OUT / 'audio'
    audio.mkdir(exist_ok=True)
    cases = []
    observed = set()
    sources = json.loads((ROOT / 'artifacts/runtime/kitten-final-20261113/results.json').read_text())
    for source in sources:
        if source['voice'] != 'Kiki' or source['text'] in observed:
            continue
        observed.add(source['text'])
        target = audio / f'line-{len(cases):02d}.wav'
        convert(Path(source['path']), target)
        cases.append({'id': f'line-{len(cases):02d}', 'reference': source['text'], 'path': str(target)})
    silence = audio / 'silence.wav'
    with wave.open(str(silence), 'wb') as output:
        output.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        output.writeframes(bytes(16000 * 2 * 3))
    cases.append({'id': 'silence', 'reference': '', 'path': str(silence)})
    named = audio / 'proper-names.wav'
    prompt = 'Please open Blocc and send the notes to Anushka Sharma.'
    if not named.exists():
        audition.OUT = OUT / 'speech-fixture'
        audition.OUT.mkdir(exist_ok=True)
        worker = audition.Worker()
        try:
            result = worker.request('names', 'voice.speak', {'voiceEngine': 'kitten', 'voice': 'Kiki', 'text': prompt, 'language': 'English', 'pitch': 1, 'play': False})
            convert(Path(result['path']), named)
        finally:
            worker.close()
    cases += [{'id': 'proper-names-plain', 'reference': prompt, 'path': str(named)},
              {'id': 'proper-names-hinted', 'reference': prompt, 'path': str(named), 'vocabulary': 'Blocc\nAnushka Sharma'}]
    baseline = OUT / 'whisper-only-models'
    baseline.mkdir(exist_ok=True)
    whisper = Path.home() / 'Library/Application Support/Desktop Pets/models/whisper-turbo'
    destination = baseline / 'whisper-turbo'
    if not destination.exists():
        destination.symlink_to(whisper, target_is_directory=True)
    results = []
    for engine in ['moonshine', 'whisper']:
        audition.OUT = OUT / engine
        audition.OUT.mkdir(exist_ok=True)
        env = os.environ.copy()
        if engine == 'whisper':
            env['PACE_MODELS_DIR'] = str(baseline)
        worker = audition.Worker(env=env)
        try:
            for index, case in enumerate(cases):
                started = time.monotonic()
                result = worker.request(f'{engine}-{index}', 'audio.transcribe', {'path': case['path'], 'purpose': 'dictation', 'language': 'en', 'dictationVocabulary': case.get('vocabulary', '')})
                normalized = words(result['text'])
                reference = words(case['reference'])
                row = {**case, 'engine': engine, 'wallMs': (time.monotonic() - started) * 1000,
                       'result': result, 'normalizedEditErrors': errors(reference, normalized), 'referenceWords': len(reference),
                       'peakProcessRSSBytesSoFar': worker.peak_rss}
                results.append(row)
                (OUT / 'results.json').write_text(json.dumps(results, indent=2))
                print(json.dumps(row), flush=True)
                if case['id'] == 'silence':
                    assert not result['text'].strip(), f'{engine} inserted speech on silence: {result}'
            if engine == 'moonshine':
                for language in ['zh', 'ja', 'es']:
                    result = worker.request('silence-' + language, 'audio.transcribe', {'path': str(silence), 'purpose': 'dictation', 'language': language, 'dictationVocabulary': 'Blocc'})
                    assert result['model'] == 'moonshine-tiny-' + language and not result['text'].strip(), result
                    (OUT / f'silence-{language}.json').write_text(json.dumps(result, indent=2))
        finally:
            worker.close()
    summary = {}
    for engine in ['moonshine', 'whisper']:
        rows = [row for row in results if row['engine'] == engine and row['id'].startswith('line-')]
        summary[engine] = {'clips': len(rows), 'medianWallMs': statistics.median(row['wallMs'] for row in rows),
                           'normalizedEditErrors': sum(row['normalizedEditErrors'] for row in rows),
                           'referenceWords': sum(row['referenceWords'] for row in rows)}
    (OUT / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == '__main__':
    main()
