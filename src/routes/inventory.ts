import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.js";
import { parseBool } from "../env.js";
import { isInventoryKind, kindTitle } from "../inventory/kinds.js";
import { errorBody } from "./errors.js";

export function isRefresh(req: FastifyRequest): boolean {
  const q = (req.query ?? {}) as Record<string, unknown>;
  return parseBool(typeof q["refresh"] === "string" ? q["refresh"] : undefined) === true;
}

export function registerInventoryRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/api/aws/:kind", async (req, reply) => {
    const { kind } = req.params as { kind: string };
    if (!isInventoryKind(kind)) return reply.code(404).send(errorBody(`unknown kind '${kind}'`));
    const entry = await deps.inventory.fetch(kind, isRefresh(req));
    return { kind, fetched_at: entry.fetched_at, error: entry.error, items: entry.value?.items ?? null, truncated: entry.value?.truncated ?? false };
  });
  app.post("/api/aws/refresh", (_req, reply) => {
    deps.inventory.invalidateAll();
    deps.identity.invalidateAll();
    deps.accessCheck.invalidateAll();
    deps.imds.invalidateAll();
    deps.spiffe.invalidateAll();
    return reply.code(204).send();
  });
  app.get("/partials/aws/:kind", async (req, reply) => {
    const { kind } = req.params as { kind: string };
    if (!isInventoryKind(kind)) return reply.code(404).send(errorBody(`unknown kind '${kind}'`));
    const entry = await deps.inventory.fetch(kind, isRefresh(req));
    return reply.partial("partials/panel", { kind, title: kindTitle(kind), entry });
  });
}
