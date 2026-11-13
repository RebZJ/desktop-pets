import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Sparkles, Copy, FileText, LoaderCircle, MessageCircle, Mic, Settings as SettingsIcon, Square, Volume2, VolumeX, X } from 'lucide-react';
import { api, errorText, isNative, subscribe, type AppState, type Settings } from './api';
import { Pace, playPetSound, usePetMood, validAction } from './Pace';

type WritingAvailability = { available: boolean; reason?: string; app?: string; shortcut?: string; permissionRequired?: boolean };

function dictationModelMissing(state: AppState) {
  const language = (state.settings.dictationLanguage || state.settings.language || 'en').toLowerCase().split(/[-_]/)[0];
  const whisper = state.models.find(model => model.id === 'whisper-turbo');
  const moonshine = state.models.find(model => model.id === `moonshine-tiny-${language}`);
  return whisper?.installed === false && (!['en', 'zh', 'ja', 'es'].includes(language) || moonshine?.installed === false);
}

export function DesktopPet({ state }: { state: AppState }) {
  const mood = usePetMood(validAction(state.pet.action));
  const [menu, setMenu] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [hint, setHint] = useState('');
  const [writing, setWriting] = useState<WritingAvailability>();
  const overlay = useRef<HTMLDivElement>(null);
  const revealed = useRef(false);
  const availabilityVersion = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [dictationPhase, setDictationPhase] = useState('idle');
  const [hiding, setHiding] = useState(false);
  const [micPending, setMicPending] = useState(false);
  const [error, setError] = useState('');
  const down = useRef<{ x: number; y: number } | undefined>(undefined);
  const dragged = useRef(false);
  useEffect(() => { document.documentElement.classList.add('overlay-document'); return () => document.documentElement.classList.remove('overlay-document'); }, []);
  useEffect(() => mood.setAction(validAction(state.pet.action)), [state.pet.action]);
  useEffect(() => {
    let dispose: (() => void) | undefined; let cancelled = false;
    void subscribe((event, data) => {
      if (event === 'dictation.state') setDictationPhase((data as { phase?: string })?.phase || 'idle');
      if (event === 'pet.visibility' && data) setHiding(!(data as { visible: boolean }).visible);
    }).then(value => { if (cancelled) value(); else dispose = value; });
    return () => { cancelled = true; dispose?.(); };
  }, []);
  useEffect(() => () => { clearTimeout(hideTimer.current); revealed.current = false; availabilityVersion.current++; }, []);
  const revealControls = () => {
    clearTimeout(hideTimer.current);
    if (revealed.current) return;
    const version = ++availabilityVersion.current;
    revealed.current = true; setControlsOpen(true); setWriting(undefined);
    void api<WritingAvailability>('completion.available').then(value => {
      if (revealed.current && availabilityVersion.current === version) setWriting(value);
    }).catch(() => {});
  };
  const leaveControls = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (overlay.current?.querySelector(':focus-visible')) return;
      revealed.current = false; availabilityVersion.current++; setControlsOpen(false); setHint('');
    }, 420);
  };
  const open = (method: string, params = {}) => { setError(''); setMenu(false); void api(method, params).catch(cause => setError(errorText(cause))); };
  const dictate = async () => {
    if (micPending) return;
    if (dictationPhase !== 'recording' && dictationModelMissing(state)) { open('window.main', { page: 'models' }); return; }
    setMicPending(true); setError('');
    try { await api('dictation.toggle'); } catch (cause) { setError(errorText(cause)); }
    finally { setMicPending(false); }
  };
  const pet = () => {
    const action = mood.pet();
    if (state.settings.soundEnabled && !state.meetings.some(meeting => ['recording', 'finalizing'].includes(meeting.status))) playPetSound(action, state.settings.volume, state.packs.find(pack => pack.id === state.settings.activePack));
    open('pet.action', { action });
  };
  const dictateHint = dictationPhase === 'recording' ? 'Stop dictation' : dictationPhase === 'transcribing' ? 'Transcribing…' : 'Dictate';
  const shortcutHint = (label: string, shortcut?: string) => shortcut ? `${label} · ${shortcut}` : label;
  const writeHint = writing?.available ? shortcutHint(`Write${writing.app ? ` in ${writing.app}` : ''}`, writing.shortcut || state.settings.completionShortcut) : writing?.reason || shortcutHint('Write at your cursor', state.settings.completionShortcut);
  const writeHidden = writing?.available === false && !writing.permissionRequired;
  return <div ref={overlay} className={`pet-window companion-pet ${controlsOpen ? 'controls-open' : ''} ${hiding ? 'pet-hiding' : ''}`} onPointerEnter={revealControls} onPointerLeave={leaveControls} onFocus={event => { if (event.target.matches(':focus-visible')) revealControls(); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) leaveControls(); }} onContextMenu={event => { event.preventDefault(); setMenu(!menu); }}>
    {(dictationPhase === 'recording' || dictationPhase === 'transcribing') && <span className="sr-only" role="status">{dictationPhase === 'recording' ? 'Listening…' : 'Catching words…'}</span>}
    {error && <p className="pet-error" role="alert">{error}{error.includes('Local models') && <button className="cloud-access" onClick={() => open('window.main', { page: 'models' })}>Open Local models</button>}</p>}
    {menu && <div className="pet-menu"><button onClick={() => open('window.meeting')}><FileText size={14} />Meeting notes</button><button onClick={() => open('window.main', { page: 'settings', section: 'shortcuts' })}>Controls & look</button><button onClick={() => { mood.setAction('celebrate'); if (state.settings.soundEnabled && !state.meetings.some(meeting => ['recording', 'finalizing'].includes(meeting.status))) playPetSound('celebrate', state.settings.volume); open('pet.action', { action: 'celebrate' }); }}>A tiny victory!</button><button onClick={() => open('pet.toggle', { visible: false })}>Hide Pace</button></div>}
    <button className="overlay-pet-button" aria-label="Pet Pace; drag to move; right-click for menu" aria-controls="pace-actions" aria-expanded={controlsOpen} onKeyDown={event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowRight' && !(event.key === 'Tab' && !event.shiftKey)) return;
      event.preventDefault(); revealControls();
      requestAnimationFrame(() => overlay.current?.querySelector<HTMLButtonElement>('.pet-controls button:not(:disabled):not([hidden])')?.focus());
    }} onPointerDown={event => { down.current = { x: event.clientX, y: event.clientY }; dragged.current = false; }} onPointerMove={event => {
      if (!down.current || dragged.current || Math.hypot(event.clientX - down.current.x, event.clientY - down.current.y) <= 7) return;
      dragged.current = true;
      if (isNative()) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().startDragging()).catch(cause => setError(errorText(cause)));
    }} onPointerUp={() => { down.current = undefined; }} onClick={event => { if (event.detail !== 0 && dragged.current) { dragged.current = false; return; } pet(); }}><Pace action={mood.action} size={state.settings.petSize} pack={state.packs.find(pack => pack.id === state.settings.activePack)} label={`Pace is ${mood.action}`} /></button>
    <nav id="pace-actions" className="pet-controls" aria-label="Pace actions" onKeyDown={event => {
      if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([hidden])')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[next]?.focus();
    }} onMouseLeave={() => setHint('')} onFocus={event => setHint(event.target.getAttribute('title') || '')} onMouseOver={event => { const button = (event.target as Element).closest('button'); if (button) setHint(button.title); }}>
      <button className="pet-talk" aria-label="Talk" title={shortcutHint('Talk', state.settings.commandShortcut)} aria-describedby={hint ? 'pet-action-hint' : undefined} onClick={() => open('window.talk')}><MessageCircle size={17} /></button>
      <button className="pet-dictate" aria-label={dictationPhase === 'recording' ? 'Stop dictation' : 'Dictate into your app'} title={shortcutHint(dictateHint, state.settings.dictationShortcut)} aria-describedby={hint ? 'pet-action-hint' : undefined} aria-pressed={dictationPhase === 'recording'} disabled={micPending || dictationPhase === 'transcribing'} onClick={() => void dictate()}>{micPending || dictationPhase === 'transcribing' ? <LoaderCircle size={17} className="spin" /> : dictationPhase === 'recording' ? <Square size={16} /> : <Mic size={17} />}</button>
      <button className="pet-meeting" aria-label="Meeting buddy" title="Meeting help & notes" aria-describedby={hint ? 'pet-action-hint' : undefined} onClick={() => open('window.meeting')}><FileText size={17} /></button>
      <button className="pet-write" aria-label="Write for me" title={writeHint} aria-describedby={hint ? 'pet-action-hint' : undefined} hidden={writeHidden} onClick={() => writing?.permissionRequired ? open('permissions.request', { kind: 'accessibility' }) : open('completion.suggest')}><Sparkles size={17} /></button>
      <button className="pet-settings" aria-label="Settings and shortcuts" title="Settings & shortcuts" aria-describedby={hint ? 'pet-action-hint' : undefined} onClick={() => open('window.main', { page: 'settings', section: 'shortcuts' })}><SettingsIcon size={17} /></button>
      {hint && <span id="pet-action-hint" className="pet-action-hint" role="tooltip">{hint}</span>}
    </nav>
  </div>;
}

