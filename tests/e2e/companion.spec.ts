import { test, expect, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

type Options = { soundEnabled?: boolean; petSize?: number; phase?: string; text?: string; error?: string; toggleError?: string; holdToggle?: boolean; holdCurrent?: boolean; savedAudio?: boolean };
async function fixture(page: Page, options: Options = {}) {
  await page.addInitScript((config: Options) => {
    const state = { settings: { onboardingCompleted: true, soundEnabled: config.soundEnabled || false, activePack: 'pace', petSize: config.petSize || 160, dictationShortcut: 'Alt+Shift+D' }, models: [], meetings: [], packs: [{ id: 'pace', name: 'Pace' }], memory: { enabled: false, applications: [] }, extensions: [], pet: { visible: true, action: 'idle' } };
    let current = { phase: config.phase || 'idle', text: config.text, error: config.error, savedAudio: config.savedAudio };
    const f: any = { calls: [], copied: [], currentReads: 0 };
    (window as any).__companionFixture = f;
    const callbacks = new Map<number, (event: any) => void>(); const handlers = new Map<number, number>(); let serial = 0;
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback(callback: (event: any) => void) { const id = ++serial; callbacks.set(id, callback); return id; },
      unregisterCallback(id: number) { callbacks.delete(id); },
      async invoke(command: string, args: any) {
        if (command === 'plugin:event|listen') { const id = ++serial; handlers.set(id, args.handler); return id; }
        if (command === 'plugin:event|unlisten') { handlers.delete(args.eventId); return; }
        if (command === 'plugin:clipboard-manager|write_text') { f.copied.push(args.text); return; }
        throw new Error(`Unexpected native fixture call ${command}`);
      },
    };
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    f.emit = (event: string, data: any) => {
      if (event === 'dictation.state') current = structuredClone(data);
      for (const callback of handlers.values()) callbacks.get(callback)?.({ payload: { event, data } });
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => f.copied.push(text) } });
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string, params: any = {}) => {
      f.calls.push({ method, params });
      if (method === 'chat.context.current') return { meetingId: null };
      if (method === 'voicechat.current') return { sessionId: null, phase: 'idle', active: false };
      if (method === 'app.state') return structuredClone(state);
      if (method === 'apps.list') return [];
      if (method === 'permissions.status') return {};
      if (method === 'dictation.current') {
        f.currentReads++;
        const snapshot = structuredClone(current);
        if (config.holdCurrent && f.currentReads === 1) return new Promise(resolve => { f.resolveCurrent = () => resolve(snapshot); });
        return snapshot;
      }
      if (method === 'window.dictationSize') return {};
      if (method === 'dictation.cancel') { current = { phase: 'idle', text: undefined, error: undefined, savedAudio: false }; f.emit('dictation.state', current); return { cancelled: true }; }
      if (method === 'dictation.retry') { current = { phase: 'draft', text: 'Recovered from saved audio.', error: undefined, savedAudio: false }; f.emit('dictation.state', current); return structuredClone(current); }
      if (method === 'dictation.toggle') {
        if (config.toggleError) throw new Error(config.toggleError);
        if (config.holdToggle) await new Promise<void>(resolve => { f.resolveToggle = resolve; });
        current = current.phase === 'recording' ? { phase: 'draft', text: 'Words kept for review.', error: undefined, savedAudio: false } : { phase: 'recording', text: undefined, error: undefined, savedAudio: false };
        f.emit('dictation.state', current); return structuredClone(current);
      }
      if (method === 'pet.action') { state.pet.action = params.action; return state.pet; }
      if (method === 'window.close' || method === 'window.chat' || method === 'window.main' || method === 'window.meeting' || method === 'pet.toggle' || method === 'permissions.request') return {};
      throw new Error(`Unexpected companion request ${method}`);
    };
  }, options);
  await page.emulateMedia({ reducedMotion: 'reduce' });
}
async function inside(element: Locator, width: number, height: number) {
  const box = await element.boundingBox(); expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(Math.round(box!.x + box!.width)).toBeLessThanOrEqual(width); expect(Math.round(box!.y + box!.height)).toBeLessThanOrEqual(height);
}
async function screenshot(page: Page, name: string) {
  const directory = path.resolve('.impeccable/review/companion'); await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), omitBackground: true, animations: 'disabled' });
}
async function calls(page: Page) { return page.evaluate(() => (window as any).__companionFixture.calls as Array<{ method: string; params: any }>); }
const petName = 'Pet Pace; drag to move; right-click for menu';

