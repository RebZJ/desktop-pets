import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, options: { held?: boolean; heldStart?: boolean; heldContext?: boolean; meetingId?: string } = {}) {
  await page.addInitScript(options => {
    let callbackId = 0; const callbacks = new Map<number, (data: any) => void>(); const handlers = new Map<number, number>(); let eventId = 0;
    const f: any = { calls: [], ...options, fail: false, current: { sessionId: null, active: false, phase: 'idle' } };
    (window as any).__chatFixture = f;
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback(callback: any) { callbacks.set(++callbackId, callback); return callbackId; },
      unregisterCallback(id: number) { callbacks.delete(id); },
      async invoke(method: string, params: any) { if (method === 'plugin:event|listen') { handlers.set(++eventId, params.handler); return eventId; } if (method === 'plugin:event|unlisten') { handlers.delete(params.eventId); return; } throw Error(method); },
    };
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    f.emit = (event: string, data: any) => { for (const handler of handlers.values()) callbacks.get(handler)?.({ payload: { event, data } }); };
    f.context = (meetingId?: string) => { f.meetingId = meetingId; f.emit('chat.context', { meetingId }); };
    f.voice = (phase: string, patch = {}) => { f.current = { ...f.current, phase, ...patch }; f.emit('voicechat.state', f.current); };
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string, params: any = {}) => {
      f.calls.push({ method, params });
      if (method === 'app.state') return { settings: { onboardingCompleted: true, soundEnabled: false }, meetings: [], pet: { visible: true, action: 'idle' } };
      if (method === 'chat.context.current') { const saved = { meetingId: f.meetingId }; if (f.heldContext) await new Promise(resolve => { f.resolveContext = resolve; }); return saved; }
      if (method === 'voicechat.current') return f.current;
      if (method === 'voicechat.start') {
        f.current = { sessionId: params.clientSessionId, active: true, phase: 'starting', meetingId: params.meetingId || null };
        if (f.heldStart) await new Promise(resolve => { f.resolveStart = resolve; });
        if (f.failStart) throw Error('Install Moonshine and Kitten in Local models to start voice conversation.');
        if (f.current.sessionId === params.clientSessionId && f.current.active) f.voice('listening');
        return f.current;
      }
      if (method === 'voicechat.stop') { if (f.failStop) throw Error('Audio engine disconnected.'); f.voice('idle', { active: false }); return f.current; }
      if (method === 'chat.send') { if (f.held) await new Promise(resolve => { f.resolve = resolve; }); if (f.fail) throw Error('Local model unavailable. Your message is preserved.'); return { text: 'One tiny step at a time. What shall we tackle first?' }; }
      if (method === 'window.close' || method === 'window.main') return {};
      throw Error(method);
    };
  }, options);
  await page.setViewportSize({ width: 300, height: 220 });
  await page.goto('/?window=command');
  await expect(page.getByRole('main', { name: 'Chat with Pace' })).toBeVisible();
  if (!options.heldContext) await expect(page.getByRole('button', { name: 'Start voice conversation' })).toBeEnabled();
}
const calls = (page: Page, method: string) => page.evaluate(method => (window as any).__chatFixture.calls.filter((call: any) => call.method === method), method);
const conversation = (page: Page) => page.getByRole('log', { name: 'Conversation' });

