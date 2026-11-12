import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Download, LoaderCircle, Volume2, VolumeX } from 'lucide-react';
import { api, bytes, errorText, isNative, type AppState, type LocalModel, type Settings } from './api';
import { Pace, playPetSound, stopPetSound, usePetMood } from './Pace';
import './onboarding.css';

const stops = ['Meet', 'Pack', 'Access', 'Home'];
const titles = ['A little adventure starts here.', 'Small pack. Big possibilities.', 'Good company. Your rules.', 'Your desktop has a new resident.'];
const modelDescriptions: Record<string, string> = {
  'qwen3.5-4b': 'Chat, writing help & meeting summaries',
  'qwen3-tts-0.6b': 'A voice for Pace · spoken replies stay off until enabled',
  'whisper-turbo': 'Turn meeting audio into a transcript',
  'nemotron-diarization': 'Give each speaker their own label',
};
const access = [
  { kind: 'accessibility', title: 'Writing help', description: 'Read a selected field and apply edits you approve.' },
  { kind: 'microphone', title: 'Microphone', description: 'Dictation and your side of a meeting.' },
  { kind: 'screenRecording', title: 'Meeting audio', description: 'Hear other apps when you choose to record.' },
];

function PixelPaw() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" shapeRendering="crispEdges"><path d="M3 4h4v5H3zm7-2h4v5h-4zm7 2h4v5h-4zM1 11h4v4H1zm18 0h4v4h-4zM8 10h8v3h3v7H5v-7h3z" /></svg>;
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
  const heading = useRef<HTMLHeadingElement>(null);
  const mood = usePetMood('wave');
  const desktop = isNative() || Boolean(window.__DESKTOP_PETS_BRIDGE__);
  const chatReady = state.models.some(model => model.id === 'qwen3.5-4b' && model.installed);
  const recording = state.meetings.some(meeting => ['recording', 'finalizing'].includes(meeting.status));

  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    if (step !== 2 || !desktop) return;
    let cancelled = false;
    const check = () => { void api<Record<string, string>>('permissions.status').then(value => { if (!cancelled) setPermissions(value); }).catch(cause => { if (!cancelled) setError(errorText(cause)); }); };
    check();
    window.addEventListener('focus', check);
    return () => { cancelled = true; window.removeEventListener('focus', check); };
  }, [step, desktop]);

  const move = (next: number) => { setError(''); setStep(next); if (next === 3) mood.setAction('celebrate'); };
  const pet = () => {
    const action = mood.pet(); setPetted(true);
    if (state.settings.soundEnabled && !recording) playPetSound(action, state.settings.volume);
    void api('pet.action', { action }).catch(cause => setError(errorText(cause)));
  };
  const finish = async () => {
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
        <button className="onboarding-skip" disabled={saving || soundSaving} onClick={() => void finish()}>Skip adventure</button>
      </div>
    </header>

    <div className="onboarding-layout">
      <section className="onboarding-world" aria-label="Pace’s pixel campsite">
        <img className="onboarding-landscape" src="/onboarding/pace-camp.webp" alt="" />
        <div className="onboarding-location"><span aria-hidden="true" />Pace’s place</div>
        <div className="onboarding-pet-position">
          <span className="onboarding-pet-cue" aria-hidden="true">{step === 3 ? 'HOME, SWEET HOME' : petted ? 'FRIEND FOUND!' : 'OH, HELLO!'}</span>
          <button className="onboarding-pet" aria-label="Pet Pace" onClick={pet} disabled={saving}><Pace action={mood.action} size={224} /></button>
          <span className="onboarding-pet-ground" aria-hidden="true" />
        </div>
        <div className="onboarding-world-caption"><PixelPaw /><span>A little company.<br />A whole lot of possibility.</span></div>
      </section>

      <section className="onboarding-dialogue" aria-labelledby="onboarding-title">
        <nav className="onboarding-stops" aria-label="Adventure stops"><ol>{stops.map((stop, index) => <li key={stop}><button aria-current={step === index ? 'step' : undefined} disabled={saving} onClick={() => move(index)}><span className="onboarding-stop-marker" aria-hidden="true">{index < step ? <Check size={12} /> : index + 1}</span>{stop}</button></li>)}</ol></nav>
        <div className="onboarding-dialogue-body" key={step}>
          <h1 id="onboarding-title" ref={heading} tabIndex={-1}>{titles[step]}</h1>
          {step === 0 && <>
            <p className="onboarding-lead">Meet Pace. Your tiny, curious companion for the big things on your desktop.</p>
            <div className="onboarding-hello"><span className="onboarding-speaker">PACE</span><p>“I brought the enthusiasm.<br />You bring the snacks.”</p><span className="onboarding-dialogue-arrow" aria-hidden="true" /></div>
            <p className="onboarding-pat-hint" role="status">{petted ? 'Pace likes you already.' : 'Go on, give Pace a little pat.'}</p>
            <p className="onboarding-small">A few quick stops, then you’re home. You can take the scenic route or skip ahead.</p>
          </>}
          {step === 1 && <>
            <p className="onboarding-lead">Pace is good company out of the box. Add local models for a few extra talents.</p>
            {!desktop && <p className="onboarding-preview-note">You’re exploring the browser preview. Model downloads live in the desktop app.</p>}
            <div className="onboarding-loadout">{state.models.map(model => {
              const downloading = installing.includes(model.id) || ['downloading', 'installing'].includes(model.status);
              const progress = typeof model.progress === 'number' ? Math.min(100, Math.max(0, model.progress <= 1 ? model.progress * 100 : model.progress)) : undefined;
              return <div className="onboarding-model" key={model.id}>
                <div><strong>{model.role}</strong><p>{modelDescriptions[model.id] || model.name}</p><span>{model.name} · {bytes(model.sizeBytes)}</span>{model.error && <p className="onboarding-model-error">{model.error}</p>}</div>
                {model.installed ? <span className="onboarding-ready"><Check size={15} />Ready</span> : downloading ? <div className="onboarding-download"><span role="status">{progress === undefined ? 'Downloading…' : `${Math.round(progress)}%`}</span><progress max={100} value={progress} aria-label={`${model.name} download progress`} /></div> : <button className="onboarding-item-button" aria-label={`Download ${model.name}`} disabled={!desktop || saving} onClick={() => void install(model)}><Download size={14} />Download</button>}
              </div>;
            })}</div>
            <p className="onboarding-small">All optional. Downloads can continue while you explore. Meeting notes use chat, transcription and speaker labels.</p>
          </>}
          {step === 2 && <>
            <p className="onboarding-lead">Open the doors you need. Pace will ask before stepping into your day.</p>
            {!desktop && <p className="onboarding-preview-note">Desktop access is available in the native app.</p>}
            <div className="onboarding-access">{access.map(item => <div className="onboarding-access-row" key={item.kind}><div><strong>{item.title}</strong><p>{item.description}</p></div>{permissions[item.kind] === 'granted' ? <span className="onboarding-ready"><Check size={15} />Allowed</span> : <button className="onboarding-item-button" aria-label={`Allow ${item.title}`} disabled={!desktop || Boolean(permissionBusy) || saving} onClick={() => void allow(item.kind)}>{permissionBusy === item.kind ? <LoaderCircle className="spin" size={14} /> : null}{permissions[item.kind] === 'denied' ? 'Review access' : 'Allow'}</button>}</div>)}</div>
            <div className="onboarding-rules"><span className="onboarding-rule-mark" aria-hidden="true"><PixelPaw /></span><p>Recording starts when you choose Record.<br />Application memory is <strong>{state.memory.enabled ? 'on' : 'off'}</strong>; manage it anytime in Memory.</p></div>
            <p className="onboarding-small">Access can wait. You can revisit these choices in Settings.</p>
          </>}
          {step === 3 && <>
            <p className="onboarding-lead">A writing buddy. A meeting sidekick. Or just a small cheetah cheering you on.</p>
            <div className="onboarding-home-note"><span className="onboarding-speaker">A NOTE FROM PACE</span><p>“Big day? Tiny steps.<br />We’ve got this.”</p></div>
            <dl className="onboarding-shortcuts"><div><dt>Hide or bring back Pace</dt><dd><kbd>{state.settings.hideShortcut}</kbd></dd></div><div><dt>Call up writing help</dt><dd><kbd>{state.settings.commandShortcut}</kbd></dd></div></dl>
            <p className="onboarding-small">{chatReady ? 'Your chat model is ready. Say hello when you get in.' : 'Start with a little company. Local models will be waiting when you need them.'} Replay this adventure anytime in Settings.</p>
          </>}
          {error && <div className="onboarding-error" role="alert">{error}</div>}
        </div>
        <footer className="onboarding-controls">
          {step > 0 ? <button className="onboarding-back" disabled={saving} onClick={() => move(step - 1)}><ArrowLeft size={16} />Back</button> : <span className="onboarding-time">Make yourself at home.</span>}
          <button className="onboarding-primary" disabled={saving || soundSaving} onClick={() => step === 3 ? void finish() : move(step + 1)}>{saving ? <><LoaderCircle className="spin" size={16} />Saving…</> : <>{['Let’s pack', 'Next stop', 'Head home', 'Enter workspace'][step]}<ArrowRight size={17} /></>}</button>
        </footer>
      </section>
    </div>
    <footer className="onboarding-footer"><span>One pet. Your device. Your adventure.</span><span>{!desktop ? 'Browser preview' : 'Made to feel a little more alive.'}</span></footer>
  </main>;
}
