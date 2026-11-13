import { useEffect, useRef, useState } from 'react';
import { ArrowUp, AudioLines, EyeOff, FileText, LoaderCircle, Shield, Square, X } from 'lucide-react';
import { api, clockTime, errorText, subscribe, type AppState, type Meeting } from './api';
import { Pace } from './Pace';
import './meeting-cloud.css';

const kit = ['qwen3.5-4b', 'whisper-turbo', 'nemotron-diarization'];

export function MeetingCloud({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const active = state.meetings.find(meeting => ['recording', 'finalizing'].includes(meeting.status));
  const [selectedId, setSelectedId] = useState<string>();
  const [startingNew, setStartingNew] = useState(false);
  const meeting = active || (startingNew ? undefined : state.meetings.find(item => item.id === selectedId) || state.meetings[0]);
  const [title, setTitle] = useState('');
  const [microphone, setMicrophone] = useState(true);
  const [system, setSystem] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tip, setTip] = useState<{ sessionId: string; text: string }>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ meetingId: string; text: string }>();
  const [asking, setAsking] = useState(false);
  const request = useRef<string | undefined>(undefined);
  const transcript = useRef<HTMLDivElement>(null);
  const recordingId = meeting?.status === 'recording' ? meeting.id : undefined;
  const locked = Boolean(active);
  const covered = state.settings.captureProtectionEnabled !== false;
  const ready = kit.every(id => state.models.some(model => model.id === id && model.installed));
  const coverHelp = `Capture protection is ${covered ? 'requested' : 'off'}. macOS screen-capture exclusion is best effort; some sharing apps may still show Pace. Quick hide: ${state.settings.hideShortcut}. Hiding does not stop recording.`;

  useEffect(() => { document.documentElement.classList.add('overlay-document'); return () => document.documentElement.classList.remove('overlay-document'); }, []);
  useEffect(() => { if (active) { setSelectedId(active.id); setStartingNew(false); } }, [active?.id]);
  useEffect(() => { request.current = undefined; setAsking(false); setQuestion(''); setAnswer(undefined); }, [meeting?.id]);
  useEffect(() => () => { request.current = undefined; }, []);
  useEffect(() => { setEditing(false); setDraft(meeting ? sessionStorage.getItem(`pace.notes-draft.${meeting.id}`) ?? meeting.notes ?? '' : ''); }, [meeting?.id]);
  useEffect(() => { if (editing && meeting) sessionStorage.setItem(`pace.notes-draft.${meeting.id}`, draft); }, [draft, editing, meeting?.id]);
  useEffect(() => {
    if (!recordingId) return;
    let dispose: (() => void) | undefined; let cancelled = false; let version = 0;
    const accept = (data: unknown) => {
      if (cancelled || !data || typeof data !== 'object') return;
      const value = data as { sessionId?: string; text?: string };
      if (value.sessionId === recordingId && typeof value.text === 'string' && value.text.trim()) {
        version++; setTip({ sessionId: value.sessionId, text: value.text });
      }
    };
    void subscribe((event, data) => { if (event === 'meeting.tip') accept(data); }).then(value => {
      if (cancelled) { value(); return; }
      dispose = value;
      const snapshot = version;
      void api('meeting.tip.current', { id: recordingId }).then(data => { if (version === snapshot) accept(data); }).catch(cause => { if (!cancelled) setError(errorText(cause)); });
    }).catch(cause => { if (!cancelled) setError(errorText(cause)); });
    return () => { cancelled = true; dispose?.(); };
  }, [recordingId]);
  useEffect(() => {
    const element = transcript.current;
    if (!element) return;
    const follow = () => { element.scrollTop = element.scrollHeight; };
    follow();
    const observer = new ResizeObserver(follow); observer.observe(element);
    return () => observer.disconnect();
  }, [meeting?.id, meeting?.segments, locked]);

  const run = async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(key); setError('');
    try { await operation(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(''); }
  };
  const open = (page: string) => void run('open', async () => { await api('window.main', { page }); });
  const start = () => void run('start', async () => {
    const value = await api<Meeting>('meeting.start', { title: title.trim() || 'Untitled meeting', language: state.settings.language, captureMicrophone: microphone, captureSystem: system });
    setSelectedId(value.id); setStartingNew(false); setTip(undefined); await refresh();
  });
  const save = () => void run('save', async () => {
    if (!meeting) return;
    await api('meeting.update', { id: meeting.id, notes: draft });
    sessionStorage.removeItem(`pace.notes-draft.${meeting.id}`); setEditing(false); await refresh();
  });
  const process = (retry: boolean) => void run('notes', async () => {
    if (!meeting) return;
    await api(retry ? 'meeting.retry' : 'meeting.summarize', { id: meeting.id, language: state.settings.language }); await refresh();
  });
  const ask = async () => {
    if (!meeting || !meeting.segments.length || !question.trim() || request.current) return;
    const text = question.trim(); const id = crypto.randomUUID(); const meetingId = meeting.id;
    request.current = id; setAsking(true); setError('');
    try {
      const result = await api<{ text: string }>('chat.send', { meetingId, conversationId: `meeting-${meetingId}`, text, quiet: true, clientRequestId: id });
      if (request.current !== id) return;
      if (!result.text?.trim()) throw new Error('Pace returned an empty answer. Try your question again.');
      setAnswer({ meetingId, text: result.text }); setQuestion(current => current.trim() === text ? '' : current);
    } catch (cause) { if (request.current === id) setError(errorText(cause)); }
    finally { if (request.current === id) { request.current = undefined; setAsking(false); } }
  };
  const currentTip = meeting?.status === 'recording' && tip && tip.sessionId === meeting.id && state.settings.meetingTips ? tip.text : '';

  return <main className="pace-cloud meeting-cloud" aria-label="Meeting with Pace" aria-busy={Boolean(busy)}>
    <header className="cloud-header" data-tauri-drag-region><strong>Meeting with Pace</strong><button className="cloud-close" aria-label="Close meeting cloud" disabled={Boolean(busy)} onClick={() => void run('close', async () => { await api('window.close', { label: 'meeting' }); })}><X size={16} /></button></header>
    <div className="meeting-cover-row"><span className={`meeting-cover ${covered ? '' : 'off'}`} tabIndex={0} title={coverHelp} aria-describedby="meeting-cover-help"><Shield size={12} />{covered ? 'Shh… cover requested' : 'Cover off'}</span><span id="meeting-cover-help" className="sr-only">{coverHelp}</span><button title={`Hide Pace and its clouds · ${state.settings.hideShortcut}. Recording continues.`} disabled={Boolean(busy)} onClick={() => void run('hide', async () => { await api('pet.toggle', { visible: false }); })}><EyeOff size={13} />Quick hide</button></div>
    {error && <div className="cloud-error" role="alert"><p className="meeting-error-message">{error}</p>{/Screen|system audio/i.test(error) && <div className="meeting-permission-actions"><button disabled={Boolean(busy)} onClick={() => void run('access', async () => { await api('permissions.request', { kind: 'screenRecording' }); })}>Allow system audio</button>{!locked && <button disabled={Boolean(busy)} onClick={() => { setSystem(false); setError(''); }}>Use microphone only</button>}</div>}{/microphone/i.test(error) && !/Screen|system audio/i.test(error) && <button disabled={Boolean(busy)} onClick={() => void run('access', async () => { await api('permissions.request', { kind: 'microphone' }); })}>Allow microphone</button>}</div>}
    <div className="meeting-cloud-body">
      {!meeting ? <>
        <div className="meeting-greeting"><Pace action={covered ? 'hush' : 'listen'} size={44} pack={state.packs.find(pack => pack.id === state.settings.activePack)} /><div><h1>A quiet pair of ears.</h1><p>Live words, useful nudges, then your notes.</p></div></div>
        {!ready && <div className="meeting-kit"><p>Meeting help needs Qwen 4B, Whisper turbo and the speaker-label pack.</p><button disabled={Boolean(busy)} onClick={() => open('models')}>Choose meeting models →</button><span>Optional downloads. Nothing starts automatically.</span></div>}
        <form id="meeting-start-form" className="meeting-setup" onSubmit={event => { event.preventDefault(); if (ready && (microphone || system)) start(); }}>
          <label>Meeting title<input value={title} maxLength={200} disabled={Boolean(busy)} onChange={event => setTitle(event.target.value)} placeholder="A name for this conversation" /></label>
          <div className="meeting-capture"><label><input type="checkbox" checked={microphone} disabled={Boolean(busy)} onChange={event => setMicrophone(event.target.checked)} />Microphone</label><label><input type="checkbox" checked={system} disabled={Boolean(busy)} onChange={event => setSystem(event.target.checked)} />System audio</label></div>
          <p className="meeting-consent">Let people know you’re recording. Pace stays muted.</p>
        </form>
      </> : <>
        <div className="meeting-now"><Pace action={meeting.status === 'recording' ? 'listen' : 'type'} size={36} pack={state.packs.find(pack => pack.id === state.settings.activePack)} /><div><h1 title={meeting.title}>{meeting.title}</h1><span role="status">{meeting.status === 'recording' ? '● Live · voice off' : meeting.status === 'finalizing' ? 'Finishing speaker labels & notes…' : meeting.status === 'interrupted' ? 'Saved · needs recovery' : 'Saved on your device'}</span></div></div>
        {meeting.error && <p className="meeting-record-error" role="status">{meeting.error}</p>}
        {locked ? <><section className="meeting-live"><div className="meeting-section-label"><AudioLines size={12} /><h2>Latest words</h2><span>Provisional labels</span></div><div className="meeting-live-words" ref={transcript} tabIndex={0} aria-label="Live transcript">{meeting.segments.length ? meeting.segments.slice(-4).map((segment, index) => <div className="meeting-live-turn" key={segment.id || `${segment.start}-${index}`}><span>{segment.speaker} · {clockTime(segment.start)}</span><p>{segment.text}</p></div>) : <p className="meeting-waiting">Listening for the first words. Nothing transcribed yet.</p>}</div></section><aside className="meeting-tip" aria-label="Quiet meeting help"><strong>PACE’S QUIET NUDGE</strong><p aria-live="polite">{currentTip || (meeting.status === 'finalizing' ? 'Your provisional transcript is safe while processing finishes.' : state.settings.meetingTips ? 'A useful question will appear here when Pace has one.' : 'Live tips are off in Settings. Your transcript still appears above.')}</p></aside></> : <section className="meeting-cloud-notes"><div className="meeting-section-label"><FileText size={12} /><h2>Your notes</h2><button disabled={Boolean(busy)} onClick={() => { setDraft(sessionStorage.getItem(`pace.notes-draft.${meeting.id}`) ?? meeting.notes ?? ''); setEditing(!editing); }}>{editing ? 'Back' : meeting.notes ? 'Edit' : 'Add your own'}</button></div>{editing ? <textarea aria-label="Edit meeting notes" value={draft} maxLength={100000} disabled={Boolean(busy)} onChange={event => setDraft(event.target.value)} /> : <div className="meeting-notes-text" tabIndex={0}>{meeting.notes || 'No notes yet. Make notes from the saved transcript, or add your own.'}{Boolean(meeting.actionItems?.length) && <ul>{meeting.actionItems!.map((item, index) => <li key={index}>{typeof item === 'string' ? item : `${item.done ? '✓ ' : ''}${item.text}`}</li>)}</ul>}</div>}</section>}
        {answer?.meetingId === meeting.id && <p className="meeting-copilot-answer" aria-label="Pace’s meeting answer" tabIndex={0}>{answer.text}</p>}
      </>}
    </div>
    {meeting && !editing && <form className="meeting-copilot" onSubmit={event => { event.preventDefault(); void ask(); }}><input aria-label="Ask Pace about this meeting" placeholder={meeting.segments.length ? 'Ask about this meeting…' : 'Questions unlock with the transcript'} value={question} maxLength={8000} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }} /><button aria-label="Ask Pace" title="Ask Pace · this meeting only, voice off" disabled={asking || !question.trim() || !meeting.segments.length}>{asking ? <LoaderCircle size={14} className="spin" /> : <ArrowUp size={14} />}</button></form>}
    <footer className="meeting-cloud-actions">
      {!meeting ? <><span>{state.settings.hideShortcut} hides Pace</span><button className="meeting-primary" type="submit" form="meeting-start-form" disabled={Boolean(busy) || !ready || (!microphone && !system)}>{busy === 'start' ? <LoaderCircle size={13} className="spin" /> : <AudioLines size={13} />}{busy === 'start' ? 'Starting…' : 'Start meeting'}</button></> : meeting.status === 'recording' ? <><span>Tips + notes, together.</span><button className="meeting-primary" disabled={Boolean(busy)} onClick={() => void run('stop', async () => { await api('meeting.stop', { id: meeting.id }); await refresh(); })}>{busy === 'stop' ? <LoaderCircle size={12} className="spin" /> : <Square size={12} />}{busy === 'stop' ? 'Stopping…' : 'Stop meeting'}</button></> : meeting.status === 'finalizing' ? <><span>Recording has stopped.</span><button disabled><LoaderCircle size={12} className="spin" />Finishing…</button></> : editing ? <><span>Draft kept until saved.</span><button className="meeting-primary" disabled={Boolean(busy)} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save notes'}</button></> : <><button className="meeting-records" disabled={Boolean(busy)} onClick={() => open('meetings')}>Full record ↗</button>{!meeting.notes && <button disabled={Boolean(busy) || (meeting.status !== 'interrupted' && !meeting.segments.length)} onClick={() => process(meeting.status === 'interrupted')}>{busy === 'notes' ? 'Making…' : meeting.status === 'interrupted' ? 'Retry' : 'Make notes'}</button>}<button className="meeting-primary" disabled={Boolean(busy)} onClick={() => { setStartingNew(true); setTitle(''); setError(''); }}>New meeting</button></>}
    </footer><span className="cloud-tail" aria-hidden="true" />
  </main>;
}
