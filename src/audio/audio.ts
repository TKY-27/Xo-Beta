/**
 * Audio engine v2: recorded sample playback (CC0 — see
 * docs/ASSET_MANIFEST.md) with WebAudio spatialization, distance filtering,
 * map-specific ambience beds and underwater processing. Continuous match
 * music is intentionally absent — the soundscape carries immersion.
 */

import type { EventBus } from '../core/events';
import type { MatchEventsMap } from '../sim/match';
import { createLocalActorIdentity, isLocalActor } from '../core/ownership';
import { getSettings } from '../core/settings';
import { fetchAudio } from '../assets/assets';

type BusName = 'sfx' | 'ui' | 'ambience' | 'music';

interface PlayOpts {
  x?: number;
  y?: number;
  z?: number;
  vol?: number;
  rate?: number;
  bus?: BusName;
  /** Lowpass cutoff for occlusion / distance muffling. */
  lp?: number;
  refDist?: number;
  rolloff?: number;
  /** Intentional layer offset in seconds. */
  delay?: number;
  /** Acoustic occlusion 0..1 (clear..blocked). Computed by the engine when
   * an occlusion provider is installed; explicit values win. */
  occlusion?: number;
}

const SAMPLES: Array<[string, string]> = [
  ['gun/pistol_a', 'guns/pistol_a.wav'],
  ['gun/pistol_b', 'guns/pistol_b.wav'],
  ['gun/pistol_c', 'guns/pistol_c.wav'],
  ['gun/smg_a', 'guns/smg_a.wav'],
  ['gun/smg_b', 'guns/smg_b.wav'],
  ['gun/ar_a', 'guns/ar_a.wav'],
  ['gun/ar_b', 'guns/ar_b.wav'],
  ['gun/shotgun_a', 'guns/shotgun_a.wav'],
  ['gun/sniper_a', 'guns/sniper_a.wav'],
  ['step/concrete_a', 'steps/footstep_concrete_000.wav'],
  ['step/concrete_b', 'steps/footstep_concrete_001.wav'],
  ['step/concrete_c', 'steps/footstep_concrete_003.wav'],
  ['step/grass_a', 'steps/footstep_grass_000.wav'],
  ['step/grass_b', 'steps/footstep_grass_002.wav'],
  ['step/wood_a', 'steps/footstep_wood_000.wav'],
  ['step/wood_b', 'steps/footstep_wood_002.wav'],
  ['step/carpet_a', 'steps/footstep_carpet_000.wav'],
  ['impact/glass_a', 'impacts/impactGlass_light_000.wav'],
  ['impact/glass_b', 'impacts/impactGlass_medium_001.wav'],
  ['impact/metal_a', 'impacts/impactMetal_light_000.wav'],
  ['impact/metal_b', 'impacts/impactMetal_heavy_001.wav'],
  ['impact/wood_a', 'impacts/impactWood_medium_000.wav'],
  ['impact/wood_b', 'impacts/impactWood_heavy_001.wav'],
  ['impact/stone_a', 'impacts/impactMining_000.wav'],
  ['impact/stone_b', 'impacts/impactMining_001.wav'],
  ['impact/soft_a', 'impacts/impactSoft_medium_000.wav'],
  ['impact/plate_a', 'impacts/impactPlate_light_000.wav'],
  ['boom/a', 'explosions/explosionCrunch_000.wav'],
  ['boom/b', 'explosions/explosionCrunch_002.wav'],
  ['boom/sub', 'explosions/lowFrequency_explosion_001.wav'],
  ['water/splash_a', 'water/splash_05.wav'],
  ['water/splash_b', 'water/splash_11.wav'],
  ['mech/door_open', 'mech/doorOpen_001.wav'],
  ['mech/door_close', 'mech/doorClose_001.wav'],
  ['chest/open_a', 'chest/openchest.wav'],
  // Shield feedback is an impact, not a laser. The old laser aliases were
  // the source of the out-of-place electronic "shun-shun" sound in normal
  // firefights. Keep the logical keys so callers do not need to know the
  // physical sample used for the effect.
  ['shield/hit', 'impacts/impactPlate_light_000.wav'],
  ['shield/break', 'impacts/impactMetal_heavy_001.wav'],
  ['grapple/fire', 'lasers/thrusterFire.wav'],
  ['ui/click', 'ui/click1.wav'],
  ['ui/hover', 'ui/rollover2.wav'],
  ['ui/back', 'ui/back_002.wav'],
  ['ui/confirm', 'ui/confirmation_001.wav'],
  ['ui/error', 'ui/error_001.wav'],
  ['ui/drop', 'ui/drop_001.wav'],
  ['pickup/item', 'ui/open_001.wav'],
  ['ui/headshot', 'ui/switch2.wav'],
  ['ui/storm', 'ui/switch12.wav'],
  ['chest/bell', 'impacts/impactBell_heavy_000.wav'],
  ['bed/city_loop', 'ambience/city_loop.wav'],
  ['bed/wind_loop', 'ambience/wind_loop.wav'],
  ['bed/birds_loop', 'ambience/birds_loop.wav'],
  ['bed/river_loop', 'ambience/river_loop.wav'],
];

/**
 * Source-recording trims measured from the bundled CC0 WAVs. These assets
 * have deliberately conservative peaks, but a few recordings (notably the
 * chest reveal) have much lower programme level than their neighbours. Keep
 * the correction at the sample boundary instead of raising the master bus;
 * ambience, UI, and distance attenuation therefore retain their intended
 * balance. Values are dB and are applied as linear gain at playback.
 */
export const AUDIO_SAMPLE_TRIM_DB: Readonly<Record<string, number>> = Object.freeze({
  'gun/pistol_a': 4.5,
  'gun/pistol_b': 4.5,
  'gun/pistol_c': 4.5,
  'gun/smg_a': 4.5,
  'gun/smg_b': 4.5,
  'gun/ar_a': 4.5,
  'gun/ar_b': 4.5,
  'gun/shotgun_a': 4.5,
  'gun/sniper_a': 4.5,
  // openchest.wav peaks at roughly -20 dBFS, unlike the mechanical layer.
  'chest/open_a': 12,
});

export function sampleGainFor(key: string): number {
  return 10 ** ((AUDIO_SAMPLE_TRIM_DB[key] ?? 0) / 20);
}

export type GunshotDistanceBand = 'local' | 'remote-near' | 'remote-mid' | 'remote-far';

export interface GunshotPresentationProfile {
  band: GunshotDistanceBand;
  priority: number;
  reportGain: number;
  crackGain: number;
  bodyGain: number;
  tailGain: number;
  subGain: number;
  reportLp: number;
  crackLp: number;
  bodyLp: number;
  tailLp: number;
  subLp: number;
  reportRefDist: number;
  crackRefDist: number;
  bodyRefDist: number;
  tailRefDist: number;
  subRefDist: number;
  reportRolloff: number;
  crackRolloff: number;
  bodyRolloff: number;
  tailRolloff: number;
  subRolloff: number;
}

