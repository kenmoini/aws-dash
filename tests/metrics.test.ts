import { afterEach, describe, expect, it } from "vitest";
import { settingsFromEnv } from "../src/config.js";
import type { CredentialProvider } from "../src/identity/credential-provider.js";
import type { AccountInfo, ListResult } from "../src/inventory/models.js";
import { testApp } from "./support/app-factory.js";
import { FakeAwsProvider } from "./support/fake-aws-provider.js";
import { fakeCredentialProvider } from "./support/fake-credentials.js";
import { FakeRoot } from "./support/fake-root.js";
import { makeJwt } from "./support/test-jwt.js";

const scrape = async (app: Awaited<ReturnType<typeof testApp>>["app"]) => {
  const res = await app.inject({ url: "/metrics" });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("text/plain");
  return res.body;
};

describe("/metrics", () => {
  let close = async () => {};
  afterEach(() => close());

  it("exposes info, probes, load and default process metrics", async () => {
    const { app, state, cpu } = await testApp({ env: { AUTH_MODE: "static", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" } });
    close = () => app.close();
    let body = await scrape(app);
    expect(body).toMatch(/^aws_dash_info\{version="\d+\.\d+\.\d+",node_version="v\d+[^"]*",auth_mode="static"\} 1$/m);
    expect(body).toMatch(/^aws_dash_start_time_seconds 1767225600$/m);
    expect(body).toMatch(/^aws_dash_probe_live 1$/m);
    expect(body).toMatch(/^aws_dash_probe_ready 1$/m);
    expect(body).toMatch(/^aws_dash_cpu_load_workers 0$/m);
    expect(body).toMatch(/^process_cpu_seconds_total /m);
    state.live = false;
    cpu.start(1);
    body = await scrape(app);
    expect(body).toMatch(/^aws_dash_probe_live 0$/m);
    expect(body).toMatch(/^aws_dash_cpu_load_workers 1$/m);
  });

  it("reports the resolved auth mode, not the literal AUTH_MODE=auto setting", async () => {
    const { app } = await testApp({ env: { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" } });
    close = () => app.close();
    const body = await scrape(app);
    expect(body).toMatch(/^aws_dash_info\{version="\d+\.\d+\.\d+",node_version="v\d+[^"]*",auth_mode="static"\} 1$/m);
  });

  it("reports cgroup limits, or -1 when unknown", async () => {
    const root = new FakeRoot().write("sys/fs/cgroup/cgroup.controllers", "memory").write("sys/fs/cgroup/memory.max", "536870912").write("sys/fs/cgroup/memory.current", "1048576").write("sys/fs/cgroup/cpu.max", "max 100000");
    const { app } = await testApp({ fsRoot: root.path });
    close = async () => { await app.close(); root.cleanup(); };
    const body = await scrape(app);
    expect(body).toMatch(/^aws_dash_cgroup_memory_limit_bytes 536870912$/m);
    expect(body).toMatch(/^aws_dash_cgroup_memory_usage_bytes 1048576$/m);
    expect(body).toMatch(/^aws_dash_cgroup_cpu_limit_cores -1$/m);
  });

  it("records inventory fetches without calling AWS on scrape", async () => {
    const { app, aws, clock } = await testApp({ env: { AWS_CACHE_TTL_SECONDS: "1" } });
    close = () => app.close();
    await app.inject({ url: "/api/aws/vpcs" });
    const before = { ...aws.calls };
    let body = await scrape(app);
    expect(aws.calls).toEqual(before);
    expect(body).toMatch(/^aws_dash_inventory_fetch_duration_seconds_count\{kind="vpcs"\} 1$/m);
    expect(body).toMatch(/^aws_dash_inventory_last_success_timestamp_seconds\{kind="vpcs"\} \d+/m);
    expect(body).not.toMatch(/aws_dash_inventory_fetch_errors_total\{kind="vpcs"\}/);
    aws.fail("vpcs");
    clock.advance(1500);
    await app.inject({ url: "/api/aws/vpcs" });
    body = await scrape(app);
    expect(body).toMatch(/^aws_dash_inventory_fetch_errors_total\{kind="vpcs"\} 1$/m);
    expect(body).toMatch(/^aws_dash_inventory_fetch_duration_seconds_count\{kind="vpcs"\} 2$/m);
  });

  it("counts HTTP requests by route pattern", async () => {
    const { app } = await testApp();
    close = () => app.close();
    await app.inject({ url: "/healthz/live" });
    await app.inject({ url: "/api/aws/vpcs" });
    await app.inject({ url: "/nope" });
    const body = await scrape(app);
    expect(body).toMatch(/^aws_dash_http_requests_total\{method="GET",route="\/healthz\/live",status="200"\} 1$/m);
    expect(body).toMatch(/^aws_dash_http_requests_total\{method="GET",route="\/api\/aws\/:kind",status="200"\} 1$/m);
    expect(body).toMatch(/^aws_dash_http_requests_total\{method="GET",route="unmatched",status="404"\} 1$/m);
  });

  it("is disabled by METRICS_ENABLED=false", async () => {
    const { app } = await testApp({ env: { METRICS_ENABLED: "false" } });
    close = () => app.close();
    const res = await app.inject({ url: "/metrics" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ detail: "metrics are disabled (METRICS_ENABLED=false)" });
  });
});

describe("identity and access-check metrics", () => {
  let close = async () => {};
  afterEach(() => close());
  const NOW = 1_767_225_600;
  const TOKEN = makeJwt({ iss: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", sub: "system:serviceaccount:aws-dash:aws-dash", aud: "sts.amazonaws.com", iat: NOW, exp: NOW + 3600 });
  const WEB = { AWS_REGION: "us-east-1", AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/aws/token", AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/aws-dash-irsa" };

  it("report -1 until identity has been loaded, then real countdowns, without touching AWS or the token file on scrape", async () => {
    let reads = 0;
    const { app, sts } = await testApp({ env: WEB, credentials: { spec: { token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE } }, readFile: () => { reads++; return TOKEN; } });
    close = () => app.close();
    let body = await scrape(app);
    expect(body).toMatch(/^aws_dash_credential_expiry_seconds\{mode="web-identity"\} -1$/m);
    expect(body).toMatch(/^aws_dash_token_file_expiry_seconds -1$/m);
    expect(sts.calls).toBe(0);
    expect(reads).toBe(0);
    await app.inject({ url: "/api/identity" });
    body = await scrape(app);
    expect(body).toMatch(/^aws_dash_credential_expiry_seconds\{mode="web-identity"\} 3300$/m);
    expect(body).toMatch(/^aws_dash_token_file_expiry_seconds 3600$/m);
    expect(body).toMatch(/^aws_dash_credential_resolutions_total\{mode="web-identity",result="ok"\} 1$/m);
    expect(sts.calls).toBe(1);
    expect(reads).toBe(1);
  });

  it("count failed credential resolutions", async () => {
    const { app } = await testApp({ env: WEB, credentials: { spec: { token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE }, credentials: Object.assign(new Error("nope"), { name: "CredentialsProviderError" }) }, readFile: () => TOKEN });
    close = () => app.close();
    await app.inject({ url: "/api/identity" });
    expect(await scrape(app)).toMatch(/^aws_dash_credential_resolutions_total\{mode="web-identity",result="error"\} 1$/m);
  });

  it("expose the access-check matrix as 1/0 gauges per action", async () => {
    const { app, accessClients } = await testApp({ env: { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }, credentials: {} });
    close = () => app.close();
    accessClients.deny("ListBucketsCommand");
    await app.inject({ url: "/api/access-check" });
    const body = await scrape(app);
    expect(body).toMatch(/^aws_dash_access_check_allowed\{action="sts:GetCallerIdentity"\} 1$/m);
    expect(body).toMatch(/^aws_dash_access_check_allowed\{action="s3:ListAllMyBuckets"\} 0$/m);
    expect(body).toMatch(/^aws_dash_access_check_allowed\{action="iam:GetRole"\} 1$/m);
  });
});

/**
 * Resolves credentials through the same shared `CredentialProvider` the production inventory path
 * uses (`createLiveAwsProvider` calls `credentials.provider()`, and the SDK's credential middleware
 * invokes it on each request), but skips the real AWS SDK/network so the test stays hermetic.
 */
class CredentialResolvingAwsProvider extends FakeAwsProvider {
  constructor(private readonly credentials: CredentialProvider) {
    super();
  }
  override async getAccount(): Promise<ListResult<AccountInfo>> {
    await this.credentials.provider()();
    return super.getAccount();
  }
}

describe("credential metrics follow real resolutions, not just Identity-tab loads", () => {
  let close = async () => {};
  afterEach(() => close());
  const ENV = { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" };
  const env = (name: string) => (ENV as Record<string, string>)[name];

  it("resolves credentials through the inventory path alone, without ever loading /identity", async () => {
    const fake = fakeCredentialProvider(settingsFromEnv(env), env);
    const { app } = await testApp({ env: ENV, overrides: { credentials: fake.provider, createAwsProvider: () => new CredentialResolvingAwsProvider(fake.provider) } });
    close = () => app.close();
    const res = await app.inject({ url: "/api/aws/account" });
    expect(res.statusCode).toBe(200);
    const body = await scrape(app);
    expect(body).toMatch(/^aws_dash_credential_expiry_seconds\{mode="static"\} 3300$/m);
    expect(body).toMatch(/^aws_dash_credential_resolutions_total\{mode="static",result="ok"\} 1$/m);
    expect(fake.counter.resolves).toBe(1);
  });

  it("does not count a second, TTL-cached inventory load as another resolution", async () => {
    const fake = fakeCredentialProvider(settingsFromEnv(env), env);
    const { app } = await testApp({ env: ENV, overrides: { credentials: fake.provider, createAwsProvider: () => new CredentialResolvingAwsProvider(fake.provider) } });
    close = () => app.close();
    await app.inject({ url: "/api/aws/account" });
    await app.inject({ url: "/api/aws/account" });
    const body = await scrape(app);
    expect(body).toMatch(/^aws_dash_credential_resolutions_total\{mode="static",result="ok"\} 1$/m);
    expect(fake.counter.resolves).toBe(1);
  });
});
