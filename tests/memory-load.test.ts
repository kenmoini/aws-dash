import { describe, expect, it } from "vitest";
import { MemoryLoad, MemoryLoadActiveError } from "../src/load/memory-load.js";
import { FakeClock } from "./support/fake-clock.js";

const MIB = 1024 * 1024;

describe("MemoryLoad", () => {
  it("is idle initially and reports process memory", () => {
    const s = new MemoryLoad().status();
    expect(s).toMatchObject({ active: false, phase: "idle", target_mib: 0, allocated_mib: 0, started_at: null, error: null });
    expect(s.rss_bytes).toBeGreaterThan(0);
    expect(typeof s.available_bytes === "number" || s.available_bytes === null).toBe(true);
  });

  it("allocates in chunks, yielding between them, then holds", async () => {
    let yields = 0;
    const load = new MemoryLoad({ chunkMib: 1, clock: new FakeClock(), yieldFn: async () => { yields++; } });
    const first = load.start(3);
    expect(first).toMatchObject({ active: true, phase: "allocating", target_mib: 3, started_at: "2026-01-01T00:00:00.000Z" });
    await load.settled();
    const s = load.status();
    expect(s).toMatchObject({ active: true, phase: "holding", target_mib: 3, allocated_mib: 3 });
    expect(s.array_buffers_bytes).toBeGreaterThanOrEqual(3 * MIB);
    expect(yields).toBe(3);
  });

  it("rejects a second start while active", async () => {
    const load = new MemoryLoad({ chunkMib: 1 });
    load.start(1);
    expect(() => load.start(1)).toThrow(MemoryLoadActiveError);
    await load.settled();
    load.stop();
  });

  it("stop() releases chunks and returns to idle", async () => {
    const load = new MemoryLoad({ chunkMib: 1 });
    load.start(2);
    await load.settled();
    expect(load.stop()).toMatchObject({ active: false, phase: "idle", target_mib: 0, allocated_mib: 0, started_at: null });
  });

  it("stop() during allocation abandons the in-flight loop", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const load = new MemoryLoad({ chunkMib: 1, yieldFn: () => gate });
    load.start(5);
    expect(load.status().allocated_mib).toBe(1);
    load.stop();
    release();
    await load.settled();
    expect(load.status()).toMatchObject({ active: false, allocated_mib: 0, phase: "idle" });
  });

  it("start() after stop() works again", async () => {
    const load = new MemoryLoad({ chunkMib: 1 });
    load.start(1); await load.settled(); load.stop();
    expect(load.start(2).active).toBe(true);
    await load.settled();
    expect(load.status().allocated_mib).toBe(2);
    load.stop();
  });

  it("an allocation failure releases everything, returns to idle and reports the error", async () => {
    const load = new MemoryLoad({ chunkMib: 1, yieldFn: async () => { throw new Error("boom"); } });
    load.start(3);
    await load.settled();
    expect(load.status()).toMatchObject({ active: false, phase: "idle", allocated_mib: 0, target_mib: 0, started_at: null, error: "boom" });
    expect(load.start(1).error).toBeNull();
    await load.settled();
    load.stop();
  });
});
