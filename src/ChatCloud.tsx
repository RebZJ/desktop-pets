import { useEffect, useRef, useState } from 'react';
import { ArrowUp, LoaderCircle, Sparkles, X } from 'lucide-react';
import { api, errorText, subscribe, type AppState } from './api';
import { Pace } from './Pace';
import './chat-cloud.css';

export function ChatCloud({ state }: { state: AppState }) {
  const [text, setText] = useState(() => sessionStorage.getItem('pace.pet-draft') || '');
  const [reply, setReply] = useState('');
  const [meetingId, setMeetingId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<string | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    document.documentElement.classList.add('overlay-document');
    let dispose: (() => void) | undefined; let cancelled = false;
    void subscribe((event, data) => {
      if (event !== 'chat.context' || cancelled) return;
      request.current = undefined; setBusy(false); setReply(''); setError('');
      setMeetingId((data as { meetingId?: string })?.meetingId); input.current?.focus();
    }).then(value => { if (cancelled) value(); else dispose = value; }).catch(cause => { if (!cancelled) setError(errorText(cause)); });
    return () => { cancelled = true; request.current = undefined; dispose?.(); document.documentElement.classList.remove('overlay-document'); };
  }, []);
  const send = async () => {
    if (busy || !text.trim()) return;
    const message = text.trim(); const id = crypto.randomUUID(); request.current = id;
    setBusy(true); setError('');
    try {
      const value = await api<{ text: string }>('chat.send', { text: message, ...(meetingId ? { meetingId } : {}), clientRequestId: id, quiet: true });
      if (request.current !== id) return;
      if (!value.text?.trim()) throw new Error('No answer arrived. Your message is still here.');
      setReply(value.text);
      setText(current => { if (current.trim() !== message) return current; sessionStorage.removeItem('pace.pet-draft'); return ''; });
    } catch (cause) { if (request.current === id) setError(errorText(cause)); }
    finally { if (request.current === id) { request.current = undefined; setBusy(false); } }
  };
  return <main className="pace-cloud chat-cloud" aria-label="Chat with Pace">
    <header className="cloud-header"><div className="cloud-portrait"><Pace action={busy ? 'think' : reply ? 'talk' : 'idle'} size={28} pack={state.packs.find(pack => pack.id === state.settings.activePack)} /><strong>{meetingId ? 'Ask about this meeting' : 'Chat with Pace'}</strong></div><button aria-label="Close chat" onClick={() => void api('window.close', { label: 'command' }).catch(cause => setError(errorText(cause)))}><X size={14} /></button></header>
    <div className="chat-reply" role="status" tabIndex={0}>{error ? <p role="alert">{error}{/model|Qwen/i.test(error) && <button onClick={() => void api('window.main', { page: 'models' })}>Open Local models</button>}</p> : busy ? 'Hmm…' : reply || (meetingId ? 'What would you like to know about this conversation?' : 'Hey! What’s on your mind?')}{!busy && reply && <Sparkles className="chat-emote" size={12} aria-label="Pace is happy" />}</div>
    <form onSubmit={event => { event.preventDefault(); void send(); }}><input ref={input} autoFocus aria-label="Message Pace" placeholder={meetingId ? 'Ask about the meeting…' : 'Say something…'} value={text} maxLength={16000} onChange={event => { setText(event.target.value); sessionStorage.setItem('pace.pet-draft', event.target.value); }} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }} /><button aria-label="Send message" disabled={busy || !text.trim()}>{busy ? <LoaderCircle size={14} className="spin" /> : <ArrowUp size={14} />}</button></form>
    <span className="cloud-tail" aria-hidden="true" />
  </main>;
}
