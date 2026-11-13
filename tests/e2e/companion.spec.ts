import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

type FixtureOptions = {
  history?: Array<{ role: string; content: string }>;
  holdFirstChat?: boolean;
  nativeEvents?: boolean;
  petSize?: number;
  replyText?: string;
  completionError?: string;
  staleCompletion?: boolean;
  writingAvailability?: { available: boolean; reason?: string; app?: string; permissionRequired?: boolean };
  noModel?: boolean;
  holdWritingChecks?: boolean;
  dictationLanguage?: string;
  speechModels?: Array<{ id: string; installed: boolean }>;
  dictationError?: string;
};

async function companionFixture(page: Page, options: FixtureOptions = {}) {
  await page.addInitScript((config: FixtureOptions) => {
    const settings = {
      onboardingCompleted: true, language: 'en', voice: 'Kiki', voiceEngine: 'auto', pitch: 1.05,
      rate: 1, volume: .65, petSize: 160, activePack: 'pace', speechEnabled: false, soundEnabled: false,
      memoryEnabled: false, allowedApps: [], allowedDomains: [], retentionDays: 30, meetingTips: false,
      dictationLanguage: config.dictationLanguage || 'en', clickThrough: false, hideShortcut: 'Alt+Shift+Space', commandShortcut: 'Alt+Space',
    };
    settings.petSize = config.petSize ?? 160;
    const state = {
      settings,
      models: config.noModel ? [] : [{ id: 'qwen3.5-4b', name: 'Qwen 3.5 · 4B', role: 'Chat & writing', sizeBytes: 100_000_000, installed: true, status: 'installed' }],
      meetings: [], extensions: [], packs: [{ id: 'pace', name: 'Pace' }],
      memory: { enabled: false, applications: [] }, pet: { visible: true, action: 'idle' },
    };
    if (config.speechModels) state.models.push(...config.speechModels.map(model => ({ name: model.id, role: 'Dictation', sizeBytes: 1, status: model.installed ? 'installed' : 'not-installed', ...model })));
    const writingChecks: Array<(value: unknown) => void> = [];
    const fixture: any = { calls: [] as Array<{ method: string; params: any }>, copied: [] as string[] };
    fixture.settleWriting = (index: number, value: unknown) => writingChecks[index]?.(value);
    let chatCount = 0;
    let pendingChat: { resolve: (value: unknown) => void; reject: (reason: Error) => void } | undefined;
    fixture.settleChat = (success: boolean) => {
      if (!pendingChat) return;
      const pending = pendingChat; pendingChat = undefined;
      if (success) pending.resolve({ text: config.replyText || 'Pace has a clear next step.' });
      else pending.reject(new Error('The local reply service is offline.'));
    };
    (window as any).__companionFixture = fixture;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => fixture.copied.push(value) } });
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string, params: any = {}) => {
      fixture.calls.push({ method, params });
      if (method === 'app.state') return structuredClone(state);
      if (method === 'completion.available' && config.holdWritingChecks) return new Promise(resolve => writingChecks.push(resolve));
      if (method === 'completion.available') return { available: true, app: 'TextEdit', shortcut: 'Alt+Shift+Enter', ...config.writingAvailability };
      if (method === 'completion.current') { if (config.completionError) throw new Error(config.completionError); return { phase: 'ready', version: 1, targetId: 'fixture-completion', app: 'TextEdit', text: ' with one small step.' }; }
      if (method === 'completion.apply') { if (config.staleCompletion) throw new Error('The cursor changed. Copy this suggestion or request a fresh one.'); return { applied: true }; }
      if (method === 'completion.dismiss') return { dismissed: true };
      if (method === 'completion.suggest') return { phase: 'generating' };
      if (method === 'dictation.toggle') { if (config.dictationError) throw new Error(config.dictationError); return { phase: 'recording' }; }
      if (method === 'chat.history') return structuredClone(config.history || []);
      if (method === 'chat.send') {
        chatCount++;
        if (config.holdFirstChat && chatCount === 1) return new Promise((resolve, reject) => { pendingChat = { resolve, reject }; });
        return { conversationId: params.conversationId, text: config.replyText || 'Pace has a clear next step.' };
      }
      if (method === 'audio.start') return { recording: true, sessionId: 'fixture-dictation' };
      if (method === 'audio.stop') return { recording: false, text: 'Dictated words for the draft.' };
      if (method === 'settings.update') { Object.assign(settings, params.patch); return settings; }
      if (method === 'permissions.request') return { requested: true };
      if (method === 'voice.stop') return { stopped: true };
      if (method === 'window.talk' || method === 'window.command' || method === 'window.main' || method === 'window.meeting') return { opened: true };
      if (method === 'window.close') return { hidden: true };
      if (method === 'writing.current') return { contextId: 'fixture-selection', application: 'TextEdit', text: 'The review are on 12 April.', canApply: true };
      if (method === 'writing.generate') return { text: 'The review is on 12 April.' };
      if (method === 'writing.apply') return { applied: true };
      throw new Error(`Unexpected companion fixture request: ${method}`);
    };
    if (config.nativeEvents) {
      let nextCallback = 0;
      let nextEvent = 0;
      const eventHandlers = new Map<number, string>();
      const callbacks: Record<string, (event: any) => void> = {};
      (window as any).__tauriEventState = { listeners: 0 };
      (window as any).__TAURI_INTERNALS__ = {
        transformCallback(callback: (event: any) => void) { const id = `fixture-callback-${++nextCallback}`; callbacks[id] = callback; return id; },
        unregisterCallback(id: string) { delete callbacks[id]; },
        async invoke(command: string, args: any) {
          if (command === 'plugin:event|listen') { const id = ++nextEvent; eventHandlers.set(id, args.handler); (window as any).__tauriEventState.listeners = eventHandlers.size; return id; }
          if (command === 'plugin:event|unlisten') { eventHandlers.delete(args.eventId); return; }
          throw new Error(`Unexpected native event fixture request: ${command}`);
        },
      };
      (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
      fixture.emit = (event: string, data: any) => { for (const callbackId of eventHandlers.values()) callbacks[callbackId]?.({ event: 'pace-event', id: 1, payload: { event, data } }); };
      fixture.emitVoiceError = (message: string) => fixture.emit('voice.error', { message });
    }
  }, options);
}

