import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "./support/app-factory.js";
import { FakeRoot } from "./support/fake-root.js";

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
