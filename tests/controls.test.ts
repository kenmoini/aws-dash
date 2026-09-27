import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { testApp } from "./support/app-factory.js";
import { FakeRoot } from "./support/fake-root.js";

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const post = (app: FastifyInstance, url: string, payload = "", headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload, headers: { ...FORM, ...headers } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("controls", () => {
  let close = async () => {};
  afterEach(() => close());

  it("are blocked with 403 when CONTROLS_ENABLED=false", async () => {
    const { app } = await testApp({ env: { CONTROLS_ENABLED: "false" } });
    close = () => app.close();
    for (const path of ["liveness", "readiness", "cpu", "memory", "crash"]) {
      const res = await post(app, `/controls/${path}`, "enabled=true");
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ detail: "controls are disabled (CONTROLS_ENABLED=false)" });
    }
  });

  it("liveness toggle flips the probe and returns the snapshot as JSON", async () => {
    const { app } = await testApp();
    close = () => app.close();
    const off = await post(app, "/controls/liveness", "enabled=false");
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ live: false, ready: true });
    expect((await app.inject({ url: "/healthz/live" })).statusCode).toBe(503);
    const on = await post(app, "/controls/liveness?enabled=true");
    expect(on.json().live).toBe(true);
    expect((await app.inject({ url: "/healthz/live" })).statusCode).toBe(200);
  });

  it("readiness toggle works and rejects bad input with 422", async () => {
    const { app } = await testApp();
    close = () => app.close();
    expect((await post(app, "/controls/readiness", "enabled=off")).json().ready).toBe(false);
    expect((await app.inject({ url: "/healthz/ready" })).statusCode).toBe(503);
    const bad = await post(app, "/controls/readiness", "enabled=maybe");
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toEqual({ detail: "'enabled' must be true or false" });
    expect((await post(app, "/controls/readiness")).statusCode).toBe(422);
  });

  it("returns the re-rendered controls card for htmx requests", async () => {
    const { app } = await testApp();
    close = () => app.close();
    const res = await post(app, "/controls/liveness", "enabled=false", { "hx-request": "true" });
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('id="controls"');
    expect(res.body).toContain("Restore liveness");
  });

  it("cpu clamps workers to the available cores and validates the range", async () => {
    const { app, workers } = await testApp();
    close = () => app.close();
    const res = await post(app, "/controls/cpu", "enabled=true&workers=64");
    expect(res.json().cpu_load).toEqual({ active: true, workers: 2 });
    expect(workers.created).toHaveLength(2);
    expect((await post(app, "/controls/cpu", "enabled=true&workers=0")).statusCode).toBe(422);
    expect((await post(app, "/controls/cpu", "enabled=true&workers=65")).json()).toEqual({ detail: "'workers' must be an integer between 1 and 64" });
    expect((await post(app, "/controls/cpu", "enabled=false")).json().cpu_load).toEqual({ active: false, workers: 0 });
  });

  it("memory allocates, warns when the target exceeds the cgroup limit, and releases", async () => {
    const root = new FakeRoot().write("sys/fs/cgroup/cgroup.controllers", "memory").write("sys/fs/cgroup/memory.max", String(1024 * 1024));
    const { app, memory } = await testApp({ fsRoot: root.path });
    close = async () => { await app.close(); root.cleanup(); };
    const res = await post(app, "/controls/memory", "enabled=true&mib=2", { "hx-request": "true" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("exceeds the cgroup limit");
    expect(res.body).toContain('class="progress"');
    await memory.settled();
    expect(memory.status()).toMatchObject({ active: true, allocated_mib: 2, phase: "holding" });
    expect((await post(app, "/controls/memory", "enabled=true&mib=1")).statusCode).toBe(409);
    const off = await post(app, "/controls/memory", "enabled=false");
    expect(off.json().memory_load).toMatchObject({ active: false, allocated_mib: 0 });
  });

  it("memory validates mib against MEMORY_LOAD_MAX_MIB", async () => {
    const { app } = await testApp({ env: { MEMORY_LOAD_MAX_MIB: "8" } });
    close = () => app.close();
    expect((await post(app, "/controls/memory", "enabled=true&mib=0")).statusCode).toBe(422);
    const big = await post(app, "/controls/memory", "enabled=true&mib=9");
    expect(big.statusCode).toBe(422);
    expect(big.json()).toEqual({ detail: "'mib' must be an integer between 1 and 8" });
  });

  it("crash answers 202, stops loads, then exits with the requested code", async () => {
    const { app, exit, cpu, memory } = await testApp();
    close = () => app.close();
    cpu.start(1);
    memory.start(1);
    await memory.settled();
    const res = await post(app, "/controls/crash", "exit_code=3");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ message: "exiting with code 3", exit_code: 3 });
    expect(exit.codes).toEqual([]);
    await sleep(60);
    expect(exit.codes).toEqual([3]);
    expect(cpu.status().active).toBe(false);
    expect(memory.status().active).toBe(false);
  });

  it("crash defaults to exit code 1, rejects 256, and renders a badge for htmx", async () => {
    const { app, exit } = await testApp();
    close = () => app.close();
    expect((await post(app, "/controls/crash", "exit_code=256")).statusCode).toBe(422);
    const hx = await post(app, "/controls/crash", "", { "hx-request": "true" });
    expect(hx.statusCode).toBe(202);
    expect(hx.body).toBe('<span class="badge bad">Exiting with code 1…</span>');
    await sleep(60);
    expect(exit.codes).toEqual([1]);
  });

  it("crash still exits when stopping the CPU load fails", async () => {
    const { app, exit, cpu, memory } = await testApp();
    close = () => app.close();
    memory.start(1);
    await memory.settled();
    const original = cpu.stop.bind(cpu);
    cpu.stop = async () => { throw new Error("terminate failed"); };
    const res = await post(app, "/controls/crash", "exit_code=7");
    expect(res.statusCode).toBe(202);
    await sleep(60);
    expect(exit.codes).toEqual([7]);
    expect(memory.status().active).toBe(false);
    cpu.stop = original;
  });
});
