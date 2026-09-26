# XO3 — Build recipe and source-member notes

How this structure is put together, member by member. The companion file `MEMBERS.txt`
is the machine-readable inventory: 642 rows, one per authored member, with its material
key, name, vertex count, face count and z-range, in build order. This document explains
what those members are and *why* they are shaped the way they are.

Read this alongside `README.md` (what it is, honest weaknesses) and `PROVENANCE.md`
(input licences).

---

## 0. Generators

Everything in the asset is built by nine hand-written generators in `src/shop_lib.py`.
There is no sculpting, no remesh, no boolean, and no imported geometry except the donor
lantern.

| Generator | What it does | Why it exists |
|---|---|---|
| `prism(name, bottom, top, ...)` | Solid from a matching 2-ring of bottom/top points | Anything with an arbitrary footprint: courtyard ground, boundary walls, yard slab, gutter. Also the roof decks, where the top ring is raised per-vertex to camber the roof. |
| `hexa(name, lo, hi, ...)` | Axis-aligned box from bounds | Stone sills, copings, counter slab, trays. The primitive that gets disguised. |
| `boxc(name, centre, size, ..., yaw, tilt, roll)` | Box with an arbitrary centre and rotation | Door leaves standing open, propped shutters, tilted boards, roof clutter. |
| `beam(name, p0, p1, width, thick, ..., up, roll)` | A rectangular section swept from p0 to p1 | **All 276 timber members.** Framing, rafters, slats, battens, rails, ladder rungs, corbels. Giving every piece of timber a `p0`/`p1` pair is why the carpentry reads as carpentry and not as a pile of cubes. |
| `batter(name, footprint, height, taper, ...)` | 6-sided lofted solid whose section shrinks with height | The adobe envelope. Real mud-brick walls lean; a vertical extrusion of a rectangle is the single most obvious tell of a blockout, so every free-standing adobe mass is battered. |
| `wall(name, u0,u1, v0,v1, y0,y1, openings, mat, ...)` | Wall panel on a global (u,v) cut grid, with a 4-sided reveal built into every opening | The core trick. Openings are cut by grid subdivision rather than by boolean subtraction, so there are no n-gons, no coplanar-artifact shading, and every opening comes with a real reveal at full wall thickness. Blind recesses additionally get a closing back plate. |
| `splay(name, outer, inner, y0, y1, ...)` | Four wedge solids that close the corners between two rectangles | How the reveals are finished. `wall()` cuts a hole of the *inner* size, then `splay()` extrudes the four edges of the outer rectangle onto the four edges of the inner one. Window: outer *smaller* than inner (flared, like a real plastered reveal). Niche: outer *larger* than inner (tapering). The 500 mm door recess is the limiting case — outer == inner, so no splay is needed. |
| `lathe(name, profile, ..., segs, scallop, oval, ...)` | Surface of revolution, optionally scalloped and ovalised | Every ceramic and every piece of produce. `scallop` adds throwing rings; `oval` squashes one axis by 1.6% so nothing is a perfect solid of revolution. |
| `tube(name, path, radius, ..., caps, radii)` | Swept circle along a polyline with per-point radius | Rope lashings, hose, chains, hanging chillies and onions, roof cords. |
| `skin(name, nu, nv, fn, ..., thick)` | Parametric grid surface, Solidify'd | The two cloth pieces and the flour sack. The displacement is in `fn`, so the cloth sags between its attachment points instead of hanging as a flat sheet. |
| `grid_block(name, lo, hi, steps, ..., jitter, seed)` | Axis-aligned solid subdivided with per-vertex jitter | The earth floor under the counter and the yard slab. Flat boxes next to jittered ground read as a mistake; jitter costs 12 faces. |

Two post-processors: `merge(name, members, mat, ...)` welds coincident vertices within
0.1 mm and discards per-member material slots, producing one mesh per material;
`finish(ob, bevel, segs, angle, smooth)` applies the bevel/auto-smooth.

