/**
 * Page half of the standalone GTAO probe. See `qa-gtao-probe.ts` for why this
 * exists and what the sample points mean.
 */
import * as THREE from 'three/webgpu';
import { pass, texture, float } from 'three/tsl';
// NOTE: GTAONode is a *default* export. Importing it as a named export yields
// undefined at module load, which fails before any error handler runs.
import GTAONode from 'three/addons/tsl/display/GTAONode.js';

const WIDTH = 640;
const HEIGHT = 400;

type Sample = {
  geoMean: number;
  geoMin: number;
  p05: number;
  p50: number;
  spread: number;
  coverage: number;
  frameMin: number;
};
type Run = { mode: string; samples: Sample | null; error: string | null };

// The bundled @types stub for GTAONode is stale: it declares neither
// getTextureNode() nor updateBeforeType. It does, however, correctly type the
// tunables as UniformNodes -- which is the important part. Assigning a raw
// number to one of these replaces the uniform *node* with a JS number and
// breaks the graph (`this.samples.lessThan is not a function`), which is what
// produced the historical "AO returns ~0 on WebGPU" black frame.
type Uniform<T> = { value: T };
type GtaoLike = {
  resolutionScale: number;
  radius: Uniform<number>;
  thickness: Uniform<number>;
  scale: Uniform<number>;
  distanceFallOff: Uniform<number>;
  distanceExponent: Uniform<number>;
  samples: Uniform<number>;
  updateBeforeType: THREE.NodeUpdateType;
  getTextureNode: () => { r: unknown };
};

const log = document.getElementById('log')!;
const say = (text: string): void => {
  log.textContent = text;
};

