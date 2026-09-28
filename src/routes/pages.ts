import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { INVENTORY_KINDS } from "../inventory/kinds.js";
import { controlsView, runtimeView } from "./runtime.js";

export function registerPageRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/", (_req, reply) => reply.page("pages/index", { ...runtimeView(deps), ...controlsView(deps) }));
  app.get("/aws", (_req, reply) =>
    reply.page("pages/aws", {
      region: deps.settings.region ?? null,
      auth: deps.credentials.describe(),
      cache_ttl_seconds: deps.settings.cacheTtlSeconds,
      kinds: INVENTORY_KINDS,
    }));
}
