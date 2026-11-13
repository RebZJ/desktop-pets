import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

type Options = { installed?: boolean; status?: string; cover?: boolean; failStart?: boolean; failStop?: boolean; failSave?: boolean; holdStop?: boolean; savedTip?: string; holdTip?: boolean; holdAsk?: boolean; askError?: boolean };
async function fixture(page: Page, options: Options = {}) {
  await page.addInitScript((config: Options) => {
    const models = ['qwen3.5-4b', 'whisper-turbo', 'nemotron-diarization'].map(id => ({ id, name: id, role: id, sizeBytes: 100, installed: config.installed !== false, status: config.installed === false ? 'not-installed' : 'installed' }));
    const meeting = { id: 'meeting-current', title: 'Friday planning', startedAt: '2026-11-13T00:00:00Z', status: config.status || 'recording', segments: [] as any[], notes: '', actionItems: [] };
    if (config.status) meeting.segments = [{ speaker: 'Speaker 1', start: 0, end: 3, text: 'Please send the reviewed draft on Friday.' }];
    const state = { settings: { onboardingCompleted: true, language: 'en', meetingTips: true, captureProtectionEnabled: config.cover !== false, hideShortcut: 'Ctrl+Shift+H', activePack: 'pace', speechEnabled: false, soundEnabled: false }, models, meetings: config.status ? [meeting] : [], packs: [{ id: 'pace', name: 'Pace' }], extensions: [], memory: { enabled: false, applications: [] }, pet: { visible: true, action: 'idle' } };
    const f: any = { calls: [], state, failStart: Boolean(config.failStart), failStop: Boolean(config.failStop), failSave: Boolean(config.failSave), askError: Boolean(config.askError) };
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
    f.update = (patch: any) => { Object.assign(meeting, patch); if (!state.meetings.length) state.meetings.push(meeting); f.emit('meeting.updated', structuredClone(meeting)); };
    f.live = () => f.update({ segments: Array.from({ length: 9 }, (_, i) => ({ speaker: `Speaker ${i % 2 + 1}`, start: i * 8, end: i * 8 + 6, text: `Turn ${i}: ${i === 8 ? 'We should clarify who reviews the draft before Friday.' : 'A synthetic transcript turn kept for the meeting record.'}` })) });
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string, params: any = {}) => {
      f.calls.push({ method, params });
      if (method === 'app.state') return structuredClone(state);
      if (method === 'meeting.tip.current') { const tip = config.savedTip ? { sessionId: meeting.id, text: config.savedTip } : null; if (config.holdTip) return new Promise(resolve => { f.resolveTip = () => resolve(tip); }); return tip; }
      if (method === 'meeting.start') { if (f.failStart) throw new Error(f.startError || 'Microphone access was denied. Check macOS permissions and retry.'); meeting.title = params.title; f.update({ status: 'recording', segments: [], notes: '' }); return structuredClone(meeting); }
      if (method === 'meeting.stop') {
        if (f.failStop) throw new Error('Capture could not stop. Recording is still active; retry Stop.');
        if (config.holdStop) await new Promise<void>(resolve => { f.resolveStop = resolve; });
        f.update({ status: 'finalizing' }); return { stopped: true };
      }
      if (method === 'chat.send') {
        if (config.holdAsk) await new Promise<void>(resolve => { f.resolveAsk = resolve; });
        if (f.askError) throw new Error('Meeting answer is unavailable. Try again.');
        return { text: 'Clarify who will review the draft before Friday.' };
      }
      if (method === 'meeting.update') { if (f.failSave) throw new Error('The notes could not save. Your draft is preserved.'); f.update({ notes: params.notes }); return structuredClone(meeting); }
      if (method === 'meeting.summarize' || method === 'meeting.retry') { f.update({ notes: 'Synthetic summary from the fixture transcript.' }); return structuredClone(meeting); }
      if (method === 'window.main' || method === 'window.close' || method === 'permissions.request') return {};
      if (method === 'pet.toggle') { state.pet.visible = params.visible; return state.pet; }
      throw new Error(`Unexpected meeting fixture request ${method}`);
    };
  }, options);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?window=meeting');
  await expect(page.getByRole('main', { name: 'Meeting with Pace' })).toBeVisible();
}
async function inside(locator: Locator, width: number, height: number) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width); expect(box!.y + box!.height).toBeLessThanOrEqual(height);
}
async function screenshot(page: Page, name: string) {
  const directory = path.resolve('.impeccable/review/companion'); await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), fullPage: false, omitBackground: true, animations: 'disabled' });
}
async function start(page: Page) {
  await page.getByRole('textbox', { name: 'Meeting title' }).fill('Friday planning');
  await page.getByRole('button', { name: 'Start meeting', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop meeting', exact: true })).toBeVisible();
}

test('setup waits for an explicit start and sends real source choices', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 380 }); await fixture(page);
  expect(await page.evaluate(() => (window as any).__meetingFixture.calls.some((c: any) => c.method === 'meeting.start'))).toBe(false);
  await expect(page.getByText('No notes yet.', { exact: false })).toHaveCount(0);
  await inside(page.getByRole('button', { name: 'Start meeting', exact: true }), 420, 380);
  await screenshot(page, 'meeting-ready-420x380.png');
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).__meetingFixture.calls.some((call: any) => call.method === 'apps.list'))).toBe(false);
  await page.getByRole('checkbox', { name: 'Microphone', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'System audio', exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Start meeting', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'System audio', exact: true }).check(); await start(page);
  const call = await page.evaluate(() => (window as any).__meetingFixture.calls.find((c: any) => c.method === 'meeting.start'));
  expect(call.params).toEqual({ title: 'Friday planning', language: 'en', captureMicrophone: false, captureSystem: true });
  await expect(page.getByRole('region', { name: 'Live transcript' })).toHaveCount(0);
  await expect(page.getByLabel('Live transcript')).toContainText('Nothing transcribed yet');
});