const GUNSHOT_PROFILES: Readonly<Record<GunshotDistanceBand, GunshotPresentationProfile>> = Object.freeze({
  local: {
    band: 'local', priority: 4,
    reportGain: 1.1, crackGain: 1.1, bodyGain: 1, tailGain: 1, subGain: 1,
    reportLp: 18000, crackLp: 12000, bodyLp: 6800, tailLp: 6200, subLp: 5200,
    reportRefDist: 7, crackRefDist: 8, bodyRefDist: 9, tailRefDist: 15, subRefDist: 12,
    reportRolloff: 1.05, crackRolloff: 1.05, bodyRolloff: 1, tailRolloff: 0.82, subRolloff: 0.9,
  },
  'remote-near': {
    band: 'remote-near', priority: 3,
    reportGain: 0.95, crackGain: 0.68, bodyGain: 0.9, tailGain: 0.9, subGain: 0.75,
    reportLp: 15000, crackLp: 9500, bodyLp: 6500, tailLp: 5600, subLp: 3500,
    reportRefDist: 6.5, crackRefDist: 7.5, bodyRefDist: 9, tailRefDist: 14, subRefDist: 12,
    reportRolloff: 1.1, crackRolloff: 1.15, bodyRolloff: 1.1, tailRolloff: 0.9, subRolloff: 0.95,
  },
  'remote-mid': {
    band: 'remote-mid', priority: 2,
    reportGain: 0.6, crackGain: 0.32, bodyGain: 0.45, tailGain: 0.65, subGain: 0.38,
    reportLp: 8000, crackLp: 6000, bodyLp: 4200, tailLp: 3200, subLp: 2000,
    reportRefDist: 6, crackRefDist: 7, bodyRefDist: 8, tailRefDist: 13, subRefDist: 11,
    reportRolloff: 1.2, crackRolloff: 1.25, bodyRolloff: 1.2, tailRolloff: 0.98, subRolloff: 1.05,
  },
  'remote-far': {
    band: 'remote-far', priority: 1,
    reportGain: 0.3, crackGain: 0.08, bodyGain: 0.2, tailGain: 0.48, subGain: 0.22,
    reportLp: 3600, crackLp: 2600, bodyLp: 2400, tailLp: 1700, subLp: 1300,
    reportRefDist: 5, crackRefDist: 6, bodyRefDist: 8, tailRefDist: 12, subRefDist: 10,
    reportRolloff: 1.35, crackRolloff: 1.4, bodyRolloff: 1.3, tailRolloff: 1, subRolloff: 1.1,
  },
});

export function gunshotDistanceBand(distance: number, isLocal: boolean): GunshotDistanceBand {
  if (isLocal) return 'local';
  const d = Number.isFinite(distance) ? Math.max(0, distance) : Number.POSITIVE_INFINITY;
  if (d <= 25) return 'remote-near';
  if (d <= 75) return 'remote-mid';
  return 'remote-far';
}

export function gunshotProfileFor(distance: number, isLocal: boolean): GunshotPresentationProfile {
  return GUNSHOT_PROFILES[gunshotDistanceBand(distance, isLocal)];
}

export const REMOTE_GUNSHOT_VOICE_LIMITS: Readonly<Record<Exclude<GunshotDistanceBand, 'local'>, number>> = Object.freeze({
  'remote-near': 4,
  'remote-mid': 3,
  'remote-far': 2,
});

const MAX_REMOTE_GUNSHOT_VOICES = 6;

/** Panning model switch distance: past this the HRTF cross-feed detail it
 * preserves is imperceptible, so far sources get the cheap equalpower model. */
const HRTF_MAX_DISTANCE = 45;

interface PooledPanner {
  readonly panner: PannerNode;
  /** Currently playing source routed through this panner, if any. */
  live: AudioBufferSourceNode | null;
}

/**
 * Fixed pool of spatial panners. HRTF PannerNode *construction* is expensive
 * (Chrome allocates a convolution per node), and combat used to build 70-100
 * of them per second — a main-thread stall every burst. Panners are now
 * allocated once and leased round-robin; only when every slot is busy does a
 * lease steal the oldest still-playing voice. Far sources lease from a
 * separate equalpower pool.
 */
class PannerPool {
  private readonly entries: PooledPanner[] = [];
  private cursor = 0;

  constructor(ctx: AudioContext, count: number, model: PanningModelType, destination: AudioNode) {
    for (let i = 0; i < count; i++) {
      const panner = ctx.createPanner();
      panner.panningModel = model;
      panner.distanceModel = 'exponential';
      panner.connect(destination);
      this.entries.push({ panner, live: null });
    }
  }

  lease(): PooledPanner {
    const n = this.entries.length;
    for (let i = 0; i < n; i++) {
      const entry = this.entries[(this.cursor + i) % n]!;
      if (!entry.live) {
        this.cursor = (this.cursor + i + 1) % n;
        return entry;
      }
    }
    // Every slot busy: steal the next slot in rotation (the oldest voice).
    const stolen = this.entries[this.cursor % n]!;
    stolen.live?.stop();
    stolen.live = null;
    this.cursor = (this.cursor + 1) % n;
    return stolen;
  }

  /** Track a source so its slot frees automatically when playback ends. */
  attach(entry: PooledPanner, source: AudioBufferSourceNode): void {
    entry.live = source;
    source.addEventListener('ended', () => {
      if (entry.live === source) entry.live = null;
    });
  }
}

/** Per-category sliding-window rate caps. Bursts fire more impact/ricochet/
 * footstep events per second than the mix can meaningfully present; the
 * extras were pure node churn. Local-player footsteps are never capped. */
const VOICE_CATEGORY_CAPS: Readonly<Record<string, { limit: number; windowSec: number }>> = Object.freeze({
  impact: { limit: 6, windowSec: 0.1 },
  ricochet: { limit: 2, windowSec: 0.12 },
  footstep: { limit: 5, windowSec: 0.15 },
});

export class AudioEngine {
  private static listenerInstance: AudioEngine | null = null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterFilter: BiquadFilterNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;
  private buses: Partial<Record<BusName, GainNode>> = {};
  /** Pre-muted base level per bus so ducking restores the authored level. */
  private busBaseLevels: Partial<Record<BusName, number>> = {};
  private buffers = new Map<string, AudioBuffer>();
  private noiseBuffer: AudioBuffer | null = null;
  private missingSampleWarnings = new Set<string>();

  // ambience beds
  private beds: Map<string, { src: AudioBufferSourceNode; gain: GainNode }> = new Map();
  private bedTargets: Map<string, number> = new Map();

  private musicState: 'none' | 'lobby' | 'victory' | 'defeat' = 'none';
  private musicNodes: OscillatorNode[] = [];
  private musicGain: GainNode | null = null;
  private musicTimer: number | null = null;
  private ambienceGeneration = 0;
  private matchEffectGeneration = 0;
  private matchEffectTimers = new Set<number>();
  private remoteGunshotVoices: Array<{ band: Exclude<GunshotDistanceBand, 'local'>; until: number }> = [];
  private hrtfPanners: PannerPool | null = null;
  private farPanners: PannerPool | null = null;
  private voiceStamps = new Map<string, number[]>();
  private occlusionProvider: ((x: number, y: number, z: number) => number) | null = null;

  /** Install a per-match acoustic occlusion sampler (see OcclusionSampler).
   * Positional sounds then query it for muffling; `null` disables. */
  setOcclusionProvider(provider: ((x: number, y: number, z: number) => number) | null): void {
    this.occlusionProvider = provider;
  }

  private occlusionAt(x: number | undefined, y: number | undefined, z: number | undefined): number {
    if (!this.occlusionProvider || x === undefined || z === undefined) return 0;
    return this.occlusionProvider(x, y ?? 1.2, z);
  }

