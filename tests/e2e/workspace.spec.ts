import { test, expect, type Page } from '@playwright/test';

async function fixtureBridge(page: Page) {
  await page.addInitScript(() => {
    const settings = { language: 'auto', voice: 'Ono_Anna', pitch: 1.05, rate: 1, volume: .65, petSize: 160, activePack: 'pace', speechEnabled: false, soundEnabled: true, memoryEnabled: false, allowedApps: [], allowedDomains: [], retentionDays: 30, meetingTips: true, clickThrough: false, hideShortcut: 'Alt+Shift+Space', commandShortcut: 'Alt+Space' };
    const models = ['qwen3.5-4b','qwen3-tts-0.6b','whisper-turbo','nemotron-diarization'].map((id, i) => ({ id, name: ['Qwen 3.5 · 4B','Qwen 3 · Voice','Whisper · Turbo','Nemotron 3 · Speakers'][i], role: ['Chat & writing','Voice','Transcription','Speakers'][i], sizeBytes: 100_000_000, installed: true, status: 'installed' }));
    const state = { settings, models, meetings: [] as any[], extensions: [] as any[], packs: [{id:'pace',name:'Pace',author:'Desktop Pets'}], memory: { enabled:false,applications:[] as string[] }, pet:{visible:true,action:'idle'} };
    let memories = [{ id:'fixture-memory',app:'TextEdit',title:'Synthetic release plan',text:'The synthetic launch review is Friday.',createdAt:'2026-11-13T00:00:00Z' }];
    const messages: any[] = [];
    (window as any).__DESKTOP_PETS_BRIDGE__ = async (method: string, params: any) => {
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
      if (method==='meeting.delete') {state.meetings=[];return {deleted:true};}
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
  });
}

test('browser preview reports native requirement without inventing a reply',async({page})=>{
  await page.goto('/');await expect(page.getByRole('heading',{name:/A little company/})).toBeVisible();
  await page.getByLabel('Message Pace').fill('Hello');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('needs the desktop app');
  await expect(page.locator('.message.assistant')).toHaveCount(0);
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

test('chat, writing preview and stale edit protection use the bridge contract',async({page})=>{
  await fixtureBridge(page);await page.goto('/');
  await page.getByLabel('Message Pace').fill('Help me plan');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.locator('.message.assistant')).toContainText('Synthetic test reply');
  await page.getByRole('button',{name:'Writing help',exact:true}).click();
  await page.getByRole('button',{name:'Use selected text'}).click();
  await expect(page.getByLabel('Your words',{exact:true})).toHaveValue('This sentence is very very unclear.');
  await page.getByRole('button',{name:'Rewrite',exact:true}).click();
  await expect(page.getByLabel('Edit Pace’s suggestion')).toHaveValue('This sentence is clear.');
  await page.getByRole('button',{name:'Apply revision'}).click();
  await expect(page.getByRole('alert')).toContainText('selection changed');
  await expect(page.getByLabel('Edit Pace’s suggestion')).toHaveValue('This sentence is clear.');
});

test('meeting lifecycle and notes display keep the saved transcript',async({page})=>{
  await fixtureBridge(page);await page.goto('/#meetings');
  await page.getByLabel('Meeting title',{exact:true}).fill('Synthetic release review');
  await page.getByRole('button',{name:'Start meeting',exact:true}).click();
  await expect(page.getByRole('button',{name:/Stop.*meeting|Finish meeting|Stop recording/})).toBeVisible();
  await page.getByRole('button',{name:/Stop.*meeting|Finish meeting|Stop recording/}).click();
  await expect(page.getByText('We will review the release Friday.')).toBeVisible();
  await page.getByRole('tab',{name:'Notes & actions',exact:true}).click();
  await expect(page.getByText(/Synthetic release review on Friday/)).toBeVisible();
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
  await page.goto('/#settings');await page.getByLabel('Response language').selectOption('ja');
  await page.reload();await expect(page.getByLabel('Response language')).toHaveValue('ja');
  await page.setViewportSize({width:390,height:844});
  for(const route of ['chat','writing','meetings','memory','extensions','models','settings','pace']){
    await page.goto(`/#${route}`);await page.waitForTimeout(100);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),route).toBe(true);
  }
});