function buildScene(): {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  dispose: () => void;
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(55, WIDTH / HEIGHT, 0.1, 200);
  camera.position.set(0, 2.4, 7.5);
  camera.lookAt(0, 0.6, 0);

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.castShadow = true;
  scene.add(floor);
  geometries.push(floor.geometry);
  materials.push(floor.material as THREE.Material);

  // A ground plane plus boxes is a weak occluder test: the boxes are short and
  // widely spaced, so even a healthy GTAO pass barely darkens anything. Add a
  // proper corner -- a floor meeting a tall wall -- which is the case that
  // actually matters for grounding and is unambiguous when it works.
  const backWall = new THREE.Mesh(
    new THREE.BoxGeometry(40, 8, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  );
  backWall.position.set(0, 4, -3);
  backWall.castShadow = true;
  backWall.receiveShadow = true;
  scene.add(backWall);
  geometries.push(backWall.geometry);
  materials.push(backWall.material as THREE.Material);

  // A row of boxes with gaps: the gaps give unambiguous "open ground" and the
  // contact patches under each box give unambiguous occlusion.
  for (let i = -2; i <= 2; i += 1) {
    const geo = new THREE.BoxGeometry(1.1, 1.4, 1.1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
    const box = new THREE.Mesh(geo, mat);
    box.position.set(i * 2.1, 0.7, 0);
    box.castShadow = true;
    box.receiveShadow = true;
    scene.add(box);
    geometries.push(geo);
    materials.push(mat);
  }

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(4, 8, 5);
  key.castShadow = true;
  scene.add(key, new THREE.AmbientLight(0xffffff, 0.6));

  return {
    scene,
    camera,
    dispose: () => {
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
    },
  };
}

async function read(
  mode: string,
  applyAo: boolean,
  radius: number,
  scale: number,
  thickness = 1.0,
  sampleCount = 16,
): Promise<Run> {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.body.appendChild(canvas);

  const { scene, camera, dispose } = buildScene();
  let renderer: InstanceType<typeof THREE.WebGPURenderer> | null = null;
  let post: InstanceType<typeof THREE.PostProcessing> | null = null;
  // Declared out here so the finally block can release it if the render that
  // fills it throws partway through setup.
  let normalTarget: THREE.RenderTarget | null = null;

  try {
    renderer = new THREE.WebGPURenderer({ canvas, antialias: false });
    renderer.setSize(WIDTH, HEIGHT);
    renderer.shadowMap.enabled = true;
    await renderer.init();

    const scenePass = pass(scene, camera);
    const depthTexture = scenePass.getTextureNode('depth');
    const colorTexture = scenePass.getTextureNode('output');

    // GTAONode samples normals via `this.normalNode.sample(uv).rgb`, so the
    // normal input must be a *samplable texture node*. Passing null falls back
    // to `getNormalFromDepth(uv, this.depthNode.value, projInverse)`, and
    // `.value` on a TextureNode is the texture itself rather than a
    // per-fragment depth float -- so the reconstruction is garbage and the AO
    // result is a uniform 1.0. That is the real reason the historical note
    // recorded "AO returns ~0 on WebGPU": the pass never had usable normals.
    // Render a view-space normal target and feed that in instead.
    let normalNode: unknown = null;
    if (mode.includes('normalTex')) {
      normalTarget = new THREE.RenderTarget(WIDTH, HEIGHT, {
        type: THREE.HalfFloatType,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
      });
      const normalMaterial = new THREE.MeshNormalMaterial();
      const previousOverride = scene.overrideMaterial;
      scene.overrideMaterial = normalMaterial;
      renderer.setRenderTarget(normalTarget);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      scene.overrideMaterial = previousOverride;
      normalMaterial.dispose();
      normalNode = texture(normalTarget.texture);
    }

    // GTAONode samples the depth itself (`this.depthNode.sample(uv).r`), so it
    // wants the depth TextureNode itself -- not `.r` and not `.node`.
    const ao = new GTAONode(
      depthTexture as never,
      normalNode as never,
      camera,
    ) as unknown as GtaoLike;
    ao.resolutionScale = scale;
    // Tunables are uniform nodes: write through .value, never assign.
    ao.radius.value = radius;
    // `thickness` gates every horizon sample: a sample only contributes when
    // abs(viewDelta.z) < thickness. The GTAOPass default of 1.0 is in *world
    // units of view-space depth*, so at typical view distances it rejects nearly
    // every sample and the effect collapses to (almost) no occlusion. Scaling it
    // with the radius is the documented way to keep the horizon test meaningful.
    ao.thickness.value = thickness;
    ao.scale.value = 1.0;
    ao.distanceFallOff.value = 1.0;
    ao.distanceExponent.value = 1.0;
    ao.samples.value = sampleCount;
    ao.updateBeforeType = THREE.NodeUpdateType.FRAME;

    post = new THREE.PostProcessing(renderer);
    const aoFactor = ao.getTextureNode().r as never;
    // 'multiply' is the real integration. 'ao-only' outputs the AO buffer
    // directly as colour: the AO target clears to white, so a dead effect reads
    // exactly 1.0 and any value below 1.0 proves the depth reached the effect.
    // 'depth-mask' is a binary proof that the depth node carries real geometry:
    // white where the sample is the far plane, black where geometry exists.
    // Raw depth is useless here because the sRGB output transform maps ~0.988 to
    // ~0.994, which is indistinguishable from 1.0 at three decimals.
    if (mode.includes('ao-only')) {
      post.outputNode = aoFactor as never;
    } else if (mode.includes('ao-stretch')) {
      // The AO buffer is white where unoccluded, so raw output hides everything
      // below a few percent. Expand the occlusion range so any real structure is
      // visible: ao below 11/12 maps to black.
      const a = aoFactor as unknown as {
        sub: (v: THREE.Node) => { mul: (v: THREE.Node) => { add: (v: THREE.Node) => { clamp: (a: number, b: number) => THREE.Node } } };
      };
      post.outputNode = a.sub(float(1.0)).mul(float(12.0)).add(float(1.0)).clamp(0, 1) as never;
    } else if (mode.includes('depth-mask')) {
      const depthR = (depthTexture as never as { r: THREE.Node & { lessThan: (v: number) => THREE.Node } }).r;
      post.outputNode = depthR.lessThan(0.999).select(0x000000, 0xffffff) as never;
    } else {
      post.outputNode = applyAo ? colorTexture.rgb.mul(aoFactor) : colorTexture.rgb;
    }

    // GTAONode renders in updateBefore(), so it needs at least one warm frame
    // before the composited result is meaningful.
    for (let i = 0; i < 3; i += 1) await post.renderAsync();

    // Statistics over the frame, excluding the (black) background. A working AO
    // pass shows contact darkening exactly where geometry meets geometry.
    const scratch = document.createElement('canvas');
    scratch.width = WIDTH;
    scratch.height = HEIGHT;
    const ctx = scratch.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
    const lum = (x: number, y: number): number => {
      const i = (y * WIDTH + x) * 4;
      return (data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114) / 255;
    };

    // "Geometry" = anything the scene actually drew. For the ao-only and
    // depth-mask passes the frame is a boolean, so geometry is "not black". The
    // AO target clears to white, so a working AO pass must also produce values
    // strictly below 1.0 somewhere (the contacts).
    const isBinary = mode.includes('ao-only') || mode.includes('depth-mask') || mode.includes('ao-stretch');
    const isGeometry = isBinary ? (x: number, y: number) => lum(x, y) > 0.02 : () => true;
    const geoValues: number[] = [];
    let frameMin = 1;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const value = lum(x, y);
        if (value < frameMin) frameMin = value;
        if (isGeometry(x, y)) geoValues.push(value);
      }
    }
    geoValues.sort((a, b) => a - b);
    const quantile = (q: number): number => geoValues[Math.min(geoValues.length - 1, Math.floor(geoValues.length * q))] ?? 1;
    const mean = geoValues.reduce((sum, v) => sum + v, 0) / Math.max(1, geoValues.length);
    const p05 = quantile(0.05);
    const p50 = quantile(0.5);
    const samples: Sample = {
      geoMean: mean,
      geoMin: geoValues[0] ?? 1,
      p05,
      p50,
      spread: p50 - p05,
      coverage: geoValues.length / (WIDTH * HEIGHT),
      frameMin,
    };

    // Keep an image of the AO/depth buffer for visual confirmation.
    if (isBinary) {
      const shot = (window as unknown as { __GTAO_SHOTS: Record<string, string> }).__GTAO_SHOTS;
      shot[mode] = scratch.toDataURL('image/png');
    }

    return { mode, samples, error: null };
  } catch (err) {
    return { mode, samples: null, error: String(err) };
  } finally {
    post?.dispose?.();
    normalTarget?.dispose();
    renderer?.dispose();
    dispose();
    canvas.remove();
  }
}