  /** Sliding-window voice cap per category (see VOICE_CATEGORY_CAPS). */
  private allowVoice(category: string): boolean {
    const cap = VOICE_CATEGORY_CAPS[category];
    if (!cap || !this.ctx) return true;
    const now = this.now();
    let stamps = this.voiceStamps.get(category);
    if (!stamps) {
      stamps = [];
      this.voiceStamps.set(category, stamps);
    }
    while (stamps.length > 0 && stamps[0]! <= now - cap.windowSec) stamps.shift();
    if (stamps.length >= cap.limit) return false;
    stamps.push(now);
    return true;
  }

  private reserveRemoteGunshotVoice(profile: GunshotPresentationProfile): boolean {
    const band = profile.band;
    if (band === 'local') return true;
    const now = this.now();
    this.remoteGunshotVoices = this.remoteGunshotVoices.filter((voice) => voice.until > now);
    const activeTotal = this.remoteGunshotVoices.length;
    const activeInBand = this.remoteGunshotVoices.filter((voice) => voice.band === band).length;
    // Near shots have the highest remote priority; far shots are deliberately
    // capped first so nine bots cannot turn the spatial mix into a wall of
    // identical reports. Each accepted event owns all of its short layers.
    if (activeTotal >= MAX_REMOTE_GUNSHOT_VOICES) return false;
    // Preserve slots for close, high-priority shots when the mix is already busy.
    if (profile.priority <= 1 && activeTotal >= MAX_REMOTE_GUNSHOT_VOICES - 1) return false;
    if (activeInBand >= REMOTE_GUNSHOT_VOICE_LIMITS[band]) return false;
    this.remoteGunshotVoices.push({ band, until: now + 0.72 });
    return true;
  }

  private scheduleMatchEffect(fn: () => void, delayMs: number): void {
    const generation = this.matchEffectGeneration;
    const timer = window.setTimeout(() => {
      this.matchEffectTimers.delete(timer);
      if (generation === this.matchEffectGeneration) fn();
    }, delayMs);
    this.matchEffectTimers.add(timer);
  }

  cancelMatchEffects(): void {
    this.matchEffectGeneration++;
    for (const timer of this.matchEffectTimers) window.clearTimeout(timer);
    this.matchEffectTimers.clear();
    this.updateLowHealth(null);
  }

  init(): void {
    if (this.ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.masterFilter = ctx.createBiquadFilter();
    this.masterFilter.type = 'lowpass';
    this.masterFilter.frequency.value = 20000; // open air default
    // Keep layered firearm reports and close chest reveals below clipping
    // without flattening the individual distance/voice levels.
    this.masterLimiter = ctx.createDynamicsCompressor();
    this.masterLimiter.threshold.value = -3;
    this.masterLimiter.knee.value = 0;
    this.masterLimiter.ratio.value = 20;
    this.masterLimiter.attack.value = 0.001;
    this.masterLimiter.release.value = 0.08;
    for (const name of ['sfx', 'ui', 'ambience', 'music'] as BusName[]) {
      const g = ctx.createGain();
      g.connect(this.masterFilter);
      this.buses[name] = g;
    }
    this.masterFilter.connect(this.masterLimiter);
    this.masterLimiter.connect(this.master);
    this.master.connect(ctx.destination);

    // Pooled spatial voices: allocated once here instead of per one-shot
    // (see PannerPool). The split point is HRTF_MAX_DISTANCE.
    this.hrtfPanners = new PannerPool(ctx, 28, 'HRTF', this.buses.sfx!);
    this.farPanners = new PannerPool(ctx, 12, 'equalpower', this.buses.sfx!);

    const len = ctx.sampleRate * 1.0;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuffer.getChannelData(0);
    let s = 1234567;
    for (let i = 0; i < len; i++) {
      s = (s * 16807) % 2147483647;
      d[i]! = ((s & 0xffff) / 0x8000 - 1) * 0.5;
    }

    this.applyVolumes();
    AudioEngine.listenerInstance = this;
  }

  resume(): void {
    void this.ctx?.resume();
  }

  applyVolumes(): void {
    if (!this.ctx || !this.master) return;
    const s = getSettings();
    this.master.gain.value = s.masterVolume;
    this.buses.sfx!.gain.value = s.sfxVolume;
    this.buses.music!.gain.value = s.musicVolume * 0.5;
    this.buses.ambience!.gain.value = s.ambienceVolume;
    this.buses.ui!.gain.value = s.uiVolume;
    // Record authored levels so transient ducking restores exactly these.
    this.busBaseLevels.sfx = s.sfxVolume;
    this.busBaseLevels.music = s.musicVolume * 0.5;
    this.busBaseLevels.ambience = s.ambienceVolume;
    this.busBaseLevels.ui = s.uiVolume;
  }

  async loadSamples(onProgress?: (pct: number) => void): Promise<void> {
    this.init();
    let done = 0;
    await Promise.all(
      SAMPLES.map(async ([key, rel]) => {
        try {
          const raw = await fetchAudio(rel.trim());
          const buf = await this.ctx!.decodeAudioData(raw);
          this.buffers.set(key, buf);
        } catch (err) {
          console.warn('sample failed:', key, err);
        }
        done++;
        onProgress?.(done / SAMPLES.length);
      }),
    );
  }

  private now(): number {
    return this.ctx!.currentTime;
  }

  /** Spatial one-shot buffer playback through a pooled panner. */
  play(key: string, opts: PlayOpts = {}): void {
    const buf = this.buffers.get(key);
    if (!this.ctx) return;
    if (!buf) {
      if (!this.missingSampleWarnings.has(key)) {
        this.missingSampleWarnings.add(key);
        console.warn('audio sample unavailable:', key);
      }
      return;
    }
    if (this.ctx.state !== 'running') {
      // Playback initiated by a valid in-game input should recover a browser
      // context suspended by tab/background policy instead of failing silently.
      void this.ctx.resume().catch((err) => console.warn('audio resume failed', err));
    }
    const bus = this.buses[opts.bus ?? 'sfx']!;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;
    const occlusion = opts.occlusion ?? this.occlusionAt(opts.x, opts.y, opts.z);
    const g = this.ctx.createGain();
    // A blocked path loses energy before it loses spectrum — attenuate
    // slightly and cut the highs hard.
    g.gain.value = (opts.vol ?? 1) * sampleGainFor(key) * (1 - 0.55 * occlusion);
    src.connect(g);
    // Chain: source → gain → (lowpass) → (pooled panner | bus).
    let tail: AudioNode = g;
    if (opts.lp !== undefined || occlusion > 0) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      const cutoff = opts.lp !== undefined ? opts.lp : 19000;
      f.frequency.value = Math.max(220, cutoff * (1 - 0.85 * occlusion));
      tail.connect(f);
      tail = f;
    }
    const hasPos = opts.x !== undefined;
    if (hasPos) {
      const distance = Math.hypot(opts.x! - cameraCenter.x, opts.z! - cameraCenter.z);
      const pool = distance > HRTF_MAX_DISTANCE ? this.farPanners : this.hrtfPanners;
      if (!pool) return;
      const entry = pool.lease();
      const p = entry.panner;
      p.refDistance = opts.refDist ?? 5;
      p.rolloffFactor = opts.rolloff ?? 1.25;
      p.positionX.value = opts.x!;
      p.positionY.value = opts.y ?? 1.2;
      p.positionZ.value = opts.z!;
      tail.connect(p);
      pool.attach(entry, src);
    } else {
      tail.connect(bus);
    }
    src.start(this.now() + (opts.delay ?? 0) + Math.random() * 0.008);
  }