---

## 1. Shell — 4 walls, 1 divider, 2 floors, 1 threshold

`build_shell()`. Wall thickness `T = 0.78` (the outer half of the front wall spans
y -1.95..-1.17, the inner half -1.17..1.17 — the front wall is 1.56 m thick, which is
what makes the 0.50 m door recess read as built-in rather than as a stuck-on box).

- `Plaster | front_west_bay`, `front_east_bay` — the two front masses, 178 verts / 150
  faces each. `wall()` with `RECESS` and `DOOR` as openings, so the 0.50 m recess and the
  1.06 x 2.06 m through-door are genuine voids with reveals, and the threshold is a real
  step in the floor.
- `Mudbrick | rear_west_bay`, `rear_east_bay` — the rear, with `RW_WIN` and `RW_DOOR` cut
  through, plus `RW_VENT` high up. Rear is mudbrick where the front is plastered: the
  plastered face is the street face.
- `Mudbrick | end_west`, `end_east` — battered end walls. `end_east` is shorter (2.82 m)
  to match bay B's lower eaves.
- `Mudbrick | bay_divider` — 300 mm, firebreak between shop and stall. Deliberately
  thinner than the envelope and stopping at bay B's eaves height, so it reads as a
  secondary internal wall.
- `Mudbrick | buttress_west` (5 courses, 0.42 m out, 0.10 m per course batter) — there
  because a 6 m span of 780 mm adobe wants one, and because the west elevation would
  otherwise be a blank slab.
- `Earth | floor_shop`, `floor_stall` — grid_block, jittered, so the interior floor is
  visibly trampled earth rather than a plane.
- `Stone | threshold` — a dressed sill across the door, raised 60 mm.

## 2. Entrance — 24 members

`build_entrance()`. The deepest reveal in the asset, so it gets the most dressing.

- `Plaster | pilaster_{l,r}` — battered returns either side of the recess.
- `Stone | recess_jamb_{l,r}`, `recess_soffit`, `recess_step` — the recess lining. The
  soffit is what stops the recess reading as a painted rectangle.
- `Timber | door_jamb_{l,r}`, `door_lintel` — the frame inside the 0.78 m reveal.
- `Timber | door_leaf_{0..4}` — five vertical planks with 6 mm shadow gaps, parented
  into a `boxc` at 58° with a yaw about the hinge axis, so the door stands open. The
  planks are separate members specifically so the shadow gaps survive the weld.
- `Timber | door_brace`, `door_ring` — the diagonal brace and a forged ring pull.
- `Iron | door_hinge_{0,1}` — strap hinges.
- `Timber | hood_rafter_{l,r}`, `hood_slat_{0..5}` — the little 6-slat hood over the door.
- `Cloth | hood_cloth` — a 26x8 sagging skin over the hood.

## 3. Window — 22 members

`build_window()`. The aperture is `WIN_A = (-3.20,-2.66,1.04,1.88)` on the outside and
`WIN_A_IN = (-3.34,-2.52,0.90,2.02)` on the inside, so `splay()` builds four closing
wedges over 380 mm of depth. The window therefore flares — wide inside, narrow outside —
which is how a plastered opening over a thick wall actually gets finished.

- `Stone | win_sill`, `win_head` — dressed stone sill projecting 40 mm, and the head.
- `Timber | win_reveal_{l,r,t,b}` — a 7-board lining, in a window recess you would
  absolutely line it.
- `Timber | win_shutter_{0..3}` — four boards, open 104° about the outer jamb.
- `Timber | win_shutter_rail_{0,1}`, `win_shutter_brace` — a stile-and-rail shutter, not
  a single board.
- `Iron | win_shutter_strap_{0,1}`, `win_hook` — strap hinges and a latch hook.
- `Timber | win_shelf_{0,1}`, `Clay | win_jar_{0,1}` — a shelf inside with jars on it.

