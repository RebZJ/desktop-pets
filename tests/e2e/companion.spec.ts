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
        if (command === 'plugin:clipboard-manager|write_text') { if (f.holdCopy) await new Promise((_, reject) => { f.rejectCopy = reject; }); f.copied.push(args.text); return; }
        throw new Error(`Unexpected native fixture call ${command}`);
      },
    };
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    f.emit = (event: string, data: any) => {
      if (event === 'dictation.state') current = structuredClone(data);
      for (const callback of handlers.values()) callbacks.get(callback)?.({ payload: { event, data } });
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { if (f.holdCopy) await new Promise((_, reject) => { f.rejectCopy = reject; }); f.copied.push(text); } } });
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
      if (method === 'dictation.retry') { if (f.holdRetry) await new Promise((_, reject) => { f.rejectRetry = reject; }); current = { phase: 'draft', text: 'Recovered from saved audio.', error: undefined, savedAudio: false }; f.emit('dictation.state', current); return structuredClone(current); }
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

test('selector needs hover or keyboard focus, keeps its leave guard and pet clicks still pet', async ({ page }) => {
  await page.setViewportSize({ width: 224, height: 224 }); await fixture(page); await page.goto('/?window=pet');
  const chat = page.getByRole('button', { name: 'Chat with Pace', exact: true });
  await expect(chat).toBeHidden();
  await page.mouse.move(5, 5); await expect(chat).toBeHidden();
  await page.getByRole('button', { name: petName }).dispatchEvent('click');
  await expect(chat).toBeHidden(); expect((await calls(page)).filter(call => call.method === 'pet.action')).toHaveLength(1);
  await page.getByRole('button', { name: petName }).hover(); await expect(chat).toBeVisible();
  await page.mouse.move(1, 1); await expect(chat).toBeVisible();
  await chat.hover(); await expect(chat).toBeVisible();
  await page.mouse.move(1, 1); await expect(chat).toBeHidden();
  await page.getByRole('button', { name: petName }).focus(); await expect(chat).toBeVisible();
  expect(await page.locator('.pet-controls').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
});

test('dictation is a tiny active-only indicator and completion leaves saved drafts untouched', async ({ page }) => {
  await page.setViewportSize({ width: 160, height: 48 }); await fixture(page, { phase: 'recording' });
  await page.addInitScript(() => { sessionStorage.setItem('pace.dictation-draft', 'My reviewed draft.'); sessionStorage.setItem('pace.dictation-source', 'Original recognized words.'); });
  await page.goto('/?window=bubble');
  await expect(page.getByRole('status')).toHaveText('Listening…');
  await expect(page.getByRole('textbox')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0);
  for (const button of await page.locator('.dictation-cloud button').all()) await inside(button, 160, 48);
  await expect(page.locator('.dictation-pixels .lit')).toHaveCount(0);
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.level', { rms: .01 }));
  await expect(page.getByRole('meter')).toHaveAttribute('value', '0.01');
  await expect(page.locator('.dictation-pixels .lit').first()).toBeVisible();
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.level', { rms: 0 }));
  await expect(page.getByRole('meter')).toHaveAttribute('value', '0'); await expect(page.locator('.dictation-pixels .lit')).toHaveCount(0);
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.level', { rms: .32 }));
  await expect(page.getByRole('meter')).toHaveAttribute('value', '0.32'); await expect(page.locator('.dictation-pixels .lit')).toHaveCount(5);
  await screenshot(page, 'dictation-indicator-160x48.png');
  await expect(page.getByRole('meter')).toHaveAttribute('value', '0'); await expect(page.locator('.dictation-pixels .lit')).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Dictation with Pace' })).toHaveCount(0);
  expect(await page.evaluate(() => [sessionStorage.getItem('pace.dictation-draft'), sessionStorage.getItem('pace.dictation-source')])).toEqual(['My reviewed draft.', 'Original recognized words.']);
  expect((await calls(page)).filter(call => call.method === 'dictation.toggle')).toHaveLength(1);
  expect((await calls(page)).some(call => /permissions|window.dictationSize/.test(call.method))).toBe(false);
});

test('recognized words recover above Pace with explicit Copy and preserve reviewed drafts', async ({ page }) => {
  await page.setViewportSize({ width: 224, height: 224 });
  await fixture(page, { phase: 'draft', text: 'Fresh recognized words.', error: 'Accessibility is unavailable; copy these words into your app.' });
  await page.addInitScript(() => { sessionStorage.setItem('pace.dictation-draft', 'My reviewed words.'); sessionStorage.setItem('pace.dictation-source', 'Older source.'); });
  await page.goto('/?window=pet');
  const notice = page.getByRole('status', { name: 'Dictation recovery' });
  await expect(notice).toContainText('Couldn’t type here.');
  const box = await notice.boundingBox(); expect(box!.width).toBeLessThanOrEqual(160); expect(box!.height).toBeLessThanOrEqual(48);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__companionFixture.copied)).toEqual([]);
  await page.keyboard.press('Tab'); await page.getByRole('button', { name: petName }).focus();
  await page.getByRole('button', { name: petName }).press('ArrowUp');
  await expect(page.getByRole('button', { name: 'Dismiss dictation notice' })).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect(page.getByRole('button', { name: 'Copy words', exact: true })).toBeFocused();
  await page.keyboard.press('Enter'); await expect(notice).toContainText('Copied.');
  expect(await page.evaluate(() => (window as any).__companionFixture.copied)).toEqual(['Fresh recognized words.']);
  expect(await page.evaluate(() => sessionStorage.getItem('pace.dictation-draft'))).toBe('My reviewed words.');
  await screenshot(page, 'dictation-recovery-pet-224x224.png');
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.state', { phase: 'recording' }));
  await expect(notice).toHaveCount(0);
});

