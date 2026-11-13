import { test, expect } from '@playwright/test';

async function setup(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const state: any = { settings: { onboardingCompleted: true, soundEnabled: false }, meetings: [], packs: [{ id: 'pace', name: 'Pace' }], pet: { visible: true, action: 'idle' } };
    const calls: any[] = []; (window as any).__homeFixture = { state, calls };
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string, params: any = {}) => {
      calls.push({ method, params });
      if (method === 'app.state') return structuredClone(state);
      if (method === 'pet.toggle') { state.pet.visible = params.visible; state.pet.action = params.visible ? 'summon' : 'burrow'; return state.pet; }
      if (method === 'pet.action') { state.pet.action = params.action; return state.pet; }
      if (method.startsWith('window.')) return { opened: true };
      throw Error(`Unexpected home fixture request: ${method}`);
    };
  });
  await page.goto('/'); await expect(page.getByRole('region', { name: 'Pace’s campsite' })).toBeVisible();
}

test('the main page is Pace’s habitat with explicit little chat and tool buttons', async ({ page }) => {
  await setup(page);
  const home = page.getByRole('region', { name: 'Pace’s campsite' });
  await expect(home).toHaveCSS('background-image', /pace-camp.webp/);
  expect(await page.evaluate(() => (window as any).__homeFixture.calls.every((call: any) => call.method === 'app.state'))).toBe(true);
  await page.getByRole('button', { name: 'Chat with Pace', exact: false }).click();
  expect(await page.evaluate(() => (window as any).__homeFixture.calls.at(-1))).toEqual({ method: 'window.chat', params: {} });
  await page.getByRole('button', { name: 'Dictate', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__homeFixture.calls.at(-1))).toEqual({ method: 'window.talk', params: {} });
  await home.getByRole('button', { name: 'Meeting notes', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__homeFixture.calls.at(-1))).toEqual({ method: 'window.main', params: { page: 'meetings' } });
  expect(await page.evaluate(() => (window as any).__homeFixture.calls.some((call: any) => /^(voicechat|audio|chat)\./.test(call.method)))).toBe(false);
});

test('ground-hole sprites play once, hold their authored final frame, and can summon again', async ({ page }) => {
  await setup(page); await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Send Pace home' }).click();
  const sprite = page.locator('.home-resident .pace-sprite');
  await expect(sprite).toHaveCSS('background-image', /burrow-v1.webp/);
  await expect(sprite).toHaveCSS('animation-iteration-count', '1');
  await expect.poll(() => sprite.evaluate(el => getComputedStyle(el).backgroundPositionX)).toMatch(/^(-1568px|calc\(0% - 1568px\))$/);
  await page.waitForTimeout(250);
  await expect(sprite).toHaveCSS('background-position-x', /^(-1568px|calc\(0% - 1568px\))$/);
  await page.getByRole('button', { name: 'Summon Pace' }).click();
  await expect(sprite).toHaveCSS('background-image', /summon-v1.webp/);
  await expect(sprite).toHaveCSS('animation-iteration-count', '1');
  const images = await page.evaluate(async () => Promise.all(['summon', 'burrow'].map(async action => { const image = new Image(); image.src = `/pets/pace/${action}-v1.webp`; await image.decode(); return [image.naturalWidth, image.naturalHeight]; })));
  expect(images).toEqual([[2048, 256], [2048, 256]]);
});

test('the habitat and chat launcher fit desktop and narrow windows', async ({ page }) => {
  await setup(page); await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const [width, height] of [[1180, 780], [800, 560], [390, 844]]) {
    await page.setViewportSize({ width, height });
    const chat = page.getByRole('button', { name: 'Chat with Pace', exact: false });
    await chat.scrollIntoViewIfNeeded();
    const box = await chat.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `.impeccable/review/companion/pace-home-${width}x${height}.png`, animations: 'disabled' });
    if (width === 1180) await page.locator('.pace-home').screenshot({ path: '.impeccable/review/companion/pace-home-scene.png', animations: 'disabled' });
  }
});