  /** Listener update (camera-relative panning). */
  static setListener(x: number, y: number, z: number, fx: number, fz: number): void {
    const inst = AudioEngine.listenerInstance;
    if (!inst || !inst.ctx?.listener) return;
    const l = inst.ctx.listener;
    if (l.positionX) {
      // Panner sources use absolute world coordinates, so the listener must
      // match the camera exactly. The old `y - 2` bias placed every sound
      // above the listener and distorted both elevation and attenuation.
      l.positionX.setTargetAtTime(x, inst.now(), 0.02);
      l.positionY.setTargetAtTime(y, inst.now(), 0.02);
      l.positionZ.setTargetAtTime(z, inst.now(), 0.02);
      l.forwardX.value = fx;
      l.forwardY.value = 0;
      l.forwardZ.value = fz;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    }
    cameraCenter.x = x;
    cameraCenter.z = z;
  }

  // -------------------------------------------------------------------------
  // Gameplay SFX
  // -------------------------------------------------------------------------

  /**
   * Briefly attenuate the ambience bus (e.g. around a local sniper report)
   * and recover smoothly. One reusable gain automation on the shared bus —
   * no per-shot node creation.
   */
  duckAmbience(durationSeconds: number, targetScale: number): void {
    const bus = this.buses['ambience'];
    const ctx = this.ctx;
    if (!bus || !ctx) return;
    const now = ctx.currentTime;
    const base = this.busBaseLevels['ambience'] ?? 1;
    bus.gain.cancelScheduledValues(now);
    bus.gain.setValueAtTime(bus.gain.value, now);
    bus.gain.linearRampToValueAtTime(base * targetScale, now + 0.02);
    bus.gain.exponentialRampToValueAtTime(Math.max(0.0001, base), now + 0.02 + durationSeconds);
  }

  gunshot(kind: string, x: number, y: number, z: number, dry = false, isLocal = false): void {
    if (!this.ctx) return;
    if (dry) {
      // A dry chamber click belongs to the gameplay SFX bus. Routing the UI
      // click here made an empty magazine sound like a menu interaction.
      this.play('impact/metal_a', { x, y, z, vol: 0.2, rate: 1.8, refDist: 2.5 });
      return;
    }
    const table: Record<string, string[]> = {
      pistol: ['gun/pistol_a', 'gun/pistol_b', 'gun/pistol_c'],
      smg: ['gun/smg_a', 'gun/smg_b'],
      ar: ['gun/ar_a', 'gun/ar_b'],
      shotgun: ['gun/shotgun_a'],
      sniper: ['gun/sniper_a'],
    };
    const keys = table[kind] ?? table.pistol!;
    const key = keys[Math.floor(Math.random() * keys.length)]!;
    const dist = Math.hypot(x - cameraCenter.x, z - cameraCenter.z);
    const distanceProfile = gunshotProfileFor(dist, isLocal);
    if (!isLocal && distanceProfile.band !== 'local' && !this.reserveRemoteGunshotVoice(distanceProfile)) return;
    const weaponProfile = {
      pistol: { report: 0.92, crack: 0.12, body: 'boom/a', bodyVol: 0.055, bodyRate: 2.35, tail: 0.075 },
      smg: { report: 0.86, crack: 0.09, body: 'boom/a', bodyVol: 0.045, bodyRate: 2.55, tail: 0.055 },
      ar: { report: 0.98, crack: 0.14, body: 'boom/a', bodyVol: 0.09, bodyRate: 2.05, tail: 0.085 },
      shotgun: { report: 1.08, crack: 0.18, body: 'boom/b', bodyVol: 0.25, bodyRate: 1.2, tail: 0.16 },
      sniper: { report: 1.12, crack: 0.24, body: 'boom/a', bodyVol: 0.28, bodyRate: 1.05, tail: 0.2 },
    }[kind] ?? { report: 0.92, crack: 0.12, body: 'boom/a', bodyVol: 0.055, bodyRate: 2.35, tail: 0.075 };
    // Local-only presentation boost: the shooter's own report reads ~3-4 dB
    // more forceful (x1.45 gain) without touching remote bands or other
    // weapons. The layered report/crack/body/tail design is preserved.
    const localSniperBoost = isLocal && kind === 'sniper' ? 1.45 : 1;
    if (localSniperBoost > 1) this.duckAmbience(0.19, 0.55);
    // One occlusion sample per shot: every layer muffles together, so a shot
    // behind a wall loses its crack first and keeps only the low tail.
    const occlusion = isLocal ? 0 : this.occlusionAt(x, y, z);

    // The close report is a verified CC0 firearm recording. A very short
    // filtered crack, low body and delayed outdoor tail restore the physical
    // layers that disappear when a real shot is reduced to a single sample.
    this.play(key, {
      x, y, z,
      vol: weaponProfile.report * distanceProfile.reportGain * localSniperBoost,
      rate: 0.94 + Math.random() * 0.12,
      lp: distanceProfile.reportLp,
      refDist: distanceProfile.reportRefDist,
      rolloff: distanceProfile.reportRolloff,
      occlusion,
    });
    this.gunCrack(
      x, y, z,
      weaponProfile.crack * distanceProfile.crackGain * localSniperBoost,
      distanceProfile.crackRefDist,
      distanceProfile.crackLp,
      distanceProfile.crackRolloff,
      occlusion,
    );
    this.play(weaponProfile.body, {
      x, y, z,
      vol: weaponProfile.bodyVol * distanceProfile.bodyGain * localSniperBoost,
      rate: weaponProfile.bodyRate + Math.random() * 0.08,
      lp: distanceProfile.bodyLp,
      refDist: distanceProfile.bodyRefDist,
      rolloff: distanceProfile.bodyRolloff,
      delay: 0.012,
      occlusion,
    });
    this.play(key, {
      x, y, z,
      vol: weaponProfile.tail * distanceProfile.tailGain,
      rate: 0.72 + Math.random() * 0.06,
      lp: distanceProfile.tailLp,
      refDist: distanceProfile.tailRefDist,
      rolloff: distanceProfile.tailRolloff,
      delay: kind === 'sniper' ? 0.085 : 0.055,
      occlusion,
    });

    // Low-end reinforcement for the two weapons whose muzzle blast is felt
    // as much as heard.
    if (kind === 'shotgun' || kind === 'sniper') {
      this.play('boom/sub', {
        x, y, z, vol: (kind === 'sniper' ? 0.38 : 0.32) * distanceProfile.subGain,
        rate: 1.08 + Math.random() * 0.14,
        lp: distanceProfile.subLp,
        refDist: distanceProfile.subRefDist,
        rolloff: distanceProfile.subRolloff,
        delay: 0.018,
        occlusion,
      });
    }
  }

  /** Brief high-frequency muzzle crack layered over recorded firearm reports. */
  private gunCrack(
    x: number, y: number, z: number, volume: number,
    refDist: number, lpFrequency: number, rolloff: number,
    occlusion = 0,
  ): void {
    if (!this.ctx || !this.noiseBuffer || !this.hrtfPanners) return;
    const entry = this.hrtfPanners.lease();
    const p = entry.panner;
    p.refDistance = refDist;
    p.rolloffFactor = rolloff;
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1700;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(220, lpFrequency * (1 - 0.85 * occlusion));
    const gain = this.ctx.createGain();
    const now = this.now();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(volume * (1 - 0.55 * occlusion), now + 0.0015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.032);
    src.connect(hp); hp.connect(lp); lp.connect(gain); gain.connect(p);
    this.hrtfPanners.attach(entry, src);
    src.start(now); src.stop(now + 0.038);
  }

