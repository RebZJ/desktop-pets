import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, FileText, LoaderCircle, MessageCircle, Mic, RotateCcw, Settings as SettingsIcon, Square, X } from 'lucide-react';
import { api, copyText, errorText, isNative, subscribe, type AppState } from './api';
import { Pace, playPetSound, usePetMood, validAction } from './Pace';

function dictationModelMissing(state: AppState) {
  const language = (state.settings.dictationLanguage || state.settings.language || 'en').toLowerCase().split(/[-_]/)[0];
  const whisper = state.models.find(model => model.id === 'whisper-turbo');
  const moonshine = state.models.find(model => model.id === `moonshine-tiny-${language}`);
  return whisper?.installed === false && (!['en', 'zh', 'ja', 'es'].includes(language) || moonshine?.installed === false);
}

type DictationState = { phase?: string; text?: string; error?: string; savedAudio?: boolean };
type Recovery = { message: string; text?: string; retry?: boolean; models?: boolean };

export function DesktopPet({ state }: { state: AppState }) {
  const mood = usePetMood(validAction(state.pet.action));
  const [menu, setMenu] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [hint, setHint] = useState('');
  const overlay = useRef<HTMLDivElement>(null);
  const revealed = useRef(false);
  const keyboardMode = useRef(false);
  const hovered = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [dictationPhase, setDictationPhase] = useState('idle');
  const [hiding, setHiding] = useState(false);
  const [micPending, setMicPending] = useState(false);
  const [recovery, setRecovery] = useState<Recovery>();
  const [copied, setCopied] = useState(false);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const recoveryEpoch = useRef(0);
  const recognized = useRef(sessionStorage.getItem('pace.dictation-source') || '');
  const down = useRef<{ x: number; y: number } | undefined>(undefined);
  const dragged = useRef(false);
  useEffect(() => { document.documentElement.classList.add('overlay-document'); return () => document.documentElement.classList.remove('overlay-document'); }, []);
  useLayoutEffect(() => mood.setAction(validAction(state.pet.action)), [state.pet.action]);
  const dismissRecovery = () => { recoveryEpoch.current++; clearTimeout(recoveryTimer.current); setRecovery(undefined); setCopied(false); };
  const showError = (cause: unknown) => {
    const message = errorText(cause); dismissRecovery();
    setRecovery({ message: /Local models|model/i.test(message) ? 'Speech model needed.' : /microphone|permission/i.test(message) ? 'Microphone unavailable.' : 'Couldn’t finish. Try again.', models: /Local models|model/i.test(message) });
  };
  const acceptDictation = (value: DictationState) => {
    const phase = value?.phase || 'idle'; setDictationPhase(phase); dismissRecovery();
    if (['starting', 'recording', 'transcribing', 'idle'].includes(phase) || phase === 'inserted' && !value.error) return;
    const words = value.text?.trim();
    if (words) {
      const draft = sessionStorage.getItem('pace.dictation-draft') || '';
      if (words !== recognized.current) {
        if (!draft || draft === recognized.current) sessionStorage.setItem('pace.dictation-draft', words);
        recognized.current = words; sessionStorage.setItem('pace.dictation-source', words);
      }
    }
    const models = /Local models|install.*(pack|model)/i.test(value.error || '');
    const message = words ? value.error ? /not confirm|text was inserted|before copying|uncertain/i.test(value.error) ? 'Check your text.' : 'Couldn’t type here.' : 'Words ready.' : value.savedAudio ? 'Audio saved.' : /No speech|No words/i.test(value.error || '') ? 'No words caught.' : models ? 'Speech model needed.' : /microphone|permission/i.test(value.error || '') ? 'Microphone unavailable.' : 'Dictation needs attention.';
    setRecovery({ message, text: words, retry: value.savedAudio, models });
    if (!words && !value.savedAudio && !models) {
      const epoch = recoveryEpoch.current;
      recoveryTimer.current = setTimeout(() => { if (recoveryEpoch.current === epoch) setRecovery(undefined); }, 4200);
    }
  };
  useEffect(() => {
    let dispose: (() => void) | undefined; let cancelled = false; let version = 0;
    void subscribe((event, data) => {
      if (event === 'dictation.state') { version++; acceptDictation(data as DictationState); }
      if (event === 'pet.visibility' && data) { const visible = (data as { visible: boolean }).visible; setHiding(!visible); if (!visible) { dismissRecovery(); resetControls(); } }
    }).then(value => {
      if (cancelled) { value(); return; }
      dispose = value; const snapshot = version;
      void api<DictationState>('dictation.current').then(value => { if (!cancelled && snapshot === version) acceptDictation(value); }).catch(() => {});
    });
    return () => { cancelled = true; recoveryEpoch.current++; clearTimeout(recoveryTimer.current); dispose?.(); };
  }, []);
  const closeControls = () => { clearTimeout(hideTimer.current); revealed.current = false; setControlsOpen(false); setHint(''); };
  const resetControls = () => { hovered.current = false; keyboardMode.current = false; closeControls(); setMenu(false); };
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (!event.isTrusted) return; if (event.key === 'Escape') { keyboardMode.current = false; closeControls(); return; } keyboardMode.current = true; if (overlay.current?.contains(document.activeElement)) revealControls(); };
    const pointer = () => { keyboardMode.current = false; if (!hovered.current) leaveControls(); };
    const hidden = () => { if (document.visibilityState === 'hidden') resetControls(); };
    window.addEventListener('keydown', key, true); window.addEventListener('pointerdown', pointer, true); window.addEventListener('pointermove', pointer, true);
    window.addEventListener('blur', resetControls); document.addEventListener('visibilitychange', hidden);
    return () => { clearTimeout(hideTimer.current); revealed.current = false; window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', pointer, true); window.removeEventListener('pointermove', pointer, true); window.removeEventListener('blur', resetControls); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  useEffect(() => { if (!state.pet.visible) resetControls(); }, [state.pet.visible]);
  const revealControls = () => {
    clearTimeout(hideTimer.current);
    if (revealed.current) return;
    revealed.current = true; setControlsOpen(true);
  };
  const leaveControls = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (hovered.current || keyboardMode.current && document.hasFocus() && overlay.current?.contains(document.activeElement)) return;
      closeControls();
    }, 420);
  };
  const open = (method: string, params = {}) => { dismissRecovery(); const epoch = recoveryEpoch.current; if (method.startsWith('window.') || method === 'pet.toggle') resetControls(); else setMenu(false); void api(method, params).catch(cause => { if (recoveryEpoch.current === epoch) showError(cause); }); };
  const dictate = async () => {
    if (micPending) return;
    if (dictationPhase !== 'recording' && dictationModelMissing(state)) { open('window.main', { page: 'models' }); return; }
    setMicPending(true); dismissRecovery(); resetControls(); const epoch = recoveryEpoch.current;
    try { await api('dictation.toggle'); } catch (cause) { if (recoveryEpoch.current === epoch) showError(cause); }
    finally { setMicPending(false); }
  };
  const pet = () => {
    const action = mood.pet();
    if (state.settings.soundEnabled && !state.meetings.some(meeting => ['recording', 'finalizing'].includes(meeting.status))) playPetSound(action, state.settings.volume, state.packs.find(pack => pack.id === state.settings.activePack));
    open('pet.action', { action });
  };
  const dictateHint = dictationPhase === 'recording' ? 'Stop dictation' : dictationPhase === 'transcribing' ? 'Transcribing…' : 'Type into your app';
  const toolsVisible = controlsOpen && !recovery && !hiding && !['summon', 'burrow'].includes(state.pet.action);
  const shortcutHint = (label: string, shortcut?: string) => shortcut ? `${label} · ${shortcut}` : label;
  return <div ref={overlay} className={`pet-window companion-pet ${toolsVisible ? 'controls-open' : ''} ${hiding || ['summon', 'burrow'].includes(state.pet.action) ? 'pet-transitioning' : ''} ${hiding && state.pet.action !== 'burrow' ? 'pet-hiding' : ''}`} onPointerLeave={() => { hovered.current = false; leaveControls(); }} onFocus={() => { if (keyboardMode.current) revealControls(); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) leaveControls(); }} onContextMenu={event => { event.preventDefault(); setMenu(!menu); }}>
    {(dictationPhase === 'recording' || dictationPhase === 'transcribing') && <span className="sr-only" role="status">{dictationPhase === 'recording' ? 'Listening…' : 'Catching words…'}</span>}
    {recovery && !hiding && !['summon', 'burrow'].includes(state.pet.action) && <div className="pet-recovery" role="status" aria-label="Dictation recovery" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement); event.preventDefault(); buttons[(current + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }}><span>{copied ? 'Copied.' : recovery.message}</span><button className="pet-recovery-dismiss" aria-label="Dismiss dictation notice" onClick={() => { dismissRecovery(); if (!keyboardMode.current) { hovered.current = false; closeControls(); } overlay.current?.querySelector<HTMLButtonElement>('.overlay-pet-button')?.focus(); }}><X size={11} /></button><div>{recovery.text && <button onClick={() => { const epoch = recoveryEpoch.current; void copyText(recovery.text!).then(() => { if (recoveryEpoch.current === epoch) setCopied(true); }).catch(cause => { if (recoveryEpoch.current === epoch) showError(cause); }); }}><Copy size={10} />Copy words</button>}{recovery.retry && <button disabled={micPending} onClick={() => { setMicPending(true); const epoch = recoveryEpoch.current; void api('dictation.retry').catch(cause => { if (recoveryEpoch.current === epoch) showError(cause); }).finally(() => setMicPending(false)); }}><RotateCcw size={10} />Retry audio</button>}{recovery.models && !recovery.text && <button onClick={() => open('window.main', { page: 'models' })}>Open models</button>}</div></div>}

    {menu && <div className="pet-menu"><button onClick={() => open('window.chat')}><MessageCircle size={14} />Chat with Pace</button><button onClick={() => open('window.meeting')}><FileText size={14} />Meeting notes</button><button onClick={() => open('window.main', { page: 'settings', section: 'shortcuts' })}>Controls & look</button><button onClick={() => { mood.setAction('celebrate'); if (state.settings.soundEnabled && !state.meetings.some(meeting => ['recording', 'finalizing'].includes(meeting.status))) playPetSound('celebrate', state.settings.volume); open('pet.action', { action: 'celebrate' }); }}>A tiny victory!</button><button onClick={() => open('pet.toggle', { visible: false })}>Hide Pace</button></div>}
    <button className="overlay-pet-button" aria-label="Pet Pace; drag to move; right-click for menu" aria-controls="pace-actions" aria-expanded={toolsVisible} onPointerEnter={() => { hovered.current = true; revealControls(); }} onPointerLeave={() => { hovered.current = false; leaveControls(); }} disabled={hiding || ['summon', 'burrow'].includes(state.pet.action)} onKeyDown={event => {
      if (!event.nativeEvent.isTrusted) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowRight' && !(event.key === 'Tab' && !event.shiftKey)) return;
      event.preventDefault(); revealControls();
      requestAnimationFrame(() => overlay.current?.querySelector<HTMLButtonElement>(recovery ? '.pet-recovery button:not(:disabled)' : '.pet-controls button:not(:disabled):not([hidden])')?.focus());
    }} onPointerDown={event => { down.current = { x: event.clientX, y: event.clientY }; dragged.current = false; }} onPointerMove={event => {
      if (!down.current || dragged.current || Math.hypot(event.clientX - down.current.x, event.clientY - down.current.y) <= 7) return;
      dragged.current = true;
      const epoch = recoveryEpoch.current;
      if (isNative()) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().startDragging()).catch(cause => { if (recoveryEpoch.current === epoch) showError(cause); });
    }} onPointerUp={() => { down.current = undefined; }} onClick={event => { if (event.detail !== 0 && dragged.current) { dragged.current = false; return; } pet(); }}><Pace action={mood.action} size={state.settings.petSize} pack={state.packs.find(pack => pack.id === state.settings.activePack)} label={`Pace is ${mood.action}`} /></button>
    <nav id="pace-actions" className="pet-controls" aria-label="Pace actions" onPointerEnter={() => { hovered.current = true; revealControls(); }} onPointerLeave={() => { hovered.current = false; leaveControls(); }} onKeyDown={event => {
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