async function expectInsideWindow(element: Locator, width: number, height: number) {
  const box = await element.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height);
}

async function saveCompanionScreenshot(page: Page, name: string) {
  const directory = path.resolve('.impeccable/review/companion');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), fullPage: false, omitBackground: true, animations: 'disabled' });
}

test('Pace fits and captures each configured native pet window size', async ({ browser }) => {
  for (const size of [128, 160, 208]) {
    const width = size + 64, height = size + 64;
    const page = await browser.newPage({ viewport: { width, height } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await companionFixture(page, { petSize: size }); await page.goto('/?window=pet');
    const pet = page.getByRole('button', { name: 'Pet Pace; drag to move; right-click for menu', exact: true });
    const controls = page.locator('.pet-controls');
    await expect(pet).toBeVisible();
    await expectInsideWindow(pet, width, height);
    await expect(controls).toBeHidden();
    if (size === 160) await saveCompanionScreenshot(page, 'pet-idle-224x224.png');
    await pet.hover();
    await expect(controls).toBeVisible();
    await expect(controls.getByRole('button')).toHaveCount(5);
    await expect(controls.getByRole('button', { name: 'Talk', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Dictate into your app', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Write for me', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Meeting buddy', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Settings and shortcuts', exact: true })).toBeVisible();
    await expectInsideWindow(controls, width, height);
    const slots = await controls.getByRole('button').evaluateAll(buttons => buttons.map(button => ({ x: button.getBoundingClientRect().x, y: button.getBoundingClientRect().y, words: button.textContent })));
    expect(slots.map(slot => slot.words)).toEqual(['', '', '', '', '']);
    expect(slots[0].y).toBeGreaterThan(slots[1].y); expect(slots[1].y).toBeGreaterThan(slots[2].y);
    expect(slots[3].y).toBe(slots[1].y); expect(slots[4].y).toBe(slots[0].y);
    for (const button of await controls.getByRole('button').all()) await expectInsideWindow(button, width, height);
    expect(await controls.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    if (size === 160) {
      const dictate = controls.getByRole('button', { name: 'Dictate into your app', exact: true });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await dictate.hover();
      await expect.poll(() => dictate.evaluate(element => getComputedStyle(element).transform)).not.toBe('none');
      await expect.poll(() => controls.getByRole('button', { name: 'Talk', exact: true }).evaluate(element => getComputedStyle(element).transform)).not.toBe('none');
      await saveCompanionScreenshot(page, 'pet-hover-224x224.png');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect.poll(() => dictate.evaluate(element => getComputedStyle(element).transform)).toBe('none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
    await saveCompanionScreenshot(page, `pet-window-${width}x${height}.png`);
    await page.mouse.move(0, 0);
    await expect(controls).toBeHidden();
    // WebKit leaves the transparent overlay on its first Tab; retain keyboard modality before focusing the pet.
    await page.keyboard.press('Tab');
    await pet.focus();
    await expect(pet).toBeFocused();
    await expect(controls).toBeVisible();
    await page.close();
  }
});

test('the pet opens Talk only when its Talk control is chosen', async ({ page }) => {
  await companionFixture(page); await page.goto('/?window=pet');
  const pet = page.getByRole('button', { name: 'Pet Pace; drag to move; right-click for menu', exact: true });
  const talk = page.getByRole('button', { name: 'Talk', exact: true });
  await expect(talk).toBeHidden();
  await pet.hover();
  await talk.click();
  await expect.poll(() => page.evaluate(() => (window as any).__companionFixture.calls.filter((call: any) => call.method === 'window.talk').length)).toBe(1);
  const methods = await page.evaluate(() => (window as any).__companionFixture.calls.map((call: any) => call.method));
  expect(methods).not.toContain('chat.send');
  expect(methods).not.toContain('audio.start');
  expect(methods).not.toContain('pet.action');
});

test('hover controls route Dictate and Write for me to their own actions', async ({ page }) => {
  await companionFixture(page); await page.goto('/?window=pet');
  const pet = page.getByRole('button', { name: 'Pet Pace; drag to move; right-click for menu', exact: true });
  await pet.hover();
  await page.getByRole('button', { name: 'Dictate into your app', exact: true }).click();
  await page.getByRole('button', { name: 'Write for me', exact: true }).click();
  const methods = await page.evaluate(() => (window as any).__companionFixture.calls.map((call: any) => call.method));
  expect(methods).toContain('dictation.toggle');
  expect(methods).toContain('completion.suggest');
  expect(methods).not.toContain('chat.send');
});

test('Meet opens its cloud and the gear links directly to shortcut settings', async ({ page }) => {
  await companionFixture(page); await page.goto('/?window=pet');
  await page.getByRole('button', { name: 'Pet Pace; drag to move; right-click for menu', exact: true }).hover();
  await page.getByRole('button', { name: 'Meeting buddy', exact: true }).click();
  await page.getByRole('button', { name: 'Settings and shortcuts', exact: true }).click();
  const calls = await page.evaluate(() => (window as any).__companionFixture.calls);
  expect(calls).toContainEqual({ method: 'window.meeting', params: {} });
  expect(calls).toContainEqual({ method: 'window.main', params: { page: 'settings', section: 'shortcuts' } });
  expect(calls.some((call: any) => ['audio.start', 'meeting.start', 'chat.send'].includes(call.method))).toBe(false);
});

test('Talk shows history without inventing a reply and fits its native 300×200 window', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 200 });
  await companionFixture(page, { history: [{ role: 'user', content: 'An earlier question.' }, { role: 'assistant', content: 'The saved answer from yesterday.' }] });
  await page.goto('/?window=bubble');
  await expect(page.locator('.cloud-header')).toContainText('Pace');
  await expect(page.getByRole('img', { name: 'Pace is idle', exact: true })).toBeVisible();
  await expect(page.locator('.cloud-header').getByRole('button', { name: 'Close speech bubble', exact: true })).toBeVisible();
  await expect(page.locator('.cloud-header nav')).toHaveCount(0);
  await expect(page.locator('.bubble-reply')).toHaveText('The saved answer from yesterday.');
  expect(await page.locator('.talk-cloud').evaluate(element => getComputedStyle(element).borderRadius)).toBe('0px');
  await expect(page.getByRole('textbox', { name: 'Ask Pace', exact: true })).toBeVisible();
  await expectInsideWindow(page.locator('.cloud-compose'), 300, 200);
  const methods = await page.evaluate(() => (window as any).__companionFixture.calls.map((call: any) => call.method));
  expect(methods).not.toContain('chat.send');
  expect(methods).not.toContain('audio.start');
});

test('Talk keeps a failed draft, disables duplicate sends while pending, then retries explicitly', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 200 });
  await companionFixture(page, { holdFirstChat: true }); await page.goto('/?window=bubble');
  const input = page.getByRole('textbox', { name: 'Ask Pace', exact: true });
  await expect(page.locator('.bubble-reply')).toHaveCount(0);
  await expect(page.getByText('What’s on your mind?', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading')).toHaveCount(0);
  await expect(page.getByText('Your little corner of company.')).toHaveCount(0);
  await input.focus();
  expect(await page.locator('.cloud-compose').evaluate(element => getComputedStyle(element).outlineWidth)).toBe('2px');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await saveCompanionScreenshot(page, 'talk-empty-300x200.png');
  await input.fill('Help me decide the next step.');
  const send = page.getByRole('button', { name: 'Send question', exact: true });
  await send.click();
  await expect(page.getByRole('status')).toContainText('Pace is working on it');
  await expect(send).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as any).__companionFixture.calls.filter((call: any) => call.method === 'chat.send').length)).toBe(1);
  await page.evaluate(() => (window as any).__companionFixture.settleChat(false));
  await expect(page.locator('.cloud-error')).toContainText('The local reply service is offline.');
  await expect(input).toHaveValue('Help me decide the next step.');
  await send.click();
  await expect(page.locator('.bubble-reply')).toContainText('Pace has a clear next step.');
  await expect(input).toHaveValue('');
  const sent = await page.evaluate(() => (window as any).__companionFixture.calls.filter((call: any) => call.method === 'chat.send').map((call: any) => call.params));
  expect(sent).toHaveLength(2);
  for (const request of sent) {
    expect(request).toMatchObject({ text: 'Help me decide the next step.', conversationId: 'pace-desktop-companion', surface: 'pet' });
    expect(request.clientRequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  }
  expect(sent[0].clientRequestId).not.toBe(sent[1].clientRequestId);
  await expect(input).toBeFocused();
  const reply = await page.locator('.bubble-reply').evaluate(element => ({ top: element.scrollTop, visible: element.clientHeight, total: element.scrollHeight }));
  if (reply.total > reply.visible) expect(reply.top).toBeGreaterThan(0);
  if (reply.total <= reply.visible) {
    await expect(page.locator('.bubble-reply')).toHaveText('Pace has a clear next step.');
  }
  await expectInsideWindow(page.locator('.cloud-compose'), 300, 200);
});

