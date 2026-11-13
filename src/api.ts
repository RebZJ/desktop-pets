import { invoke } from '@tauri-apps/api/core';

export interface Settings {
  onboardingCompleted: boolean;
  theme: 'camp' | 'night' | 'handheld';
  interfaceFont: 'pixel' | 'inter' | 'fira';
  captureProtectionEnabled: boolean;
  language: string;
  voice: string;
  voiceEngine: 'auto' | 'kitten' | 'qwen';
  pitch: number;
  speechEnabled: boolean;
  soundEnabled: boolean;
  petSize: number;
  rate: number;
  volume: number;
  memoryEnabled: boolean;
  allowedApps: string[];
  allowedDomains: string[];
  retentionDays: number;
  meetingTips: boolean;
  clickThrough: boolean;
  hideShortcut: string;
  commandShortcut: string;
  dictationShortcut: string;
  completionShortcut: string;
  dictationLanguage: string;
  dictationVocabulary: string;
  writingExamples: string;
  activePack: string;
  [key: string]: unknown;
}

export interface LocalModel {
  id: string;
  name: string;
  role: string;
  sizeBytes: number;
  installed: boolean;
  status: string;
  progress?: number;
  error?: string;
}

export interface Segment { id?: string; speaker: string; start: number; end: number; text: string }
export interface Meeting {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  segments: Segment[];
  notes?: string;
  error?: string;
  actionItems?: Array<string | { text: string; done?: boolean }>;
}
export interface MemoryItem { id: string; text: string; application?: string; app?: string; title?: string; createdAt?: string }
export interface Extension { id: string; name: string; command?: string; args?: string[]; enabled?: boolean; enabledTools?: string[]; status?: string; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }
export interface PetPack { id: string; name: string; author?: string; attribution?: string; license?: string; path?: string; directory?: string; sounds?: Record<string, string>; actions?: Array<{ id: string; src: string; frameWidth: number; frameHeight: number; frameCount: number; fps: number }> }
export interface AppState {
  settings: Settings;
  models: LocalModel[];
  meetings: Meeting[];
  extensions: Extension[];
  packs: PetPack[];
  memory: { enabled: boolean; applications: string[] };
  pet: { visible: boolean; action: string };
}

export const defaultSettings: Settings = { onboardingCompleted: false, theme: 'camp', interfaceFont: 'pixel', captureProtectionEnabled: true, language: 'auto', voice: 'Kiki', voiceEngine: 'auto', pitch: 1.05, rate: 1, volume: .65, speechEnabled: false, soundEnabled: true, petSize: 160, memoryEnabled: false, allowedApps: [], allowedDomains: [], retentionDays: 30, meetingTips: true, clickThrough: false, hideShortcut: 'Alt+Shift+Space', commandShortcut: 'Alt+Space', dictationShortcut: 'Alt+Shift+D', completionShortcut: 'Alt+Shift+Enter', dictationLanguage: 'en', dictationVocabulary: '', writingExamples: '', activePack: 'pace' };
export const initialState: AppState = {
  settings: defaultSettings,
  models: [
    { id: 'moonshine-tiny-en', name: 'Moonshine Tiny · English', role: 'Fast dictation', sizeBytes: 45_400_000, installed: false, status: 'not-installed' },
    { id: 'moonshine-tiny-zh', name: 'Moonshine Tiny · Chinese', role: 'Chinese dictation', sizeBytes: 32_300_000, installed: false, status: 'not-installed' },
    { id: 'moonshine-tiny-ja', name: 'Moonshine Tiny · Japanese', role: 'Japanese dictation', sizeBytes: 32_300_000, installed: false, status: 'not-installed' },
    { id: 'moonshine-tiny-es', name: 'Moonshine Tiny · Spanish', role: 'Spanish dictation', sizeBytes: 32_300_000, installed: false, status: 'not-installed' },
    { id: 'qwen3.5-4b', name: 'Qwen 3.5 · 4B', role: 'Meeting notes & questions', sizeBytes: 3_060_000_000, installed: false, status: 'not-installed' },
    { id: 'kitten-tts-micro-0.8-onnx', name: 'Kitten Micro · portable voice', role: 'voice', sizeBytes: 44_663_872, installed: false, status: 'not-installed' },
    { id: 'qwen3-tts-0.6b', name: 'Qwen 3 TTS · 0.6B', role: 'Pace’s voice', sizeBytes: 1_970_000_000, installed: false, status: 'not-installed' },
    { id: 'whisper-turbo', name: 'Whisper large v3 turbo', role: 'Transcription', sizeBytes: 574_000_000, installed: false, status: 'not-installed' },
    { id: 'nemotron-diarization', name: 'Nemotron 3 Diarization', role: 'Speaker labels', sizeBytes: 107_012_128, installed: false, status: 'not-installed' },
  ],
  meetings: [], extensions: [], packs: [{ id: 'pace', name: 'Pace', author: 'Desktop Pets' }],
  memory: { enabled: false, applications: [] }, pet: { visible: true, action: 'idle' },
};

