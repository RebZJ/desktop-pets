import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const CHUNK_SECONDS = 15;
const elapsedSeconds = since => +((performance.now() - since) / 1000).toFixed(3);

export function readPCM16Wav(buffer) {
  assert(buffer.length >= 44 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE', 'Fixture must be a WAV file.');
  let format;
  let pcm;
  for (let at = 12; at + 8 <= buffer.length;) {
    const name = buffer.toString('ascii', at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    const end = at + 8 + size;
    assert(end <= buffer.length, 'Truncated WAV chunk.');
    if (name === 'fmt ') {
      assert(size >= 16, 'Invalid WAV format.');
      format = [buffer.readUInt16LE(at + 8), buffer.readUInt16LE(at + 10), buffer.readUInt32LE(at + 12), buffer.readUInt16LE(at + 22)];
    }
    if (name === 'data') pcm = buffer.subarray(at + 8, end);
    at = end + (size % 2);
  }
  assert.deepEqual(format, [1, 1, SAMPLE_RATE, 16], 'Fixture must be PCM16 mono 16 kHz.');
  assert(pcm?.length > 0 && pcm.length % 2 === 0, 'Fixture contains no complete samples.');
  return pcm;
}

export function wavHeader(byteLength) {
  assert(Number.isInteger(byteLength) && byteLength >= 0 && byteLength % 2 === 0 && byteLength <= 0xffff_ffff - 36, 'Invalid WAV length.');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + byteLength, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(byteLength, 40);
  return header;
}

async function writeRepeatedWav(filename, pcm, seconds) {
  const byteLength = seconds * BYTES_PER_SECOND;
  const file = await fs.open(filename, 'w');
  try {
    await file.write(wavHeader(byteLength));
    for (let written = 0; written < byteLength;) {
      const chunk = pcm.subarray(0, Math.min(pcm.length, byteLength - written));
      const result = await file.write(chunk);
      assert.equal(result.bytesWritten, chunk.length, 'Could not write the fixture.');
      written += chunk.length;
    }
  } finally { await file.close(); }
}

async function writeChunk(source, filename, startSeconds, seconds) {
  const pcm = Buffer.alloc(seconds * BYTES_PER_SECOND);
  const { bytesRead } = await source.read(pcm, 0, pcm.length, 44 + startSeconds * BYTES_PER_SECOND);
  assert.equal(bytesRead, pcm.length, 'Could not read a full audio chunk.');
  await fs.writeFile(filename, Buffer.concat([wavHeader(pcm.length), pcm]));
}

function processRows(stdout) {
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
    return match ? [{ pid: +match[1], ppid: +match[2], rssKiB: +match[3], cpuPercent: +match[4], elapsed: match[5], name: path.basename(match[6]) }] : [];
  });
}