test('long Talk replies scroll above the fixed composer and capture the lower reply', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 200 });
  await companionFixture(page, { replyText: 'A long synthetic reply explains each next step in a little more detail. '.repeat(24) });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/?window=bubble');
  const input = page.getByRole('textbox', { name: 'Ask Pace', exact: true });
  await input.fill('Give me a detailed answer.'); await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(page.locator('.bubble-reply')).toContainText('A long synthetic reply');
  const scroll = await page.locator('.bubble-reply').evaluate(element => ({ top: element.scrollTop, visible: element.clientHeight, total: element.scrollHeight }));
  expect(scroll.total).toBeGreaterThan(scroll.visible);
  expect(scroll.top).toBeGreaterThan(0);
  await expectInsideWindow(page.locator('.cloud-compose'), 300, 200);
  await saveCompanionScreenshot(page, 'talk-longreply-300x200.png');
});

test('dictation fills the Talk draft and waits for Send; IME Enter does not send a candidate', async ({ page }) => {
  await companionFixture(page); await page.goto('/?window=bubble');
  const input = page.getByRole('textbox', { name: 'Ask Pace', exact: true });
  await page.getByRole('button', { name: 'Dictate a message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop dictation', exact: true })).toBeVisible();
  let calls = await page.evaluate(() => (window as any).__companionFixture.calls.map((call: any) => call.method));
  expect(calls).toContain('audio.start'); expect(calls).not.toContain('chat.send');
  await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
  await expect(input).toHaveValue('Dictated words for the draft.');
  calls = await page.evaluate(() => (window as any).__companionFixture.calls.map((call: any) => call.method));
  expect(calls.filter(method => method === 'audio.stop')).toHaveLength(1);
  expect(calls).not.toContain('chat.send');
  await input.fill('こんにちは、Pace');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: true });
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: false, keyCode: 229 });
  await expect(input).toHaveValue('こんにちは、Pace');
  calls = await page.evaluate(() => (window as any).__companionFixture.calls.map((call: any) => call.method));
  expect(calls).not.toContain('chat.send');
  await input.press('Enter');
  await expect(page.locator('.bubble-reply')).toContainText('Pace has a clear next step.');
  expect(await page.evaluate(() => (window as any).__companionFixture.calls.filter((call: any) => call.method === 'chat.send').length)).toBe(1);
});

