import pino from "pino";
import { buildApp, createDeps, type AppDeps } from "../../src/app.js";
import { settingsFromEnv } from "../../src/config.js";
import { CpuLoad } from "../../src/load/cpu-load.js";
import { MemoryLoad } from "../../src/load/memory-load.js";
import { RuntimeState } from "../../src/state/runtime-state.js";
import { StateService } from "../../src/state/state-service.js";
import { FakeAwsProvider } from "./fake-aws-provider.js";
import { FakeClock } from "./fake-clock.js";
import { FakeExit } from "./fake-exit.js";
import { FakeWorkerFactory } from "./fake-worker-factory.js";

export interface TestAppOptions {
  env?: Record<string, string>;
  fsRoot?: string;
  overrides?: Partial<AppDeps>;
}

/** Builds the app with every external dependency faked; nothing reaches the OS, network or AWS. */
export async function testApp(opts: TestAppOptions = {}) {
  const vars = opts.env ?? {};
  const env = (name: string) => vars[name];
  const settings = settingsFromEnv(env);
  const clock = new FakeClock();
  const exit = new FakeExit();
  const workers = new FakeWorkerFactory();
  const state = new RuntimeState(clock);
  const cpu = new CpuLoad({ maxWorkers: 2, factory: workers.factory });
  const memory = new MemoryLoad({ chunkMib: 1, clock });
  const aws = new FakeAwsProvider();
  const deps = createDeps({
    settings, env, clock, logger: pino({ level: "silent" }), fsRoot: opts.fsRoot ?? "/nonexistent-root",
    state, cpu, memory, stateService: new StateService(state, cpu, memory, settings, clock),
    exit: exit.fn, crashDelayMs: 10, createAwsProvider: () => aws, ...opts.overrides,
  });
  const app = await buildApp(deps);
  return { app, deps, clock, exit, workers, state, cpu, memory, aws };
}
