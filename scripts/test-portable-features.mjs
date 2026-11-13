// Run against a disposable debug host: PACE_E2E_BRIDGE_FILE=... node scripts/test-portable-features.mjs
// Uses recorded synthetic WAVs only; opens no devices, windows, or permission prompts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { englishFixtureNoteChecks, readPCM16Wav, requestJSON } from './soak.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(root, 'artifacts/runtime');
const bridgeFile = path.resolve(process.env.PACE_E2E_BRIDGE_FILE || path.join(runtimeRoot, 'e2e-app/e2e-bridge.json'));
assert(bridgeFile.startsWith(runtimeRoot + path.sep), 'Use an isolated debug data directory under artifacts/runtime.');
const bridge = JSON.parse(await fs.readFile(bridgeFile, 'utf8'));
const endpoint = new URL(bridge.url);
assert(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1', 'The bridge must use loopback HTTP.');
assert(typeof bridge.token === 'string' && bridge.token.length > 0, 'The debug bridge must require a token.');
const out = path.join(runtimeRoot, `portable-features-${randomUUID()}`);
await fs.mkdir(out, { recursive: true });
const report = { passed: false, steps: [], limitations: [
  'Synthetic prerecorded speech; physical microphone/system capture, device permissions, and cross-app insertion are not exercised.',
  'Stopping the optional adapter is checked against portable ASR. Active-capture survival needs a synthetic capture injection hook or an explicitly authorized device test.',
  'Meeting-grounded copilot text is tested; automatic tip display and UI behavior are not exercised.',
] };
const save = () => fs.writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
async function rpc(method, params = {}) {
  const start = performance.now();
  try {
    const value = await requestJSON(endpoint, bridge.token, method, params, 900_000);
    report.steps.push({ method, seconds: +((performance.now() - start) / 1000).toFixed(3), value });
    await save();
    console.log(`${method}: ok`);
    return value;
  } catch (error) {
    report.steps.push({ method, error: String(error) });
    await save();
    throw error;
  }
}
function timedSegments(value, seconds) {
  assert(Array.isArray(value.segments) && value.segments.length > 0, 'Expected actual timed speech segments.');
  assert(value.segments.every(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end > segment.start && segment.end <= seconds + 0.5), 'Speech timestamps must stay inside the WAV.');
}
const fixtureDir = path.join(runtimeRoot, 'meeting-fixture');
const fixture = path.join(fixtureDir, 'meeting.wav');
const fixtureBytes = await fs.readFile(fixture);
const seconds = readPCM16Wav(fixtureBytes).length / 32000;
const truth = JSON.parse(await fs.readFile(path.join(fixtureDir, 'truth.json'), 'utf8'));
const dictationFixture = path.join(fixtureDir, '0.wav');
const dictationSeconds = readPCM16Wav(await fs.readFile(dictationFixture)).length / 32000;
let settings;
try {
  const unauthorized = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ method: 'app.state' }) }).then(response => response.json());
  assert.equal(unauthorized.ok, false, 'Unauthenticated requests must be rejected.');
  const runtime = await rpc('runtime.status');
  assert.equal(path.resolve(runtime.dataDirectory), path.dirname(bridgeFile));
  assert.equal(runtime.offline, true);
  const state = await rpc('app.state');
  assert.equal(state.memory.enabled, false, 'Do not run against enabled ambient memory.');
  assert(!state.meetings.some(meeting => ['recording', 'finalizing'].includes(meeting.status)), 'Use a host with no active recording.');
  for (const id of ['moonshine-tiny-en', 'whisper-turbo', 'nemotron-diarization', 'qwen3.5-4b']) {
    assert(state.models.some(model => model.id === id && model.installed), `Install ${id} before running this test.`);
  }
  settings = state.settings;
  await rpc('settings.update', { patch: { language: 'en', dictationLanguage: 'en', speechEnabled: false, meetingTips: false } });

  const dictation = await rpc('audio.transcribe', { path: dictationFixture, purpose: 'dictation', language: 'en' });
  assert.equal(dictation.model, 'moonshine-tiny-en', 'Dictation must use the actual tiny engine.');
  timedSegments(dictation, dictationSeconds);
  assert.match(dictation.text, /release notes/i);
  assert.match(dictation.text, /Friday/i);

  const transcript = await rpc('audio.transcribe', { path: fixture, purpose: 'meeting', language: 'en' });
  assert.equal(transcript.model, 'whisper-turbo');
  timedSegments(transcript, seconds);
  for (const word of [/Monday/i, /Friday/i, /tutorial/i, /sounds/i]) assert.match(transcript.text, word);
  assert(transcript.segments.at(-1).end >= seconds - 3, 'Whisper must reach the final fixture turn.');
  const diarization = await rpc('audio.diarize', { path: fixture });
  assert.equal(diarization.model, 'nemotron-diarization');
  assert.equal(diarization.speakerCount, 2, 'The two-voice fixture must retain two anonymous speakers.');
  timedSegments(diarization, seconds);
  const dominant = truth.map(turn => {
    const overlaps = new Map();
    for (const segment of diarization.segments) {
      const overlap = Math.max(0, Math.min(turn.end, segment.end) - Math.max(turn.start, segment.start));
      overlaps.set(segment.speaker, (overlaps.get(segment.speaker) || 0) + overlap);
    }
    const [speaker, covered] = [...overlaps].sort((a, b) => b[1] - a[1])[0];
    assert(covered >= (turn.end - turn.start) / 2, 'Each labelled turn needs substantial speaker coverage.');
    return speaker;
  });
  assert.equal(dominant[0], dominant[2]);
  assert.equal(dominant[1], dominant[3]);
  assert.notEqual(dominant[0], dominant[1], 'Speaker identity must follow voices across turns.');

  const id = randomUUID();
  report.meetingId = id;
  const directory = path.join(path.dirname(bridgeFile), 'recordings', id);
  await fs.mkdir(directory, { recursive: true });
  const recording = path.join(directory, 'system.wav');
  await fs.copyFile(fixture, recording);
  await rpc('_test.meeting.seed', { id, title: 'Portable synthetic two-speaker test', startedAt: new Date().toISOString(), status: 'interrupted', segments: [], capture: { directory } });
  const meeting = await rpc('meeting.retry', { id });
  assert.equal(meeting.status, 'completed');
  timedSegments(meeting, seconds);
  assert.equal(new Set(meeting.segments.map(segment => segment.speaker)).size, 2);
  for (const [name, passed] of Object.entries(englishFixtureNoteChecks(meeting))) assert(passed, `Notes: ${name}`);
  const answer = await rpc('chat.send', { conversationId: `portable-meeting-${id}`, meetingId: id, text: 'When did we decide to launch, and who will test the installer? Answer only from this meeting.', quiet: true });
  assert.match(answer.text, /Monday/i);
  assert.match(answer.text, /Daniel/i);
  await assert.rejects(fs.access(recording), /ENOENT/);
  assert.deepEqual(await fs.readFile(fixture), fixtureBytes, 'Recovery cleanup must preserve the source fixture.');

  await rpc('_test.worker.crash');
  const afterAdapterStop = await rpc('audio.transcribe', { path: dictationFixture, purpose: 'dictation', language: 'en' });
  assert.equal(afterAdapterStop.model, 'moonshine-tiny-en');
  assert.equal(afterAdapterStop.cold, false, 'Stopping the optional manager must preserve the warm portable speech runtime.');
  assert.match(afterAdapterStop.text, /release notes/i);
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  try {
    if (settings) await rpc('settings.update', { patch: Object.fromEntries(['language', 'dictationLanguage', 'speechEnabled', 'meetingTips'].filter(key => key in settings).map(key => [key, settings[key]])) });
  } catch (error) {
    report.passed = false;
    report.error = `Restoring isolated settings: ${error}`;
    throw error;
  } finally { await save(); }

  console.log(`Portable feature report: ${path.join(out, 'results.json')}`);
}
