import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';

test.beforeAll(async () => { await mkdir('.impeccable/review', { recursive: true }); });

async function interactionFixture(page: Page, withMeeting = false, holdChat = false) {
  await page.addInitScript(({ includeMeeting, pendingChat }: { includeMeeting: boolean; pendingChat: boolean }) => {
    const calls = { chat: 0, pet: [] as string[], tools: 0, lastChat: null as any };
    const meetings = includeMeeting ? [{ id: 'fixture-meeting', title: 'Synthetic fixture meeting', startedAt: '2026-11-13T00:00:00Z', status: 'recording', segments: [{ speaker: 'You', start: 1, end: 4, text: 'Synthetic discussion of the release schedule.' }] }] : [];
    const state = { settings: { onboardingCompleted: true, soundEnabled: false, speechEnabled: true }, models: [], meetings, memory: { enabled: false, applications: [] }, pet: { visible: true, action: 'idle' }, packs: [{ id: 'pace', name: 'Pace' }], extensions: [{ id: 'fixture-tool', name: 'Fixture tools', command: '/fixture/no-process-started', enabled: true, enabledTools: ['echo'] }] };
    (window as any).__interactionCalls = calls;
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string, params: any) => {
      if (method === 'app.state') return structuredClone(state);
      if (method === 'chat.history') return [];
      if (method === 'chat.send') { calls.chat++; calls.lastChat = params; if (pendingChat) await new Promise<void>(resolve => { (window as any).__resolveMeetingQuestion = resolve; }); return { conversationId: params.conversationId, text: 'Synthetic fixture answer.' }; }
      if (method === 'apps.list') return { apps: [] };
      if (method === 'meeting.export') return { filename: 'fixture-notes.md', content: '# Synthetic fixture notes\n\n- [x] Reviewed fixture action.\n\n## Transcript\nYou: 你好、Pace.\n' };
      if (method === 'pet.action') { calls.pet.push(params.action); state.pet.action = params.action; return state.pet; }
      if (method === 'extensions.inspect') return { tools: [{ name: 'echo', description: 'Synthetic fixture tool.' }] };
      if (method === 'extensions.call') { calls.tools++; if (calls.tools === 2) throw new Error('Synthetic fixture failure.'); return { content: [{ type: 'text', text: 'Synthetic fixture result.' }] }; }
      throw new Error(`Unimplemented interaction fixture: ${method}`);
    };
  }, { includeMeeting: withMeeting, pendingChat: holdChat });
}

test('overlay pet activates by keyboard while a pointer drag does not pet it', async ({ page }) => {
  await interactionFixture(page); await page.goto('/?window=pet');
  const pet = page.getByRole('button', { name: 'Pet Pace; drag to move; right-click for menu', exact: true });
  const controls = page.locator('.pet-controls');
  await expect(controls.getByRole('button', { name: 'Chat with Pace', exact: true })).toBeHidden();
  await expect(controls.getByRole('button', { name: 'Dictate into your app', exact: true })).toBeHidden();
  // WebKit leaves the transparent overlay on its first Tab; retain keyboard modality before focusing the pet.
  await page.keyboard.press('Tab');
  await pet.focus();
  await expect(pet).toBeFocused();
  await expect(controls).toBeVisible();
  await pet.press('Enter'); await pet.press('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__interactionCalls.pet.length)).toBe(2);
  const box = await pet.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 40, box!.y + 40); await page.mouse.down();
  await page.mouse.move(box!.x + 60, box!.y + 45, { steps: 3 }); await page.mouse.up();
  expect(await page.evaluate(() => (window as any).__interactionCalls.pet.length)).toBe(2);
  await pet.evaluate(element => element.blur());
  await page.mouse.move(0, 0);
  await expect(controls.getByRole('button', { name: 'Chat with Pace', exact: true })).toBeVisible();
  await expect(controls.getByRole('button', { name: 'Dictate into your app', exact: true })).toBeHidden();
});

test('MCP one-shot confirmation is consumed on success and failure', async ({ page }) => {
  await interactionFixture(page); await page.goto('/#extensions');
  await page.getByRole('button', { name: /Fixture tools Local MCP server/ }).click();
  const confirmation = page.getByRole('checkbox', { name: /I reviewed/ });
  const run = page.getByRole('button', { name: 'Confirm & run tool', exact: true });
  await confirmation.check(); await run.click();
  await expect(page.locator('.tool-output')).toContainText('Synthetic fixture result.');
  await expect(confirmation).not.toBeChecked(); await expect(run).toBeDisabled();
  await confirmation.check(); await run.click();
  await expect(page.getByRole('alert')).toContainText('Synthetic fixture failure.');
  await expect(confirmation).not.toBeChecked(); await expect(run).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__interactionCalls.tools)).toBe(2);
});