test('uncertain insertion asks to check existing text and never copies automatically', async ({ page }) => {
  await fixture(page, { phase: 'draft', text: 'Recognized words.', error: 'The text was inserted, but I could not confirm the caret. Check before copying.' });
  await page.goto('/?window=pet');
  const notice = page.getByRole('status', { name: 'Dictation recovery' }); await expect(notice).toContainText('Check your text.');
  await expect(notice).not.toContainText('Couldn’t type here.'); await expect(page.getByRole('button', { name: 'Copy words', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__companionFixture.copied)).toEqual([]);
  expect((await calls(page)).some(call => /dictation\.(retry|toggle)|writing\.apply/.test(call.method))).toBe(false);
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.state', { phase: 'draft', text: 'Recognized words.', error: 'Accessibility is unavailable; copy these words into your app.' }));
  await expect(notice).toContainText('Couldn’t type here.');
});

test('new recording beats stale snapshots and thinking stays tiny without enabling another capture', async ({ page }) => {
  await page.setViewportSize({ width: 160, height: 48 }); await fixture(page, { holdCurrent: true, phase: 'draft', text: 'Old snapshot.' }); await page.goto('/?window=bubble');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__companionFixture.resolveCurrent))).toBe(true);
  await page.evaluate(() => { const f = (window as any).__companionFixture; f.emit('dictation.state', { phase: 'recording' }); f.resolveCurrent(); });
  await expect(page.getByRole('button', { name: 'Stop dictation' })).toBeEnabled();
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.state', { phase: 'transcribing' }));
  await expect(page.getByRole('status')).toHaveText('Thinking…');
  await expect(page.getByRole('button', { name: 'Cancel dictation' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Stop dictation' })).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0); await expect(page.getByRole('meter')).toHaveCount(0);
  expect((await calls(page)).some(call => call.method === 'dictation.toggle')).toBe(false);
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.state', { phase: 'error', error: 'A very long error. '.repeat(100) }));
  await expect(page.getByRole('main', { name: 'Dictation with Pace' })).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('pending pet dictation cannot duplicate and a microphone error leaves saved words intact', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 224, height: 224 } });
  await fixture(page, { holdToggle: true }); await page.goto('/?window=pet');
  await page.getByRole('button', { name: petName }).hover();
  const start = page.getByRole('button', { name: 'Dictate into your app', exact: true }); await start.click(); await expect(start).toBeDisabled(); await start.dispatchEvent('click');
  expect((await calls(page)).filter(call => call.method === 'dictation.toggle')).toHaveLength(1);
  await page.evaluate(() => (window as any).__companionFixture.resolveToggle()); await expect(page.getByRole('button', { name: 'Stop dictation' })).toBeEnabled(); await page.close();
  const failed = await browser.newPage({ viewport: { width: 224, height: 224 } });
  await fixture(failed, { toggleError: 'Microphone access was denied.' });
  await failed.addInitScript(() => sessionStorage.setItem('pace.dictation-draft', 'Keep my reviewed words.')); await failed.goto('/?window=pet');
  await failed.getByRole('button', { name: petName }).hover(); await failed.getByRole('button', { name: 'Dictate into your app', exact: true }).click();
  await expect(failed.getByRole('status', { name: 'Dictation recovery' })).toContainText('Microphone unavailable.');
  expect(await failed.evaluate(() => sessionStorage.getItem('pace.dictation-draft'))).toBe('Keep my reviewed words.');
  expect((await calls(failed)).some(call => call.method === 'permissions.request')).toBe(false); await failed.close();
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


test('empty dictation gives a brief pet notice with no blank draft or automatic retry', async ({ page }) => {
  await page.setViewportSize({ width: 224, height: 224 });
  await fixture(page, { phase: 'error', text: '', error: 'No speech was caught. Try the dictation shortcut again.' }); await page.goto('/?window=pet');
  const notice = page.getByRole('status', { name: 'Dictation recovery' }); await expect(notice).toContainText('No words caught.');
  await expect(page.getByRole('textbox')).toHaveCount(0); await expect(page.getByRole('button', { name: /Copy words|Retry audio|Review words/ })).toHaveCount(0);
  expect((await calls(page)).some(call => /^(dictation\.(toggle|retry)|permissions\.request)$/.test(call.method))).toBe(false);
  await page.getByRole('button', { name: 'Dismiss dictation notice' }).click();
  await page.getByRole('button', { name: petName }).hover();
  await page.getByRole('button', { name: 'Dictate into your app', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop dictation', exact: true })).toBeEnabled(); await expect(notice).toHaveCount(0);
});

test('failed ASR offers explicit pet audio retry and new activity invalidates old notices', async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 224, height: 224 });
  await fixture(page, { phase: 'error', error: 'The speech model could not finish. Your audio is saved.', savedAudio: true }); await page.goto('/?window=pet');
  const notice = page.getByRole('status', { name: 'Dictation recovery' }); await expect(notice).toContainText('Audio saved.');
  expect((await calls(page)).some(call => call.method === 'dictation.retry')).toBe(false);
  await page.getByRole('button', { name: 'Retry audio' }).click(); await expect(notice).toContainText('Words ready.');
  await expect(page.getByRole('button', { name: 'Copy words' })).toBeEnabled();
  expect((await calls(page)).filter(call => call.method === 'dictation.retry')).toHaveLength(1);
  await page.evaluate(() => { const f = (window as any).__companionFixture; f.emit('dictation.state', { phase: 'error', error: 'No speech was caught.' }); f.emit('dictation.state', { phase: 'starting' }); });
  await expect(notice).toHaveCount(0);
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.state', { phase: 'draft', text: 'Newer result.' }));
  await expect(notice).toContainText('Words ready.');
  await page.clock.fastForward(6000); await expect(notice).toContainText('Words ready.');
  await page.evaluate(() => (window as any).__companionFixture.emit('pet.visibility', { visible: false }));
  await expect(notice).toHaveCount(0);
});

