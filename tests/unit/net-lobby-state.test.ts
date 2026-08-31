import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
  buildHandshake,
  type BuildIdentity,
} from '../../src/net/protocol';
import {
  LobbyError,
  LobbyState,
  MAX_HUMAN_PARTICIPANTS,
  type LobbyStateOptions,
} from '../../src/net/lobbyState';

const build: BuildIdentity = {
  protocolVersion: PROTOCOL_VERSION,
  buildId: 'test-build',
  features: [...PROTOCOL_FEATURES],
};

function makeLobby(overrides: Partial<LobbyStateOptions> = {}) {
  return new LobbyState({
    roomId: 'room-1',
    hostPeerId: 'host-peer',
    build,
    seed: 123,
    ...overrides,
  });
}

function guest(index: number, overrides: Record<string, unknown> = {}) {
  return buildHandshake({
    roomId: 'room-1',
    peerId: `peer-${index}`,
    participantId: `participant-${index}`,
    role: 'participant',
    protocolSession: `session-${index}`,
    nonce: `nonce-${index}`,
    build,
    ...overrides,
  });
}

function command(lobby: LobbyState, peerId: string, type: string, payload: Record<string, unknown>) {
  const participant = lobby.getParticipantByPeer(peerId);
  if (!participant) throw new Error(`missing participant ${peerId}`);
  return lobby.applyCommand(peerId, {
    type,
    protocolVersion: PROTOCOL_VERSION,
    protocolSession: participant.protocolSession,
    senderPeerId: peerId,
    nonce: `${type}-${lobby.revision + 1}-${peerId}`,
    ...payload,
  });
}

