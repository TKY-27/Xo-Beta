/**
 * Audio engine: fully procedural WebAudio synthesis (original work — no
 * external sound assets). Spatialized SFX via PannerNode, layered music
 * states, storm ambience. All gameplay sounds also emit perception events
 * through the match event bus (AI hearing never reads the audio graph).
 */

import type { EventBus } from '../core/events';
import type { MatchEventsMap } from '../sim/match';
import { getSettings } from '../core/settings';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private ambienceBus: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private listenerReady = false;
  private noiseBuffer: AudioBuffer | null = null;

  private musicState: 'none' | 'explore' | 'combat' | 'final' | 'victory' | 'defeat' = 'none';
  private musicNodes: Array<OscillatorNode> = [];
  private musicGain: GainNode | null = null;
  private windSource: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;

  init(): void {
    if (this.ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.ambienceBus = ctx.createGain();
    this.uiBus = ctx.createGain();
    for (const bus of [this.sfxBus, this.musicBus, this.ambienceBus, this.uiBus]) {
      bus!.connect(this.master);
    }

    // Shared noise buffer
    const len = ctx.sampleRate * 1.2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.applyVolumes();
    this.listenerReady = true;
  }

  resume(): void {
    void this.ctx?.resume();
  }

  applyVolumes(): void {
    if (!this.ctx || !this.master) return;
    const s = getSettings();
    this.master.gain.value = s.masterVolume;
    this.sfxBus!.gain.value = s.sfxVolume;
    this.musicBus!.gain.value = s.musicVolume * 0.55;
    this.ambienceBus!.gain.value = s.ambienceVolume;
    this.uiBus!.gain.value = s.uiVolume * 0.8;
  }

  private now(): number {
    return this.ctx!.currentTime;
  }

  // -------------------------------------------------------------------------
  // Low-level synth helpers
  // -------------------------------------------------------------------------

  private envGain(dest: AudioNode, attack: number, decay: number, peak: number, when = 0): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, this.now() + when);
    g.gain.linearRampToValueAtTime(peak, this.now() + when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, this.now() + when + attack + decay);
    g.connect(dest);
    return g;
  }

  private osc(type: OscillatorType, freq: number, detuneCents = 0): OscillatorNode {
    const o = this.ctx!.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detuneCents;
    return o;
  }

  private noise(when = 0): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuffer!;
    src.loop = true;
    src.start(this.now() + when + Math.random() * 0.01);
    return src;
  }

  private panner(x: number, y: number, z: number): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'exponential';
    p.refDistance = 6;
    p.rolloffFactor = 1.4;
    if (this.listenerReady) {
      const l = this.ctx!.listener;
      if (l.positionX) {
        l.positionX.value = 0; l.positionY.value = 2; l.positionZ.value = 0;
        l.forwardX.value = 0; l.forwardY.value = 0; l.forwardZ.value = -1;
        l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
      }
    }
    p.positionX.value = x - cameraCenter.x;
    p.positionY.value = y;
    p.positionZ.value = z - cameraCenter.z;
    return p;
  }
  /** Camera position fed each frame for relative panning. */
  static setListenerPos(x: number, z: number): void {
    cameraCenter.x = x;
    cameraCenter.z = z;
  }

  // -------------------------------------------------------------------------
  // Weapon / gameplay SFX
  // -------------------------------------------------------------------------

  gunshot(kind: string, x: number, y: number, z: number, dry = false): void {
    if (!this.ctx) return;
    const pan = this.panner(x, y, z);
    pan.connect(this.sfxBus!);
    if (dry) {
      const click = this.osc('square', 2400);
      click.connect(this.envGain(pan, 0.001, 0.04, 0.25));
      click.start();
      click.stop(this.now() + 0.08);
      return;
    }

    const when = 0;
    switch (kind) {
      case 'pistol': {
        const o = this.osc('sawtooth', 190);
        o.frequency.exponentialRampToValueAtTime(70, this.now() + 0.09);
        o.connect(this.envGain(pan, 0.002, 0.1, 0.5));
        o.start(); o.stop(this.now() + 0.14);
        const n = this.noise();
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'bandpass'; hp.frequency.value = 3200; hp.Q.value = 0.7;
        n.connect(hp); hp.connect(this.envGain(pan, 0.001, 0.07, 0.5, when));
        n.stop(this.now() + 0.12);
        break;
      }
      case 'smg': {
        const o = this.osc('square', 150);
        o.frequency.exponentialRampToValueAtTime(60, this.now() + 0.06);
        o.connect(this.envGain(pan, 0.001, 0.065, 0.42));
        o.start(); o.stop(this.now() + 0.1);
        const n = this.noise();
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 4200;
        n.connect(bp); bp.connect(this.envGain(pan, 0.001, 0.05, 0.4));
        n.stop(this.now() + 0.09);
        break;
      }
      case 'ar': {
        const o = this.osc('sawtooth', 130);
        o.frequency.exponentialRampToValueAtTime(52, this.now() + 0.11);
        o.connect(this.envGain(pan, 0.002, 0.13, 0.55));
        o.start(); o.stop(this.now() + 0.18);
        const n = this.noise();
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 2600;
        n.connect(lp); lp.connect(this.envGain(pan, 0.001, 0.1, 0.55));
        n.stop(this.now() + 0.15);
        break;
      }
      case 'shotgun': {
        const o = this.osc('sawtooth', 90);
        o.frequency.exponentialRampToValueAtTime(34, this.now() + 0.22);
        o.connect(this.envGain(pan, 0.003, 0.28, 0.85));
        o.start(); o.stop(this.now() + 0.36);
        const n = this.noise();
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 1400;
        n.connect(lp); lp.connect(this.envGain(pan, 0.002, 0.24, 0.8));
        n.stop(this.now() + 0.32);
        break;
      }
      case 'sniper': {
        const o = this.osc('sawtooth', 110);
        o.frequency.exponentialRampToValueAtTime(30, this.now() + 0.3);
        o.connect(this.envGain(pan, 0.003, 0.38, 0.95));
        o.start(); o.stop(this.now() + 0.48);
        const n = this.noise();
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 900;
        n.connect(hp); hp.connect(this.envGain(pan, 0.001, 0.3, 0.7));
        n.stop(this.now() + 0.42);
        break;
      }
    }
  }

  impact(x: number, y: number, z: number, material: string): void {
    if (!this.ctx) return;
    const pan = this.panner(x, y, z);
    pan.connect(this.sfxBus!);
    const n = this.noise();
    const f = this.ctx.createBiquadFilter();
    if (material === 'metal') { f.type = 'bandpass'; f.frequency.value = 5200; f.Q.value = 2; }
    else if (material === 'water') { f.type = 'lowpass'; f.frequency.value = 700; }
    else if (material === 'wood') { f.type = 'bandpass'; f.frequency.value = 1600; f.Q.value = 1; }
    else { f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 0.8; }
    n.connect(f);
    f.connect(this.envGain(pan, 0.001, 0.07, material === 'water' ? 0.4 : 0.3));
    n.stop(this.now() + 0.1);
  }

  ricochet(x: number, y: number, z: number): void {
    if (!this.ctx) return;
    const pan = this.panner(x, y, z);
    pan.connect(this.sfxBus!);
    const o = this.osc('sine', 3400 + Math.random() * 1800);
    o.frequency.exponentialRampToValueAtTime(600, this.now() + 0.14);
    o.connect(this.envGain(pan, 0.001, 0.16, 0.22));
    o.start(); o.stop(this.now() + 0.2);
  }

  glassBreak(x: number, y: number, z: number): void {
    if (!this.ctx) return;
    const pan = this.panner(x, y, z);
    pan.connect(this.sfxBus!);
    for (let i = 0; i < 5; i++) {
      const o = this.osc('triangle', 2600 + Math.random() * 3200);
      o.connect(this.envGain(pan, 0.001, 0.12 + Math.random() * 0.1, 0.14, i * 0.02));
      o.start(this.now() + i * 0.02);
      o.stop(this.now() + 0.3);
    }
    const n = this.noise();
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 4000;
    n.connect(hp);
    hp.connect(this.envGain(pan, 0.001, 0.18, 0.25));
    n.stop(this.now() + 0.24);
  }

  debrisCrack(x: number, y: number, z: number): void {
    if (!this.ctx) return;
    const pan = this.panner(x, y, z);
    pan.connect(this.sfxBus!);
    const n = this.noise();
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900;
    n.connect(lp);
    lp.connect(this.envGain(pan, 0.002, 0.2, 0.5));
    n.stop(this.now() + 0.26);
  }

  footstep(x: number, y: number, z: number, running: boolean): void {
    if (!this.ctx) return;
    const vol = running ? 0.16 : 0.09;
    const pan = this.panner(x, y, z);
    pan.connect(this.sfxBus!);
    const n = this.noise();
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380 + Math.random() * 220;
    n.connect(lp);
    lp.connect(this.envGain(pan, 0.002, 0.07, vol));
    n.stop(this.now() + 0.09);
  }

  jumpLand(x: number, y: number, z: number, hard: boolean): void {
    if (!this.ctx) return;
    const pan = this.panner(x, y, z);
    pan.connect(this.sfxBus!);
    const o = this.osc('sine', hard ? 90 : 130);
    o.frequency.exponentialRampToValueAtTime(50, this.now() + (hard ? 0.16 : 0.08));
    o.connect(this.envGain(pan, 0.002, hard ? 0.2 : 0.1, hard ? 0.45 : 0.2));
    o.start(); o.stop(this.now() + 0.26);
  }

  whoosh(x: number, y: number, z: number, pitch = 1): void {
    if (!this.ctx) return;
    const pan = this.panner(x, y, z);
    pan.connect(this.sfxBus!);
    const n = this.noise();
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(500 * pitch, this.now());
    bp.frequency.exponentialRampToValueAtTime(2200 * pitch, this.now() + 0.16);
    n.connect(bp);
    bp.connect(this.envGain(pan, 0.01, 0.18, 0.3));
    n.stop(this.now() + 0.24);
  }

  grappleFire(x: number, y: number, z: number): void {
    this.whoosh(x, y, z, 1.4);
    if (!this.ctx) return;
    const pan = this.panner(x, y, z);
    pan.connect(this.sfxBus!);
    const o = this.osc('square', 800);
    o.frequency.exponentialRampToValueAtTime(300, this.now() + 0.12);
    o.connect(this.envGain(pan, 0.002, 0.13, 0.16));
    o.start(); o.stop(this.now() + 0.17);
  }

  dashFx(x: number, y: number, z: number): void {
    this.whoosh(x, y, z, 1.9);
  }

  splashFx(x: number, y: number, z: number, heavy: boolean): void {
    if (!this.ctx) return;
    const pan = this.panner(x, y, z);
    pan.connect(this.sfxBus!);
    const n = this.noise();
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(heavy ? 1200 : 800, this.now());
    lp.frequency.exponentialRampToValueAtTime(300, this.now() + 0.35);
    n.connect(lp);
    lp.connect(this.envGain(pan, 0.005, heavy ? 0.5 : 0.3, heavy ? 0.55 : 0.3));
    n.stop(this.now() + (heavy ? 0.6 : 0.4));
  }

  healComplete(): void {
    if (!this.ctx || !this.uiBus) return;
    const g = this.envGain(this.uiBus, 0.02, 0.4, 0.3);
    [523, 659, 784].forEach((f, i) => {
      const o = this.osc('sine', f);
      o.connect(g);
      o.start(this.now() + i * 0.07);
      o.stop(this.now() + 0.5);
    });
  }

  chestOpen(x: number, y: number, z: number): void {
    if (!this.ctx) return;
    const pan = this.panner(x, y, z);
    pan.connect(this.sfxBus!);
    const o = this.osc('triangle', 330);
    o.frequency.linearRampToValueAtTime(520, this.now() + 0.25);
    o.connect(this.envGain(pan, 0.01, 0.35, 0.3));
    o.start(); o.stop(this.now() + 0.45);
    const shimmer = this.osc('sine', 1560);
    shimmer.connect(this.envGain(pan, 0.05, 0.5, 0.12));
    shimmer.start(); shimmer.stop(this.now() + 0.6);
  }

  pickupUi(): void {
    if (!this.ctx || !this.uiBus) return;
    const o = this.osc('sine', 720);
    o.frequency.setValueAtTime(720, this.now());
    o.frequency.linearRampToValueAtTime(980, this.now() + 0.06);
    o.connect(this.envGain(this.uiBus, 0.004, 0.1, 0.22));
    o.start(); o.stop(this.now() + 0.14);
  }

  uiClick(): void {
    if (!this.ctx || !this.uiBus) return;
    const o = this.osc('triangle', 440);
    o.connect(this.envGain(this.uiBus, 0.002, 0.06, 0.16));
    o.start(); o.stop(this.now() + 0.08);
  }

  eliminationFx(x: number, y: number, z: number): void {
    if (!this.ctx) return;
    const pan = this.panner(x, y, z);
    pan.connect(this.sfxBus!);
    const o = this.osc('sawtooth', 420);
    o.frequency.exponentialRampToValueAtTime(80, this.now() + 0.5);
    o.connect(this.envGain(pan, 0.01, 0.55, 0.3));
    o.start(); o.stop(this.now() + 0.65);
  }

  reloadClick(emptyMag: boolean): void {
    if (!this.ctx || !this.sfxBus) return;
    const o = this.osc('square', emptyMag ? 200 : 340);
    o.connect(this.envGain(this.sfxBus, 0.001, 0.05, emptyMag ? 0.2 : 0.14));
    o.start(); o.stop(this.now() + 0.08);
  }

  explosionFx(x: number, y: number, z: number): void {
    if (!this.ctx) return;
    const pan = this.panner(x, y, z);
    pan.connect(this.sfxBus!);
    const o = this.osc('sawtooth', 60);
    o.frequency.exponentialRampToValueAtTime(24, this.now() + 0.6);
    o.connect(this.envGain(pan, 0.004, 0.75, 0.95));
    o.start(); o.stop(this.now() + 0.9);
    const n = this.noise();
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(2400, this.now());
    lp.frequency.exponentialRampToValueAtTime(180, this.now() + 0.6);
    n.connect(lp);
    lp.connect(this.envGain(pan, 0.002, 0.7, 0.8));
    n.stop(this.now() + 0.85);
  }

  poundImpact(x: number, y: number, z: number): void {
    if (!this.ctx) return;
    const pan = this.panner(x, y, z);
    pan.connect(this.sfxBus!);
    const o = this.osc('sine', 70);
    o.frequency.exponentialRampToValueAtTime(30, this.now() + 0.3);
    o.connect(this.envGain(pan, 0.003, 0.42, 0.85));
    o.start(); o.stop(this.now() + 0.5);
  }

  stormTick(): void {
    if (!this.ctx || !this.ambienceBus) return;
    const o = this.osc('sine', 210);
    o.connect(this.envGain(this.ambienceBus, 0.02, 0.5, 0.2));
    o.start(); o.stop(this.now() + 0.6);
  }

  victoryFanfare(win: boolean): void {
    if (!this.ctx || !this.musicBus) return;
    const notes = win ? [392, 494, 587, 784] : [392, 330, 262, 196];
    notes.forEach((f, i) => {
      const o = this.osc('triangle', f);
      o.connect(this.envGain(this.musicBus!, 0.03, 1.1, 0.3, i * 0.16));
      o.start(this.now() + i * 0.16);
      o.stop(this.now() + i * 0.16 + 1.3);
    });
  }

  // -------------------------------------------------------------------------
  // Ambience (wind bed) + music states
  // -------------------------------------------------------------------------

  startAmbience(preset: string): void {
    if (!this.ctx || !this.ambienceBus || this.windSource) return;
    const n = this.noise();
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = preset === 'night' ? 240 : preset === 'overcast' ? 380 : 300;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.05;
    n.connect(lp);
    lp.connect(gain);
    gain.connect(this.ambienceBus);
    this.windSource = n;
    this.windGain = gain;
  }

  stopAmbience(): void {
    try { this.windSource?.stop(); } catch { /* already stopped */ }
    this.windSource = null;
    this.windGain = null;
  }

  setStormNearby(near: boolean): void {
    if (this.windGain && this.ctx) {
      this.windGain.gain.setTargetAtTime(near ? 0.14 : 0.05, this.now(), 1.2);
    }
  }

  setMusicState(state: typeof this.musicState): void {
    if (state === this.musicState) return;
    this.musicState = state;
    // Tear down previous layer
    for (const o of this.musicNodes) {
      try { o.stop(); } catch { /* already stopped */ }
    }
    this.musicNodes = [];
    if (this.musicGain) {
      this.musicGain.gain.setTargetAtTime(0, this.now(), 0.4);
      this.musicGain = null;
    }
    if (state === 'none' || !this.ctx || !this.musicBus) return;

    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(state === 'combat' ? 0.34 : state === 'final' ? 0.42 : state === 'explore' ? 0.22 : 0.3, this.now(), 0.8);
    gain.connect(this.musicBus);
    this.musicGain = gain;

    // Simple evolving pad + pulse patterns per state
    const scales: Record<string, number[]> = {
      explore: [220, 277, 330, 415],
      combat: [174, 207, 233, 261],
      final: [146, 155, 174, 185],
      victory: [261, 329, 392, 523],
      defeat: [196, 185, 164, 146],
    };
    const notes = scales[state]!;
    const patternSpeed = state === 'combat' ? 0.24 : state === 'final' ? 0.3 : 0.62;

    const padOsc = this.osc('sawtooth', notes[0]! / 2);
    const padFilter = this.ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = state === 'final' ? 480 : 700;
    padOsc.connect(padFilter);
    padFilter.connect(gain);
    padOsc.start();
    this.musicNodes.push(padOsc);

    let step = 0;
    const tickNote = () => {
      if (this.musicState !== state || !this.ctx) return;
      const f = notes[step % notes.length]!;
      const o = this.osc(state === 'final' ? 'square' : 'triangle', f);
      o.connect(this.envGain(gain, 0.01, patternSpeed * 1.6, 0.12));
      o.start();
      o.stop(this.now() + patternSpeed * 2);
      step++;
      window.setTimeout(tickNote, patternSpeed * 1000);
    };
    tickNote();
  }
}

