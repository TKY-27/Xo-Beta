# Networking

## Online networking scope

Phase 3 introduced private-room discovery, a synchronized host-authoritative
lobby, and direct game-connection establishment. Phase 4 adds the production
online match path: one host-owned authoritative `Match`, validated guest input,
binary snapshots/events, client prediction and interpolation, and bounded
disconnect/reconnect handling. Guests render `ClientReplica`; they never run a
second authoritative full simulation.

The network has two layers:

1. **Trystero/Nostr control layer.** Encrypted discovery, admission, lobby
   commands/state, Ready state, ping sampling, dedicated-connection signaling,
   and reconnect negotiation.
2. **Dedicated game layer.** One browser-native `RTCPeerConnection` from the
   host to each guest. Guests never establish authoritative game connections
   with other guests.

The topology is therefore host↔guest 1, host↔guest 2, and host↔guest 3. There
is no dedicated game server, server-side room database, public matchmaking
list, TURN service, SFU, Worker, or Pages Function.

## Signaling dependency

- Package: `trystero@0.25.4` (exactly pinned)
- License: MIT
- Import: `trystero/nostr`
- Transitive Nostr signer: `@noble/secp256k1@3.1.0`, MIT
- Accounts, telemetry, provider keys: none used by Xo Beta

Trystero is used only for discovery, admission, synchronized lobby/control
messages, and offer/answer/ICE signaling. It is not used for high-frequency
gameplay because its action layer provides serialization, chunking, and
reliable delivery that are useful for control but inappropriate for input and
state snapshots. Those messages use the dedicated DataChannels below.

Trystero's package defaults include Cloudflare STUN and allow an optional
`turnConfig`. Xo Beta does not inherit those defaults: every Trystero room is
created with an explicit `rtcConfig.iceServers` STUN-only list and no
`turnConfig` property.

## Private discovery

The app supplies an explicit list of public, unauthenticated Nostr relay URLs
rather than relying on a public room list. The selected relays are public
endpoints from Trystero 0.25.4's reviewed Nostr defaults. They require no Xo Beta
account, API key, payment method, or billing agreement. If a relay later
requires authentication or payment, it simply fails health checks; the app
does not enroll or fall back to a paid service.

The discovery topic is derived from a random invite secret. The signaling
password is independently derived and encrypts session descriptions before
they are published to Nostr. Room names are never searchable because no human
room name is published. Trystero uses a derived Nostr kind in the ephemeral
20,000–29,999 range and subscribes from the current time. The host's
announcement ends when the host leaves or closes the page, so no durable room
record is owned by Xo Beta.

Relay sockets are reported as connecting, open, closed, or failed. Xo Beta sets
Trystero's `manualReconnection` option, holds its global reconnect gate, and
permits at most three reconnect releases with fixed bounded delays. This
overrides the package's automatic socket loop. Initial discovery also has a
fixed timeout. Exhaustion is a visible discovery failure, not a server fallback.

## Dedicated game connection

The host creates these channels for every guest:

| Channel | Ordering | Retransmission | Use |
| --- | --- | --- | --- |
| `control` | ordered | reliable | lifecycle, handshake, keyframes/recovery |
| `event` | ordered | reliable | authoritative discrete events |
| `input` | unordered | `maxRetransmits: 0` | input commands |
| `snapshot` | unordered | `maxRetransmits: 0` | high-frequency state snapshots |

Every channel uses `binaryType = "arraybuffer"`, an explicit
`bufferedAmountLowThreshold`, and a maximum buffered amount. No channel owns an
unbounded application queue. Congested snapshots are dropped rather than
delivered after they are obsolete. The input path is also lossy by design;
reliable control/event sends fail closed when their buffer ceiling is reached.

Offer, answer, and non-relay ICE candidates travel through a bounded Trystero
action. A relay ICE candidate is rejected at receipt and a selected relay
candidate pair is treated as a connection failure. Connection establishment has
one timeout, one ICE-restart attempt, and a final timeout. There is no endless
retry loop.

## Lobby authority and match transition

The creator is permanently the host. A P-256 ephemeral signing key commits the
host identity into the invite, and guests accept canonical lobby snapshots
only when that host verifies. No guest election occurs when the host leaves.

The host owns arena, mode, Bot fill, Bot difficulty, team assignment, and the
start request. A participant owns only their pre-Ready display name, skin, and
Ready state. Host setting changes invalidate every non-host Ready state.

The roster preview reuses `src/sim/roster.ts`. A start request is eligible only
when protocol/build identities match, all connected guests are Ready, the
Phase 2 roster validates, and all four required dedicated channels are open.
The host then sends one canonical map/hash, seed, mode, difficulty, roster,
team, skin, protocol/build, and start-tick payload. Every guest validates and
loads it before replying `READY_TO_SIMULATE`; the countdown begins only after
every connected participant reaches that barrier.

During play the host advances the single fixed-step simulation at 60 Hz,
receives bounded 60 Hz input commands, and initially emits 20 Hz delta
snapshots plus periodic reliable keyframes. Missing or timed-out guest input is
neutralized rather than repeated. Damage, inventory, projectiles, glass,
storm, eliminations, and results are host decisions. A disconnected guest may
reclaim the same Actor for 60 seconds with a rotated reconnect token; there is
no Bot takeover. Host loss permits only bounded ICE recovery before the match
ends for all guests. There is no host migration.

## Connectivity limits

Direct P2P can reveal network addresses to invited peers. Symmetric NAT,
firewalls, enterprise policy, browser policy, or UDP filtering may prevent a
connection. Xo Beta reports that limitation accurately and suggests another
network or mobile hotspot. It does not describe NAT failure as a temporary Xo
Beta server outage and does not claim universal connectivity.

## Connection-test scope

The deterministic browser suite uses isolated Chromium contexts and real
same-machine `RTCPeerConnection`/DataChannel pairs while mocking only the public
Nostr relay layer. This covers two, three, and four participants without making
CI depend on public relay availability. A second LAN device, a separate-network
device, and a mobile-hotspot path were not available in the implementation
environment, so no claim is made for those network classes. They remain manual
device/network checks, and failure on them is an acceptable STUN-only outcome.
