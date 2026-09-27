import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.js";
import { MemoryLoadActiveError } from "../load/memory-load.js";
import { errorBody } from "./errors.js";
import { isHtmx } from "./htmx.js";
import { inputBool, inputInt, readInput, type Input } from "./input.js";
import { controlsView } from "./runtime.js";

export function registerControlRoutes(app: FastifyInstance, deps: AppDeps): void {
  const respond = (req: FastifyRequest, reply: FastifyReply) =>
    isHtmx(req) ? reply.partial("partials/controls", controlsView(deps)) : reply.send(deps.stateService.snapshot());
  const unprocessable = (reply: FastifyReply, detail: string) => reply.code(422).send(errorBody(detail));
  const enabledOr422 = (input: Input, reply: FastifyReply): boolean | undefined => {
    const enabled = inputBool(input, "enabled");
    if (enabled === undefined) void unprocessable(reply, "'enabled' must be true or false");
    return enabled;
  };

  // Encapsulated plugin so the 403 gate applies only to /controls/*.
  void app.register(async (ctl) => {
    ctl.addHook("preHandler", async (_req, reply) => {
      if (!deps.settings.controlsEnabled) return reply.code(403).send(errorBody("controls are disabled (CONTROLS_ENABLED=false)"));
      return undefined;
    });

    ctl.post("/controls/liveness", async (req, reply) => {
      const enabled = enabledOr422(readInput(req), reply);
      if (enabled === undefined) return reply;
      deps.state.live = enabled;
      return respond(req, reply);
    });

    ctl.post("/controls/readiness", async (req, reply) => {
      const enabled = enabledOr422(readInput(req), reply);
      if (enabled === undefined) return reply;
      deps.state.ready = enabled;
      return respond(req, reply);
    });

    ctl.post("/controls/cpu", async (req, reply) => {
      const input = readInput(req);
      const enabled = enabledOr422(input, reply);
      if (enabled === undefined) return reply;
      if (enabled) {
        const workers = inputInt(input, "workers", 1, 1, 64);
        if (workers === undefined) return unprocessable(reply, "'workers' must be an integer between 1 and 64");
        deps.cpu.start(workers);
      } else {
        await deps.cpu.stop();
      }
      return respond(req, reply);
    });

    ctl.post("/controls/memory", async (req, reply) => {
      const input = readInput(req);
      const enabled = enabledOr422(input, reply);
      if (enabled === undefined) return reply;
      if (enabled) {
        const max = deps.settings.memoryLoadMaxMib;
        const mib = inputInt(input, "mib", Math.min(256, max), 1, max);
        if (mib === undefined) return unprocessable(reply, `'mib' must be an integer between 1 and ${max}`);
        try {
          deps.memory.start(mib);
        } catch (err) {
          if (err instanceof MemoryLoadActiveError) return reply.code(409).send(errorBody(err.message));
          throw err;
        }
      } else {
        deps.memory.stop();
      }
      return respond(req, reply);
    });

    ctl.post("/controls/crash", async (req, reply) => {
      const code = inputInt(readInput(req), "exit_code", 1, 0, 255);
      if (code === undefined) return unprocessable(reply, "'exit_code' must be an integer between 0 and 255");
      setTimeout(() => {
        void deps.cpu.stop()
          .catch((err: unknown) => req.log.warn({ err }, "cpu load did not stop cleanly before crash"))
          .then(() => {
            deps.memory.stop();
            deps.exit(code);
          });
      }, deps.crashDelayMs);
      reply.code(202);
      return isHtmx(req)
        ? reply.type("text/html; charset=utf-8").send(`<span class="badge bad">Exiting with code ${code}…</span>`)
        : reply.send({ message: `exiting with code ${code}`, exit_code: code });
    });
  });
}