## 4. Niche — 11 members

`build_niche()`. 300 x 760 mm, 380 mm deep, splayed the *opposite* way from the window
(`NICHE` outer, `NICHE_IN` inner is smaller), so it tapers inward like a pigeonhole
rather than flaring. Deliberately a different read from the window in the same wall —
two identical openings in one facade is the blockout signature.

`Timber | niche_shelf_{0,1}`, `niche_top`, `niche_lintel`, `niche_cheek_{l,r}`;
`Iron | niche_peg_{0,1}`; `Clay | niche_jar_{0,1}`.

## 5. Stall, counter and hatch — 47 members

`build_stall()`. The busiest bay and the one shot 01 tests at 1.4 m.

- `Mudbrick | stall_hatch_head` / `stall_counter_pier` — the plastered mass the counter
  is built into, with `HATCH` cut through.
- `Timber | hatch_frame_{l,r,t,b}` — a lining frame around the serving hatch.
- `Timber | counter_apron_{0,1}` + `apron_batten_{0,1,2}` + `Stone | counter_plinth` —
  the apron below the slab, battens and a stone plinth course, because a 2.7 x 0.9 m
  blank panel under a counter is the most conspicuous unmodulated surface in the build.
- `Stone | counter_slab_w`, `counter_slab_e` — the dressed counter, split in two so a
  scupper notch can be cut between them for draining wash water.
- `Timber | counter_bracket_{0,1}` — corbels under the slab overhang.
- `Timber | stall_shutter_{0,1}` + `stall_shutter_rail_{0,1}` + `stall_shutter_stile_{0,1}`
  + `stall_shutter_brace` — the 1.14 m shutter propped open above the hatch. The brace
  runs corner to corner with `up=(0,1,0)` and `roll=ang` to sit in the shutter plane.
- `Timber | stall_head_beam`, `stall_spur_{0..3}` — the head beam and its struts.
- `Iron | stall_ring_{0,1}`, `stall_prop` — ring pulls and the prop.
- `Timber | sign_batten`, `sign_board`, `sign_price_{0,1}` + `Iron | sign_chain_{0,1}` —
  the price board hung on chain off the awning ledger.

## 6. Awning — 63 members

`build_awning()`. Ledger fixed into the facade at 2.55 m, outer rail at y -3.14 / z 2.12.
That 1.21 m projection at 0.43 m of fall reads as an awning; the first pass used a
1.53 m projection and read as a veranda, which is why it was pulled in.

- `Timber | awn_ledger` — built into the wall (`y YF-0.16 .. YF+0.02` so it is *not*
  buried inside the 780 mm wall; the first version was entirely inside the wall and
  invisible).
- `Timber | awn_rafter_{0..2}_{l,r}` — three pairs, the outer two ending at the posts.
- `Timber | awn_purlin_{0,1}` — two spanwise purlins.
- `Timber | awn_outer_rail`, `awn_rail_kicker_{0,1}`.
- `Timber | awn_slat_{0..21}_{0,1}` — 22 slats per span, each a `beam()` with a 15 mm
  droop toward mid-span, and each span starting at a different x so the joint staggers
  (seam `+0.53*j`). 42% open in plan, so from below you see slat-slat-shadow, which is
  the whole point of a slatted awning.
- `Timber | awn_post_{w,e}` at 116 mm square, `Stone | awn_footing_{w,e}` at 340 mm,
  `Timber | awn_knee_{w,e}`.
- `Iron | awn_tierod_{0,1}`, `awn_bolt_{0,1}`.
- `Timber | awn_drip_strip`.
- `Rope | awn_lashing_{0,1,2}`.
- `Cloth | awn_cloth` — 40x20 skin over the eastern two bays, displaced by
  `0.105 * sin(pi*local)**0.72 * (0.28+0.72*fy)` plus a down-slope crease and a wind lift
  `0.055*fy**3`. The exponent is what stops it reading as a rigid board; the first
  version sagged uniformly and read as sheet steel.

