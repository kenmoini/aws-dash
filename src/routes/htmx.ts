import type { FastifyRequest } from "fastify";

/** htmx sets HX-Request on every request it makes; those get HTML fragments, everything else gets JSON. */
export function isHtmx(req: FastifyRequest): boolean {
  return req.headers["hx-request"] === "true";
}