test('live turns and quiet help stay together, bounded and scoped to the active session', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 380 }); await fixture(page); await start(page);
  await page.evaluate(() => { const f = (window as any).__meetingFixture; f.live(); f.emit('meeting.tip', { sessionId: 'old-meeting', text: 'Unrelated secret tip' }); });
  await expect(page.getByText('Unrelated secret tip')).toHaveCount(0);
  await expect(page.locator('.meeting-live-turn')).toHaveCount(4);
  await expect(page.getByLabel('Live transcript')).not.toContainText('Turn 0:');
  await page.evaluate(() => (window as any).__meetingFixture.emit('meeting.tip', { sessionId: 'meeting-current', text: 'Who will review the draft before Friday?' }));
  await expect(page.getByLabel('Quiet meeting help')).toContainText('Who will review');
  await page.evaluate(() => (window as any).__meetingFixture.emit('meeting.tip', { sessionId: 'old-meeting', text: 'Unrelated secret tip' }));
  await expect(page.getByLabel('Quiet meeting help')).toContainText('Who will review');
  await inside(page.locator('.meeting-cloud'), 420, 380); await inside(page.getByRole('button', { name: 'Stop meeting', exact: true }), 420, 380);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(380);
  await screenshot(page, 'meeting-live-420x380.png');
  await page.getByRole('button', { name: 'Stop meeting', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finishing…', exact: true })).toBeDisabled();
  await expect(page.getByText('Recording has stopped.')).toBeVisible();
  await expect(page.getByLabel('Live transcript')).toContainText('Turn 8');
  await page.evaluate(() => (window as any).__meetingFixture.update({ status: 'completed' }));
  await expect(page.locator('.meeting-notes-text')).toContainText('No notes yet.');
  expect(await page.evaluate(() => (window as any).__meetingFixture.calls.some((c: any) => c.method === 'meeting.summarize'))).toBe(false);
});

