import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { errorBody } from "./errors.js";

export function registerMetricsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/metrics", async (_req, reply) => {
    if (!deps.settings.metricsEnabled) return reply.code(404).send(errorBody("metrics are disabled (METRICS_ENABLED=false)"));
    return reply.type(deps.metrics.contentType).send(await deps.metrics.render());
  });
}

/** Counts every response by route pattern. Must be added BEFORE any route is registered so it applies to all of them. */
export function registerHttpMetricsHook(app: FastifyInstance, deps: AppDeps): void {
  app.addHook("onResponse", (req, reply, done) => {
    deps.metrics.httpRequest(req.method, req.routeOptions.url ?? "unmatched", reply.statusCode);
    done();
  });
}
