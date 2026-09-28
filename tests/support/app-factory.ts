import pino from "pino";
import { buildApp, createDeps, type AppDeps } from "../../src/app.js";
import { settingsFromEnv } from "../../src/config.js";
import type { ImdsFetch } from "../../src/imds/imds-client.js";
import { CpuLoad } from "../../src/load/cpu-load.js";
import { MemoryLoad } from "../../src/load/memory-load.js";
import { RuntimeState } from "../../src/state/runtime-state.js";
import { StateService } from "../../src/state/state-service.js";
import { FakeAccessCheckClients } from "./fake-access-clients.js";
import { FakeAwsProvider } from "./fake-aws-provider.js";
import { FakeClock } from "./fake-clock.js";
import { fakeCredentialProvider, type FakeCredentialOptions } from "./fake-credentials.js";
import { FakeExit } from "./fake-exit.js";
import { FakeSts } from "./fake-sts.js";
import { FakeWorkerFactory } from "./fake-worker-factory.js";
import { FakeWorkloadApi } from "./fake-workload-api.js";

export interface TestAppOptions {
  env?: Record<string, string>;
  fsRoot?: string;
  overrides?: Partial<AppDeps>;
  credentials?: FakeCredentialOptions;
  readFile?: (path: string) => string;
}

/** Minimal IMDS fake for route tests: answers the token PUT then the document GET; `mode: "hang"` waits for the abort signal. */
export class FakeImdsFetch {
  calls = 0;
  mode: "ok" | "hang" = "ok";
  document: Record<string, string> = { instanceId: "i-test", instanceType: "t3.micro", availabilityZone: "us-east-1a", region: "us-east-1", accountId: "123456789012", imageId: "ami-test", privateIp: "10.0.0.1" };
  readonly fn: ImdsFetch = async (url, init) => {
    this.calls++;
    if (this.mode === "hang") await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    if (url.endsWith("/latest/api/token")) return { ok: true, status: 200, text: async () => "T" };
    return { ok: true, status: 200, text: async () => JSON.stringify(this.document) };
  };
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
  const sts = new FakeSts();
  const accessClients = new FakeAccessCheckClients(sts);
  const imdsFetch = new FakeImdsFetch();
  const workloadApi = new FakeWorkloadApi();
  const fake = opts.credentials ? fakeCredentialProvider(settings, env, opts.credentials) : undefined;
  const deps = createDeps({
    settings, env, clock, logger: pino({ level: "silent" }), fsRoot: opts.fsRoot ?? "/nonexistent-root",
    state, cpu, memory, stateService: new StateService(state, cpu, memory, settings, clock),
    exit: exit.fn, crashDelayMs: 10, createAwsProvider: () => aws,
    createStsClient: () => sts,
    identityReadFile: opts.readFile ?? (() => { throw Object.assign(new Error("ENOENT: no token file in tests"), { code: "ENOENT" }); }),
    createAccessCheckClients: () => accessClients,
    imdsFetch: imdsFetch.fn, imdsTimeoutMs: 20,
    createWorkloadApi: () => workloadApi, spiffeTimeoutMs: 20,
    ...(fake ? { credentials: fake.provider } : {}),
    ...opts.overrides,
  });
  const app = await buildApp(deps);
  return { app, deps, clock, exit, workers, state, cpu, memory, aws, sts, accessClients, imdsFetch, workloadApi, credentialResolves: () => fake?.counter.resolves ?? 0 };
}