test('Talk surfaces spoken reply failures honestly', async ({ page }) => {
  await companionFixture(page, { nativeEvents: true }); await page.goto('/?window=bubble');
  await expect.poll(() => page.evaluate(() => (window as any).__tauriEventState.listeners)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).__companionFixture.emit('voice.started', {}));
  await expect(page.getByRole('img', { name: 'Pace is talk' })).toBeVisible();
  await page.evaluate(() => (window as any).__companionFixture.emitVoiceError('Kitten voice could not play this reply.'));
  await expect(page.getByRole('img', { name: 'Pace is idle' })).toBeVisible();
  await expect(page.locator('.cloud-error')).toContainText('Kitten voice could not play this reply.');
});

test('cursor autocomplete is a preview with explicit accept and copy fallback', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 200 }); await companionFixture(page); await page.goto('/?window=command');
  await expect(page.getByRole('main', { name: 'Autocomplete at your cursor' })).toBeVisible();
  const preview = page.getByRole('textbox', { name: 'Suggested continuation' });
  await expect(preview).toHaveValue(' with one small step.');
  await expect(page.locator('.cloud-header')).toContainText('TextEdit');
  expect(await page.evaluate(() => (window as any).__companionFixture.calls.some((call: any) => call.method === 'completion.apply'))).toBe(false);
  await expectInsideWindow(preview, 360, 200); await expectInsideWindow(page.getByRole('button', { name: 'Accept', exact: true }), 360, 200);
  await saveCompanionScreenshot(page, 'autocomplete-ready-360x200.png');
  await preview.fill('');
  await expect(preview).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toBeDisabled();
  await preview.fill(' with one tiny step.'); await page.getByRole('button', { name: 'Copy suggestion' }).click();
  expect(await page.evaluate(() => (window as any).__companionFixture.copied)).toEqual([' with one tiny step.']);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__companionFixture.calls.find((call: any) => call.method === 'completion.apply').params)).toEqual({ targetId: 'fixture-completion', text: ' with one tiny step.' });
});

