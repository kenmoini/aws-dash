import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "./support/app-factory.js";

describe("runtime page and partials", () => {
  let close = async () => {};
  afterEach(() => close());

  it("GET / renders the layout with nav, runtime poller and controls card", async () => {
    const { app } = await testApp();
    close = () => app.close();
    const res = await app.inject({ url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const html = res.body;
    expect(html).toContain("<title>Runtime · aws-dash</title>");
    expect(html).toContain('<a href="/" class="active">Runtime</a>');
    expect(html).toContain('<a href="/aws" class="">AWS</a>');
    expect(html).toContain('hx-get="/partials/runtime" hx-trigger="every 5s"');
    expect(html).toContain('id="controls"');
    expect(html).toContain('hx-post="/controls/liveness"');
    expect(html).toContain('hx-post="/controls/memory"');
    expect(html).toContain('src="/public/js/htmx.min.js"');
    expect(html).toMatch(/<span class="version">v\d+\.\d+\.\d+<\/span>/);
  });

  it("GET /partials/runtime is a fragment showing pod info from the environment", async () => {
    const { app } = await testApp({ env: { KUBERNETES_SERVICE_HOST: "10.0.0.1", POD_NAME: "aws-dash-x", POD_NAMESPACE: "demo" } });
    close = () => app.close();
    const res = await app.inject({ url: "/partials/runtime" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<html");
    expect(res.body).toContain('<dl class="kv">');
    expect(res.body).toContain("aws-dash-x");
    expect(res.body).toContain('<span class="badge ok">live: OK</span>');
  });

  it("escapes values from the environment", async () => {
    const { app } = await testApp({ env: { KUBERNETES_SERVICE_HOST: "x", POD_NAME: "<script>alert(1)</script>" } });
    close = () => app.close();
    const res = await app.inject({ url: "/partials/runtime" });
    expect(res.body).not.toContain("<script>alert");
    expect(res.body).toContain("&lt;script&gt;");
  });

  it("GET /partials/controls hides buttons when controls are disabled", async () => {
    const { app } = await testApp({ env: { CONTROLS_ENABLED: "false" } });
    close = () => app.close();
    const res = await app.inject({ url: "/partials/controls" });
    expect(res.body).toContain("Controls are disabled (CONTROLS_ENABLED=false)");
    expect(res.body).not.toContain("hx-post=");
    expect(res.body).toContain('id="control-error"');
  });

  it("GET /partials/controls polls fast while a memory load is allocating, and slower (paused while typing) otherwise", async () => {
    const { app, memory } = await testApp();
    close = () => app.close();
    const idle = await app.inject({ url: "/partials/controls" });
    expect(idle.body).toContain('hx-trigger="every 5s [');
    memory.start(2);
    const allocating = await app.inject({ url: "/partials/controls" });
    expect(allocating.body).toContain('hx-trigger="every 1s"');
    await memory.settled();
    memory.stop();
  });

  it("GET /api/runtime returns runtime info plus state as JSON", async () => {
    const { app } = await testApp();
    close = () => app.close();
    const res = await app.inject({ url: "/api/runtime" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("container_runtime");
    expect(body).toHaveProperty("cgroup.version");
    expect(body.state).toMatchObject({ live: true, ready: true });
  });

  it("serves static assets", async () => {
    const { app } = await testApp();
    close = () => app.close();
    expect((await app.inject({ url: "/public/css/site.css" })).headers["content-type"]).toContain("text/css");
    expect((await app.inject({ url: "/public/js/htmx.min.js" })).statusCode).toBe(200);
  });
});
