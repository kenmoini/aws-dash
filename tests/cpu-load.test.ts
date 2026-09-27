import { describe, expect, it } from "vitest";
import { CpuLoad } from "../src/load/cpu-load.js";
import { FakeWorkerFactory } from "./support/fake-worker-factory.js";

describe("CpuLoad", () => {
  it("starts the requested number of workers, clamped to maxWorkers", () => {
    const fake = new FakeWorkerFactory();
    const load = new CpuLoad({ maxWorkers: 2, factory: fake.factory });
    expect(load.status()).toEqual({ active: false, workers: 0 });
    expect(load.start(64)).toEqual({ active: true, workers: 2 });
    expect(fake.created).toEqual([0, 1]);
  });

  it("clamps requests below 1 up to 1", () => {
    const fake = new FakeWorkerFactory();
    const load = new CpuLoad({ maxWorkers: 4, factory: fake.factory });
    expect(load.start(0).workers).toBe(1);
  });

  it("is idempotent while running", () => {
    const fake = new FakeWorkerFactory();
    const load = new CpuLoad({ maxWorkers: 4, factory: fake.factory });
    load.start(2);
    expect(load.start(4)).toEqual({ active: true, workers: 2 });
    expect(fake.created).toHaveLength(2);
  });

  it("stop() flips the flag and waits for workers to exit", async () => {
    const fake = new FakeWorkerFactory();
    const load = new CpuLoad({ maxWorkers: 4, factory: fake.factory });
    load.start(3);
    expect(await load.stop()).toEqual({ active: false, workers: 0 });
    expect(fake.terminated).toBe(0);
    expect(await load.stop()).toEqual({ active: false, workers: 0 });
  });

  it("stop() terminates workers that ignore the flag after the timeout", async () => {
    const fake = new FakeWorkerFactory();
    fake.stubborn = true;
    const load = new CpuLoad({ maxWorkers: 4, factory: fake.factory, stopTimeoutMs: 20 });
    load.start(2);
    await load.stop();
    expect(fake.terminated).toBe(2);
  });

  it("burns real worker threads and stops within 2 seconds", async () => {
    const load = new CpuLoad({ maxWorkers: 2 });
    expect(load.start(2).workers).toBe(2);
    const t0 = Date.now();
    expect((await load.stop()).active).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
