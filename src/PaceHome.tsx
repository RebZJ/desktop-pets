import { AudioLines, Eye, EyeOff, MessageCircle, Mic } from 'lucide-react';
import type { AppState } from './api';
import { Pace, validAction } from './Pace';
import './pace-home.css';

type Props = { state: AppState; busy: boolean; onAction: (method: string, params?: Record<string, unknown>) => Promise<void> };
export function PaceHome({ state, busy, onAction }: Props) {
  const action = validAction(state.pet.action);
  const present = state.pet.visible || action === 'burrow';
  return <section className="pace-home" aria-label="Pace’s campsite">
    <div className="home-dialogue"><h1>Pace’s place</h1><p>A little clearing in your day.</p></div>
    <button className={`home-resident ${present ? '' : 'resident-away'}`} aria-label="Pet Pace in his campsite" disabled={busy || !state.pet.visible} onClick={() => void onAction('pet.action', { action: 'happy' })}><Pace action={action} size={224} pack={state.packs.find(pack => pack.id === state.settings.activePack)} label={`Pace is ${action}`} /></button>
    <div className="home-tools" aria-label="Campsite tools"><button className="home-chat" aria-label="Chat with Pace" aria-describedby="home-chat-detail" disabled={busy} onClick={() => void onAction('window.chat')}><MessageCircle size={18} /><span>Chat with Pace<small id="home-chat-detail">Talk, or just type.</small></span></button><button disabled={busy} onClick={() => void onAction('window.talk')}><Mic size={16} /><span>Dictate</span></button><button disabled={busy} onClick={() => void onAction('window.main', { page: 'meetings' })}><AudioLines size={16} /><span>Meeting notes</span></button></div>
    <button className="home-summon" disabled={busy} onClick={() => void onAction('pet.toggle', { visible: !state.pet.visible })}>{state.pet.visible ? <EyeOff size={14} /> : <Eye size={14} />}{state.pet.visible ? 'Send Pace home' : 'Summon Pace'}</button>
  </section>;
}
