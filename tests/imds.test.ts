import { afterEach, describe, expect, it } from "vitest";
import { ImdsClient, type ImdsFetch } from "../src/imds/imds-client.js";
import { TtlCache } from "../src/inventory/ttl-cache.js";
import { testApp } from "./support/app-factory.js";
import { FakeClock } from "./support/fake-clock.js";

const DOC = { instanceId: "i-0abc", instanceType: "m6i.large", availabilityZone: "us-east-1a", region: "us-east-1", accountId: "123456789012", imageId: "ami-1", privateIp: "10.0.1.5" };

interface Call { url: string; method: string; headers: Record<string, string> }

/** Scripted IMDS: answers the token PUT and the document GET; can be told to time out, error, or answer with a status. */
function fakeFetch(opts: { tokenStatus?: number; docStatus?: number; body?: string; hang?: boolean; networkError?: string } = {}) {
  const calls: Call[] = [];
  const fn: ImdsFetch = async (url, init) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {} });
    if (opts.networkError) throw Object.assign(new TypeError("fetch failed"), { cause: { code: opts.networkError } });
    if (opts.hang) {
      await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    }
    if (url.endsWith("/latest/api/token")) return { ok: (opts.tokenStatus ?? 200) < 300, status: opts.tokenStatus ?? 200, text: async () => "TOKEN123" };
    return { ok: (opts.docStatus ?? 200) < 300, status: opts.docStatus ?? 200, text: async () => opts.body ?? JSON.stringify(DOC) };
  };
  return { fn, calls };
}

describe("ImdsClient", () => {
  const client = (fetch: ImdsFetch, extra: Partial<ConstructorParameters<typeof ImdsClient>[0]> = {}) => {
    const clock = new FakeClock();
    return { clock, imds: new ImdsClient({ enabled: true, clock, cache: new TtlCache(60_000, clock), fetchFn: fetch, baseUrl: "http://imds.test", timeoutMs: 20, ...extra }) };
  };

  it("performs the IMDSv2 token exchange and maps the identity document", async () => {
    const f = fakeFetch();
    const { imds } = client(f.fn);
    expect(await imds.get()).toEqual({
      available: true, reason: null, fetched_at: "2026-01-01T00:00:00.000Z",
      instance: { instance_id: "i-0abc", instance_type: "m6i.large", availability_zone: "us-east-1a", region: "us-east-1", account_id: "123456789012", image_id: "ami-1", private_ip: "10.0.1.5" },
    });
    expect(f.calls).toEqual([
      { url: "http://imds.test/latest/api/token", method: "PUT", headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" } },
      { url: "http://imds.test/latest/dynamic/instance-identity/document", method: "GET", headers: { "X-aws-ec2-metadata-token": "TOKEN123" } },
    ]);
  });

  it("caches for the TTL and reloads on force", async () => {
    const f = fakeFetch();
    const { imds } = client(f.fn);
    await imds.get();
    await imds.get();
    expect(f.calls).toHaveLength(2);
    await imds.get(true);
    expect(f.calls).toHaveLength(4);
  });

  it.each([
    [{ hang: true }, /did not answer within \d+m?s: not running on EC2, or the pod cannot reach IMDS \(hop limit 1, EKS Auto Mode\)/],
    [{ tokenStatus: 401 }, /^IMDS token request returned 401$/],
    [{ docStatus: 404 }, /^IMDS returned 404$/],
    [{ body: "<html>" }, /^IMDS response is not a JSON object$/],
    [{ body: "[1]" }, /^IMDS response is not a JSON object$/],
    [{ networkError: "EHOSTUNREACH" }, /^IMDS not reachable: EHOSTUNREACH$/],
  ])("reports %o as unavailable", async (opts, reason) => {
    const { imds } = client(fakeFetch(opts).fn);
    const info = await imds.get();
    expect(info.available).toBe(false);
    expect(info.instance).toBeNull();
    expect(info.reason).toMatch(reason);
  });

  it("is disabled without calling anything", async () => {
    const f = fakeFetch();
    const { imds } = client(f.fn, { enabled: false });
    expect(await imds.get()).toMatchObject({ available: false, reason: "disabled (IMDS_ENABLED=false)", instance: null });
    expect(f.calls).toHaveLength(0);
  });
});

describe("IMDS routes", () => {
  let close = async () => {};
  afterEach(() => close());

  it("JSON, partial, page card, and refresh invalidation", async () => {
    const { app, imdsFetch } = await testApp();
    close = () => app.close();
    imdsFetch.document = DOC;
    const json = (await app.inject({ url: "/api/imds" })).json();
    expect(json).toMatchObject({ available: true, instance: { instance_id: "i-0abc", availability_zone: "us-east-1a" } });
    const html = (await app.inject({ url: "/partials/imds" })).body;
    expect(html).toContain("<h2>Instance metadata (IMDS)</h2>");
    expect(html).toContain("describes the <strong>node</strong>");
    expect(html).toContain("m6i.large");
    expect(html).toContain('hx-get="/partials/imds?refresh=1"');
    expect((await app.inject({ url: "/identity" })).body).toContain('data-imds-panel hx-get="/partials/imds" hx-trigger="load"');
    expect(imdsFetch.calls).toBe(2);
    await app.inject({ method: "POST", url: "/api/aws/refresh" });
    await app.inject({ url: "/api/imds" });
    expect(imdsFetch.calls).toBe(4);
  });

  it("renders unavailable as a normal state", async () => {
    const { app, imdsFetch } = await testApp();
    close = () => app.close();
    imdsFetch.mode = "hang";
    const html = (await app.inject({ url: "/partials/imds" })).body;
    expect(html).toContain("Unavailable: IMDS did not answer within 20ms: not running on EC2");
    const off = await testApp({ env: { IMDS_ENABLED: "false" } });
    expect((await off.app.inject({ url: "/partials/imds" })).body).toContain("Unavailable: disabled (IMDS_ENABLED=false)");
    await off.app.close();
  });
});
