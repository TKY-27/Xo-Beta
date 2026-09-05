/**
 * Acoustic occlusion sampling for positional sounds.
 *
 * A single world raycast (listener ear → source) decides whether a sound is
 * muffled. Results are cached on a coarse grid with a short TTL so a burst of
 * combat events clustered around the same wall costs one raycast, not one
 * per event. The type is structural: PhysicsWorld.losBlocked satisfies it.
 */
export interface OcclusionWorld {
  losBlocked(
    ox: number, oy: number, oz: number,
    tx: number, ty: number, tz: number,
  ): boolean;
}

/** Occlusion strength applied to a fully blocked path (0..1). */
const BLOCKED_OCCLUSION = 0.72;
/** Sounds closer than this to the ear never get muffled — the direct wave
 * dominates and the raycast would be wasted work. */
const MIN_OCCLUSION_DISTANCE = 3;
/** Cache grid size in metres. */
const GRID = 2;

interface CacheEntry {
  occ: number;
  until: number;
}

export class OcclusionSampler {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private world: OcclusionWorld | null,
    private ttlMs = 120,
    private cacheCap = 96,
  ) {}

  /**
   * 0 = clear path, 1 = fully blocked. `timeMs` is any monotonic clock the
   * caller owns (performance.now()).
   */
  occlusion(
    ex: number, ey: number, ez: number,
    sx: number, sy: number, sz: number,
    timeMs: number,
  ): number {
    if (!this.world) return 0;
    const dx = sx - ex, dy = sy - ey, dz = sz - ez;
    if (Math.hypot(dx, dy, dz) < MIN_OCCLUSION_DISTANCE) return 0;
    const key = `${Math.round(ex / GRID)},${Math.round(ey)},${Math.round(ez / GRID)}`
      + `|${Math.round(sx / GRID)},${Math.round(sy)},${Math.round(sz / GRID)}`;
    const cached = this.cache.get(key);
    if (cached && cached.until > timeMs) return cached.occ;
    const occ = this.world.losBlocked(ex, ey, ez, sx, sy, sz) ? BLOCKED_OCCLUSION : 0;
    if (this.cache.size >= this.cacheCap) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { occ, until: timeMs + this.ttlMs });
    return occ;
  }

  reset(): void {
    this.cache.clear();
  }
}