export function TalkCloud({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState(() => sessionStorage.getItem('pace.pet-draft') || '');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState('');
  const [globalPhase, setGlobalPhase] = useState('idle');
  const [status, setStatus] = useState('');
  const request = useRef<string | undefined>(undefined);
  const pending = useRef(false);
  const microphone = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const replyArea = useRef<HTMLParagraphElement>(null);
  const recovered = useRef<string | undefined>(undefined);
  const preserveDictation = (phrase: string) => {
    if (!phrase.trim() || recovered.current === phrase) return;
    recovered.current = phrase;
    setDraft(current => { const merged = current ? `${current}${current.endsWith(' ') ? '' : ' '}${phrase}` : phrase; sessionStorage.setItem('pace.pet-draft', merged); return merged; });
  };
  const conversation = 'pace-desktop-companion';
  const ready = state.models.some(model => ['qwen3.5-4b', 'qwen3.5-2b'].includes(model.id) && model.installed);
  useEffect(() => { sessionStorage.setItem('pace.pet-draft', draft); }, [draft]);
  useEffect(() => { document.documentElement.classList.add('overlay-document'); return () => document.documentElement.classList.remove('overlay-document'); }, []);
  useEffect(() => {
    let cancelled = false; let dispose: (() => void) | undefined;
    void api<Array<{ role: string; content: string }>>('chat.history', { conversationId: conversation }).then(history => { if (!cancelled && !pending.current) setReply(history.filter(item => item.role === 'assistant').at(-1)?.content || ''); }).catch(() => {});
    void subscribe((event, data) => {
      const value = data as { text?: string; clientRequestId?: string } | null;
      if (event === 'chat.delta' && value?.clientRequestId && value.clientRequestId === request.current) setReply(current => current + (value.text || ''));
      else if ((event === 'pet.bubble' || event === 'pet.say') && value?.text && !pending.current) setReply(value.text);
      else if (event === 'dictation.state') {
        const result = data as { phase?: string; text?: string; error?: string }; setGlobalPhase(result.phase || 'idle'); if (result.phase === 'recording') recovered.current = undefined; if (result.phase !== 'recording' && result.phase !== 'transcribing') { microphone.current = false; setRecording(false); setMicBusy(false); }
        if (result.phase === 'draft' && result.text) { preserveDictation(result.text); setStatus('Dictation kept here. Copy it into your app.'); }
        if (result.error) setError(result.error);
      }
      else if (event === 'dictation.finished') {
        const result = data as { text?: string; error?: string; inserted?: boolean }; microphone.current = false; setRecording(false); setMicBusy(false); setGlobalPhase('idle');
        if (result.inserted) setStatus('Typed into your app.');
        else if (result.text) { preserveDictation(result.text); setStatus('Dictation kept here. Review or copy it.'); }
        if (result.error) setError(result.error);
      }
      else if (event === 'voice.started') setSpeaking(true);
      else if (event === 'voice.stopped') setSpeaking(false);
      else if (event === 'voice.error') { setSpeaking(false); setError((data as { message?: string })?.message || 'Pace’s voice could not play.'); }
    }).then(value => { if (cancelled) value(); else dispose = value; });
    return () => { cancelled = true; dispose?.(); if (microphone.current) { microphone.current = false; void api('audio.stop').then(value => { const text = (value as { text?: string })?.text; if (text) { const draft = sessionStorage.getItem('pace.pet-draft') || ''; sessionStorage.setItem('pace.pet-draft', draft ? `${draft.trimEnd()} ${text}` : text); } }).catch(() => {}); } };
  }, []);
  useEffect(() => { if (replyArea.current) replyArea.current.scrollTop = replyArea.current.scrollHeight; }, [reply]);
  const send = async () => {
    if (!draft.trim() || pending.current || microphone.current || globalPhase === 'recording' || globalPhase === 'transcribing') return;
    const text = draft.trim(); const id = crypto.randomUUID(); pending.current = true; request.current = id;
    setBusy(true); setError(''); setStatus(''); setReply('');
    try {
      const result = await api<{ text: string }>('chat.send', { text, conversationId: conversation, surface: 'pet', clientRequestId: id });
      if (!result.text?.trim()) throw new Error('Pace returned an empty reply. Try again.');
      setReply(result.text); setDraft(current => current.trim() === text ? '' : current); input.current?.focus();
    } catch (cause) { setReply(''); setError(errorText(cause)); }
    finally { pending.current = false; request.current = undefined; setBusy(false); }
  };
  const dictate = async () => {
    setError('');
    if (!microphone.current && globalPhase !== 'recording' && dictationModelMissing(state)) {
      void api('window.main', { page: 'models' }).catch(cause => setError(errorText(cause))); return;
    }
    setMicBusy(true);
    try {
      if (globalPhase === 'recording' && !microphone.current) { await api('dictation.toggle'); return; }
      if (microphone.current) {
        microphone.current = false; setRecording(false);
        const result = await api<{ text?: string }>('audio.stop');
        if (result.text?.trim()) preserveDictation(result.text.trim()); else setError('No speech caught that time. Try again or type below.');
        input.current?.focus();
      } else { recovered.current = undefined; await api('audio.start'); microphone.current = true; setRecording(true); }
    } catch (cause) { microphone.current = false; setRecording(false); setError(errorText(cause)); }
    finally { setMicBusy(false); }
  };
  const toggleVoice = async () => {
    setError(''); setVoiceBusy(true);
    try { if (state.settings.speechEnabled) await api('voice.stop'); await api<Settings>('settings.update', { patch: { speechEnabled: !state.settings.speechEnabled } }); await refresh(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setVoiceBusy(false); }
  };
  const listening = recording || globalPhase === 'recording';
  const emote = listening ? 'dictate' : speaking ? 'talk' : busy ? 'think' : 'idle';
  return <main className="pace-cloud talk-cloud bubble-window" aria-label="Talk with Pace">
    <header className="cloud-header talk-header">
      <div className="cloud-portrait"><Pace action={emote} size={36} label={`Pace is ${emote}`} /><span>{listening ? 'Listening…' : speaking ? 'Speaking…' : busy ? 'Thinking…' : 'Pace'}</span></div>
      <button aria-label={state.settings.speechEnabled ? 'Mute spoken replies' : 'Enable spoken replies'} title={state.settings.speechEnabled ? 'Mute spoken replies' : 'Enable spoken replies'} disabled={voiceBusy} onClick={() => void toggleVoice()}>{state.settings.speechEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}</button>
      {(reply || draft) && <button aria-label={reply ? 'Copy Pace’s reply' : 'Copy dictation'} title={reply ? 'Copy reply' : 'Copy draft'} onClick={() => void navigator.clipboard.writeText(reply || draft).then(() => setStatus('Copied.')).catch(cause => setError(errorText(cause)))}><Copy size={14} /></button>}
      <button className="cloud-close" aria-label="Close speech bubble" title="Close" onClick={() => { void api('window.close', { label: 'bubble' }).catch(cause => setError(errorText(cause))); }}><X size={16} /></button>
    </header>
    {reply ? <p ref={replyArea} className="bubble-reply" tabIndex={0} aria-label="Pace’s reply">{reply}</p> : <div className="bubble-placeholder">{busy ? <span role="status">Pace is working on it…</span> : listening ? <span role="status">Microphone on. Press Stop when you’re done.</span> : <span>What’s on your mind?</span>}{!ready && !busy && !listening && <button className="cloud-setup" onClick={() => void api('window.main', { page: 'models' }).catch(cause => setError(errorText(cause)))}>Set up a local model</button>}</div>}
    {error && <p className="cloud-error" role="alert">{error}{error.includes('Local models') && <button className="cloud-access" onClick={() => void api('window.main', { page: 'models' }).catch(cause => setError(errorText(cause)))}>Open Local models</button>}{error.includes('Accessibility') && <button className="cloud-access" onClick={() => { void api('permissions.request', { kind: 'accessibility' }).catch(cause => setError(errorText(cause))); }}>Open Accessibility settings</button>}</p>}
    <form className="cloud-compose" onSubmit={event => { event.preventDefault(); void send(); }}><input ref={input} aria-label="Ask Pace" value={draft} onChange={event => setDraft(event.target.value)} placeholder={listening ? 'Listening…' : 'Ask Pace…'} readOnly={listening} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }} /><button type="button" className={listening ? 'cloud-mic recording' : 'cloud-mic'} aria-label={listening ? 'Stop dictation' : 'Dictate a message'} title={listening ? 'Stop dictation' : 'Dictate a message'} aria-pressed={listening} disabled={busy || micBusy} onClick={() => void dictate()}>{micBusy ? <LoaderCircle size={15} className="spin" /> : listening ? <Square size={14} /> : <Mic size={15} />}</button><button className="send-button" aria-label="Send question" title="Send" disabled={!draft.trim() || busy || listening || micBusy}>{busy ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={16} />}</button></form>
    {status && <p className="cloud-foot" role="status">{status}</p>}
    <span className="cloud-tail" aria-hidden="true" />
  </main>;
}
