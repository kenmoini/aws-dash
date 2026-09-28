import fs from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import fastifyStatic from "@fastify/static";
import formbody from "@fastify/formbody";
// Exception to "routes/app.ts never import @aws-sdk/*": the STS client constructor is the one
// SDK value app.ts needs to build the default createStsClient factory (see AppDeps.createStsClient).
import { STSClient } from "@aws-sdk/client-sts";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { AwsClientDefaults } from "./aws/client-defaults.js";
import { awsErrorFrom } from "./aws/aws-error.js";
import { systemClock, type Clock } from "./clock.js";
import { settingsFromEnv, type AppSettings } from "./config.js";
import { processEnv, type EnvLookup } from "./env.js";
import { AccessCheckService, createAccessCheckClients, type AccessCheckClients } from "./identity/access-check.js";
import { CredentialProvider } from "./identity/credential-provider.js";
import { IdentityService, type StsLike } from "./identity/identity-service.js";
import { SpiffePanel } from "./identity/spiffe-panel.js";
import { createWorkloadApi, type WorkloadApiFactory } from "./identity/workload-api.js";
import { ImdsClient, type ImdsFetch } from "./imds/imds-client.js";
import { InventoryService } from "./inventory/inventory-service.js";
import { createLiveAwsProvider } from "./inventory/live-provider.js";
import type { AwsProvider } from "./inventory/provider.js";
import { TtlCache } from "./inventory/ttl-cache.js";
import { createInClusterClient, type K8sClientFactory } from "./k8s/k8s-client.js";
import { K8sInfoService } from "./k8s/k8s-info.js";
import { CpuLoad } from "./load/cpu-load.js";
import { MemoryLoad } from "./load/memory-load.js";
import { createLogger } from "./logging.js";
import { Metrics } from "./metrics/metrics.js";
import { PUBLIC_DIR, VIEWS_DIR } from "./paths.js";
import { registerControlRoutes } from "./routes/controls.js";
import { errorBody } from "./routes/errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerIdentityRoutes } from "./routes/identity.js";
import { registerInventoryRoutes } from "./routes/inventory.js";
import { registerHttpMetricsHook, registerMetricsRoutes } from "./routes/metrics.js";
import { registerPageRoutes } from "./routes/pages.js";
import { createRenderer, registerRendering } from "./routes/render.js";
import { registerRuntimeRoutes } from "./routes/runtime.js";
import { readCgroupInfo } from "./runtime/runtime-info.js";
import { realExit, type ProcessExit } from "./state/process-exit.js";
import { RuntimeState } from "./state/runtime-state.js";
import { StateService } from "./state/state-service.js";

export interface AppDeps {
  settings: AppSettings;
  env: EnvLookup;
  clock: Clock;
  logger: Logger;
  /** "/" in production; a temp dir in tests so /proc, /sys and /etc can be faked. */
  fsRoot: string;
  version: string;
  state: RuntimeState;
  cpu: CpuLoad;
  memory: MemoryLoad;
  stateService: StateService;
  exit: ProcessExit;
  crashDelayMs: number;
  credentials: CredentialProvider;
  /** Builds the live AWS provider on first use; tests inject a fake. */
  createAwsProvider: () => AwsProvider;
  inventory: InventoryService;
  metrics: Metrics;
  /** Builds the STS client for GetCallerIdentity on first use; tests inject a fake. */
  createStsClient: (config: AwsClientDefaults) => StsLike;
  identityReadFile: (path: string) => string;
  identity: IdentityService;
  /** Builds the access-check clients on first use; tests inject a fake. */
  createAccessCheckClients: (config: AwsClientDefaults) => AccessCheckClients;
  accessCheck: AccessCheckService;
  imdsFetch: ImdsFetch;
  imdsTimeoutMs: number;
  imds: ImdsClient;
  /** Opens a SPIRE Workload API channel for one load; tests inject a fake. */
  createWorkloadApi: WorkloadApiFactory;
  spiffeTimeoutMs: number;
  spiffe: SpiffePanel;
  /** Builds the in-cluster API client on first load; tests inject a fake. */
  createK8sClient: K8sClientFactory;
  k8sTimeoutMs: number;
  k8s: K8sInfoService;
}

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

