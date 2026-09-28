import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { isRefresh } from "./inventory.js";

export function registerIdentityRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/api/identity", (req) => deps.identity.get(isRefresh(req)));
  app.get("/partials/identity", async (req, reply) =>
    reply.partial("partials/identity", { info: await deps.identity.get(isRefresh(req)), now: deps.clock.now().toISOString() }));
  app.get("/api/access-check", (req) => deps.accessCheck.run(isRefresh(req)));
  app.get("/partials/access-check", async (req, reply) =>
    reply.partial("partials/access-check", { report: await deps.accessCheck.run(isRefresh(req)), now: deps.clock.now().toISOString() }));
}
