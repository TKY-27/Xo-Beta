/** Small typed event bus. Simulation emits; audio/UI/AI subscribe. */
export class EventBus<Events extends object> {
  private listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn as (payload: never) => void);
    return () => set!.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as (p: Events[K]) => void)(payload);
      } catch (err) {
        console.error(`EventBus handler error for "${String(type)}"`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
