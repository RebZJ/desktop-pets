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
} as const;
export type PaceAction = keyof typeof actions;
export const validAction = (action: string): PaceAction => action in actions ? action as PaceAction : 'idle';

const builtinSounds: Record<PaceAction, string> = {
  idle: 'attention', wave: 'attention', think: 'curious-trill', type: 'curious-trill',
  create: 'curious-trill', review: 'attention', schedule: 'attention', sprint: 'happy-chirp',
  celebrate: 'celebration', sleep: 'sleepy-purr', happy: 'happy-chirp', annoyed: 'surprised-squeak',
  talk: 'attention', listen: 'attention', dictate: 'attention',
};
let petAudio: HTMLAudioElement | undefined;
export function stopPetSound() { petAudio?.pause(); petAudio = undefined; }

export function playPetSound(action: PaceAction, volume: number, pack?: PetPack) {
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
  const source = custom ? isNative() && pack?.directory ? convertFileSrc(`${pack.directory}/${custom.src}`) : custom.src : `/pets/pace/${action}.webp`;
  return <span role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={`pace-sprite ${className}`} style={{
    '--pace-bound': `${size}px`, '--pace-size': 'calc(var(--pace-bound) / max(1, var(--pace-ratio)))', '--pace-frames': config.frames, '--pace-duration': `${config.frames / config.fps}s`,
    '--pace-ratio': custom ? custom.frameWidth / custom.frameHeight : 1,
    '--pace-frame-width': 'calc(var(--pace-size) * var(--pace-ratio))', width: 'var(--pace-frame-width)', height: 'var(--pace-size)',
    backgroundImage: `url('${source}')`, backgroundSize: 'calc(var(--pace-frames) * var(--pace-frame-width)) var(--pace-size)',
    animationPlayState: paused ? 'paused' : 'running', transform: flip ? 'scaleX(-1)' : undefined,
  } as CSSProperties} />;
}

export function usePetMood(initial: PaceAction = 'idle') {
  const [action, setAction] = useState<PaceAction>(initial);
  const [clicks, setClicks] = useState<number[]>([]);
  const [activity, setActivity] = useState(Date.now());
  useEffect(() => {
    const duration = action === 'happy' || action === 'annoyed' ? 3000 : action === 'wave' || action === 'celebrate' ? 2200 : 20_000;
    if (!['idle', 'happy', 'annoyed', 'wave', 'celebrate'].includes(action)) return;
    const timer = setTimeout(() => setAction(action === 'idle' ? 'sleep' : 'idle'), duration);
    return () => clearTimeout(timer);
  }, [action, activity]);
  const pet = () => {
    const now = Date.now();
    const recent = [...clicks.filter(time => now - time < 1200), now];
    setClicks(recent);
    setActivity(now);
    const next: PaceAction = recent.length >= 4 ? 'annoyed' : 'happy';
    setAction(next);
    return next;
  };
  return { action, setAction, pet };
}
