import { Eta } from "eta";
import type { FastifyInstance, FastifyReply } from "fastify";
import { fmt } from "../views/fmt.js";

declare module "fastify" {
  interface FastifyReply {
    /** Renders a full page; the page template selects its layout with `<% layout("/layout", {...}) %>`. */
    page(name: string, data?: Record<string, unknown>): Promise<FastifyReply>;
    /** Renders an htmx fragment (no layout). */
    partial(name: string, data?: Record<string, unknown>): Promise<FastifyReply>;
  }
}

export function createRenderer(viewsDir: string, cache: boolean): Eta {
  // Template names are root-relative when they start with "/", e.g. include("/partials/runtime", it).
  return new Eta({ views: viewsDir, cache, autoEscape: true, useWith: false });
}

export function registerRendering(app: FastifyInstance, opts: { eta: Eta; version: string }): void {
  const base = { version: opts.version, fmt };
  async function render(this: FastifyReply, name: string, data: Record<string, unknown> = {}): Promise<FastifyReply> {
    const html = await opts.eta.renderAsync(name, { ...base, ...data });
    return this.type("text/html; charset=utf-8").send(html);
  }
  app.decorateReply("page", render);
  app.decorateReply("partial", render);
}