test('compact chat opens passively and streams typed answers without recording', async ({ page }) => {
  await fixture(page, { held: true });
  const box = await page.getByRole('main', { name: 'Chat with Pace' }).boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(300); expect(box!.y + box!.height).toBeLessThanOrEqual(220);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(300);
  expect((await calls(page, 'voicechat.start')).length).toBe(0);
  await page.getByRole('textbox', { name: 'Message Pace' }).fill('Help me pick one small next step.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.evaluate(() => { const f = (window as any).__chatFixture; const id = f.calls.find((call: any) => call.method === 'chat.send').params.clientRequestId; f.emit('chat.delta', { clientRequestId: 'other-window', text: 'Wrong answer' }); f.emit('chat.delta', { clientRequestId: id, text: 'One tiny' }); });
  await expect(conversation(page)).toContainText('One tiny'); await expect(conversation(page)).not.toContainText('Wrong answer');
  await page.evaluate(() => (window as any).__chatFixture.resolve());
  await expect(conversation(page)).toContainText('What shall we tackle first?');
  await expect(page.getByRole('textbox', { name: 'Message Pace' })).toHaveValue('');
  const sent = (await calls(page, 'chat.send'))[0]; expect(sent.params).toMatchObject({ text: 'Help me pick one small next step.', quiet: true });
  expect((await calls(page, 'voicechat.start')).length).toBe(0);
  await page.screenshot({ path: '.impeccable/review/companion/chat-compact.png', omitBackground: true });
});

test('one explicit Start continues listening after replies, with real meter and session guards', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Start voice conversation' }).click();
  await expect(page.getByRole('status')).toHaveText('Listening…');
  await expect(page.getByRole('img', { name: 'Pace is listen' })).toBeVisible();
  await expect(page.getByRole('meter', { name: 'Microphone level' })).toHaveAttribute('value', '0');
  await page.evaluate(() => { const f = (window as any).__chatFixture; f.emit('voicechat.level', { sessionId: 'old-session', level: 1 }); });
  await expect(page.getByRole('meter')).toHaveAttribute('value', '0');
  await page.evaluate(() => { const f = (window as any).__chatFixture; f.emit('voicechat.level', { sessionId: f.current.sessionId, level: .4 }); });
  await expect(page.getByRole('meter')).toHaveAttribute('value', '0.4');
  await expect(page.getByRole('meter')).toHaveAttribute('value', '0');
  await page.evaluate(() => (window as any).__chatFixture.voice('thinking', { userText: 'What should I do next?' }));
  await expect(page.getByRole('status')).toHaveText('Thinking…'); await expect(conversation(page)).toContainText('What should I do next?');
  await page.evaluate(() => (window as any).__chatFixture.voice('speaking', { text: 'Choose one small task.' }));
  await expect(page.getByRole('status')).toHaveText('Pace is speaking…'); await expect(page.getByRole('img', { name: 'Pace is talk' })).toBeVisible();
  await expect(conversation(page)).toContainText('Choose one small task.');
  await page.evaluate(() => (window as any).__chatFixture.voice('listening'));
  await expect(page.getByRole('status')).toHaveText('Listening…'); expect((await calls(page, 'voicechat.start')).length).toBe(1);
  await page.screenshot({ path: '.impeccable/review/companion/chat-live.png', omitBackground: true });
  await page.getByRole('button', { name: 'End voice conversation' }).click();
  await expect(page.getByRole('button', { name: 'Start voice conversation' })).toBeVisible();
  await expect(conversation(page)).toContainText('Choose one small task.');
});


