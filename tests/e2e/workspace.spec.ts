import { test, expect, type Page } from '@playwright/test';
import type { Meeting } from '../../src/api';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const key = 'desktop-pets.browser-state.v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ settings: { onboardingCompleted: true } }));
  });
});

async function fixtureBridge(page: Page, meetings: Meeting[] = []) {
  await page.addInitScript((meetings) => {
    const settings = { onboardingCompleted: true, language: 'auto', voice: 'Ono_Anna', pitch: 1.05, rate: 1, volume: .65, petSize: 160, activePack: 'pace', speechEnabled: false, soundEnabled: true, memoryEnabled: false, allowedApps: [], allowedDomains: [], retentionDays: 30, meetingTips: true, clickThrough: false, hideShortcut: 'Alt+Shift+Space', commandShortcut: 'Alt+Space' };
    const models = ['qwen3.5-4b','qwen3-tts-0.6b','whisper-turbo','nemotron-diarization'].map((id, i) => ({ id, name: ['Qwen 3.5 · 4B','Qwen 3 · Voice','Whisper · Turbo','Nemotron 3 · Speakers'][i], role: ['Chat & notes','Voice','Transcription','Speakers'][i], sizeBytes: 100_000_000, installed: true, status: 'installed' }));
    const state = { settings, models, meetings: structuredClone(meetings) as any[], extensions: [] as any[], packs: [{id:'pace',name:'Pace',author:'Desktop Pets'}], memory: { enabled:false,applications:[] as string[] }, pet:{visible:true,action:'idle'} };
    let memories = [{ id:'fixture-memory',app:'TextEdit',title:'Synthetic release plan',text:'The synthetic launch review is Friday.',createdAt:'2026-11-13T00:00:00Z' }];
    const messages: any[] = [];
    const calls: Array<{ method: string; params: any }> = [];
    (window as any).__workspaceFixture = { state, calls };
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string, params: any) => {
      calls.push({ method, params: structuredClone(params) });
      if (method==='app.state') return structuredClone(state);
      if (method==='models.status') return models;
      if (method==='settings.update') {Object.assign(settings,params.patch);return settings;}
      if (method==='chat.history') return structuredClone(messages);
      if (method==='chat.send') {messages.push({id:'u',role:'user',content:params.text},{id:'a',role:'assistant',content:'Synthetic test reply: let’s make a clear plan.'});return {conversationId:params.conversationId,text:'Synthetic test reply: let’s make a clear plan.'};}
      if (method==='writing.capture') return {contextId:'fixture-target',app:'TextEdit',scope:'selection',text:'This sentence is very very unclear.',canApply:true};
      if (method==='writing.generate') return {text:'This sentence is clear.'};
      if (method==='writing.apply') throw new Error('The text or selection changed. Copy the preview or capture the field again.');
      if (method==='meeting.start') {const m={id:'fixture-meeting',title:params.title,status:'recording',startedAt:new Date().toISOString(),segments:[]};state.meetings.unshift(m);return m;}
      if (method==='meeting.stop') {const m=state.meetings[0];m.status='completed';m.endedAt=new Date().toISOString();m.segments=[{speaker:'You',start:1,end:4,text:'We will review the release Friday.'}];m.notes='## Summary\nSynthetic release review on Friday.';return m;}
      if (method==='meeting.summarize') return state.meetings[0];
      if (method==='meeting.update') {Object.assign(state.meetings.find(m=>m.id===params.id),params);return state.meetings[0];}
      if (method==='meeting.export') return {filename:'synthetic-meeting.md',content:'# Synthetic meeting\nRelease review Friday.'};
      if (method==='meeting.delete') {state.meetings=state.meetings.filter(meeting=>meeting.id!==params.id);return {deleted:true};}
      if (method==='apps.list') return {apps:[{bundleId:'com.apple.TextEdit',name:'TextEdit'}]};
      if (method==='permissions.status') return {accessibility:'denied',microphone:'denied',screenRecording:'denied'};
      if (method==='permissions.request') return {accessibility:'denied',microphone:'denied',screenRecording:'denied'};
      if (method==='memory.settings') {if('enabled'in params){state.memory.enabled=params.enabled;settings.memoryEnabled=params.enabled;}if(params.applications)state.memory.applications=params.applications;if(params.domains)settings.allowedDomains=params.domains;return state.memory;}
      if (method==='memory.search') return memories.filter(m=>!params.query||m.text.toLowerCase().includes(params.query.toLowerCase()));
      if (method==='memory.delete') {memories=params.id?memories.filter(m=>m.id!==params.id):[];return {deleted:true};}
      if (method==='extensions.add') {const e={id:'fixture-extension',...params,enabled:true,enabledTools:[]};state.extensions.push(e);return e;}
      if (method==='extensions.inspect') return {tools:[{name:'echo',description:'Synthetic local echo tool'}]};
      if (method==='extensions.update') {const e=state.extensions.find(e=>e.id===params.id);Object.assign(e,params);return e;}
      if (method==='extensions.call') return {content:[{type:'text',text:'Synthetic tool response'}]};
      if (method==='extensions.remove') {state.extensions=state.extensions.filter(e=>e.id!==params.id);return {removed:true};}
      if (method==='pet.action') {state.pet.action=params.action;return state.pet;}
      if (method==='pet.toggle') {state.pet.visible=params.visible??!state.pet.visible;return state.pet;}
      if (method==='audio.start') throw new Error('Enable Microphone access in System Settings to record audio.');
      if (method==='window.main'||method==='window.close'||method==='window.command') return {opened:true};
      throw new Error(`Fixture does not implement ${method}`);
    };
  }, meetings);
}

