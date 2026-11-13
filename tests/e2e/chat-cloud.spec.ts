import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, held = false) {
  await page.addInitScript(({ held }) => {
    let callbackId = 0; const callbacks = new Map<number, (data: any) => void>(); const handlers = new Map<number, number>(); let eventId = 0;
    const f: any = { calls: [], held, fail: false };
    (window as any).__chatFixture = f;
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback(callback: any) { callbacks.set(++callbackId, callback); return callbackId; },
      unregisterCallback(id: number) { callbacks.delete(id); },
      async invoke(method: string, params: any) { if (method === 'plugin:event|listen') { handlers.set(++eventId, params.handler); return eventId; } if (method === 'plugin:event|unlisten') { handlers.delete(params.eventId); return; } throw Error(method); },
    };
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    f.context = (meetingId?: string) => { for (const handler of handlers.values()) callbacks.get(handler)?.({ payload: { event: 'chat.context', data: { meetingId } } }); };
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string, params: any = {}) => {
      f.calls.push({ method, params });
      if (method === 'app.state') return { settings: { onboardingCompleted: true, soundEnabled: false }, meetings: [], pet: { visible: true, action: 'idle' } };
      if (method === 'chat.send') { if (f.held) await new Promise(resolve => { f.resolve = resolve; }); if (f.fail) throw Error('Local model unavailable. Your message is preserved.'); return { text: 'One tiny step at a time. What shall we tackle first?' }; }
      if (method === 'window.close' || method === 'window.main') return {};
      throw Error(method);
    };
  }, { held });
  await page.setViewportSize({ width: 300, height: 220 });
  await page.goto('/?window=command');
  await expect(page.getByRole('main', { name: 'Chat with Pace' })).toBeVisible();
}

test('chat is a compact explicit text bubble with no ambient audio or generation', async ({ page }) => {
  await fixture(page);
  const box = await page.getByRole('main', { name: 'Chat with Pace' }).boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(300); expect(box!.y + box!.height).toBeLessThanOrEqual(220);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(300);
  expect(await page.evaluate(() => (window as any).__chatFixture.calls.map((call: any) => call.method).filter((method: string) => method !== 'app.state'))).toEqual([]);
  await page.getByRole('textbox', { name: 'Message Pace' }).fill('Help me pick one small next step.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('status')).toContainText('One tiny step');
  await expect(page.getByRole('textbox', { name: 'Message Pace' })).toHaveValue('');
  await page.screenshot({ path: '.impeccable/review/companion/chat-compact.png', omitBackground: true });
  const calls = await page.evaluate(() => (window as any).__chatFixture.calls);
  expect(calls.find((call: any) => call.method === 'chat.send').params).toMatchObject({ text: 'Help me pick one small next step.', quiet: true });
  expect(calls.some((call: any) => /audio|voice|dictation|memory/.test(call.method))).toBe(false);
});

test('failed or pending chat preserves drafts and IME cannot submit', async ({ page }) => {
  await fixture(page, true);
  const input = page.getByRole('textbox', { name: 'Message Pace' }); await input.fill('My next step?');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  expect(await page.evaluate(() => (window as any).__chatFixture.calls.some((call: any) => call.method === 'chat.send'))).toBe(false);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await input.fill('Keep this next thought.');
  await page.evaluate(() => (window as any).__chatFixture.resolve());
  await expect(input).toHaveValue('Keep this next thought.');
  await page.evaluate(() => { const f = (window as any).__chatFixture; f.held = false; f.fail = true; });
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('alert')).toContainText('preserved'); await expect(input).toHaveValue('Keep this next thought.');
  await page.reload(); await expect(input).toHaveValue('Keep this next thought.');
});

test('meeting questions remain scoped and old replies cannot leak into a different context', async ({ page }) => {
  await fixture(page, true);
  await page.evaluate(() => (window as any).__chatFixture.context('meeting-one'));
  await expect(page.getByText('Ask about this meeting', { exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message Pace' }); await input.fill('What was decided?'); await page.getByRole('button', { name: 'Send message' }).click();
  await page.evaluate(() => { const f = (window as any).__chatFixture; f.context(); f.resolve(); });
  await expect(page.getByText('Chat with Pace', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).not.toContainText('One tiny step');
  const sent = await page.evaluate(() => (window as any).__chatFixture.calls.find((call: any) => call.method === 'chat.send'));
  expect(sent.params.meetingId).toBe('meeting-one');
  await page.getByRole('button', { name: 'Close chat' }).click();
  expect(await page.evaluate(() => (window as any).__chatFixture.calls.at(-1))).toEqual({ method: 'window.close', params: { label: 'command' } });
});
