import { describe, expect, it } from 'vitest';
import { replicaVisibleMapActorIds } from '../../src/ui/ui';

type MapActor = {
  id: number;
  teamId: number | null;
  alive: boolean;
};

const actor = (id: number, teamId: number | null, alive = true): MapActor => ({
  id,
  teamId,
  alive,
});

describe('replica tactical-map actor privacy', () => {
  it('keeps the local participant and living teammates while omitting enemies and dead teammates', () => {
    const ids = replicaVisibleMapActorIds({
      localActorId: 1,
      actors: [
        actor(1, 0),
        actor(2, 0),
        actor(3, 0, false),
        actor(4, 1),
      ],
    });

    expect(ids).toEqual([1, 2]);
  });

  it('does not treat same-team-looking actors as teammates in a non-team projection', () => {
    const ids = replicaVisibleMapActorIds({
      localActorId: 1,
      actors: [actor(1, null), actor(2, null), actor(3, 1)],
    });

    expect(ids).toEqual([1]);
  });

  it('returns no map actors when the projection has no local participant', () => {
    expect(replicaVisibleMapActorIds({
      localActorId: null,
      actors: [actor(1, 0), actor(2, 0)],
    })).toEqual([]);
  });
});