test('voice captions wait for playback and ignore raw generation deltas', async ({ page }) => {
  await fixture(page); await page.getByRole('button', { name: 'Start voice conversation' }).click();
  await page.evaluate(() => {
    const f = (window as any).__chatFixture;
    f.voice('thinking', { sequence: 3, userText: 'A small next step?', text: '' });
    f.emit('chat.delta', { clientRequestId: 'another-session', text: 'Wrong session' });
    f.emit('chat.delta', { clientRequestId: f.current.sessionId, text: 'Choose one' });
    f.emit('voicechat.state', { ...f.current, sequence: 1, phase: 'starting' });
  });
  await expect(page.getByRole('status')).toHaveText('Thinking…');
  await expect(conversation(page)).not.toContainText('Choose one'); await expect(conversation(page)).not.toContainText('Wrong session');
  await page.evaluate(() => {
    const f = (window as any).__chatFixture;
    f.voice('speaking', { sequence: 4, text: 'Choose one' });
    f.emit('chat.delta', { clientRequestId: f.current.sessionId, text: 'Late duplicate' });
    f.emit('voicechat.state', { ...f.current, sequence: 3, phase: 'thinking', text: 'Stale partial' });
  });
  await expect(page.getByRole('status')).toHaveText('Pace is speaking…');
  await expect(conversation(page)).toContainText('Choose one');
  await expect(conversation(page)).not.toContainText('small task');
  await page.evaluate(() => (window as any).__chatFixture.voice('speaking', { sequence: 5, text: 'Choose one small task.' }));
  await expect(conversation(page)).toContainText('Choose one small task.');
  await expect(conversation(page)).not.toContainText('Late duplicate'); await expect(conversation(page)).not.toContainText('Stale partial');
  expect((await conversation(page).innerText()).match(/Choose one/g)).toHaveLength(1);
  await page.evaluate(() => (window as any).__chatFixture.voice('transcribing', { sequence: 6 }));
  await expect(conversation(page)).not.toContainText('Choose one');
  await page.evaluate(() => { const f = (window as any).__chatFixture; f.voice('thinking', { sequence: 7, userText: 'Next question', text: '' }); f.emit('chat.delta', { clientRequestId: f.current.sessionId, text: 'New partial' }); });
  await expect(conversation(page)).not.toContainText('New partial');
  const id = await page.evaluate(() => (window as any).__chatFixture.current.sessionId);
  await page.getByRole('button', { name: 'End voice conversation' }).click();
  await page.evaluate(id => (window as any).__chatFixture.emit('chat.delta', { clientRequestId: id, text: 'After End' }), id);
  await expect(conversation(page)).not.toContainText('After End');
});

test('End during startup or thinking ignores late voice events, and close waits for stop', async ({ page }) => {
  await fixture(page, { heldStart: true });
  await page.getByRole('button', { name: 'Start voice conversation' }).click();
  await expect(page.getByRole('status')).toHaveText('Opening microphone…');
  const oldId = await page.evaluate(() => (window as any).__chatFixture.current.sessionId);
  await page.getByRole('button', { name: 'End voice conversation' }).click();
  await page.evaluate(oldId => { const f = (window as any).__chatFixture; f.resolveStart(); f.emit('voicechat.state', { sessionId: oldId, active: true, phase: 'speaking', text: 'Old reply' }); f.heldStart = false; }, oldId);
  await expect(page.getByRole('button', { name: 'Start voice conversation' })).toBeVisible(); await expect(conversation(page)).not.toContainText('Old reply');
  await page.getByRole('button', { name: 'Start voice conversation' }).click();
  await page.evaluate(() => (window as any).__chatFixture.voice('thinking', { userText: 'Another thought' }));
  await page.getByRole('button', { name: 'End voice conversation' }).click();
  expect((await calls(page, 'voicechat.stop')).length).toBe(2);
  await page.getByRole('button', { name: 'Start voice conversation' }).click();
  await page.evaluate(() => { const f = (window as any).__chatFixture; f.voice('error', { active: false, error: 'Voice output interrupted.' }); f.failStop = true; });
  await expect(page.getByRole('button', { name: 'End voice conversation' })).toBeEnabled();
  await page.getByRole('button', { name: 'Close chat' }).click();
  await expect(page.getByRole('alert')).toContainText('Try End again');
  expect((await calls(page, 'window.close')).length).toBe(0); await expect(page.getByRole('button', { name: 'End voice conversation' })).toBeEnabled();
  await page.evaluate(() => (window as any).__chatFixture.failStop = false);
  await page.getByRole('button', { name: 'Close chat' }).click();
  const all = await page.evaluate(() => (window as any).__chatFixture.calls.map((call: any) => call.method));
  expect(all.slice(-2)).toEqual(['voicechat.stop', 'window.close']);
});

