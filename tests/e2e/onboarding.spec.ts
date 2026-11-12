import { test, expect, type Page } from '@playwright/test';
import { initialState, type Settings } from '../../src/api';

type BridgeCall = { method: string; params: Record<string, unknown> };
type FixtureOptions = { completed?: boolean; installed?: string[]; failState?: boolean; saveFailures?: number; delaySave?: boolean; settings?: Partial<Settings> };

async function onboardingFixture(page: Page, options: FixtureOptions = {}) {
  await page.addInitScript(({ snapshot, options }) => {
    const state = structuredClone(snapshot);
    Object.assign(state.settings, { soundEnabled: false, onboardingCompleted: Boolean(options.completed) }, options.settings);
    state.models.forEach(model => { if (options.installed?.includes(model.id)) { model.installed = true; model.status = 'installed'; } });
    const calls: BridgeCall[] = [];
    const permissions: Record<string, string> = { accessibility: 'denied', microphone: 'denied', screenRecording: 'denied' };
    let failures = options.saveFailures || 0;
    (window as any).__onboardingFixture = { state, calls };
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
      if (method === 'chat.history') return [];
      if (method === 'apps.list') return [];
      throw new Error(`Unimplemented onboarding fixture: ${method}`);
    };
  }, { snapshot: initialState, options });
}

const tour = (page: Page) => page.getByRole('main', { name: 'Welcome to Desktop Pets', exact: true });
const stops = (page: Page) => page.getByRole('navigation', { name: 'Adventure stops', exact: true });
const bridgeCalls = (page: Page): Promise<BridgeCall[]> => page.evaluate(() => (window as any).__onboardingFixture.calls);

test('first run stays passive while every adventure stop is browsed', async ({ page }) => {
  await onboardingFixture(page); await page.goto('/');
  await expect(tour(page).getByRole('heading', { name: 'A little adventure starts here.', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Let’s pack', exact: true }).click();
  await expect(tour(page).getByRole('heading', { name: 'Small pack. Big possibilities.', exact: true })).toBeVisible();
  for (const model of initialState.models) await expect(page.getByRole('button', { name: `Download ${model.name}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next stop', exact: true }).click();
  await expect(tour(page).getByRole('heading', { name: 'Good company. Your rules.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Head home', exact: true }).click();
  await expect(tour(page).getByRole('heading', { name: 'Your desktop has a new resident.', exact: true })).toBeVisible();
  for (const name of ['Meet', 'Access', 'Pack', 'Home']) await stops(page).getByRole('button', { name, exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(tour(page).getByRole('heading', { name: 'Good company. Your rules.', exact: true })).toBeVisible();
  expect((await bridgeCalls(page)).filter(call => !['app.state', 'permissions.status'].includes(call.method))).toEqual([]);
});

test('petting Pace is an explicit interaction with the native bridge', async ({ page }) => {
  await onboardingFixture(page); await page.goto('/');
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
  for (const [index, model] of initialState.models.entries()) {
    await page.getByRole('button', { name: `Download ${model.name}`, exact: true }).click();
    await expect.poll(async () => (await bridgeCalls(page)).filter(call => call.method === 'models.install').map(call => call.params.id)).toEqual(initialState.models.slice(0, index + 1).map(item => item.id));
  }
});

test('desktop access is requested separately and only after consent', async ({ page }) => {
  await onboardingFixture(page); await page.goto('/');
  await stops(page).getByRole('button', { name: 'Access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Good company. Your rules.', exact: true })).toBeVisible();
  expect((await bridgeCalls(page)).filter(call => call.method === 'permissions.request')).toEqual([]);
  const permissions = [['Writing help', 'accessibility'], ['Microphone', 'microphone'], ['Meeting audio', 'screenRecording']];
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
  for (const name of ['Meet', 'Pack', 'Access', 'Home']) await expect(stops(page).getByRole('button', { name, exact: true })).toBeDisabled();
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
    else await expect(page.locator('.utility-window')).toBeVisible();
    expect((await bridgeCalls(page)).filter(call => call.method === 'settings.update')).toEqual([]);
  }
});

test('all stops fit narrow and short windows with reduced motion', async ({ page }) => {
  await onboardingFixture(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const viewport of [{ width: 390, height: 844 }, { width: 800, height: 560 }]) {
    await page.setViewportSize(viewport); await page.goto('/');
    await expect(tour(page)).toBeVisible();
    for (const name of ['Pack', 'Access', 'Home', 'Meet']) {
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
