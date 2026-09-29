import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { SpiffePanel, summarizeX509 } from "../src/identity/spiffe-panel.js";
import { TtlCache } from "../src/inventory/ttl-cache.js";
import { testApp } from "./support/app-factory.js";
import { FakeClock } from "./support/fake-clock.js";
import { FakeWorkloadApi, FIXTURE_CERT, FIXTURE_DER, FIXTURE_PEM_BODY, FIXTURE_SPIFFE_ID, NOW, rpcError } from "./support/fake-workload-api.js";
import { makeJwt, TEST_SIGNATURE } from "./support/test-jwt.js";

const SOCKET = "unix:///spiffe-workload-api/spire-agent.sock";

// A trailing default parameter can't distinguish "omitted" from "explicitly undefined" (both trigger
// the default), so the no-socket test below needs a rest tuple instead to force a real `undefined` through.
function panel(api: FakeWorkloadApi, ...socketArg: [string | undefined] | []) {
  const socket = socketArg.length > 0 ? socketArg[0] : SOCKET;
  const clock = new FakeClock();
  const created: string[] = [];
  const p = new SpiffePanel({
    socket, audience: "aws-dash", clock, cache: new TtlCache(60_000, clock), timeoutMs: 20,
    createApi: (s, timeoutMs) => { created.push(`${s}|${timeoutMs}`); return api; },
  });
  return { p, clock, created };
}

describe("summarizeX509", () => {
  it("reads the leaf of a DER chain with Node's X509Certificate", () => {
    const s = summarizeX509({ spiffe_id: FIXTURE_SPIFFE_ID, certificate: new Uint8Array([...FIXTURE_DER, ...FIXTURE_DER]), hint: "" }, new Date("2026-01-01T00:00:00Z"));
    expect(s).toEqual({
      spiffe_id: FIXTURE_SPIFFE_ID,
      san_uris: [FIXTURE_SPIFFE_ID],
      serial: FIXTURE_CERT.serialNumber,
      issuer: "O=SPIRE, C=US",
      not_before: FIXTURE_CERT.validFromDate.toISOString(),
      not_after: FIXTURE_CERT.validToDate.toISOString(),
      expires_in_seconds: Math.floor((FIXTURE_CERT.validToDate.getTime() - Date.UTC(2026, 0, 1)) / 1000),
    });
  });
});

