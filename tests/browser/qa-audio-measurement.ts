/**
 * Headed audio measurement for Phase 1 firearm profiles.
 *
 * This renders the bundled report WAV through the same distance profile
 * parameters and an HRTF PannerNode. It deliberately reports front/back
 * separately and does not invent an indoor result: AudioEngine currently has
 * no map-occlusion input, so indoor environmental filtering is a follow-up
 * boundary rather than a number this script can honestly measure.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const WEAPONS = [
  ['pistol', 'pistol_a.wav', 0.92],
  ['smg', 'smg_a.wav', 0.86],
  ['assault-rifle', 'ar_a.wav', 0.98],
  ['shotgun', 'shotgun_a.wav', 1.08],
  ['sniper', 'sniper_a.wav', 1.12],
] as const;
const DISTANCES = [10, 25, 50, 100, 150] as const;

interface Probe {
  weapon: string;
  distance: number;
  side: 'front' | 'behind';
  peak: number;
  peakDb: number;
  rms: number;
  reportGain: number;
  reportLp: number;
  reportRefDist: number;
  reportRolloff: number;
}

function legacyReport(distance: number, baseGain: number): { gain: number; lp: number; refDist: number; rolloff: number } {
  const nearField = Math.max(0, 1 - distance / 20);
  return {
    gain: baseGain * (1 + nearField * 0.2),
    lp: Math.max(900, 18000 - distance * 90),
    refDist: 7,
    rolloff: 1.25,
  };
}

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5212, strictPort: true }, logLevel: 'silent' });
  await server.listen();
  const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  try {
    await page.goto('http://localhost:5212/', { waitUntil: 'domcontentloaded' });
    const inputs = WEAPONS.flatMap(([weapon, file, baseGain]) => DISTANCES.flatMap((distance) => (
      (['front', 'behind'] as const).map((side) => ({ weapon, file, baseGain, distance, side }))
    )));
    const probes = await page.evaluate(async (items) => {
      const audioModulePath = `${location.origin}/src/audio/audio.ts`;
      const { gunshotProfileFor } = await import(/* @vite-ignore */ audioModulePath);
      const audio = new AudioContext();
      const buffers = new Map<string, AudioBuffer>();
      for (const item of items) {
        if (buffers.has(item.file)) continue;
        const response = await fetch(`/assets/audio/guns/${item.file}`);
        buffers.set(item.file, await audio.decodeAudioData(await response.arrayBuffer()));
      }
      const result: Array<Record<string, number | string>> = [];
      for (const item of items) {
        const profile = gunshotProfileFor(item.distance, false);
        const sample = buffers.get(item.file);
        if (!sample) throw new Error(`missing decoded sample ${item.file}`);
        const sampleRate = 44100;
        const frameCount = Math.ceil(sampleRate * 1.25);
        const offline = new OfflineAudioContext(2, frameCount, sampleRate);
        const source = offline.createBufferSource();
        source.buffer = sample;
        const filter = offline.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = profile.reportLp;
        const gain = offline.createGain();
        gain.gain.value = item.baseGain * profile.reportGain * 10 ** (4.5 / 20);
        const panner = offline.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'exponential';
        panner.refDistance = profile.reportRefDist;
        panner.rolloffFactor = profile.reportRolloff;
        panner.positionX.value = 0;
        panner.positionY.value = 1.2;
        panner.positionZ.value = item.side === 'front' ? -item.distance : item.distance;
        source.connect(filter);
        filter.connect(gain);
        gain.connect(panner);
        panner.connect(offline.destination);
        source.start(0);
        const rendered = await offline.startRendering();
        let peak = 0;
        let sumSquares = 0;
        let sampleCount = 0;
        for (let channel = 0; channel < rendered.numberOfChannels; channel++) {
          for (const value of rendered.getChannelData(channel)) {
            const absolute = Math.abs(value);
            peak = Math.max(peak, absolute);
            sumSquares += value * value;
            sampleCount++;
          }
        }
        result.push({
          weapon: item.weapon,
          distance: item.distance,
          side: item.side,
          peak,
          peakDb: 20 * Math.log10(Math.max(peak, 1e-9)),
          rms: Math.sqrt(sumSquares / Math.max(1, sampleCount)),
          reportGain: item.baseGain * profile.reportGain,
          reportLp: profile.reportLp,
          reportRefDist: profile.reportRefDist,
          reportRolloff: profile.reportRolloff,
        });
      }
      await audio.close();
      return result;
    }, inputs);
    for (const row of probes as unknown as Probe[]) console.log(JSON.stringify(row));
    console.log(JSON.stringify({
      legacySourceModel: Object.fromEntries(WEAPONS.map(([weapon, , baseGain]) => [
        weapon,
        Object.fromEntries(DISTANCES.map((distance) => [distance, legacyReport(distance, baseGain)])),
      ])),
      indoor: 'not-modeled: AudioEngine has no map-occlusion input',
      probeCount: probes.length,
    }));
  } finally {
    await page.close();
    await browser.close();
    await server.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
