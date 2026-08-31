# Host authority model

Xo Beta private rooms are friends-only, invited, direct P2P matches. The host
browser owns the authoritative simulation because there is no dedicated game
server. Guests are mutually untrusted and may request actions, but they cannot
assert outcomes.

| State category | Deciding side | Guest permission |
| --- | --- | --- |
| Local keyboard/gamepad/mouse input | Guest locally | Submit an input request only |
| Permitted lobby profile | Guest, subject to host validation | Change own display name, skin, or Ready state before lock |
| Arena, mode, Bot fill, difficulty, team assignment | Host | Request lobby changes only where the host exposes them |
| Match start and countdown | Host | Acknowledge preparation/readiness or report load failure |
| Movement outcome and physics | Host | Send bounded input; local prediction is cosmetic |
| Bot commands and Bot perception result | Host | No Bot control |
| Projectiles and projectile lifetime | Host | Request fire/reload/use actions through input |
| Hit resolution, damage, health, shield, and healing | Host | No state claim |
| Inventory, ammo, pickups, chests, and item placement | Host | No state claim |
| Glass and other destructibles | Host | No state claim |
| Storm phase and damage | Host | No state claim |
| Elimination, spectating target, and alive state | Host | No state claim |
| Team winner, placement, and results | Host | No state claim |
| Tactical ping | Host after validating a guest request | Request a bounded location ping |
| Protocol acknowledgments | Each endpoint for its own authenticated channel | Acknowledge packets only |
| Rendering, audio, camera, and local prediction | Each browser locally | Presentation cannot change match state |

The host accepts only the authenticated participant's input channel and maps it
to the Actor bound in the locked roster. Guest messages carrying position,
physics, Bot, projectile, hit, damage, health, inventory, pickup, glass, storm,
elimination, winner, or results fields are not part of the protocol and are
rejected. Authoritative snapshots and events flow from the host and are checked
for session, sequence, revision, entity, and event identity before a guest
applies them.

The host is trusted for the intended friends-only fairness model, but the host
can theoretically cheat: it can sign false state, exclude a guest, or end the
room. There is no server-side mechanism to prevent that. This limitation is
intentional and is not acceptable as a basis for public matchmaking.

Public Nostr relays and STUN services provide untrusted discovery and address
discovery only. They do not decide lobby or gameplay state, store a multiplayer
database, or provide a paid relay path.
