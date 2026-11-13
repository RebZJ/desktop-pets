import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { englishFixtureNoteChecks } from './soak.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeFile = path.resolve(process.env.PACE_E2E_BRIDGE_FILE || path.join(root, 'artifacts/runtime/e2e-app/e2e-bridge.json'));
assert(bridgeFile.startsWith(path.join(root, 'artifacts/runtime/')), 'Integration checks must use an isolated test data directory.');
let bridge;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    bridge = JSON.parse(await fs.readFile(bridgeFile, 'utf8'));
    const ready = await fetch(bridge.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: '_test.windows' }), signal: AbortSignal.timeout(2000) }).then(response => response.json());
    if (ready.ok) break;
  } catch { /* The packaged host may still be starting. */ }
  bridge = undefined;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert(bridge, 'Start the isolated debug desktop host before integration checks.');
assert.equal(new URL(bridge.url).hostname, '127.0.0.1');
const out = path.join(root, 'artifacts/runtime/desktop-integration');
await fs.mkdir(out, { recursive: true });
const results = [];
function checkFixtureActions(meeting) {
  for (const [check, passed] of Object.entries(englishFixtureNoteChecks(meeting))) assert(passed, check);
}
const request = async (method, params = {}, expectedError) => {
  const started = performance.now();
  const response = await fetch(bridge.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(900_000) });
  const reply = await response.json();
  const entry = { method, seconds: +((performance.now() - started) / 1000).toFixed(3), reply };
  results.push(entry);
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`${method}: ${entry.seconds}s ${reply.ok ? 'ok' : expectedError ? 'expected rejection' : 'FAILED'}`);
  if (expectedError) { assert.equal(reply.ok, false); assert.match(String(reply.error), expectedError); }
  else assert.equal(reply.ok, true, reply.error);
  return reply.data;
};

const state = await request('app.state');
for (const id of ['qwen3.5-4b', 'whisper-turbo', 'nemotron-diarization', 'kitten-tts-micro-0.8', 'moonshine-tiny-en']) assert(state.models.some(model => model.id === id && model.installed), `Install ${id} before this test.`);
const runtime = await request('runtime.status');
assert.equal(path.resolve(runtime.dataDirectory), path.dirname(bridgeFile));
assert.equal(runtime.offline, true);
assert.equal(state.memory.enabled, false, 'Do not run this test against enabled ambient memory.');
await request('pet.toggle',{visible:false});await new Promise(resolve=>setTimeout(resolve,250));
assert((await request('_test.windows')).every(window=>!window.visible));
await request('pet.toggle',{visible:true});await new Promise(resolve=>setTimeout(resolve,100));
assert.equal((await request('_test.windows')).find(window=>window.label==='pet').visible,true);
await request('window.main');
const downloadStart = Date.now();
await request('_test.download');
let downloaded = false;
for (let attempt = 0; attempt < 30 && !downloaded; attempt++) {
  const downloads = path.join(os.homedir(), 'Downloads');
  for (const name of await fs.readdir(downloads)) {
    if (!name.startsWith('pace-native-download-fixture')) continue;
    const file = path.join(downloads, name);
    if ((await fs.stat(file)).mtimeMs < downloadStart - 1000) continue;
    if (await fs.readFile(file, 'utf8') !== 'Pace native download fixture\n') continue;
    await fs.unlink(file);
    downloaded = true;
  }
  if (!downloaded) await new Promise(resolve => setTimeout(resolve, 1000));
}
assert(downloaded, 'The actual WebView must save a Blob export through WKDownload.');

const unauthorized = await fetch(bridge.url, { method: 'POST', body: JSON.stringify({ method: 'app.state' }) }).then(r => r.json());
assert.equal(unauthorized.ok, false);

for (const [language, text, expected] of [
  ['en', 'Introduce yourself as Pace in one short English sentence.', /Pace/i],
  ['zh', '请用一句简体中文介绍你自己，名字叫佩斯。', /[\u3400-\u9fff]/],
  ['ja', '日本語で一文だけ自己紹介してください。名前はペースです。', /[\u3040-\u30ff]/],
  ['es', 'Preséntate como Pace en una sola frase en español.', /Pace/i],
]) {
  await request('settings.update', { patch: { language, speechEnabled: false } });
  const answer = await request('chat.send', { conversationId: `integration-${language}-${randomUUID()}`, text, quiet: true });
  assert.match(answer.text, expected);
}
await request('settings.update', { patch: { language: 'en' } });
const revision = await request('writing.generate', { mode: 'rewrite', text: 'The review are on 12 April. Amina will send the notes.', instruction: 'Fix grammar. Keep the review singular, the date 12 April, and the name Amina. Return only the corrected text.' });
assert.match(revision.text, /12 April/); assert.match(revision.text, /Amina/); assert.match(revision.text, /review is/i);

for (const text of ['The synthetic launch review is Friday.', '明天的会议需要准备笔记。', '明日の会議で確認しましょう。', 'La reunión sintética es el viernes.']) await request('_test.memory.add', { app: 'test.synthetic', title: 'Synthetic integration fixture', text });
for (const query of ['launch review', '会议需要', '会議', 'reunión']) assert((await request('memory.search', { query })).length > 0, query);
const recalled = await request('chat.send', { conversationId: `integration-recall-${randomUUID()}`, text: 'When is the synthetic launch review? Cite the saved memory.', quiet: true });
assert.match(recalled.text, /Friday/i); assert.match(recalled.text, /\[memory:\d+\]/);
const memoryId = recalled.text.match(/\[memory:(\d+)\]/)[1];
assert.match((await request('memory.get', { id: memoryId })).text, /Friday/);
await request('memory.delete', { app: 'test.synthetic' });
assert.equal((await request('memory.search', { query: 'synthetic launch review' })).length, 0);

