#!/usr/bin/env python3
"""Exercise the real debug NativeManager against a fake STDIO adapter on macOS.

Run after `cargo build --manifest-path src-tauri/Cargo.toml --locked`:
  python3 scripts/test-native-transport.py [--binary PATH] [--expect-binary-sha256 HASH]
Uses only an owned app/profile, port 41432, synthetic text and fake clipboard metadata.
"""
import argparse
import hashlib
import json
import os
import plistlib
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = 41432
BINARY = ROOT / 'src-tauri/target/debug/desktop-pets'
TEMPLATE = ROOT / 'artifacts/release/Desktop Pets.app'
STUB = ROOT / 'tests/fixtures/native-transport-stub.py'


def wait_for(check, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.03)
    raise AssertionError('Owned fixture did not reach the expected state before its deadline')


def events(file):
    if not file.exists():
        return []
    return [json.loads(line) for line in file.read_text().splitlines() if line.strip()]


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def rpc(bridge, method, params=None, timeout=10):
    assert bridge['url'] == f'http://127.0.0.1:{PORT}'
    request = urllib.request.Request(bridge['url'], json.dumps({'method': method, 'params': params or {}}).encode(),
                                     {'Authorization': 'Bearer ' + bridge['token'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        value = json.load(response)
    assert value.get('ok'), f'Owned fixture RPC failed: {method}'
    return value['data']


def run_mode(base, app, mode):
    directory = base / mode
    directory.mkdir(mode=0o700)
    profile = directory / 'profile'
    profile.mkdir(mode=0o700)
    models = profile / 'models'
    models.mkdir(mode=0o700)
    database = profile / 'desktop-pets.sqlite'
    with sqlite3.connect(database) as connection:
        connection.execute('CREATE TABLE settings(id INTEGER PRIMARY KEY, data TEXT NOT NULL)')
        settings = {'onboardingCompleted': True, 'soundEnabled': False, 'speechEnabled': False,
                    'hideShortcut': 'Control+Alt+Shift+Super+F20', 'commandShortcut': 'Control+Alt+Shift+Super+F21',
                    'dictationShortcut': 'Control+Alt+Shift+Super+F22'}
        connection.execute('INSERT INTO settings VALUES(1,?)', [json.dumps(settings)])
    stub_log = profile / 'stub.jsonl'
    environment = os.environ.copy()
    environment.update(PACE_E2E_PORT=str(PORT), PACE_E2E_TOKEN=uuid.uuid4().hex,
                       PACE_E2E_DATA_DIR=str(profile), PACE_MODELS_DIR=str(models),
                       PACE_TEST_NATIVE_TRANSPORT_MODE=mode, PACE_TEST_NATIVE_TRANSPORT_LOG=str(stub_log))
    bridge_file = profile / 'e2e-bridge.json'
    host_log = (directory / 'host.log').open('wb')
    process = subprocess.Popen([str(app / 'Contents/MacOS/desktop-pets')], env=environment,
                               stdout=host_log, stderr=host_log, start_new_session=True)
    bridge = None
    result = {'mode': mode, 'passed': False, 'hostPid': process.pid, 'profile': str(profile)}
    try:
        def ready():
            assert process.poll() is None, 'Owned debug host exited before its bridge was ready'
            if not bridge_file.exists():
                return None
            try:
                return json.loads(bridge_file.read_text())
            except json.JSONDecodeError:
                return None
        bridge = wait_for(ready)
        assert bridge['token'] == environment['PACE_E2E_TOKEN']
        assert bridge_file.stat().st_mode & 0o077 == 0, 'Bridge credentials must remain private'
        runtime = rpc(bridge, 'runtime.status')
        assert Path(runtime['dataDirectory']).resolve() == profile.resolve(), 'Refusing a host outside the owned profile'
        state = rpc(bridge, 'app.state')
        assert not state['meetings'] and not state['memory']['enabled']
        assert not any(model['installed'] for model in state['models']) and not any(models.iterdir())
        rpc(bridge, 'pet.toggle', {'visible': False, 'immediate': True})
        target = rpc(bridge, '_test.dictation.capture')
        assert target['targetId'] == 'transport-fixture-target' and target['app'] == 'STDIO fixture'
        wait_for(lambda: any(event['event'] == ('stdin-paused' if mode == 'write' else 'started') for event in events(stub_log)))
        started = time.monotonic()
        if mode == 'write':
            outcome = rpc(bridge, '_test.dictation.insert', {'targetId': target['targetId'], 'text': 'x' * 100_000})
            elapsed = time.monotonic() - started
            assert elapsed < 3.25, f'Blocked native input took {elapsed:.3f}s instead of the bounded write deadline'
            assert outcome['dispatched'] is True and outcome['verified'] is False and outcome['inserted'] is False
            assert 'input connection stopped' in outcome['insertionError'].lower()
            stub_pid = events(stub_log)[0]['pid']
            wait_for(lambda: not alive(stub_pid), 3)
            assert not any(event.get('method') == 'dictation.insert' for event in events(stub_log)), 'Blocked input was unexpectedly read/retried'
            result.update(milliseconds=round(elapsed * 1000), workerExited=True, insertRequestsRead=0)
        else:
            # A thread owns only this bridge request; the main thread triggers only this host's hide API.
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(rpc, bridge, '_test.dictation.insert', {'targetId': target['targetId'], 'text': 'Synthetic transport check.'})
                held = wait_for(lambda: next((event for event in events(stub_log) if event['event'] == 'insert-held'), None))
                cancelled = time.monotonic()
                rpc(bridge, 'pet.toggle', {'visible': False, 'immediate': True})
                outcome = pending.result(timeout=4)
                elapsed = time.monotonic() - cancelled
            assert elapsed < 3, f'Scoped cancellation took {elapsed:.3f}s'
            assert outcome['dispatched'] is True and outcome['verified'] is False and outcome['inserted'] is False
            assert outcome['clipboardRecoveryId'] == 'mock-original-clipboard-lease'
            assert 'Fixture cancellation' in outcome['insertionError']
            recorded = events(stub_log)
            assert len([event for event in recorded if event.get('method') == 'dictation.insert']) == 1
            cancellations = [event for event in recorded if event['event'] == 'cancel']
            assert len(cancellations) == 1 and cancellations[0]['matched'] is True
            assert cancellations[0]['targetId'] == held['requestId']
            result.update(milliseconds=round(elapsed * 1000), insertRequestsRead=1, scopedCancelMatched=True, clipboardRecoveryMetadataRetained=True)
        result.update(passed=True, isolatedProfileVerified=True, installedModels=0, realAudioOpened=False, realInputSent=False, realClipboardAccessed=False)
    finally:
        forced = False
        if process.poll() is None:
            if bridge:
                try:
                    rpc(bridge, '_test.quit', timeout=2)
                except Exception:
                    pass
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                forced = True
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=3)
        host_log.close()
        for event in events(stub_log):
            if event['event'] == 'started':
                wait_for(lambda: not alive(event['pid']), 3)
        result.update(hostExited=process.poll() is not None, hostExitCode=process.returncode, forcedCleanup=forced)
        (directory / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
        if result['passed']:
            assert not forced and process.returncode == 0, 'Owned host did not exit cleanly'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=BINARY)
    parser.add_argument('--expect-binary-sha256')
    args = parser.parse_args()
    assert sys.platform == 'darwin', 'This app-bundle STDIO transport check currently runs on macOS only'
    binary = args.binary.resolve()
    assert binary.is_file() and TEMPLATE.is_dir() and STUB.is_file()
    native_source = binary.parents[2] / 'src/native.rs'
    assert native_source.is_file() and binary.stat().st_mtime >= native_source.stat().st_mtime, 'Refresh the debug host after NativeManager edits'
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    if args.expect_binary_sha256:
        assert digest == args.expect_binary_sha256, 'Debug binary does not match the approved refreshed build'
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(('127.0.0.1', PORT))
    previous_umask = os.umask(0o077)
    try:
        base = Path(tempfile.mkdtemp(prefix='pace-native-transport-', dir='/private/tmp')).resolve()
        assert base.parent == Path('/private/tmp') and base.name.startswith('pace-native-transport-')
        app = base / 'Transport Fixture.app'
        shutil.copytree(TEMPLATE, app, symlinks=True)
        shutil.copy2(binary, app / 'Contents/MacOS/desktop-pets')
        shutil.copy2(STUB, app / 'Contents/Resources/native/PaceNative')
        (app / 'Contents/Resources/native/PaceNative').chmod(0o700)
        with (app / 'Contents/Info.plist').open('rb') as file:
            metadata = plistlib.load(file)
        metadata['CFBundleIdentifier'] = 'app.desktoppets.transport-fixture.' + uuid.uuid4().hex
        with (app / 'Contents/Info.plist').open('wb') as file:
            plistlib.dump(metadata, file)
        report = {'binary': str(binary), 'binarySha256': digest, 'fixtureDirectory': str(base), 'port': PORT,
                  'scope': 'Real debug Tauri NativeManager; fake STDIO adapter and synthetic outcomes only.', 'results': []}
        for mode in ('write', 'cancel-recovery'):
            report['results'].append(run_mode(base, app, mode))
        (base / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    finally:
        os.umask(previous_umask)


if __name__ == '__main__':
    main()
