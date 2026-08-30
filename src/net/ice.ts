/**
 * The Phase 3 peer connection is intentionally limited to public STUN
 * discovery.  The game has no relay service, so credentials and relay URLs
 * must never be added to this configuration.
 */

/** Public, uncredentialed STUN endpoints used for ICE server discovery. */
export const PUBLIC_STUN_SERVER_URLS = Object.freeze([
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.nextcloud.com:443',
  'stun:stun.stunprotocol.org:3478',
] as const);

/** Alias retained for callers that refer to the list as STUN servers. */
export const STUN_SERVER_URLS = PUBLIC_STUN_SERVER_URLS;

/**
 * A fresh list is returned for every connection.  Keeping this as a factory
 * prevents one peer from mutating the configuration observed by another.
 */
export function createIceConfiguration(): RTCConfiguration {
  return {
    iceServers: PUBLIC_STUN_SERVER_URLS.map((urls) => ({ urls })),
    iceTransportPolicy: 'all',
  };
}

/** The canonical Phase 3 configuration, useful for inspection and tests. */
export const PHASE_3_ICE_CONFIGURATION: RTCConfiguration = createIceConfiguration();

/** Common names for integrations that call this the RTC configuration. */
export const RTC_CONFIGURATION = PHASE_3_ICE_CONFIGURATION;
export const ICE_CONFIGURATION = PHASE_3_ICE_CONFIGURATION;

function urlsFor(server: RTCIceServer): string[] {
  return Array.isArray(server.urls) ? [...server.urls] : [server.urls];
}

/** True when a URL is a STUN URL (and not another ICE transport). */
export function isStunServerUrl(url: string): boolean {
  return /^stun:(?![^\s@]*@)[^\s]+$/iu.test(url);
}

/**
 * Validate the narrow configuration accepted by the game connection.
 * Keeping this check at the factory boundary makes accidental relay or
 * credential configuration fail before a browser peer is constructed.
 */
export function assertStunOnlyConfiguration(configuration: RTCConfiguration): void {
  if (configuration.iceTransportPolicy !== 'all') {
    throw new Error('Phase 3 requires iceTransportPolicy=all');
  }

  const servers = configuration.iceServers ?? [];
  if (servers.length < 2) {
    throw new Error('Phase 3 requires multiple public STUN servers');
  }

  const allUrls: string[] = [];
  for (const server of servers) {
    if (server.username !== undefined || server.credential !== undefined) {
      throw new Error('Phase 3 STUN servers must not contain credentials');
    }
    const urls = urlsFor(server);
    if (urls.length === 0 || urls.some((url) => !isStunServerUrl(url))) {
      throw new Error('Phase 3 accepts STUN URLs only');
    }
    allUrls.push(...urls);
  }
  if (new Set(allUrls).size < 2) {
    throw new Error('Phase 3 requires distinct public STUN servers');
  }
}

type CandidateLike =
  | string
  | RTCIceCandidateInit
  | Pick<RTCIceCandidate, 'candidate' | 'type'>
  | null
  | undefined;

function candidateString(candidate: CandidateLike): string | null {
  if (typeof candidate === 'string') return candidate;
  if (!candidate || typeof candidate.candidate !== 'string') return null;
  return candidate.candidate;
}

/** Extract the ICE candidate type from either a browser candidate or SDP line. */
export function iceCandidateType(candidate: CandidateLike): string | null {
  let explicitType: string | null = null;
  if (typeof candidate !== 'string' && candidate && 'type' in candidate) {
    const type = candidate.type;
    if (typeof type === 'string' && type.length > 0) explicitType = type.toLowerCase();
  }

  const value = candidateString(candidate);
  if (!value) return explicitType;
  const parsedTypes = [...value.matchAll(/(?:^|\s)typ\s+(host|srflx|prflx|relay)(?=\s|$)/giu)]
    .map((match) => match[1]!.toLowerCase());
  if (explicitType === 'relay' || parsedTypes.includes('relay')) return 'relay';
  return explicitType ?? parsedTypes[0] ?? null;
}

/** Relay candidates are outside the direct peer-to-peer Phase 3 contract. */
export function isRelayIceCandidate(candidate: CandidateLike): boolean {
  return iceCandidateType(candidate) === 'relay';
}
