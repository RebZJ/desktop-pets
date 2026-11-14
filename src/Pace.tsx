import { useEffect, useState, type CSSProperties } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { isNative, type PetPack } from './api';

export const actions = {
  idle: { label: 'Idle', frames: 24, fps: 12, frameSize: 256 },
  wave: { label: 'Wave', frames: 8, fps: 12, frameSize: 256 },
  think: { label: 'Think', frames: 24, fps: 12, frameSize: 256 },
  type: { label: 'Type', frames: 24, fps: 16, frameSize: 256 },
  create: { label: 'Create', frames: 24, fps: 12, frameSize: 256 },
  review: { label: 'Review', frames: 24, fps: 12, frameSize: 256 },
  schedule: { label: 'Schedule', frames: 24, fps: 12, frameSize: 256 },
  sprint: { label: 'Sprint', frames: 8, fps: 12, frameSize: 256 },
  celebrate: { label: 'Celebrate', frames: 8, fps: 12, frameSize: 256 },
  sleep: { label: 'Sleep', frames: 8, fps: 5, frameSize: 512 },
  happy: { label: 'Petted', frames: 24, fps: 16, frameSize: 256 },
  annoyed: { label: 'Annoyed', frames: 24, fps: 16, frameSize: 256 },
  talk: { label: 'Talking', frames: 8, fps: 8, frameSize: 256 },
  listen: { label: 'Listening', frames: 8, fps: 8, frameSize: 256 },
  dictate: { label: 'Big ear', frames: 8, fps: 8, frameSize: 256 },
  hush: { label: 'Quiet company', frames: 8, fps: 8, frameSize: 256 },
  summon: { label: 'Popping out', frames: 8, fps: 8, frameSize: 256 },
  burrow: { label: 'Going home', frames: 8, fps: 8, frameSize: 256 },
} as const;
export type PaceAction = keyof typeof actions;
export const validAction = (action: string): PaceAction => action in actions ? action as PaceAction : 'idle';

const builtinSounds: Record<PaceAction, string> = {
  idle: 'attention', wave: 'attention', think: 'curious-trill', type: 'curious-trill',
  create: 'curious-trill', review: 'attention', schedule: 'attention', sprint: 'happy-chirp',
  celebrate: 'celebration', sleep: 'sleepy-purr', happy: 'happy-chirp', annoyed: 'surprised-squeak',
  talk: 'attention', listen: 'attention', dictate: 'attention', hush: 'attention', summon: 'attention', burrow: 'sleepy-purr',
};
let petAudio: HTMLAudioElement | undefined;
let voiceConversationActive = false;
export function setVoiceConversationActive(active: boolean) { voiceConversationActive = active; if (active) stopPetSound(); }
export function stopPetSound() { petAudio?.pause(); petAudio = undefined; }

export function playPetSound(action: PaceAction, volume: number, pack?: PetPack) {
  if (voiceConversationActive) return;
  stopPetSound();
  if (volume <= 0) return;
  const fallback = `/pets/pace/sounds/${builtinSounds[action]}.wav`;
  const custom = pack?.id !== 'pace' ? pack?.sounds?.[action] : undefined;
  const source = custom ? isNative() && pack?.directory ? convertFileSrc(`${pack.directory}/${custom}`) : custom : fallback;
  const play = (src: string, recover: boolean) => {
    const clip = new Audio(src); petAudio = clip;
    clip.volume = Math.min(1, Math.max(0, volume));
    clip.addEventListener('ended', () => { if (petAudio === clip) petAudio = undefined; }, { once: true });
    clip.addEventListener('error', () => { if (petAudio !== clip) return; petAudio = undefined; if (recover) play(fallback, false); }, { once: true });
    void clip.play().catch(() => {});
  };
  play(source, Boolean(custom));
}

export function Pace({ action = 'idle', size = 160, paused = false, flip = false, label, className = '', pack }: { action?: PaceAction; size?: number; paused?: boolean; flip?: boolean; label?: string; className?: string; pack?: PetPack }) {
  const custom = pack?.id !== 'pace' ? pack?.actions?.find(item => item.id === action) || pack?.actions?.find(item => item.id === 'idle') : undefined;
  const config = custom ? { frames: custom.frameCount, fps: custom.fps } : actions[action];
  const source = custom ? isNative() && pack?.directory ? convertFileSrc(`${pack.directory}/${custom.src}`) : custom.src : `/pets/pace/${action}${['summon', 'burrow'].includes(action) ? '-v1' : ['talk', 'listen', 'dictate', 'hush'].includes(action) ? '-v2' : ''}.webp`;
  const once = action === 'summon' || action === 'burrow';
  return <span key={source} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={`pace-sprite ${className}`} style={{
    '--pace-bound': `${size}px`, '--pace-size': 'calc(var(--pace-bound) / max(1, var(--pace-ratio)))', '--pace-frames': config.frames, '--pace-duration': `${config.frames / config.fps}s`,
    '--pace-last-frame': config.frames - 1, '--pace-steps': once ? Math.max(1, config.frames - 1) : config.frames,
    '--pace-ratio': custom ? custom.frameWidth / custom.frameHeight : 1,
    '--pace-frame-width': 'calc(var(--pace-size) * var(--pace-ratio))', width: 'var(--pace-frame-width)', height: 'var(--pace-size)',
    backgroundImage: `url('${source}')`, backgroundSize: 'calc(var(--pace-frames) * var(--pace-frame-width)) var(--pace-size)',
    animationName: once ? 'pace-once-frames' : undefined, animationIterationCount: once ? 1 : undefined, animationTimingFunction: once ? `steps(${Math.max(1, config.frames - 1)})` : undefined, animationFillMode: once ? 'forwards' : undefined,
    animationPlayState: paused ? 'paused' : 'running', transform: flip ? 'scaleX(-1)' : undefined,
  } as CSSProperties} />;
}

export function usePetMood(initial: PaceAction = 'idle', stayAwake = false) {
  const [action, setAction] = useState<PaceAction>(initial);
  const [clicks, setClicks] = useState<number[]>([]);
  const [activity, setActivity] = useState(Date.now());
  useEffect(() => {
    if (action === 'idle' && stayAwake) return;
    const duration = action === 'summon' ? 1000 : action === 'happy' || action === 'annoyed' ? 3000 : action === 'wave' || action === 'celebrate' ? 2200 : 20_000;
    if (!['idle', 'happy', 'annoyed', 'wave', 'celebrate', 'summon'].includes(action)) return;
    const timer = setTimeout(() => setAction(action === 'idle' ? 'sleep' : 'idle'), duration);
    return () => clearTimeout(timer);
  }, [action, activity, stayAwake]);
  const wake = () => {
    setActivity(Date.now());
    setAction(current => current === 'sleep' ? 'wave' : current);
  };
  const pet = (reaction?: 'happy' | 'annoyed') => {
    const now = Date.now();
    const recent = [...clicks.filter(time => now - time < 1200), now];
    if (!reaction) setClicks(recent);
    setActivity(now);
    const next: PaceAction = reaction || (recent.length >= 4 ? 'annoyed' : 'happy');
    setAction(next);
    return next;
  };
  return { action, setAction, pet, wake };
}
