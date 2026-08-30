/**
 * Local ownership boundary for presentation events.
 *
 * Phase 1 has one local actor. Keeping the identity explicit here lets audio
 * and other local-only presentation consumers switch to the multiplayer
 * ownership model without each consumer inventing its own test.
 */
export interface LocalActorIdentity {
  readonly actorId: number | null;
}

export function createLocalActorIdentity(actorId: number | null | undefined): LocalActorIdentity {
  return Object.freeze({ actorId: actorId ?? null });
}

export function isLocalActor(actorId: number, identity: LocalActorIdentity): boolean {
  return identity.actorId !== null && identity.actorId === actorId;
}
