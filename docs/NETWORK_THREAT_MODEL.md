# Network threat model

## Assets and trust boundaries

The invite secret, host signing private key, lobby authentication key,
reconnect tokens, display names, lobby settings, and future authoritative match
state are protected assets. The static Cloudflare host serves code only; it is
not a multiplayer authority. Public Nostr relays and STUN services are
untrusted discovery/connectivity aids. Invited browsers are mutually untrusted
until the host admits them.

The creator is the permanent authority for the room and future match. The host
can therefore cheat, lie about lobby or match state, exclude a participant, or
end the room. Phase 3 does not claim cheat prevention. Friends-only rooms and a
visible host badge make this trust choice explicit.

## Addressed threats

- **Public room enumeration:** the discovery ID is derived from a high-entropy
  secret; no room list or searchable room name exists.
- **Signaling disclosure:** a separately derived password encrypts Trystero
  session descriptions passed through Nostr.
- **Host impersonation:** an ephemeral Web Crypto P-256 public-key fingerprint
  is committed into the invite; canonical host state is signed with ECDSA
  SHA-256. Verification is self-contained and requires no account, remote
  certificate authority, or server-issued identity.
- **Cross-purpose key reuse:** HKDF labels separate discovery, encryption,
  lobby authentication, reconnect, and protocol binding.
- **Replay/stale admission:** fresh nonces, bounded age, replay caches, protocol
  binding, and token rotation reject repeats.
- **Unauthorized lobby changes:** the host validates host-only controls;
  participants can mutate only their own permitted profile/Ready fields.
- **Capacity and resource abuse:** four-human capacity, payload caps, message
  allowlists, rate limits, bounded connection attempts, and explicit disposal.
- **Paid relay activation:** no TURN URI, credential, provider key, or
  `turnConfig` is accepted. Relay ICE candidates fail closed.
- **Injection by names:** remote display names are normalized, length-limited,
  and rendered with `textContent`, never `innerHTML`.

## Residual risks

Direct WebRTC may reveal public, reflexive, local-network, or mDNS-derived
address information to invited peers. Public relays observe timing, encrypted
payload sizes, derived topics, and the ephemeral Nostr event public key. Public
STUN operators observe source network metadata. WebRTC DTLS protects the direct
data path, but it does not hide peer IP addresses.

A compromised host can sign malicious canonical state because it owns the
legitimate private key. An invited participant can attempt denial of service
within browser/network limits. Rate and size controls reduce these risks but do
not make hostile public matchmaking safe. This phase intentionally provides no
public matchmaking, free-text chat, voice, or uploaded user content.

Room availability depends on third-party public relays and on NAT traversal.
Failure is acceptable and produces no paid fallback. There is no promise of
universal reachability or permanent room availability.

## Browser compatibility

The implementation requires browser-native WebRTC DataChannels and Web Crypto
support for `crypto.getRandomValues`, HKDF with SHA-256, SHA-256 digests, and
ECDSA P-256 signing/verification. These primitives are available in current
secure-context releases of Chrome, Edge, Firefox, and Safari. Private rooms
fail visibly when required primitives are absent; there is no custom crypto
fallback. Manual testing remains browser/network specific.