describe("SpiffePanel", () => {
  it("is unavailable without a socket and never opens the Workload API", async () => {
    const api = new FakeWorkloadApi();
    const { p, created } = panel(api, undefined);
    const info = await p.get();
    expect(info.available).toBe(false);
    expect(info.reason).toContain("SPIFFE_ENDPOINT_SOCKET is not set");
    expect(info.socket).toBeNull();
    expect(created).toEqual([]);
    expect(api.calls).toEqual({ x509: 0, jwt: 0, close: 0 });
  });

  it("summarises both SVIDs, passes socket, deadline and audience through, and closes the channel once", async () => {
    const api = new FakeWorkloadApi();
    const { p, created } = panel(api);
    const info = await p.get();
    expect(created).toEqual([`${SOCKET}|20`]);
    expect(api.audiences).toEqual(["aws-dash"]);
    expect(info.available).toBe(true);
    expect(info.socket).toBe(SOCKET);
    expect(info.x509?.spiffe_id).toBe(FIXTURE_SPIFFE_ID);
    expect(info.x509_error).toBeNull();
    expect(info.jwt).toMatchObject({ spiffe_id: FIXTURE_SPIFFE_ID, audience: "aws-dash", error: null, expires_at: "2026-01-01T00:05:00.000Z",
      claims: { iss: "https://oidc-discovery.apps.example.org", sub: FIXTURE_SPIFFE_ID, aud: "aws-dash" } });
    expect(info.fetched_at).toBe("2026-01-01T00:00:00.000Z");
    expect(api.calls).toEqual({ x509: 1, jwt: 1, close: 1 });
    const json = JSON.stringify(info);
    for (const secret of [api.token, TEST_SIGNATURE, FIXTURE_PEM_BODY]) expect(json, secret.slice(0, 20)).not.toContain(secret);
  });

  it("is unavailable when both fetches fail, with the agent hint, and still closes the channel", async () => {
    const api = new FakeWorkloadApi();
    api.x509Error = rpcError("UNAVAILABLE", "No connection established");
    api.jwtError = rpcError("UNAVAILABLE", "No connection established");
    const { p } = panel(api);
    const info = await p.get();
    expect(info.available).toBe(false);
    expect(info.reason).toBe(`SPIRE agent not reachable at ${SOCKET}: is the csi.spiffe.io volume mounted and the agent running? (No connection established)`);
    expect(info.x509).toBeNull();
    expect(info.jwt).toBeNull();
    expect(api.calls.close).toBe(1);
  });

  it("keeps the X.509 section when only the JWT-SVID fetch fails", async () => {
    const api = new FakeWorkloadApi();
    api.jwtError = rpcError("PERMISSION_DENIED", "no identity issued");
    const { p } = panel(api);
    const info = await p.get();
    expect(info.available).toBe(true);
    expect(info.x509?.spiffe_id).toBe(FIXTURE_SPIFFE_ID);
    expect(info.jwt).toMatchObject({ spiffe_id: null, audience: "aws-dash", claims: {}, error: expect.stringContaining("no registration entry matches this pod") });
  });

  it("reports a garbage certificate as the X.509 error without throwing", async () => {
    const api = new FakeWorkloadApi();
    api.certificate = new Uint8Array([1, 2, 3]);
    const { p } = panel(api);
    const info = await p.get();
    expect(info.available).toBe(true);
    expect(info.x509).toBeNull();
    expect(info.x509_error).toBeTruthy();
    expect(info.jwt?.error).toBeNull();
  });

  it("is unavailable, and never rejects, when the factory itself throws (e.g. an unparseable target)", async () => {
    const clock = new FakeClock();
    const p = new SpiffePanel({
      socket: SOCKET, audience: "aws-dash", clock, cache: new TtlCache(60_000, clock), timeoutMs: 20,
      createApi: () => { throw new Error('Could not parse target name ""'); },
    });
    const info = await p.get();
    expect(info.available).toBe(false);
    expect(info.reason).toContain('Could not parse target name ""');
  });

  it("fetches the X.509 and JWT SVIDs concurrently, so one slow call does not serialise the other", async () => {
    const api = new FakeWorkloadApi();
    let releaseX509!: () => void;
    const jwtStarted = new Promise<void>((resolve) => { releaseX509 = resolve; });
    const baseX509 = api.fetchX509.bind(api);
    const baseJwt = api.fetchJwt.bind(api);
    api.fetchX509 = async () => { await jwtStarted; return baseX509(); }; // completes only once the JWT fetch has begun
    api.fetchJwt = async (aud) => { releaseX509(); return baseJwt(aud); };
    const { p } = panel(api);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("sequential fetches deadlocked")), 500); });
    try {
      const info = await Promise.race([p.get(), deadline]);
      expect(info.available).toBe(true);
      expect(info.x509?.spiffe_id).toBe(FIXTURE_SPIFFE_ID);
      expect(info.jwt?.error).toBeNull();
    } finally {
      clearTimeout(timer);
    }
    expect(api.calls.close).toBe(1);
  });

  it("recomputes expires_in_seconds on every get while the cached entry ages", async () => {
    const api = new FakeWorkloadApi();
    const { p, clock } = panel(api);
    const first = (await p.get()).x509!.expires_in_seconds;
    clock.advance(10_000);
    expect((await p.get()).x509!.expires_in_seconds).toBe(first - 10);
    expect(api.calls.x509).toBe(1);
  });

  it("caches for the TTL, force reloads, and invalidateAll expires", async () => {
    const api = new FakeWorkloadApi();
    const { p, clock } = panel(api);
    await p.get();
    await p.get();
    expect(api.calls.x509).toBe(1);
    await p.get(true);
    expect(api.calls.x509).toBe(2);
    clock.advance(61_000);
    await p.get();
    expect(api.calls.x509).toBe(3);
    p.invalidateAll();
    await p.get();
    expect(api.calls.x509).toBe(4);
    expect(p.peek()?.available).toBe(true);
  });
});