  impact(x: number, y: number, z: number, material: string): void {
    if (!this.allowVoice('impact')) return;
    const table: Record<string, string[]> = {
      metal: ['impact/metal_a', 'impact/metal_b', 'impact/plate_a'],
      glass: ['impact/glass_a', 'impact/glass_b'],
      wood: ['impact/wood_a', 'impact/wood_b'],
      water: ['water/splash_a'],
      dirt: ['impact/soft_a'],
      foliage: ['impact/soft_a'],
    };
    const keys = table[material] ?? ['impact/stone_a', 'impact/stone_b'];
    this.play(keys[Math.floor(Math.random() * keys.length)]!, {
      x, y, z,
      vol: material === 'metal' ? 0.75 : 0.6,
      rate: 0.9 + Math.random() * 0.22,
      refDist: 3.5,
    });
  }

  ricochet(x: number, y: number, z: number): void {
    if (!this.allowVoice('ricochet')) return;
    this.play('impact/metal_a', { x, y, z, vol: 0.45, rate: 1.7 + Math.random() * 0.5, refDist: 3 });
  }

  glassBreak(x: number, y: number, z: number): void {
    this.play('impact/glass_b', { x, y, z, vol: 1.05, rate: 0.9 + Math.random() * 0.2 });
    this.play('impact/glass_a', { x, y, z, vol: 0.8, rate: 1.25 });
  }

  debrisCrack(x: number, y: number, z: number): void {
    this.play('impact/wood_b', { x, y, z, vol: 0.9, rate: 0.85 + Math.random() * 0.2 });
  }

  footstep(x: number, y: number, z: number, running: boolean, surface: string, isLocal = false): void {
    // Remote steps are rate-capped: ten combatants sprinting used to push
    // ~27 step events per second through the spatial mixer.
    if (!isLocal && !this.allowVoice('footstep')) return;
    const table: Record<string, string[]> = {
      stone: ['step/concrete_a', 'step/concrete_b', 'step/concrete_c'],
      metal: ['step/concrete_a', 'step/concrete_c'],
      wood: ['step/wood_a', 'step/wood_b'],
      grass: ['step/grass_a', 'step/grass_b'],
      carpet: ['step/carpet_a'],
      water: ['water/splash_a'],
    };
    const isSelf = Math.hypot(x - cameraCenter.x, z - cameraCenter.z) < 1.6;
    const keys = (table[surface] ?? table.stone!).slice();
    if (isSelf && surface === 'metal') keys.push('step/carpet_a');
    const key = keys[Math.floor(Math.random() * keys.length)]!;
    // Recorded steps peak close to full scale, but the old gain/ref-distance
    // combination pushed another combatant below the ambience after only a
    // few metres. Preserve headroom while keeping nearby movement actionable.
    const vol = (running ? 0.68 : 0.44) * (isSelf ? 0.92 : 1);
    const rate = surface === 'metal' ? 1.12 : 0.94 + Math.random() * 0.14;
    this.play(key, {
      x, y, z, vol, rate, refDist: 4.8, rolloff: 1.05,
      lp: running ? undefined : 6000,
      occlusion: isSelf ? 0 : this.occlusionAt(x, y, z),
    });
  }

  jumpLand(x: number, y: number, z: number, hard: boolean, surface = 'stone', isLocal = false): void {
    this.footstep(x, y, z, true, surface, isLocal);
    this.play('impact/soft_a', {
      x, y, z, vol: hard ? 0.8 : 0.4, rate: 0.8,
      occlusion: isLocal ? 0 : this.occlusionAt(x, y, z),
    });
  }

