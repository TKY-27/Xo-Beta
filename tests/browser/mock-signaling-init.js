/* global window, crypto, URLSearchParams, location */
(() => {
  const register = window.__xoMockRegister;
  const handshakeSend = window.__xoMockHandshakeSend;
  const handshakeDone = window.__xoMockHandshakeDone;
  const actionSend = window.__xoMockActionSend;
  const leave = window.__xoMockLeave;
  const peerId = `peer-${crypto.randomUUID()}`;
  const handshakeQueues = new Map();
  const actionHandlers = new Map();
  const peerConnections = {};
  const completedPeerJoins = new Set();
  let earlyGameOfferCount = 0;
  let room;
  let disposed = false;

  const queueFor = (remote) => {
    let queue = handshakeQueues.get(remote);
    if (!queue) {
      queue = { values: [], waiters: [] };
      handshakeQueues.set(remote, queue);
    }
    return queue;
  };
  window.__xoMockReceiveHandshake = (remote, data) => {
    const queue = queueFor(remote);
    const waiter = queue.waiters.shift();
    if (waiter) waiter(data);
    else queue.values.push(data);
  };
  window.__xoMockBeginHandshake = async (remote, initiator) => {
    const callback = window.__xoMockFactoryOptions?.onPeerHandshake;
    if (!callback) {
      await handshakeDone(peerId, remote, true);
      return;
    }
    const send = (data) => handshakeSend(peerId, remote, data);
    const receive = async () => {
      const queue = queueFor(remote);
      const value = queue.values.length > 0
        ? queue.values.shift()
        : await new Promise((resolve) => queue.waiters.push(resolve));
      return { data: value };
    };
    try {
      await callback(remote, send, receive, initiator);
      await handshakeDone(peerId, remote, true);
    } catch {
      await handshakeDone(peerId, remote, false);
    }
  };
  window.__xoMockReceiveAction = async (namespace, data, from) => {
    await actionHandlers.get(namespace)?.onMessage?.(data, { peerId: from });
  };
  window.__xoMockIsPeerJoinComplete = (remote) => completedPeerJoins.has(remote);
  window.__xoMockRecordEarlyGameOffer = () => { earlyGameOfferCount += 1; };
  window.__xoMockGetDiagnostics = () => ({ earlyGameOffers: earlyGameOfferCount });
  window.__xoMockPeerJoin = (remote) => {
    peerConnections[remote] = {};
    room.onPeerJoin?.(remote);
    // Trystero installs the active peer before invoking onPeerJoin, but the
    // application callback itself must return before its first offer may be
    // considered activated by this regression harness.
    completedPeerJoins.add(remote);
  };
  window.__xoMockPeerLeave = (remote) => {
    delete peerConnections[remote];
    completedPeerJoins.delete(remote);
    room.onPeerLeave?.(remote);
  };

  window.__xoPhase3TestSignalingFactory = (options) => {
    window.__xoMockFactoryOptions = options;
    const relayFailed = new URLSearchParams(location.search).has('relay-fail');
    room = {
      makeAction(namespace, config = {}) {
        const action = {
          onMessage: config.onMessage ?? null,
          onReceiveProgress: null,
          send(data, sendOptions = {}) {
            return actionSend(peerId, namespace, data, sendOptions.target ?? null);
          },
        };
        actionHandlers.set(namespace, action);
        return action;
      },
      ping: async () => 2,
      leave: async () => {
        if (disposed) return;
        disposed = true;
        await leave(peerId);
      },
      isPassive: () => false,
      getPeers: () => peerConnections,
      onPeerJoin: null,
      onPeerLeave: null,
      onPeerStream: null,
      onPeerTrack: null,
      addStream: () => [],
      removeStream: () => undefined,
      addTrack: () => [],
      removeTrack: () => undefined,
      replaceTrack: () => [],
    };
    void register(peerId, options.discoveryId);
    const health = [{ url: 'wss://deterministic-local-mock.invalid', state: relayFailed ? 'failed' : 'open' }];
    return {
      peerId,
      room,
      relayHealth: () => health,
      onRelayHealth(listener) {
        listener(health);
        return () => undefined;
      },
      waitForRelay: async () => !relayFailed,
      dispose: () => room.leave(),
    };
  };
})();
