#!/usr/bin/env python3
"""Audition the native pinned Kitten bundle offline; --install explicitly downloads it first."""
import argparse
import json
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'artifacts/runtime/kitten-audition-20261113'
LINES = [
    'Hi! I am Pace, your little desktop friend.',
    'You did the hard part. Let us take one tiny step together.',
    'Would you like a little break?',
    'Amina and Jasper will meet on Friday.',
    'The total is $12.50.',
    'Your next meeting is November 13 at 2:30 p.m.',
    'Please check the API and the CPU.',
    'Wait... did we forget the biscuits? Oh, there they are!',
    'Open TypeScript and save the README file.',
    '1, 2, 3. Ready when you are!',
    'Hey, you are doing okay. I am right here.',
    'When the meeting ends, I will help you gather your notes and choose one small thing to do next.',
]


class Worker:
    def __init__(self, offline=True, env=None):
        command = [str(ROOT / 'native/bin/PaceNative')]
        if offline:
            command = ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)', *command]
        self.events = []
        self.messages = queue.Queue()
        self.log = (OUT / ('offline-stderr.log' if offline else 'install-stderr.log')).open('w')
        self.process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.log, text=True, bufsize=1, env=env)
        self.peak_rss = 0
        threading.Thread(target=self.read, daemon=True).start()
        threading.Thread(target=self.memory, daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                message = {'fatal': line}
            self.events.append({'receivedMonotonic': time.monotonic(), **message})
            self.messages.put(message)
        self.messages.put({'fatal': 'Native worker exited'})

    def memory(self):
        while self.process.poll() is None:
            result = subprocess.run(['/bin/ps', '-o', 'rss=', '-p', str(self.process.pid)], capture_output=True, text=True)
            if result.stdout.strip():
                self.peak_rss = max(self.peak_rss, int(result.stdout.strip()) * 1024)
            time.sleep(0.1)

    def request(self, id, method, params):
        self.process.stdin.write(json.dumps({'id': id, 'method': method, 'params': params}) + '\n')
        self.process.stdin.flush()
        while True:
            message = self.messages.get(timeout=300)
            assert 'fatal' not in message, message
            if message.get('id') == id:
                assert 'error' not in message, message
                return message['result']

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=10)
        self.log.close()


def main():
    global OUT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--output', type=Path, default=OUT)
    parser.add_argument('--quick', action='store_true', help='Only the four female alternatives and Jasper, two lines each')
    parser.add_argument('--qwen', action='store_true', help='Also generate two baseline Qwen lines')
    args = parser.parse_args()
    OUT = args.output.resolve()
    OUT.mkdir(parents=True, exist_ok=True)
    if args.install:
        installer = Worker(offline=False)
        try:
            result = installer.request('install', 'models.install', {'id': 'kitten-tts-micro-0.8'})
            print(json.dumps(result), flush=True)
        finally:
            installer.close()
    worker = Worker()
    results = []
    try:
        cases = [('kitten', voice, index) for voice in ['Kiki', 'Bella', 'Rosie', 'Luna', 'Jasper'] for index in range(2)]
        if not args.quick:
            cases += [('kitten', 'Kiki', index) for index in range(2, len(LINES))]
        if args.qwen:
            cases += [('qwen', 'Ono_Anna', index) for index in range(2)]
        # Repeat the same greeting after loading, so cold/warm is a matched comparison.
        cases.insert(1, ('kitten', 'Kiki', 0))
        for number, (engine, voice, index) in enumerate(cases):
            started = time.monotonic()
            result = worker.request(f'voice-{number}', 'voice.speak', {
                'voiceEngine': engine, 'voice': voice, 'language': 'English', 'text': LINES[index],
                'pitch': 1, 'rate': 1, 'play': False,
            })
            target = OUT / f'{number:02d}-{engine}-{voice.lower()}-{index + 1:02d}.wav'
            shutil.copyfile(result['path'], target)
            assert target.stat().st_size > 1000, result
            row = {'text': LINES[index], **result, 'path': str(target), 'wallSeconds': time.monotonic() - started,
                   'peakProcessRSSBytesSoFar': worker.peak_rss}
            results.append(row)
            (OUT / 'results.json').write_text(json.dumps(results, indent=2))
            print(json.dumps(row), flush=True)
        # Exercise the actual AVAudioEngine stream path, then interrupt it.
        started = time.monotonic()
        playback = worker.request('playback', 'voice.speak', {'voiceEngine': 'kitten', 'voice': 'Kiki', 'language': 'English', 'text': LINES[0], 'pitch': 1.05, 'play': True})
        assert playback['firstPlaybackScheduledMs'] >= playback['firstAudioMs']
        (OUT / 'playback-first-graph.json').write_text(json.dumps(playback, indent=2))
        time.sleep(playback['duration'] + 0.25)
        started = time.monotonic()
        playback = worker.request('playback-reuse', 'voice.speak', {'voiceEngine': 'kitten', 'voice': 'Kiki', 'language': 'English', 'text': LINES[0], 'pitch': 1.05, 'play': True})
        assert playback['firstPlaybackScheduledMs'] >= playback['firstAudioMs']
        time.sleep(0.25)
        before = time.monotonic()
        worker.request('stop', 'voice.stop', {})
        playback['stopRequestMs'] = (time.monotonic() - before) * 1000
        playback['wallSeconds'] = time.monotonic() - started
        (OUT / 'playback.json').write_text(json.dumps(playback, indent=2))
        (OUT / 'events.jsonl').write_text(''.join(json.dumps(event) + '\n' for event in worker.events))
        print(json.dumps({'playback': playback}), flush=True)
    finally:
        worker.close()


if __name__ == '__main__':
    main()