describe("SPIFFE routes", () => {
  let close = async () => {};
  afterEach(() => close());
  const ZTWIM = { AWS_REGION: "us-east-1", SPIFFE_ENDPOINT_SOCKET: SOCKET, SPIFFE_JWT_AUDIENCE: "aws-dash", AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/aws/token", AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/aws-dash-ztwim" };
  const stsToken = makeJwt({ iss: "https://oidc-discovery.apps.example.org", sub: FIXTURE_SPIFFE_ID, aud: "aws-dash", iat: NOW, exp: NOW + 300 });

  it("GET /api/spiffe returns JSON and GET /identity carries the card", async () => {
    const { app } = await testApp({ env: ZTWIM });
    close = () => app.close();
    const res = await app.inject({ url: "/api/spiffe" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true, socket: SOCKET, x509: { spiffe_id: FIXTURE_SPIFFE_ID }, jwt: { audience: "aws-dash" } });
    expect((await app.inject({ url: "/identity" })).body).toContain('data-spiffe-panel hx-get="/partials/spiffe" hx-trigger="load"');
  });

  it("the partial shows both SVIDs, the same-as-token badge, and never raw material", async () => {
    const { app, workloadApi } = await testApp({ env: ZTWIM, credentials: { spec: { credential_type: "fromTokenFile → sts:AssumeRoleWithWebIdentity", role_arn: ZTWIM.AWS_ROLE_ARN, token_file: ZTWIM.AWS_WEB_IDENTITY_TOKEN_FILE } }, readFile: () => stsToken });
    close = () => app.close();
    await app.inject({ url: "/api/identity" });
    const html = (await app.inject({ url: "/partials/spiffe" })).body;
    for (const text of ["SPIFFE workload identity", "X.509-SVID", FIXTURE_SPIFFE_ID, "same as the token sub presented to STS", "JWT-SVID for audience", "aws-dash",
      "Raw SVIDs", 'hx-get="/partials/spiffe?refresh=1"', "expires</dt><dd>2026-01-01 00:05:00 UTC (in "]) {
      expect(html, text).toContain(text);
    }
    for (const secret of [workloadApi.token, stsToken, TEST_SIGNATURE, FIXTURE_PEM_BODY]) expect(html, secret.slice(0, 20)).not.toContain(secret);
  });

  it("shows the same-as-token-sub badge on the very first /partials/spiffe load, without pre-warming identity", async () => {
    const { app } = await testApp({ env: ZTWIM, credentials: { spec: { credential_type: "fromTokenFile → sts:AssumeRoleWithWebIdentity", role_arn: ZTWIM.AWS_ROLE_ARN, token_file: ZTWIM.AWS_WEB_IDENTITY_TOKEN_FILE } }, readFile: () => stsToken });
    close = () => app.close();
    const html = (await app.inject({ url: "/partials/spiffe" })).body;
    expect(html).toContain("same as the token sub presented to STS");
  });

  it("shows 'differs' when the STS token sub is another identity, and Unavailable without a socket", async () => {
    const other = makeJwt({ iss: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", sub: "system:serviceaccount:aws-dash:aws-dash", aud: "sts.amazonaws.com", iat: NOW, exp: NOW + 3600 });
    const { app } = await testApp({ env: ZTWIM, credentials: { spec: { credential_type: "fromTokenFile", role_arn: ZTWIM.AWS_ROLE_ARN, token_file: ZTWIM.AWS_WEB_IDENTITY_TOKEN_FILE } }, readFile: () => other });
    close = () => app.close();
    await app.inject({ url: "/api/identity" });
    expect((await app.inject({ url: "/partials/spiffe" })).body).toContain("differs from the token sub presented to STS");
    await app.close();
    const bare = await testApp({ env: { AWS_REGION: "us-east-1" } });
    close = () => bare.app.close();
    expect((await bare.app.inject({ url: "/partials/spiffe" })).body).toContain("Unavailable: SPIFFE_ENDPOINT_SOCKET is not set");
  });

  it("nothing SVID-shaped reaches the logs and refresh-all invalidates the panel", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "trace" }, { write: (chunk: string) => { lines.push(chunk); } });
    const { app, workloadApi } = await testApp({ env: ZTWIM, overrides: { logger } });
    close = () => app.close();
    await app.inject({ url: "/api/spiffe" });
    await app.inject({ url: "/partials/spiffe?refresh=1" });
    expect(workloadApi.calls.x509).toBe(2);
    expect((await app.inject({ method: "POST", url: "/api/aws/refresh" })).statusCode).toBe(204);
    await app.inject({ url: "/api/spiffe" });
    expect(workloadApi.calls.x509).toBe(3);
    const joined = lines.join("\n");
    for (const secret of [workloadApi.token, TEST_SIGNATURE, FIXTURE_PEM_BODY]) expect(joined, secret.slice(0, 20)).not.toContain(secret);
  });
});