test('autocomplete accessibility errors offer an explicit permission action in the compact window', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 200 });
  await companionFixture(page, { completionError: 'Accessibility permission is required to read text at your cursor.' });
  await page.goto('/?window=command');
  await expect(page.getByRole('alert')).toContainText('Accessibility permission is required');
  const accept = page.getByRole('button', { name: 'Accept', exact: true });
  const access = page.getByRole('button', { name: 'Open Accessibility settings', exact: true });
  await expect(accept).toBeDisabled();
  await expectInsideWindow(page.locator('.completion-cloud'), 360, 200);
  await expectInsideWindow(access, 360, 200);
  await expectInsideWindow(accept, 360, 200);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(200);
  expect(await page.evaluate(() => (window as any).__companionFixture.calls.some((call: any) => call.method === 'permissions.request'))).toBe(false);
  await saveCompanionScreenshot(page, 'autocomplete-access-360x200.png');
  await access.click();
  const request = await page.evaluate(() => (window as any).__companionFixture.calls.find((call: any) => call.method === 'permissions.request'));
  expect(request).toMatchObject({ method: 'permissions.request', params: { kind: 'accessibility' } });
});

test('stale autocomplete stays editable and dismiss never inserts text', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 200 }); await companionFixture(page, { staleCompletion: true }); await page.goto('/?window=command');
  await expect(page.getByRole('textbox', { name: 'Suggested continuation' })).toHaveValue(' with one small step.');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cursor changed');
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Suggested continuation' })).toHaveValue(' with one small step.');
  await saveCompanionScreenshot(page, 'autocomplete-stale-360x200.png');
  await page.getByRole('button', { name: 'Dismiss suggestion' }).click();
  expect(await page.evaluate(() => (window as any).__companionFixture.calls.filter((call: any) => call.method === 'completion.apply').length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__companionFixture.calls.some((call: any) => call.method === 'completion.dismiss'))).toBe(true);
});

