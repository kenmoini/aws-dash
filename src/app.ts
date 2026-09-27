import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import fastifyStatic from "@fastify/static";
import formbody from "@fastify/formbody";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { systemClock, type Clock } from "./clock.js";
import { settingsFromEnv, type AppSettings } from "./config.js";
import { processEnv, type EnvLookup } from "./env.js";
import { CpuLoad } from "./load/cpu-load.js";
import { MemoryLoad } from "./load/memory-load.js";
import { createLogger } from "./logging.js";
import { PUBLIC_DIR, VIEWS_DIR } from "./paths.js";
import { registerControlRoutes } from "./routes/controls.js";
import { errorBody } from "./routes/errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPageRoutes } from "./routes/pages.js";
import { createRenderer, registerRendering } from "./routes/render.js";
import { registerRuntimeRoutes } from "./routes/runtime.js";
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
  return {
    settings, env, clock, state, cpu, memory,
    logger: overrides.logger ?? createLogger(settings),
    fsRoot: overrides.fsRoot ?? "/",
    version: overrides.version ?? pkg.version,
    stateService: overrides.stateService ?? new StateService(state, cpu, memory, settings, clock),
    exit: overrides.exit ?? realExit,
    crashDelayMs: overrides.crashDelayMs ?? 500,
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
  return app;
}
