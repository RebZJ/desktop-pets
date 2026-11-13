import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Sparkles, Copy, FileText, LoaderCircle, MessageCircle, Mic, Square, Volume2, VolumeX, X } from 'lucide-react';
import { api, errorText, isNative, subscribe, type AppState, type Settings } from './api';
import { Pace, playPetSound, usePetMood, validAction } from './Pace';

function CloudHeader() {
  const [error, setError] = useState('');
  return <><header className="cloud-header"><strong>Talk with Pace</strong><button className="cloud-close" aria-label="Close speech bubble" onClick={() => { void api('window.close', { label: 'bubble' }).catch(cause => setError(errorText(cause))); }}><X size={16} /></button></header>{error && <p className="cloud-error" role="alert">{error}</p>}</>;
}

export function DesktopPet({ state }: { state: AppState }) {
  const mood = usePetMood(validAction(state.pet.action));
  const [menu, setMenu] = useState(false);
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
  const open = (method: string, params = {}) => { setError(''); setMenu(false); void api(method, params).catch(cause => setError(errorText(cause))); };
  const dictate = async () => {
    if (micPending) return;
    setMicPending(true); setError('');
    try { await api('dictation.toggle'); } catch (cause) { setError(errorText(cause)); }
    finally { setMicPending(false); }
  };
  const pet = () => {
    const action = mood.pet();
    if (state.settings.soundEnabled && !state.meetings.some(meeting => ['recording', 'finalizing'].includes(meeting.status))) playPetSound(action, state.settings.volume, state.packs.find(pack => pack.id === state.settings.activePack));
    open('pet.action', { action });
  };
  return <div className={`pet-window companion-pet ${hiding ? 'pet-hiding' : ''}`} onContextMenu={event => { event.preventDefault(); setMenu(!menu); }}>
    {(dictationPhase === 'recording' || dictationPhase === 'transcribing') && <span className="sr-only" role="status">{dictationPhase === 'recording' ? 'Listening…' : 'Catching words…'}</span>}
    {error && <p className="pet-error" role="alert">{error}</p>}
    {menu && <div className="pet-menu"><button onClick={() => open('window.main', { page: 'meetings' })}><FileText size={14} />Meeting notes</button><button onClick={() => open('window.main', { page: 'settings' })}>Pet settings</button><button onClick={() => { mood.setAction('celebrate'); if (state.settings.soundEnabled && !state.meetings.some(meeting => ['recording', 'finalizing'].includes(meeting.status))) playPetSound('celebrate', state.settings.volume); open('pet.action', { action: 'celebrate' }); }}>A tiny victory!</button><button onClick={() => open('pet.toggle', { visible: false })}>Hide Pace</button></div>}
    <button className="overlay-pet-button" aria-label="Pet Pace; drag to move; right-click for menu" onPointerDown={event => { down.current = { x: event.clientX, y: event.clientY }; dragged.current = false; }} onPointerMove={event => {
      if (!down.current || dragged.current || Math.hypot(event.clientX - down.current.x, event.clientY - down.current.y) <= 7) return;
      dragged.current = true;
      if (isNative()) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().startDragging()).catch(cause => setError(errorText(cause)));
    }} onPointerUp={() => { down.current = undefined; }} onClick={event => { if (event.detail !== 0 && dragged.current) { dragged.current = false; return; } pet(); }}><Pace action={mood.action} size={state.settings.petSize} pack={state.packs.find(pack => pack.id === state.settings.activePack)} label={`Pace is ${mood.action}`} /></button>
    <nav className="pet-controls" aria-label="Pace actions"><button className="pet-talk" onClick={() => open('window.talk')}><MessageCircle size={13} /><span>Talk</span></button><button aria-label={dictationPhase === 'recording' ? 'Stop dictation' : 'Dictate into your app'} title={dictationPhase === 'recording' ? 'Stop dictation' : 'Dictate into your app'} aria-pressed={dictationPhase === 'recording'} disabled={micPending || dictationPhase === 'transcribing'} onClick={() => void dictate()}>{micPending ? <LoaderCircle size={14} className="spin" /> : dictationPhase === 'recording' ? <Square size={14} /> : <Mic size={14} />}<span>{dictationPhase === 'recording' ? 'Stop' : dictationPhase === 'transcribing' ? 'Working…' : 'Dictate'}</span></button><button aria-label="Write for me" title="Write for me at your cursor" onClick={() => open('completion.suggest')}><Sparkles size={13} /><span>Write for me</span></button></nav>
  </div>;
}