test('failed start or stop preserves capture state and permits retry', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 380 }); await fixture(page, { failStart: true });
  await page.getByRole('textbox', { name: 'Meeting title' }).fill('Keep my title');
  await page.getByRole('button', { name: 'Start meeting', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('access was denied');
  await expect(page.getByRole('textbox', { name: 'Meeting title' })).toHaveValue('Keep my title');
  await page.evaluate(() => { const f = (window as any).__meetingFixture; f.failStart = false; f.failStop = true; });
  await page.getByRole('button', { name: 'Start meeting', exact: true }).click();
  await page.getByRole('button', { name: 'Stop meeting', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Recording is still active');
  await expect(page.getByText('● Live · voice off', { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__meetingFixture.failStop = false; });
  await page.getByRole('button', { name: 'Stop meeting', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finishing…', exact: true })).toBeDisabled();
});

test('pending actions disable the cloud controls without losing the recording', async ({ page }) => {
  await fixture(page, { holdStop: true }); await start(page);
  await page.getByRole('button', { name: 'Stop meeting', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stopping…', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Quick hide', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Close meeting cloud', exact: true })).toBeDisabled();
  await expect(page.getByText('● Live · voice off', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__meetingFixture.resolveStop());
  await expect(page.getByRole('button', { name: 'Finishing…', exact: true })).toBeDisabled();
});

test('missing meeting kit opens optional model setup without capture or download', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 300 }); await fixture(page, { installed: false });
  await expect(page.getByText('Meeting help needs Qwen 4B', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start meeting', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Choose meeting models →', exact: true }).click();
  const calls = await page.evaluate(() => (window as any).__meetingFixture.calls);
  expect(calls).toContainEqual({ method: 'window.main', params: { page: 'models' } });
  expect(calls.some((c: any) => ['meeting.start', 'models.download'].includes(c.method))).toBe(false);
  await inside(page.getByRole('button', { name: 'Start meeting', exact: true }), 360, 300);
  await screenshot(page, 'meeting-models-360x300.png');
});

test('cover copy is honest and quick hide never stops capture', async ({ page }) => {
  await fixture(page, { cover: false }); await start(page);
  await expect(page.getByText('Cover off', { exact: true })).toHaveAttribute('title', /best effort.*Ctrl\+Shift\+H/);
  await page.getByRole('button', { name: 'Quick hide', exact: true }).click();
  const calls = await page.evaluate(() => (window as any).__meetingFixture.calls);
  expect(calls).toContainEqual({ method: 'pet.toggle', params: { visible: false } });
  expect(calls.some((c: any) => c.method === 'meeting.stop')).toBe(false);
  await page.getByRole('button', { name: 'Close meeting cloud', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__meetingFixture.calls)).toContainEqual({ method: 'window.close', params: { label: 'meeting' } });
});

test('completed notes stay editable and a failed save keeps the draft across reopen', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 380 }); await fixture(page, { status: 'completed', failSave: true });
  await expect(page.locator('.meeting-notes-text')).toContainText('No notes yet.');
  await page.getByRole('button', { name: 'Add your own', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit meeting notes' }); await editor.fill('My reviewed next step.');
  await page.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('draft is preserved');
  await expect(editor).toHaveValue('My reviewed next step.');
  await page.reload(); await page.getByRole('button', { name: 'Add your own', exact: true }).click();
  await expect(editor).toHaveValue('My reviewed next step.');
  await page.evaluate(() => { (window as any).__meetingFixture.failSave = false; });
  await page.getByRole('button', { name: 'Save notes', exact: true }).click();
  await expect(page.locator('.meeting-notes-text')).toHaveText('My reviewed next step.');
  await screenshot(page, 'meeting-notes-420x380.png');
  await page.getByRole('button', { name: 'Full record ↗', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__meetingFixture.calls)).toContainEqual({ method: 'window.main', params: { page: 'meetings' } });
});

test('small meeting windows retain a visible primary action and scroll reading content', async ({ page }) => {
  await fixture(page, { status: 'recording' }); await page.evaluate(() => (window as any).__meetingFixture.live());
  for (const [width, height] of [[360, 300], [390, 380]]) {
    await page.setViewportSize({ width, height });
    await inside(page.locator('.meeting-cloud'), width, height); await inside(page.getByRole('button', { name: 'Stop meeting', exact: true }), width, height);
    await expect.poll(() => page.getByLabel('Live transcript').evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)).toBe(true);
    await inside(page.locator('.meeting-tip p'), width, height);
    await expect(page.locator('.meeting-cloud-body')).toHaveCSS('overflow-y', 'auto');
    await inside(page.getByRole('textbox', { name: 'Ask Pace about this meeting', exact: true }), width, height);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(height);
    await screenshot(page, `meeting-live-${width}x${height}.png`);
  }
});


test('reopening restores the session tip and a late snapshot never replaces newer help', async ({ page }) => {
  await fixture(page, { status: 'recording', savedTip: 'A previously shown question.', holdTip: true });
  await expect.poll(() => page.evaluate(() => typeof (window as any).__meetingFixture.resolveTip)).toBe('function');
  await page.evaluate(() => { const f = (window as any).__meetingFixture; f.emit('meeting.tip', { sessionId: 'meeting-current', text: 'A newer useful question.' }); f.resolveTip(); });
  await expect(page.getByLabel('Quiet meeting help')).toContainText('A newer useful question.');
  await expect(page.getByLabel('Quiet meeting help')).not.toContainText('previously shown');
  await page.reload();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__meetingFixture.resolveTip)).toBe('function');
  await page.evaluate(() => (window as any).__meetingFixture.resolveTip());
  await expect(page.getByLabel('Quiet meeting help')).toContainText('A previously shown question.');
});


test('interrupted audio can retry even before the first saved transcript turn', async ({ page }) => {
  await fixture(page, { status: 'interrupted' });
  await page.evaluate(() => (window as any).__meetingFixture.update({ segments: [], error: 'No speech was detected. Saved audio is preserved; retry or delete this meeting.' }));
  await expect(page.getByText('No speech was detected. Saved audio is preserved; retry or delete this meeting.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__meetingFixture.calls)).toContainEqual({ method: 'meeting.retry', params: { id: 'meeting-current', language: 'en' } });
  await expect(page.locator('.meeting-notes-text')).toContainText('Synthetic summary');
});


test('permission recovery is explicit and microphone-only retry keeps the source choice', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 300 }); await fixture(page, { failStart: true });
  await page.evaluate(() => { (window as any).__meetingFixture.startError = 'Enable Screen & System Audio Recording in System Settings before capturing meeting audio.'; });
  await page.getByRole('button', { name: 'Start meeting', exact: true }).click();
  const access=page.getByRole('button', { name: 'Allow system audio', exact: true });
  const fallback=page.getByRole('button', { name: 'Use microphone only', exact: true });
  for (const action of [access,fallback]) {
    await inside(action,360,300);
    expect(await action.evaluate(element=>{const button=element.getBoundingClientRect();const panel=element.closest('.cloud-error')!.getBoundingClientRect();return button.top>=panel.top&&button.bottom<=panel.bottom;})).toBe(true);
  }
  await access.click();
  expect(await page.evaluate(() => (window as any).__meetingFixture.calls)).toContainEqual({ method: 'permissions.request', params: { kind: 'screenRecording' } });
  await page.getByRole('button', { name: 'Start meeting', exact: true }).click();
  await page.getByRole('button', { name: 'Use microphone only', exact: true }).click();
  await expect(page.getByLabel('System audio', { exact: true })).not.toBeChecked();
  expect((await page.evaluate(() => (window as any).__meetingFixture.calls)).filter((call: any) => call.method === 'meeting.start')).toHaveLength(2);
  await page.evaluate(() => { (window as any).__meetingFixture.failStart = false; });
  await page.getByRole('button', { name: 'Start meeting', exact: true }).click();
  const starts=await page.evaluate(() => (window as any).__meetingFixture.calls.filter((call: any) => call.method === 'meeting.start'));
  expect(starts.at(-1).params.captureSystem).toBe(false); expect(starts.at(-1).params.captureMicrophone).toBe(true);
});