test('four compact action icons fit each native pet size without writing', async ({ browser }) => {
  for (const size of [128, 160, 208]) {
    const width = size + 64; const page = await browser.newPage({ viewport: { width, height: width } });
    await fixture(page, { petSize: size }); await page.goto('/?window=pet');
    const pet = page.getByRole('button', { name: petName }); await pet.hover();
    const controls = page.locator('.pet-controls'); await expect(controls.getByRole('button')).toHaveCount(4);
    await expect(page.getByRole('button', { name: /Talk|Write for me/ })).toHaveCount(0);
    const slots = await controls.getByRole('button').evaluateAll(buttons => buttons.map(button => ({ y: button.getBoundingClientRect().y, words: button.textContent })));
    expect(slots.map(slot => slot.words)).toEqual(['', '', '', '']); expect(slots[0].y).toBe(slots[3].y); expect(slots[1].y).toBe(slots[2].y); expect(slots[1].y).toBeLessThan(slots[0].y);
    for (const button of await controls.getByRole('button').all()) await inside(button, width, width);
    await inside(pet, width, width); await screenshot(page, `pet-four-icons-${width}x${width}.png`);
    expect((await calls(page)).some(call => /^(chat|writing|completion)\./.test(call.method) && call.method !== 'chat.context.current')).toBe(false);
    await page.close();
  }
});

