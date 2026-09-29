import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/inventory/ttl-cache.js";
import { FakeClock } from "./support/fake-clock.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("TtlCache", () => {
  it("serves a fresh value from cache and reloads after the TTL", async () => {
    const clock = new FakeClock();
    const cache = new TtlCache(60_000, clock);
    let calls = 0;
    const loader = async () => ({ n: ++calls });
    expect(await cache.get("k", loader)).toEqual({ value: { n: 1 }, fetched_at: "2026-01-01T00:00:00.000Z", error: null });
    expect(await cache.get("k", loader)).toMatchObject({ value: { n: 1 } });
    clock.advance(59_999);
    expect((await cache.get("k", loader)).value).toEqual({ n: 1 });
    clock.advance(2);
    expect((await cache.get("k", loader)).value).toEqual({ n: 2 });
  });

  it("force bypasses a fresh entry", async () => {
    const cache = new TtlCache(60_000, new FakeClock());
    let calls = 0;
    const loader = async () => ++calls;
    await cache.get("k", loader);
    expect((await cache.get("k", loader, true)).value).toBe(2);
  });

  it("is single-flight per key: concurrent callers share one load", async () => {
    const cache = new TtlCache(60_000, new FakeClock());
    const gate = deferred<string>();
    let calls = 0;
    const loader = () => { calls++; return gate.promise; };
    const a = cache.get("k", loader);
    const b = cache.get("k", loader);
    gate.resolve("v");
    expect((await a).value).toBe("v");
    expect((await b).value).toBe("v");
    expect(calls).toBe(1);
  });

  it("keeps the last good value when a reload fails and records the error", async () => {
    const clock = new FakeClock();
    const cache = new TtlCache(1000, clock, (err) => `translated: ${(err as Error).message}`);
    await cache.get("k", async () => ["good"]);
    clock.advance(2000);
    const entry = await cache.get("k", async () => { throw new Error("boom"); });
    expect(entry).toEqual({ value: ["good"], fetched_at: "2026-01-01T00:00:02.000Z", error: "translated: boom" });
    // the failure is cached for the TTL too, so panels do not hammer a broken API
    let calls = 0;
    expect((await cache.get("k", async () => { calls++; return ["new"]; })).error).toBe("translated: boom");
    expect(calls).toBe(0);
  });

  it("does not cache a failed first load: the next get retries instead of serving the error for the TTL", async () => {
    const cache = new TtlCache(1000, new FakeClock());
    expect(await cache.get("k", async () => { throw new Error("nope"); })).toEqual({ value: null, fetched_at: "2026-01-01T00:00:00.000Z", error: "nope" });
    expect(cache.peek("k")).toEqual({ value: null, fetched_at: "2026-01-01T00:00:00.000Z", error: "nope" });
    let calls = 0;
    expect(await cache.get("k", async () => { calls++; return ["now"]; })).toEqual({ value: ["now"], fetched_at: "2026-01-01T00:00:00.000Z", error: null });
    expect(calls).toBe(1);
  });

  it("concurrent callers during a failing first load share the one attempt", async () => {
    const cache = new TtlCache(1000, new FakeClock());
    let calls = 0;
    const loader = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); throw new Error("nope"); };
    const [a, b] = await Promise.all([cache.get("k", loader), cache.get("k", loader)]);
    expect(a.error).toBe("nope");
    expect(b).toEqual(a);
    expect(calls).toBe(1);
  });

  it("a second consecutive first-load failure is also left unfresh", async () => {
    const cache = new TtlCache(1000, new FakeClock());
    let calls = 0;
    const loader = async () => { calls++; throw new Error(`nope ${calls}`); };
    expect((await cache.get("k", loader)).error).toBe("nope 1");
    expect((await cache.get("k", loader)).error).toBe("nope 2");
    expect((await cache.get("k", loader)).error).toBe("nope 3");
    expect(calls).toBe(3);
  });

  it("invalidateAll expires entries and discards a load that started before it", async () => {
    const cache = new TtlCache(60_000, new FakeClock());
    const gate = deferred<string>();
    let calls = 0;
    const slow = () => { calls++; return gate.promise; };
    const pending = cache.get("k", slow);
    cache.invalidateAll();
    gate.resolve("stale");
    expect((await pending).value).toBe("stale"); // the caller that waited still gets its answer
    expect((await cache.get("k", async () => "fresh")).value).toBe("fresh"); // but nothing was stored
    expect(calls).toBe(1);
  });

  it("invalidateAll keeps the last good value for a reload that fails", async () => {
    const cache = new TtlCache(60_000, new FakeClock());
    await cache.get("k", async () => ["good"]);
    cache.invalidateAll();
    let calls = 0;
    const entry = await cache.get("k", async () => { calls++; throw new Error("denied"); });
    expect(calls).toBe(1);
    expect(entry).toEqual({ value: ["good"], fetched_at: "2026-01-01T00:00:00.000Z", error: "denied" });
  });

  it("force while a load is in flight waits for it, then loads again", async () => {
    const cache = new TtlCache(60_000, new FakeClock());
    const gate = deferred<number>();
    let calls = 0;
    const loader = () => { calls++; return calls === 1 ? gate.promise : Promise.resolve(99); };
    const first = cache.get("k", loader);
    const forced = cache.get("k", loader, true);
    gate.resolve(1);
    expect((await first).value).toBe(1);
    expect((await forced).value).toBe(99);
    expect(calls).toBe(2);
  });

  it("peek returns the stored entry (even when stale) without loading, or null", async () => {
    const clock = new FakeClock();
    const cache = new TtlCache(1000, clock);
    expect(cache.peek("k")).toBeNull();
    await cache.get("k", async () => "v");
    clock.advance(5000);
    expect(cache.peek<string>("k")).toEqual({ value: "v", fetched_at: "2026-01-01T00:00:00.000Z", error: null });
  });
});
