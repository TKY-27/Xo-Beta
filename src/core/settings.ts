/** Persistent user settings with safe fallbacks when storage is unavailable. */

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'cinematic';
export type CameraMode = 'fps' | 'tps';
export type TpsCharacterSide = 'left' | 'right';
export type SkinId = 'vanguard' | 'pathfinder' | 'specter' | 'striker' | 'warden' | 'nova';

export interface KeyBindings {
  forward: string; back: string; left: string; right: string;
  jump: string; sprint: string; crouch: string;
  fire: string; ads: string; reload: string; interact: string;
  slot1: string; slot2: string; slot3: string; slot4: string; slot5: string;
  cameraToggle: string; melee: string; dash: string; grapple: string; groundPound: string;
  dropWeapon: string; useMedkit: string; useShield: string;
  spectatePrev: string; spectateNext: string; mapToggle: string;
  /** Moves the third-person shoulder to the opposite side. */
  shoulderSwap: string;
}

export const DEFAULT_BINDINGS: KeyBindings = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  jump: 'Space', sprint: 'ShiftLeft', crouch: 'ControlLeft',
  fire: 'Mouse0', ads: 'Mouse2', reload: 'KeyR', interact: 'KeyE',
  slot1: 'Digit1', slot2: 'Digit2', slot3: 'Digit3', slot4: 'Digit4', slot5: 'Digit5',
  cameraToggle: 'KeyV', melee: 'KeyQ', dash: 'ShiftRight', grapple: 'KeyF', groundPound: 'KeyC',
  dropWeapon: 'KeyX', useMedkit: 'KeyG', useShield: 'KeyH',
  spectatePrev: 'ArrowLeft', spectateNext: 'ArrowRight', mapToggle: 'KeyM',
  shoulderSwap: 'KeyZ',
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
  shadowQuality: 'low' | 'medium' | 'high' | 'cinematic';
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
  /** Third-person shoulder placement; left keeps the character near 35% X. */
  tpsCharacterSide: TpsCharacterSide;
  /** Selected player appearance. Applied to the next spawned rig in a match. */
  playerSkin: SkinId;
  crosshairColor: string;
  crosshairSize: number;
  crosshairDot: boolean;
  cameraShake: number;
  showFps: boolean;

  // Accessibility & localization
  lang: 'en' | 'ja';
  /** First-run onboarding (language + default view) completed. */
  onboarded: boolean;
  damageNumbers: boolean;
  colorVision: 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';
  reducedMotion: boolean;
  captions: boolean;

  // Gamepad
  gamepadEnabled: boolean;
  padLookSens: number;
  padDeadzone: number;
  vibration: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 1.0,
  adsSensitivity: 0.8,
  invertY: false,
  fov: 80,
  bindings: { ...DEFAULT_BINDINGS },

  quality: 'high',
  resolutionScale: 0.5,
  shadows: true,
  shadowQuality: 'medium',
  postProcessing: true,
  bloom: true,
  reflections: true,
  ao: true,
  aa: 'fxaa',
  motionBlur: false,
  dof: false,
  fpsLimit: 0,

  masterVolume: 0.8,
  musicVolume: 0.6,
  sfxVolume: 1.0,
  ambienceVolume: 0.7,
  uiVolume: 0.8,

  cameraMode: 'fps',
  tpsCharacterSide: 'left',
  playerSkin: 'vanguard',
  crosshairColor: '#eaf6ff',
  crosshairSize: 10,
  crosshairDot: true,
  cameraShake: 1.0,
  showFps: false,

  lang: 'en',
  onboarded: false,
  damageNumbers: true,
  colorVision: 'none',
  reducedMotion: false,
  captions: false,

  gamepadEnabled: true,
  padLookSens: 1.0,
  padDeadzone: 0.15,
  vibration: true,
};

const STORAGE_KEY = 'xo-beta-settings-v1';