test('browser preview opens meeting notes without inventing a transcript',async({page})=>{
  await page.goto('/');
  await expect(page.locator('.meetings-page')).toBeVisible();
  await expect(page.getByRole('button',{name:'Chat with Pace',exact:true})).toHaveCount(0);
  await expect(page.getByRole('textbox',{name:'Message Pace',exact:true})).toHaveCount(0);
  await expect(page.locator('.transcript-turn')).toHaveCount(0);
});

test('all twelve real sprite strips load and pet visibility toggles',async({page})=>{
  await fixtureBridge(page);await page.goto('/#pace');
  await expect(page.getByRole('heading',{name:'Your very own little Pace.'})).toBeVisible();
  for(const name of ['Idle','Wave','Think','Type','Create','Review','Schedule','Sprint','Celebrate','Sleep','Petted','Annoyed']){
    await page.getByRole('button',{name,exact:true}).click();
    await expect(page.locator('.action-selector button.selected')).toHaveText(name);
  }
  const images=await page.evaluate(async()=>Promise.all(['idle','wave','think','type','create','review','schedule','sprint','celebrate','sleep','happy','annoyed'].map(async name=>{
    const image=new Image();image.src=`/pets/pace/${name}.webp`;await image.decode();return {name,width:image.naturalWidth,height:image.naturalHeight};
  })));
  expect(images.every(i=>i.width>0&&i.height>0)).toBe(true);
  await page.getByRole('button',{name:'Hide desktop pet',exact:true}).last().click();
  await expect(page.getByRole('button',{name:'Show desktop pet',exact:true}).last()).toBeVisible();
});

test('old chat and writing routes open meeting records without general chat',async({page})=>{
  await fixtureBridge(page);
  for(const route of ['chat','writing']) {
    await page.goto('/#'+route);
    await expect(page.locator('.meetings-page')).toBeVisible();
    await expect(page.getByRole('textbox',{name:'Message Pace'})).toHaveCount(0);
  }
});

test('meeting lifecycle and notes display keep the saved transcript',async({page})=>{
  const duplicateKeys: string[] = [];
  page.on('console', message => { if (/same key/.test(message.text())) duplicateKeys.push(message.text()); });
  await fixtureBridge(page);await page.goto('/#meetings');
  await expect(page.locator('.capture-options').getByRole('combobox')).toHaveCount(0);
  await expect(page.locator('.capture-options').getByRole('checkbox')).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).__workspaceFixture.calls.some((call: any) => call.method === 'apps.list'))).toBe(false);
  await page.getByRole('checkbox', { name: 'Microphone', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'System audio', exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Start meeting', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'System audio', exact: true }).check();
  await page.getByLabel('Meeting title',{exact:true}).fill('Synthetic release review');
  await page.getByRole('button',{name:'Start meeting',exact:true}).click();
  await expect(page.getByRole('button',{name:/Stop.*meeting|Finish meeting|Stop recording/})).toBeVisible();
  await expect(page.locator('.meeting-notes')).toHaveCount(1);
  await expect(page.locator('.meeting-question')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__workspaceFixture.calls.filter((call: any) => call.method === 'meeting.start'))).toEqual([{ method: 'meeting.start', params: { title: 'Synthetic release review', language: 'auto', captureMicrophone: false, captureSystem: true } }]);
  await page.getByRole('button',{name:/Stop.*meeting|Finish meeting|Stop recording/}).click();
  await expect(page.locator('.meeting-notes')).toHaveCount(1);
  await page.getByRole('tab',{name:'Transcript',exact:true}).click();
  await expect(page.locator('.meeting-notes')).toHaveCount(0);
  await expect(page.getByText('We will review the release Friday.')).toBeVisible();
  await page.getByRole('tab',{name:'Notes & actions',exact:true}).click();
  await expect(page.locator('.meeting-notes')).toHaveCount(1);
  await expect(page.locator('.note-document')).toHaveCount(1);
  await expect(page.locator('.meeting-question')).toHaveCount(1);
  await expect(page.locator('.note-document')).toContainText('Synthetic release review on Friday');
  expect(duplicateKeys).toEqual([]);
});

