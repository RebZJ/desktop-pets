import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { initialState, type Settings } from '../../src/api';

type BridgeCall = { method: string; params: Record<string, unknown> };
type FixtureOptions = { completed?: boolean; installed?: string[]; failState?: boolean; saveFailures?: number; delaySave?: boolean; settings?: Partial<Settings>; nativeEvents?: boolean; busyStopOnce?: boolean };

async function onboardingFixture(page: Page, options: FixtureOptions = {}) {
  await page.addInitScript(({ snapshot, options }) => {
    const state = structuredClone(snapshot);
    Object.assign(state.settings, { soundEnabled: false, onboardingCompleted: Boolean(options.completed) }, options.settings);
    state.models.forEach(model => { if (options.installed?.includes(model.id)) { model.installed = true; model.status = 'installed'; } });
    const calls: BridgeCall[] = [];
    const permissions: Record<string, string> = { accessibility: 'denied', microphone: 'denied', screenRecording: 'denied' };
    let failures = options.saveFailures || 0;
    let dictating = false;
    let busyStopOnce = Boolean(options.busyStopOnce);
    const fixture: any = { state, calls };
    (window as any).__onboardingFixture = fixture;
    window.__DESKTOP_PETS_BRIDGE__ = async (method, params) => {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'app.state') {
        if (options.failState) throw new Error('Synthetic startup failure.');
        return structuredClone(state);
      }
      if (method === 'settings.update') {
        if (failures-- > 0) throw new Error('Synthetic setting write failed.');
        if (options.delaySave) await new Promise<void>(resolve => { (window as any).__finishOnboardingSave = resolve; });
        Object.assign(state.settings, params.patch);
        return structuredClone(state.settings);
      }
      if (method === 'models.install') {
        const model = state.models.find(item => item.id === params.id)!;
        model.installed = true; model.status = 'installed';
        return structuredClone(model);
      }
      if (method === 'models.status') return structuredClone(state.models);
      if (method === 'permissions.status') return structuredClone(permissions);
      if (method === 'permissions.request') { permissions[String(params.kind)] = 'granted'; return structuredClone(permissions); }
      if (method === 'pet.action') { state.pet.action = String(params.action); return structuredClone(state.pet); }
      if (method === 'window.talk') return { opened: true };
      if (method === 'voice.speak') return { played: true };
      if (method === 'dictation.toggle') {
        if (dictating && busyStopOnce) { busyStopOnce = false; return { busy: true }; }
        dictating = !dictating;
        return dictating ? { recording: true } : { recording: false, text: 'Māori names in the draft.' };
      }
      if (method === 'completion.current') return null;
      if (method === 'chat.history') return [];
      if (method === 'apps.list') return [];
      throw new Error(`Unimplemented onboarding fixture: ${method}`);
    };
    if (options.nativeEvents) {
      let nextCallback = 0;
      let nextEvent = 0;
      const eventHandlers = new Map<number, string>();
      const callbacks: Record<string, (event: any) => void> = {};
      (window as any).__onboardingNative = { listeners: 0 };
      (window as any).__TAURI_INTERNALS__ = {
        transformCallback(callback: (event: any) => void) { const id = `fixture-callback-${++nextCallback}`; callbacks[id] = callback; return id; },
        unregisterCallback(id: string) { delete callbacks[id]; },
        async invoke(command: string, args: any) {
          if (command === 'plugin:event|listen') { const id = ++nextEvent; eventHandlers.set(id, args.handler); (window as any).__onboardingNative.listeners = eventHandlers.size; return id; }
          if (command === 'plugin:event|unlisten') { eventHandlers.delete(args.eventId); (window as any).__onboardingNative.listeners = eventHandlers.size; return; }
          throw new Error(`Unexpected onboarding native request: ${command}`);
        },
      };
      (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
      fixture.emit = (event: string, data: unknown) => {
        for (const callbackId of eventHandlers.values()) callbacks[callbackId]?.({ event: 'pace-event', id: 1, payload: { event, data } });
      };
    }
  }, { snapshot: initialState, options });
}

