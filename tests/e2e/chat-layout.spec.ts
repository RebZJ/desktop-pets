import { test, expect } from '@playwright/test';

test('legacy chat entry keeps saved drafts untouched and opens Pace’s habitat', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('desktop-pets.browser-state.v1', JSON.stringify({ settings: { onboardingCompleted: true, soundEnabled: false } }));
    if (!sessionStorage.getItem('pace.chat-draft')) sessionStorage.setItem('pace.chat-draft', 'My existing unsent conversation.');
    if (!sessionStorage.getItem('pace.pet-draft')) sessionStorage.setItem('pace.pet-draft', 'My existing pet conversation.');
    (window as any).__legacyCalls = [];
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string) => {
      (window as any).__legacyCalls.push(method);
      if (method === 'app.state') return { settings: { onboardingCompleted: true, soundEnabled: false }, meetings: [], models: [], pet: { visible: true, action: 'idle' } };
      if (method === 'apps.list') return [];
      throw new Error(`Unexpected legacy route request: ${method}`);
    };
  });
  for (const viewport of [{ width: 1180, height: 780 }, { width: 800, height: 560 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await page.goto('/#chat');
    await expect(page.locator('.pace-home')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message Pace', exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button')).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => (window as any).__legacyCalls.some((method: string) => method.startsWith('chat.')))).toBe(false);
    expect(await page.evaluate(() => [sessionStorage.getItem('pace.chat-draft'), sessionStorage.getItem('pace.pet-draft')])).toEqual(['My existing unsent conversation.', 'My existing pet conversation.']);
  }
});