## 7. Roof, parapet, corbels, loft — 58 members

`build_roof()`. Eaves 3.05 m (bay A) and 2.82 m (bay B), so the front parapet line steps.

- `Earth | roof_deck_a`, `roof_deck_b` — `prism()` with a raised top ring, giving a
  60 mm camber. Screed, not brick: a brick-laid roof deck read as dark planking from
  the air in an earlier pass and was wrong anyway.
- `Mudbrick | parapet_a`, `merlon_{0..4}` — plain parapet plus coping on bay A, crenellated
  merlons on bay B. The variation is the reason you can tell the two bays apart at
  silhouette level.
- `Stone | cope_a`, `cope_b`.
- `Timber | corbel_{0..8}` — nine eaves corbels, all `beam()`s at slightly different
  projections.
- `Timber | fascia_a`, `fascia_b`.
- `Mudbrick | roof_hatch_frame`, `Timber | roof_hatch_cover` (33° propped open),
  `Iron | roof_hatch_stay`.
- `Mudbrick | loft_body` + `Timber | loft_ledge`, `loft_perch`, `Clay | loft_hole_sleeve`
  (12-segment tube), `Clay | loft_hole_void`. A solid wedge with a real sleeved hole.
- `Clay | roof_jar_{a,b}`, `roof_bucket`, `Timber | roof_timber_{0,1}`.

## 8. Boundary — 12 members

`build_boundary()`. The row is closed on all four sides; an open-ended blockout never is.

- `Plaster | boundary_front_w`, `boundary_front_e` — 0.60 m returns off the front facade
  at each end, plus `Stone | boundary_cope_{w,e}` and a `Stone | boundary_drip_{w,e}`
  course. These give the front elevation its corners and stop it reading as a flat
  elevation of a box.
- `Mudbrick | boundary_rear_w`, `boundary_rear_e` + `Stone | boundary_rear_cope_{w,e}`.
  These sit at y 2.63..2.99, *outside* the 1.8 m service yard, not inside it.
- `Mudbrick | gate_post_{0,1}`, `Timber | gate_head` — the east gate.
- `Ground | apron_*` (4 members), `Stone | drain_channel`, `Iron | drain_grate` — the
  ground is split around the 0.40 m channel drain rather than running a slab through it.
  Everything at ground level has a z-min of -0.30 so the apron is a 300 mm thick solid,
  not a floating 55 mm shelf.

## 9. Utilities — 34 members

`build_utilities()`. The reason the service elevation is not a blank wall.

- `Clay | downspout` at r = 76 mm, flush against the east face, running from
  `DECK_B + 0.28` down to a `Clay | downspout_hopper` at `DECK_B + 0.20..0.52`, with
  `Iron | downspout_strap_{0,1,2}` and a `Stone | soak_box`. The first pass had a 58 mm
  pipe floating 400 mm off the wall with stripes across it.
- `Iron | vent_grille` — a rear high vent, 6 bars.
- `Iron | utility_box` with a `Timber | utility_bracket`, and `Iron | bib_tap` +
  `Rope | hose_coil` (46-point tube).
- `Iron | yard_tap`, `Clay | water_butt` (staved: 9 staves, 2 hoops, a lid), a lid
  board, and `Timber | butt_brace_{0,1}`.
- `Iron | rw_window_grille` — 6 bars over the rear window.
- `Timber | lean_post_{0,1}`, `lean_rafter_{0..5}`, `lean_slat_{0..6}` — the rear-yard
  lean-to, 7 boards sitting 52..104 mm *above* the rafters so they are visible from the
  yard (the first pass had them 12 mm below, where the rafters hid them).
- `Timber | ladder_side_{0,1}`, `ladder_rung_{0..5}`, `Iron | ladder_hook_{0,1}`.
- `Timber | log_{0..11}` — a west-side firewood stack.

