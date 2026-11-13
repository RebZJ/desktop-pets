import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

type Options = { status?: 'recording' | 'finalizing'; missingModel?: string; oldInterrupted?: boolean; failStart?: boolean; failStop?: boolean; holdStop?: boolean; holdOpen?: boolean };

async function fixture(page: Page, options: Options = {}) {
  await page.setViewportSize({ width: 300, height: options.status ? 64 : 260 });
  await page.addInitScript((config: Options) => {
    const models = ['qwen3.5-4b', 'whisper-turbo', 'nemotron-diarization'].map(id => ({ id, name: id, role: id, sizeBytes: 100, installed: config.missingModel !== id, status: config.missingModel === id ? 'not-installed' : 'installed' }));
    const meeting = { id: 'meeting-current', title: 'Friday planning', startedAt: new Date().toISOString(), status: config.status || 'recording', segments: [] as any[], notes: '', actionItems: [] };
    const old = { ...meeting, id: 'meeting-old', title: 'Old interrupted meeting', status: 'interrupted', error: 'Saved audio needs attention.' };
    const state = { settings: { onboardingCompleted: true, language: 'en', activePack: 'pace', speechEnabled: false, soundEnabled: false }, models, meetings: [...(config.status ? [meeting] : []), ...(config.oldInterrupted ? [old] : [])], packs: [{ id: 'pace', name: 'Pace' }], extensions: [], memory: { enabled: false, applications: [] }, pet: { visible: true, action: 'idle' } };
    const f: any = { calls: [], state, failStart: Boolean(config.failStart), failStop: Boolean(config.failStop) };
    (window as any).__meetingFixture = f;
    let nextCallback = 0, nextEvent = 0;
    const callbacks: Record<string, (event: any) => void> = {};
    const handlers = new Map<number, string>();
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback(callback: (event: any) => void) { const id = `meeting-callback-${++nextCallback}`; callbacks[id] = callback; return id; },
      unregisterCallback(id: string) { delete callbacks[id]; },
      async invoke(command: string, args: any) {
        if (command === 'plugin:event|listen') { const id = ++nextEvent; handlers.set(id, args.handler); return id; }
        if (command === 'plugin:event|unlisten') { handlers.delete(args.eventId); return; }
        throw new Error(`Unexpected event fixture request ${command}`);
      },
    };
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
    f.emit = (event: string, data: any) => { for (const callback of handlers.values()) callbacks[callback]?.({ event: 'pace-event', id: 1, payload: { event, data } }); };
    f.update = (patch: any) => { Object.assign(meeting, patch); state.meetings = [meeting, ...state.meetings.filter(item => item.id !== meeting.id)]; f.emit('meeting.updated', structuredClone(meeting)); };
    f.words = (text = 'Please send the reviewed draft on Friday.') => f.update({ segments: [{ speaker: 'Speaker 1', start: 0, end: 3, text }] });
    f.level = (rms: number, peak: number, sessionId = meeting.id) => f.emit('meeting.level', { sessionId, level: { rms, peak }, tracks: [{ track: 'microphone', level: { rms, peak } }] });
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string, params: any = {}) => {
      f.calls.push({ method, params });
      if (method === 'app.state') return structuredClone(state);
      if (method === 'meeting.start') {
        if (f.failStart) throw new Error(f.startError || 'Microphone access was denied. Check macOS permissions and retry.');
        f.update({ title: params.title, startedAt: new Date().toISOString(), status: 'recording', segments: [], notes: '', error: undefined });
        return structuredClone(meeting);
      }
      if (method === 'meeting.stop') {
        if (f.failStop) throw new Error('Capture could not stop. Recording is still active; retry Stop.');
        if (config.holdStop) await new Promise<void>(resolve => { f.resolveStop = resolve; });
        f.update({ status: 'finalizing' }); return { stopped: true };
      }
      if (method === 'window.main' && config.holdOpen) await new Promise<void>(resolve => { f.resolveOpen = resolve; });
      if (['window.main', 'window.chat', 'window.close', 'window.meetingLayout'].includes(method)) return {};
      throw new Error(`Unexpected meeting fixture request ${method}`);
    };
  }, options);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?window=meeting');
  await expect(page.getByRole('main', { name: 'Meeting with Pace' })).toBeVisible();
  await expect.poll(() => calls(page, 'app.state')).not.toHaveLength(0);
}

