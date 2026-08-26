/**
 * Audio engine v2: recorded sample playback (CC0 — see
 * docs/ASSET_MANIFEST.md) with WebAudio spatialization, distance filtering,
 * map-specific ambience beds and underwater processing. Continuous match
 * music is intentionally absent — the soundscape carries immersion.
 */

import type { EventBus } from '../core/events';
import type { MatchEventsMap } from '../sim/match';
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
  ['shield/hit', 'lasers/laserSmall_0.wav'],
  ['shield/break', 'lasers/forceField_001.wav'],
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

export class AudioEngine {
  private static listenerInstance: AudioEngine | null = null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterFilter: BiquadFilterNode | null = null;
  private buses: Partial<Record<BusName, GainNode>> = {};
  private buffers = new Map<string, AudioBuffer>();
  private noiseBuffer: AudioBuffer | null = null;

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
    for (const name of ['sfx', 'ui', 'ambience', 'music'] as BusName[]) {
      const g = ctx.createGain();
      g.connect(this.masterFilter);
      this.buses[name] = g;
    }
    this.masterFilter.connect(this.master);
    this.master.connect(ctx.destination);

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

  /** Spatial one-shot buffer playback through a panner. */
  play(key: string, opts: PlayOpts = {}): void {
    const buf = this.buffers.get(key);
    if (!buf || !this.ctx) return;
    const bus = this.buses[opts.bus ?? 'sfx']!;
    let node: AudioNode = bus;

    if (opts.lp !== undefined) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = Math.max(220, opts.lp);
      f.connect(bus);
      node = f;
    }

    let out: AudioNode = node;
    const hasPos = opts.x !== undefined;
    if (hasPos) {
      const p = this.ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'exponential';
      p.refDistance = opts.refDist ?? 5;
      p.rolloffFactor = opts.rolloff ?? 1.25;
      p.positionX.value = opts.x!;
      p.positionY.value = opts.y ?? 1.2;
      p.positionZ.value = opts.z!;
      p.connect(node);
      out = p;
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = opts.rate ?? 1;
    const g = this.ctx.createGain();
    g.gain.value = opts.vol ?? 1;
    g.connect(out);
    src.connect(g);
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

  gunshot(kind: string, x: number, y: number, z: number, dry = false): void {
    if (!this.ctx) return;
    if (dry) {
      this.play('ui/click', { x, y, z, vol: 0.35, rate: 1.8 });
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
    const lp = Math.max(900, 18000 - dist * 90);
    const nearVol = kind === 'pistol' && dist < 3 ? 0.55 : 1;
    const profile = {
      pistol: { report: 0.92, crack: 0.12, body: 'boom/a', bodyVol: 0.055, bodyRate: 2.35, tail: 0.075 },
      smg: { report: 0.86, crack: 0.09, body: 'boom/a', bodyVol: 0.045, bodyRate: 2.55, tail: 0.055 },
      ar: { report: 0.98, crack: 0.14, body: 'boom/a', bodyVol: 0.09, bodyRate: 2.05, tail: 0.085 },
      shotgun: { report: 1.08, crack: 0.18, body: 'boom/b', bodyVol: 0.25, bodyRate: 1.2, tail: 0.16 },
      sniper: { report: 1.12, crack: 0.24, body: 'boom/a', bodyVol: 0.28, bodyRate: 1.05, tail: 0.2 },
    }[kind] ?? { report: 0.92, crack: 0.12, body: 'boom/a', bodyVol: 0.055, bodyRate: 2.35, tail: 0.075 };

    // The close report is a verified CC0 firearm recording. A very short
    // filtered crack, low body and delayed outdoor tail restore the physical
    // layers that disappear when a real shot is reduced to a single sample.
    this.play(key, {
      x, y, z,
      vol: profile.report * nearVol,
      rate: 0.94 + Math.random() * 0.12,
      lp,
      refDist: 7,
    });
    this.gunCrack(x, y, z, profile.crack);
    this.play(profile.body, {
      x, y, z,
      vol: profile.bodyVol,
      rate: profile.bodyRate + Math.random() * 0.08,
      lp: kind === 'shotgun' || kind === 'sniper' ? 5200 : 6800,
      refDist: 9,
      delay: 0.012,
    });
    this.play(key, {
      x, y, z,
      vol: profile.tail,
      rate: 0.72 + Math.random() * 0.06,
      lp: Math.max(1200, 6200 - dist * 35),
      refDist: 15,
      rolloff: 0.82,
      delay: kind === 'sniper' ? 0.085 : 0.055,
    });

    // Low-end reinforcement for the two weapons whose muzzle blast is felt
    // as much as heard.
    if (kind === 'shotgun' || kind === 'sniper') {
      this.play('boom/sub', {
        x, y, z, vol: kind === 'sniper' ? 0.38 : 0.32,
        rate: 1.08 + Math.random() * 0.14,
        delay: 0.018,
      });
    }
  }

  /** Brief high-frequency muzzle crack layered over recorded firearm reports. */
  private gunCrack(x: number, y: number, z: number, volume: number): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'exponential';
    p.refDistance = 8;
    p.rolloffFactor = 1.05;
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
    p.connect(this.buses.sfx!);

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1700;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 9200;
    const gain = this.ctx.createGain();
    const now = this.now();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.0015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.032);
    src.connect(hp); hp.connect(lp); lp.connect(gain); gain.connect(p);
    src.start(now); src.stop(now + 0.038);
  }

  impact(x: number, y: number, z: number, material: string): void {
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
    this.play('impact/metal_a', { x, y, z, vol: 0.45, rate: 1.7 + Math.random() * 0.5, refDist: 3 });
  }

