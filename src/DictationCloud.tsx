import { useEffect, useRef, useState } from 'react';
import { Copy, LoaderCircle, Mic, Square, X } from 'lucide-react';
import { api, copyText, errorText, subscribe, type AppState } from './api';
import { Pace } from './Pace';
import './dictation-cloud.css';

type DictationState = { phase: 'idle' | 'recording' | 'transcribing' | 'draft' | 'inserted' | 'error'; text?: string; error?: string; savedAudio?: boolean };

export function DictationCloud({ state }: { state: AppState }) {
  const [current, setCurrent] = useState<DictationState>();
  const [draft, setDraft] = useState(() => sessionStorage.getItem('pace.dictation-draft') || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [level, setLevel] = useState(0);
  const version = useRef(0);
  const recognized = useRef(sessionStorage.getItem('pace.dictation-source') || '');
  const mounted = useRef(true);
  const accept = (value: DictationState) => {
    if (!mounted.current || !value?.phase) return;
    setCurrent(value);
    if (value.phase === 'recording') { recognized.current = ''; sessionStorage.removeItem('pace.dictation-source'); }
    if (value.text?.trim() && value.phase !== 'recording' && value.phase !== 'transcribing' && value.text !== recognized.current) { recognized.current = value.text; sessionStorage.setItem('pace.dictation-source', value.text); setDraft(value.text); sessionStorage.setItem('pace.dictation-draft', value.text); setCopied(false); }
    setLevel(0);
    if (value.error) setError(value.error);
    else if (value.phase === 'recording') setError('');
  };
  const load = async () => {
    const snapshot = version.current;
    const value = await api<DictationState>('dictation.current');
    if (version.current === snapshot) accept(value);
  };
  useEffect(() => {
    mounted.current = true;
    document.documentElement.classList.add('overlay-document');
    let dispose: (() => void) | undefined; let cancelled = false;
    void subscribe((event, data) => {
      if (cancelled) return;
      if (event === 'dictation.state') { version.current++; accept(data as DictationState); }
      if (event === 'dictation.level') {
        const value = (data as { rms?: number } | null)?.rms;
        if (typeof value === 'number' && Number.isFinite(value)) setLevel(Math.max(0, Math.min(1, value)));
      }
    }).then(value => {
      if (cancelled) { value(); return; }
      dispose = value;
      void load().catch(cause => { if (mounted.current) setError(errorText(cause)); });
    }).catch(cause => { if (mounted.current) setError(errorText(cause)); });
    return () => { cancelled = true; mounted.current = false; dispose?.(); document.documentElement.classList.remove('overlay-document'); };
  }, []);
  const runDictation = async (method: 'dictation.toggle' | 'dictation.retry') => {
    if (busy || !current || current.phase === 'transcribing') return;
    setBusy(true); setError(''); setCopied(false);
    try { await api(method); await load(); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const recording = current?.phase === 'recording';
  const transcribing = current?.phase === 'transcribing';
  const status = !current ? error ? 'Status unavailable.' : 'Checking dictation…' : recording ? 'Listening…' : transcribing ? 'Transcribing…' : copied ? 'Copied.' : current?.phase === 'inserted' ? 'Typed into your app.' : current?.phase === 'draft' ? 'Ready to review or copy.' : 'Ready when you are.';
  return <main className="pace-cloud dictation-cloud" aria-label="Dictation with Pace">
    <header className="cloud-header"><div className="cloud-portrait"><Pace action={recording ? 'dictate' : transcribing ? 'think' : 'idle'} size={32} pack={state.packs.find(pack => pack.id === state.settings.activePack)} label={`Pace is ${recording ? 'dictate' : transcribing ? 'think' : 'idle'}`} /><strong>Dictation</strong></div><button aria-label="Copy dictation" title="Copy dictation" disabled={!draft.trim() || recording || transcribing} onClick={() => void copyText(draft).then(() => setCopied(true)).catch(cause => setError(errorText(cause)))}><Copy size={14} /></button><button className="cloud-close" aria-label="Close dictation" title="Close" onClick={() => void api('window.close', { label: 'bubble' }).catch(cause => setError(errorText(cause)))}><X size={16} /></button></header>
    <textarea aria-label="Dictation text" value={draft} readOnly={recording || transcribing} onChange={event => { setDraft(event.target.value); sessionStorage.setItem('pace.dictation-draft', event.target.value); setCopied(false); }} placeholder="Your words appear here." />
    {error && <div className="cloud-error" role="alert">{error}{current?.savedAudio && <button className="cloud-access" disabled={busy || transcribing} onClick={() => void runDictation('dictation.retry')}>Retry saved audio</button>}{!current && <button className="cloud-access" onClick={() => void load().catch(cause => setError(errorText(cause)))}>Retry status</button>}{/Local models|install.*(pack|model)/i.test(error) && <button className="cloud-access" onClick={() => void api('window.main', { page: 'models' }).catch(cause => setError(errorText(cause)))}>Open Local models</button>}{/microphone/i.test(error) && <button className="cloud-access" onClick={() => void api('permissions.request', { kind: 'microphone' }).catch(cause => setError(errorText(cause)))}>Allow microphone</button>}</div>}
    <footer className="dictation-actions"><div><span role="status">{status}</span>{recording && <meter aria-label="Microphone level" min={0} max={1} value={level} />}</div><button className="dictation-toggle" disabled={busy || !current || transcribing} onClick={() => void runDictation('dictation.toggle')}>{busy || transcribing ? <LoaderCircle size={14} className="spin" /> : recording ? <Square size={14} /> : <Mic size={14} />}{transcribing ? 'Transcribing…' : recording ? 'Stop dictation' : 'Start dictation'}</button></footer>
    <span className="cloud-tail" aria-hidden="true" />
  </main>;
}
