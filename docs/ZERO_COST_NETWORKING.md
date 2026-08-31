# Zero-cost networking invariant

The repository owner must incur exactly zero multiplayer networking cost. This
invariant outranks connection success, convenience, latency, NAT compatibility,
and feature completeness.

## Production allowlist

- static assets on the project's existing Cloudflare deployment
- unauthenticated public Nostr relay WebSockets selected explicitly in source
- unauthenticated public STUN URIs selected explicitly in source
- direct browser-to-browser WebRTC

These endpoints receive no owner account, API key, billing credential, credit
card, payment method, or paid-overage agreement. If an endpoint stops accepting
anonymous free traffic, it becomes unhealthy and the connection fails.

## Absolute denylist

Production must not contain or construct:

- TURN or TURN-over-TLS URIs
- Cloudflare Realtime TURN or SFU
- any credentialed relay or metered fallback
- an owner-operated signaling/game server
- a Cloudflare Worker or Pages Function for multiplayer
- a server-side room or matchmaking database
- provider API/billing keys
- automatic fallback from direct P2P to a billable service

Public Nostr relays and STUN services are untrusted third-party infrastructure,
not an Xo Beta server authority. The static Cloudflare Workers Static Assets
deployment serves files only; it has no multiplayer Worker route, Pages
Function, database, or game authority.

`iceTransportPolicy` remains `"all"` because `"relay"` would require TURN.
The configured `iceServers` array contains STUN entries only. Candidate parsing
also rejects `typ relay`, so a future dependency/default change cannot silently
activate relay transport.

## Dependency audit

Trystero 0.25.4 is MIT licensed, browser-native, account-free, and has no
telemetry. Its Nostr strategy encrypts discovery session data when a password
is supplied. Its generic API also supports optional TURN, and its default ICE
array includes Cloudflare STUN. Xo Beta overrides the complete ICE array and
never supplies the optional TURN configuration.

At implementation time (2026-08-30), Cloudflare's official Realtime
documentation explicitly listed standalone TURN as metered and did not clearly
state that public STUN requires no payment method, subscription, or possible
charge. Cloudflare STUN was therefore omitted. Ambiguity resolves toward
connection failure, not cost risk.

Sources:

- Trystero repository and API: https://github.com/dmotz/trystero
- Cloudflare Realtime TURN pricing/service addresses:
  https://developers.cloudflare.com/realtime/turn/

## Gates

Unit tests assert that source RTC configuration contains no TURN scheme,
credential, or `turnConfig`, and that all configured URIs use STUN. The
production bundle is scanned for TURN URI schemes, provider credentials,
literal invite tokens, unexpected WebSocket origins, and known multiplayer API
endpoint patterns. The Content Security Policy allowlists only the four pinned
Nostr relay origins. License and secret audits run with the normal release
checks.

Connection establishment has a bounded initial attempt and one bounded ICE
restart. Exhaustion shows a localized direct-P2P limitation message and ends
the attempt. There is no endless retry and no paid recovery path.
Nostr relay socket reconnection is separately set to manual and capped at three
attempts; it cannot silently fall back to another transport or service.

## Machine-readable receipt

After a production build, run:

```bash
npm run audit:zero-cost
```

The audit scans source, production configuration, lockfile metadata, `dist/`,
and any generated `.wrangler/dry-run/` output. It writes
`dist/zero-cost-networking-audit.json` with the pass/fail result, UTC audit
timestamp, tested commit SHA, direct-WebRTC-only architecture, public Nostr
signaling, credential-free STUN configuration, and explicit false values for
TURN, SFU, dedicated server, multiplayer database/Worker/Pages Function, and
billable fallback. It contains no secrets, room tokens, peer addresses, or
SDP. The build and CI audit fail closed on a TURN URI, relay credential,
billable provider credential, hidden multiplayer endpoint, or non-static
deployment binding.