  whoosh(x: number, y: number, z: number, pitch = 1): void {
    if (!this.ctx || !this.noiseBuffer) return;
    // Distance attenuation so distant actors' movement layers stay local.
    const d = Math.hypot(x - cameraCenter.x, z - cameraCenter.z);
    if (d > 55) return;
    const pool = d > HRTF_MAX_DISTANCE ? this.farPanners : this.hrtfPanners;
    if (!pool) return;
    const att = 1 / (1 + (d * d) / 420);
    const entry = pool.lease();
    const p = entry.panner;
    p.refDistance = 3;
    p.rolloffFactor = 1.15;
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer;
    n.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    // A broad low-frequency air rush reads as cloth/wind. The previous
    // narrow 420->2100 Hz sweep was perceived as a synthetic projectile.
    bp.Q.value = 0.55;
    bp.frequency.setValueAtTime(180 * pitch, this.now());
    bp.frequency.exponentialRampToValueAtTime(720 * pitch, this.now() + 0.16);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, this.now());
    g.gain.linearRampToValueAtTime(0.1 * att, this.now() + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, this.now() + 0.24);
    n.connect(bp); bp.connect(g); g.connect(p);
    pool.attach(entry, n);
    n.start(); n.stop(this.now() + 0.26);
  }

  grappleFire(x: number, y: number, z: number): void {
    this.play('grapple/fire', { x, y, z, vol: 0.7, rate: 1.2 });
    this.whoosh(x, y, z, 1.5);
  }

  /** Positional punch swing: short filtered-noise "fwip". */
  meleeSwing(x: number, y: number, z: number): void {
    if (!this.ctx || !this.noiseBuffer || !this.hrtfPanners) return;
    const entry = this.hrtfPanners.lease();
    const p = entry.panner;
    p.refDistance = 4;
    p.rolloffFactor = 1.3;
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer;
    n.loop = true;
    n.playbackRate.value = 0.9 + Math.random() * 0.2;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(500, this.now());
    bp.frequency.exponentialRampToValueAtTime(2400, this.now() + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, this.now());
    g.gain.linearRampToValueAtTime(0.16, this.now() + 0.025);
    g.gain.exponentialRampToValueAtTime(0.0001, this.now() + 0.18);
    n.connect(bp); bp.connect(g); g.connect(p);
    this.hrtfPanners.attach(entry, n);
    n.start(); n.stop(this.now() + 0.2);
  }

  /** Punch connect: soft body thud + knuckle crack layer. */
  meleeHit(x: number, y: number, z: number): void {
    this.play('impact/soft_a', { x, y, z, vol: 0.85, rate: 0.92, refDist: 4 });
    this.play('impact/metal_a', { x, y, z, vol: 0.22, rate: 1.7, refDist: 4 });
  }

  dashFx(x: number, y: number, z: number): void {
    this.whoosh(x, y, z, 1.9);
  }

  splashFx(x: number, y: number, z: number, heavy: boolean): void {
    this.play(heavy ? 'water/splash_b' : 'water/splash_a', {
      x, y, z, vol: heavy ? 1.0 : 0.65, rate: heavy ? 0.92 : 1.06 + Math.random() * 0.14,
    });
  }

  healComplete(): void {
    this.play('ui/confirm', { bus: 'ui', vol: 0.8 });
  }

  chestOpen(x: number, y: number, z: number, tier = 0): void {
    // Mechanical lid, then a layered crystalline "shaan" reveal.
    // Bell + glass shimmer — deliberately non-electronic (treasure discovery).
    const bellRate = tier === 2 ? 1.42 : tier === 1 ? 1.62 : 1.86;
    const spatial: Pick<PlayOpts, 'refDist' | 'rolloff'> = { refDist: 2.5, rolloff: 0.7 };
    this.play('mech/door_open', { x, y, z, vol: 0.74, rate: tier === 2 ? 0.82 : tier === 1 ? 0.95 : 1.08, ...spatial });
    this.scheduleMatchEffect(() => {
      this.play('chest/open_a', { x, y, z, vol: 1.0, rate: tier === 2 ? 0.88 : 1, ...spatial });
      this.play('impact/metal_b', { x, y, z, vol: 0.32, rate: 1.3, ...spatial });
    }, 240);
    this.scheduleMatchEffect(() => {
      this.play('chest/bell', { x, y, z, vol: tier === 2 ? 0.62 : tier === 1 ? 0.52 : 0.42, rate: bellRate, ...spatial });
      this.play('chest/bell', { x, y, z, vol: tier === 2 ? 0.4 : 0.3, rate: bellRate * 1.26, ...spatial });
      this.play('impact/glass_a', { x, y, z, vol: tier === 2 ? 0.42 : 0.3, rate: tier === 2 ? 1.7 : 1.95, ...spatial });
    }, 320);
    if (tier >= 1) {
      this.scheduleMatchEffect(() => {
        this.play('chest/bell', { x, y, z, vol: 0.32, rate: bellRate * 1.5, ...spatial });
        this.play('impact/glass_b', { x, y, z, vol: 0.22, rate: 1.6, ...spatial });
      }, 520);
    }
  }

  pickupUi(rare: boolean): void {
    this.play(rare ? 'ui/confirm' : 'pickup/item', { bus: 'ui', vol: 0.75, rate: rare ? 1.05 : 1 });
  }

  /**
   * Physical pickup feedback: a cloth rustle plus a material clink. The old
   * electronic `ui/open_001` blip broke the foley layer the rest of the mix
   * builds. Rare (epic+ weapon) adds a faint crystalline shimmer on top of
   * the same physical base.
   */
  pickupFx(kind: 'weapon' | 'ammo' | 'heal' | undefined, rare: boolean): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const bus = this.buses.ui!;
    const ctx = this.ctx;
    const now = this.now();
    // Cloth rustle: two quick noise bursts through a bright bandpass read as
    // a hand brushing webbing/cloth while grabbing the item.
    for (const [offset, vol] of [[0, 0.16], [0.05, 0.1]] as const) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.playbackRate.value = 1.1 + Math.random() * 0.3;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 0.8;
      bp.frequency.value = 2100 + Math.random() * 700;
      const g = ctx.createGain();
      const t = now + offset;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      src.connect(bp); bp.connect(g); g.connect(bus);
      src.start(t); src.stop(t + 0.13);
    }
    if (kind === 'heal') {
      this.play('impact/glass_a', { bus: 'ui', vol: 0.12, rate: 1.85 });
    } else {
      // Magazine/weapon metal settling into the hands.
      this.play('impact/metal_a', { bus: 'ui', vol: 0.2, rate: 1.55 + Math.random() * 0.25 });
    }
    if (rare) {
      this.play('chest/bell', { bus: 'ui', vol: 0.16, rate: 2.3, delay: 0.09 });
      this.play('impact/glass_a', { bus: 'ui', vol: 0.1, rate: 2.1, delay: 0.1 });
    }
  }

  /**
   * Painful hard landing: floor impact, a pitch-dropping body thud and a
   * cloth/pad scuff. `severity` (0..1, derived from fall damage) scales gain
   * and low-end weight. Remote landings play positionally through the pooled
   * panner.
   */
  fallDamageFx(x: number, y: number, z: number, severity: number, isLocal = false): void {
    if (!this.ctx) return;
    this.play('impact/soft_a', { x, y, z, vol: 0.55 + 0.55 * severity, rate: 0.72 });
    const ctx = this.ctx;
    const now = this.now();
    const bus = this.buses.sfx!;
    // Position remote landings; a local landing sits at the listener anyway.
    let destination: AudioNode = bus;
    const pool = isLocal ? null : this.hrtfPanners;
    if (pool) {
      const leased = pool.lease();
      leased.panner.refDistance = 5;
      leased.panner.rolloffFactor = 1.2;
      leased.panner.positionX.value = x;
      leased.panner.positionY.value = y;
      leased.panner.positionZ.value = z;
      destination = leased.panner;
      if (this.noiseBuffer) {
        // Keep the panner slot tracked so it frees as soon as the thud ends.
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        pool.attach(leased, src);
        src.start(now); src.stop(now + 0.3);
      }
    }
    // Body thud: sub sine dropping two octaves reads as torso compression.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(115 - 35 * severity, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.45 + 0.5 * severity, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.27);
    osc.connect(g); g.connect(destination);
    osc.start(now); osc.stop(now + 0.3);
  }

  uiClick(kind: 'click' | 'hover' | 'back' | 'confirm' | 'error' = 'click'): void {
    this.play(`ui/${kind}`, { bus: 'ui', vol: kind === 'hover' ? 0.32 : 0.6 });
  }

  eliminationFx(x: number, y: number, z: number): void {
    this.play('boom/b', { x, y, z, vol: 0.5, rate: 1.4 });
    this.play('shield/break', { x, y, z, vol: 0.5, rate: 1.25 });
  }

  reloadClick(emptyMag: boolean): void {
    this.play(emptyMag ? 'impact/metal_b' : 'impact/metal_a', { bus: 'sfx', vol: emptyMag ? 0.38 : 0.3, rate: emptyMag ? 1.15 : 1.7 });
  }

  shieldHit(x: number, y: number, z: number): void {
    this.play('shield/hit', { x, y, z, vol: 0.55, rate: 0.9 + Math.random() * 0.3 });
  }

  shieldBreakFx(x: number, y: number, z: number): void {
    this.play('shield/break', { x, y, z, vol: 0.9, rate: 0.85 });
    this.play('impact/glass_b', { x, y, z, vol: 0.7, rate: 0.8 });
  }

  headshotTick(): void {
    this.play('ui/headshot', { bus: 'ui', vol: 0.5, rate: 1.6 });
  }

  // Low-health heartbeat: a "lub-dub" sub pulse whose rate tightens as health
  // drains. Driven by the presentation loop each frame via updateLowHealth().
  private lowHealthActive = false;
  private lowHealthSeverity = 1;
  private heartbeatTimer: number | null = null;

  /** `health`: local HP (0-100), or null when dead/spectating. */
  updateLowHealth(health: number | null): void {
    const active = health !== null && health > 0 && health <= 30;
    if (active && health !== null) this.lowHealthSeverity = 1 - health / 30;
    if (active === this.lowHealthActive) return;
    this.lowHealthActive = active;
    if (active) this.scheduleHeartbeat();
    else if (this.heartbeatTimer !== null) {
      window.clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // Rain bed + thunder: one looping filtered-noise source for the whole
  // match, thunder as sparse scheduled bursts. No per-frame audio work.
  private rainNodes: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private rainLevel = 0;
  private thunderTimer: number | null = null;

  /** Start (or adjust) the rain ambience bed. `intensity` 0..1. */
  startRain(intensity: number): void {
    if (!this.ctx || !this.noiseBuffer) return;
    this.rainLevel = Math.max(0.15, Math.min(1, intensity));
    if (this.rainNodes) {
      this.rainNodes.gain.gain.setTargetAtTime(this.rainGain(), this.now(), 0.5);
      return;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 400;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 0.4;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.0001;
    src.connect(hp); hp.connect(bp); bp.connect(gain); gain.connect(this.buses.ambience!);
    src.start();
    gain.gain.setTargetAtTime(this.rainGain(), this.now() + 0.05, 1.2);
    this.rainNodes = { src, gain };
    this.scheduleThunder();
  }

  stopRain(): void {
    if (this.rainNodes) {
      const { src, gain } = this.rainNodes;
      gain.gain.setTargetAtTime(0.0001, this.now(), 0.4);
      const timer = window.setTimeout(() => {
        try { src.stop(); } catch { /* already stopped */ }
      }, 1500);
      this.matchEffectTimers.add(timer);
      this.rainNodes = null;
    }
    if (this.thunderTimer !== null) {
      window.clearTimeout(this.thunderTimer);
      this.thunderTimer = null;
    }
    this.rainLevel = 0;
  }

  private rainGain(): number {
    return 0.05 + 0.13 * this.rainLevel;
  }

  private scheduleThunder(): void {
    if (!this.rainNodes) return;
    this.thunderTimer = window.setTimeout(() => {
      this.thunderBurst();
      this.scheduleThunder();
    }, 14000 + Math.random() * 26000);
  }

  /** Distant rolling thunder behind the rain bed. */
  private thunderBurst(): void {
    const vol = 0.08 + 0.22 * this.rainLevel;
    this.play('boom/a', { vol: vol * 0.8, rate: 0.55, lp: 900, refDist: 40, rolloff: 0.55, delay: Math.random() * 0.4 });
    this.play('boom/sub', { vol, rate: 0.7, lp: 400, delay: 0.2 + Math.random() * 0.6 });
  }

  private scheduleHeartbeat(): void {
    if (!this.lowHealthActive || !this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    for (const [offset, vol] of [[0, 0.3], [0.15, 0.2]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(58, t0 + offset);
      osc.frequency.exponentialRampToValueAtTime(40, t0 + offset + 0.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0 + offset);
      g.gain.linearRampToValueAtTime(vol, t0 + offset + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.13);
      osc.connect(g);
      g.connect(this.buses.sfx!);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.16);
    }
    const period = 1150 - 380 * this.lowHealthSeverity;
    this.heartbeatTimer = window.setTimeout(() => this.scheduleHeartbeat(), period);
  }

  explosionFx(x: number, y: number, z: number): void {
    this.play('boom/a', { x, y, z, vol: 1.1, rate: 0.9 + Math.random() * 0.2 });
    this.play('boom/sub', { x, y, z, vol: 0.8, rate: 0.95 });
  }

  poundImpact(x: number, y: number, z: number): void {
    this.play('boom/b', { x, y, z, vol: 0.9, rate: 0.8 });
    this.play('boom/sub', { x, y, z, vol: 0.7, rate: 1.05 });
  }

  stormWarningSting(): void {
    this.play('ui/storm', { bus: 'ui', vol: 0.7, rate: 0.8 });
    this.play('boom/sub', { vol: 0.35, bus: 'ui', rate: 0.7 });
  }

  doorSound(x: number, y: number, z: number, open: boolean): void {
    this.play(open ? 'mech/door_open' : 'mech/door_close', { x, y, z, vol: 0.8, rate: 0.96 + Math.random() * 0.08 });
  }

  victoryFanfare(win: boolean): void {
    this.stopMusic();
    if (!win) {
      this.play('ui/error', { bus: 'music', vol: 0.6, rate: 0.7 });
      return;
    }
    this.startMusic('victory');
  }

  // -------------------------------------------------------------------------
  // Ambience beds & zones
  // -------------------------------------------------------------------------

  startAmbience(preset: string, indoor: boolean): void {
    this.init();
    const generation = ++this.ambienceGeneration;
    const wanted: string[] =
      preset === 'night' || preset === 'bluehour'
        ? ['city_loop']
        : preset === 'overcast'
          ? ['wind_loop', 'birds_loop']
          : ['birds_loop', 'river_loop'];
    const files: Record<string, string> = {
      city_loop: 'ambience/city_loop.wav',
      wind_loop: 'ambience/wind_loop.wav',
      birds_loop: 'ambience/birds_loop.wav',
      river_loop: 'ambience/river_loop.wav',
    };
    for (const [key, file] of Object.entries(files)) {
      if (!wanted.includes(key)) continue;
      const raw = this.buffers.get(`bed/${key}`);
      if (!raw) {
        // decode lazily then retry once
        fetchAudio(file).then((ab) => this.ctx!.decodeAudioData(ab)).then((buf) => {
          if (generation !== this.ambienceGeneration) return;
          this.buffers.set(`bed/${key}`, buf);
          this.startAmbience(preset, indoor);
        }).catch(() => undefined);
        continue;
      }
      const existing = this.beds.get(key);
      if (existing) continue;
      const src = this.ctx!.createBufferSource();
      src.buffer = raw;
      src.loop = true;
      const gain = this.ctx!.createGain();
      gain.gain.value = 0;
      const target = key === 'city_loop' ? 0.34 : key === 'wind_loop' ? 0.3 : key === 'birds_loop' ? 0.24 : 0.3;
      gain.gain.setTargetAtTime(indoor ? target * 0.45 : target, this.now(), 1.2);
      src.connect(gain);
      gain.connect(this.buses.ambience!);
      src.start();
      this.beds.set(key, { src, gain });
    }
    // fade out beds no longer wanted
    for (const [key, bed] of this.beds) {
      if (!wanted.includes(key)) {
        bed.gain.gain.setTargetAtTime(0, this.now(), 0.6);
        window.setTimeout(() => { try { bed.src.stop(); } catch { /* stopped */ } }, 1600);
        this.beds.delete(key);
      } else {
        const base = key === 'city_loop' ? 0.34 : key === 'wind_loop' ? 0.3 : key === 'birds_loop' ? 0.24 : 0.3;
        bed.gain.gain.setTargetAtTime(indoor ? base * 0.45 : base, this.now(), 0.8);
      }
    }
  }

  stopAmbience(): void {
    this.ambienceGeneration++;
    for (const [, bed] of this.beds) {
      bed.gain.gain.setTargetAtTime(0, this.now(), 0.3);
      window.setTimeout(() => { try { bed.src.stop(); } catch { /* already */ } }, 900);
    }
    this.beds.clear();
  }

  /** Underwater / indoor acoustic state. */
  setEnvironmentState(state: 'open' | 'underwater'): void {
    if (!this.masterFilter) return;
    const t = this.now();
    if (state === 'underwater') {
      this.masterFilter.frequency.setTargetAtTime(700, t, 0.18);
    } else {
      this.masterFilter.frequency.setTargetAtTime(19500, t, 0.3);
    }
  }

  // -------------------------------------------------------------------------
  // Music: lobby loop + result stings only
  // -------------------------------------------------------------------------

  setMusicState(state: typeof this.musicState): void {
    if (state === this.musicState) return;
    this.musicState = state;
    this.stopMusic();
    if (state === 'lobby') this.startMusic('lobby');
    if (state === 'victory') this.startMusic('victory');
    if (state === 'defeat') this.play('ui/error', { bus: 'music', vol: 0.5, rate: 0.72 });
  }

  private stopMusic(): void {
    if (this.musicTimer !== null) {
      window.clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
    for (const o of this.musicNodes) {
      try { o.stop(); } catch { /* stopped */ }
    }
    this.musicNodes = [];
    if (this.musicGain) {
      this.musicGain.gain.setTargetAtTime(0, this.now(), 0.4);
      const g = this.musicGain;
      window.setTimeout(() => { try { g.disconnect(); } catch { /* ok */ } }, 1500);
      this.musicGain = null;
    }
  }

  private startMusic(state: 'lobby' | 'victory'): void {
    if (!this.ctx || !this.buses.music) return;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(state === 'lobby' ? 0.16 : 0.3, this.now(), state === 'lobby' ? 1.4 : 0.15);
    gain.connect(this.buses.music);
    this.musicGain = gain;

    if (state === 'victory') {
      const notes = [392, 494, 587, 784, 988];
      notes.forEach((f, i) => {
        const o = this.ctx!.createOscillator();
        o.type = 'triangle';
        o.frequency.value = f;
        const og = this.ctx!.createGain();
        og.gain.setValueAtTime(0.0001, this.now() + i * 0.14);
        og.gain.linearRampToValueAtTime(0.28, this.now() + i * 0.14 + 0.04);
        og.gain.exponentialRampToValueAtTime(0.0001, this.now() + i * 0.14 + 1.2);
        o.connect(og); og.connect(gain);
        o.start(this.now() + i * 0.14);
        o.stop(this.now() + i * 0.14 + 1.3);
        this.musicNodes.push(o);
      });
      return;
    }

    // Lobby: slow evolving pad (original)
    const chords: number[][] = [
      [220, 277.2, 329.6],
      [196, 246.9, 293.7],
      [174.6, 220, 261.6],
      [164.8, 207.7, 246.9],
    ];
    let ci = 0;
    const padStep = () => {
      if (this.musicState !== 'lobby' || !this.ctx) return;
      const chord = chords[ci % chords.length]!;
      ci++;
      const oscs: OscillatorNode[] = [];
      chord.forEach((f, k) => {
        const o = this.ctx!.createOscillator();
        o.type = k === 0 ? 'sawtooth' : 'triangle';
        o.frequency.value = f * (k === 0 ? 0.5 : 1);
        o.detune.value = (Math.random() - 0.5) * 8;
        const og = this.ctx!.createGain();
        og.gain.setValueAtTime(0.0001, this.now());
        og.gain.linearRampToValueAtTime(k === 0 ? 0.10 : 0.07, this.now() + 1.6);
        og.gain.setTargetAtTime(0.0001, this.now() + 4.4, 1.2);
        const lp = this.ctx!.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 900;
        o.connect(lp); lp.connect(og); og.connect(gain);
        o.start();
        oscs.push(o);
      });
      this.musicNodes.push(...oscs);
      window.setTimeout(() => {
        for (const o of oscs) { try { o.stop(); } catch { /* ok */ } }
      }, 8200);
      this.musicTimer = window.setTimeout(padStep, 6200);
    };
    padStep();
  }
}

const cameraCenter = { x: 0, z: 0 };

/** Wire all match events to audio. */
export function attachAudio(match: MatchLike, audio: AudioEngine, bus: EventBus<MatchEventsMap>): () => void {
  const offs: Array<() => void> = [];
  const localActor = createLocalActorIdentity(match.localActorId);
  const on = <K extends keyof MatchEventsMap>(k: K, fn: (p: MatchEventsMap[K]) => void) => offs.push(bus.on(k, fn));

  on('shotFired', (e) => audio.gunshot(e.weaponId, e.x, e.y, e.z, e.dry, isLocalActor(e.actorId, localActor)));
  on('impact', (e) => audio.impact(e.x, e.y, e.z, e.material));
  on('ricochet', (e) => audio.ricochet(e.x, e.y, e.z));
  on('glassBreak', (e) => audio.glassBreak(e.x, e.y, e.z));
  on('destructibleDestroyed', (e) => audio.debrisCrack(e.x, e.y, e.z));
  on('footstep', (e) => audio.footstep(e.x, e.y, e.z, e.running, e.surface, isLocalActor(e.actorId, localActor)));
  on('land', (e) => {
    const a = match.actors.find((x) => x.id === e.actorId);
    if (a) {
      audio.jumpLand(
        a.body.position.x, a.body.position.y, a.body.position.z,
        e.fallDamage > 0 || e.impactSpeed > 20, e.surface,
        isLocalActor(e.actorId, localActor),
      );
      if (e.fallDamage > 0) {
        audio.fallDamageFx(a.body.position.x, a.body.position.y, a.body.position.z, Math.min(1, e.fallDamage / 80), isLocalActor(e.actorId, localActor));
      }
    }
  });
  // A normal jump has no synthetic air-sweep layer. With several bots this
  // event used to fill ordinary firefights with repeated electronic whooshes;
  // landing material and footsteps provide the physical movement feedback.
  on('slide', (e) => {
    const a = match.actors.find((x) => x.id === e.actorId);
    if (a) audio.whoosh(a.body.position.x, a.body.position.y - 0.6, a.body.position.z, 0.8);
  });
  on('dash', (e) => {
    const a = match.actors.find((x) => x.id === e.actorId);
    if (a) audio.dashFx(a.body.position.x, a.body.position.y, a.body.position.z);
  });
  on('grappleAttach', (e) => audio.grappleFire(e.x, e.y, e.z));
  on('splash', (e) => audio.splashFx(e.x, e.y, e.z, e.heavy));
  on('chestOpened', (e) => audio.chestOpen(e.x, e.y, e.z, e.tier ?? 0));
  on('itemPickedUp', (e) => {
    if (isLocalActor(e.actorId, localActor)) audio.pickupFx(e.kind, e.rare ?? false);
  });
  on('healDone', (e) => {
    if (isLocalActor(e.actorId, localActor)) audio.healComplete();
  });
  on('reloadStarted', (e) => {
    if (isLocalActor(e.actorId, localActor)) audio.reloadClick(e.empty);
  });
  on('actorHit', (e) => {
    if (e.shieldDamage > 0) {
      const v = match.actors.find((a) => a.id === e.targetId);
      if (v) audio.shieldHit(v.body.position.x, v.body.position.y, v.body.position.z);
    }
  });
  on('shieldBroken', (e) => {
    const v = match.actors.find((a) => a.id === e.actorId);
    if (v) audio.shieldBreakFx(v.body.position.x, v.body.position.y, v.body.position.z);
  });
  on('headshotFeedback', (e) => {
    if (isLocalActor(e.attackerId, localActor)) audio.headshotTick();
  });
  on('eliminated', (e) => {
    const v = match.actors.find((a) => a.id === e.victimId);
    if (v) audio.eliminationFx(v.body.position.x, v.body.position.y, v.body.position.z);
  });
  on('poundImpact', (e) => audio.poundImpact(e.x, e.y, e.z));
  on('stormWaiting', () => audio.stormWarningSting());

  return () => {
    offs.forEach((f) => f());
    audio.cancelMatchEffects();
  };
}

interface MatchLike {
  actors: Array<{ id: number; body: { position: { x: number; y: number; z: number } } }>;
  localActorId: number | null;
}
