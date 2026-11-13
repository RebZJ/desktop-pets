import { test, expect, type Page } from '@playwright/test';

const storageKey = 'desktop-pets.browser-state.v1';
async function browserSettings(page: Page) {
  await page.addInitScript(key => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: { onboardingCompleted: true, soundEnabled: false } }));
  }, storageKey);
}

async function nativeFixture(page: Page) {
  await page.addInitScript(() => {
    const settings: Record<string, unknown> = { onboardingCompleted: true, soundEnabled: false };
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<number, number>();
    let serial = 0;
    (window as any).__themeEvents = { emit(event: string, data: unknown) { for (const callback of listeners.values()) callbacks.get(callback)?.({ payload: { event, data } }); }, get count() { return listeners.size; } };
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback(callback: (event: unknown) => void) { const id = ++serial; callbacks.set(id, callback); return id; },
      unregisterCallback(id: number) { callbacks.delete(id); },
      async invoke(command: string, args: any) {
        if (command === 'plugin:event|listen') { const id = ++serial; listeners.set(id, args.handler); return id; }
        if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
        throw new Error(`Unexpected native fixture call: ${command}`);
      },
    };
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string, params: any) => {
      if (method === 'app.state') return { settings, models: [], meetings: [], extensions: [] };
      if (method === 'apps.list' || method === 'chat.history') return [];
      if (method === 'settings.update') {
        if (params.patch.commandShortcut === 'Alt+Q') throw new Error('That shortcut is already in use. Choose another shortcut.');
        Object.assign(settings, params.patch); return settings;
      }
      if (method === 'permissions.status') return {};
      if (method === 'completion.current') return { phase: 'idle' };
      return {};
    };
  });
}

test('all nine palette and font combinations persist, with default readable prose', async ({ page }) => {
  await browserSettings(page);
  await page.goto('/#settings');
  await expect(page.getByLabel('Interface font')).toHaveValue('pixel');
  expect(await page.locator('.setting-row p').first().evaluate(element => getComputedStyle(element).fontFamily)).toContain('Inter');
  for (const theme of ['camp', 'night', 'handheld']) {
    for (const font of ['pixel', 'inter', 'fira']) {
      await page.getByLabel('World palette').selectOption(theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.getByLabel('Interface font').selectOption(font);
      await expect(page.locator('html')).toHaveAttribute('data-font', font);
      await page.reload();
      await expect(page.getByLabel('World palette')).toHaveValue(theme);
      await expect(page.getByLabel('Interface font')).toHaveValue(font);
      await page.evaluate(() => document.fonts.ready);
      const shortcutStyle = await page.locator('.shortcut-input').first().evaluate(element => ({ background: getComputedStyle(element).backgroundColor, surface: getComputedStyle(element.closest('.settings-group')!).backgroundColor, radius: getComputedStyle(element).borderRadius }));
      expect(shortcutStyle.background).toBe(shortcutStyle.surface);
      expect(shortcutStyle.radius).toBe('0px');
      const fonts = await page.getByRole('heading', { name: 'Look & feel' }).evaluate(element => getComputedStyle(element).fontFamily);
      expect(fonts).toContain(font === 'pixel' ? 'Pixelify Sans' : font === 'inter' ? 'Inter' : 'Fira Sans');
    }
  }
  await expect(page.getByText('Requested · Quick hide ready', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Enable screen-share cover' })).toHaveCount(0);
});

test('appearance rejects unsupported writes and repairs corrupt browser values', async ({ page }) => {
  await browserSettings(page); await page.goto('/#settings');
  const rejected = await page.evaluate(async () => {
    const { api } = await import('/src/api.ts');
    const patches = [{ theme: 'unknown' }, { theme: ['camp'] }, { interfaceFont: 'comic' }, { captureProtectionEnabled: 'yes' }];
    return Promise.all(patches.map(async patch => { try { await api('settings.update', { patch }); return false; } catch { return true; } }));
  });
  expect(rejected).toEqual([true, true, true, true]);
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ settings: { onboardingCompleted: true, theme: 'unknown', interfaceFont: 'comic', captureProtectionEnabled: 'yes' } })), storageKey);
  await page.reload();
  await expect(page.getByLabel('World palette')).toHaveValue('camp');
  await expect(page.getByLabel('Interface font')).toHaveValue('pixel');
  await expect(page.getByText('Requested · Quick hide ready', { exact: true })).toBeVisible();
});

