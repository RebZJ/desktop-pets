import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('desktop-pets.browser-state.v1', JSON.stringify({ settings: { onboardingCompleted: true } }));
    const history = Array.from({ length: 30 }, (_, index) => ({
      id: `history-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: `${index % 2 ? 'Pace' : 'You'}: ` + ('A long synthetic conversation keeps going through the release plan, dates, owners and open questions. '.repeat(12)),
    }));
    const state = {
      settings: { onboardingCompleted: true, language: 'auto', voice: 'Ono_Anna', pitch: 1.05, rate: 1, volume: .65, petSize: 160, activePack: 'pace', speechEnabled: false, soundEnabled: true, memoryEnabled: false, allowedApps: [], allowedDomains: [], retentionDays: 30, meetingTips: true, clickThrough: false, hideShortcut: 'Alt+Shift+Space', commandShortcut: 'Alt+Space', dictationShortcut: 'Alt+Shift+D', completionShortcut: 'Alt+Shift+Enter', dictationLanguage: 'en', dictationVocabulary: 'Pace\nQwen\nMoonshine' },
      models: [{ id: 'qwen3.5-4b', name: 'Qwen 3.5 · 4B', role: 'Chat & writing', sizeBytes: 100_000_000, installed: true, status: 'installed' }],
      meetings: [], extensions: [], packs: [{ id: 'pace', name: 'Pace' }], memory: { enabled: false, applications: [] }, pet: { visible: true, action: 'idle' },
    };
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string) => {
      if (method === 'app.state') return structuredClone(state);
      if (method === 'chat.history') return structuredClone(history);
      if (method === 'apps.list') return [];
      if (method === 'models.status') return state.models;
      throw new Error(`Unexpected fixture request: ${method}`);
    };
  });
});

async function saveReviewScreenshot(page: import('@playwright/test').Page, name: string) {
  const directory = path.resolve('.impeccable/review/companion');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), fullPage: false, animations: 'disabled' });
}

test('long chat history stays above the composer at desktop, compact and phone sizes', async ({ page }) => {
  await mkdir(path.resolve('.impeccable/review/companion'), { recursive: true });
  for (const viewport of [{ width: 1180, height: 780 }, { width: 800, height: 560 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('.message')).toHaveCount(30);
    const layout = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.messages')!;
      const composer = document.querySelector<HTMLElement>('.chat-compose-area')!;
      const main = document.querySelector<HTMLElement>('.main-content')!;
      const clip = scroller.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      const visibleText = [...document.querySelectorAll<HTMLElement>('.message-text')].flatMap(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return [...range.getClientRects()].map(rect => ({
          left: Math.max(rect.left, clip.left + scroller.clientLeft),
          right: Math.min(rect.right, clip.right - scroller.clientLeft),
          top: Math.max(rect.top, clip.top + scroller.clientTop),
          bottom: Math.min(rect.bottom, clip.top + scroller.clientTop + scroller.clientHeight),
        }));
      }).filter(rect => rect.right > rect.left && rect.bottom > rect.top);
      const overlapsComposer = visibleText.some(rect => rect.right > composerRect.left && rect.left < composerRect.right && rect.bottom > composerRect.top && rect.top < composerRect.bottom);
      return {
        viewport: [innerWidth, innerHeight],
        composerInMain: composerRect.top >= mainRect.top && composerRect.bottom <= mainRect.bottom,
        messagesCanScroll: ['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1,
        messageBoxBeforeComposer: clip.bottom + scrollY <= composerRect.top + scrollY + 1,
        mainNoScroll: main.scrollHeight <= main.clientHeight + 1,
        overlapsComposer,
        messageBox: [clip.top + scrollY, clip.bottom + scrollY],
        composerBox: [composerRect.top + scrollY, composerRect.bottom + scrollY],
        mainScroll: [main.scrollTop, main.scrollHeight, main.clientHeight],
        measuredTextRects: visibleText.length,
      };
    });
    expect(layout, JSON.stringify(layout)).toMatchObject({ composerInMain: true, messagesCanScroll: true, messageBoxBeforeComposer: true, mainNoScroll: true, overlapsComposer: false });
    await saveReviewScreenshot(page, viewport.width === 1180 ? 'chat-long.png' : viewport.width === 800 ? 'chat-long-800x560.png' : 'chat-long-mobile.png');
  }
  await page.setViewportSize({ width: 1180, height: 780 });
  await page.goto('/#settings');
  await expect(page.locator('.settings-page')).toBeVisible();
  await page.getByLabel('Quick hide shortcut').scrollIntoViewIfNeeded();
  await saveReviewScreenshot(page, 'settings-shortcuts-1180x780.png');
  await page.getByLabel('Custom dictation vocabulary').scrollIntoViewIfNeeded();
  await saveReviewScreenshot(page, 'settings-vocabulary-1180x780.png');
  await page.setViewportSize({ width: 800, height: 560 });
  await page.goto('/#settings');
  await expect(page.locator('.settings-page')).toBeVisible();
  await page.getByLabel('Quick hide shortcut').scrollIntoViewIfNeeded();
  await saveReviewScreenshot(page, 'settings-shortcuts-800x560.png');
  await page.getByLabel('Custom dictation vocabulary').scrollIntoViewIfNeeded();
  await saveReviewScreenshot(page, 'settings-vocabulary-800x560.png');
  await page.setViewportSize({ width: 1180, height: 780 });
  await page.goto('/#meetings');
  await page.getByRole('button', { name: 'Meeting notes', exact: true }).click();
  await expect(page.locator('.meetings-page')).toBeVisible();
  await saveReviewScreenshot(page, 'meetings-pixel-theme.png');
});
