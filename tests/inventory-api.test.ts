import { afterEach, describe, expect, it } from "vitest";
import { AwsError } from "../src/aws/aws-error.js";
import { testApp } from "./support/app-factory.js";

describe("inventory JSON API", () => {
  let close = async () => {};
  afterEach(() => close());

  it("serves a kind, caches it, and honours ?refresh=true", async () => {
    const { app, aws } = await testApp();
    close = () => app.close();
    const res = await app.inject({ url: "/api/aws/instances" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: "instances", fetched_at: "2026-01-01T00:00:00.000Z", error: null, truncated: false,
      items: [expect.objectContaining({ id: "i-0abc", name: "web-1" })],
    });
    await app.inject({ url: "/api/aws/instances" });
    expect(aws.calls.instances).toBe(1);
    await app.inject({ url: "/api/aws/instances?refresh=true" });
    expect(aws.calls.instances).toBe(2);
  });

  it("returns 404 JSON for an unknown kind", async () => {
    const { app } = await testApp();
    close = () => app.close();
    const res = await app.inject({ url: "/api/aws/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ detail: "unknown kind 'nope'" });
  });

  it("POST /api/aws/refresh invalidates every kind", async () => {
    const { app, aws } = await testApp();
    close = () => app.close();
    await app.inject({ url: "/api/aws/vpcs" });
    const res = await app.inject({ method: "POST", url: "/api/aws/refresh" });
    expect(res.statusCode).toBe(204);
    await app.inject({ url: "/api/aws/vpcs" });
    expect(aws.calls.vpcs).toBe(2);
  });

  it("a failing kind keeps its last good items and does not affect other kinds", async () => {
    const { app, aws, clock } = await testApp({ env: { AWS_CACHE_TTL_SECONDS: "1" } });
    close = () => app.close();
    await app.inject({ url: "/api/aws/instances" });
    aws.fail("instances");
    clock.advance(1500);
    const failed = (await app.inject({ url: "/api/aws/instances" })).json();
    expect(failed.error).toMatch(/^AccessDenied: Access Denied — grant the identity the read-only policy/);
    expect(failed.items).toHaveLength(1);
    expect(failed.fetched_at).toBe("2026-01-01T00:00:01.500Z");
    const vpcs = (await app.inject({ url: "/api/aws/vpcs" })).json();
    expect(vpcs.error).toBeNull();
    expect(vpcs.items).toHaveLength(1);
  });

  it("a provider that cannot be built reports the error in every kind and is retried on the next request", async () => {
    let attempts = 0;
    const { app } = await testApp({ overrides: { createAwsProvider: () => { attempts++; throw new AwsError("AUTH_MODE web-identity requires AWS_ROLE_ARN"); } } });
    close = () => app.close();
    const a = (await app.inject({ url: "/api/aws/account" })).json();
    expect(a).toMatchObject({ kind: "account", error: "AUTH_MODE web-identity requires AWS_ROLE_ARN", items: null, truncated: false });
    const b = (await app.inject({ url: "/api/aws/vpcs" })).json();
    expect(b.error).toBe("AUTH_MODE web-identity requires AWS_ROLE_ARN");
    expect(attempts).toBe(2);
  });

  it("all eight kinds answer", async () => {
    const { app } = await testApp();
    close = () => app.close();
    for (const kind of ["account", "instances", "vpcs", "subnets", "securitygroups", "s3buckets", "eksclusters", "ecrrepos"]) {
      const res = await app.inject({ url: `/api/aws/${kind}` });
      expect(res.statusCode, kind).toBe(200);
      expect(res.json().items, kind).toHaveLength(1);
    }
  });
});