async function main(): Promise<void> {
  (window as unknown as { __GTAO_SHOTS: Record<string, string> }).__GTAO_SHOTS = {};
  const runs: Run[] = [];
  // Baseline: no GTAO at all. Proves the readback path and gives the
  // unoccluded scene distribution to compare against.
  runs.push(await read('baseline/no-ao', false, 0, 1));
  // Binary proof that the depth node carries real geometry: black where
  // geometry exists, white at the far plane. If this is all white, no GTAO
  // configuration can ever occlude because every fragment discards.
  runs.push(await read('depth/depth-mask', false, 0, 1));

  // The decisive measurement with a real occluder (floor meeting a tall wall).
  // A dead effect leaves the AO target at its white clear colour; a working
  // effect drives it far below 1.0 along the wall/floor junction. `ao-stretch`
  // expands the occlusion range so the pattern is visible instead of near-white.
  for (const thickness of [1.0, 6.0]) {
    for (const radius of [0.5, 2.0, 6.0]) {
      runs.push(
        await read(
          `gtao/ao-stretch/radius=${radius}/thickness=${thickness}`,
          true,
          radius,
          0.5,
          thickness,
          32,
        ),
      );
    }
  }
  runs.push(await read('gtao/ao-only/radius=2/thickness=6/raw', true, 2.0, 0.5, 6.0, 32));
  (window as unknown as { __GTAO_RESULTS: Run[] }).__GTAO_RESULTS = runs;
  say(JSON.stringify(runs, null, 2));
  (window as unknown as { __GTAO_DONE: boolean }).__GTAO_DONE = true;
}

void main().catch((err) => {
  (window as unknown as { __GTAO_RESULTS: unknown }).__GTAO_RESULTS = [{ fatal: String(err) }];
  (window as unknown as { __GTAO_DONE: boolean }).__GTAO_DONE = true;
  say(String(err));
});
