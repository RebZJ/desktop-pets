// Requires an already launched disposable fixture and isolated debug host. Never launches or focuses apps.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { requestJSON } from './soak.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'artifacts/runtime');
assert(process.env.PACE_E2E_BRIDGE_FILE, 'Set PACE_E2E_BRIDGE_FILE to the isolated debug host bridge.');
const bridgeFile = path.resolve(process.env.PACE_E2E_BRIDGE_FILE);
const stateFile = path.resolve(process.env.PACE_CURSOR_FIXTURE_STATE || path.join(runtime, 'native-cua-fixture/state'));
function isolatedProfile(profile) {
  return profile === runtime || profile.startsWith(runtime + path.sep) || (path.dirname(profile) === path.resolve(tmpdir()) && path.basename(profile).startsWith('desk-pet-e2e-'));
}
assert(isolatedProfile(path.dirname(bridgeFile)) && stateFile.startsWith(runtime + path.sep), 'Use host data under artifacts/runtime or a direct os.tmpdir()/desk-pet-e2e-* directory, and the owned fixture state under artifacts/runtime.');
const bridge = JSON.parse(await fs.readFile(bridgeFile, 'utf8'));
const endpoint = new URL(bridge.url);
assert(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && typeof bridge.token === 'string' && bridge.token.length > 0, 'A token-protected loopback bridge is required.');
const fixtureName = 'Pace Synthetic Cursor Fixture';
const initialText = 'One small step is ';
const reference = 'It was the best of times, it was the worst of times. It was the age of wisdom, it was the age of foolishness.';
const normalize = text => text.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const audio = path.resolve(process.env.PACE_ASR_FIXTURE_PATH || path.join(runtime, 'dictation-benchmark-20261113/human/complete-phrases.wav'));
assert.equal(createHash('sha256').update(await fs.readFile(audio)).digest('hex'), '41675dfe47ece730ee2934a84918a1b716678954ac69f17735f24e3cef8012c1', 'Use the pinned public speech fixture.');
const out = path.join(runtime, `dictation-insertion-${randomUUID()}`);
await fs.mkdir(out, { recursive: true });
const report = { passed: false, fixtureApp: fixtureName, initialText, audio, calls: [], limitations: ['Prerecorded public speech; microphone capture is tested separately.', 'Insertion is limited to the known disposable fixture; no automatic retries or focus changes.'] };
async function rpc(method, params = {}) {
  const started = performance.now();
  try {
    const value = await requestJSON(endpoint, bridge.token, method, params, 120_000);
    report.calls.push({ method, milliseconds: Math.round(performance.now() - started), ok: true });
    return value;
  } catch {
    report.calls.push({ method, ok: false });
    throw new Error(`${method} failed; no automatic retry was attempted.`);
  }
}
async function fixtureState() {
  const value = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert(Number.isFinite(value.time) && Math.abs(Date.now() / 1000 - value.time) < 2, 'Fixture state is stale; aborting.');
  return value;
}
function requireKnownFocusedState(value) {
  assert(value.active === true && Number.isInteger(value.selfPID) && value.frontPID === value.selfPID, 'The disposable fixture lost focus; aborting without typing.');
  assert(value.text === initialText && value.location === initialText.length && value.length === 0, 'Fixture text or selection changed; aborting without typing.');
}
try {
  const host = await rpc('runtime.status');
  assert(path.resolve(host.dataDirectory) === path.dirname(bridgeFile), 'The host does not use the isolated profile.');
  requireKnownFocusedState(await fixtureState());
  const target = await rpc('_test.dictation.capture');
  // Never send text to a target unless the native adapter identifies this exact disposable app.
  assert(target.app === fixtureName && target.canInsert === true && typeof target.targetId === 'string' && /^[0-9a-f-]{36}$/i.test(target.targetId), 'Capture did not identify the disposable fixture; aborting without typing.');
  const transcript = await rpc('audio.transcribe', { path: audio, purpose: 'dictation', language: 'en' });
  assert(transcript.model === 'moonshine-tiny-en' && typeof transcript.text === 'string' && normalize(transcript.text) === normalize(reference), 'The pinned speech fixture did not decode as expected; aborting without typing.');
  const insertedText = transcript.text;
  const expected = initialText + insertedText;
  requireKnownFocusedState(await fixtureState());
  // Native insertion rechecks the same app, field, cursor and unchanged text immediately before writing.
  const result = await rpc('_test.dictation.insert', { targetId: target.targetId, text: insertedText });
  assert(result.inserted === true, 'Native insertion was not confirmed; do not retry automatically.');
  let confirmed = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const current = await fixtureState();
    if (current.text === expected) { confirmed = true; break; }
    assert(current.text === initialText, 'Fixture text differs from the expected result; do not retry.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(confirmed, 'The disposable text view did not report the inserted result; do not retry.');
  report.model = transcript.model;
  report.insertedText = insertedText;
  report.finalText = expected;
  report.passed = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Report: ${path.join(out, 'results.json')}`);
}