describe('host-authoritative lobby state', () => {
  it('admits at most four humans and rejects host claims, duplicates, and build mismatches', () => {
    const lobby = makeLobby();
    for (let index = 1; index < MAX_HUMAN_PARTICIPANTS; index++) {
      lobby.addParticipant(guest(index));
    }
    expect(lobby.participants).toHaveLength(MAX_HUMAN_PARTICIPANTS);
    expect(() => lobby.addParticipant(guest(4))).toThrowError(LobbyError);
    expect(() => lobby.addParticipant(guest(1))).toThrowError(/already/i);
    expect(() => lobby.addParticipant(guest(5, { role: 'host' }))).toThrowError(/host/i);
    expect(() => lobby.addParticipant(guest(6, { build: { ...build, buildId: 'different' } }))).toThrowError(/build|invalid/i);
  });

  it('allows only own profile/readiness changes and host-only lobby controls', () => {
    const lobby = makeLobby();
    lobby.addParticipant(guest(1));
    lobby.setDisplayName('host-peer', 'Renamed Host');
    expect(() => command(lobby, 'peer-1', 'set-map', { mapId: 'eden' })).toThrowError(/host/i);
    expect(() => command(lobby, 'peer-1', 'set-team', { participantId: 'host', teamId: 1 })).toThrowError(/host/i);
    command(lobby, 'peer-1', 'set-display-name', { displayName: 'e\u0301' });
    expect(lobby.getParticipantByPeer('peer-1')?.displayName).toBe('é');
    command(lobby, 'peer-1', 'set-skin', { skinId: 'nova' });
    command(lobby, 'peer-1', 'set-ready', { ready: true });
    expect(() => command(lobby, 'peer-1', 'set-display-name', { displayName: 'Too Late' })).toThrowError(/ready/i);
    command(lobby, 'peer-1', 'set-ready', { ready: false });
  });

  it('clears non-host readiness after host settings change while preserving host readiness', () => {
    const lobby = makeLobby();
    lobby.addParticipant(guest(1));
    lobby.setReady('host-peer', true);
    lobby.setReady('peer-1', true);
    lobby.setMap('host-peer', 'oldfront');
    expect(lobby.getParticipantByPeer('host-peer')?.ready).toBe(true);
    expect(lobby.getParticipantByPeer('peer-1')?.ready).toBe(false);

    lobby.setReady('peer-1', true);
    lobby.setDifficulty('host-peer', 'hard');
    expect(lobby.getParticipantByPeer('host-peer')?.ready).toBe(true);
    expect(lobby.getParticipantByPeer('peer-1')?.ready).toBe(false);
  });

  it.each([
    ['ffa-bot-fill', true, 1],
    ['ffa', false, 2],
    ['teams', false, 2],
    ['teams-bot-fill', true, 2],
    ['humans-vs-bots', true, 1],
  ] as const)('previews the Phase 2 %s roster', (mode, botFill, humans) => {
    const lobby = makeLobby({ mode, botFill });
    for (let index = 1; index < humans; index++) lobby.addParticipant(guest(index));
    const preview = lobby.rosterPreview();
    expect(preview.mode).toBe(mode);
    expect(preview.valid).toBe(true);
    expect(preview.humans).toHaveLength(humans);
    expect(preview.roster.length).toBeGreaterThanOrEqual(humans);
  });

  it('keeps online mode and team semantics within the Phase 3 allowlist', () => {
    expect(() => makeLobby({ mode: 'solo' })).toThrowError(/mode/i);

    const lobby = makeLobby({ mode: 'ffa', botFill: false });
    lobby.addParticipant(guest(1));
    lobby.setMode('host-peer', 'teams');
    expect(lobby.participants.map((participant) => participant.teamId)).toEqual([0, 1]);

    lobby.setMode('host-peer', 'humans-vs-bots');
    expect(lobby.config.botFill).toBe(true);
    expect(lobby.participants.every((participant) => participant.teamId === 0)).toBe(true);
    expect(() => lobby.setBotFill('host-peer', false)).toThrowError(/requires Bot fill/i);

    lobby.setMode('host-peer', 'ffa');
    expect(lobby.participants.every((participant) => participant.teamId === null)).toBe(true);
    expect(() => lobby.setTeam('host-peer', 'participant-1', 1)).toThrowError(/Team Battle/i);
  });

  it('reports all start gates and never launches a Match', () => {
    const lobby = makeLobby({ mode: 'ffa-bot-fill', botFill: true });
    lobby.addParticipant({ handshake: guest(1), channelOpen: false });
    lobby.setReady('peer-1', true);
    let eligibility = lobby.getStartEligibility();
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.guestsReady).toBe(true);
    expect(eligibility.validFinalRoster).toBe(true);
    expect(eligibility.channelsOpen).toBe(false);

    lobby.markChannelOpen('peer-1');
    eligibility = lobby.getStartEligibility();
    expect(eligibility.eligible).toBe(true);
    const result = lobby.requestStart('host-peer');
    expect(result.accepted).toBe(true);
    expect(result.launched).toBe(false);
    expect(result.eligibility.eligible).toBe(true);
    expect(lobby.matchLocked).toBe(true);
    expect(lobby.getStartEligibility().blockers).toContain('match-locked');
    expect(() => lobby.addParticipant(guest(2))).toThrowError(/locked/i);
    expect(() => lobby.setSkin('host-peer', 'nova')).toThrowError(/locked/i);
  });

  it('reclaims the same disconnected slot after match lock without unlocking roster mutations', () => {
    const lobby = makeLobby({ mode: 'ffa-bot-fill', botFill: true });
    lobby.addParticipant({ handshake: guest(1), channelOpen: true });
    lobby.setReady('peer-1', true);
    expect(lobby.requestStart('host-peer').accepted).toBe(true);
    lobby.markDisconnected('peer-1');
    const reclaimed = lobby.reclaimParticipant(
      'participant-1',
      'peer-1',
      'peer-1-reconnected',
      'session-1-rotated',
    );
    expect(reclaimed.slotId).toBe(1);
    expect(reclaimed.participantId).toBe('participant-1');
    expect(reclaimed.peerId).toBe('peer-1-reconnected');
    expect(lobby.matchLocked).toBe(true);
    expect(() => lobby.setSkin('host-peer', 'nova')).toThrowError(/locked/i);
    expect(() => lobby.addParticipant(guest(2))).toThrowError(/locked/i);
  });

  it('keeps lobby connectivity separate from direct channel state', () => {
    const lobby = makeLobby();
    lobby.addParticipant(guest(1));
    lobby.setReady('peer-1', true);

    lobby.setChannelOpen('peer-1', false);
    let participant = lobby.getParticipantByPeer('peer-1');
    expect(participant?.connected).toBe(true);
    expect(participant?.channelsOpen).toBe(false);
    expect(participant?.ready).toBe(true);

    lobby.markDisconnected('peer-1');
    participant = lobby.getParticipantByPeer('peer-1');
    expect(participant?.connected).toBe(false);
    expect(participant?.channelsOpen).toBe(false);
    expect(participant?.ready).toBe(false);
    expect(() => lobby.setSkin('peer-1', 'nova')).toThrowError(/disconnected/i);
    const lateCommand = {
      type: 'set-ready' as const,
      protocolVersion: PROTOCOL_VERSION,
      protocolSession: 'session-1',
      senderPeerId: 'peer-1',
      nonce: 'late-ready-command',
      ready: true,
    };
    expect(() => lobby.applyCommand('peer-1', lateCommand)).toThrowError(/disconnected/i);

    lobby.markConnected('peer-1');
    expect(() => lobby.applyCommand('peer-1', lateCommand)).not.toThrow();
    participant = lobby.getParticipantByPeer('peer-1');
    expect(participant?.connected).toBe(true);
    expect(participant?.channelsOpen).toBe(false);
    expect(participant?.ready).toBe(true);
  });

  it('rejects stale protocol sessions and unknown peers at the command boundary', () => {
    const lobby = makeLobby();
    lobby.addParticipant(guest(1));
    const participant = lobby.getParticipantByPeer('peer-1')!;
    expect(() => lobby.applyCommand('peer-1', {
      type: 'set-ready',
      protocolVersion: PROTOCOL_VERSION,
      protocolSession: 'old-session',
      senderPeerId: 'peer-1',
      nonce: 'stale-1',
      ready: true,
    })).toThrowError(/stale/i);
    expect(participant.ready).toBe(false);
    command(lobby, 'peer-1', 'set-ready', { ready: true });
    expect(lobby.getParticipantByPeer('peer-1')?.ready).toBe(true);
    expect(() => lobby.applyCommand('unknown', {
      type: 'set-ready',
      protocolVersion: PROTOCOL_VERSION,
      protocolSession: 'session',
      senderPeerId: 'unknown',
      nonce: 'unknown-1',
      ready: true,
    })).toThrowError(/unknown/i);
  });

  it('reclaims only a disconnected guest, rotates session identity, and rejects stale/duplicate peers', () => {
    const lobby = makeLobby();
    lobby.addParticipant(guest(1));
    lobby.markDisconnected('peer-1');
    const reclaimed = lobby.reclaimParticipant('participant-1', 'peer-1', 'peer-1-new', 'session-1-new');
    expect(reclaimed.peerId).toBe('peer-1-new');
    expect(reclaimed.protocolSession).toBe('session-1-new');
    expect(reclaimed.connected).toBe(false);
    expect(reclaimed.channelsOpen).toBe(false);
    expect(reclaimed.ready).toBe(false);
    expect(() => lobby.reclaimParticipant('participant-1', 'peer-1', 'peer-1-other', 'session-1-other'))
      .toThrowError(/stale|disconnected/i);
    lobby.addParticipant(guest(2));
    lobby.markDisconnected('peer-1-new');
    expect(() => lobby.reclaimParticipant('participant-1', 'peer-1-new', 'peer-2', 'session-1-other'))
      .toThrowError(/already/i);
  });

  it('honors a free requested guest slot and rejects invalid or occupied slots', () => {
    const lobby = makeLobby();
    const joined = lobby.addParticipant({ handshake: guest(1), requestedSlot: 3 });
    expect(joined.slotId).toBe(3);
    expect(() => lobby.addParticipant({ handshake: guest(2), requestedSlot: 0 })).toThrowError(/slot/i);
    expect(() => lobby.addParticipant({ handshake: guest(3), requestedSlot: 3 })).toThrowError(/occupied|full/i);
  });
});
