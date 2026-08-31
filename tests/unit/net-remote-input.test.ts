import { describe, expect, it } from 'vitest';
import { emptyCommand } from '../../src/sim/input';
import { RemoteInputController, type RemoteInputFrame } from '../../src/net/remoteInput';

function actor(id = 2, bot = false) {
  return {
    id,
    personality: bot ? { name: 'BOT' } : null,
    yaw: 0.25,
    pitch: -0.1,
  } as never;
}

function frame(sequence: number, patch: Partial<ReturnType<typeof emptyCommand>> = {}): RemoteInputFrame {
  return {
    sequence,
    clientTick: sequence,
    lastAcknowledgedHostTick: sequence,
    shotTick: sequence,
    command: { ...emptyCommand(), yaw: 0.4, pitch: 0.1, ...patch },
  };
}

describe('RemoteInputController', () => {
  it('maps one admitted peer to exactly one human actor', () => {
    const controller = new RemoteInputController('peer-a', 2, { violationLimit: 2 });
    expect(controller.accept({ receivedHostTick: 1, frames: [frame(1, { moveZ: 1 })] }).accepted).toBe(true);
    expect(controller.updateCommand(actor(2), 1 / 60).moveZ).toBe(1);
    expect(controller.updateCommand(actor(3), 1 / 60).moveZ).toBe(0);
    expect(controller.isDisconnected).toBe(false);
    expect(controller.updateCommand(actor(2, true), 1 / 60).fireHeld).toBe(false);
    expect(controller.isDisconnected).toBe(true);
  });

  it('neutralizes immediately when a fresh packet is missing', () => {
    const target = actor(2);
    const controller = new RemoteInputController('peer-a', 2);
    controller.accept({ receivedHostTick: 10, frames: [frame(10, { moveX: 1, fireHeld: true, adsHeld: true })] });
    expect(controller.updateCommand(target, 1 / 60)).toMatchObject({ moveX: 1, fireHeld: true, adsHeld: true });
    controller.setHostTick(11);
    expect(controller.updateCommand(target, 1 / 60)).toMatchObject({ moveX: 0, fireHeld: false, adsHeld: false });
  });

  it('disables implicit actions immediately and reports the bounded timeout once', () => {
    const target = actor(2);
    const timedOut: number[] = [];
    const missing: number[] = [];
    const controller = new RemoteInputController('peer-a', 2, {
      timeoutTicks: 3,
      onInputMissing: (value) => missing.push(value.id),
      onInputTimeout: (value) => timedOut.push(value.id),
    });
    controller.accept({ receivedHostTick: 10, frames: [frame(10, { moveZ: 1 })] });
    controller.setHostTick(10);
    controller.updateCommand(target, 1 / 60);
    expect(controller.allowsAutomaticActions).toBe(true);

    controller.setHostTick(11);
    expect(controller.updateCommand(target, 1 / 60).moveZ).toBe(0);
    expect(controller.allowsAutomaticActions).toBe(false);
    expect(missing).toEqual([2]);

    controller.setHostTick(13);
    expect(controller.updateCommand(target, 1 / 60).moveZ).toBe(0);
    expect(controller.allowsAutomaticActions).toBe(false);
    controller.setHostTick(14);
    controller.updateCommand(target, 1 / 60);
    expect(timedOut).toEqual([2]);

    controller.accept({ receivedHostTick: 15, frames: [frame(15)] });
    controller.setHostTick(15);
    controller.updateCommand(target, 1 / 60);
    expect(controller.allowsAutomaticActions).toBe(true);
  });

  it('does not replay duplicate edge commands recovered by redundancy', () => {
    const target = actor(2);
    const controller = new RemoteInputController('peer-a', 2);
    controller.accept({ receivedHostTick: 1, frames: [frame(1, { jumpPressed: true })] });
    expect(controller.updateCommand(target, 1 / 60).jumpPressed).toBe(true);
    expect(controller.accept({ receivedHostTick: 2, frames: [frame(1, { jumpPressed: true })] }).accepted).toBe(false);
    expect(controller.updateCommand(target, 1 / 60).jumpPressed).toBe(false);
  });

  it('recovers an unseen edge from the bounded redundant frames in a fresh packet', () => {
    const target = actor(2);
    const controller = new RemoteInputController('peer-a', 2);
    expect(controller.accept({
      receivedHostTick: 2,
      frames: [frame(1, { jumpPressed: true }), frame(2, { moveZ: 1 })],
    }).accepted).toBe(true);
    expect(controller.updateCommand(target, 1 / 60)).toMatchObject({
      jumpPressed: true,
      moveZ: 1,
    });

    expect(controller.accept({
      receivedHostTick: 3,
      frames: [frame(1, { jumpPressed: true }), frame(3, { moveZ: 1 })],
    }).accepted).toBe(true);
    expect(controller.updateCommand(target, 1 / 60).jumpPressed).toBe(false);
  });

  it('preserves the original fire sequence when redundancy recovers a dropped shot', () => {
    const acceptedShots: RemoteInputFrame[] = [];
    const controller = new RemoteInputController('peer-a', 2, {
      onAcceptedShot: (_actor, input) => {
        acceptedShots.push(input);
        return true;
      },
    });
    expect(controller.accept({
      receivedHostTick: 2,
      frames: [frame(1, { firePressed: true }), frame(2, { moveZ: 1 })],
    }).accepted).toBe(true);

    const target = actor(2);
    const command = controller.updateCommand(target, 1 / 60);
    expect(command).toMatchObject({ firePressed: true, moveZ: 1 });
    expect(controller.tryAuthoritativeShot(target, command, 1 / 60)).toBe(true);
    expect(acceptedShots).toHaveLength(1);
    expect(acceptedShots[0]).toMatchObject({ sequence: 2, fireInputSequence: 1, shotTick: 1 });
  });

  it('keeps an unconsumed edge when a newer neutral packet arrives before the host tick', () => {
    const acceptedShots: RemoteInputFrame[] = [];
    const controller = new RemoteInputController('peer-a', 2, {
      onAcceptedShot: (_actor, input) => {
        acceptedShots.push(input);
        return true;
      },
    });
    expect(controller.accept({
      receivedHostTick: 1,
      frames: [frame(1, { firePressed: true })],
    }).accepted).toBe(true);
    expect(controller.accept({
      receivedHostTick: 2,
      frames: [frame(2, { moveZ: 1 })],
    }).accepted).toBe(true);

    const target = actor(2);
    const command = controller.updateCommand(target, 1 / 60);
    expect(command).toMatchObject({ firePressed: true, moveZ: 1 });
    expect(controller.tryAuthoritativeShot(target, command, 1 / 60)).toBe(true);
    expect(acceptedShots).toHaveLength(1);
    expect(acceptedShots[0]).toMatchObject({ sequence: 2, fireInputSequence: 1, shotTick: 1 });

    expect(controller.accept({
      receivedHostTick: 3,
      frames: [frame(1, { firePressed: true }), frame(3)],
    }).accepted).toBe(true);
    expect(controller.updateCommand(target, 1 / 60).firePressed).toBe(false);
  });

  it('rejects malformed, future, stale and abusive streams with a bounded disconnect', () => {
    const disconnected: string[] = [];
    const controller = new RemoteInputController('peer-a', 2, {
      violationLimit: 3,
      onDisconnect: (peer) => disconnected.push(peer),
    });
    expect(controller.accept({ receivedHostTick: 1, frames: [frame(1, { moveX: Number.NaN })] }).reason).toBe('malformed');
    expect(controller.accept({ receivedHostTick: 1, frames: [frame(1)] }).accepted).toBe(true);
    // clientTick is checked against the previously admitted client-domain
    // tick; receivedHostTick is only the host's receipt timestamp. Keep the
    // host-mapped shotTick close so this isolates the client-clock check.
    expect(controller.accept({
      receivedHostTick: 2,
      frames: [{ ...frame(99), shotTick: 2 }],
    }).reason).toBe('future');
    expect(controller.accept({ receivedHostTick: 3, frames: [] }).reason).toBe('malformed');
    expect(controller.isDisconnected).toBe(true);
    expect(disconnected).toEqual(['peer-a']);
  });

  it('keeps client and host tick domains independent under a large clock offset', () => {
    const target = actor(2);
    const controller = new RemoteInputController('peer-a', 2);

    expect(controller.accept({
      receivedHostTick: 1_000,
      frames: [{ ...frame(1), clientTick: 1, shotTick: 1_000 }],
    }).accepted).toBe(true);
    expect(controller.updateCommand(target, 1 / 60)).toBeTruthy();

    expect(controller.accept({
      receivedHostTick: 1_001,
      frames: [{ ...frame(2), clientTick: 2, shotTick: 1_001 }],
    }).accepted).toBe(true);
  });

  it('rejects a stale edge hidden in otherwise fresh redundant input', () => {
    const controller = new RemoteInputController('peer-a', 2, { maxPastTicks: 10 });
    expect(controller.accept({
      receivedHostTick: 20,
      frames: [frame(1, { reloadPressed: true }), frame(20, { moveZ: 1 })],
    })).toMatchObject({ accepted: false, reason: 'stale' });
    expect(controller.updateCommand(actor(2), 1 / 60)).toMatchObject({
      reloadPressed: false,
      moveZ: 0,
    });
  });

  it('rate limits a burst without unbounded buffering', () => {
    const controller = new RemoteInputController('peer-a', 2, {
      ratePerSecond: 2,
      violationLimit: 20,
    });
    expect(controller.accept({ receivedHostTick: 0, frames: [frame(1)] }).accepted).toBe(true);
    expect(controller.accept({ receivedHostTick: 0, frames: [frame(2)] }).accepted).toBe(true);
    expect(controller.accept({ receivedHostTick: 0, frames: [frame(3)] }).reason).toBe('rate-limit');
  });
});
