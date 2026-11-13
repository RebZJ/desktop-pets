import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Download, Keyboard, LoaderCircle, Mic, Volume2, VolumeX } from 'lucide-react';
import { api, errorText, isNative, subscribe, type AppState, type LocalModel, type Settings } from './api';
import { Pace, playPetSound, stopPetSound, usePetMood } from './Pace';
import { ShortcutInput } from './ShortcutInput';
import './onboarding.css';

const stops = ['Pack', 'Meet', 'Keys', 'Access', 'Home'];
const titles = ['A tiny pack for your first tricks.', 'A little adventure starts here.', 'Keys that feel like yours.', 'Good company. Your rules.', 'Your desktop has a new resident.'];
const languages = [
  { id: 'en', label: 'English', model: 'moonshine-tiny-en' },
  { id: 'zh', label: 'Chinese', model: 'moonshine-tiny-zh' },
  { id: 'ja', label: 'Japanese', model: 'moonshine-tiny-ja' },
  { id: 'es', label: 'Spanish', model: 'moonshine-tiny-es' },
  { id: 'auto', label: 'Automatic · Whisper Turbo', model: 'whisper-turbo' },
];
const modelDescriptions: Record<string, string> = {
  'qwen3.5-4b': 'Local brain for chat & meeting notes',
  'kitten-tts-micro-0.8-onnx': 'Pace’s English voice · Kiki',
  'moonshine-tiny-en': 'Fast English dictation',
  'moonshine-tiny-zh': 'Fast Chinese dictation',
  'moonshine-tiny-ja': 'Fast Japanese dictation',
  'moonshine-tiny-es': 'Fast Spanish dictation',
  'whisper-turbo': 'Multilingual dictation & meeting transcripts',
};
const shortcutActions = [
  { label: 'Dictation window', field: 'commandShortcut' },
  { label: 'Dictate', field: 'dictationShortcut' },
  { label: 'Quick Hide', field: 'hideShortcut' },
] as const;
const access = [
  { kind: 'accessibility', title: 'Accessibility', description: 'Type dictated words into the app you choose.' },
  { kind: 'microphone', title: 'Microphone', description: 'Only used when you start dictation, voice chat or a meeting recording.' },
  { kind: 'screenRecording', title: 'Meeting audio', description: 'Hear other apps when you choose to record.' },
];

function PixelPaw() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" shapeRendering="crispEdges"><path d="M3 4h4v5H3zm7-2h4v5h-4zm7 2h4v5h-4zM1 11h4v4H1zm18 0h4v4h-4zM8 10h8v3h3v7H5v-7h3z" /></svg>;
}

function modelSize(size: number) {
  if (size >= 1_000_000_000) return `${(size / 1_000_000_000).toFixed(2).replace(/0$/, '')} GB`;
  return `${(size / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`;
}

