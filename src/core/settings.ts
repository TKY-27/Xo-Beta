/** Persistent user settings with safe fallbacks when storage is unavailable. */

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';
export type CameraMode = 'fps' | 'tps';

export interface KeyBindings {
  forward: string; back: string; left: string; right: string;
  jump: string; sprint: string; crouch: string;
  fire: string; ads: string; reload: string; interact: string;
  slot1: string; slot2: string; slot3: string; slot4: string; slot5: string;
  cameraToggle: string; dash: string; grapple: string; groundPound: string;
  dropWeapon: string; useMedkit: string; useShield: string;
  spectatePrev: string; spectateNext: string; mapToggle: string;
}

export const DEFAULT_BINDINGS: KeyBindings = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  jump: 'Space', sprint: 'ShiftLeft', crouch: 'ControlLeft',
  fire: 'Mouse0', ads: 'Mouse2', reload: 'KeyR', interact: 'KeyE',
  slot1: 'Digit1', slot2: 'Digit2', slot3: 'Digit3', slot4: 'Digit4', slot5: 'Digit5',
  cameraToggle: 'KeyV', dash: 'KeyQ', grapple: 'KeyF', groundPound: 'KeyC',
  dropWeapon: 'KeyX', useMedkit: 'KeyG', useShield: 'KeyH',
  spectatePrev: 'ArrowLeft', spectateNext: 'ArrowRight', mapToggle: 'KeyM',
};

export interface Settings {
  // Controls
  sensitivity: number;
  adsSensitivity: number;
  invertY: boolean;
  fov: number;
  bindings: KeyBindings;

  // Graphics
  quality: QualityPreset;
  resolutionScale: number;
  shadows: boolean;
  shadowQuality: 'low' | 'medium' | 'high';
  postProcessing: boolean;
  bloom: boolean;
  reflections: boolean;
  ao: boolean;
  aa: 'off' | 'fxaa' | 'smaa';
  motionBlur: boolean;
  dof: boolean;
  fpsLimit: 0 | 60 | 120 | 144; // 0 = uncapped/vsync

  // Audio
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  ambienceVolume: number;
  uiVolume: number;

  // Gameplay
  cameraMode: CameraMode;
  crosshairColor: string;
  crosshairSize: number;
  crosshairDot: boolean;
  cameraShake: number;
  showFps: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 1.0,
  adsSensitivity: 0.8,
  invertY: false,
  fov: 80,
  bindings: { ...DEFAULT_BINDINGS },

  quality: 'ultra',
  resolutionScale: 1,
  shadows: true,
  shadowQuality: 'high',
  postProcessing: true,
  bloom: true,
  reflections: true,
  ao: true,
  aa: 'smaa',
  motionBlur: false,
  dof: false,
  fpsLimit: 0,

  masterVolume: 0.8,
  musicVolume: 0.6,
  sfxVolume: 1.0,
  ambienceVolume: 0.7,
  uiVolume: 0.8,

  cameraMode: 'fps',
  crosshairColor: '#eaf6ff',
  crosshairSize: 10,
  crosshairDot: true,
  cameraShake: 1.0,
  showFps: false,
};

const STORAGE_KEY = 'xo-beta-settings-v1';

function loadStored(): Partial<Settings> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<Settings>;
  } catch {
    return {};
  }
}

let current: Settings = mergeSettings(DEFAULT_SETTINGS, loadStored());
const changeListeners: Array<(s: Settings) => void> = [];

function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  const out: Settings = { ...base, ...patch, bindings: { ...base.bindings, ...(patch.bindings ?? {}) } };
  return out;
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = mergeSettings(current, patch);
  persist();
  for (const fn of changeListeners) fn(current);
}

export function resetBindings(): void {
  updateSettings({ bindings: { ...DEFAULT_BINDINGS } });
}

export function onSettingsChanged(fn: (s: Settings) => void): () => void {
  changeListeners.push(fn);
  return () => {
    const i = changeListeners.indexOf(fn);
    if (i >= 0) changeListeners.splice(i, 1);
  };
}

function persist(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable — settings stay session-only */
  }
}