  glassBreak(x: number, y: number, z: number): void {
    this.play('impact/glass_b', { x, y, z, vol: 1.05, rate: 0.9 + Math.random() * 0.2 });
    this.play('impact/glass_a', { x, y, z, vol: 0.8, rate: 1.25 });
  }

  debrisCrack(x: number, y: number, z: number): void {
    this.play('impact/wood_b', { x, y, z, vol: 0.9, rate: 0.85 + Math.random() * 0.2 });
  }

  footstep(x: number, y: number, z: number, running: boolean, surface: string): void {
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
    // A restrained 10% reduction keeps material cues readable without
    // competing with weapon reports and nearby threats.
    const vol = (running ? 0.558 : 0.342) * (isSelf ? 0.85 : 1);
    const rate = surface === 'metal' ? 1.12 : 0.94 + Math.random() * 0.14;
    this.play(key, { x, y, z, vol, rate, refDist: 3, lp: running ? undefined : 5200 });
  }

  jumpLand(x: number, y: number, z: number, hard: boolean, surface = 'stone'): void {
    this.footstep(x, y, z, true, surface);
    this.play('impact/soft_a', { x, y, z, vol: hard ? 0.8 : 0.4, rate: 0.8 });
  }

  whoosh(x: number, _y: number, z: number, pitch = 1): void {
    if (!this.ctx || !this.noiseBuffer) return;
    // Distance attenuation so distant actors' movement layers stay local.
    const d = Math.hypot(x - cameraCenter.x, z - cameraCenter.z);
    if (d > 55) return;
    const att = 1 / (1 + (d * d) / 420);
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer;
    n.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.3;
    bp.frequency.setValueAtTime(420 * pitch, this.now());
    bp.frequency.exponentialRampToValueAtTime(2100 * pitch, this.now() + 0.16);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, this.now());
    g.gain.linearRampToValueAtTime(0.22 * att, this.now() + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, this.now() + 0.24);
    n.connect(bp); bp.connect(g); g.connect(this.buses.sfx!);
    n.start(); n.stop(this.now() + 0.26);
  }

  grappleFire(x: number, y: number, z: number): void {
    this.play('grapple/fire', { x, y, z, vol: 0.7, rate: 1.2 });
    this.whoosh(x, y, z, 1.5);
  }

  /** Positional punch swing: short filtered-noise "fwip". */
  meleeSwing(x: number, y: number, z: number): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'exponential';
    p.refDistance = 4;
    p.rolloffFactor = 1.3;
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
    p.connect(this.buses.sfx!);
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
    this.play('mech/door_open', { x, y, z, vol: 0.6, rate: tier === 2 ? 0.82 : tier === 1 ? 0.95 : 1.08 });
    this.scheduleMatchEffect(() => {
      this.play('chest/open_a', { x, y, z, vol: 0.9, rate: tier === 2 ? 0.88 : 1 });
      this.play('impact/metal_b', { x, y, z, vol: 0.32, rate: 1.3 });
    }, 240);
    this.scheduleMatchEffect(() => {
      this.play('chest/bell', { x, y, z, vol: tier === 2 ? 0.5 : tier === 1 ? 0.4 : 0.3, rate: bellRate });
      this.play('chest/bell', { x, y, z, vol: tier === 2 ? 0.34 : 0.24, rate: bellRate * 1.26 });
      this.play('impact/glass_a', { x, y, z, vol: tier === 2 ? 0.42 : 0.3, rate: tier === 2 ? 1.7 : 1.95 });
    }, 320);
    if (tier >= 1) {
      this.scheduleMatchEffect(() => {
        this.play('chest/bell', { x, y, z, vol: 0.28, rate: bellRate * 1.5 });
        this.play('impact/glass_b', { x, y, z, vol: 0.22, rate: 1.6 });
      }, 520);
    }
  }

  pickupUi(rare: boolean): void {
    this.play(rare ? 'ui/confirm' : 'pickup/item', { bus: 'ui', vol: 0.75, rate: rare ? 1.05 : 1 });
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
  const on = <K extends keyof MatchEventsMap>(k: K, fn: (p: MatchEventsMap[K]) => void) => offs.push(bus.on(k, fn));

  on('shotFired', (e) => audio.gunshot(e.weaponId, e.x, e.y, e.z, e.dry));
  on('impact', (e) => audio.impact(e.x, e.y, e.z, e.material));
  on('ricochet', (e) => audio.ricochet(e.x, e.y, e.z));
  on('glassBreak', (e) => audio.glassBreak(e.x, e.y, e.z));
  on('destructibleDestroyed', (e) => audio.debrisCrack(e.x, e.y, e.z));
  on('footstep', (e) => audio.footstep(e.x, e.y, e.z, e.running, e.surface));
  on('land', (e) => {
    const a = match.actors.find((x) => x.id === e.actorId);
    if (a) audio.jumpLand(a.body.position.x, a.body.position.y, a.body.position.z, e.fallDamage > 0 || e.impactSpeed > 20, e.surface);
  });
  on('jump', (e) => {
    const a = match.actors.find((x) => x.id === e.actorId);
    if (a) audio.whoosh(a.body.position.x, a.body.position.y, a.body.position.z, 1.2);
  });
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
  on('itemPickedUp', (e) => audio.pickupUi(e.rare ?? false));
  on('healDone', () => audio.healComplete());
  on('reloadStarted', (e) => audio.reloadClick(e.empty));
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
  on('headshotFeedback', () => audio.headshotTick());
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
}
