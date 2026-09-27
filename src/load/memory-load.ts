import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { systemClock, type Clock } from "../clock.js";

export type MemoryLoadPhase = "idle" | "allocating" | "holding" | "releasing";

export interface MemoryLoadStatus {
  active: boolean;
  phase: MemoryLoadPhase;
  target_mib: number;
  allocated_mib: number;
  started_at: string | null;
  rss_bytes: number;
  external_bytes: number;
  array_buffers_bytes: number;
  /** process.constrainedMemory(): the cgroup limit Node sees, or null when unknown. */
  constrained_bytes: number | null;
  available_bytes: number | null;
}

export class MemoryLoadActiveError extends Error {
  override name = "MemoryLoadActiveError";
  constructor() { super("memory load already active"); }
}

const MIB = 1024 * 1024;

/** Allocates and holds off-heap Buffers so container RSS climbs toward (and past) the cgroup limit. */
export class MemoryLoad {
  private readonly chunkMib: number;
  private readonly clock: Clock;
  private readonly yieldFn: () => Promise<void>;
  private chunks: Buffer[] = [];
  private phase: MemoryLoadPhase = "idle";
  private targetMib = 0;
  private startedAt: Date | null = null;
  private generation = 0;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(opts: { chunkMib?: number; clock?: Clock; yieldFn?: () => Promise<void> } = {}) {
    this.chunkMib = Math.max(1, opts.chunkMib ?? 64);
    this.clock = opts.clock ?? systemClock;
    this.yieldFn = opts.yieldFn ?? (() => setImmediatePromise());
  }

  status(): MemoryLoadStatus {
    const mem = process.memoryUsage();
    const constrained = process.constrainedMemory();
    return {
      active: this.phase !== "idle",
      phase: this.phase,
      target_mib: this.targetMib,
      allocated_mib: this.chunks.reduce((sum, c) => sum + c.length, 0) / MIB,
      started_at: this.startedAt?.toISOString() ?? null,
      rss_bytes: mem.rss,
      external_bytes: mem.external,
      array_buffers_bytes: mem.arrayBuffers,
      constrained_bytes: constrained > 0 ? constrained : null,
      available_bytes: typeof process.availableMemory === "function" ? process.availableMemory() : null,
    };
  }

  /** Kicks off allocation and returns immediately; await settled() to wait for it. */
  start(mib: number): MemoryLoadStatus {
    if (this.phase !== "idle") throw new MemoryLoadActiveError();
    this.targetMib = Math.max(1, Math.trunc(mib));
    this.startedAt = this.clock.now();
    this.phase = "allocating";
    const gen = ++this.generation;
    this.inFlight = this.allocate(gen);
    return this.status();
  }

  stop(): MemoryLoadStatus {
    this.generation++;
    this.phase = "releasing";
    this.chunks = [];
    this.targetMib = 0;
    this.startedAt = null;
    this.phase = "idle";
    return this.status();
  }

  settled(): Promise<void> {
    return this.inFlight;
  }

  private async allocate(gen: number): Promise<void> {
    let allocated = 0;
    while (allocated < this.targetMib && gen === this.generation) {
      const size = Math.min(this.chunkMib, this.targetMib - allocated);
      // allocUnsafe + fill touches every page so the kernel actually commits the memory.
      this.chunks.push(Buffer.allocUnsafe(size * MIB).fill(0x5a));
      allocated += size;
      await this.yieldFn();
    }
    if (gen === this.generation) this.phase = "holding";
  }
}