test('missing voice models explain recovery without clearing typed drafts', async ({ page }) => {
  await fixture(page); await page.getByRole('textbox', { name: 'Message Pace' }).fill('A thought for later');
  await page.evaluate(() => (window as any).__chatFixture.failStart = true);
  await page.getByRole('button', { name: 'Start voice conversation' }).click();
  await expect(page.getByRole('alert')).toContainText('Moonshine and Kitten');
  await page.getByRole('button', { name: 'Open Local models' }).click();
  expect((await calls(page, 'window.main'))[0].params).toEqual({ page: 'models' });
  await expect(page.getByRole('textbox', { name: 'Message Pace' })).toHaveValue('A thought for later');
});

test('failed or pending typed chat preserves drafts and IME cannot submit', async ({ page }) => {
  await fixture(page, { held: true });
  const input = page.getByRole('textbox', { name: 'Message Pace' }); await input.fill('My next step?');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  expect((await calls(page, 'chat.send')).length).toBe(0);
  await page.getByRole('button', { name: 'Send message' }).click(); await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await input.fill('Keep this next thought.'); await page.evaluate(() => (window as any).__chatFixture.resolve());
  await expect(input).toHaveValue('Keep this next thought.');
  await page.evaluate(() => { const f = (window as any).__chatFixture; f.held = false; f.fail = true; });
  await page.getByRole('button', { name: 'Send message' }).click(); await expect(page.getByRole('alert')).toContainText('preserved');
  await page.reload(); await expect(input).toHaveValue('Keep this next thought.');
});

