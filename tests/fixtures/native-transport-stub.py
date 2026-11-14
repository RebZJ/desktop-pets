#!/usr/bin/env python3
"""STDIO-only NativeManager fixture. Never calls OS input, AX, audio or clipboard APIs."""
import json
import os
import sys
import time
from pathlib import Path

mode = os.environ['PACE_TEST_NATIVE_TRANSPORT_MODE']
assert mode in {'write', 'cancel-recovery'}
log = Path(os.environ['PACE_TEST_NATIVE_TRANSPORT_LOG'])
assert log.parent == Path(os.environ['PACE_DATA_DIR'])


def record(event, **fields):
    with log.open('a') as output:
        output.write(json.dumps({'event': event, 'pid': os.getpid(), **fields}) + '\n')


def reply(request_id, result):
    print(json.dumps({'id': request_id, 'result': result}), flush=True)


record('started', mode=mode)
pending = None
while True:
    # Read one request at a time; write mode intentionally stops before the insert.
    line = sys.stdin.readline()
    if not line:
        break
    request = json.loads(line)
    request_id = request['id']
    method = request['method']
    params = request.get('params', {})
    record('request', method=method, requestId=request_id)
    if method == 'permissions.status':
        reply(request_id, {'accessibility': 'fixture-only', 'microphone': 'fixture-only', 'screenRecording': 'fixture-only'})
    elif method == 'dictation.capture':
        reply(request_id, {'targetId': 'transport-fixture-target', 'canInsert': True, 'app': 'STDIO fixture'})
        if mode == 'write':
            record('stdin-paused')
            while True:
                time.sleep(60)
    elif method == 'dictation.insert':
        assert mode == 'cancel-recovery' and pending is None
        pending = request_id
        record('insert-held', requestId=request_id, textLength=len(params.get('text', '')))
    elif method == 'runtime.cancel':
        matches = pending is not None and params.get('id') == pending
        record('cancel', requestId=request_id, targetId=params.get('id'), matched=matches)
        if matches:
            reply(pending, {'inserted': False, 'dispatched': True, 'verified': False,
                            'insertionError': 'Fixture cancellation: check the original field.',
                            'clipboardRecoveryId': 'mock-original-clipboard-lease'})
            pending = None
        reply(request_id, {'cancelled': matches})
    elif method == 'dictation.discard':
        reply(request_id, {'discarded': True})
    elif method == 'meeting.status':
        reply(request_id, {'recording': False})
    else:
        print(json.dumps({'id': request_id, 'error': {'message': 'Unsupported fixture method'}}), flush=True)
