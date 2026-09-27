import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppDeps } from "../app.js";

function probe(reply: FastifyReply, ok: boolean, what: "liveness" | "readiness") {
  if (ok) return reply.send({ status: "ok" });
  return reply.code(503).send({ status: "failing", reason: `${what} disabled via controls` });
}

export function registerHealthRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/healthz/live", (_req, reply) => probe(reply, deps.state.live, "liveness"));
  app.get("/healthz/ready", (_req, reply) => probe(reply, deps.state.ready, "readiness"));
  app.get("/api/state", () => deps.stateService.snapshot());
}