test('memory remains opt-in, searchable and deletable',async({page})=>{
  await fixtureBridge(page);await page.goto('/#memory');
  const toggle=page.getByRole('switch',{name:/memory/i});await expect(toggle).toHaveAttribute('aria-checked','false');
  await page.locator('#memory-app').fill('com.apple.TextEdit');await page.getByRole('button',{name:'Allow app',exact:true}).click();
  await toggle.click();await expect(toggle).toHaveAttribute('aria-checked','true');
  await page.getByLabel('Search saved memories').fill('Friday');await page.getByRole('button',{name:'Search',exact:true}).click();
  await expect(page.getByText('The synthetic launch review is Friday.')).toBeVisible();
  await page.getByRole('button',{name:'Delete this memory'}).click();await expect(page.getByText('The synthetic launch review is Friday.')).toHaveCount(0);
});

test('local tools require both a per-tool grant and reviewed arguments',async({page})=>{
  await fixtureBridge(page);await page.goto('/#extensions');await page.getByRole('button',{name:'Add extension'}).click();
  await page.getByLabel('Extension name').fill('Synthetic tools');await page.getByLabel('Executable path or command').fill('/synthetic/mcp');await page.getByRole('button',{name:'Connect server'}).click();
  await page.getByRole('button',{name:/Synthetic tools.*Local MCP server/}).click();
  await expect(page.getByRole('button',{name:'Confirm & run tool'})).toBeDisabled();
  await page.getByRole('checkbox',{name:/echo Synthetic local echo/}).check();
  await expect(page.getByRole('button',{name:'Confirm & run tool'})).toBeDisabled();
  await page.getByRole('checkbox',{name:/I reviewed/}).check();await page.getByRole('button',{name:'Confirm & run tool'}).click();
  await expect(page.locator('.tool-output')).toContainText('Synthetic tool response');
});

test('settings persist and the narrow workspace has no horizontal overflow',async({page})=>{
  await page.goto('/#settings');await page.getByLabel('Dictation language').selectOption('ja');
  await page.reload();await expect(page.getByLabel('Dictation language')).toHaveValue('ja');
  await page.setViewportSize({width:390,height:844});
  for(const route of ['chat','writing','meetings','memory','extensions','models','settings','pace']){
    await page.goto(`/#${route}`);await page.waitForTimeout(100);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),route).toBe(true);
  }
});


test('existing memory and extensions remain manageable through Settings', async ({ page }) => {
  await fixtureBridge(page); await page.goto('/#settings');
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /Memory|Extensions/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Saved memory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A little context. Your choice.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Manage extensions', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Local tools/ })).toBeVisible();
});


test('deleting a saved meeting requires confirmation and removes only that record', async ({ page }, testInfo) => {
  const meetings = [
    { id: 'recovery-selected', title: 'Interrupted review', status: 'interrupted', error: 'Saved audio is ready to recover.' },
    { id: 'completed-other', title: 'Keep this meeting', status: 'completed' },
    { id: 'recording-other', title: 'Live meeting', status: 'recording' },
    { id: 'finalizing-other', title: 'Processing meeting', status: 'finalizing' },
  ].map(meeting => ({ ...meeting, startedAt: '2026-11-14T00:00:00Z', segments: [{ speaker: 'Speaker 1', start: 1, end: 3, text: `${meeting.title} transcript` }], notes: `${meeting.title} notes` }));
  await fixtureBridge(page, meetings); await page.goto('/#meetings');
  const before = await page.evaluate(() => structuredClone((window as any).__workspaceFixture.state));
  const deleteCalls = () => page.evaluate(() => (window as any).__workspaceFixture.calls.filter((call: any) => call.method === 'meeting.delete'));
  await page.getByRole('button', { name: 'Delete meeting', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm delete', exact: true })).toBeVisible();
  expect(await deleteCalls()).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await deleteCalls()).toEqual([]);
  expect(await page.evaluate(() => (window as any).__workspaceFixture.state)).toEqual(before);
  for (const title of ['Live meeting', 'Processing meeting']) {
    await page.locator('.meeting-history-item').filter({ hasText: title }).click();
    await expect(page.getByRole('button', { name: 'Delete meeting', exact: true })).toBeDisabled();
  }
  await page.locator('.meeting-history-item').filter({ hasText: 'Interrupted review' }).click();
  await page.getByRole('button', { name: 'Delete meeting', exact: true }).click();
  for (const viewport of [{ width: 1180, height: 780 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'Confirm delete', exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: testInfo.outputPath(`meeting-delete-confirmation-${viewport.width}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.locator('.meeting-history-item')).toHaveCount(3);
  await expect(page.locator('.meeting-history-item').filter({ hasText: 'Interrupted review' })).toHaveCount(0);
  await expect(page.locator('.meeting-history-item.selected')).toContainText('Keep this meeting');
  expect(await deleteCalls()).toEqual([{ method: 'meeting.delete', params: { id: 'recovery-selected' } }]);
  const after = await page.evaluate(() => (window as any).__workspaceFixture.state);
  expect(after.meetings).toEqual(before.meetings.filter((meeting: Meeting) => meeting.id !== 'recovery-selected'));
  expect(after.settings).toEqual(before.settings);
});