const cameraCenter = { x: 0, z: 0 };

/** Wire all match events to audio. */
export function attachAudio(match: MatchLike, audio: AudioEngine, bus: EventBus<MatchEventsMap>): () => void {
  const offs: Array<() => void> = [];
  const on = <K extends keyof MatchEventsMap>(k: K, fn: (p: MatchEventsMap[K]) => void) => offs.push(bus.on(k, fn));

  on('shotFired', (e) => {
    audio.gunshot(e.weaponId, e.x, e.y, e.z, e.dry);
  });
  on('impact', (e) => audio.impact(e.x, e.y, e.z, e.material));
  on('ricochet', (e) => audio.ricochet(e.x, e.y, e.z));
  on('glassBreak', (e) => audio.glassBreak(e.x, e.y, e.z));
  on('destructibleDestroyed', (e) => audio.debrisCrack(e.x, e.y, e.z));
  on('footstep', (e) => audio.footstep(e.x, e.y, e.z, e.running));
  on('land', (e) => {
    const a = match.actors.find((x) => x.id === e.actorId);
    if (a) audio.jumpLand(a.body.position.x, a.body.position.y, a.body.position.z, e.fallDamage > 0 || e.impactSpeed > 20);
  });
  on('jump', () => audio.whoosh(cameraCenter.x, 2, cameraCenter.z, 1.2));
  on('slide', () => audio.whoosh(cameraCenter.x, 1, cameraCenter.z, 0.8));
  on('dash', () => audio.dashFx(cameraCenter.x, 1.5, cameraCenter.z));
  on('grappleAttach', (e) => audio.grappleFire(e.x, e.y, e.z));
  on('splash', (e) => audio.splashFx(cameraCenter.x, 0, cameraCenter.z, e.heavy));
  on('chestOpened', (e) => audio.chestOpen(e.x, e.y, e.z));
  on('itemPickedUp', () => audio.pickupUi());
  on('healDone', () => audio.healComplete());
  on('reloadStarted', (e) => audio.reloadClick(e.empty));
  on('eliminated', (e) => {
    const v = match.actors.find((a) => a.id === e.victimId);
    if (v) audio.eliminationFx(v.body.position.x, v.body.position.y, v.body.position.z);
  });
  on('poundImpact', (e) => audio.poundImpact(e.x, e.y, e.z));
  on('stormWaiting', () => audio.stormTick());

  return () => offs.forEach((f) => f());
}

interface MatchLike {
  actors: Array<{ id: number; body: { position: { x: number; y: number; z: number } } }>;
}

// attachAudio only reads ids/positions; the full Match type satisfies it structurally.