export function Onboarding({ state, refresh, onSettings, onComplete }: {
  state: AppState;
  refresh: () => Promise<void>;
  onSettings: (settings: Settings) => void;
  onComplete: (settings: Settings) => void;
}) {
  const [step, setStep] = useState(0);
  const [petted, setPetted] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [soundSaving, setSoundSaving] = useState(false);
  const [installing, setInstalling] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<Record<string, string>>({});
  const [permissionBusy, setPermissionBusy] = useState('');
  const [settingBusy, setSettingBusy] = useState('');
  const [settingStatus, setSettingStatus] = useState('');
  const [shortcutTest, setShortcutTest] = useState('');
  const [dictationText, setDictationText] = useState('');
  const [dictationRecording, setDictationRecording] = useState(false);
  const [dictationBusy, setDictationBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const dictationField = useRef<HTMLTextAreaElement>(null);
  const mood = usePetMood('wave');
  const desktop = isNative() || Boolean(window.__DESKTOP_PETS_BRIDGE__);
  const native = isNative();
  const notesReady = state.models.some(model => model.id === 'qwen3.5-4b' && model.installed);
  const selectedLanguage = state.settings.dictationLanguage || 'en';
  const dictationModel = state.models.find(model => model.id === languages.find(language => language.id === selectedLanguage)?.model);
  const packModels = [dictationModel, state.models.find(model => model.id === 'kitten-tts-micro-0.8-onnx'), state.models.find(model => model.id === 'qwen3.5-4b')].filter((model): model is LocalModel => Boolean(model));
  const recording = state.meetings.some(meeting => ['recording', 'finalizing'].includes(meeting.status));

  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    if (step !== 3 || !desktop) return;
    let cancelled = false;
    const check = () => { void api<Record<string, string>>('permissions.status').then(value => { if (!cancelled) setPermissions(value); }).catch(cause => { if (!cancelled) setError(errorText(cause)); }); };
    check();
    window.addEventListener('focus', check);
    return () => { cancelled = true; window.removeEventListener('focus', check); };
  }, [step, desktop]);

  useEffect(() => {
    if (step !== 2 || !native) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void subscribe((event, data) => {
      const payload = data as { action?: string; phase?: string; text?: string; error?: string } | null;
      if (event === 'shortcut.triggered' && payload?.action && !cancelled) setShortcutTest(payload.action);
      if (event === 'dictation.state' && payload && !cancelled) {
        if (payload.phase === 'recording') setDictationRecording(true);
        else if (['transcribing', 'draft', 'inserted', 'error'].includes(payload.phase || '')) setDictationRecording(false);
        if (payload.phase === 'draft' && payload.text) setDictationText(payload.text);
        if (payload.phase === 'error' && payload.error) setError(payload.error);
      }
      if (event === 'dictation.finished' && payload?.text && !cancelled) setDictationText(payload.text);
    }).then(unlisten => { if (cancelled) unlisten(); else dispose = unlisten; });
    return () => { cancelled = true; dispose?.(); };
  }, [step, native]);

  useEffect(() => {
    if (step !== 3 || !native) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void subscribe((event, data) => {
      const payload = data as { phase?: string; text?: string; error?: string } | null;
      if (!payload || cancelled) return;
      if (event === 'dictation.state') {
        if (payload.phase === 'recording') setDictationRecording(true);
        else if (['transcribing', 'draft', 'inserted', 'error'].includes(payload.phase || '')) setDictationRecording(false);
        if (payload.phase === 'draft' && payload.text) setDictationText(payload.text);
        if (payload.phase === 'error' && payload.error) setError(payload.error);
      } else if (event === 'dictation.finished' && payload.text) setDictationText(payload.text);
    }).then(unlisten => { if (cancelled) unlisten(); else dispose = unlisten; });
    return () => { cancelled = true; dispose?.(); };
  }, [step, native]);

  const stopDictationBeforeLeaving = async () => {
    if (!dictationRecording) return true;
    setError(''); setDictationBusy(true);
    try {
      const result = await api<{ recording?: boolean; text?: string; busy?: boolean }>('dictation.toggle');
      if (result.busy) { setError('Dictation is still finishing. Wait a moment before leaving.'); return false; }
      if (result.text) setDictationText(result.text);
      setDictationRecording(false);
      return true;
    } catch (cause) { setError(errorText(cause)); return false; }
    finally { setDictationBusy(false); }
  };
  const move = async (next: number) => {
    if (saving || dictationBusy) return;
    if (dictationRecording && !await stopDictationBeforeLeaving()) return;
    setError(''); setSettingStatus(''); setStep(next); if (next === 4) mood.setAction('celebrate');
  };
  const pet = () => {
    const action = mood.pet(); setPetted(true);
    if (state.settings.soundEnabled && !recording) playPetSound(action, state.settings.volume);
    void api('pet.action', { action }).catch(cause => setError(errorText(cause)));
  };
  const finish = async () => {
    if (dictationBusy || !await stopDictationBeforeLeaving()) return;
    setError(''); setSaving(true);
    try { const settings = await api<Settings>('settings.update', { patch: { onboardingCompleted: true } }); onComplete(settings); }
    catch (cause) { setError(`Couldn’t save your adventure. ${errorText(cause)} Try again.`); }
    finally { setSaving(false); }
  };
  const toggleSound = async () => {
    setSoundSaving(true); setError('');
    try { const settings = await api<Settings>('settings.update', { patch: { soundEnabled: !state.settings.soundEnabled } }); onSettings(settings); if (!settings.soundEnabled) stopPetSound(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setSoundSaving(false); }
  };
  const install = async (model: LocalModel) => {
    setError(''); setInstalling(current => [...current, model.id]);
    try { await api('models.install', { id: model.id }); await refresh(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setInstalling(current => current.filter(id => id !== model.id)); }
  };
  const updateSetting = async (key: keyof Settings, value: string) => {
    setError(''); setSettingStatus(''); setSettingBusy(String(key));
    try {
      const settings = await api<Settings>('settings.update', { patch: { [key]: value } });
      onSettings(settings); if (String(key).endsWith('Shortcut')) setShortcutTest(''); setSettingStatus(key === 'dictationLanguage' ? 'Dictation language saved.' : 'Shortcut saved.'); return true;
    } catch (cause) { setError(errorText(cause)); return false; }
    finally { setSettingBusy(''); }
  };
  const saveSettingText = async (key: 'dictationVocabulary', value: string) => {
    setError(''); setSettingStatus(''); setSettingBusy(key);
    try {
      const settings = await api<Settings>('settings.update', { patch: { [key]: value } });
      onSettings(settings); setSettingStatus('Vocabulary saved.');
    } catch (cause) { setError(errorText(cause)); }
    finally { setSettingBusy(''); }
  };
  const toggleDictation = async () => {
    setError(''); setDictationBusy(true);
    if (!dictationRecording) dictationField.current?.focus();
    try {
      const result = await api<{ recording?: boolean; text?: string; busy?: boolean }>('dictation.toggle');
      if (result.busy) { setError('Dictation is still finishing. Try again in a moment.'); return; }
      setDictationRecording(Boolean(result.recording));
      if (result.text) setDictationText(result.text);
    } catch (cause) { setError(errorText(cause)); setDictationRecording(false); }
    finally { setDictationBusy(false); }
  };
  const allow = async (kind: string) => {
    setError(''); setPermissionBusy(kind);
    try { setPermissions(await api<Record<string, string>>('permissions.request', { kind })); }
    catch (cause) { setError(errorText(cause)); }
    finally { setPermissionBusy(''); }
  };

  return <main className={`onboarding-shell onboarding-stop-${step}`} aria-label="Welcome to Desktop Pets">
    <header className="onboarding-header">
      <span className="onboarding-brand"><PixelPaw />desktop pets<span className="onboarding-brand-dot">.</span></span>
      <div className="onboarding-header-actions">
        <button className="onboarding-sound" aria-label={state.settings.soundEnabled ? 'Mute pet sounds' : 'Enable pet sounds'} aria-pressed={state.settings.soundEnabled} disabled={soundSaving || saving} onClick={() => void toggleSound()}>{state.settings.soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}</button>
        <button className="onboarding-skip" disabled={saving || soundSaving || dictationBusy} onClick={() => void finish()}>Skip adventure</button>
      </div>
    </header>

    <div className="onboarding-layout">
      <section className="onboarding-world" aria-label="Pace’s pixel campsite">
        <img className="onboarding-landscape" src="/onboarding/pace-camp.webp" alt="" />
        <div className="onboarding-location"><span aria-hidden="true" />Pace’s place</div>
        <div className="onboarding-pet-position">
          <span className="onboarding-pet-cue" aria-hidden="true">{step === 4 ? 'HOME, SWEET HOME' : petted ? 'FRIEND FOUND!' : 'OH, HELLO!'}</span>
          <button className="onboarding-pet" aria-label="Pet Pace" onClick={pet} disabled={saving}><Pace action={mood.action} size={224} /></button>
          <span className="onboarding-pet-ground" aria-hidden="true" />
        </div>
        <div className="onboarding-world-caption"><PixelPaw /><span>A little company.<br />A whole lot of possibility.</span></div>
      </section>

      <section className="onboarding-dialogue" aria-labelledby="onboarding-title">
        <nav className="onboarding-stops" aria-label="Adventure stops"><ol>{stops.map((stop, index) => <li key={stop}><button aria-current={step === index ? 'step' : undefined} disabled={saving || dictationBusy} onClick={() => void move(index)}><span className="onboarding-stop-marker" aria-hidden="true">{index < step ? <Check size={12} /> : index + 1}</span>{stop}</button></li>)}</ol></nav>
        <div className="onboarding-dialogue-body" key={step}>
          <h1 id="onboarding-title" ref={heading} tabIndex={-1}>{titles[step]}</h1>
          {step === 0 && <>
            <p className="onboarding-lead">Choose one small dictation pack first. Add the meeting brain when you need notes and a copilot.</p>
            {!desktop && <p className="onboarding-preview-note">Browser preview can’t download models. The desktop app shows real model sizes and progress.</p>}
            <label className="onboarding-field-label" htmlFor="dictation-language">Dictation language</label>
            <select id="dictation-language" className="onboarding-select" value={selectedLanguage} disabled={Boolean(settingBusy) || saving} onChange={event => void updateSetting('dictationLanguage', event.target.value)}>
              {languages.map(language => <option value={language.id} key={language.id}>{language.label}</option>)}
            </select>
            <div className="onboarding-loadout">{packModels.map(model => {
              const downloading = installing.includes(model.id) || ['downloading', 'installing'].includes(model.status);
              const progress = typeof model.progress === 'number' ? Math.min(100, Math.max(0, model.progress <= 1 ? model.progress * 100 : model.progress)) : undefined;
              return <div className="onboarding-model" key={model.id}>
                <div><strong>{model.id === dictationModel?.id ? 'Quick dictation' : 'Meeting brain'}</strong><p>{modelDescriptions[model.id] || model.name}</p><span>{model.name} · {modelSize(model.sizeBytes)}</span>{model.error && <p className="onboarding-model-error">{model.error}</p>}</div>
                {model.installed ? <span className="onboarding-ready"><Check size={15} />Ready</span> : downloading ? <div className="onboarding-download"><span role="status">{progress === undefined ? 'Downloading…' : `${Math.round(progress)}%`}</span><progress max={100} value={progress} aria-label={`${model.name} download progress`} /></div> : <button className="onboarding-item-button" aria-label={`Download ${model.name}`} disabled={!desktop || saving} onClick={() => void install(model)}><Download size={14} />Download</button>}
              </div>;
            })}</div>
            {selectedLanguage === 'auto' && <p className="onboarding-small">Automatic language detection uses Whisper Turbo. The smaller Moonshine packs are language-specific.</p>}
            <p className="onboarding-small">Downloads start only when you choose them and can continue while you explore. The other languages, large transcription model and speaker labels are in Local Models.</p>
          </>}
          {step === 1 && <>
            <p className="onboarding-lead">Meet Pace. Your tiny, curious companion for the big things on your desktop.</p>
            <div className="onboarding-hello"><span className="onboarding-speaker">PACE</span><p>“I brought the enthusiasm.<br />You bring the snacks.”</p><span className="onboarding-dialogue-arrow" aria-hidden="true" /></div>
            <p className="onboarding-pat-hint" role="status">{petted ? 'Pace likes you already.' : 'Go on, give Pace a little pat.'}</p>
            <p className="onboarding-small">{notesReady ? 'Your local brain is ready for meeting notes and questions.' : 'Dictation works without the optional meeting brain.'}</p>
          </>}
          {step === 2 && <>
            <p className="onboarding-lead">Pick key combinations that fit your hands. Changes save only after the desktop accepts them.</p>
            {!native && <p className="onboarding-preview-note">Browser preview can show your choices, but global shortcut keys only work in the desktop app.</p>}
            <div className="onboarding-shortcut-list">
              {shortcutActions.map(action => {
                const detected = shortcutTest === ({ 'Dictation window': 'talk', Dictate: 'dictate', 'Quick Hide': 'hide' } as const)[action.label];
                return <div className="onboarding-shortcut-row" key={action.field}>
                  <span>{action.label}<small>{detected ? 'Shortcut detected' : action.field === 'dictationShortcut' ? 'Hold to speak · tap to start or stop' : 'Press the keys to try it'}</small></span>
                  <ShortcutInput label={`${action.label} shortcut`} field={action.field} settings={state.settings} disabled={saving} onSave={value => updateSetting(action.field, value)} />
                </div>;
              })}
            </div>
            <div className="onboarding-key-try"><button className="onboarding-item-button" disabled={!native} onClick={() => void api('window.talk').catch(cause => setError(errorText(cause)))}><Keyboard size={14} />Open dictation</button><span>Opens the dictation draft. It doesn’t verify a global key.</span></div>
          </>}
          {step === 3 && <>
            <p className="onboarding-lead">Try your microphone here, then choose only the access you want Pace to have.</p>
            {!native && <p className="onboarding-preview-note">Native shortcuts and microphone access can only be tested in the desktop app.</p>}
            <label className="onboarding-field-label" htmlFor="dictation-practice">Dictation practice</label>
            <textarea ref={dictationField} id="dictation-practice" className="onboarding-practice" value={dictationText} onChange={event => setDictationText(event.target.value)} placeholder="Type here, or start Dictate and review the words before using them…" />
            <button className="onboarding-item-button onboarding-dictate" disabled={!native || dictationBusy || saving} onClick={() => void toggleDictation()}>{dictationBusy ? <LoaderCircle size={14} className="spin" /> : <Mic size={14} />}{dictationRecording ? 'Stop dictation' : 'Try dictation'}</button>
            <div className="onboarding-access">{access.map(item => <div className="onboarding-access-row" key={item.kind}><div><strong>{item.title}</strong><p>{item.description}</p></div>{permissions[item.kind] === 'granted' ? <span className="onboarding-ready"><Check size={15} />Allowed</span> : permissions[item.kind] === 'on-recording' || permissions[item.kind] === 'unsupported' ? <span className="onboarding-small">{permissions[item.kind] === 'on-recording' ? 'Asked when recording' : 'Unavailable on this platform'}</span> : <button className="onboarding-item-button" aria-label={`Allow ${item.title}`} disabled={!desktop || Boolean(permissionBusy) || saving} onClick={() => void allow(item.kind)}>{permissionBusy === item.kind ? <LoaderCircle className="spin" size={14} /> : null}{permissions[item.kind] === 'denied' ? 'Review access' : 'Allow'}</button>}</div>)}</div>
            <label className="onboarding-field-label" htmlFor="dictation-vocabulary">Names and words Pace should recognize</label>
            <textarea id="dictation-vocabulary" className="onboarding-practice onboarding-vocabulary" maxLength={4000} defaultValue={state.settings.dictationVocabulary || ''} placeholder="Names, places, acronyms… separated by commas" />
            <button className="onboarding-item-button onboarding-save-vocabulary" disabled={Boolean(settingBusy) || saving} onClick={event => { const value = event.currentTarget.previousElementSibling as HTMLTextAreaElement; void saveSettingText('dictationVocabulary', value.value); }}>Save vocabulary</button>
            <div className="onboarding-rules"><span className="onboarding-rule-mark" aria-hidden="true"><PixelPaw /></span><p>Recording starts only when you choose Dictate. Quick Hide also hides this setup; use Pace’s menu or the menu bar to bring it back. macOS may still show Pace in full-display capture.</p></div>
            <p className="onboarding-small">Accessibility, microphone and screen access are separate and optional. You can change them later in Settings.</p>
          </>}
          {step === 4 && <>
            <p className="onboarding-lead">A dictation companion, a meeting helper, or just a small cheetah cheering you on.</p>
            <div className="onboarding-home-note"><span className="onboarding-speaker">A NOTE FROM PACE</span><p>“Big day? Tiny steps.<br />We’ve got this.”</p></div>
            <dl className="onboarding-shortcuts"><div><dt>Dictation window</dt><dd><kbd>{state.settings.commandShortcut}</kbd></dd></div><div><dt>Dictate</dt><dd><kbd>{state.settings.dictationShortcut}</kbd></dd></div><div><dt>Quick Hide</dt><dd><kbd>{state.settings.hideShortcut}</kbd></dd></div></dl>
            <p className="onboarding-small">{notesReady ? 'Your local brain is ready for meeting notes.' : 'Start with Pace. Add the local brain whenever you want.'} Replay this adventure anytime in Settings.</p>
          </>}
          {settingStatus && <p className="onboarding-setting-status" role="status">{settingStatus}</p>}
          {error && <div className="onboarding-error" role="alert">{error}</div>}
        </div>
        <footer className="onboarding-controls">
          {step > 0 ? <button className="onboarding-back" disabled={saving || dictationBusy} onClick={() => void move(step - 1)}><ArrowLeft size={16} />Back</button> : <span className="onboarding-time">Make yourself at home.</span>}
          <button className="onboarding-primary" disabled={saving || soundSaving || dictationBusy} onClick={() => step === 4 ? void finish() : void move(step + 1)}>{saving ? <><LoaderCircle className="spin" size={16} />Saving…</> : dictationBusy && dictationRecording ? <><LoaderCircle className="spin" size={16} />Stopping dictation…</> : <>{['Meet Pace', 'Set up keys', 'Choose access', 'Go home', 'Enter workspace'][step]}<ArrowRight size={17} /></>}</button>
        </footer>
      </section>
    </div>
    <footer className="onboarding-footer"><span>One pet. Your device. Your adventure.</span><span>{!desktop ? 'Browser preview' : 'Made to feel a little more alive.'}</span></footer>
  </main>;
}