test('every shortcut records a chosen combination and persists after reload', async ({ page }) => {
  await browserSettings(page); await page.goto('/#settings');
  const choices = [
    ['Quick hide shortcut', 'Shift+F8'],
    ['Talk shortcut', 'Control+Alt+K'],
    ['Dictation shortcut', 'Alt+Shift+J'],
    ['Autocomplete shortcut', 'Control+Alt+ArrowRight'],
  ];
  for (const [label, shortcut] of choices) {
    const input = page.getByRole('textbox', { name: label, exact: true });
    await input.click(); await input.press(shortcut);
    await expect(input).toHaveValue(shortcut);
    await input.press('Enter');
    await expect(page.getByRole('button', { name: `Save ${label.toLowerCase()}`, exact: true })).toBeDisabled();
  }
  await page.reload();
  for (const [label, shortcut] of choices) await expect(page.getByRole('textbox', { name: label, exact: true })).toHaveValue(shortcut);
});

test('browser preview synchronizes palette and font to every utility window', async ({ page, context }) => {
  await browserSettings(page); await page.goto('/#settings');
  const tools: Page[] = [];
  for (const kind of ['pet', 'bubble', 'command', 'meeting']) {
    const tool = await context.newPage(); await tool.goto(`/?window=${kind}`); tools.push(tool);
  }
  for (const [theme, font] of [['night', 'inter'], ['handheld', 'fira'], ['camp', 'pixel']]) {
    await page.getByLabel('World palette').selectOption(theme);
    await page.getByLabel('Interface font').selectOption(font);
    for (const tool of tools) {
      await expect(tool.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(tool.locator('html')).toHaveAttribute('data-font', font);
    }
  }
});

test('native settings events reach all window kinds and gear navigation focuses shortcuts', async ({ page, context }) => {
  for (const kind of ['', 'pet', 'bubble', 'command', 'meeting']) {
    const tool = kind ? await context.newPage() : page;
    await nativeFixture(tool); await tool.goto(kind ? `/?window=${kind}` : '/#chat');
    await expect.poll(() => tool.evaluate(() => (window as any).__themeEvents.count)).toBeGreaterThan(0);
    await tool.evaluate(() => (window as any).__themeEvents.emit('settings.updated', { theme: 'night', interfaceFont: 'fira' }));
    await expect(tool.locator('html')).toHaveAttribute('data-theme', 'night');
    await expect(tool.locator('html')).toHaveAttribute('data-font', 'fira');
    if (kind) await tool.close();
  }
  await page.evaluate(() => (window as any).__themeEvents.emit('navigation.open', { page: 'settings', section: 'shortcuts' }));
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(page.locator('#shortcuts')).toBeFocused();
  for (const label of ['Quick hide shortcut', 'Talk shortcut', 'Dictation shortcut', 'Autocomplete shortcut']) await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  await page.getByLabel('Talk shortcut', { exact: true }).click();
  await expect(page.getByLabel('Talk shortcut', { exact: true }).locator('..')).toHaveClass(/is-recording/);
  await page.getByLabel('Talk shortcut', { exact: true }).press('Alt+Q');
  await page.getByRole('button', { name: 'Save talk shortcut', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already in use');
  expect(await page.evaluate(() => location.hash)).toBe('#settings');
  for (const section of ['appearance', 'privacy']) {
    await page.evaluate(id => (window as any).__themeEvents.emit('navigation.open', { page: 'settings', section: id }), section);
    await expect(page.locator(`#${section}`)).toBeFocused();
  }
  await page.evaluate(() => (window as any).__themeEvents.emit('navigation.open', { page: 'settings', section: '__invalid__' }));
  await expect(page.locator('#privacy')).toBeFocused();
});
