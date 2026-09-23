/**
 * Dedicated first-person stage. The viewmodel renders in its own scene
 * through its own camera, composed over the world pass before bloom —
 * the way shipped FPS games present a weapon: a fixed view-space camera
 * (constant FOV, 1 cm near plane) and a lighting rig synced every frame to
 * the world's sun/ambient/hemisphere so the weapon responds to the
 * environment (shade darkens it, desert warms it, night cools it) without
 * inheriting the world camera's FOV distortion, near-plane clipping or fog.
 *
 * The stage camera sits at the origin looking down -Z: pose space is view
 * space by construction, so no per-frame camera transform is needed. The
 * world sun direction is transformed into view space each frame from the
 * live camera quaternion, which keeps the weapon's key light on the same
 * side as the world's.
 */
import * as THREE from 'three';

export interface WorldLightingSnapshot {
  sunColor: THREE.Color;
  sunIntensity: number;
  /** Normalized direction TOWARD the sun, world space. */
  sunDirection: THREE.Vector3;
  hemiSkyColor: THREE.Color;
  hemiGroundColor: THREE.Color;
  hemiIntensity: number;
  ambientColor: THREE.Color;
  ambientIntensity: number;
  environment: THREE.Texture | null;
  environmentIntensity: number;
}

const _viewSunDir = new THREE.Vector3();
const _invQuat = new THREE.Quaternion();

export class ViewModelStage {
  readonly scene = new THREE.Scene();
  /** Fixed view-space camera. FOV stays constant across ADS/sprint so the
   * weapon keeps its authored framing while the world camera zooms. */
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.01, 12);
  readonly sun: THREE.DirectionalLight;
  readonly fill: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly sunTarget = new THREE.Object3D();
  /** Scratch colors: the snapshot colors are shared references — copy before
   * assigning so per-stage modulation never leaks back into the world rig. */
  private readonly sunColorScratch = new THREE.Color();
  private readonly hemiSkyScratch = new THREE.Color();
  private readonly hemiGroundScratch = new THREE.Color();
  private readonly ambientScratch = new THREE.Color();

  constructor() {
    this.scene.background = null;
    this.scene.fog = null;

    // Weapon key light, synced to the world sun (direction + color). A tight
    // shadow frustum around the origin gives the hands and gun real
    // self-shadowing (fingers on the grip, sight occlusion) at trivial cost.
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const cam = this.sun.shadow.camera;
    cam.left = -0.85;
    cam.right = 0.85;
    cam.top = 0.85;
    cam.bottom = -0.85;
    cam.near = 0.1;
    cam.far = 12;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.004;
    this.sun.position.set(1, 3, 2);
    this.sun.target = this.sunTarget;
    this.scene.add(this.sun, this.sunTarget);

    // Sky/ground bounce, synced to the world hemisphere light.
    this.hemi = new THREE.HemisphereLight(0xbfd4e8, 0x44483e, 0.8);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.2);
    this.scene.add(this.ambient);

    // Camera-relative fill from upper-left behind the weapon: keeps the
    // camera-facing side of the receiver readable when the sun is behind it,
    // and lifts the gloves out of charcoal under overcast skies (OldFront)
    // where the world's own fill is weakest.
    this.fill = new THREE.DirectionalLight(0xdde8f4, 0.8);
    this.fill.position.set(-0.6, 0.5, 1.2);
    this.scene.add(this.fill);
  }

  /** Re-derive the lighting rig from the world's live lights. Called once
   * per rendered frame before the viewmodel update. */
  syncLighting(quaternion: THREE.Quaternion, world: WorldLightingSnapshot): void {
    // World sun direction → view space (the stage camera IS the view).
    _invQuat.copy(quaternion).invert();
    _viewSunDir.copy(world.sunDirection).applyQuaternion(_invQuat).normalize();
    this.sun.position.copy(_viewSunDir).multiplyScalar(6);
    this.sunColorScratch.copy(world.sunColor);
    this.sun.color.copy(this.sunColorScratch);
    // Keep the key at world intensity: the weapon albedos are already tuned
    // dark, and multiplying the sun washed the sleeves out to chalk under
    // the day maps' high sun.
    this.sun.intensity = world.sunIntensity;

    this.hemiSkyScratch.copy(world.hemiSkyColor);
    this.hemiGroundScratch.copy(world.hemiGroundColor);
    this.hemi.color.copy(this.hemiSkyScratch);
    this.hemi.groundColor.copy(this.hemiGroundScratch);
    this.hemi.intensity = world.hemiIntensity;

    this.ambientScratch.copy(world.ambientColor);
    this.ambient.color.copy(this.ambientScratch);
    this.ambient.intensity = world.ambientIntensity;

    if (this.scene.environment !== world.environment) {
      this.scene.environment = world.environment;
    }
    this.scene.environmentIntensity = world.environmentIntensity;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
