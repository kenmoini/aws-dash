import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { controlsView, runtimeView } from "./runtime.js";

export function registerPageRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/", (_req, reply) => reply.page("pages/index", { ...runtimeView(deps), ...controlsView(deps) }));
}
