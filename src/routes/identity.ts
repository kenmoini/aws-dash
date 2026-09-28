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
  app.get("/api/imds", (req) => deps.imds.get(isRefresh(req)));
  app.get("/partials/imds", async (req, reply) => reply.partial("partials/imds", { info: await deps.imds.get(isRefresh(req)) }));
  app.get("/api/spiffe", (req) => deps.spiffe.get(isRefresh(req)));
  app.get("/partials/spiffe", async (req, reply) =>
    reply.partial("partials/spiffe", {
      info: await deps.spiffe.get(isRefresh(req)),
      token_sub: deps.identity.peek()?.token?.claims["sub"] ?? null,
      now: deps.clock.now().toISOString(),
    }));
}
