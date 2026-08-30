import {
  getRelaySockets,
  joinRoom,
  pauseRelayReconnection,
  resumeRelayReconnection,
  selfId,
  type JoinRoomCallbacks,
  type Room,
} from 'trystero/nostr';
import { createIceConfiguration } from './ice';

export const NOSTR_APP_ID = 'xo-beta-private-p2p-v3';

/**
 * Public, unauthenticated endpoints selected from Trystero 0.25.4's Nostr
 * defaults. Xo Beta has no account, key, billing agreement, or paid fallback
 * with any of them. A relay that stops accepting anonymous traffic simply
 * becomes unhealthy.
 */
export const PUBLIC_NOSTR_RELAYS = Object.freeze([
  'wss://nos.lol',
  'wss://relay.agorist.space',
  'wss://relay.mostro.network',
  'wss://schnorr.me',
]);

export type RelayHealthState = 'connecting' | 'open' | 'closed' | 'failed';

export interface RelayHealth {
  readonly url: string;
  readonly state: RelayHealthState;
}

export interface NostrSignalingOptions {
  readonly discoveryId: string;
  readonly signalingPassword: string;
  readonly onPeerHandshake: NonNullable<JoinRoomCallbacks['onPeerHandshake']>;
  readonly onJoinError?: (reason: 'handshake' | 'direct') => void;
  readonly onRelayExhausted?: () => void;
  readonly handshakeTimeoutMs?: number;
}

export interface NostrSignalingRoom {
  readonly peerId: string;
  readonly room: Room;
  relayHealth(): readonly RelayHealth[];
  onRelayHealth(listener: (health: readonly RelayHealth[]) => void): () => void;
  waitForRelay(timeoutMs?: number): Promise<boolean>;
  dispose(): Promise<void>;
}

const RELAY_POLL_MS = 500;
const DEFAULT_RELAY_TIMEOUT_MS = 8_000;
export const MAX_RELAY_RECONNECT_ATTEMPTS = 3;
const RELAY_RECONNECT_DELAYS_MS = Object.freeze([500, 1_500, 3_000] as const);

/** Open an encrypted Nostr discovery room with an explicit STUN-only RTC config. */
export function openNostrSignalingRoom(options: NostrSignalingOptions): NostrSignalingRoom {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(options.discoveryId)) {
    throw new Error('Invalid derived discovery ID');
  }
  if (options.signalingPassword.length < 32 || options.signalingPassword.length > 256) {
    throw new Error('Invalid derived signaling password');
  }

  let disposed = false;
  let reconnectAttempts = 0;
  let reconnectTimer: number | null = null;
  let reconnectPauseTimer: number | null = null;
  let exhaustionReported = false;
  const listeners = new Set<(health: readonly RelayHealth[]) => void>();
  // Trystero reconnects relay sockets automatically unless this global gate is
  // held. Keep it paused and release it only for the bounded attempts below.
  resumeRelayReconnection();
  pauseRelayReconnection();
  let room: Room;
  try {
    room = joinRoom({
      appId: NOSTR_APP_ID,
      password: options.signalingPassword,
      relayConfig: {
        urls: [...PUBLIC_NOSTR_RELAYS],
        warnOnRelayFailure: false,
        manualReconnection: true,
      },
      rtcConfig: createIceConfiguration(),
      trickleIce: true,
    }, options.discoveryId, {
      onPeerHandshake: options.onPeerHandshake,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 8_000,
      onJoinError(details) {
        const reason = /direct|ice|connect/iu.test(details.error) ? 'direct' : 'handshake';
        options.onJoinError?.(reason);
      },
    });
  } catch (error) {
    resumeRelayReconnection();
    throw error;
  }

  const relayHealth = (): readonly RelayHealth[] => {
    const sockets = getRelaySockets() as Record<string, WebSocket>;
    return Object.freeze(PUBLIC_NOSTR_RELAYS.map((url) => {
      const socket = sockets[url];
      if (!socket) return Object.freeze({ url, state: 'connecting' as const });
      const state: RelayHealthState = socket.readyState === WebSocket.OPEN
        ? 'open'
        : socket.readyState === WebSocket.CONNECTING
          ? 'connecting'
          : socket.readyState === WebSocket.CLOSED
            ? 'failed'
            : 'closed';
      return Object.freeze({ url, state });
    }));
  };

  let previous = '';
  const timer = window.setInterval(() => {
    if (disposed) return;
    const current = relayHealth();
    if (current.every((relay) => relay.state === 'open')) {
      reconnectAttempts = 0;
      exhaustionReported = false;
    }
    const hasFailedRelay = current.some((relay) => relay.state === 'failed' || relay.state === 'closed');
    if (hasFailedRelay && reconnectTimer === null && reconnectAttempts < MAX_RELAY_RECONNECT_ATTEMPTS) {
      const delay = RELAY_RECONNECT_DELAYS_MS[reconnectAttempts] ?? RELAY_RECONNECT_DELAYS_MS.at(-1)!;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (disposed) return;
        reconnectAttempts += 1;
        resumeRelayReconnection();
        // Re-arm the lock in the next task, after Trystero has reopened each
        // pending socket but before a later WebSocket close event can retry it.
        reconnectPauseTimer = window.setTimeout(() => {
          reconnectPauseTimer = null;
          if (!disposed) pauseRelayReconnection();
        }, 0);
      }, delay);
    }
    if (!exhaustionReported && reconnectAttempts >= MAX_RELAY_RECONNECT_ATTEMPTS
      && current.every((relay) => relay.state === 'failed' || relay.state === 'closed')) {
      exhaustionReported = true;
      options.onRelayExhausted?.();
    }
    const key = current.map((relay) => `${relay.url}:${relay.state}`).join('|');
    if (key === previous) return;
    previous = key;
    for (const listener of listeners) listener(current);
  }, RELAY_POLL_MS);

  return {
    peerId: selfId,
    room,
    relayHealth,
    onRelayHealth(listener) {
      listeners.add(listener);
      listener(relayHealth());
      return () => listeners.delete(listener);
    },
    async waitForRelay(timeoutMs = DEFAULT_RELAY_TIMEOUT_MS) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
      const startedAt = performance.now();
      while (!disposed && performance.now() - startedAt < timeoutMs) {
        if (relayHealth().some((relay) => relay.state === 'open')) return true;
        await new Promise<void>((resolve) => window.setTimeout(resolve, RELAY_POLL_MS));
      }
      return false;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      window.clearInterval(timer);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (reconnectPauseTimer !== null) window.clearTimeout(reconnectPauseTimer);
      reconnectTimer = null;
      reconnectPauseTimer = null;
      listeners.clear();
      // Release any socket callbacks waiting on the global Trystero lock. The
      // room closes them immediately, so they cannot schedule another retry.
      resumeRelayReconnection();
      await room.leave();
    },
  };
}
