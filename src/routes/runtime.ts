import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { collectRuntimeInfo, readMemoryLimitBytes } from "../runtime/runtime-info.js";

export function runtimeView(deps: AppDeps) {
  return { info: collectRuntimeInfo(deps.fsRoot, deps.env), state: deps.stateService.snapshot() };
}

export function controlsView(deps: AppDeps) {
  return { snapshot: deps.stateService.snapshot(), memory_limit_bytes: readMemoryLimitBytes(deps.fsRoot) };
}

export function registerRuntimeRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/api/runtime", () => ({ ...collectRuntimeInfo(deps.fsRoot, deps.env), state: deps.stateService.snapshot() }));
  app.get("/partials/runtime", (_req, reply) => reply.partial("partials/runtime", runtimeView(deps)));
  app.get("/partials/controls", (_req, reply) => reply.partial("partials/controls", controlsView(deps)));
}
