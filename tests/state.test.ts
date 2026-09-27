import { describe, expect, it } from "vitest";
import { settingsFromEnv } from "../src/config.js";
import { CpuLoad } from "../src/load/cpu-load.js";
import { MemoryLoad } from "../src/load/memory-load.js";
import { RuntimeState } from "../src/state/runtime-state.js";
import { StateService } from "../src/state/state-service.js";
import { FakeClock } from "./support/fake-clock.js";
import { FakeWorkerFactory } from "./support/fake-worker-factory.js";

describe("RuntimeState", () => {
  it("starts healthy and records start time from the clock", () => {
    const clock = new FakeClock();
    const s = new RuntimeState(clock);
    expect(s.live).toBe(true);
    expect(s.ready).toBe(true);
    expect(s.startedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("StateService.snapshot", () => {
  it("combines probes, uptime, controls flag and load status with snake_case keys", () => {
    const clock = new FakeClock();
    const state = new RuntimeState(clock);
    const cpu = new CpuLoad({ maxWorkers: 2, factory: new FakeWorkerFactory().factory });
    const memory = new MemoryLoad({ chunkMib: 1, clock });
    const service = new StateService(state, cpu, memory, settingsFromEnv(() => undefined), clock);
    clock.advance(90_500);
    state.ready = false;
    cpu.start(1);
    const snap = service.snapshot();
    expect(snap).toMatchObject({
      live: true, ready: false, started_at: "2026-01-01T00:00:00.000Z", uptime_seconds: 90.5, controls_enabled: true,
      cpu_load: { active: true, workers: 1 },
      memory_load: { active: false, phase: "idle" },
    });
    expect(Object.keys(snap)).toEqual(["live", "ready", "started_at", "uptime_seconds", "controls_enabled", "cpu_load", "memory_load"]);
  });

  it("reflects CONTROLS_ENABLED=false", () => {
    const clock = new FakeClock();
    const service = new StateService(new RuntimeState(clock), new CpuLoad({ factory: new FakeWorkerFactory().factory }),
      new MemoryLoad(), settingsFromEnv((n) => (n === "CONTROLS_ENABLED" ? "false" : undefined)), clock);
    expect(service.snapshot().controls_enabled).toBe(false);
  });
});