type Bridge = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
declare global { interface Window { __TAURI_INTERNALS__?: unknown; __DESKTOP_PETS_BRIDGE__?: Bridge | { dispatch: Bridge } } }
export const isNative = () => Boolean(window.__TAURI_INTERNALS__);
const STORAGE = 'desktop-pets.browser-state.v1';

function readBrowserState(): AppState {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) || 'null') as Partial<AppState> | null;
    return { ...initialState, ...saved, settings: normalizeSettings(saved?.settings), models: initialState.models };
  } catch { return initialState; }
}

function browserDispatch(method: string, params: Record<string, unknown>): unknown {
  const state = readBrowserState();
  const save = () => localStorage.setItem(STORAGE, JSON.stringify(state));
  if (method === 'app.state') return state;
  if (method === 'chat.history') return [];
  if (method === 'apps.list') return [];
  if (method === 'models.status') return state.models;
  if (method === 'settings.update') {
    const patch = params.patch as Partial<Settings>;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Settings must be an object');
    if ('theme' in patch && (typeof patch.theme !== 'string' || !['camp', 'night', 'handheld'].includes(patch.theme))) throw new Error('Unsupported theme');
    if ('interfaceFont' in patch && (typeof patch.interfaceFont !== 'string' || !['pixel', 'inter', 'fira'].includes(patch.interfaceFont))) throw new Error('Unsupported interface font');
    if ('captureProtectionEnabled' in patch && typeof patch.captureProtectionEnabled !== 'boolean') throw new Error('Invalid value for captureProtectionEnabled');
    state.settings = { ...state.settings, ...patch }; save(); return state.settings;
  }
  if (method === 'pet.action') { state.pet.action = String(params.action || 'idle'); save(); return state.pet; }
  if (method === 'pet.toggle') { state.pet.visible = typeof params.visible === 'boolean' ? params.visible : !state.pet.visible; save(); return state.pet; }
  if (method === 'memory.settings') { state.memory = { ...state.memory, ...params }; save(); return state.memory; }
  if (method === 'memory.search') return [];
  if (method === 'memory.delete') return { deleted: 0 };
  if (method === 'extensions.list') return state.extensions;
  if (method === 'packs.list') return state.packs;
  if (method === 'meeting.status') return state.meetings;
  throw new Error('This action needs the desktop app. Open Desktop Pets to use local models and native desktop access.');
}

export async function api<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  let value: unknown;
  const bridge = window.__DESKTOP_PETS_BRIDGE__;
  if (bridge) value = await (typeof bridge === 'function' ? bridge(method, params) : bridge.dispatch(method, params));
  else if (isNative()) {
    value = await invoke('dispatch', { method, params });
  } else value = browserDispatch(method, params);
  if (value && typeof value === 'object' && 'ok' in value) {
    const result = value as { ok: boolean; data?: unknown; error?: string | { message?: string } };
    if (!result.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || 'The action could not be completed.');
    return result.data as T;
  }
  return value as T;
}

export async function subscribe(handler: (event: string, data: unknown) => void): Promise<() => void> {
  if (!isNative()) {
    const changed = (event: StorageEvent) => { if (event.key === STORAGE) handler('settings.updated', readBrowserState().settings); };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }
  const { listen } = await import('@tauri-apps/api/event');
  return listen<{ event: string; data: unknown }>('pace-event', ({ payload }) => handler(payload.event, payload.data));
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong. Try again.';
export const bytes = (size: number) => size >= 1e9 ? `${(size / 1e9).toFixed(1)} GB` : `${Math.round(size / 1e6)} MB`;
export const clockTime = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

export function normalizeSettings(value?: Partial<Settings>): Settings {
  const settings = { ...defaultSettings, ...value };
  if (!['camp', 'night', 'handheld'].includes(settings.theme)) settings.theme = defaultSettings.theme;
  if (!['pixel', 'inter', 'fira'].includes(settings.interfaceFont)) settings.interfaceFont = defaultSettings.interfaceFont;
  if (typeof settings.captureProtectionEnabled !== 'boolean') settings.captureProtectionEnabled = true;
  return settings;
}

export function normalizeState(value: Partial<AppState>): AppState {
  return { ...initialState, ...value, settings: normalizeSettings(value.settings), memory: { ...initialState.memory, ...value.memory }, pet: { ...initialState.pet, ...value.pet }, models: Array.isArray(value.models) ? value.models : initialState.models, meetings: Array.isArray(value.meetings) ? value.meetings : [], extensions: Array.isArray(value.extensions) ? value.extensions : [], packs: Array.isArray(value.packs) ? value.packs : initialState.packs };
}


export async function copyText(text: string): Promise<void> {
  if (isNative()) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
  } else await navigator.clipboard.writeText(text);
}