export function TalkCloud({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState(() => sessionStorage.getItem('pace.pet-draft') || '');
  const [question, setQuestion] = useState('');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
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
      else if ((event === 'meeting.tip' || event === 'pet.bubble' || event === 'pet.say') && value?.text && !pending.current) { setQuestion(''); setReply(value.text); }
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
      else if (event === 'voice.error') setError((data as { message?: string })?.message || 'Pace’s voice could not play.');
    }).then(value => { if (cancelled) value(); else dispose = value; });
    return () => { cancelled = true; dispose?.(); if (microphone.current) { microphone.current = false; void api('audio.stop').then(value => { const text = (value as { text?: string })?.text; if (text) { const draft = sessionStorage.getItem('pace.pet-draft') || ''; sessionStorage.setItem('pace.pet-draft', draft ? `${draft.trimEnd()} ${text}` : text); } }).catch(() => {}); } };
  }, []);
  useEffect(() => { if (replyArea.current) replyArea.current.scrollTop = replyArea.current.scrollHeight; }, [reply]);
  const send = async () => {
    if (!draft.trim() || pending.current || microphone.current || globalPhase === 'recording' || globalPhase === 'transcribing') return;
    const text = draft.trim(); const id = crypto.randomUUID(); pending.current = true; request.current = id;
    setBusy(true); setError(''); setQuestion(text); setReply('');
    try {
      const result = await api<{ text: string }>('chat.send', { text, conversationId: conversation, surface: 'pet', clientRequestId: id });
      if (!result.text?.trim()) throw new Error('Pace returned an empty reply. Try again.');
      setReply(result.text); setDraft(current => current.trim() === text ? '' : current); input.current?.focus();
    } catch (cause) { setReply(''); setError(errorText(cause)); }
    finally { pending.current = false; request.current = undefined; setBusy(false); }
  };
  const dictate = async () => {
    setError(''); setMicBusy(true);
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
  return <main className="pace-cloud talk-cloud bubble-window" aria-label="Talk with Pace">
    <CloudHeader />
    <div className="cloud-portrait" aria-hidden="true"><Pace action={listening ? 'dictate' : busy ? 'think' : 'idle'} size={44} />{(listening || busy) && <span>{listening ? 'I’m listening.' : 'One tiny moment…'}</span>}</div>
    {question && <p className="cloud-question">{question}</p>}
    {reply ? <p ref={replyArea} className="bubble-reply" tabIndex={0} aria-label="Pace’s reply">{reply}</p> : <div className="bubble-placeholder">{busy ? <span role="status">Pace is working on it…</span> : listening ? <span role="status">Microphone on. Press Stop when you’re done.</span> : <><h1>Hey. What’s the next tiny step?</h1><p>Talk through a tricky bit, untangle a thought, or just say hello.</p></>}</div>}
    {!ready && !reply && !busy && <button className="cloud-setup" onClick={() => void api('window.main', { page: 'models' }).catch(cause => setError(errorText(cause)))}>Set up a local model</button>}
    {error && <p className="cloud-error" role="alert">{error}{error.includes('Accessibility') && <button className="cloud-access" onClick={() => { void api('permissions.request', { kind: 'accessibility' }).catch(cause => setError(errorText(cause))); }}>Open Accessibility settings</button>}</p>}
    <form className="cloud-compose" onSubmit={event => { event.preventDefault(); void send(); }}><input ref={input} aria-label="Ask Pace" value={draft} onChange={event => setDraft(event.target.value)} placeholder={listening ? 'Listening…' : 'Say something to Pace…'} readOnly={listening} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }} /><button type="button" className={listening ? 'cloud-mic recording' : 'cloud-mic'} aria-label={listening ? 'Stop dictation' : 'Dictate a message'} aria-pressed={listening} disabled={busy || micBusy} onClick={() => void dictate()}>{micBusy ? <LoaderCircle size={15} className="spin" /> : listening ? <Square size={14} /> : <Mic size={15} />}</button><button className="send-button" aria-label="Send question" disabled={!draft.trim() || busy || listening || micBusy}>{busy ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={16} />}</button></form>
    <footer className="cloud-foot"><span>{listening ? 'Listening · press your shortcut to finish' : status || 'A little help, on your device.'}</span><button aria-label={state.settings.speechEnabled ? 'Mute spoken replies' : 'Enable spoken replies'} disabled={voiceBusy} onClick={() => void toggleVoice()}>{state.settings.speechEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}</button>{draft && !reply && <button aria-label="Copy dictation" onClick={() => void navigator.clipboard.writeText(draft).then(() => setStatus('Copied.')).catch(cause => setError(errorText(cause)))}><Copy size={12} /></button>}{reply && <button aria-label="Copy Pace’s reply" onClick={() => void navigator.clipboard.writeText(reply).catch(cause => setError(errorText(cause)))}><Copy size={12} /></button>}</footer>
    <span className="cloud-tail" aria-hidden="true" />
  </main>;
}