test('on-demand meeting question includes its meeting context and stays quiet', async ({ page }) => {
  await interactionFixture(page, true); await page.goto('/#meetings');
  await page.getByLabel('Ask Pace about this meeting', { exact: true }).fill('What should I clarify next?');
  await page.getByRole('button', { name: 'Ask Pace', exact: true }).click();
  await expect(page.locator('.meeting-answer')).toContainText('Synthetic fixture answer.');
  const params = await page.evaluate(() => (window as any).__interactionCalls.lastChat);
  expect(params).toMatchObject({ meetingId: 'fixture-meeting', conversationId: 'meeting-fixture-meeting', text: 'What should I clarify next?', quiet: true });
});

test('Download notes delivers the returned Markdown file unchanged', async ({ page }) => {
  await interactionFixture(page, true); await page.goto('/#meetings');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download notes', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('fixture-notes.md');
  expect(await readFile((await download.path())!, 'utf8')).toBe('# Synthetic fixture notes\n\n- [x] Reviewed fixture action.\n\n## Transcript\nYou: 你好、Pace.\n');
  await expect(page.getByRole('status')).toContainText('Download started.');
});

test('pet artwork and menu fit every configured native pet size', async ({ browser }) => {
  for (const size of [128, 160, 208]) {
    const width = size + 64, height = size + 64;
    const page = await browser.newPage({ viewport: { width, height } });
    await page.addInitScript((petSize: number) => {
      (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string) => {
        if (method === 'app.state') return { settings: { onboardingCompleted: true, petSize, soundEnabled: false }, models: [], meetings: [], pet: { visible: true, action: 'idle' } };
        throw new Error(`Unimplemented size fixture: ${method}`);
      };
    }, size);
    await page.goto('http://127.0.0.1:1420/?window=pet');
    await expect(page.locator('.overlay-pet-button .pace-sprite')).toHaveCSS('width', `${size}px`);
    const pet = page.getByRole('button', { name: 'Pet Pace; drag to move; right-click for menu', exact: true });
    await expect(page.getByRole('button', { name: 'Chat with Pace', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Dictate into your app', exact: true })).toBeHidden();
    await pet.hover();
    await expect(page.locator('.pet-controls')).toBeVisible();
    await pet.click({ button: 'right' });
    const menu = page.locator('.pet-menu');
    await expect(menu).toBeVisible();
    for (const name of ['Meeting notes', 'Controls & look', 'A tiny victory!', 'Hide Pace']) await expect(menu.getByRole('button', { name, exact: true })).toBeVisible();
    for (const selector of ['.overlay-pet-button', '.pet-menu']) {
      const box = await page.locator(selector).boundingBox();
      expect(box, `${size}: ${selector}`).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width); expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    }
    await page.close();
  }
});

test('long dictation stays copyable from a tiny pet notice without opening an editor', async ({ page }) => {
  await page.setViewportSize({ width: 224, height: 224 });
  await page.addInitScript(() => {
    (window as any).__copiedDictation = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copiedDictation = text; } } });
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string) => {
      if (method === 'app.state') return { settings: { onboardingCompleted: true, soundEnabled: false }, models: [], meetings: [] };
      if (method === 'dictation.current') return { phase: 'draft', text: 'A long recognized dictation phrase. '.repeat(80) };
      throw new Error(`Unexpected dictation fixture: ${method}`);
    };
  });
  await page.goto('/?window=pet');
  const notice = page.getByRole('status', { name: 'Dictation recovery' }); await expect(notice).toContainText('Words ready.');
  const box = await notice.boundingBox(); expect(box!.width).toBeLessThanOrEqual(160); expect(box!.height).toBeLessThanOrEqual(48);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy words', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__copiedDictation)).toBe('A long recognized dictation phrase. '.repeat(80).trim());
});


test('workspace meeting copilot keeps Stop available and preserves a next question', async ({ page }) => {
  await interactionFixture(page, true, true); await page.goto('/#meetings');
  const input = page.getByRole('textbox', { name: 'Ask Pace about this meeting', exact: true });
  await input.fill('What should I clarify next?');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: true });
  expect(await page.evaluate(() => (window as any).__interactionCalls.chat)).toBe(0);
  await page.getByRole('button', { name: 'Ask Pace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeEnabled();
  await input.fill('Keep my next question.');
  await page.evaluate(() => (window as any).__resolveMeetingQuestion());
  await expect(page.locator('.meeting-answer')).toContainText('Synthetic fixture answer.');
  await expect(input).toHaveValue('Keep my next question.');
  const params = await page.evaluate(() => (window as any).__interactionCalls.lastChat);
  expect(params).toMatchObject({ meetingId: 'fixture-meeting', quiet: true }); expect(params.clientRequestId).toMatch(/^[0-9a-f-]{36}$/i);
});