export async function main() {
  const durationSeconds = Number(process.env.PACE_SOAK_SECONDS ?? 3600);
  assert(Number.isSafeInteger(durationSeconds) && durationSeconds >= CHUNK_SECONDS, 'PACE_SOAK_SECONDS must be a whole number of at least 15 seconds.');
  wavHeader(durationSeconds * BYTES_PER_SECOND);
  const bridgeFile = path.resolve(process.env.PACE_E2E_BRIDGE_FILE ?? path.join(ROOT, 'artifacts/runtime/e2e-app/e2e-bridge.json'));
  const bridge = JSON.parse(await fs.readFile(bridgeFile, 'utf8'));
  const endpoint = new URL(bridge.url);
  assert(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'The test bridge must use loopback HTTP.');
  assert(typeof bridge.token === 'string' && bridge.token.length > 0, 'The test bridge has no token.');
  const appDataDirectory = path.dirname(bridgeFile);
  const outputDirectory = path.join(ROOT, 'artifacts/runtime/soak');
  await fs.mkdir(outputDirectory, { recursive: true });
  const eventsFile = path.join(outputDirectory, 'events.jsonl');
  const resultsFile = path.join(outputDirectory, 'results.json');
  const eventLog = await fs.open(eventsFile, 'w');
  const started = performance.now();
  const result = {
    status: 'preparing', startedAt: new Date().toISOString(), requestedDurationSeconds: durationSeconds,
    eligibleFor60MinuteEvidence: false, fixture: null, meetingId: randomUUID(),
    context: { platform: os.platform(), osRelease: os.release(), architecture: os.arch(), totalMemoryBytes: os.totalmem(), bridgeFile, appDataDirectory, concurrentProcessesAreObserved: true, operatorNote: process.env.PACE_SOAK_CONTEXT ?? null },
    chunks: [], resourceSamples: [], errors: [], finalization: null,
    limitations: ['Synthetic repeated fixture, not live microphone or meeting-app audio.', 'Process RSS and system swap are observations; RSS alone does not measure all Metal/unified-memory allocations.', 'This run does not test a real screen-sharing app or consent UX.'],
  };
  let interval;
  let sampling;
  let stopRequested = false;
  let saving = Promise.resolve();
  const pending = new Set();
  const tasks = [];
  const event = async (name, data = {}) => {
    await eventLog.write(JSON.stringify({ event: name, at: new Date().toISOString(), wallSeconds: elapsedSeconds(started), ...data }) + '\n');
  };
  const save = () => {
    result.wallClockSeconds = elapsedSeconds(started);
    const snapshot = JSON.stringify(result, null, 2);
    saving = saving.catch(() => {}).then(async () => {
      await fs.writeFile(resultsFile + '.tmp', snapshot);
      await fs.rename(resultsFile + '.tmp', resultsFile);
    });
    return saving;
  };
  const api = async (method, params = {}, timeoutMs = 300_000) => {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(timeoutMs),
    });
    assert(response.ok, `${method}: HTTP ${response.status}`);
    const body = await response.json();
    if (!body.ok) throw new Error(`${method}: ${body.error ?? 'Unknown host error'}`);
    return body.data;
  };
  const sample = async () => {
    if (sampling) return sampling;
    sampling = (async () => {
      const sample = { at: new Date().toISOString(), wallSeconds: elapsedSeconds(started), freeMemoryBytes: os.freemem(), loadAverage: os.loadavg(), pendingChunks: pending.size };
      try {
        const [ps, swap] = await Promise.all([
          run('/bin/ps', ['-axo', 'pid=,ppid=,rss=,pcpu=,etime=,comm=']),
          run('/usr/sbin/sysctl', ['-n', 'vm.swapusage']),
        ]);
        const rows = processRows(ps.stdout);
        sample.appProcesses = rows.filter(row => /^(PaceNative|desktop-pets|desktop_pets|DesktopPets|Pace|Desktop Pets|nemo-speech|whisper-cli|whisper-vad-speech-segments)$/.test(row.name));
        sample.largestProcesses = [...rows].sort((a, b) => b.rssKiB - a.rssKiB).slice(0, 8);
        sample.swap = swap.stdout.trim();
      } catch (error) { sample.resourceError = error.message; }
      try {
        const [runtime, meetings] = await Promise.all([api('runtime.status', {}, 30_000), api('meeting.list', {}, 30_000)]);
        sample.runtime = runtime;
        const meeting = meetings.find(item => item.id === result.meetingId);
        if (meeting) sample.meeting = { status: meeting.status, segmentCount: meeting.segments?.length ?? 0, lastSegmentEnd: meeting.segments?.at(-1)?.end, error: meeting.error ?? null };
      } catch (error) { sample.hostError = error.message; result.errors.push({ phase: 'monitor', message: error.message }); }
      result.resourceSamples.push(sample);
      await event('resources', sample);
      await save();
      console.log(JSON.stringify({ event: 'soak.progress', wallSeconds: sample.wallSeconds, processedChunks: result.chunks.filter(chunk => chunk.ok).length, pendingChunks: pending.size, appProcesses: sample.appProcesses, swap: sample.swap, hostError: sample.hostError }));
    })().finally(() => { sampling = null; });
    return sampling;
  };
  const stop = () => { stopRequested = true; void event('stop.requested'); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let recording;
  let source;
  try {
    const state = await api('app.state');
    result.context.settingsAtStart = state.settings;
    assert(state.settings.meetingTips === true, 'Enable meeting tips before the soak; the script leaves shared app settings unchanged.');
    assert(!state.meetings.some(meeting => meeting.status === 'recording' || meeting.status === 'finalizing'), 'Finish the other recording/finalization before the soak.');
    const runtime = await api('runtime.status');
    assert.equal(path.resolve(runtime.dataDirectory), appDataDirectory, 'The bridge metadata and native worker use different app-data directories.');
    assert((await api('models.status')).every(model => model.installed), 'Install the real model pack before starting the soak.');
    await api('voice.stop');
    const fixtureDirectory = path.join(ROOT, 'artifacts/runtime/meeting-fixture');
    const fixturePath = path.join(fixtureDirectory, 'meeting.wav');
    try { await fs.access(fixturePath); }
    catch { await run('python3', [path.join(ROOT, 'scripts/create-meeting-fixture.py'), '--output', fixtureDirectory]); }
    const pcm = readPCM16Wav(await fs.readFile(fixturePath));
    const truth = JSON.parse(await fs.readFile(path.join(fixtureDirectory, 'truth.json'), 'utf8'));
    const fixtureSeconds = pcm.length / BYTES_PER_SECOND;
    result.fixture = { path: fixturePath, durationSeconds: fixtureSeconds, labelledTurns: truth.length, repeatedToSeconds: durationSeconds };
    const repeatedTruth = [];
    for (let base = 0; base < durationSeconds; base += fixtureSeconds) {
      for (const turn of truth) if (base + turn.start < durationSeconds) repeatedTruth.push({ ...turn, start: base + turn.start, end: Math.min(durationSeconds, base + turn.end) });
    }
    await fs.writeFile(path.join(outputDirectory, 'truth.json'), JSON.stringify(repeatedTruth, null, 2));
    const directory = path.join(appDataDirectory, 'recordings', result.meetingId);
    await fs.mkdir(path.join(directory, 'chunks'), { recursive: true });
    const systemWav = path.join(directory, 'system.wav');
    await writeRepeatedWav(systemWav, pcm, durationSeconds);
    source = await fs.open(systemWav, 'r');
    recording = { id: result.meetingId, title: durationSeconds === 3600 ? 'Synthetic 60-minute workload' : `Synthetic ${durationSeconds}-second harness check`, status: 'recording', startedAt: new Date().toISOString(), segments: [], notes: '', actionItems: [], capture: { sessionId: result.meetingId, directory, tracks: [] } };
    await api('_test.meeting.seed', recording);
    result.status = 'recording';
    const pacedStarted = performance.now();
    result.pacedStartedAt = new Date().toISOString();
    await event('recording.started', { requestedDurationSeconds: durationSeconds, meetingId: result.meetingId });
    await sample();
    interval = setInterval(() => void sample().catch(error => result.errors.push({ phase: 'monitor', message: error.message })), 60_000);
    for (let index = 0, audioStart = 0; audioStart < durationSeconds; index++, audioStart += CHUNK_SECONDS) {
      const seconds = Math.min(CHUNK_SECONDS, durationSeconds - audioStart);
      const deadline = pacedStarted + (audioStart + seconds) * 1000;
      while (!stopRequested && performance.now() < deadline) await sleep(Math.min(1000, deadline - performance.now()));
      if (stopRequested) break;
      const filename = path.join(directory, 'chunks', `${String(index).padStart(4, '0')}.wav`);
      await writeChunk(source, filename, audioStart, seconds);
      const entry = { index, startMs: audioStart * 1000, endMs: (audioStart + seconds) * 1000, path: filename, submittedAt: new Date().toISOString(), submittedWallSeconds: elapsedSeconds(pacedStarted), latenessMs: +Math.max(0, performance.now() - deadline).toFixed(3) };
      result.chunks.push(entry);
      await event('chunk.submitted', entry);
      const submitted = performance.now();
      const task = api('_test.audio.chunk', { sessionId: result.meetingId, track: 'system', path: filename, startMs: entry.startMs, endMs: entry.endMs })
        .then(response => {
          entry.response = response;
          assert.equal(response.processed, true, `Chunk ${index} was not processed: ${response.reason ?? 'no reason returned'}`);
          assert(Number.isInteger(response.segmentsAdded) && response.segmentsAdded >= 0, `Chunk ${index} returned an invalid segment count.`);
          entry.ok = true;
          if (response.tipError) result.errors.push({ phase: 'tip', index, message: response.tipError });
        })
        .catch(error => { entry.ok = false; entry.error = error.message; result.errors.push({ phase: 'chunk', index, message: error.message }); })
        .finally(async () => { entry.processingSeconds = elapsedSeconds(submitted); pending.delete(task); await event('chunk.processed', entry); });
      pending.add(task);
      tasks.push(task);
      result.maximumPendingChunks = Math.max(result.maximumPendingChunks ?? 0, pending.size);
      await save();
    }
    result.recordingWallClockSeconds = elapsedSeconds(pacedStarted);
    result.status = 'draining';
    await source.close(); source = null;
    await Promise.allSettled(tasks);
    const current = (await api('meeting.list')).find(meeting => meeting.id === result.meetingId);
    assert(current, 'The synthetic meeting disappeared from the real host.');
    result.provisional = { segmentCount: current.segments?.length ?? 0, transcriptCharacters: (current.segments ?? []).reduce((sum, segment) => sum + (segment.text?.length ?? 0), 0) };
    const actualAudioSeconds = result.chunks.at(-1)?.endMs / 1000 || 0;
    if (actualAudioSeconds < durationSeconds) {
      await fs.truncate(systemWav, 44 + actualAudioSeconds * BYTES_PER_SECOND);
      const truncated = await fs.open(systemWav, 'r+');
      try { await truncated.write(wavHeader(actualAudioSeconds * BYTES_PER_SECOND), 0, 44, 0); }
      finally { await truncated.close(); }
    }
    current.status = 'interrupted'; current.endedAt = new Date().toISOString();
    current.capture = { ...recording.capture, duration: actualAudioSeconds, tracks: [{ track: 'system', path: systemWav, frames: actualAudioSeconds * SAMPLE_RATE, offsetMs: 0 }] };
    await api('_test.meeting.seed', current);
    if (stopRequested) throw new Error('Soak was stopped before the requested paced duration; the synthetic recording remains recoverable.');
    result.status = 'finalizing';
    if (!result.provisional.segmentCount) result.errors.push({ phase: 'live-transcript', message: 'The live chunk path returned no provisional transcript.' });
    result.tipCounts = {
      attempted: result.chunks.filter(chunk => chunk.response?.tipAttempted === true || chunk.response?.tipGenerated === true || Boolean(chunk.response?.tipError)).length,
      generated: result.chunks.filter(chunk => chunk.response?.tipGenerated === true).length,
      notGenerated: result.chunks.filter(chunk => chunk.response?.tipGenerated === false).length,
      errors: result.errors.filter(error => error.phase === 'tip').length,
    };
    result.tipInstrumentationAvailable = result.chunks.some(chunk => Object.hasOwn(chunk.response ?? {}, 'tipAttempted'));
    if (!result.tipCounts.attempted) result.errors.push({ phase: 'tip-validation', message: 'The paced workload provided no evidence of a real LLM meeting-tip attempt.' });
    await save();
    await event('finalization.started');
    const finalStarted = performance.now();
    const final = await api('meeting.retry', { id: result.meetingId }, 2 * 60 * 60 * 1000);
    result.finalization = { seconds: elapsedSeconds(finalStarted), meeting: final };
    assert.equal(final.status, 'completed', 'The real meeting finalizer did not complete.');
    assert(final.segments?.length > 0 && final.notes?.length > 0, 'The finalizer returned no transcript or notes.');
    result.finalTranscript = {
      segmentCount: final.segments.length,
      characters: final.segments.reduce((sum, segment) => sum + (segment.text?.length ?? 0), 0),
      firstStart: Math.min(...final.segments.map(segment => segment.start)),
      lastEnd: Math.max(...final.segments.map(segment => segment.end)),
      speakerLabels: [...new Set(final.segments.map(segment => segment.speaker))],
      noteCharacters: final.notes.length,
    };
    assert(result.finalTranscript.lastEnd >= actualAudioSeconds - fixtureSeconds - 2, 'The final transcript did not reach the last fixture cycle.');
    result.context.settingsAtEnd = (await api('app.state')).settings;
    result.englishNotePresenceChecks = Object.fromEntries(['Amina', 'Daniel', 'Monday', 'Friday', 'tutorial', 'sounds'].map(text => [text, final.notes.toLowerCase().includes(text.toLowerCase())]));
    result.eligibleFor60MinuteEvidence = durationSeconds >= 3600 && result.recordingWallClockSeconds >= 3600 && result.chunks.length === Math.ceil(durationSeconds / CHUNK_SECONDS) && result.chunks.every(chunk => chunk.ok && chunk.latenessMs < CHUNK_SECONDS * 1000) && result.errors.length === 0 && result.tipCounts.attempted > 0;
    result.status = result.errors.length ? 'completed-with-errors' : 'passed';
    if (result.errors.length) process.exitCode = 1;
    await event('finalization.completed', { seconds: result.finalization.seconds, segmentCount: final.segments.length, noteCharacters: final.notes.length });
  } catch (error) {
    result.status = stopRequested ? 'stopped' : 'failed';
    result.errors.push({ phase: result.finalization ? 'validation' : 'workload', message: error.message, stack: error.stack });
    await event('failed', { message: error.message });
    process.exitCode = 1;
  } finally {
    if (interval) clearInterval(interval);
    await Promise.allSettled(tasks);
    if (sampling) await sampling.catch(() => {});
    if (source) await source.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    result.endedAt = new Date().toISOString();
    const timings = result.chunks.map(chunk => chunk.processingSeconds).filter(Number.isFinite).sort((a, b) => a - b);
    result.chunkLatencySeconds = timings.length ? { median: timings[Math.floor(timings.length / 2)], p95: timings[Math.min(timings.length - 1, Math.ceil(timings.length * 0.95) - 1)], maximum: timings.at(-1) } : null;
    result.maximumSubmissionLatenessMs = Math.max(0, ...result.chunks.map(chunk => chunk.latenessMs));
    result.processRSSKiB = {};
    for (const sample of result.resourceSamples) for (const process of sample.appProcesses ?? []) {
      const stats = result.processRSSKiB[process.name] ??= { first: process.rssKiB, last: process.rssKiB, peak: process.rssKiB, observedPids: [] };
      stats.last = process.rssKiB; stats.peak = Math.max(stats.peak, process.rssKiB);
      if (!stats.observedPids.includes(process.pid)) stats.observedPids.push(process.pid);
    }
    await save();
    await eventLog.close();
    console.log(JSON.stringify({ status: result.status, requestedDurationSeconds: durationSeconds, recordingWallClockSeconds: result.recordingWallClockSeconds, totalWallClockSeconds: result.wallClockSeconds, chunks: result.chunks.length, successfulChunks: result.chunks.filter(chunk => chunk.ok).length, errors: result.errors.length, eligibleFor60MinuteEvidence: result.eligibleFor60MinuteEvidence, resultsFile }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
