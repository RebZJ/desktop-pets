import { useEffect, useRef, useState } from 'react';
import { ArrowUp, LoaderCircle, Mic, Square, X } from 'lucide-react';
import { api, errorText, subscribe, type AppState } from './api';
import { Pace } from './Pace';
import './chat-cloud.css';

type VoiceState = { sessionId: string | null; phase: 'idle' | 'starting' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error'; active: boolean; sequence?: number; meetingId?: string | null; userText?: string; text?: string; error?: string };
type Turn = { id: string; user: string; text: string };
const idleVoice: VoiceState = { sessionId: null, phase: 'idle', active: false };

function ChatMessage({ speaker, text }: { speaker: 'You' | 'Pace'; text: string }) {
  return <p className={`chat-bubble ${speaker === 'You' ? 'chat-user' : 'chat-pace'}`}><strong>{speaker}</strong>{text}<span className="chat-bubble-tail" aria-hidden="true" /></p>;
}

export function ChatCloud({ state }: { state: AppState }) {
  const [text, setText] = useState(() => sessionStorage.getItem('pace.pet-draft') || '');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [meetingId, setMeetingId] = useState<string>();
  const [contextReady, setContextReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [voice, setVoice] = useState<VoiceState>(idleVoice);
  const [ending, setEnding] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const request = useRef<string | undefined>(undefined);
  const session = useRef<string | undefined>(undefined);
  const acceptingVoice = useRef(false);
  const context = useRef<string | undefined>(undefined);
  const contextVersion = useRef(0);
  const voiceVersion = useRef(0);
  const voiceSnapshot = useRef<VoiceState>(idleVoice);
  const mounted = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [scrolled, setScrolled] = useState(false);
  const levelTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const acceptVoice = (value: VoiceState) => {
    if (!mounted.current || !acceptingVoice.current || !value?.sessionId || value.sessionId !== session.current || (value.meetingId || undefined) !== context.current) return;
    if (typeof value.sequence === 'number' && voiceSnapshot.current.sessionId === value.sessionId && typeof voiceSnapshot.current.sequence === 'number' && value.sequence < voiceSnapshot.current.sequence) return;
    const next = value.phase === 'transcribing' ? { ...value, text: '' } : value;
    voiceSnapshot.current = next; setVoice(next); setLevel(0); setError(value.error || '');
    if (!value.active && value.phase === 'idle') { acceptingVoice.current = false; session.current = undefined; }
  };
  const endVoice = async () => {
    const id = session.current;
    if (!id) return true;
    acceptingVoice.current = false; voiceVersion.current++; setEnding(true); setLevel(0);
    try {
      await api('voicechat.stop', { sessionId: id });
      if (session.current === id) { session.current = undefined; if (mounted.current) setVoice(current => ({ ...idleVoice, userText: current.userText, text: current.text })); }
      return true;
    } catch (cause) { if (mounted.current) setError(`Could not end voice conversation. ${errorText(cause)} Try End again.`); return false; }
    finally { if (mounted.current) setEnding(false); }
  };
  const changeContext = (value?: string) => {
    if (contextVersion.current > 0 && context.current === value) { contextVersion.current++; input.current?.focus(); return; }
    contextVersion.current++; context.current = value; voiceSnapshot.current = idleVoice; following.current = true; setScrolled(false);
    request.current = undefined; setBusy(false); setTurns([]); setVoice(idleVoice); setError(''); setMeetingId(value); setContextReady(true);
    void endVoice(); input.current?.focus();
  };
  useEffect(() => {
    mounted.current = true;
    document.documentElement.classList.add('overlay-document');
    let dispose: (() => void) | undefined; let cancelled = false;
    void subscribe((event, data) => {
      if (cancelled) return;
      if (event === 'chat.context') changeContext((data as { meetingId?: string | null })?.meetingId || undefined);
      if (event === 'chat.delta') {
        const value = data as { clientRequestId?: string; text?: string };
        if (value.clientRequestId && value.clientRequestId === request.current && typeof value.text === 'string') setTurns(current => current.map(turn => turn.id === value.clientRequestId ? { ...turn, text: turn.text + value.text } : turn));
      }
      if (event === 'voicechat.state') { voiceVersion.current++; acceptVoice(data as VoiceState); }
      if (event === 'voicechat.level') {
        const value = data as { sessionId?: string; level?: number };
        if (!acceptingVoice.current || value.sessionId !== session.current || typeof value.level !== 'number' || !Number.isFinite(value.level)) return;
        setLevel(Math.max(0, Math.min(1, value.level)));
        clearTimeout(levelTimeout.current); levelTimeout.current = setTimeout(() => setLevel(0), 350);
      }
    }).then(async value => {
      if (cancelled) { value(); return; }
      dispose = value;
      const version = contextVersion.current;
      try {
        const saved = await api<{ meetingId?: string | null }>('chat.context.current');
        if (!cancelled && contextVersion.current === version) changeContext(saved.meetingId || undefined);
        const snapshot = voiceVersion.current; const currentContext = contextVersion.current;
        const current = await api<VoiceState>('voicechat.current');
        if (!cancelled && voiceVersion.current === snapshot && contextVersion.current === currentContext && current.active && current.sessionId && (current.meetingId || undefined) === context.current) {
          session.current = current.sessionId; acceptingVoice.current = true; acceptVoice(current);
        }
      } catch (cause) { if (!cancelled) setError(errorText(cause)); }
    }).catch(cause => { if (!cancelled) setError(errorText(cause)); });
    return () => {
      cancelled = true; mounted.current = false; request.current = undefined; acceptingVoice.current = false;
      if (session.current) void api('voicechat.stop', { sessionId: session.current }).catch(() => {});
      dispose?.(); clearTimeout(levelTimeout.current); document.documentElement.classList.remove('overlay-document');
    };
  }, []);
  useEffect(() => {
    if (!transcript.current || !following.current) return;
    transcript.current.scrollTop = transcript.current.scrollHeight;
    setScrolled(transcript.current.scrollTop > 1);
  }, [turns, voice.userText, voice.text, error]);
  const startVoice = async () => {
    if (!contextReady || request.current || session.current) return;
    const id = crypto.randomUUID(); session.current = id; acceptingVoice.current = true; voiceVersion.current++;
    following.current = true;
    setError(''); setLevel(0); voiceSnapshot.current = { sessionId: id, phase: 'starting', active: true, meetingId: context.current }; setVoice(voiceSnapshot.current);
    try { acceptVoice(await api<VoiceState>('voicechat.start', { clientSessionId: id, ...(context.current ? { meetingId: context.current } : {}) })); }
    catch (cause) {
      if (session.current !== id || !acceptingVoice.current) return;
      acceptingVoice.current = false; session.current = undefined; setVoice(idleVoice); setError(errorText(cause));
    }
  };
  const send = async () => {
    if (!contextReady || request.current || session.current || !text.trim()) return;
    const message = text.trim(); const id = crypto.randomUUID(); request.current = id;
    following.current = true;
    setBusy(true); setError(''); setTurns(current => [...current, { id, user: message, text: '' }]);
    try {
      const value = await api<{ text: string }>('chat.send', { text: message, ...(context.current ? { meetingId: context.current } : {}), clientRequestId: id, quiet: true });
      if (request.current !== id) return;
      if (!value.text?.trim()) throw new Error('No answer arrived. Your message is still here.');
      setTurns(current => current.map(turn => turn.id === id ? { ...turn, text: value.text } : turn));
      setText(current => { if (current.trim() !== message) return current; sessionStorage.removeItem('pace.pet-draft'); return ''; });
    } catch (cause) { if (request.current === id) setError(errorText(cause)); }
    finally { if (request.current === id) { request.current = undefined; setBusy(false); } }
  };
  const voiceActive = Boolean(session.current);
  const recording = state.meetings.some(meeting => ['recording', 'finalizing'].includes(meeting.status));
  const status = ending ? 'Ending conversation…' : voice.phase === 'starting' ? 'Opening microphone…' : voice.phase === 'listening' ? 'Listening…' : voice.phase === 'transcribing' ? 'Hearing your words…' : voice.phase === 'thinking' || busy ? 'Thinking…' : voice.phase === 'speaking' ? 'Pace is speaking…' : voice.phase === 'error' ? 'Voice needs attention' : 'Microphone off';
  const action = voice.phase === 'listening' ? 'listen' : voice.phase === 'speaking' ? 'talk' : busy || ['starting', 'transcribing', 'thinking'].includes(voice.phase) ? 'think' : 'idle';
  return <main className="pace-cloud chat-cloud" aria-label="Chat with Pace">
    <div className="chat-history" data-scrolled={scrolled}>
      <div ref={transcript} className="chat-reply" role="log" aria-label="Conversation" aria-live="polite" tabIndex={0} onScroll={event => {
        const element = event.currentTarget;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 16;
        setScrolled(element.scrollTop > 1);
      }}><div className="chat-messages">
        {!turns.length && !voice.userText && !voice.text && <p className="chat-bubble chat-hint">{voiceActive ? 'Talk naturally. Pace listens again after replying.' : meetingId ? 'Ask a question about this meeting, by voice or text.' : 'Talk in English, or type a message.'}<span className="chat-bubble-tail" aria-hidden="true" /></p>}
        {turns.map(turn => <div className="chat-turn" key={turn.id}><ChatMessage speaker="You" text={turn.user} />{turn.text && <ChatMessage speaker="Pace" text={turn.text} />}</div>)}
        {voice.userText && <ChatMessage speaker="You" text={voice.userText} />}{voice.text && <ChatMessage speaker="Pace" text={voice.text} />}
        {error && <p className="chat-bubble chat-error" role="alert">{error}{/model|Qwen|Kitten|Moonshine/i.test(error) && <button onClick={() => void api('window.main', { page: 'models' }).catch(cause => setError(errorText(cause)))}>Open Local models</button>}{/microphone|permission|input device/i.test(error) && <button onClick={() => void api('window.main', { page: 'settings', section: 'privacy' }).catch(cause => setError(errorText(cause)))}>Open microphone settings</button>}<span className="chat-bubble-tail" aria-hidden="true" /></p>}
      </div></div>
    </div>
    <footer className="chat-dock">
    <form onSubmit={event => { event.preventDefault(); void send(); }}><input ref={input} autoFocus aria-label="Message Pace" placeholder={voiceActive ? 'End voice to send a message…' : meetingId ? 'Ask about the meeting…' : 'Say something…'} value={text} maxLength={16000} onChange={event => { setText(event.target.value); sessionStorage.setItem('pace.pet-draft', event.target.value); }} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }} /><button aria-label="Send message" disabled={!contextReady || busy || voiceActive || !text.trim()}>{busy ? <LoaderCircle size={14} className="spin" /> : <ArrowUp size={14} />}</button></form>
      <div className={`chat-bottom-options ${voiceActive ? 'voice-active' : ''}`}>
        <div className="cloud-portrait"><Pace action={action} size={24} label={`Pace is ${action}`} pack={state.packs.find(pack => pack.id === state.settings.activePack)} />{!voiceActive && <strong>{meetingId ? 'Meeting chat' : 'Chat with Pace'}</strong>}</div>
        <div className="chat-voice-controls">{voiceActive ? <><span role="status">{status}</span>{voice.phase === 'listening' && <meter aria-label="Microphone level" min={0} max={1} value={level} />}<button className="chat-end" aria-label="End voice conversation" onClick={() => void endVoice()}><Square size={10} fill="currentColor" />End</button></> : <button className="chat-start" aria-label="Start voice conversation" disabled={busy || !contextReady || recording} title={recording ? 'Finish the current meeting before starting voice chat. You can still type.' : 'English voice chat · Kiki'} onClick={() => void startVoice()}><Mic size={13} />Talk</button>}</div>
        <button aria-label="Close chat" onClick={() => void endVoice().then(ended => { if (ended) { request.current = undefined; return api('window.close', { label: 'command' }); } }).catch(cause => setError(errorText(cause)))}><X size={14} /></button>
      </div>
    </footer>
  </main>;
}
