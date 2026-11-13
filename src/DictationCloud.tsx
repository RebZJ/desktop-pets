import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, LoaderCircle, Mic, Square, X } from 'lucide-react';
import { api, copyText, errorText, subscribe, type AppState } from './api';
import { Pace } from './Pace';
import './dictation-cloud.css';

type DictationState = { phase: 'idle' | 'starting' | 'recording' | 'transcribing' | 'draft' | 'inserted' | 'error'; text?: string; error?: string; savedAudio?: boolean };

export function DictationCloud({ state }: { state: AppState }) {
  const [current, setCurrent] = useState<DictationState>();
  const [draft, setDraft] = useState(() => sessionStorage.getItem('pace.dictation-draft') || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [level, setLevel] = useState(0);
  const version = useRef(0);
  const recognized = useRef(sessionStorage.getItem('pace.dictation-source') || '');
  const mounted = useRef(true);
  const levelTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const accept = (value: DictationState) => {
    if (!mounted.current || !value?.phase) return;
    setCurrent(value);
    if (value.phase === 'starting' || value.phase === 'recording') {
      recognized.current = ''; sessionStorage.removeItem('pace.dictation-source'); setExpanded(false);
    }
    if (value.text?.trim() && !['starting', 'recording', 'transcribing'].includes(value.phase) && value.text !== recognized.current) {
      recognized.current = value.text; sessionStorage.setItem('pace.dictation-source', value.text);
      setDraft(value.text); sessionStorage.setItem('pace.dictation-draft', value.text); setCopied(false);
    }
    if (value.phase === 'draft') setExpanded(true);
    setLevel(0); setError(value.error || '');
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
        if (typeof value === 'number' && Number.isFinite(value)) {
          setLevel(Math.max(0, Math.min(1, value)));
          clearTimeout(levelTimeout.current);
          levelTimeout.current = setTimeout(() => setLevel(0), 350);
        }
      }
    }).then(value => {
      if (cancelled) { value(); return; }
      dispose = value;
      void load().catch(cause => { if (mounted.current) setError(errorText(cause)); });
    }).catch(cause => { if (mounted.current) setError(errorText(cause)); });
    return () => { cancelled = true; mounted.current = false; dispose?.(); clearTimeout(levelTimeout.current); document.documentElement.classList.remove('overlay-document'); };
  }, []);
  const starting = current?.phase === 'starting';
  const recording = current?.phase === 'recording';
  const transcribing = current?.phase === 'transcribing';
  const active = starting || recording;
  const review = expanded && !active && !transcribing && Boolean(draft.trim());
  const mode = review ? 'draft' : error ? 'error' : 'compact';
  useEffect(() => { void api('window.dictationSize', { mode }).catch(() => {}); }, [mode]);
  const runDictation = async (method: 'dictation.toggle' | 'dictation.retry' | 'dictation.cancel') => {
    if ((busy && method !== 'dictation.cancel') || !current || transcribing) return;
    setBusy(true); setError(''); setCopied(false);
    try { await api(method); await load(); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const status = !current ? error ? 'Status unavailable' : 'Checking…' : starting ? 'Opening mic…' : recording ? 'Listening…' : transcribing ? 'Transcribing…' : copied ? 'Copied.' : current.phase === 'inserted' ? 'Typed into your app.' : current.phase === 'draft' ? 'Ready to copy.' : current.phase === 'error' ? 'Needs attention' : 'Ready to dictate';
  const shortcutHint = `${state.settings.dictationShortcut}: hold to speak, release to finish; tap to start, tap again to finish.`;
  return <main className={`pace-cloud dictation-cloud ${review ? 'has-draft' : ''}`} aria-label="Dictation with Pace" title={shortcutHint}>
    <div className="dictation-strip">
      <Pace action={recording ? 'dictate' : starting || transcribing ? 'think' : 'idle'} size={24} pack={state.packs.find(pack => pack.id === state.settings.activePack)} label={`Pace is ${recording ? 'dictate' : starting || transcribing ? 'think' : 'idle'}`} />
      <div className="dictation-signal"><span role="status">{status}</span>{recording && <meter aria-label="Microphone level" min={0} max={1} value={level} />}{!active && !transcribing && draft.trim() && <button className="dictation-review" aria-expanded={review} onClick={() => setExpanded(!expanded)}>{review ? <ChevronUp size={11} /> : <ChevronDown size={11} />}{review ? 'Hide words' : 'Review words'}</button>}</div>
      {current?.phase === 'inserted' && !copied ? <Check className="dictation-success" size={14} aria-hidden="true" /> : null}
      <button className="dictation-toggle" aria-label={transcribing ? 'Transcribing…' : active ? 'Stop dictation' : 'Start dictation'} title={active ? 'Finish and type into your app' : shortcutHint} disabled={busy || !current || transcribing} onClick={() => void runDictation('dictation.toggle')}>{busy || starting || transcribing ? <LoaderCircle size={14} className="spin" /> : recording ? <Square size={12} fill="currentColor" /> : <Mic size={14} />}</button>
      <button className="dictation-dismiss" aria-label={active ? 'Cancel dictation' : 'Close dictation'} title={active ? 'Discard this recording' : 'Close'} disabled={transcribing} onClick={() => active ? void runDictation('dictation.cancel') : void api('window.close', { label: 'bubble' }).catch(cause => setError(errorText(cause)))}><X size={14} /></button>
    </div>
    {error && <div className="cloud-error" role="alert">{error}{current?.savedAudio && <button className="cloud-access" disabled={busy || transcribing} onClick={() => void runDictation('dictation.retry')}>Retry saved audio</button>}{!current && <button className="cloud-access" onClick={() => void load().catch(cause => setError(errorText(cause)))}>Retry status</button>}{/Local models|install.*(pack|model)/i.test(error) && <button className="cloud-access" onClick={() => void api('window.main', { page: 'models' }).catch(cause => setError(errorText(cause)))}>Open Local models</button>}{/microphone/i.test(error) && <button className="cloud-access" onClick={() => void api('permissions.request', { kind: 'microphone' }).catch(cause => setError(errorText(cause)))}>Allow microphone</button>}</div>}
    {review && <><textarea aria-label="Dictation text" value={draft} onChange={event => { setDraft(event.target.value); sessionStorage.setItem('pace.dictation-draft', event.target.value); setCopied(false); }} /><button className="dictation-copy" aria-label="Copy dictation" onClick={() => void copyText(draft).then(() => setCopied(true)).catch(cause => setError(errorText(cause)))}><Copy size={13} />{copied ? 'Copied' : 'Copy words'}</button></>}
  </main>;
}