test('pet keyboard navigation exposes dictation, chat, meetings and settings', async ({ page }) => {
  await page.setViewportSize({ width: 224, height: 224 }); await fixture(page); await page.goto('/?window=pet');
  const pet = page.getByRole('button', { name: petName }); await page.keyboard.press('Tab'); await pet.focus(); await pet.press('ArrowUp');
  const dictate = page.getByRole('button', { name: 'Dictate into your app', exact: true }); await expect(dictate).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText('Type into your app · Alt+Shift+D');
  await dictate.press('ArrowRight'); await expect(page.getByRole('button', { name: 'Chat with Pace', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect(page.getByRole('button', { name: 'Meeting buddy' })).toBeFocused();
  await page.keyboard.press('End'); await expect(page.getByRole('button', { name: 'Settings and shortcuts' })).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect(dictate).toBeFocused();
  await page.getByRole('button', { name: 'Chat with Pace', exact: true }).click(); await page.getByRole('button', { name: 'Meeting buddy' }).click(); await page.getByRole('button', { name: 'Settings and shortcuts' }).click();
  expect(await calls(page)).toContainEqual({ method: 'window.chat', params: {} });
  expect(await calls(page)).toContainEqual({ method: 'window.meeting', params: {} });
  expect(await calls(page)).toContainEqual({ method: 'window.main', params: { page: 'settings', section: 'shortcuts' } });
});

test('dictation widget stays compact while listening and expands only to recover words', async ({ page }) => {
  await page.setViewportSize({ width: 240, height: 76 }); await fixture(page); await page.goto('/?window=bubble');
  await expect(page.getByRole('button', { name: 'Start dictation', exact: true })).toBeEnabled();
  expect((await calls(page)).map(call => call.method)).not.toContain('dictation.toggle');
  await expect(page.getByRole('textbox', { name: 'Dictation text' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Send|Speak|Talk/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Listening…'); await expect(page.getByRole('img', { name: 'Pace is dictate' })).toBeVisible();
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.level', { rms: .32, peak: .7 }));
  await expect(page.getByRole('meter', { name: 'Microphone level' })).toHaveAttribute('value', '0.32');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  for (const button of await page.locator('.dictation-cloud button').all()) await inside(button, 240, 76);
  await screenshot(page, 'dictation-listening-240x76.png');
  await page.setViewportSize({ width: 320, height: 260 });
  await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Dictation text' })).toHaveValue('Words kept for review.');
  await expect(page.getByRole('meter')).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy dictation', exact: true }).click(); await expect(page.getByRole('status')).toHaveText('Copied.');
  expect(await page.evaluate(() => (window as any).__companionFixture.copied)).toEqual(['Words kept for review.']);
  for (const element of await page.locator('.dictation-cloud button, .dictation-cloud textarea').all()) await inside(element, 320, 260);
  expect((await calls(page)).filter(call => call.method === 'dictation.toggle')).toHaveLength(2);
  expect((await calls(page)).some(call => /^(chat|audio|completion|writing)\./.test(call.method))).toBe(false);
  await screenshot(page, 'dictation-draft-320x260.png');
  expect(await calls(page)).toContainEqual({ method: 'window.dictationSize', params: { mode: 'compact' } });
  expect(await calls(page)).toContainEqual({ method: 'window.dictationSize', params: { mode: 'draft' } });
});

test('recognized draft remains copyable without Accessibility and reviewed edits survive reopen', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 200 });
  await fixture(page, { phase: 'draft', text: 'Recognized words without insertion.', error: 'Accessibility is unavailable; copy these words into your app.' }); await page.goto('/?window=bubble');
  await expect(page.getByRole('alert')).toContainText('Accessibility');
  const input = page.getByRole('textbox', { name: 'Dictation text' }); await expect(input).toHaveValue('Recognized words without insertion.');
  await input.fill('My reviewed words.'); await page.reload(); await expect(input).toHaveValue('My reviewed words.');
  await page.getByRole('button', { name: 'Copy dictation' }).click(); await expect(page.getByRole('status')).toHaveText('Copied.');
  expect(await page.evaluate(() => (window as any).__companionFixture.copied)).toEqual(['My reviewed words.']);
  expect((await calls(page)).some(call => call.method === 'permissions.request')).toBe(false);
  await inside(page.getByRole('button', { name: 'Start dictation' }), 300, 200);
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.state', { phase: 'recording', text: 'Older cached words.' }));
  await expect(input).toHaveCount(0);
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.state', { phase: 'transcribing', text: 'Older cached words.' }));
  await expect(input).toHaveCount(0);
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.state', { phase: 'draft', text: 'Fresh recognized words.' }));
  await expect(input).toHaveValue('Fresh recognized words.');
});

test('real state events win over an older cached snapshot and transcribing blocks another recording', async ({ page }) => {
  await fixture(page, { holdCurrent: true, phase: 'draft', text: 'Old snapshot.' }); await page.goto('/?window=bubble');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__companionFixture.resolveCurrent))).toBe(true);
  await page.evaluate(() => { const f = (window as any).__companionFixture; f.emit('dictation.state', { phase: 'recording' }); f.resolveCurrent(); });
  await expect(page.getByRole('button', { name: 'Stop dictation' })).toBeEnabled();
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.state', { phase: 'transcribing' }));
  await expect(page.getByRole('button', { name: 'Transcribing…' })).toBeDisabled();
  await expect(page.getByRole('img', { name: 'Pace is think' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Dictation text' })).toHaveCount(0);
  expect((await calls(page)).some(call => call.method === 'dictation.toggle')).toBe(false);
});

test('pending toggle cannot duplicate and a microphone failure preserves its draft', async ({ browser }) => {
  const page = await browser.newPage(); await fixture(page, { holdToggle: true }); await page.goto('/?window=bubble');
  const start = page.getByRole('button', { name: 'Start dictation', exact: true }); await expect(start).toBeEnabled(); await start.click();
  await expect(start).toBeDisabled(); await start.dispatchEvent('click');
  expect((await calls(page)).filter(call => call.method === 'dictation.toggle')).toHaveLength(1);
  await page.evaluate(() => (window as any).__companionFixture.resolveToggle()); await expect(page.getByRole('button', { name: 'Stop dictation' })).toBeVisible(); await page.close();
  const failed = await browser.newPage({ viewport: { width: 300, height: 200 } }); await fixture(failed, { phase: 'draft', text: 'Keep this draft.', toggleError: 'Microphone access was denied.' }); await failed.goto('/?window=bubble');
  await failed.getByRole('button', { name: 'Start dictation' }).click(); await expect(failed.getByRole('alert')).toContainText('Microphone');
  await expect(failed.getByRole('textbox', { name: 'Dictation text' })).toHaveValue('Keep this draft.');
  await inside(failed.getByRole('button', { name: 'Allow microphone' }), 300, 200); await inside(failed.getByRole('button', { name: 'Start dictation' }), 300, 200); await failed.close();
});

test('passive routes preserve drafts and only the explicit chat window shows a composer', async ({ page }) => {
  await fixture(page); await page.addInitScript(() => { for (const [key, value] of Object.entries({ 'pace.chat-draft': 'Existing chat draft.', 'pace.pet-draft': 'Existing pet chat draft.', 'pace.conversation': 'existing-conversation' })) sessionStorage.setItem(key, value); });
  for (const route of ['/#chat', '/#writing', '/?window=bubble', '/?window=command']) {
    await page.goto(route);
    await expect(page.getByRole('textbox', { name: /Message Pace|Ask Pace$/, exact: true })).toHaveCount(route.includes('window=command') ? 1 : 0);
    await expect(page.getByRole('button', { name: 'Chat with Pace', exact: true })).toHaveCount(route.includes('#chat') ? 1 : 0);
    expect((await calls(page)).some(call => /^(chat|writing|completion)\./.test(call.method) && call.method !== 'chat.context.current')).toBe(false);
    expect(await page.evaluate(() => [sessionStorage.getItem('pace.chat-draft'), sessionStorage.getItem('pace.pet-draft'), sessionStorage.getItem('pace.conversation')])).toEqual(['Existing chat draft.', 'Existing pet chat draft.', 'existing-conversation']);
  }
});


test('empty dictation reports no speech and offers a fresh explicit start without a blank draft', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 200 });
  await fixture(page, { phase: 'error', text: '', error: 'No speech was caught. Try the dictation shortcut again.' });
  await page.goto('/?window=bubble');
  await expect(page.getByRole('status')).toHaveText('Needs attention');
  await expect(page.getByRole('alert')).toHaveText('No speech was caught. Try the dictation shortcut again.');
  await expect(page.getByRole('textbox', { name: 'Dictation text' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Copy dictation|Review words/ })).toHaveCount(0);
  const start = page.getByRole('button', { name: 'Start dictation', exact: true });
  await expect(start).toBeEnabled();
  expect((await calls(page)).some(call => /^(dictation\.(toggle|retry)|permissions\.request)$/.test(call.method))).toBe(false);
  await start.click();
  await expect(page.getByRole('status')).toHaveText('Listening…');
  await expect(page.getByRole('button', { name: 'Stop dictation', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await calls(page)).filter(call => call.method === 'dictation.toggle')).toHaveLength(1);
  expect((await calls(page)).some(call => call.method === 'permissions.request')).toBe(false);
});

test('failed ASR offers an explicit saved-audio retry without starting another recording', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 200 });
  await fixture(page, { phase: 'error', error: 'The speech model could not finish. Your audio is saved.', savedAudio: true }); await page.goto('/?window=bubble');
  const retry = page.getByRole('button', { name: 'Retry saved audio', exact: true }); await expect(retry).toBeEnabled();
  expect((await calls(page)).some(call => call.method === 'dictation.retry')).toBe(false);
  await retry.click(); await expect(page.getByRole('textbox', { name: 'Dictation text' })).toHaveValue('Recovered from saved audio.');
  expect((await calls(page)).filter(call => call.method === 'dictation.retry')).toHaveLength(1);
  expect((await calls(page)).some(call => call.method === 'dictation.toggle')).toBe(false);
  await expect(page.getByRole('button', { name: 'Copy dictation' })).toBeEnabled();
});

