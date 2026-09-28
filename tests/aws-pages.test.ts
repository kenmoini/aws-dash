import { afterEach, describe, expect, it } from "vitest";
import { AwsError } from "../src/aws/aws-error.js";
import { testApp } from "./support/app-factory.js";

const KINDS = ["account", "instances", "vpcs", "subnets", "securitygroups", "s3buckets", "eksclusters", "ecrrepos"];

describe("AWS page and panels", () => {
  let close = async () => {};
  afterEach(() => close());

  it("GET /aws renders the header card and eight lazy panels", async () => {
    const { app } = await testApp({ env: { AWS_REGION: "eu-west-1", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" } });
    close = () => app.close();
    const res = await app.inject({ url: "/aws" });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain("<title>AWS · aws-dash</title>");
    expect(html).toContain('<a href="/aws" class="active">AWS</a>');
    expect(html).toContain('hx-post="/api/aws/refresh"');
    expect(html).toContain("eu-west-1");
    expect(html).toContain("static — auto: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set");
    for (const kind of KINDS) expect(html).toContain(`data-aws-panel hx-get="/partials/aws/${kind}" hx-trigger="load, refresh"`);
    expect(html).toContain("Security group rules");
  });

  it("shows a hint when the region is unset", async () => {
    const { app } = await testApp();
    close = () => app.close();
    expect((await app.inject({ url: "/aws" })).body).toContain("not set (AWS_REGION)");
  });

  it("every kind renders a table or key/value list", async () => {
    const { app } = await testApp();
    close = () => app.close();
    for (const kind of KINDS) {
      const res = await app.inject({ url: `/partials/aws/${kind}` });
      expect(res.statusCode, kind).toBe(200);
      expect(res.body, kind).not.toContain("<html");
      expect(res.body, kind).toMatch(/<table|<dl class="kv">/);
      expect(res.body, kind).toContain("Fetched 2026-01-01 00:00:00 UTC");
      expect(res.body, kind).toContain(`hx-get="/partials/aws/${kind}?refresh=1"`);
    }
  });

  it("renders fixture rows with escaping", async () => {
    const { app, aws } = await testApp();
    close = () => app.close();
    aws.instances.items[0]!.name = "<script>x</script>";
    const res = await app.inject({ url: "/partials/aws/instances" });
    expect(res.body).toContain("i-0abc");
    expect(res.body).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(res.body).not.toContain("<script>x");
    const account = await app.inject({ url: "/partials/aws/account" });
    expect(account.body).toContain("123456789012");
    expect(account.body).toContain("kemo-lab");
  });

  it("shows the stale banner when a refresh fails after a good load", async () => {
    const { app, aws, clock } = await testApp({ env: { AWS_CACHE_TTL_SECONDS: "1" } });
    close = () => app.close();
    await app.inject({ url: "/partials/aws/vpcs" });
    aws.fail("vpcs");
    clock.advance(1500);
    const res = await app.inject({ url: "/partials/aws/vpcs?refresh=1" });
    expect(res.body).toContain('<div class="error">AccessDenied: Access Denied — grant the identity the read-only policy');
    expect(res.body).toContain("vpc-1");
    expect(res.body).toContain("Last attempt 2026-01-01 00:00:01 UTC failed; showing previously cached data");
  });

  it("shows only the error when the first load fails, and 'None found.' for empty lists", async () => {
    const { app, aws } = await testApp();
    close = () => app.close();
    aws.fail("subnets");
    const failed = await app.inject({ url: "/partials/aws/subnets" });
    expect(failed.body).toContain('<div class="error">');
    expect(failed.body).toContain("Last attempt 2026-01-01 00:00:00 UTC failed");
    expect(failed.body).not.toContain("previously cached");
    expect(failed.body).not.toContain("<table");
    aws.ecrrepos.items = [];
    expect((await app.inject({ url: "/partials/aws/ecrrepos" })).body).toContain("None found.");
  });

  it("flags truncated listings", async () => {
    const { app, aws } = await testApp();
    close = () => app.close();
    aws.s3buckets.truncated = true;
    expect((await app.inject({ url: "/partials/aws/s3buckets" })).body).toContain("Showing the first 1 items only.");
  });

  it("returns 404 for an unknown kind and surfaces provider construction errors in the panel", async () => {
    const { app } = await testApp({ overrides: { createAwsProvider: () => { throw new AwsError("AWS_REGION is not set; set it in the ConfigMap"); } } });
    close = () => app.close();
    expect((await app.inject({ url: "/partials/aws/nope" })).statusCode).toBe(404);
    const res = await app.inject({ url: "/partials/aws/account" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("AWS_REGION is not set");
  });
});
