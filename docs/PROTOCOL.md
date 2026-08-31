# Private-room protocol

## Security context

An invite contains one random root secret and a commitment to the ephemeral
host signing identity. The root secret is never used directly as a room ID,
password, authentication tag, reconnect namespace, or session identifier.
HKDF-SHA-256 derives independent values with explicit labels for:

- discovery room ID
- signaling encryption password
- lobby authentication key
- reconnect namespace
- protocol-session binding

The link form is `#join=<encoded-token>`. Browsers do not send URL fragments in
HTTP requests. Manual entry uses the same token encoded with grouped Crockford
Base32 and a checksum. Parsing ignores letter case, spaces, and hyphens while
rejecting ambiguous or out-of-alphabet characters.

## Admission handshake

Trystero's pre-join peer handshake keeps a transport pending: it is absent from
the active peer map and cannot send lobby actions until admission completes.
The guest sends a bounded canonical admission request containing:

- protocol version and production build hash
- guest role (never host)
- room proof bound to the lobby authentication key
- expected host-identity commitment
- normalized display name and valid Phase 1 skin
- requested slot, supported feature list, and fresh nonce
- optional reconnect claim

The host rejects an incompatible protocol/build, wrong proof or host
commitment, a fifth human, malformed/oversized payload, invalid Unicode/name or
skin, duplicate peer, duplicate reclaim, unsupported feature, stale/replayed
nonce, unknown reconnect token, or admission after match lock.

An accepted response contains the host public key, assigned slot and
participant identity, protocol-session binding, a fresh per-slot reconnect
token, and the signed canonical lobby state. The guest verifies the public-key
fingerprint against the invite commitment and verifies the signature before it
accepts the host. A guest response claiming the host role is always rejected.

## Lobby messages

Messages have a small allowlisted type, protocol/build binding, monotonically
increasing sequence or nonce, and an explicit payload-size limit. Per-peer
token buckets limit message frequency. Unknown message types and feature flags,
malformed binary/JSON payloads, stale state, and replayed admissions fail
closed.

Guests send requests only to the admitted host. The host validates ownership,
applies the mutation, signs the next canonical state, and broadcasts it.
Guests never merge peer state or accept another guest as an authority.
The signed state includes the host-computed Phase 2 roster preview; guests
validate its build, room, revision, participant, and roster bindings before
rendering it.

Ready is cleared for all non-host participants whenever arena, mode, Bot fill,
Bot difficulty, or any human team assignment changes.

## Reconnect claim

After admission, the guest stores its reconnect token only in
`sessionStorage`. The key is namespaced by a derived reconnect value; the raw
invite secret is not part of the storage key or value. Tokens are never written
to `localStorage`, the invite, logs, error reports, or URLs.

The host binds a token to the room, assigned slot, participant identity, and
protocol session. A reconnect request does not assert a participant identity;
the opaque token selects the host's in-memory binding. A changed browser peer
ID may reclaim that disconnected slot. Successful reclaim rotates the token,
invalidating the previous value. An unknown token is removed from the guest's
session and permits one fresh-admission attempt when capacity remains; it never
reclaims an existing identity. Before match lock this restores lobby
membership. During a match, a valid claim within 60 seconds rebinds the same
roster slot and Actor, rotates the token, and receives a full authoritative
keyframe. An eliminated participant returns as a spectator. Expired claims do
not create a new player or Bot takeover.

## Dedicated WebRTC signaling

Only admitted host↔guest pairs may exchange dedicated-connection signaling.
The allowlist is offer, answer, and ICE candidate. SDP/candidate payloads are
bounded, and `typ relay` candidates are rejected. The host creates the four
named DataChannels; the guest validates every received label and reliability
configuration. Unknown, duplicate, or misconfigured channels close the
connection. Before application data is accepted, the reliable control channel
exchanges an exact bounded protocol binding for the build, room, participant,
browser peer ID, role, and admission session. A mismatch closes the dedicated
connection. All inbound channel messages are bounded independently from the
Trystero control layer.

Start eligibility proves that the lobby and all required channels are ready.
The host then sends the canonical match-start payload; each guest validates the
map/build/protocol/roster binding, loads presentation resources, and returns
`READY_TO_SIMULATE`. Only the host may begin the countdown, and only after every
connected participant acknowledges that barrier.

High-frequency input and snapshot packets are binary, versioned,
session-bound, sequenced, ticked, and exact-length validated. Guests send only
bounded input, tactical-ping requests, acknowledgements, and reconnect
control. Reliable authoritative events and keyframes use monotonic IDs and
revisions so duplicate delivery is idempotent. No packet accepts guest claims
for position, health, inventory, damage, ownership, glass, storm, or results.

## Binary validation contract

Every binary decoder rejects before allocation or state mutation when its
header, type, session, reserved bytes, payload length, enum, count, or sequence
is invalid. The current bounds are:

| Boundary | Rule |
| --- | --- |
| Input packet | Exact header/payload length; 128-byte payload maximum; three redundant frames maximum |
| Snapshot packet | 8 KiB payload maximum; 64 chunks and 64 entities maximum; entity records have bounded lengths |
| Reliable packet | 48 KiB payload maximum; canonical values reject non-finite numbers and dangerous object keys |
| Match-start JSON | 48 KiB maximum; fatal UTF-8; exact keys and closed map/mode/difficulty/skin/roster enums |
| Reassembly | Session is checked before a chunk enters the reassembly table; duplicate, stale, and mismatched chunks are rejected |
| Stateful gates | Sequence, tick, rewind, rate, replay nonce, peer count, and idle state all have finite bounds |

Lengths are checked against the actual buffer, not only a declared field.
Negative values, integer overflow, NaN, Infinity, malformed UTF-8, duplicate
IDs, future ticks, excessive rewind, and unsupported enum values are rejected.
Decoder errors are converted to bounded protocol failures; they do not crash or
partially apply a match. The deterministic fuzz corpus is run with:

```bash
npx vitest run tests/unit/net-fuzz.test.ts
```

Acceptance response delivery is a commit point. Fresh admission and reconnect
stage their lobby, Actor, token, and peer bindings, send the signed response,
then commit. A failed send rolls back the staged state. Reconnect tokens are
never logged, and SDP, ICE candidates, peer addresses, or room secrets are not
rendered in the ordinary UI.