const extension = await request('extensions.add', { name: 'Synthetic local arithmetic', command: process.execPath, args: [path.join(root, 'tests/fixtures/mcp-server.mjs')] });
assert.equal((await request('extensions.inspect', { id: extension.id })).tools[0].name, 'add');
await request('extensions.call', { id: extension.id, tool: 'add', arguments: { a: 17, b: 25 }, confirmed: true }, /Enable/);
await request('extensions.update', { id: extension.id, enabledTools: ['add'], enabled: true });
await request('extensions.call', { id: extension.id, tool: 'add', arguments: { a: 17, b: 25 } }, /confirm/i);
const sum = await request('extensions.call', { id: extension.id, tool: 'add', arguments: { a: 17, b: 25 }, confirmed: true });
assert.equal(sum.content[0].text, '42');
await request('extensions.remove', { id: extension.id });

const packId = `fixture-${randomUUID().slice(0, 8)}`;
const packDir = path.join(out, packId);
await fs.mkdir(packDir, { recursive: true });
await fs.copyFile(path.join(root, 'public/pets/pace/idle.webp'), path.join(packDir, 'idle.webp'));
await fs.copyFile(path.join(root, 'public/pets/pace/sounds/happy-chirp.wav'), path.join(packDir, 'chirp.wav'));
await fs.writeFile(path.join(packDir, 'manifest.json'), JSON.stringify({ version: 1, id: packId, name: 'Synthetic test pet', license: 'CC-BY-4.0', attribution: 'Outpaced / Desktop Pets, synthetic test remix', sounds: { happy: 'chirp.wav' }, actions: [{ id: 'idle', src: 'idle.webp', frameWidth: 256, frameHeight: 256, frameCount: 24, fps: 12 }] }));
const zip = path.join(out, `${packId}.zip`);
await run('/usr/bin/zip', ['-q', zip, 'manifest.json', 'idle.webp', 'chirp.wav'], { cwd: packDir });
const imported = await request('packs.import', { path: zip }); assert.equal(imported.id, packId);
await request('settings.update', { patch: { activePack: packId } });
assert.equal((await request('app.state')).settings.activePack, packId);
await request('packs.remove', { id: packId });
assert.equal((await request('app.state')).settings.activePack, 'pace');

const fixture = path.join(root, 'artifacts/runtime/meeting-fixture/meeting.wav');
await fs.access(fixture);
const meetingId = randomUUID();
const recordingDir = path.join(path.dirname(bridgeFile), 'recordings', meetingId);
await fs.mkdir(recordingDir, { recursive: true });
const recording = path.join(recordingDir, 'system.wav'); await fs.copyFile(fixture, recording);
await request('_test.meeting.seed', { id: meetingId, title: 'Synthetic two-speaker integration meeting', startedAt: new Date().toISOString(), status: 'recording', segments: [], capture: { directory: recordingDir } });
await request('voice.speak', { text: 'This must remain silent.', play: false }, /stays quiet/);
await request('_test.worker.crash');
let interrupted;
for(let attempt=0;attempt<20;attempt++) {interrupted=(await request('meeting.list')).find(m=>m.id===meetingId);if(interrupted.status==='interrupted')break;await new Promise(resolve=>setTimeout(resolve,100));}
assert.equal(interrupted.status,'interrupted','A worker failure must leave a recoverable meeting.');
const meeting = await request('meeting.retry', { id: meetingId });
assert.equal(meeting.status, 'completed');
assert(meeting.segments.length > 1); assert(meeting.segments.every(s => s.end > s.start));
assert(new Set(meeting.segments.map(s => s.speaker)).size >= 2, 'The real fixture must keep two speaker labels.');
assert.match(meeting.notes, /Monday/i); assert.match(meeting.notes, /Friday/i); assert(meeting.actionItems.length > 0);
checkFixtureActions(meeting);
for (let attempt = 0; attempt < 2; attempt++) checkFixtureActions(await request('meeting.summarize', { id: meetingId }));
assert.match((await request('meeting.export', { id: meetingId })).content, /Speaker [12]/);
await assert.rejects(fs.access(recording), /ENOENT/);
const answer = await request('chat.send', { conversationId: `meeting-${meetingId}`, meetingId, text: 'When did we decide to launch?', quiet: true });
assert.match(answer.text, /Monday/i);
const voice = await request('voice.speak', { text: 'Hello, I am Pace.', language: 'auto', voice: 'Kiki', voiceEngine: 'kitten', play: false });
assert((await fs.stat(voice.path)).size > 10000);
await request('voice.stop');
assert.equal((await request('runtime.status')).voiceLoaded, false);
await request('settings.update', { patch: { language: 'auto', speechEnabled: false } });
await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify({ passed: true, steps: results.length, meetingId, limitations: ['Synthetic audio, not microphone/system capture.', 'Cross-app Accessibility and physical shortcuts need an unlocked Mac.'] }, null, 2));
console.log(`Actual desktop integration passed: ${results.length} operations.`);