test('late Copy and Retry errors cannot replace a new dictation notice', async ({ page }) => {
  await fixture(page, { phase: 'error', text: 'Words to copy.', savedAudio: true }); await page.goto('/?window=pet');
  await page.evaluate(() => { const f = (window as any).__companionFixture; f.holdCopy = true; f.holdRetry = true; });
  await page.getByRole('button', { name: 'Copy words', exact: true }).click();
  await page.getByRole('button', { name: 'Retry audio', exact: true }).click();
  await page.evaluate(() => { const f = (window as any).__companionFixture; f.emit('dictation.state', { phase: 'recording' }); f.rejectCopy(Error('Old clipboard failure')); f.rejectRetry(Error('Old retry failure')); });
  await expect(page.getByRole('status', { name: 'Dictation recovery' })).toHaveCount(0);
  await page.evaluate(() => (window as any).__companionFixture.emit('dictation.state', { phase: 'draft', text: 'A fresh result.' }));
  await expect(page.getByRole('status', { name: 'Dictation recovery' })).toContainText('Words ready.');
});

test('starting and recording can cancel without showing a draft or permission prompt', async ({ page }) => {
  await page.setViewportSize({ width: 160, height: 48 }); await fixture(page, { phase: 'starting' }); await page.goto('/?window=bubble');
  await expect(page.getByRole('status')).toHaveText('Opening mic…'); await expect(page.getByRole('meter')).toHaveCount(0);
  expect(await page.locator('.dictation-work i').first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.getByRole('button', { name: 'Cancel dictation' }).click();
  await expect(page.getByRole('main', { name: 'Dictation with Pace' })).toHaveCount(0);
  expect((await calls(page)).filter(call => call.method === 'dictation.cancel')).toHaveLength(1);
  expect((await calls(page)).some(call => call.method === 'permissions.request')).toBe(false);
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
