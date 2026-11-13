import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileText, LoaderCircle, MessageCircle, Mic, Settings as SettingsIcon, Square } from 'lucide-react';
import { api, errorText, isNative, subscribe, type AppState } from './api';
import { Pace, playPetSound, usePetMood, validAction } from './Pace';

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
  const overlay = useRef<HTMLDivElement>(null);
  const revealed = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [dictationPhase, setDictationPhase] = useState('idle');
  const [hiding, setHiding] = useState(false);
  const [micPending, setMicPending] = useState(false);
  const [error, setError] = useState('');
  const down = useRef<{ x: number; y: number } | undefined>(undefined);
  const dragged = useRef(false);
  useEffect(() => { document.documentElement.classList.add('overlay-document'); return () => document.documentElement.classList.remove('overlay-document'); }, []);
  useLayoutEffect(() => mood.setAction(validAction(state.pet.action)), [state.pet.action]);
  useEffect(() => {
    let dispose: (() => void) | undefined; let cancelled = false; let version = 0;
    void subscribe((event, data) => {
      if (event === 'dictation.state') { version++; setDictationPhase((data as { phase?: string })?.phase || 'idle'); }
      if (event === 'pet.visibility' && data) setHiding(!(data as { visible: boolean }).visible);
    }).then(value => {
      if (cancelled) { value(); return; }
      dispose = value; const snapshot = version;
      void api<{ phase?: string }>('dictation.current').then(value => { if (!cancelled && snapshot === version) setDictationPhase(value?.phase || 'idle'); }).catch(() => {});
    });
    return () => { cancelled = true; dispose?.(); };
  }, []);
  useEffect(() => () => { clearTimeout(hideTimer.current); revealed.current = false; }, []);
  const revealControls = () => {
    clearTimeout(hideTimer.current);
    if (revealed.current) return;
    revealed.current = true; setControlsOpen(true);
  };
  const leaveControls = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (overlay.current?.querySelector(':focus-visible')) return;
      revealed.current = false; setControlsOpen(false); setHint('');
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
  const dictateHint = dictationPhase === 'recording' ? 'Stop dictation' : dictationPhase === 'transcribing' ? 'Transcribing…' : 'Type into your app';
  const toolsVisible = controlsOpen && !hiding && !['summon', 'burrow'].includes(state.pet.action);
  const shortcutHint = (label: string, shortcut?: string) => shortcut ? `${label} · ${shortcut}` : label;
  return <div ref={overlay} className={`pet-window companion-pet ${toolsVisible ? 'controls-open' : ''} ${hiding || ['summon', 'burrow'].includes(state.pet.action) ? 'pet-transitioning' : ''} ${hiding && state.pet.action !== 'burrow' ? 'pet-hiding' : ''}`} onPointerEnter={revealControls} onPointerLeave={leaveControls} onFocus={event => { if (event.target.matches(':focus-visible')) revealControls(); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) leaveControls(); }} onContextMenu={event => { event.preventDefault(); setMenu(!menu); }}>
    {(dictationPhase === 'recording' || dictationPhase === 'transcribing') && <span className="sr-only" role="status">{dictationPhase === 'recording' ? 'Listening…' : 'Catching words…'}</span>}
    {error && <p className="pet-error" role="alert">{error}{error.includes('Local models') && <button className="cloud-access" onClick={() => open('window.main', { page: 'models' })}>Open Local models</button>}</p>}
    {menu && <div className="pet-menu"><button onClick={() => open('window.chat')}><MessageCircle size={14} />Chat with Pace</button><button onClick={() => open('window.meeting')}><FileText size={14} />Meeting notes</button><button onClick={() => open('window.main', { page: 'settings', section: 'shortcuts' })}>Controls & look</button><button onClick={() => { mood.setAction('celebrate'); if (state.settings.soundEnabled && !state.meetings.some(meeting => ['recording', 'finalizing'].includes(meeting.status))) playPetSound('celebrate', state.settings.volume); open('pet.action', { action: 'celebrate' }); }}>A tiny victory!</button><button onClick={() => open('pet.toggle', { visible: false })}>Hide Pace</button></div>}
    <button className="overlay-pet-button" aria-label="Pet Pace; drag to move; right-click for menu" aria-controls="pace-actions" aria-expanded={toolsVisible} disabled={hiding || ['summon', 'burrow'].includes(state.pet.action)} onKeyDown={event => {
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
      <button className="pet-dictate" aria-label={dictationPhase === 'recording' ? 'Stop dictation' : 'Dictate into your app'} title={shortcutHint(dictateHint, state.settings.dictationShortcut)} aria-describedby={hint ? 'pet-action-hint' : undefined} aria-pressed={dictationPhase === 'recording'} disabled={micPending || dictationPhase === 'transcribing'} onClick={() => void dictate()}>{micPending || dictationPhase === 'transcribing' ? <LoaderCircle size={15} className="spin" /> : dictationPhase === 'recording' ? <Square size={14} /> : <Mic size={15} />}</button>
      <button className="pet-chat" aria-label="Chat with Pace" title="Chat with Pace" aria-describedby={hint ? 'pet-action-hint' : undefined} onClick={() => open('window.chat')}><MessageCircle size={15} /></button>
      <button className="pet-meeting" aria-label="Meeting buddy" title="Meeting help & notes" aria-describedby={hint ? 'pet-action-hint' : undefined} onClick={() => open('window.meeting')}><FileText size={15} /></button>
      <button className="pet-settings" aria-label="Settings and shortcuts" title="Settings & shortcuts" aria-describedby={hint ? 'pet-action-hint' : undefined} onClick={() => open('window.main', { page: 'settings', section: 'shortcuts' })}><SettingsIcon size={15} /></button>
      {hint && <span id="pet-action-hint" className="pet-action-hint" role="tooltip">{hint}</span>}
    </nav>
  </div>;
}