test('global dictation types into the app without replacing a pending chat draft', async ({ page }) => {
  await companionFixture(page, { nativeEvents: true }); await page.goto('/?window=bubble');
  const input = page.getByRole('textbox', { name: 'Ask Pace', exact: true }); await input.fill('My unsent thought');
  await expect.poll(() => page.evaluate(() => (window as any).__tauriEventState.listeners)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.state', { phase: 'recording' }));
  await expect(page.getByRole('button', { name: 'Stop dictation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send question' })).toBeDisabled();
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.finished', { inserted: true, text: 'Words for the other app.' }));
  await expect(input).toHaveValue('My unsent thought'); await expect(page.locator('.cloud-foot')).toContainText('Typed into your app.');
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.finished', { inserted: false, text: 'Preserved when the cursor moved.' }));
  await expect(input).toHaveValue('My unsent thought Preserved when the cursor moved.');
  expect(await page.evaluate(() => (window as any).__companionFixture.calls.some((call: any) => call.method === 'chat.send'))).toBe(false);

  await page.setViewportSize({ width: 224, height: 224 });
  await page.goto('/?window=pet');
  await expect.poll(() => page.evaluate(() => (window as any).__tauriEventState.listeners)).toBeGreaterThan(0);
  await page.evaluate(() => { const fixture = (window as any).__companionFixture; fixture.emit('pet.action', { action: 'dictate' }); fixture.emit('dictation.state', { phase: 'recording' }); });
  await expect(page.getByRole('status')).toHaveText('Listening…');
  const pet = page.getByRole('button', { name: 'Pet Pace; drag to move; right-click for menu', exact: true });
  await expect(pet.locator('.pace-sprite')).toHaveAttribute('aria-label', 'Pace is dictate');
  await pet.hover();
  await expect(page.locator('.pet-controls')).toBeVisible();
  await saveCompanionScreenshot(page, 'pet-dictating-224x224.png');
});

test('streamed chat text accepts only the current client request', async ({ page }) => {
  await companionFixture(page, { nativeEvents: true, holdFirstChat: true }); await page.goto('/?window=bubble');
  await page.getByRole('textbox', { name: 'Ask Pace', exact: true }).fill('One step?'); await page.getByRole('button', { name: 'Send question' }).click();
  const id = await page.evaluate(() => (window as any).__companionFixture.calls.find((call: any) => call.method === 'chat.send').params.clientRequestId);
  await page.evaluate(() => (window as any).__companionFixture.emit('chat.delta', { clientRequestId: 'older-request', text: 'Wrong reply' }));
  await expect(page.locator('.bubble-reply')).toHaveCount(0);
  await page.evaluate((clientRequestId: string) => (window as any).__companionFixture.emit('chat.delta', { clientRequestId, text: 'Take one tiny step.' }), id);
  await expect(page.locator('.bubble-reply')).toHaveText('Take one tiny step.');
  await page.evaluate(() => (window as any).__companionFixture.settleChat(true));
});

test('an answer never clears words typed while it was pending', async ({ page }) => {
  await companionFixture(page, { holdFirstChat: true }); await page.goto('/?window=bubble');
  const input = page.getByRole('textbox', { name: 'Ask Pace', exact: true }); await input.fill('First thought');
  await page.getByRole('button', { name: 'Send question' }).click(); await input.fill('Next unsent thought');
  await page.evaluate(() => (window as any).__companionFixture.settleChat(true));
  await expect(page.locator('.bubble-reply')).toHaveText('Pace has a clear next step.');
  await expect(input).toHaveValue('Next unsent thought');
  expect(await page.evaluate(() => sessionStorage.getItem('pace.pet-draft'))).toBe('Next unsent thought');
});

test('dictation recovery appends once across its state and finished events', async ({ page }) => {
  await companionFixture(page, { nativeEvents: true }); await page.goto('/?window=bubble');
  const input = page.getByRole('textbox', { name: 'Ask Pace', exact: true }); await input.fill('Keep my idea.');
  await expect.poll(() => page.evaluate(() => (window as any).__tauriEventState.listeners)).toBeGreaterThan(0);
  await page.evaluate(() => { const f = (window as any).__companionFixture; f.emit('dictation.state', { phase: 'recording' }); f.emit('dictation.state', { phase: 'draft', text: 'Keep my voice too.' }); f.emit('dictation.finished', { inserted: false, text: 'Keep my voice too.' }); });
  await expect(input).toHaveValue('Keep my idea. Keep my voice too.');
});


test('ring keyboard navigation reveals shortcut hints and skips unavailable writing', async ({ page }) => {
  await page.setViewportSize({ width: 224, height: 224 });
  await companionFixture(page, { writingAvailability: { available: false, reason: 'Focus an editable field.' } });
  await page.goto('/?window=pet');
  const pet = page.getByRole('button', { name: 'Pet Pace; drag to move; right-click for menu', exact: true });
  await page.keyboard.press('Tab'); await pet.focus();
  await expect(page.locator('.pet-controls')).toBeVisible();
  const talk = page.getByRole('button', { name: 'Talk', exact: true });
  for (const key of ['ArrowUp', 'ArrowRight', 'Tab']) {
    await pet.focus(); await pet.press(key); await expect(talk).toBeFocused();
  }
  await pet.focus(); await pet.press('Shift+Tab'); await expect(talk).not.toBeFocused();
  await pet.focus(); await pet.press('Tab'); await expect(talk).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText('Talk · Alt+Space');
  await expect(page.getByRole('button', { name: 'Write for me', exact: true })).toBeHidden();
  await talk.press('ArrowRight'); await expect(page.getByRole('button', { name: 'Dictate into your app' })).toBeFocused();
  await page.keyboard.press('End'); await expect(page.getByRole('button', { name: 'Settings and shortcuts' })).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect(talk).toBeFocused();
  expect(await page.evaluate(() => (window as any).__companionFixture.calls.filter((call: any) => call.method === 'completion.available').length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__companionFixture.calls.some((call: any) => call.method === 'completion.suggest'))).toBe(false);
});

test('ring hover crosses transparent gaps and checks writing only once per opening', async ({ page }) => {
  await page.setViewportSize({ width: 224, height: 224 }); await companionFixture(page); await page.goto('/?window=pet');
  await page.getByRole('button', { name: 'Pet Pace; drag to move; right-click for menu', exact: true }).hover();
  await page.mouse.move(110, 102);
  await expect(page.locator('.pet-controls')).toBeVisible();
  await page.getByRole('button', { name: 'Talk', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toHaveText('Talk · Alt+Space');
  await page.getByRole('button', { name: 'Write for me', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toContainText('Write in TextEdit');
  expect(await page.evaluate(() => (window as any).__companionFixture.calls.filter((call: any) => call.method === 'completion.available').length)).toBe(1);
  await page.mouse.move(0, 0); await expect(page.locator('.pet-controls')).toBeHidden();
  expect(await page.locator('.pet-controls button').first().evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
});

test('writing permission affordance explains and opens access settings without capturing text', async ({ page }) => {
  await page.setViewportSize({ width: 224, height: 224 });
  await companionFixture(page, { writingAvailability: { available: false, permissionRequired: true, reason: 'Allow Accessibility to write at your cursor.' } });
  await page.goto('/?window=pet');
  await page.getByRole('button', { name: 'Pet Pace; drag to move; right-click for menu', exact: true }).hover();
  const write = page.getByRole('button', { name: 'Write for me', exact: true }); await write.hover();
  await expect(page.getByRole('tooltip')).toContainText('Allow Accessibility'); await write.click();
  const calls = await page.evaluate(() => (window as any).__companionFixture.calls);
  expect(calls).toContainEqual({ method: 'permissions.request', params: { kind: 'accessibility' } });
  expect(calls.some((call: any) => call.method === 'completion.suggest')).toBe(false);
});

test('compact Talk emotes follow listening, thinking and actual voice playback; copy and mute remain reachable', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 200 });
  await companionFixture(page, { nativeEvents: true, holdFirstChat: true }); await page.goto('/?window=bubble');
  await expect.poll(() => page.evaluate(() => (window as any).__tauriEventState.listeners)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Dictate a message', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Pace is dictate' })).toBeVisible();
  await saveCompanionScreenshot(page, 'talk-listening-300x200.png');
  await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
  await page.getByRole('button', { name: 'Copy dictation', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__companionFixture.copied)).toEqual(['Dictated words for the draft.']);
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Pace is think' })).toBeVisible();
  await saveCompanionScreenshot(page, 'talk-thinking-300x200.png');
  await page.evaluate(() => (window as any).__companionFixture.settleChat(true));
  await page.evaluate(() => (window as any).__companionFixture.emit('voice.started', {}));
  await expect(page.getByRole('img', { name: 'Pace is talk' })).toBeVisible();
  await saveCompanionScreenshot(page, 'talk-speaking-300x200.png');
  await page.getByRole('button', { name: 'Copy Pace’s reply', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Copied.');
  await page.getByRole('button', { name: 'Enable spoken replies', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mute spoken replies', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__companionFixture.emit('voice.stopped', {}));
  await expect(page.getByRole('img', { name: 'Pace is idle' })).toBeVisible();
  for (const button of await page.locator('.talk-cloud button').all()) await expectInsideWindow(button, 300, 200);
});

test('compact Talk keeps model setup and permission recovery visible', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 200 }); await companionFixture(page, { noModel: true, nativeEvents: true }); await page.goto('/?window=bubble');
  await expect(page.getByRole('button', { name: 'Set up a local model' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__tauriEventState.listeners)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.state', { phase: 'error', error: 'Accessibility permission is required to insert into this app.' }));
  await expectInsideWindow(page.getByRole('button', { name: 'Open Accessibility settings' }), 300, 200);
  await expectInsideWindow(page.locator('.cloud-compose'), 300, 200);
  await saveCompanionScreenshot(page, 'talk-permission-300x200.png');
});


test('autocomplete preview, stale target and permission recovery fit the 300×180 native minimum', async ({ browser }) => {
  for (const mode of ['ready', 'stale', 'permission']) {
    const page = await browser.newPage({ viewport: { width: 300, height: 180 } });
    await companionFixture(page, { staleCompletion: mode === 'stale', completionError: mode === 'permission' ? 'Accessibility permission is required to read text at your cursor.' : undefined });
    await page.goto('/?window=command');
    const accept = page.getByRole('button', { name: 'Accept', exact: true });
    if (mode === 'permission') {
      await expect(page.getByRole('alert')).toContainText('Accessibility permission');
      await expectInsideWindow(page.getByRole('button', { name: 'Open Accessibility settings', exact: true }), 300, 180);
    } else {
      await expect(page.getByRole('textbox', { name: 'Suggested continuation' })).toHaveValue(' with one small step.');
      if (mode === 'stale') { await accept.click(); await expect(page.getByRole('alert')).toContainText('cursor changed'); }
      await expectInsideWindow(page.getByRole('textbox', { name: 'Suggested continuation' }), 300, 180);
      await expectInsideWindow(page.getByRole('button', { name: 'Copy suggestion' }), 300, 180);
    }
    await expectInsideWindow(page.locator('.completion-cloud'), 300, 180); await expectInsideWindow(accept, 300, 180);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(180);
    await saveCompanionScreenshot(page, `autocomplete-${mode}-300x180.png`);
    await page.close();
  }
});


test('hover metadata belongs only to its open arc and is cleared before a fresh target check', async ({ page }) => {
  await page.setViewportSize({ width: 224, height: 224 }); await companionFixture(page, { holdWritingChecks: true }); await page.goto('/?window=pet');
  const pet = page.getByRole('button', { name: 'Pet Pace; drag to move; right-click for menu', exact: true });
  const write = page.getByRole('button', { name: 'Write for me', exact: true });
  await pet.hover(); await expect(page.locator('.pet-controls')).toBeVisible();
  await page.mouse.move(0, 0); await expect(page.locator('.pet-controls')).toBeHidden();
  await pet.hover();
  await expect.poll(() => page.evaluate(() => (window as any).__companionFixture.calls.filter((call: any) => call.method === 'completion.available').length)).toBe(2);
  await page.evaluate(() => (window as any).__companionFixture.settleWriting(1, { available: true, app: 'Current app' }));
  await expect(write).toHaveAttribute('title', /Current app/);
  await page.evaluate(() => (window as any).__companionFixture.settleWriting(0, { available: false, reason: 'Old target was not editable.' }));
  await expect(write).toBeVisible(); await expect(write).toHaveAttribute('title', /Current app/);
  await page.mouse.move(0, 0); await expect(page.locator('.pet-controls')).toBeHidden(); await pet.hover();
  await expect(write).toHaveAttribute('title', /Write at your cursor/);
  await page.mouse.move(0, 0); await expect(page.locator('.pet-controls')).toBeHidden();
  await page.evaluate(() => (window as any).__companionFixture.settleWriting(2, { available: false, reason: 'A closed hover cannot hide the next target.' }));
  await pet.hover(); await expect(write).toBeVisible(); await expect(write).toHaveAttribute('title', /Write at your cursor/);
});

test('definite missing speech packs route Dictate and Talk mic to setup before capture; installed fallback and Stop still work', async ({ browser }) => {
  for (const scenario of [
    { route: 'pet', language: 'ja', moonshine: false, whisper: false, setup: true },
    { route: 'bubble', language: 'en', moonshine: false, whisper: false, setup: true },
    { route: 'pet', language: 'auto', moonshine: true, whisper: false, setup: true },
    { route: 'pet', language: 'ja-JP', moonshine: true, whisper: false, setup: false },
    { route: 'bubble', language: 'zh', moonshine: false, whisper: true, setup: false },
    { route: 'pet', language: 'en', moonshine: false, whisper: false, setup: false, stopping: true },
  ]) {
    const page = await browser.newPage({ viewport: { width: 300, height: 200 } });
    const language = scenario.language.split('-')[0];
    await companionFixture(page, { nativeEvents: true, dictationLanguage: scenario.language, speechModels: [{ id: `moonshine-tiny-${language}`, installed: scenario.moonshine }, { id: 'whisper-turbo', installed: scenario.whisper }] });
    await page.goto(`/?window=${scenario.route}`);
    if (scenario.stopping) {
      await expect.poll(() => page.evaluate(() => (window as any).__tauriEventState.listeners)).toBeGreaterThan(0);
      await page.evaluate(() => (window as any).__companionFixture.emit('dictation.state', { phase: 'recording' }));
    }
    if (scenario.route === 'pet') await page.getByRole('button', { name: 'Pet Pace; drag to move; right-click for menu', exact: true }).hover();
    await page.getByRole('button', { name: scenario.stopping ? 'Stop dictation' : scenario.route === 'pet' ? 'Dictate into your app' : 'Dictate a message', exact: true }).click();
    const calls = await page.evaluate(() => (window as any).__companionFixture.calls);
    expect(calls.some((call: any) => call.method === 'window.main' && call.params.page === 'models')).toBe(scenario.setup);
    expect(calls.some((call: any) => ['audio.start', 'dictation.toggle'].includes(call.method))).toBe(!scenario.setup);
    await page.close();
  }
});

test('native missing-pack errors retain a direct Local models recovery', async ({ page }) => {
  await page.setViewportSize({ width: 224, height: 224 });
  await companionFixture(page, { dictationError: 'Install the dictation language pack or Whisper in Local models before dictating.' }); await page.goto('/?window=pet');
  await page.getByRole('button', { name: 'Pet Pace; drag to move; right-click for menu', exact: true }).hover();
  await page.getByRole('button', { name: 'Dictate into your app', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Install the dictation language pack');
  await page.getByRole('button', { name: 'Open Local models', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__companionFixture.calls.some((call: any) => call.method === 'window.main' && call.params.page === 'models'))).toBe(true);
});
