import { describe, expect, it } from 'vitest';
import {
  GuestReconnectSessionStore,
  MemoryReconnectStorage,
  ReconnectError,
  ReconnectTokenManager,
  type ReconnectBinding,
} from '../../src/net/reconnect';

const binding: ReconnectBinding = {
  roomId: 'room-1',
  slotId: 2,
  participantId: 'participant-2',
  protocolSession: 'session-2',
};

describe('lobby reconnect credentials', () => {
  it('issues random tokens bound to the complete room/slot/participant/session tuple', () => {
    const manager = new ReconnectTokenManager({ storage: new MemoryReconnectStorage(), now: () => 1000 });
    const first = manager.issue(binding);
    const second = manager.issue(binding);
    expect(first).not.toBe(second);
    expect(first).not.toContain(binding.roomId);
    expect(manager.bindingFor(first)).toEqual(binding);
    expect(manager.getRecord(first)?.generation).toBe(0);
  });

  it('rejects unknown, mismatched, and expired credentials without accepting them', () => {
    let now = 1000;
    const manager = new ReconnectTokenManager({
      storage: new MemoryReconnectStorage(),
      ttlMs: 100,
      now: () => now,
    });
    const token = manager.issue(binding);
    expect(() => manager.reclaim('not-a-token', binding)).toThrowError(ReconnectError);
    expect(() => manager.reclaim(token, { ...binding, slotId: 1 })).toThrowError(/binding/i);
    expect(manager.bindingFor(token)).toEqual(binding);
    now = 1100;
    expect(() => manager.reclaim(token, binding)).toThrowError(/expired/i);
    expect(manager.bindingFor(token)).toBeNull();
  });

  it('rotates on successful reclaim and invalidates the previous token', () => {
    const manager = new ReconnectTokenManager({ storage: new MemoryReconnectStorage(), now: () => 2000 });
    const token = manager.issue(binding);
    const rotated = manager.reclaim(token, binding, { nextProtocolSession: 'session-3' });
    expect(rotated).not.toBe(token);
    expect(() => manager.reclaim(token, binding)).toThrowError(/unknown/i);
    expect(manager.bindingFor(rotated)).toEqual({ ...binding, protocolSession: 'session-3' });
    expect(manager.getRecord(rotated)?.generation).toBe(1);
  });

  it('supports Map-like storage and does not provide a broad unrelated-storage wipe', () => {
    const storage = new Map<string, string>();
    const manager = new ReconnectTokenManager({ storage, now: () => 3000 });
    const token = manager.issue(binding);
    expect(storage.size).toBe(1);
    manager.revoke(token);
    expect(storage.size).toBe(0);
  });

  it('stores only the guest token under the derived namespace and replaces it after reclaim', () => {
    const values = new Map<string, string>();
    const storage = {
      values,
      getItem(key: string) { return values.get(key) ?? null; },
      setItem(key: string, value: string) { values.set(key, value); },
      removeItem(key: string) { values.delete(key); },
    } as unknown as Storage & { values: Map<string, string> };
    const guestStore = new GuestReconnectSessionStore({ namespace: 'derived-namespace-1234', storage });
    const manager = new ReconnectTokenManager({ storage: new MemoryReconnectStorage(), now: () => 4000 });
    const first = manager.issue(binding);
    guestStore.save(first, 'old-browser-peer');
    expect(guestStore.load('new-browser-peer')).toBe(first);
    expect(storage.values.get(guestStore.key)).toBe(first);
    expect(storage.values.get(guestStore.key)).not.toContain(binding.roomId);

    const next = manager.reclaim(first, binding, { nextProtocolSession: 'session-4' });
    guestStore.replace(next, 'new-browser-peer');
    expect(guestStore.load()).toBe(next);
    expect(guestStore.load()).not.toBe(first);
    guestStore.clear();
    expect(guestStore.load()).toBeNull();
  });
});
