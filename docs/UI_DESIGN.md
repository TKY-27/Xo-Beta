# Xo Beta — UI Design Charter

Contributor reference for front-end work. It defines the project's visual
identity, accessibility constraints and interaction conventions.

Xo Beta does not copy any commercial UI pixel-for-pixel. It extracts
principles and expresses them in its own identity: a near-future competitive
FPS with three distinct world languages (NEO CITY cyan/night, OLD FRONT warm
stone/amber, EDEN FACILITY green/aqua/white).

---

## Visual quality checklist (apply to every screen)

A screen fails review if any of these are true without a specific, stated
design reason:

1. **Dark navy everywhere** — base surfaces are near-black neutral (#0b0d10
   family), not blue-purple navy. Color is an accent tied to map identity,
   not a default wash.
2. **Arbitrary cyan/purple glow** — glow only marks *interactive or live*
   state (selected map, active objective). Decorative glow is removed.
3. **Glassmorphism on every surface** — at most one translucent layer per
   screen (usually none). Panels are solid, dark, high-contrast.
4. **Excessive blur** — backdrop blur ≤ 8px and only where legibility is
   preserved over live 3D.
5. **Giant rounded cards** — radii ≤ 10px; structural edges are cut/chamfered
   (military-FPS language), not bubbly.
6. **Uniform card grids** — no screen may be three equal cards in a row.
   Composition is asymmetric and edge-anchored.
7. **Unnecessary gradients** — gradients only for light response (sky,
   vignette), never as panel decoration.
8. **Fake futuristic borders** — no random corner brackets or HUD ticks that
   convey nothing. Every stroke marks a real boundary or state.
9. **Everything centered / floating** — content anchors to edges; the 3D
   world is the backdrop, UI frames it.
10. **Identical screen layouts** — menu, map select, settings each have a
    distinct composition while sharing one type/color system.
11. **Text-heavy dashboards** — labels are short; numbers are big; meta info
    is revealed on interaction, not printed everywhere.
12. **Decorative data with no purpose** — no fake stats, uptime chips,
    version badges, or filler microcopy.
13. **Generic Inter-like SaaS aesthetic** — display type is a condensed
    industrial face; body is a humanist sans; JA uses a matching JP family.
14. **Excessive fade/float animations** — motion is directional, 120–260ms,
    tied to enter/exit/hover/selection only. Nothing idly loops except the
    live 3D scene.
15. **UI covering the game art** — the character/map imagery is never more
    than ~35% obscured; panels hug edges.

## Positive principles (what we DO)

- **One primary action per screen.** PLAY is the loudest element in the game.
  Secondary actions are quiet, monochrome, edge-anchored.
- **Character-first lobby.** The selected combatant is the visual center,
  lit like a key-art render; navigation is a thin rail; panels never cover
  the figure.
- **Map select = world preview.** Large live-rendered imagery per map with
  name + identity tags; selection state is unmistakable; each map's accent
  color tints its own panel only.
- **Settings = fast scanning.** Left rail categories, one-column rows,
  value-first controls, current values obvious at a glance, keyboard
  navigable, instant apply, reset affordance.
- **HUD shows only what combat needs.** Health/shield, ammo, weapon,
  inventory, minimap, alive count at rest; everything else contextual.
- **Typography carries hierarchy.** Condensed uppercase display with tight
  tracking for headers and big numerals; letter-spaced small labels for meta;
  weight contrast instead of color noise.
- **Motion has purpose.** Screens slide along one axis; selection states snap
  with 120ms ease-out; the lobby camera breathes but UI does not float.
- **EN/JA parity.** Japanese is not an afterthought: line-length, wrapping,
  and button sizing are checked in both languages; no orphaned Latin glyphs
  in JA text; numerals stay tabular in both.

## Type system (self-hosted, redistributable licenses)

- Display/headers/numbers: **Saira Condensed** (SIL OFL 1.1) — industrial,
  tabular-friendly numerals, strong in uppercase.
- Body/UI: **Inter Tight** (SIL OFL 1.1) — neutral, compact, excellent at
  small sizes (chosen deliberately for legibility, not by default).
- Japanese: **Noto Sans JP** (SIL OFL 1.1) — weights 400/500/700; pairs with
  Inter Tight for Latin-in-JA and with Saira for display JA fallback.
- Numerals in HUD/stats use `font-variant-numeric: tabular-nums`.
