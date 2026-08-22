# Bot AI

Nine autonomous bots fight for the same victory as the human — looting,
healing, rotating, ambushing, third-partying — under strictly fair
information rules.

## The fairness contract (non-negotiable)

Bots may only act on information their perception system could plausibly have:

- **Vision**: 100° cone, ~88u effective range, line-of-sight raycasts,
  exposure modifiers (crouched/still targets harder to spot), distance falloff.
  Early game (~first 75–90s) vision is deliberately reduced so the opening is
  about looting, not long-range sniping.
- **Hearing**: gameplay events only — shots (160u), footsteps (~34u), chest
  opens, glass breaks. Positions carry distance-scaled error.
- **Memory**: last-known positions with confidence decay (vision ≈7s half-life,
  sounds ≈4s). Aiming at a target you can't see is impossible; hunting stale
  trails has a patience budget.
- **No wallhacks, no omniscient inventory knowledge, no guaranteed hits,
  no teleporting.** Bots use the identical movement state machine, weapon
  timers, recoil, spread and projectile simulation as the player.

## Architecture

```
world events ─► Perception (vision/hearing) ─► Memory (decaying beliefs)
                                                      │
                                    Utility brain ◄───┘
                    (combat/loot/heal/rotate/third-party/
                     ambush/search/wander — rescored on cadence)
                                          │
              BotNavigator (A* + traversal edges) ──► InputCommand
                                          │
              BotCombat (aim model) ──────┘
```

### Utility scoring highlights

- Storm urgency overrides almost everything once outside or far from safety;
  healing never channels inside the storm.
- Loot need scales with missing weapons/ammo/heals; unreachable loot gets
  blacklisted with timeouts; full-inventory swap churn is prevented by storage
  pre-checks.
- Third-party evaluation weighs distance, recency of gunfire and personality;
  it unlocks after the early game.
- After fights, bots relocate away from hot zones rather than camping bodies.

### Combat execution (fair aim model)

- **Reaction delay** before first shot on acquire (~0.17–0.55s by difficulty).
- **Tracking-limited aim** rotating at bounded rad/s toward a predicted point:
  projectile time-of-flight lead plus gravity compensation per weapon class.
- **Gaussian aim error** scaled by difficulty, distance and skill; re-sampled
  at human-like intervals (~0.25s) producing wobble rather than jitter.
- **Burst discipline** for automatics; fire only when angular error is small
  and LOS is genuinely clear this tick.
- Movement during fights: strafe cycles, preferred-range management, crouch
  peeks, occasional dash/grapple gated by moveSkill.

## Roster & personalities

| Bot | Role | Notes |
| --- | --- | --- |
| **VEX** | Precision / sniper / AR | Elite benchmark: maximum reasoning always |
| **RAZOR** | Close-range aggro | Elite benchmark: shotgun/SMG gap closing |
| **ORBIT** | Tactical planner | Elite benchmark: zone play + third-party timing |
| NOVA | Balanced | |
| GHOST | Stealth ambush | Crouch-patrols near threats |
| KIRA | Aggressive hunter | Short preferred range, high chase drive |
| HEX | Opportunist | Highest loot greed + third-party appetite |
| AXIS | Defensive high-ground | Long preferred range, disciplined rotations |
| ZERO | Survival positioning | Most cautious, strong rotation discipline |

The elite trio ignores difficulty scaling (they are the benchmark); other bots
scale reaction/error/tracking/movement-skill across Normal → Nightmare.
Difficulty never multiplies damage.

## Navigation

Bots path over a generated multi-level nav graph (`src/world/nav.ts`) whose
edges encode traversal types (walk/jump/mantle/drop/swim). Waypoint steering
feeds the shared movement system; jump/mantle edges translate into real input
presses. Stuck detection triggers hop/dash unstick attempts and repaths.
Drop-phase steering manages glide ratio to land precisely at chosen POIs.

## Match-local adaptation

Within a match, bots track observed engagement distances and aggression from
opponents they perceive and blend those into target-selection preferences.
No cross-session profiling exists.

## Validating AI changes

```bash
npm run sim -- map=neocity seed=42 difficulty=hard count=3
```

Check aggregate duration (13–18 min), eliminations (~9), storm deaths, chest
opens and win spread. Personalities intentionally differ in win rates — don't
optimize toward uniform wins. Deterministic seeds make comparisons exact.
