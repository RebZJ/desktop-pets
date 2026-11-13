// Disposable debug host only: install Whisper, leave NeMo absent to exercise recovery.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { requestJSON } from './soak.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeFile = path.resolve(process.env.PACE_E2E_BRIDGE_FILE || '');
assert(bridgeFile.startsWith(path.join(root, 'artifacts/runtime/')));
const bridge = JSON.parse(await fs.readFile(bridgeFile, 'utf8'));
const endpoint = new URL(bridge.url);
assert.equal(endpoint.hostname, '127.0.0.1');
const call = (method, params = {}) => requestJSON(endpoint, bridge.token, method, params);
const runtime = await call('runtime.status');
assert.equal(path.resolve(runtime.dataDirectory), path.dirname(bridgeFile));
const state = await call('app.state');
assert.equal(state.settings.memoryEnabled, false);
assert(!state.meetings.some(meeting => ['recording', 'finalizing'].includes(meeting.status)));
assert(state.models.some(model => model.id === 'whisper-turbo' && model.installed));
assert(!state.models.some(model => model.id === 'nemotron-diarization' && model.installed));
const ids = [];
try {
  const empty = randomUUID(); ids.push(empty);
  await call('_test.meeting.seed', { id: empty, status: 'interrupted', segments: [], notes: 'Saved user notes', actionItems: [] });
  await assert.rejects(call('meeting.summarize', { id: empty }), /No speech was detected/);
  let saved = (await call('meeting.list')).find(meeting => meeting.id === empty);
  assert.equal(saved.status, 'interrupted');
  assert.match(saved.error, /No speech was detected/);
  assert.equal(saved.notes, 'Saved user notes');

  const spoken = randomUUID(); ids.push(spoken);
  const directory = path.join(path.dirname(bridgeFile), 'recordings', spoken);
  await fs.mkdir(directory, { recursive: true });
  const audio = path.join(directory, 'microphone.wav');
  await fs.copyFile(path.join(root, 'artifacts/runtime/meeting-fixture/0.wav'), audio);
  await call('_test.meeting.seed', { id: spoken, status: 'interrupted', notes: 'Saved user notes', actionItems: [],
    segments: [{ track: 'system', start: 20, end: 21, text: 'Existing provisional transcript' }], capture: { directory } });
  await assert.rejects(call('meeting.retry', { id: spoken }), /Install the Nemotron/);
  saved = (await call('meeting.list')).find(meeting => meeting.id === spoken);
  assert.equal(saved.status, 'interrupted');
  assert.match(saved.error, /Install the Nemotron/);
  assert.equal(saved.notes, 'Saved user notes');
  assert(saved.segments.some(segment => segment.track === 'system' && segment.text === 'Existing provisional transcript'));
  assert.match(saved.segments.filter(segment => segment.track === 'microphone').map(segment => segment.text).join(' '), /release notes/i);
  await fs.access(audio);
  console.log('Meeting recovery: blank notes rejected; transcript, notes, other tracks and audio preserved after diarization failure.');
} finally {
  for (const id of ids) await call('meeting.delete', { id });
}
