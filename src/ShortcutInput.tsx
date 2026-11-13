import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { api, errorText, isNative, type Settings } from './api';

const shortcutFields = ['hideShortcut', 'commandShortcut', 'dictationShortcut', 'completionShortcut'] as const;
type ShortcutField = typeof shortcutFields[number];
const reserved = new Set(['Super+Q', 'Super+W', 'Super+H', 'Super+M', 'Super+Tab', 'Super+Space', 'Shift+Super+Tab', 'Alt+Super+Escape', 'Alt+Tab', 'Alt+Shift+Tab', 'Alt+F4', 'Control+Alt+Delete']);
let recordingRequest: Promise<unknown> = Promise.resolve();
function setNativeRecording(active: boolean) {
  recordingRequest = recordingRequest.catch(() => {}).then(() => api('shortcut.recording', { active }));
  return recordingRequest;
}

function normalized(value: string) {
  return value.toLowerCase().split('+').map(part => ({ ctrl: 'control', command: 'super', cmd: 'super', meta: 'super', option: 'alt' }[part] || part).replace(/^key(?=[a-z]$)|^digit(?=\d$)/, '')).sort().join('+');
}

export function ShortcutInput({ label, field, settings, disabled = false, onSave }: {
  label: string; field: ShortcutField; settings: Settings; disabled?: boolean; onSave: (value: string) => Promise<boolean>;
}) {
  const value = settings[field];
  const [draft, setDraft] = useState(value);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const capture = useRef<Promise<unknown>>(Promise.resolve());
  const hint = useId();
  useEffect(() => setDraft(value), [value]);
  const stop = () => {
    if (!active.current) return capture.current;
    active.current = false; setRecording(false);
    if (isNative()) capture.current = setNativeRecording(false);
    return capture.current;
  };
  useEffect(() => {
    const blur = () => { input.current?.blur(); };
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('blur', blur); if (active.current && isNative()) void setNativeRecording(false).catch(() => {}); active.current = false; };
  }, []);
  useEffect(() => { if (!recording) return; const timer = setTimeout(() => input.current?.blur(), 45_000); return () => clearTimeout(timer); }, [recording]);
  const start = async () => {
    if (active.current || saving) return;
    active.current = true; setError('');
    const request = isNative() ? setNativeRecording(true) : Promise.resolve();
    capture.current = request;
    try {
      await request;
      if (active.current && capture.current === request) setRecording(true);
    } catch (cause) { if (capture.current === request) { active.current = false; setError(errorText(cause)); } }
  };
  const record = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { setDraft(value); setError(''); input.current?.blur(); return; }
    if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey && draft !== value) { event.currentTarget.form?.requestSubmit(); return; }
    if (!recording || event.repeat || event.nativeEvent.isComposing || ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(event.key)) return;
    if (!event.ctrlKey && !event.altKey && !event.metaKey && !(event.shiftKey && /^F([1-9]|1[0-9]|2[0-4])$/.test(event.code))) { setError('Include Control, Option/Alt, or Command/Super; Shift can pair with a function key.'); return; }
    const code = event.code;
    if (!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|Backquote|Backslash|BracketLeft|BracketRight|Comma|Equal|Minus|Period|Quote|Semicolon|Slash|CapsLock|NumLock|PrintScreen|ScrollLock|Pause|Numpad([0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter|Equal))$/.test(code)) { setError('That key is not supported. Choose another key combination.'); return; }
    const key = code.replace(/^Key|^Digit/, '');
    const next = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', key].filter(Boolean).join('+');
    if (reserved.has(next)) { setError('That combination is reserved by the system. Choose another shortcut.'); return; }
    if (shortcutFields.some(other => other !== field && normalized(settings[other]) === normalized(next))) { setError('That shortcut conflicts with another Pace shortcut. Choose a unique key combination.'); return; }
    setError(''); setDraft(next);
  };
  return <div className="shortcut-selector"><form className={`shortcut-input${recording ? ' is-recording' : ''}`} onSubmit={event => {
    event.preventDefault(); if (draft === value || saving || error) return;
    setSaving(true);
    void (async () => { try { await stop(); if (!await onSave(draft)) setDraft(value); input.current?.blur(); } catch (cause) { setError(errorText(cause)); } finally { setSaving(false); } })();
  }}>
    <input ref={input} aria-label={label} aria-describedby={hint} readOnly value={draft} disabled={disabled} onFocus={() => void start()} onClick={() => void start()} onBlur={() => { if (!saving) { setDraft(value); setError(''); } void stop().catch(cause => setError(errorText(cause))); }} onKeyDown={record} spellCheck={false} />
    <button className="button quiet" type="submit" title={`Save ${label.toLowerCase()}`} onMouseDown={event => event.preventDefault()} disabled={disabled || saving || draft === value || Boolean(error)}>{saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}</button>
  </form><span id={hint} className={`shortcut-hint${error ? ' shortcut-error' : ''}`} role={error ? 'alert' : undefined}>{error || (recording ? 'Press keys · Save or Enter · Esc cancels' : draft !== value ? 'Not saved · Save to apply' : 'Click, then press your key combination')}</span></div>;
}