function loadStored(): unknown {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

let current: Settings = mergeSettings(DEFAULT_SETTINGS, loadStored());
const changeListeners: Array<(s: Settings) => void> = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function choice<T extends string | number>(value: unknown, fallback: T, allowed: readonly T[]): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function safeBindings(base: KeyBindings, value: unknown): KeyBindings {
  if (!isRecord(value)) return { ...base };
  const bindings = { ...base };
  for (const key of Object.keys(DEFAULT_BINDINGS) as Array<keyof KeyBindings>) {
    const candidate = value[key];
    // KeyboardEvent.code values and the two mouse bindings are short ASCII
    // identifiers. Ignore control characters and unexpectedly large payloads.
    if (typeof candidate === 'string' && /^[\x21-\x7e]{1,64}$/.test(candidate)) {
      bindings[key] = candidate;
    }
  }
  return bindings;
}

/**
 * Merge data crossing the localStorage boundary without trusting its shape.
 * This also protects runtime updates issued from JavaScript or browser tools.
 */
function mergeSettings(base: Settings, patch: unknown): Settings {
  if (!isRecord(patch)) return { ...base, bindings: { ...base.bindings } };
  const crosshairColor = typeof patch.crosshairColor === 'string'
    && /^#[0-9a-f]{6}$/i.test(patch.crosshairColor)
    ? patch.crosshairColor
    : base.crosshairColor;

  return {
    sensitivity: bounded(patch.sensitivity, base.sensitivity, 0.2, 3),
    adsSensitivity: bounded(patch.adsSensitivity, base.adsSensitivity, 0.2, 2),
    invertY: bool(patch.invertY, base.invertY),
    fov: bounded(patch.fov, base.fov, 60, 110),
    bindings: safeBindings(base.bindings, patch.bindings),

    quality: choice(patch.quality, base.quality, ['low', 'medium', 'high', 'ultra', 'cinematic']),
    resolutionScale: bounded(patch.resolutionScale, base.resolutionScale, 0.5, 1.5),
    shadows: bool(patch.shadows, base.shadows),
    shadowQuality: choice(patch.shadowQuality, base.shadowQuality, ['low', 'medium', 'high', 'cinematic']),
    postProcessing: bool(patch.postProcessing, base.postProcessing),
    bloom: bool(patch.bloom, base.bloom),
    reflections: bool(patch.reflections, base.reflections),
    ao: bool(patch.ao, base.ao),
    aa: choice(patch.aa, base.aa, ['off', 'fxaa', 'smaa']),
    motionBlur: bool(patch.motionBlur, base.motionBlur),
    dof: bool(patch.dof, base.dof),
    fpsLimit: choice(patch.fpsLimit, base.fpsLimit, [0, 60, 120, 144]),

    masterVolume: bounded(patch.masterVolume, base.masterVolume, 0, 1),
    musicVolume: bounded(patch.musicVolume, base.musicVolume, 0, 1),
    sfxVolume: bounded(patch.sfxVolume, base.sfxVolume, 0, 1),
    ambienceVolume: bounded(patch.ambienceVolume, base.ambienceVolume, 0, 1),
    uiVolume: bounded(patch.uiVolume, base.uiVolume, 0, 1),

    cameraMode: choice(patch.cameraMode, base.cameraMode, ['fps', 'tps']),
    tpsCharacterSide: choice(patch.tpsCharacterSide, base.tpsCharacterSide, ['left', 'right']),
    playerSkin: choice(patch.playerSkin, base.playerSkin, ['vanguard', 'pathfinder', 'specter', 'striker', 'warden', 'nova']),
    crosshairColor,
    crosshairSize: bounded(patch.crosshairSize, base.crosshairSize, 4, 20),
    crosshairDot: bool(patch.crosshairDot, base.crosshairDot),
    cameraShake: bounded(patch.cameraShake, base.cameraShake, 0, 1.5),
    showFps: bool(patch.showFps, base.showFps),

    lang: choice(patch.lang, base.lang, ['en', 'ja']),
    onboarded: bool(patch.onboarded, base.onboarded),
    damageNumbers: bool(patch.damageNumbers, base.damageNumbers),
    colorVision: choice(patch.colorVision, base.colorVision, ['none', 'protanopia', 'deuteranopia', 'tritanopia']),
    reducedMotion: bool(patch.reducedMotion, base.reducedMotion),
    captions: bool(patch.captions, base.captions),

    gamepadEnabled: bool(patch.gamepadEnabled, base.gamepadEnabled),
    padLookSens: bounded(patch.padLookSens, base.padLookSens, 0.3, 3),
    padDeadzone: bounded(patch.padDeadzone, base.padDeadzone, 0.05, 0.45),
    vibration: bool(patch.vibration, base.vibration),
  };
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
  // Debounced: rapid writes (e.g. V toggling camera mode) must not hit
  // synchronous localStorage on every input event.
  if (persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch {
      /* storage unavailable — settings stay session-only */
    }
  }, 350);
}

let persistTimer: number | null = null;

/** Force-flush any pending debounced write (call on pagehide). */
export function flushSettingsPersist(): void {
  if (persistTimer === null) return;
  window.clearTimeout(persistTimer);
  persistTimer = null;
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable */
  }
}
