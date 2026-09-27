import { describe, expect, it } from "vitest";
import { localProbeUrl, main, selfProbe } from "../src/cli.js";
import { testApp } from "./support/app-factory.js";

describe("cli --healthcheck", () => {
  it("builds the probe URL from PORT", () => {
    expect(localProbeUrl(() => undefined)).toBe("http://127.0.0.1:8080/healthz/live");
    expect(localProbeUrl((n) => (n === "PORT" ? "9000" : undefined))).toBe("http://127.0.0.1:9000/healthz/live");
  });

  it("returns 0 on 2xx, 1 otherwise, and prints one line", async () => {
    const lines: string[] = [];
    const ok = await selfProbe("http://x/healthz/live", async () => ({ ok: true, status: 200 }), (l) => lines.push(l));
    const bad = await selfProbe("http://x/healthz/live", async () => ({ ok: false, status: 503 }), (l) => lines.push(l));
    const down = await selfProbe("http://x/healthz/live", async () => { throw new Error("ECONNREFUSED"); }, (l) => lines.push(l));
    expect([ok, bad, down]).toEqual([0, 1, 1]);
    expect(lines).toEqual(["200 http://x/healthz/live", "503 http://x/healthz/live", "unhealthy: ECONNREFUSED"]);
  });

  it("main() prints usage and returns 2 without --healthcheck", async () => {
    const lines: string[] = [];
    expect(await main([], () => undefined, (l) => lines.push(l))).toBe(2);
    expect(lines[0]).toContain("--healthcheck");
  });

  it("probes a real listening app", async () => {
    const { app, state } = await testApp();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const lines: string[] = [];
      expect(await selfProbe(`${address}/healthz/live`, fetch, (l) => lines.push(l))).toBe(0);
      state.live = false;
      expect(await selfProbe(`${address}/healthz/live`, fetch, (l) => lines.push(l))).toBe(1);
    } finally {
      await app.close();
    }
  });
});
