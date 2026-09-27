import pino from "pino";
import { describe, expect, it } from "vitest";
import { createDeps } from "../src/app.js";
import { CpuLoad } from "../src/load/cpu-load.js";
import { FakeWorkerFactory } from "./support/fake-worker-factory.js";

/** createDeps() is the production wiring; everything else in the suite bypasses it via testApp overrides. */
describe("createDeps", () => {
  it("wires stateService to the cpu dependency it was given", async () => {
    const vars: Record<string, string> = {};
    const env = (name: string) => vars[name];
    const cpu = new CpuLoad({ maxWorkers: 1, factory: new FakeWorkerFactory().factory });
    const deps = createDeps({ env, logger: pino({ level: "silent" }), cpu });
    cpu.start(1);
    expect(deps.stateService.snapshot().cpu_load).toEqual(cpu.status());
    await deps.cpu.stop();
  });

  it("defaults port to 8080 with an empty env and reads the version from package.json", () => {
    const deps = createDeps({ env: () => undefined, logger: pino({ level: "silent" }) });
    expect(deps.settings.port).toBe(8080);
    expect(deps.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