test('initial and immediate context switches cannot leak old typed or spoken replies', async ({ page }) => {
  await fixture(page, { held: true, heldContext: true, meetingId: 'old-meeting' });
  await expect(page.getByRole('button', { name: 'Start voice conversation' })).toBeDisabled();
  await page.evaluate(() => { const f = (window as any).__chatFixture; f.context('meeting-one'); f.resolveContext(); });
  await expect(page.getByText('Meeting chat', { exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message Pace' }); await input.fill('What was decided?'); await page.getByRole('button', { name: 'Send message' }).click();
  await page.evaluate(() => { const f = (window as any).__chatFixture; f.context(); f.resolve(); });
  await expect(conversation(page)).not.toContainText('One tiny step');
  expect((await calls(page, 'chat.send'))[0].params.meetingId).toBe('meeting-one');
  await page.getByRole('button', { name: 'Start voice conversation' }).click();
  await page.evaluate(() => { const f = (window as any).__chatFixture; const sessionId = f.current.sessionId; f.context('meeting-two'); f.emit('voicechat.state', { sessionId, active: true, phase: 'speaking', text: 'Wrong meeting answer' }); });
  await expect(page.getByRole('button', { name: 'Start voice conversation' })).toBeVisible();
  await expect(conversation(page)).not.toContainText('Wrong meeting answer');
  expect((await calls(page, 'voicechat.stop')).length).toBe(1);
  await page.getByRole('button', { name: 'Start voice conversation' }).click();
  expect((await calls(page, 'voicechat.start'))[1].params.meetingId).toBe('meeting-two');
});

test('focusing the same chat keeps delivered messages and a live session running', async ({ page }) => {
  await fixture(page);
  await page.getByRole('textbox', { name: 'Message Pace' }).fill('One tiny step?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(conversation(page)).toContainText('One tiny step');
  await page.evaluate(() => (window as any).__chatFixture.context());
  await expect(conversation(page)).toContainText('One tiny step');
  await page.getByRole('button', { name: 'Start voice conversation' }).click();
  const id = await page.evaluate(() => (window as any).__chatFixture.current.sessionId);
  await page.evaluate(() => (window as any).__chatFixture.context());
  await expect(page.getByRole('button', { name: 'End voice conversation' })).toBeVisible();
  expect((await calls(page, 'voicechat.stop')).length).toBe(0);
  expect(await page.evaluate(() => (window as any).__chatFixture.current.sessionId)).toBe(id);
});

test('pixel bubbles float on a clear background with a fixed bottom dock', async ({ page }) => {
  await fixture(page);
  await expect(page.locator('.chat-history')).toHaveAttribute('data-scrolled', 'false');
  for (const height of [180, 220, 330]) {
    await page.setViewportSize({ width: 300, height });
    const layout = await page.evaluate(() => {
      const shell = document.querySelector('.chat-cloud')!;
      const history = document.querySelector('.chat-history')!.getBoundingClientRect();
      const dock = document.querySelector('.chat-dock')!.getBoundingClientRect();
      const style = getComputedStyle(shell);
      const bubble = document.querySelector('.chat-bubble')!;
      const reply = document.querySelector('.chat-reply')!;
      return { background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow,
        historyBottom: history.bottom, dockTop: dock.top, dockBottom: dock.bottom,
        width: document.documentElement.scrollWidth, scrollbars: getComputedStyle(reply).scrollbarWidth,
        outline: getComputedStyle(bubble, '::before').clipPath,
        tail: bubble.querySelector('.chat-bubble-tail') !== null };
    });
    expect(layout).toMatchObject({ background: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none', scrollbars: 'none', tail: true });
    expect(layout.outline).toContain('polygon(');
    expect(layout.historyBottom).toBeLessThanOrEqual(layout.dockTop);
    expect(layout.dockBottom).toBeLessThanOrEqual(height);
    expect(layout.width).toBeLessThanOrEqual(300);
    await expect(page.getByRole('button', { name: 'Start voice conversation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close chat' })).toBeVisible();
  }
  await page.getByRole('textbox', { name: 'Message Pace' }).fill('One small next step?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.chat-user')).toContainText('One small next step?');
  await expect(page.locator('.chat-pace')).toContainText('One tiny step');
  const positions = await page.evaluate(() => {
    const turn = document.querySelector('.chat-turn')!.getBoundingClientRect();
    const user = document.querySelector('.chat-user')!.getBoundingClientRect();
    const pace = document.querySelector('.chat-pace')!.getBoundingClientRect();
    return { userRight: user.right, paceLeft: pace.left, turnRight: turn.right, turnLeft: turn.left };
  });
  expect(positions.userRight).toBeCloseTo(positions.turnRight);
  expect(positions.paceLeft).toBeCloseTo(positions.turnLeft);
  await page.screenshot({ path: test.info().outputPath('pixel-chat-history.png'), omitBackground: true });
});

test('history scrolls without visible bars and streaming respects reading position', async ({ page }) => {
  await fixture(page, { held: true });
  await page.getByRole('textbox', { name: 'Message Pace' }).fill('Help me make a small plan.');
  await page.getByRole('button', { name: 'Send message' }).click();
  const stream = (text: string) => page.evaluate(text => {
    const f = (window as any).__chatFixture;
    const id = f.calls.find((call: any) => call.method === 'chat.send').params.clientRequestId;
    f.emit('chat.delta', { clientRequestId: id, text });
  }, text);
  await stream('First, pick one task. Then give it ten quiet minutes.\n'.repeat(12));
  const log = conversation(page);
  const scrollTop = () => log.evaluate(element => element.scrollTop);
  await expect.poll(scrollTop).toBeGreaterThan(100);
  await expect(page.locator('.chat-history')).toHaveAttribute('data-scrolled', 'true');
  expect(await page.locator('.chat-history').evaluate(element => getComputedStyle(element).maskImage)).toContain('linear-gradient');
  const box = (await log.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -10000);
  await expect.poll(scrollTop).toBe(0);
  await expect(page.locator('.chat-history')).toHaveAttribute('data-scrolled', 'false');
  await stream('A fresh thought should not pull you away from what you are reading.\n');
  await expect(log).toContainText('A fresh thought');
  expect(await scrollTop()).toBe(0);
  await log.focus(); await log.press('End');
  await expect.poll(() => log.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await stream('And one more thought, when you are ready.\n'.repeat(4));
  await expect.poll(() => log.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await page.screenshot({ path: test.info().outputPath('pixel-chat-fade.png'), omitBackground: true });
});
