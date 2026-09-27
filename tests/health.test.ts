import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "./support/app-factory.js";

describe("health endpoints", () => {
  let close = async () => {};
  afterEach(() => close());

  it("report ok while healthy", async () => {
    const { app } = await testApp();
    close = () => app.close();
    for (const path of ["/healthz/live", "/healthz/ready"]) {
      const res = await app.inject({ method: "GET", url: path });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json()).toEqual({ status: "ok" });
    }
  });

  it("return 503 with a reason when a probe is disabled", async () => {
    const { app, state } = await testApp();
    close = () => app.close();
    state.live = false;
    expect((await app.inject({ url: "/healthz/live" })).json()).toEqual({ status: "failing", reason: "liveness disabled via controls" });
    expect((await app.inject({ url: "/healthz/live" })).statusCode).toBe(503);
    expect((await app.inject({ url: "/healthz/ready" })).statusCode).toBe(200);
    state.ready = false;
    const ready = await app.inject({ url: "/healthz/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().reason).toBe("readiness disabled via controls");
  });

  it("GET /api/state returns the snapshot", async () => {
    const { app, clock } = await testApp();
    close = () => app.close();
    clock.advance(5000);
    const res = await app.inject({ url: "/api/state" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ live: true, ready: true, uptime_seconds: 5, controls_enabled: true, cpu_load: { active: false } });
  });

  it("unknown routes return JSON 404", async () => {
    const { app } = await testApp();
    close = () => app.close();
    const res = await app.inject({ url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ detail: "not found: GET /nope" });
  });

  it("stops CPU and memory load on close", async () => {
    const { app, cpu, memory } = await testApp();
    cpu.start(1);
    memory.start(1);
    await memory.settled();
    await app.close();
    expect(cpu.status().active).toBe(false);
    expect(memory.status().active).toBe(false);
  });
});
