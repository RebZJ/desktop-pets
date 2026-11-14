// Run against a disposable debug host; never the installed user's profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.resolve(process.env.PACE_E2E_BRIDGE_FILE || path.join(root, 'artifacts/runtime/companion-controls/e2e-bridge.json'));
assert(file.startsWith(path.join(root, 'artifacts/runtime/')), 'Use an isolated runtime directory.');
let bridge;
for (let attempt=0; attempt<30; attempt++) {
  try {
    const candidate=JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(new URL(candidate.url).hostname,'127.0.0.1');
    const ready=await fetch(candidate.url,{method:'POST',headers:{authorization:`Bearer ${candidate.token}`,'content-type':'application/json'},body:JSON.stringify({method:'_test.windows'}),signal:AbortSignal.timeout(2000)}).then(response=>response.json());
    if (ready.ok) { bridge=candidate; break; }
  } catch { /* LaunchServices starts the disposable host asynchronously. */ }
  await new Promise(resolve=>setTimeout(resolve,500));
}
assert(bridge,'Start the isolated debug host before running this check.');
const checks = [];
async function rpc(method, params = {}, rejection) {
  const reply = await fetch(bridge.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(30000) }).then(response => response.json());
  if (rejection) { assert.equal(reply.ok, false); assert.match(reply.error, rejection); }
  else assert.equal(reply.ok, true, reply.error);
  checks.push({ method, passed: true });
  return reply.data;
}
const runtime = await rpc('runtime.status');
assert.equal(path.resolve(runtime.dataDirectory), path.dirname(file));
const state = await rpc('app.state');
assert.equal(state.memory.enabled, false);
assert(!state.meetings.some(meeting => ['recording', 'finalizing'].includes(meeting.status)));
const labels = ['main', 'pet', 'bubble', 'command', 'meeting'].sort();
async function windows() {
  const value = await rpc('_test.windows');
  assert.deepEqual(value.map(window => window.label).sort(), labels);
  return value;
}
async function settled() { await new Promise(resolve => setTimeout(resolve, 180)); return windows(); }
try {
  assert((await rpc('_test.shortcuts')).registered.every(Boolean));
  let status = await rpc('shortcut.status');
  assert.equal(status.suspended, false);
  assert(Object.values(status.bindings).every(binding => binding.registered));
  await rpc('shortcut.recording', { active: true });
  let keys = await rpc('_test.shortcuts');
  assert.equal(keys.recording, true); assert(keys.registered.every(value => !value));
  status = await rpc('shortcut.status');
  assert.equal(status.suspended, true);
  assert(Object.values(status.bindings).every(binding => !binding.registered));
  await rpc('settings.update', { patch: { dictationShortcut: 'Control+Alt+F8' } });
  assert((await rpc('_test.shortcuts')).registered.every(value => !value));
  await rpc('shortcut.recording', { active: false });
  keys = await rpc('_test.shortcuts');
  assert.equal(keys.recording, false); assert(keys.registered.every(Boolean));
  status = await rpc('shortcut.status');
  assert.equal(status.suspended, false);
  assert(Object.values(status.bindings).every(binding => binding.registered));
  assert.equal(status.bindings.dictationShortcut.shortcut, 'Control+Alt+F8');
  await rpc('settings.update', { patch: { dictationShortcut: state.settings.dictationShortcut } });
  await rpc('completion.suggest', {}, /paused/i);
  for (const enabled of (process.env.PACE_TEST_COVER_TOGGLE === '1' ? [false, true] : [true])) {
    const settings = await rpc('settings.update', { patch: { captureProtectionEnabled: enabled } });
    assert.equal(settings.captureProtectionEnabled, enabled);
    for (const window of await windows()) assert.equal(window.native.sharingType, enabled ? 0 : 1, window.label);
  }
  await rpc('settings.update', { patch: { theme: 'night', interfaceFont: 'fira' } });
  const updated = await rpc('app.state');
  assert.equal(updated.settings.theme, 'night'); assert.equal(updated.settings.interfaceFont, 'fira');
  await rpc('settings.update', { patch: { theme: 'unsupported' } }, /theme|palette|invalid/i);
  await rpc('window.meeting');
  let all = await settled();
  const meeting = all.find(window => window.label === 'meeting');
  assert.equal(meeting.visible, true); assert.equal(meeting.width, 300); assert.equal(meeting.height, 260);
  for (const label of ['bubble', 'command']) assert.equal(all.find(window => window.label === label).visible, false);
  await rpc('window.chat'); all = await settled();
  assert.equal(all.find(window => window.label === 'command').visible, true);
  assert.equal(all.find(window => window.label === 'bubble').visible, false);
  assert.equal((await rpc('_test.dictation')).recording, false);
  assert.equal(all.find(window => window.label === 'meeting').visible, false);
  await rpc('window.meeting');
  await rpc('window.main', { page: 'settings', section: 'shortcuts' });
  await rpc('window.main', { page: 'settings', section: 'appearance' });
  await rpc('window.main', { page: 'settings', section: 'privacy' });
  await rpc('meeting.tip.current', { id: 'missing-synthetic-meeting' }, /not found|unknown|exist/i);
  await rpc('pet.action', { action: 'hush' });
  await rpc('pet.toggle', { visible: false, immediate: true });
  assert((await settled()).every(window => !window.visible));
  await rpc('pet.toggle', { visible: true });
  all = await settled();
  assert.equal(all.find(window => window.label === 'pet').visible, true);
  assert.equal(all.find(window => window.label === 'meeting').visible, false);
  await rpc('permissions.status');
  await rpc('_test.worker.crash');
  await rpc('permissions.status');
  assert.equal((await rpc('_test.dictation')).recording, false);
  await rpc('settings.update', { patch: { theme: state.settings.theme, interfaceFont: state.settings.interfaceFont, captureProtectionEnabled: true } });
  await fs.writeFile(path.join(path.dirname(file), 'controls-results.json'), JSON.stringify({ checks, windows: all, recordingStarted: false }, null, 2));
  console.log(`Passed ${checks.length} native companion operations; no recording started.`);
} finally { await rpc('_test.quit'); }
