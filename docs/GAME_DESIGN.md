# Game Design Notes

## Identity

> Near-future stylized-realism battle royale for the desktop browser.
> Readable silhouettes, honest ballistics, movement as skill expression.

Xo Beta borrows *feel* targets from great shooters (Apex pacing, Titanfall
movement ceiling, CS precision) but implements its own systems, maps,
characters, art and audio from scratch.

## Match structure (10 combatants, 1 human + 9 bots)

1. **Transport flyover** — a dropship crosses the map on a randomized route.
   Bots pick landing POIs using loot potential, distance from others'
   claimed drops, route geometry and personality risk tolerance; they jump at
   their closest approach. The player jumps freely with `Space`.
2. **Freefall & glide** — dive to fall faster, deploy into a glide below
   ~55u altitude (or manually). Glide ratio is manageable: flatten to extend,
   dive to land on target.
3. **Looting phase** (~90s of reduced bot vision keeps it about gearing up)
   — floor loot, chests, first weapon priorities.
4. **Mid game** — storm circle 1–3 force rotations; bots patrol locally,
   third-party distant fights after phase 1, disengage when hurt.
5. **Endgame** — circles compress aggressively (final radius < 1u), music
   shifts to the "final" state, remaining bots converge and resolve.

Target match length: **13–18 minutes**. Headless simulations report actual
duration so pacing changes can be evaluated against this design target.

## Movement kit

| Move | Notes |
| --- | --- |
| Sprint | unlimited, no stamina |
| Slide | entry boost from sprint speed, slide-jump preserves momentum |
| Double jump | second jump refreshes air control |
| Dash | 2 ground charges / effectively 1 in air; 3s regen while grounded |
| Wall run | requires speed + vertical wall; reduced gravity, camera tilt |
| Wall jump | pushes off wall preserving tangential momentum |
| Mantle | ledges up to 2.7u; validated clearance, no teleports through walls |
| Grapple | any static surface ≤72u; swing physics, 6s cooldown; bots use it |
| Ground pound | windup → fast fall → AoE damage + knockback + shockwave |
| Bunny hop | landing-jump window preserves momentum with a soft cap |
| Swim/dive | full water gameplay on EDEN: buoyancy, drag, shore mantles |

## Combat rules (identical for humans & bots)

- Real projectiles: velocity, gravity drop, substepped CCD raycasts.
- Regions: head ×2.0, chest ×1.0, abdomen ×0.9, arms ×0.75, legs ×0.7
  (weapons may override).
- Shield absorbs before health; 100+100 effective pool.
- Bloom/recoil/spread respond to stance, ADS and movement.
- Shotgun simulates 10 pellets; sniper ricochets once off shallow angles;
  glass penetrates (and shatters).
- Healing channels (Med Kit 5s/+75hp, Shield Cell 3s/+50sh) slow you to 25%
  and interrupt on damage or actions.

## Loot economy

Five rarity tiers (common→legendary) improve damage plus handling stats
(reload, spread, recoil, ADS, projectile speed) without changing each class's
identity. Floor weights start at 40/28/18/10/4. Chest tiers:

- **Standard** — common/uncommon/rare
- **Elite** — rare/epic
- **Vault** — epic/legendary (rare, memorable placement)

Ammo does not consume inventory slots (light/medium/shells/heavy pools).
Five universal slots hold anything: five weapons, five heal stacks, mixes.

## Eliminations

No blood or gore. Defeated combatants play a defeat pose, dissolve upward in
their signature color (energy wisps), and drop their inventory as floating,
bobbing, rarity-glowing world items.

## Storm design

Eight phases tuned for the ~500×500 map and 10-combatant lobby: long early
loot windows, mid-game pressure that creates encounters, late-game circles
that remove camping space entirely (final radius 0.5u, dps 12). Circle
centers randomize within the previous circle so rotations stay interesting.
