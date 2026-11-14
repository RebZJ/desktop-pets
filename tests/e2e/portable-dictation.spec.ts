import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, quiet = false) {
  await page.addInitScript(({ quiet }) => {
    const state = { settings: { onboardingCompleted: true, soundEnabled: false, petSize: 160 }, models: [], meetings: [], packs: [], memory: { enabled: false, applications: [] }, extensions: [], pet: { visible: true, action: 'idle' } };
    let current: any = quiet ? { phase: 'dispatched', dispatched: true, verified: false, text: 'Native input was dispatched.' } : { phase: 'error', dispatched: true, text: 'Words retained.', error: 'The app did not confirm insertion.', clipboardRecoveryId: 'original-lease' };
    const callbacks = new Map<number, (value: any) => void>();
    const listeners = new Map<number, number>(); let serial = 0;
    const f: any = { calls: [], copied: [], holdRestore: false };
    (window as any).__pasteFixture = f;
    f.emit = (value: any) => { current = value; for (const callback of listeners.values()) callbacks.get(callback)?.({ payload: { event: 'dictation.state', data: value } }); };
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback(callback: (value: any) => void) { const id = ++serial; callbacks.set(id, callback); return id; },
      unregisterCallback(id: number) { callbacks.delete(id); },
      async invoke(command: string, args: any) {
        if (command === 'plugin:event|listen') { const id = ++serial; listeners.set(id, args.handler); return id; }
        if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
        if (command === 'plugin:clipboard-manager|write_text') { f.copied.push(args.text); return; }
        throw new Error(command);
      },
    };
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string, params: any) => {
      f.calls.push({ method, params });
      if (method === 'app.state') return structuredClone(state);
      if (method === 'dictation.current') return structuredClone(current);
      if (method === 'dictation.clipboard.restore') {
        if (f.failRestore) { f.failRestore = false; throw new Error('Temporary pasteboard write failure.'); }
        if (f.holdRestore) await new Promise((_, reject) => { f.rejectRestore = reject; });
        return { restored: true };
      }
      if (method === 'pet.action') return state.pet;
      if (method.startsWith('window.')) return {};
      throw new Error(method);
    };
  }, { quiet });
}

test('unverified dispatched input is a quiet terminal result, with no automatic copy or retry', async ({ page }) => {
  await fixture(page, true); await page.goto('/?window=bubble');
  await expect(page.getByRole('main', { name: 'Dictation with Pace' })).toHaveCount(0);
  await page.goto('/?window=pet');
  await expect(page.getByRole('status', { name: 'Dictation recovery' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pasteFixture.copied)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__pasteFixture.calls.filter((c: any) => c.method === 'dictation.retry'))).toEqual([]);
});

test('an unread paste offers an explicit clipboard restore without repeating insertion', async ({ page }) => {
  await fixture(page); await page.goto('/?window=pet');
  await expect(page.getByRole('status', { name: 'Dictation recovery' })).toContainText('Check your text.');
  await page.getByRole('button', { name: 'Restore original clipboard', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Dictation recovery' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pasteFixture.calls.filter((c: any) => c.method === 'dictation.clipboard.restore'))).toEqual([{ method: 'dictation.clipboard.restore', params: { recoveryId: 'original-lease' } }]);
  expect(await page.evaluate(() => (window as any).__pasteFixture.calls.some((c: any) => c.method === 'dictation.insert' || c.method === 'dictation.retry'))).toBe(false);
});

test('explicit Copy retires the old clipboard recovery action', async ({ page }) => {
  await fixture(page); await page.goto('/?window=pet');
  await page.getByRole('button', { name: 'Copy words' }).click();
  await expect(page.getByRole('button', { name: 'Restore original clipboard', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pasteFixture.copied)).toEqual(['Words retained.']);
});

test('late clipboard restore failure cannot replace a newer dictation notice', async ({ page }) => {
  await fixture(page); await page.goto('/?window=pet');
  await page.evaluate(() => { (window as any).__pasteFixture.holdRestore = true; });
  await page.getByRole('button', { name: 'Restore original clipboard', exact: true }).click();
  await page.evaluate(() => {
    const f = (window as any).__pasteFixture;
    f.emit({ phase: 'error', text: 'New words.', error: 'No editable field.', clipboardRecoveryId: 'new-lease' });
    f.rejectRestore(new Error('Old lease expired.'));
  });
  await expect(page.getByRole('status', { name: 'Dictation recovery' })).toContainText('Couldn’t type here.');
  await expect(page.getByRole('status', { name: 'Dictation recovery' })).not.toContainText('Clipboard changed.');
  await expect(page.getByRole('button', { name: 'Restore original clipboard', exact: true })).toBeEnabled();
});


test('a temporary restore failure keeps the original clipboard available for another explicit attempt', async ({ page }) => {
  await fixture(page); await page.goto('/?window=pet');
  await page.evaluate(() => { (window as any).__pasteFixture.failRestore = true; });
  const restore = page.getByRole('button', { name: 'Restore original clipboard', exact: true });
  await restore.click();
  await expect(page.getByRole('status', { name: 'Dictation recovery' })).toContainText('Couldn’t restore. Try again.');
  await expect(restore).toBeEnabled();
  await restore.click();
  await expect(page.getByRole('status', { name: 'Dictation recovery' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pasteFixture.calls.filter((c: any) => c.method === 'dictation.clipboard.restore'))).toHaveLength(2);
  expect(await page.evaluate(() => (window as any).__pasteFixture.copied)).toEqual([]);
});