const tour = (page: Page) => page.getByRole('main', { name: 'Welcome to Desktop Pets', exact: true });
const stops = (page: Page) => page.getByRole('navigation', { name: 'Adventure stops', exact: true });
const bridgeCalls = (page: Page): Promise<BridgeCall[]> => page.evaluate(() => (window as any).__onboardingFixture.calls);

async function saveOnboardingScreenshot(page: Page, viewport: string, stop: number) {
  const directory = path.resolve('.impeccable/review/companion');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `onboarding-${viewport}-${stop}.png`), fullPage: false, omitBackground: true, animations: 'disabled' });
}

test('first run stays passive while every adventure stop is browsed', async ({ page }) => {
  await onboardingFixture(page); await page.goto('/');
  await expect(tour(page).getByRole('heading', { name: 'A tiny pack for your first tricks.', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation', exact: true })).toHaveCount(0);
  for (const id of ['moonshine-tiny-en', 'kitten-tts-micro-0.8', 'qwen3.5-4b']) {
    const model = initialState.models.find(item => item.id === id)!;
    await expect(page.getByRole('button', { name: `Download ${model.name}`, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /Download .*Whisper|Download .*Nemotron|Download .*Qwen 3 · Voice/ })).toHaveCount(0);
  await stops(page).getByRole('button', { name: 'Meet', exact: true }).click();
  await expect(tour(page).getByRole('heading', { name: 'A little adventure starts here.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Set up keys', exact: true }).click();
  await expect(tour(page).getByRole('heading', { name: 'Keys that feel like yours.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Choose access', exact: true }).click();
  await expect(tour(page).getByRole('heading', { name: 'Good company. Your rules.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Go home', exact: true }).click();
  await expect(tour(page).getByRole('heading', { name: 'Your desktop has a new resident.', exact: true })).toBeVisible();
  for (const name of ['Pack', 'Meet', 'Keys', 'Access', 'Home']) await stops(page).getByRole('button', { name, exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(tour(page).getByRole('heading', { name: 'Good company. Your rules.', exact: true })).toBeVisible();
  expect((await bridgeCalls(page)).filter(call => !['app.state', 'permissions.status'].includes(call.method))).toEqual([]);
});

test('petting Pace is an explicit interaction with the native bridge', async ({ page }) => {
  await onboardingFixture(page); await page.goto('/');
  await stops(page).getByRole('button', { name: 'Meet', exact: true }).click();
  await page.getByRole('button', { name: 'Pet Pace', exact: true }).click();
  await expect(tour(page)).toContainText('Pace likes you already.');
  const actions = (await bridgeCalls(page)).filter(call => call.method === 'pet.action');
  expect(actions).toHaveLength(1);
  expect(actions[0].params.action).toBeTruthy();
});

test('each optional download uses its real model ID only after clicking', async ({ page }) => {
  await onboardingFixture(page); await page.goto('/');
  await stops(page).getByRole('button', { name: 'Pack', exact: true }).click();
  expect((await bridgeCalls(page)).filter(call => call.method === 'models.install')).toEqual([]);
  const models = ['moonshine-tiny-en', 'kitten-tts-micro-0.8', 'qwen3.5-4b'].map(id => initialState.models.find(model => model.id === id)!);
  for (const [index, model] of models.entries()) {
    await page.getByRole('button', { name: `Download ${model.name}`, exact: true }).click();
    await expect.poll(async () => (await bridgeCalls(page)).filter(call => call.method === 'models.install').map(call => call.params.id)).toEqual(models.slice(0, index + 1).map(item => item.id));
  }
});

test('the selected dictation language is saved and determines the first pack', async ({ page }) => {
  await onboardingFixture(page); await page.goto('/');
  await page.getByLabel('Dictation language').selectOption('ja');
  await expect.poll(async () => (await bridgeCalls(page)).filter(call => call.method === 'settings.update').map(call => call.params.patch)).toContainEqual({ dictationLanguage: 'ja' });
  await expect(page.getByRole('button', { name: 'Download Moonshine Tiny · Japanese', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Download Moonshine Tiny · Japanese', exact: true }).click();
  await expect.poll(async () => (await bridgeCalls(page)).filter(call => call.method === 'models.install').map(call => call.params.id)).toEqual(['moonshine-tiny-ja']);
  await page.getByLabel('Dictation language').selectOption('auto');
  await expect(page.getByRole('button', { name: 'Download Whisper large v3 turbo', exact: true })).toBeVisible();
  await expect(page.getByText(/Automatic language detection uses Whisper Turbo \(574 MB\)/)).toBeVisible();
});

test('shortcut changes wait for acknowledgement and only native events mark keys detected', async ({ page }) => {
  await onboardingFixture(page, { nativeEvents: true, settings: { commandShortcut: 'Control+Shift+F12' } }); await page.goto('/');
  await stops(page).getByRole('button', { name: 'Keys', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__onboardingNative.listeners)).toBeGreaterThan(0);
  const changed = [
    ['Talk', 'commandShortcut', 'Control+Alt+Space'],
    ['Dictate', 'dictationShortcut', 'Control+Alt+D'],
    ['Autocomplete', 'completionShortcut', 'Control+Alt+Enter'],
    ['Quick Hide', 'hideShortcut', 'Control+Alt+H'],
  ];
  const talk = page.locator('.onboarding-shortcut-row').filter({ hasText: 'Talk' });
  await expect(talk.getByRole('combobox', { name: 'Talk shortcut', exact: true })).toHaveValue('Control+Shift+F12');
  await expect(talk.getByRole('option', { name: 'Current custom · Control+Shift+F12', exact: true })).toBeAttached();
  for (const [label, field, shortcut] of changed) {
    const row = page.locator('.onboarding-shortcut-row').filter({ hasText: label });
    await row.getByRole('combobox', { name: `${label} shortcut`, exact: true }).selectOption(shortcut);
    await expect.poll(async () => (await bridgeCalls(page)).filter(call => call.method === 'settings.update').map(call => call.params.patch)).toContainEqual({ [field]: shortcut });
    await expect(page.getByRole('status')).toContainText('Shortcut saved.');
  }
  await expect(talk.locator('small')).toHaveText('Press the keys to try it');
  await page.getByRole('button', { name: 'Try Talk', exact: true }).click();
  await expect.poll(async () => (await bridgeCalls(page)).filter(call => call.method === 'window.talk').length).toBe(1);
  await expect(talk.locator('small')).toHaveText('Press the keys to try it');
  for (const [action, label] of [['talk', 'Talk'], ['dictate', 'Dictate'], ['complete', 'Autocomplete'], ['hide', 'Quick Hide']]) {
    await page.evaluate(action => (window as any).__onboardingFixture.emit('shortcut.triggered', { action }), action);
    await expect(page.locator('.onboarding-shortcut-row').filter({ hasText: label }).locator('small')).toHaveText('Shortcut detected');
  }
});

test('dictation starts only on its explicit button; vocabulary and examples save after acknowledgement', async ({ page }) => {
  await onboardingFixture(page, { nativeEvents: true }); await page.goto('/');
  await stops(page).getByRole('button', { name: 'Access', exact: true }).click();
  const practice = page.getByLabel('Dictation practice', { exact: true });
  await practice.fill('I will review the notes.');
  expect((await bridgeCalls(page)).filter(call => call.method === 'dictation.toggle')).toEqual([]);
  await page.getByRole('button', { name: 'Try dictation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop dictation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
  await expect(practice).toHaveValue('Māori names in the draft.');
  expect((await bridgeCalls(page)).filter(call => call.method === 'dictation.toggle')).toHaveLength(2);
  await page.getByLabel('Names and words Pace should recognize').fill('Ngāi Tahu, Aotearoa, Rimu');
  await page.getByRole('button', { name: 'Save vocabulary', exact: true }).click();
  await expect.poll(async () => (await bridgeCalls(page)).filter(call => call.method === 'settings.update').map(call => call.params.patch)).toContainEqual({ dictationVocabulary: 'Ngāi Tahu, Aotearoa, Rimu' });
  await page.getByLabel('Autocomplete style examples').fill('Short, warm notes with plain language.');
  await page.getByRole('button', { name: 'Save examples', exact: true }).click();
  await expect.poll(async () => (await bridgeCalls(page)).filter(call => call.method === 'settings.update').map(call => call.params.patch)).toContainEqual({ writingExamples: 'Short, warm notes with plain language.' });
  await expect(page.getByRole('status')).toContainText('Writing examples saved.');
});

test('leaving Access stops dictation, keeps the heard text, and stops again before Skip saves', async ({ page }) => {
  await onboardingFixture(page, { nativeEvents: true }); await page.goto('/');
  await stops(page).getByRole('button', { name: 'Access', exact: true }).click();
  await page.getByRole('button', { name: 'Try dictation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop dictation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Go home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your desktop has a new resident.', exact: true })).toBeVisible();
  expect((await bridgeCalls(page)).filter(call => call.method === 'dictation.toggle')).toHaveLength(2);
  await stops(page).getByRole('button', { name: 'Access', exact: true }).click();
  const practice = page.getByLabel('Dictation practice', { exact: true });
  await expect(practice).toHaveValue('Māori names in the draft.');
  await page.getByRole('button', { name: 'Try dictation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop dictation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Skip adventure', exact: true }).click();
  await expect(tour(page)).toHaveCount(0);
  const methods = (await bridgeCalls(page)).map(call => call.method);
  expect(methods.slice(-3)).toEqual(['dictation.toggle', 'dictation.toggle', 'settings.update']);
  expect((await bridgeCalls(page)).filter(call => call.method === 'settings.update').at(-1)?.params.patch).toEqual({ onboardingCompleted: true });
});

test('a busy dictation stop keeps setup open until the recording can stop', async ({ page }) => {
  await onboardingFixture(page, { nativeEvents: true, busyStopOnce: true }); await page.goto('/');
  await stops(page).getByRole('button', { name: 'Access', exact: true }).click();
  await page.getByRole('button', { name: 'Try dictation', exact: true }).click();
  await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
  await expect(tour(page).getByRole('alert')).toContainText('Dictation is still finishing. Try again in a moment.');
  await expect(page.getByRole('button', { name: 'Stop dictation', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__onboardingFixture.state.settings.onboardingCompleted)).toBe(false);
  await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
  await expect(page.getByLabel('Dictation practice', { exact: true })).toHaveValue('Māori names in the draft.');
  await page.getByRole('button', { name: 'Go home', exact: true }).click();
  await expect(tour(page).getByRole('heading', { name: 'Your desktop has a new resident.', exact: true })).toBeVisible();
});

test('browser preview explains native tests and never starts dictation', async ({ page }) => {
  await onboardingFixture(page); await page.goto('/');
  await stops(page).getByRole('button', { name: 'Access', exact: true }).click();
  await expect(page.getByText('Native shortcuts and microphone access can only be tested in the desktop app.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try dictation', exact: true })).toBeDisabled();
  await expect(tour(page)).toContainText('Quick Hide also hides this setup');
  await expect(tour(page)).toContainText('macOS may still show Pace in full-display capture.');
  expect((await bridgeCalls(page)).filter(call => call.method === 'dictation.toggle')).toEqual([]);
});

test('Kiki voice preview is explicit and available only after its pack is installed', async ({ page }) => {
  await onboardingFixture(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Hear Pace say hello', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Download Kitten TTS Micro · 40M', exact: true }).click();
  await stops(page).getByRole('button', { name: 'Meet', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hear Pace say hello', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hear Pace say hello', exact: true }).click();
  await expect.poll(async () => (await bridgeCalls(page)).filter(call => call.method === 'voice.speak').length).toBe(1);
  const speech = (await bridgeCalls(page)).find(call => call.method === 'voice.speak')!;
  expect(speech.params).toMatchObject({ voice: 'Kiki', voiceEngine: 'kitten', language: 'English' });
  expect((await bridgeCalls(page)).filter(call => call.method === 'settings.update')).toEqual([]);
});

test('desktop access is requested separately and only after consent', async ({ page }) => {
  await onboardingFixture(page); await page.goto('/');
  await stops(page).getByRole('button', { name: 'Access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Good company. Your rules.', exact: true })).toBeVisible();
  expect((await bridgeCalls(page)).filter(call => call.method === 'permissions.request')).toEqual([]);
  const permissions = [['Accessibility', 'accessibility'], ['Microphone', 'microphone'], ['Meeting audio', 'screenRecording']];
  for (const [index, [title]] of permissions.entries()) {
    await page.getByRole('button', { name: `Allow ${title}`, exact: true }).click();
    await expect.poll(async () => (await bridgeCalls(page)).filter(call => call.method === 'permissions.request').map(call => call.params.kind)).toEqual(permissions.slice(0, index + 1).map(item => item[1]));
  }
  expect((await bridgeCalls(page)).filter(call => /^(audio\.|meeting\.|writing\.|memory\.)/.test(call.method))).toEqual([]);
});

for (const ready of [false, true]) {
  test(`finishing persists only completion and opens ${ready ? 'chat with a ready model' : 'Pace without a model'}`, async ({ page }) => {
    await onboardingFixture(page, { installed: ready ? ['qwen3.5-4b'] : [] }); await page.goto('/');
    const before = await page.evaluate(() => structuredClone((window as any).__onboardingFixture.state.settings));
    await stops(page).getByRole('button', { name: 'Home', exact: true }).click();
    await page.getByRole('button', { name: 'Enter workspace', exact: true }).click();
    await expect(tour(page)).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Main navigation', exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#${ready ? 'chat' : 'pace'}$`));
    expect((await bridgeCalls(page)).filter(call => call.method === 'settings.update').map(call => call.params.patch)).toEqual([{ onboardingCompleted: true }]);
    expect(await page.evaluate(() => (window as any).__onboardingFixture.state.settings)).toEqual({ ...before, onboardingCompleted: true });
  });
}

test('browser preview can skip without downloads and remembers completion after reload', async ({ page }) => {
  await page.goto('/');
  await expect(tour(page)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('desktop-pets.browser-state.v1'))).toBeNull();
  await page.getByRole('button', { name: 'Skip adventure', exact: true }).click();
  await expect(tour(page)).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('desktop-pets.browser-state.v1')!).settings.onboardingCompleted)).toBe(true);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main navigation', exact: true })).toBeVisible();
  await expect(tour(page)).toHaveCount(0);
});

test('replaying and leaving the adventure preserves existing preferences and completion', async ({ page }) => {
  await onboardingFixture(page, { completed: true, settings: { language: 'ja', soundEnabled: true, speechEnabled: true, memoryEnabled: true, allowedApps: ['com.apple.TextEdit'], allowedDomains: ['example.com'], petSize: 208 } });
  await page.goto('/#settings');
  await expect(tour(page)).toHaveCount(0);
  const before = await page.evaluate(() => structuredClone((window as any).__onboardingFixture.state));
  for (const finish of [true, false]) {
    await page.getByRole('button', { name: 'Replay Pace’s adventure', exact: true }).click();
    await expect(tour(page)).toBeVisible();
    expect(await page.evaluate(() => (window as any).__onboardingFixture.state.settings.onboardingCompleted)).toBe(true);
    if (finish) {
      await stops(page).getByRole('button', { name: 'Home', exact: true }).click();
      await page.getByRole('button', { name: 'Enter workspace', exact: true }).click();
    } else await page.getByRole('button', { name: 'Skip adventure', exact: true }).click();
    await expect(tour(page)).toHaveCount(0);
    await expect(page).toHaveURL(/#settings$/);
    expect(await page.evaluate(() => (window as any).__onboardingFixture.state)).toEqual(before);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  }
  for (const call of (await bridgeCalls(page)).filter(call => call.method === 'settings.update')) expect(call.params.patch).toEqual({ onboardingCompleted: true });
  expect((await bridgeCalls(page)).filter(call => /^(models\.install|permissions\.request|memory\.)/.test(call.method))).toEqual([]);
});

test('a failed save keeps the adventure open and can be retried', async ({ page }) => {
  await onboardingFixture(page, { saveFailures: 1 }); await page.goto('/');
  await stops(page).getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Enter workspace', exact: true }).click();
  await expect(tour(page).getByRole('alert')).toContainText('Synthetic setting write failed.');
  expect(await page.evaluate(() => (window as any).__onboardingFixture.state.settings.onboardingCompleted)).toBe(false);
  await expect(page.getByRole('button', { name: 'Enter workspace', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Enter workspace', exact: true }).click();
  await expect(tour(page)).toHaveCount(0);
  expect((await bridgeCalls(page)).filter(call => call.method === 'settings.update')).toHaveLength(2);
});

test('saving disables navigation so a second action cannot race completion', async ({ page }) => {
  await onboardingFixture(page, { delaySave: true }); await page.goto('/');
  await stops(page).getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Enter workspace', exact: true }).click();
  for (const name of ['Pack', 'Meet', 'Keys', 'Access', 'Home']) await expect(stops(page).getByRole('button', { name, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Skip adventure', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).__finishOnboardingSave());
  await expect(tour(page)).toHaveCount(0);
  expect((await bridgeCalls(page)).filter(call => call.method === 'settings.update')).toHaveLength(1);
});

test('startup failure does not mistake default settings for a first run', async ({ page }) => {
  await onboardingFixture(page, { failState: true }); await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Synthetic startup failure.');
  await expect(tour(page)).toHaveCount(0);
  expect((await bridgeCalls(page)).filter(call => call.method === 'settings.update')).toEqual([]);
});

test('utility windows bypass first-run onboarding', async ({ page }) => {
  await onboardingFixture(page);
  for (const kind of ['pet', 'commandbar', 'bubble']) {
    await page.goto(`/?window=${kind}`);
    await expect(tour(page)).toHaveCount(0);
    if (kind === 'pet') await expect(page.getByRole('button', { name: 'Pet Pace; drag to move; right-click for menu', exact: true })).toBeVisible();
    else if (kind === 'bubble') await expect(page.getByRole('textbox', { name: 'Ask Pace', exact: true })).toBeVisible();
    else await expect(page.locator('.completion-cloud')).toBeVisible();
    expect((await bridgeCalls(page)).filter(call => call.method === 'settings.update')).toEqual([]);
  }
});

test('all stops fit narrow and short windows with reduced motion', async ({ page }) => {
  await onboardingFixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const viewport of [{ width: 390, height: 844 }, { width: 800, height: 560 }]) {
    await page.setViewportSize(viewport); await page.goto('/');
    await expect(tour(page)).toBeVisible();
    for (const name of ['Meet', 'Keys', 'Access', 'Home', 'Pack']) {
      await stops(page).getByRole('button', { name, exact: true }).click();
      await expect(tour(page).getByRole('heading', { level: 1 })).toBeFocused();
      await expect(page.locator('.onboarding-dialogue-body')).toHaveCSS('animation-name', 'none');
      await expect(page.locator('.onboarding-pet .pace-sprite')).toHaveCSS('animation-name', 'none');
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${viewport.width}×${viewport.height}, ${name}: document width`).toBeLessThanOrEqual(viewport.width);
      const continueButton = page.locator('.onboarding-primary');
      await continueButton.scrollIntoViewIfNeeded();
      const box = await continueButton.boundingBox(); expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    }
  }
});

test('captures all five onboarding stops at desktop, minimum desktop and mobile sizes', async ({ page }) => {
  await onboardingFixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const viewports = [
    { width: 1180, height: 780 },
    { width: 800, height: 560 },
    { width: 390, height: 844 },
  ];
  const order = ['Pack', 'Meet', 'Keys', 'Access', 'Home'];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(tour(page)).toBeVisible();
    for (const [index, name] of order.entries()) {
      if (index > 0) await stops(page).getByRole('button', { name, exact: true }).click();
      await expect(stops(page).getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'step');
      await expect(tour(page).getByRole('heading', { level: 1 })).toBeFocused();
      await saveOnboardingScreenshot(page, `${viewport.width}x${viewport.height}`, index + 1);
    }
  }
});