async function calls(page: Page, method: string) {
  return page.evaluate(name => (window as any).__meetingFixture.calls.filter((call: any) => call.method === name), method);
}
async function inside(locator: Locator, width: number, height: number) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const detail = `Bounds ${JSON.stringify(box)} must fit ${width}×${height}`;
  expect(box!.x, detail).toBeGreaterThanOrEqual(0); expect(box!.y, detail).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, detail).toBeLessThanOrEqual(width); expect(box!.y + box!.height, detail).toBeLessThanOrEqual(height);
}
async function start(page: Page) {
  await page.getByRole('textbox', { name: 'Meeting title' }).fill('Friday planning');
  await page.getByRole('button', { name: 'Start meeting', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop meeting', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 300, height: 64 });
}

test('opening setup is passive, fits 300×260, and sends explicit audio sources', async ({ page }) => {
  await fixture(page);
  expect(await calls(page, 'meeting.start')).toHaveLength(0); expect(await calls(page, 'apps.list')).toHaveLength(0);
  expect(await calls(page, 'window.meetingLayout')).toContainEqual({ method: 'window.meetingLayout', params: { layout: 'setup' } });
  await inside(page.getByRole('main'), 300, 260); await inside(page.getByRole('button', { name: 'Start meeting', exact: true }), 300, 260);
  await expect(page.getByRole('combobox')).toHaveCount(0); await expect(page.getByRole('checkbox')).toHaveCount(2);
  await page.getByRole('checkbox', { name: 'Microphone', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'System audio', exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Start meeting', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Meeting title' }).press('Enter');
  expect(await calls(page, 'meeting.start')).toHaveLength(0);
  await page.getByRole('checkbox', { name: 'System audio', exact: true }).check(); await start(page);
  expect(await calls(page, 'meeting.start')).toEqual([{ method: 'meeting.start', params: { title: 'Friday planning', language: 'en', captureMicrophone: false, captureSystem: true } }]);
});

for (const missingModel of ['qwen3.5-4b', 'whisper-turbo', 'nemotron-diarization']) {
  test(`missing ${missingModel} blocks capture and opens model setup only on request`, async ({ page }) => {
    await fixture(page, { missingModel });
    await expect(page.getByRole('button', { name: 'Start meeting', exact: true })).toBeDisabled();
    await page.getByRole('textbox', { name: 'Meeting title' }).press('Enter');
    await page.getByRole('button', { name: 'Install meeting models to start →', exact: true }).click();
    expect(await calls(page, 'window.main')).toEqual([{ method: 'window.main', params: { page: 'models' } }]);
    for (const method of ['meeting.start', 'models.install', 'models.download']) expect(await calls(page, method)).toHaveLength(0);
  });
}

test('failed start keeps the title and sources for an explicit retry', async ({ page }) => {
  await fixture(page, { failStart: true });
  await page.getByRole('textbox', { name: 'Meeting title' }).fill('Keep my title');
  await page.getByRole('checkbox', { name: 'System audio', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Start meeting', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('access was denied');
  await expect(page.getByRole('textbox', { name: 'Meeting title' })).toHaveValue('Keep my title');
  await expect(page.getByRole('checkbox', { name: 'System audio', exact: true })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Start meeting', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Stop meeting', exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__meetingFixture.failStart = false; });
  await page.getByRole('button', { name: 'Start meeting', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop meeting', exact: true })).toBeVisible();
  expect((await calls(page, 'meeting.start')).at(-1).params).toEqual({ title: 'Keep my title', language: 'en', captureMicrophone: true, captureSystem: false });
});

test('system-audio failure offers an explicit microphone-only retry without restarting itself', async ({ page }) => {
  await fixture(page, { failStart: true });
  await page.evaluate(() => { (window as any).__meetingFixture.startError = 'Enable Screen & System Audio Recording in System Settings before capturing meeting audio.'; });
  await page.getByRole('button', { name: 'Start meeting', exact: true }).click();
  await page.getByRole('button', { name: 'Use microphone only', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'System audio', exact: true })).not.toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0); expect(await calls(page, 'meeting.start')).toHaveLength(1);
  await page.evaluate(() => { (window as any).__meetingFixture.failStart = false; });
  await page.getByRole('button', { name: 'Start meeting', exact: true }).click();
  expect((await calls(page, 'meeting.start')).at(-1).params).toEqual({ title: 'Untitled meeting', language: 'en', captureMicrophone: true, captureSystem: false });
});

test('recording stays inside 300×64 with a long title and a reachable Stop', async ({ page }) => {
  await fixture(page, { status: 'recording' });
  await page.evaluate(() => { const f = (window as any).__meetingFixture; f.update({ title: 'An unusually long planning meeting title that must never push Stop out of the widget' }); f.words(); });
  await expect(page.getByRole('status')).toContainText('Recording');
  await expect.poll(() => calls(page, 'window.meetingLayout')).toContainEqual({ method: 'window.meetingLayout', params: { layout: 'compact' } });
  await inside(page.getByRole('main'), 300, 64);
  for (const name of ['Open meeting notes', 'Ask Pace about this meeting', 'Stop meeting', 'Close meeting cloud']) await inside(page.getByRole('button', { name, exact: true }), 300, 64);
  expect(await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))).toEqual({ width: 300, height: 64 });
  await expect(page.getByText('Please send the reviewed draft on Friday.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop meeting', exact: true }).click();
  expect(await calls(page, 'meeting.stop')).toEqual([{ method: 'meeting.stop', params: { id: 'meeting-current' } }]);
});

test('All notes and Open notes dispatch the appropriate meeting context', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'All notes', exact: true }).click(); await start(page);
  await page.getByRole('button', { name: 'Open meeting notes', exact: true }).click();
  expect(await calls(page, 'window.main')).toEqual([{ method: 'window.main', params: { page: 'meetings' } }, { method: 'window.main', params: { page: 'meetings', meetingId: 'meeting-current' } }]);
});

