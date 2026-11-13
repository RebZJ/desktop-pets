import { useEffect, useState } from 'react';
import { Check, Copy, LoaderCircle, X } from 'lucide-react';
import { api, errorText, subscribe } from './api';

type Suggestion = { phase?: string; version?: number; text?: string; targetId?: string; app?: string; error?: string };

export function AutocompleteCloud() {
  const [suggestion, setSuggestion] = useState<Suggestion>({});
  const [text, setText] = useState('');
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [targetRejected, setTargetRejected] = useState(false);
  useEffect(() => { document.documentElement.classList.add('overlay-document'); return () => document.documentElement.classList.remove('overlay-document'); }, []);
  useEffect(() => {
    let closed = false; let dispose: (() => void) | undefined; let version = 0; let latest = -1;
    const accept = (next: Suggestion | null) => { if (closed || !next || (next.version !== undefined && next.version < latest)) return; latest = Math.max(latest, next.version ?? latest); setSuggestion(next); setText(next.text || ''); setError(next.error || ''); setCopied(false); setTargetRejected(false); };
    void subscribe((event, data) => { if (event === 'completion.state' || event === 'completion.suggested') { version++; accept(data as Suggestion); } }).then(value => {
      if (closed) { value(); return; } dispose = value; const snapshot = version;
      void api<Suggestion | null>('completion.current').then(next => { if (version === snapshot) accept(next); }).catch(cause => setError(errorText(cause)));
    });
    return () => { closed = true; dispose?.(); };
  }, []);
  const dismiss = () => { void api('completion.dismiss', { targetId: suggestion.targetId }).catch(cause => setError(errorText(cause))); };
  const apply = async () => {
    if (!text.trim() || !suggestion.targetId || applying || targetRejected || suggestion.error) return;
    setApplying(true); setError('');
    try { await api('completion.apply', { targetId: suggestion.targetId, text }); }
    catch (cause) { setError(errorText(cause)); setTargetRejected(true); }
    finally { setApplying(false); }
  };
  return <main className="pace-cloud completion-cloud" aria-label="Autocomplete at your cursor">
    <header className="cloud-header"><strong>Write for me</strong><span>{suggestion.app || 'At your cursor'}</span><button className="cloud-close" aria-label="Dismiss suggestion" onClick={dismiss}><X size={16} /></button></header>
    {suggestion.phase === 'generating' ? <p className="completion-wait" role="status"><LoaderCircle size={15} className="spin" />Finding the next few words…</p> : suggestion.targetId ? <textarea aria-label="Suggested continuation" value={text} maxLength={4000} onChange={event => setText(event.target.value)} spellCheck={false} /> : <p className="completion-empty">Put your cursor where you’re writing, then press your autocomplete shortcut. Pace will suggest what comes next.</p>}
    {error && <p role="alert" className="cloud-error">{error}{error.includes('Accessibility') && <button className="cloud-access" onClick={() => { void api('permissions.request', { kind: 'accessibility' }).catch(cause => setError(errorText(cause))); }}>Open Accessibility settings</button>}</p>}
    <footer className="completion-actions"><span>Your words stay yours.</span>{text && <button className="cloud-copy" aria-label="Copy suggestion" onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(cause => setError(errorText(cause))); }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy'}</button>}<button className="completion-accept" disabled={!text.trim() || !suggestion.targetId || applying || targetRejected || !!suggestion.error} onClick={() => void apply()}>{applying ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Accept</button></footer>
    <span className="cloud-tail" aria-hidden="true" />
  </main>;
}
