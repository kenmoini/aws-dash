import type { Clock } from "../clock.js";

export interface CacheEntry<T> {
  value: T | null;
  fetched_at: string | null;
  error: string | null;
}

interface Slot {
  entry: CacheEntry<unknown>;
  fresh_until: number;
  epoch: number;
}

/** Per-key TTL cache: one load at a time per key; a failed reload keeps the last good value and records the error. */
export class TtlCache {
  private readonly slots = new Map<string, Slot>();
  private readonly inflight = new Map<string, Promise<CacheEntry<unknown>>>();
  private epoch = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock,
    private readonly describeError: (err: unknown) => string = (err) => (err instanceof Error ? err.message : String(err)),
  ) {}

  async get<T>(key: string, loader: () => Promise<T>, force = false): Promise<CacheEntry<T>> {
    if (!force) {
      const fresh = this.fresh<T>(key);
      if (fresh) return fresh;
    }
    const pending = this.inflight.get(key) as Promise<CacheEntry<T>> | undefined;
    if (pending) {
      if (!force) return pending;
      await pending.catch(() => undefined);
    }
    const run = this.load(key, loader);
    this.inflight.set(key, run);
    try {
      return await run;
    } finally {
      if (this.inflight.get(key) === run) this.inflight.delete(key);
    }
  }

  /** Drops every entry; loads already in flight complete for their callers but are not stored. */
  invalidateAll(): void {
    this.epoch++;
    this.slots.clear();
  }

  private fresh<T>(key: string): CacheEntry<T> | undefined {
    const slot = this.slots.get(key);
    if (slot && slot.epoch === this.epoch && this.clock.now().getTime() < slot.fresh_until) return slot.entry as CacheEntry<T>;
    return undefined;
  }

  private async load<T>(key: string, loader: () => Promise<T>): Promise<CacheEntry<T>> {
    const epoch = this.epoch;
    const previous = (this.slots.get(key)?.entry.value ?? null) as T | null;
    let entry: CacheEntry<T>;
    try {
      const value = await loader();
      entry = { value, fetched_at: this.clock.now().toISOString(), error: null };
    } catch (err) {
      entry = { value: previous, fetched_at: this.clock.now().toISOString(), error: this.describeError(err) };
    }
    if (this.epoch === epoch) this.slots.set(key, { entry, fresh_until: this.clock.now().getTime() + this.ttlMs, epoch });
    return entry;
  }
}