test('Ask about meeting waits for actual words and opens chat with this meeting ID', async ({ page }) => {
  await fixture(page, { status: 'recording' });
  const ask = page.getByRole('button', { name: 'Ask Pace about this meeting', exact: true });
  await expect(ask).toBeDisabled(); await page.evaluate(() => (window as any).__meetingFixture.words('   '));
  await expect(ask).toBeDisabled(); expect(await calls(page, 'window.chat')).toHaveLength(0);
  await page.evaluate(() => (window as any).__meetingFixture.words()); await expect(ask).toBeEnabled(); await ask.click();
  expect(await calls(page, 'window.chat')).toEqual([{ method: 'window.chat', params: { meetingId: 'meeting-current' } }]);
  expect(await calls(page, 'chat.send')).toHaveLength(0);
});

test('the real meter ignores other sessions and warns only after eight seconds of silence', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-14T00:00:00Z') }); await page.clock.pauseAt(new Date('2026-11-14T00:00:01Z'));
  await fixture(page, { status: 'recording' });
  const meter = page.getByRole('meter', { name: 'Meeting audio level' });
  await expect(meter).toHaveAttribute('value', '0');
  await page.evaluate(() => { const f = (window as any).__meetingFixture; f.level(1, 1, 'other-meeting'); f.level(0, 0); });
  await expect(meter).toHaveAttribute('value', '0'); await page.clock.runFor(7000); await expect(page.getByRole('alert')).toHaveCount(0);
  await page.clock.runFor(1000); await expect(page.getByRole('alert')).toContainText('No audio coming in');
  await expect.poll(() => calls(page, 'window.meetingLayout')).toContainEqual({ method: 'window.meetingLayout', params: { layout: 'message' } });
  await page.evaluate(() => (window as any).__meetingFixture.level(0.04, 0.2));
  await expect.poll(() => meter.evaluate(element => (element as HTMLMeterElement).value)).toBeCloseTo(0.6);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => (window as any).__meetingFixture.level(0, 0)); await page.clock.runFor(60_000);
  await expect(meter).toHaveAttribute('value', '0'); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a real peak before eight seconds prevents a later silence warning', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-14T00:00:00Z') }); await page.clock.pauseAt(new Date('2026-11-14T00:00:01Z'));
  await fixture(page, { status: 'recording' }); await page.evaluate(() => (window as any).__meetingFixture.level(0.001, 0.01));
  await expect.poll(() => page.getByRole('meter').evaluate(element => (element as HTMLMeterElement).value)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).__meetingFixture.level(0, 0)); await page.clock.runFor(20_000);
  await expect(page.getByRole('status')).toContainText('00:20'); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('failed Stop keeps recording and can be retried', async ({ page }) => {
  await fixture(page, { status: 'recording', failStop: true }); await page.getByRole('button', { name: 'Stop meeting', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Recording is still active'); await expect(page.getByRole('status')).toContainText('Recording');
  await expect(page.getByRole('button', { name: 'Stop meeting', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).__meetingFixture.failStop = false; }); await page.getByRole('button', { name: 'Stop meeting', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Preparing notes…'); expect(await calls(page, 'meeting.stop')).toHaveLength(2);
});

test('Close and native Quick Hide visibility changes leave recording untouched', async ({ page }) => {
  await fixture(page, { status: 'recording' }); await expect(page.getByRole('button', { name: 'Quick hide', exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).__meetingFixture.emit('pet.visibility', { visible: false }));
  await page.getByRole('button', { name: 'Close meeting cloud', exact: true }).click();
  expect(await calls(page, 'window.close')).toEqual([{ method: 'window.close', params: { label: 'meeting' } }]);
  expect(await calls(page, 'meeting.stop')).toHaveLength(0); expect(await calls(page, 'meeting.start')).toHaveLength(0);
  await page.evaluate(() => (window as any).__meetingFixture.emit('pet.visibility', { visible: true })); await expect(page.getByRole('status')).toContainText('Recording');
});

test('a pending Stop is single-flight while Close and Open notes still respond', async ({ page }) => {
  await fixture(page, { status: 'recording', holdStop: true });
  const stop = page.getByRole('button', { name: 'Stop meeting', exact: true }); await stop.click(); await expect(stop).toBeDisabled();
  await page.getByRole('button', { name: 'Close meeting cloud', exact: true }).click(); await page.getByRole('button', { name: 'Open meeting notes', exact: true }).click();
  expect.soft(await calls(page, 'window.close')).toEqual([{ method: 'window.close', params: { label: 'meeting' } }]);
  expect.soft(await calls(page, 'window.main')).toEqual([{ method: 'window.main', params: { page: 'meetings', meetingId: 'meeting-current' } }]);
  expect(await calls(page, 'meeting.stop')).toHaveLength(1); await page.evaluate(() => (window as any).__meetingFixture.resolveStop());
  await expect(page.getByRole('status')).toHaveText('Preparing notes…');
});

test('opening notes cannot block Stop while a window request is pending', async ({ page }) => {
  await fixture(page, { status: 'recording', holdOpen: true }); await page.getByRole('button', { name: 'Open meeting notes', exact: true }).click();
  await page.getByRole('button', { name: 'Stop meeting', exact: true }).click();
  expect(await calls(page, 'meeting.stop')).toEqual([{ method: 'meeting.stop', params: { id: 'meeting-current' } }]);
  await expect(page.getByRole('status')).toHaveText('Preparing notes…'); await page.evaluate(() => (window as any).__meetingFixture.resolveOpen());
});

test('finalizing remains compact and responsive, then offers a new meeting', async ({ page }) => {
  await fixture(page, { status: 'finalizing' }); await expect(page.getByRole('status')).toHaveText('Preparing notes…');
  await expect(page.getByRole('button', { name: 'Stop meeting', exact: true })).toHaveCount(0); await inside(page.getByRole('main'), 300, 64);
  await page.getByRole('button', { name: 'Open meeting notes', exact: true }).click(); await page.getByRole('button', { name: 'Close meeting cloud', exact: true }).click();
  expect(await calls(page, 'window.main')).toEqual([{ method: 'window.main', params: { page: 'meetings', meetingId: 'meeting-current' } }]); expect(await calls(page, 'window.close')).toHaveLength(1);
  await page.evaluate(() => (window as any).__meetingFixture.update({ status: 'completed', notes: 'The reviewed notes belong in the workspace.' }));
  await expect(page.getByRole('status')).toHaveText('Notes ready'); await expect(page.getByText('The reviewed notes belong in the workspace.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'New meeting', exact: true }).click(); await page.setViewportSize({ width: 300, height: 260 });
  await expect(page.getByRole('button', { name: 'Start meeting', exact: true })).toBeVisible();
  expect(await calls(page, 'meeting.start')).toHaveLength(0); expect(await calls(page, 'meeting.summarize')).toHaveLength(0);
});

test('old interrupted records never hijack new setup or a current recording', async ({ page }) => {
  await fixture(page, { oldInterrupted: true }); await expect(page.getByRole('heading', { name: 'Take meeting notes' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0); expect(await calls(page, 'meeting.retry')).toHaveLength(0); await start(page);
  await page.evaluate(() => { const f = (window as any).__meetingFixture; f.emit('meeting.updated', { ...f.state.meetings.find((meeting: any) => meeting.id === 'meeting-old'), error: 'An old recovery failed.' }); });
  await expect(page.getByRole('status')).toContainText('Recording'); await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open meeting notes', exact: true }).click(); expect((await calls(page, 'window.main')).at(-1).params.meetingId).toBe('meeting-current');
});

test('an interrupted current recording opens its saved record without an automatic retry', async ({ page }) => {
  await fixture(page, { status: 'recording' });
  await page.evaluate(() => (window as any).__meetingFixture.update({ status: 'interrupted', error: 'No speech was detected. Saved audio is preserved.' }));
  await expect(page.getByRole('status')).toHaveText('Needs attention'); await expect(page.getByRole('alert')).toContainText('Saved audio is preserved');
  await page.setViewportSize({ width: 300, height: 148 }); await page.getByRole('button', { name: 'Open saved recording →', exact: true }).click();
  expect(await calls(page, 'window.main')).toEqual([{ method: 'window.main', params: { page: 'meetings', meetingId: 'meeting-current' } }]); expect(await calls(page, 'meeting.retry')).toHaveLength(0);
});

test('capture the three compact meeting layouts for visual review', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-14T00:00:00Z') }); await page.clock.pauseAt(new Date('2026-11-14T00:00:01Z'));
  const directory = path.resolve('.impeccable/review/companion'); await mkdir(directory, { recursive: true });
  const capture = (name: string) => page.screenshot({ path: path.join(directory, name), omitBackground: true, animations: 'disabled' });
  await fixture(page); await capture('meeting-setup-300x260.png'); await start(page);
  await page.evaluate(() => (window as any).__meetingFixture.level(0.04, 0.2));
  await expect.poll(() => page.getByRole('meter').evaluate(element => (element as HTMLMeterElement).value)).toBeCloseTo(0.6);
  await capture('meeting-recording-300x64.png');
  await page.evaluate(() => (window as any).__meetingFixture.update({ id: 'meeting-quiet', title: 'Quiet meeting', startedAt: new Date().toISOString() }));
  await expect(page.getByRole('meter')).toHaveAttribute('value', '0');
  await page.evaluate(() => (window as any).__meetingFixture.level(0, 0)); await page.clock.runFor(8000);
  await expect(page.getByRole('alert')).toContainText('No audio coming in'); await page.setViewportSize({ width: 300, height: 148 });
  await inside(page.getByRole('button', { name: 'Stop meeting', exact: true }), 300, 148);
  await capture('meeting-silence-300x148.png');
});