## 10. Lantern — 5 members

`build_lantern()` brackets a single donor brass lantern under the awning at the
shop/stall boundary: `Iron | lantern_stay`, `lantern_bracket`, `lantern_hook`,
`lantern_scroll` (a bent-tube shepherd's crook), and `Timber | lantern_board` behind
it so the pierced brass filigree has something to read against. The lantern body itself
is the imported donor mesh.

## 11. Dressing — 176 members

`shop_dressing.py`, in three passes. `interiors()` (46), `counter_dressing()` (52),
`exterior_dressing()` (78).

Nine lathe profiles: `JAR_TALL`, `JAR_ROUND`, `JAR_AMPHORA`, `JAR_SQUAT`, `BOWL`,
`DISH`, plus a water butt, a basket, a churn, a strainer. Every jar is 24 segments with
0.9 mm seam rings and 1.6% oval distortion.

- **Shop:** a plank bench, a 3-tier jar rack, a flour sack (`skin()`, so it slumps), hung
  pot, 6 hanging chilli strings, 4 onion braids, a pan, a strainer.
- **Stall:** a `wall()`-built hearth with a blind firebox, a stone top, two grates over
  `Flame | hearth_embers` (emission 9.0), 3 logs, a 3-tier shelf, a prep table with
  bowls, a rolling pin, a knife block.
- **Rear storage:** a 0.8 m door ajar 22° on `Iron | rw_door_hinge_{0,1}` with a padlock
  and ledges, behind it crates and jars.
- **Counter:** a bread tray with 4 lathed flatbreads, a bowl stack, 2 crates, a woven
  basket with 11 produce pieces, a churn, a ladle, a herb bundle.
- **Exterior:** entry jars and bowls, a stone step, swept sand at the drain, an east
  plinth with jars and a crate, firewood, 2 cloth rugs, a price board, a bell.

`import_lantern(x, y, z, scale=0.135)` glTF-imports `donor/brass_diya_lantern_1k.glb`,
reparents it under a `donor_brass_diya_lantern` empty, renames every object and material
with a `donor_` prefix, decimates body and chain at 0.22 and the link at 0.40, joins the
three meshes, remaps the duplicated `brass_diya_lantern_diff_1k.001` image back onto the
base name, and deletes loose geometry. It returns False on any failure, in which case
the build continues with no lantern rather than crashing.

---

## 12. Build order, and why

1. `prep_textures.py` — 23 PNGs. Must run first; everything else loads from `textures/`.
2. `build_shop_row.py`:
   shell -> entrance -> window -> niche -> stall -> awning -> roof -> boundary ->
   utilities -> lantern -> dressing, then per-key `finish()` (bevel + auto-smooth) ->
   per-key `merge()` -> `weld(1e-5)` -> one `auto_smooth(32°)` on each merged object ->
   parent all to an `XO_ShopRow` empty -> save blend -> export GLB -> print `STATS`.
3. `build_collision.py` — 12 boxes from a literal `BOXES` table, then `verify()` re-opens
   the model blend and asserts every box's vertices land inside real geometry.
4. `render_shop.py`, `diag.py` — both take the blend on the command line.

Two non-obvious decisions, both forced by observed failure:

- **Bevel per member, not per merged object.** Bevel's solver is not reproducible on a
  27k-vertex merged mesh. Run whole-mesh, a bevel was silently rejected on roughly 40% of
  runs — with a `# rejected` line in the log — and the face count changed between runs
  (Plaster 474 on one run, 250 on the next). Escalating the half-width and re-selecting
  before every weld pass did not help. Beveling the ~400 authored members individually,
  then welding, then auto-smoothing once, made the build deterministic.
- **The splay wedges are emitted in world space with an identity object transform.** The
  first version built world-space vertices *and* left a rotation on the object, so the
  rotation was applied twice and the plaster reached z = -3.2 m. The axis==1 branch also
  had x and z in swapped slots.