test('meeting copilot asks only about this transcript and Stop stays reachable while thinking', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 380 }); await fixture(page, { status: 'recording', holdAsk: true });
  const input = page.getByRole('textbox', { name: 'Ask Pace about this meeting', exact: true });
  expect(await page.evaluate(() => (window as any).__meetingFixture.calls.some((call: any) => call.method === 'chat.send'))).toBe(false);
  await input.fill('What should I clarify next?');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: true });
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, keyCode: 229 });
  expect(await page.evaluate(() => (window as any).__meetingFixture.calls.some((call: any) => call.method === 'chat.send'))).toBe(false);
  await page.getByRole('button', { name: 'Ask Pace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ask Pace', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Stop meeting', exact: true })).toBeEnabled();
  await input.fill('Keep my next question.');
  await page.evaluate(() => (window as any).__meetingFixture.resolveAsk());
  await expect(page.getByLabel('Pace’s meeting answer')).toHaveText('Clarify who will review the draft before Friday.');
  await expect(input).toHaveValue('Keep my next question.');
  const calls = await page.evaluate(() => (window as any).__meetingFixture.calls);
  const question = calls.filter((call: any) => call.method === 'chat.send'); expect(question).toHaveLength(1);
  expect(question[0].params).toMatchObject({ meetingId: 'meeting-current', conversationId: 'meeting-meeting-current', text: 'What should I clarify next?', quiet: true });
  expect(question[0].params.clientRequestId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(calls.some((call: any) => call.method.startsWith('voice.'))).toBe(false);
  await inside(input, 420, 380); await inside(page.getByRole('button', { name: 'Stop meeting', exact: true }), 420, 380);
  await page.getByLabel('Pace’s meeting answer').scrollIntoViewIfNeeded(); await screenshot(page, 'meeting-copilot-420x380.png');
});

test('saved meeting question failure keeps the draft and a late answer cannot leak into a new meeting', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 380 }); await fixture(page, { status: 'completed', holdAsk: true, askError: true });
  const input = page.getByRole('textbox', { name: 'Ask Pace about this meeting', exact: true });
  await input.fill('Who reviews the draft?'); await page.getByRole('button', { name: 'Ask Pace', exact: true }).click();
  await page.evaluate(() => (window as any).__meetingFixture.resolveAsk());
  await expect(page.getByRole('alert')).toContainText('Meeting answer is unavailable'); await expect(input).toHaveValue('Who reviews the draft?');
  await page.evaluate(() => { (window as any).__meetingFixture.askError = false; });
  await page.getByRole('button', { name: 'Ask Pace', exact: true }).click();
  await page.getByRole('button', { name: 'New meeting', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start meeting', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__meetingFixture.resolveAsk());
  await expect(page.getByLabel('Pace’s meeting answer')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Ask Pace about this meeting' })).toHaveCount(0);
});