/** Production wiring; tests pass overrides for everything that touches the outside world. */
export function createDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const env = overrides.env ?? processEnv;
  const settings = overrides.settings ?? settingsFromEnv(env);
  const clock = overrides.clock ?? systemClock;
  const state = overrides.state ?? new RuntimeState(clock);
  const cpu = overrides.cpu ?? new CpuLoad({ maxWorkers: settings.cpuLoadMaxWorkers });
  const memory = overrides.memory ?? new MemoryLoad({ clock });
  const logger = overrides.logger ?? createLogger(settings);
  const credentials = overrides.credentials ?? new CredentialProvider(settings, env);
  const createAwsProvider = overrides.createAwsProvider ?? (() => createLiveAwsProvider({ settings, credentials, logger }));
  const fsRoot = overrides.fsRoot ?? "/";
  const version = overrides.version ?? pkg.version;
  const stateService = overrides.stateService ?? new StateService(state, cpu, memory, settings, clock);
  const metrics = overrides.metrics ?? new Metrics({
    version, nodeVersion: process.version, authMode: credentials.describe().mode, startedAt: state.startedAt,
    snapshot: () => stateService.snapshot(), cgroup: () => readCgroupInfo(fsRoot), now: () => clock.now(),
  });
  const inventory = overrides.inventory ?? new InventoryService(createAwsProvider, new TtlCache(settings.cacheTtlSeconds * 1000, clock, (err) => awsErrorFrom(err).message), logger, metrics);
  const createStsClient = overrides.createStsClient ?? ((config: AwsClientDefaults) => new STSClient(config));
  const identityReadFile = overrides.identityReadFile ?? ((path: string) => fs.readFileSync(path, "utf8"));
  const identity = overrides.identity ?? new IdentityService({
    settings, env, clock, logger, credentials, createStsClient,
    cache: new TtlCache(settings.cacheTtlSeconds * 1000, clock, (err) => awsErrorFrom(err).message),
    readFile: identityReadFile,
  });
  metrics.setIdentitySource(() => identity.peek());
  // Fed by the shared memoized provider's tap, so every real resolution — from inventory,
  // access-check or the Identity tab — is recorded, and a scrape never touches AWS.
  metrics.setCredentialSource(() => credentials.lastResolution());
  credentials.onResolve((r) => metrics.resolved(r.mode, r.ok));
  const createAccessClients = overrides.createAccessCheckClients ?? createAccessCheckClients;
  const accessCheck = overrides.accessCheck ?? new AccessCheckService({
    settings, clock, logger, credentials, createClients: createAccessClients,
    cache: new TtlCache(settings.cacheTtlSeconds * 1000, clock, (err) => awsErrorFrom(err).message),
    observer: metrics,
  });
  const imdsFetch = overrides.imdsFetch ?? ((url: string, init: Parameters<ImdsFetch>[1]) => fetch(url, init));
  const imdsTimeoutMs = overrides.imdsTimeoutMs ?? 1000;
  const imds = overrides.imds ?? new ImdsClient({
    enabled: settings.imdsEnabled, clock, fetchFn: imdsFetch, timeoutMs: imdsTimeoutMs,
    cache: new TtlCache(settings.cacheTtlSeconds * 1000, clock, (err) => awsErrorFrom(err).message),
  });
  const createWorkloadApiFn = overrides.createWorkloadApi ?? createWorkloadApi;
  const spiffeTimeoutMs = overrides.spiffeTimeoutMs ?? 3000;
  const spiffe = overrides.spiffe ?? new SpiffePanel({
    socket: settings.spiffeEndpointSocket, audience: settings.spiffeJwtAudience, clock, createApi: createWorkloadApiFn, timeoutMs: spiffeTimeoutMs,
    cache: new TtlCache(settings.cacheTtlSeconds * 1000, clock, (err) => awsErrorFrom(err).message),
  });
  const createK8sClientFn = overrides.createK8sClient ?? createInClusterClient;
  const k8sTimeoutMs = overrides.k8sTimeoutMs ?? 3000;
  const k8s = overrides.k8s ?? new K8sInfoService({
    enabled: settings.k8sInfoEnabled, env, clock, createClient: createK8sClientFn, timeoutMs: k8sTimeoutMs,
    cache: new TtlCache(settings.cacheTtlSeconds * 1000, clock, (err) => awsErrorFrom(err).message),
  });
  return {
    settings, env, clock, state, cpu, memory, logger,
    fsRoot,
    version,
    stateService,
    exit: overrides.exit ?? realExit,
    crashDelayMs: overrides.crashDelayMs ?? 500,
    credentials,
    createAwsProvider,
    inventory,
    metrics,
    createStsClient,
    identityReadFile,
    identity,
    createAccessCheckClients: createAccessClients,
    accessCheck,
    imdsFetch,
    imdsTimeoutMs,
    imds,
    createWorkloadApi: createWorkloadApiFn,
    spiffeTimeoutMs,
    spiffe,
    createK8sClient: createK8sClientFn,
    k8sTimeoutMs,
    k8s,
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // Explicit generics: without them TS infers the Logger param as `pino.Logger` (from
  // loggerInstance) rather than the default `FastifyBaseLogger`, and the resulting
  // FastifyInstance<..., pino.Logger, ...> is not assignable to the plain FastifyInstance
  // this function returns.
  const app = Fastify<Server, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    loggerInstance: deps.logger,
    logController: new LogController({ disableRequestLogging: true }),
  });
  await app.register(formbody);
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/public/" });
  registerRendering(app, { eta: createRenderer(VIEWS_DIR, deps.env("NODE_ENV") === "production"), version: deps.version });
  registerHttpMetricsHook(app, deps);

  app.setNotFoundHandler((req, reply) => reply.code(404).send(errorBody(`not found: ${req.method} ${req.url}`)));
  // Explicit FastifyError annotation: setErrorHandler's error param generic defaults
  // to `unknown` unless the handler pins it via an explicit parameter type.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "unhandled error");
    return reply.code(status).send(errorBody(status >= 500 ? "internal error" : err.message));
  });
  app.addHook("onClose", async () => {
    await deps.cpu.stop();
    deps.memory.stop();
  });

  registerHealthRoutes(app, deps);
  registerRuntimeRoutes(app, deps);
  registerPageRoutes(app, deps);
  registerControlRoutes(app, deps);
  registerInventoryRoutes(app, deps);
  registerIdentityRoutes(app, deps);
  registerMetricsRoutes(app, deps);
  return app;
}
