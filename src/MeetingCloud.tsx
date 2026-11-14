import { useEffect, useState } from 'react';
import { AudioLines, FileText, LoaderCircle, MessageCircle, Mic, Square, X } from 'lucide-react';
import { api, clockTime, errorText, recognitionModelId, subscribe, type AppState, type Meeting } from './api';
import './meeting-cloud.css';

type Levels = { sessionId: string; level: { rms: number; peak: number }; tracks?: Array<{ track: string; level: { rms: number; peak: number } }> };

export function MeetingCloud({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const active = state.meetings.find(meeting => ['recording', 'finalizing'].includes(meeting.status));
  const [selectedId, setSelectedId] = useState<string>();
  const meeting = active || state.meetings.find(meeting => meeting.id === selectedId);
  const [title, setTitle] = useState('');
  const [microphone, setMicrophone] = useState(true);
  const [system, setSystem] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<Levels>();
  const [heardAudio, setHeardAudio] = useState(false);
  const recognition = recognitionModelId(state.settings, state.models, true);
  const kit = ['qwen3.5-4b', 'nemotron-diarization', recognition];
  const ready = Boolean(recognition) && kit.every(id => state.models.some(model => model.id === id && model.installed));
  const recording = meeting?.status === 'recording';
  const noAudio = recording && elapsed >= 8 && levels?.sessionId === meeting.id && !heardAudio && !meeting.segments.some(segment => segment.text.trim());
  const message = error || meeting?.error || (noAudio ? 'No audio coming in. Check your microphone and call output.' : '');
  const layout = !meeting ? 'setup' : message ? 'message' : 'compact';
  useEffect(() => { document.documentElement.classList.add('overlay-document'); return () => document.documentElement.classList.remove('overlay-document'); }, []);
  useEffect(() => { if (active) setSelectedId(active.id); }, [active?.id]);
  useEffect(() => { void api('window.meetingLayout', { layout }).catch(cause => setError(errorText(cause))); }, [layout]);
  useEffect(() => {
    setLevels(undefined); setHeardAudio(false);
    let dispose: (() => void) | undefined; let cancelled = false;
    void subscribe((event, data) => {
      const value = data as Levels | null;
      if (cancelled || event !== 'meeting.level' || value?.sessionId !== meeting?.id || !value?.level) return;
      setLevels(value); if ([value.level, ...(value.tracks || []).map(track => track.level)].some(level => Number.isFinite(level?.peak) && level.peak > 0.0001)) setHeardAudio(true);
    }).then(value => { if (cancelled) value(); else dispose = value; }).catch(cause => { if (!cancelled) setError(errorText(cause)); });
    return () => { cancelled = true; dispose?.(); };
  }, [meeting?.id]);
  useEffect(() => {
    if (!meeting) return;
    const tick = () => setElapsed(Math.max(0, (Date.now() - new Date(meeting.startedAt).getTime()) / 1000));
    tick(); if (!recording) return;
    const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [meeting?.id, recording]);
  const run = async (key: string, operation: () => Promise<unknown>) => {
    if (busy) return; setBusy(key); setError('');
    try { await operation(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(''); }
  };
  const openNotes = () => void api('window.main', { page: 'meetings', ...(meeting ? { meetingId: meeting.id } : {}) }).catch(cause => setError(errorText(cause)));
  const close = () => void api('window.close', { label: 'meeting' }).catch(cause => setError(errorText(cause)));
  const start = () => void run('start', async () => {
    const result = await api<Meeting>('meeting.start', { title: title.trim() || 'Untitled meeting', language: state.settings.language, captureMicrophone: microphone, captureSystem: system });
    setSelectedId(result.id); await refresh();
  });
  const inputLevels = levels ? [levels.level, ...(levels.tracks || []).map(track => track.level)] : [];
  const meter = Math.min(1, Math.sqrt(Math.max(0, ...inputLevels.map(level => Number.isFinite(level?.rms) ? level.rms : 0))) * 3);
  return <main className={`meeting-widget ${meeting ? 'meeting-widget-live' : 'meeting-widget-setup'}`} aria-label="Meeting with Pace">
    {!meeting ? <>
      <header><h1>Take meeting notes</h1><button aria-label="Close meeting cloud" onClick={close}><X size={14} /></button></header>
      <form id="meeting-start-form" onSubmit={event => { event.preventDefault(); if (ready && (microphone || system)) start(); }}>
        <label className="sr-only" htmlFor="quick-meeting-title">Meeting title</label><input id="quick-meeting-title" value={title} maxLength={160} onChange={event => setTitle(event.target.value)} placeholder="Meeting name (optional)" />
        <fieldset disabled={Boolean(busy)}><legend>Listen to</legend><label><input type="checkbox" checked={microphone} onChange={event => setMicrophone(event.target.checked)} />Microphone</label><label><input type="checkbox" checked={system} onChange={event => setSystem(event.target.checked)} />System audio</label></fieldset>
        <p className="meeting-setup-help">Let everyone know. Stop when you’re done; Pace makes the notes.</p>
        {!ready && <button className="meeting-model-link" type="button" onClick={() => void api('window.main', { page: recognition ? 'models' : 'settings' }).catch(cause => setError(errorText(cause)))}>{recognition ? 'Download selected meeting models →' : 'Choose a meeting language in Settings →'}</button>}
      </form>
    </> : <div className="meeting-widget-bar">
      <div className="meeting-signal" title={levels?.tracks?.map(track => `${track.track}: ${track.level.peak > 0.0001 ? 'audio detected' : 'quiet'}`).join(' · ') || 'Checking audio input'}><AudioLines size={15} /><meter aria-label="Meeting audio level" min={0} max={1} value={meter} /></div>
      <div className="meeting-widget-status"><strong role="status">{recording ? `Recording ${clockTime(elapsed)}` : meeting.status === 'finalizing' ? 'Preparing notes…' : meeting.status === 'interrupted' ? 'Needs attention' : 'Notes ready'}</strong><small title={meeting.title}>{meeting.title}</small></div>
      <button aria-label="Open meeting notes" title="Open notes and transcript" onClick={openNotes}><FileText size={15} /></button>
      <button aria-label="Ask Pace about this meeting" title="Ask about this meeting" disabled={!meeting.segments.some(segment => segment.text.trim())} onClick={() => void api('window.chat', { meetingId: meeting.id }).catch(cause => setError(errorText(cause)))}><MessageCircle size={15} /></button>
      {recording ? <button className="meeting-stop" aria-label="Stop meeting" title="Stop and make notes" disabled={busy === 'stop'} onClick={() => void run('stop', async () => { await api('meeting.stop', { id: meeting.id }); await refresh(); })}>{busy === 'stop' ? <LoaderCircle size={14} className="spin" /> : <Square size={13} />}</button> : meeting.status === 'finalizing' ? <LoaderCircle size={14} className="spin" /> : <button aria-label="New meeting" title="New meeting" onClick={() => { setSelectedId(undefined); setTitle(''); setError(''); }}><Mic size={14} /></button>}
      <button aria-label="Close meeting cloud" title="Hide widget; keep recording" onClick={close}><X size={13} /></button>
    </div>}
    {message && <div className="meeting-widget-error" role="alert">{message}{meeting?.status === 'interrupted' && <button onClick={openNotes}>Open saved recording →</button>}{/Screen|system audio/i.test(error) && !meeting && <button onClick={() => { setSystem(false); setError(''); }}>Use microphone only</button>}</div>}
    {!meeting && <footer><button onClick={openNotes}>All notes</button><button className="meeting-start" type="submit" form="meeting-start-form" disabled={Boolean(busy) || !ready || (!microphone && !system)}>{busy === 'start' ? <LoaderCircle size={13} className="spin" /> : <Mic size={13} />}{busy === 'start' ? 'Starting…' : 'Start meeting'}</button></footer>}
  </main>;
}