test('starting is not reported as listening and cancellation discards only the active capture', async ({ page }) => {
  await page.setViewportSize({ width: 240, height: 76 });
  await fixture(page, { phase: 'starting' }); await page.goto('/?window=bubble');
  await expect(page.getByRole('status')).toHaveText('Opening mic…');
  await expect(page.getByRole('meter')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel dictation' }).click();
  await expect(page.getByRole('status')).toHaveText('Ready to dictate');
  expect((await calls(page)).filter(call => call.method === 'dictation.cancel')).toHaveLength(1);
  expect((await calls(page)).some(call => call.method === 'dictation.toggle')).toBe(false);
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.state', { phase: 'recording' }));
  const meter = page.getByRole('meter', { name: 'Microphone level' });
  await expect(meter).toHaveAttribute('value', '0');
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.level', { rms: .4 }));
  await expect(meter).toHaveAttribute('value', '0.4');
  await expect(meter).toHaveAttribute('value', '0');
});


test('pet earcons stay quiet during a voice conversation and return after End', async ({ page }) => {
  await fixture(page, { soundEnabled: true });
  await page.addInitScript(() => {
    (window as any).__earconPlays = 0;
    (window as any).Audio = class {
      volume = 1;
      addEventListener() {}
      pause() {}
      play() { (window as any).__earconPlays++; return Promise.resolve(); }
    };
  });
  await page.goto('/?window=pet');
  const pet = page.getByRole('button', { name: petName });
  await pet.focus();
  await page.evaluate(() => (window as any).__companionFixture.emit('voicechat.state', { sessionId: 'voice-test', phase: 'listening', active: true }));
  await pet.press('Enter');
  expect(await page.evaluate(() => (window as any).__earconPlays)).toBe(0);
  await page.evaluate(() => (window as any).__companionFixture.emit('voicechat.state', { sessionId: 'voice-test', phase: 'idle', active: false }));
  await pet.press('Enter');
  expect(await page.evaluate(() => (window as any).__earconPlays)).toBe(1);
});
