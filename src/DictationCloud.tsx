import { useEffect, useRef, useState } from 'react';
import { Square, X } from 'lucide-react';
import { api, subscribe, type AppState } from './api';
import './dictation-cloud.css';

type DictationState = { phase: 'idle' | 'starting' | 'recording' | 'transcribing' | 'draft' | 'inserted' | 'dispatched' | 'error' };

export function DictationCloud({ state }: { state: AppState }) {
  const [current, setCurrent] = useState<DictationState>();
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const version = useRef(0);
  const mounted = useRef(true);
  const levelTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const accept = (value: DictationState) => {
    if (!mounted.current || !value?.phase) return;
    setCurrent(value); setLevel(0);
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
          clearTimeout(levelTimeout.current); levelTimeout.current = setTimeout(() => setLevel(0), 350);
        }
      }
    }).then(value => {
      if (cancelled) { value(); return; }
      dispose = value; void load().catch(() => {});
    }).catch(() => {});
    return () => { cancelled = true; mounted.current = false; dispose?.(); clearTimeout(levelTimeout.current); document.documentElement.classList.remove('overlay-document'); };
  }, []);
  const run = async (method: 'dictation.toggle' | 'dictation.cancel') => {
    if (busy && method !== 'dictation.cancel') return;
    setBusy(true);
    try { await api(method); await load(); }
    finally { if (mounted.current) setBusy(false); }
  };
  const starting = current?.phase === 'starting';
  const recording = current?.phase === 'recording';
  const transcribing = current?.phase === 'transcribing';
  if (!starting && !recording && !transcribing) return null;
  return <main className="dictation-cloud" aria-label="Dictation with Pace" title={`${state.settings.dictationShortcut}: hold to speak, release to finish; tap to start, tap again to finish.`}>
    <div className="dictation-signal"><span role="status">{starting ? 'Opening mic…' : recording ? 'Listening…' : 'Thinking…'}</span>{recording ? <><span className="dictation-pixels" aria-hidden="true">{[.02, .06, .12, .2, .3].map((threshold, index) => <i key={threshold} className={Math.min(1, level * 8) >= threshold ? 'lit' : ''} style={{ height: `${4 + Math.min(index, 4 - index) * 4}px` }} />)}</span><meter className="sr-only" aria-label="Microphone level" min={0} max={1} value={level} /></> : <span className="dictation-work" aria-hidden="true"><i /><i /><i /></span>}</div>
    {recording && <button className="dictation-toggle" aria-label="Stop dictation" disabled={busy} onClick={() => void run('dictation.toggle').catch(() => {})}><Square size={10} fill="currentColor" /></button>}
    <button className="dictation-dismiss" aria-label="Cancel dictation" disabled={transcribing} onClick={() => void run('dictation.cancel').catch(() => {})}><X size={12} /></button>
  </main>;
}
