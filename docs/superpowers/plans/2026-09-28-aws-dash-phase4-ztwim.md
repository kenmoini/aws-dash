# aws-dash Phase 4 — SPIFFE panel, Kubernetes card, node-reader RBAC, ZTWIM overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the demo's OpenShift leg: a display-only SPIFFE card that reads the pod's X.509-SVID and JWT-SVID straight from the SPIRE Workload API, a Kubernetes card that reads this pod and its node from the API server (so `OOMKilled` and the node's instance type are visible in the app), the RBAC those reads need, and the `deploy/ztwim` overlay whose spiffe-helper native sidecar writes the JWT-SVID the AWS SDK exchanges with STS.

**Architecture:** Two new side-card services mirror the Phase 3 `ImdsClient` shape exactly — `TtlCache`-backed `get(force)` / `peek()` / `invalidateAll()`, every failure a displayable `{available:false, reason}` — behind two thin adapters that are the only files allowed to import the new libraries: `src/identity/workload-api.ts` (npm `spiffe` over a gRPC transport we open and close per load) and `src/k8s/k8s-client.ts` (`@kubernetes/client-node` in-cluster config). Certificates are parsed with Node's own `node:crypto` `X509Certificate`; JWT-SVID claims go through the existing `decodeJwtForDisplay`, so no raw SVID material can reach HTML, JSON or logs. Deploy adds `rbac.yaml` (Role: get pods) to the base, a Kustomize Component `node-reader` (ClusterRole: get nodes) the EKS and ztwim overlays opt into, and the `ztwim` overlay: CSI socket + static `helper.conf` + native sidecar + trust-policy template.

**Tech Stack:** Node 24 (local 26), TypeScript 5.9.3, Fastify 5, Eta, htmx 2, vitest 5, `spiffe` 0.5.1 + `@protobuf-ts/grpc-transport` 2.11.1 + `@grpc/grpc-js` 1.14.5, `@kubernetes/client-node` 2.0.0, Kustomize (components), spiffe-helper `registry.redhat.io/zero-trust-workload-identity-manager/spiffe-helper-rhel9:v0.11.0-1787560110`.

**Spec:** `docs/superpowers/specs/2026-09-27-aws-dash-design.md` — §2 endpoints (`/api/spiffe`, `/api/k8s`), §3 config (`K8S_INFO_ENABLED`, `SPIFFE_ENDPOINT_SOCKET`, `SPIFFE_JWT_AUDIENCE`), §9 side cards, §11 deploy (`rbac.yaml`, `components/node-reader`, `ztwim` row), §12 tests, §13 Phase 4, §14–15 verification and risks.

## Global Constraints

- Node `>=24 <27`; TypeScript pinned `5.9.3`; `NodeNext` ESM (`.js` import suffixes), `verbatimModuleSyntax`, `strict`, `noUncheckedIndexedAccess`; `.npmrc` has `save-exact=true` — every new dependency is installed with an exact version.
- New libraries are imported only in their adapter: `spiffe`, `@protobuf-ts/grpc-transport`, `@grpc/grpc-js` only in `src/identity/workload-api.ts`; `@kubernetes/client-node` only in `src/k8s/k8s-client.ts` (plus `import type` of `V1Pod`/`V1Node` in `src/k8s/k8s-info.ts` and the test fake). Routes never import them.
- `node_modules` must stay free of native addons (CI already checks `find node_modules -name '*.node'` after `npm prune --omit=dev --omit=optional`); both libraries are pure JS (verified 2026-09-28).
- Every cloud/cluster failure renders inside its card with HTTP 200 and never throws out of a service; "unavailable" is a normal state.
- Raw SVID material — X.509 chains, private keys, trust bundles, JWT-SVID tokens — and the Workload API's `x509SvidKey` never reach HTML, JSON, `/metrics` or a log line. Tests pin this with `TEST_SIGNATURE`, the fixture PEM's base64 body and the fixture SPIFFE ID.
- Tests never reach the network or a live cluster; the only sockets a test may open are Unix sockets under a temp directory (Task 1's adapter test).
- Conventions (unchanged): snake_case JSON; `HX-Request: true` → HTML fragment else JSON; Eta root-relative names start with `/`; every new card is a `<section class="card" data-<name>-panel hx-get="/partials/<name>" hx-trigger="load">` on the Identity page with a `refresh` link targeting `closest [data-<name>-panel]`; `POST /api/aws/refresh` invalidates every cache.
- Deploy: no `runAsUser` anywhere; base Deployment keeps empty `initContainers`/`volumes`/`volumeMounts` for `/-` patches; placeholders are exactly `AWS_ACCOUNT_ID`, `OIDC_ISSUER_HOST`, `TRUST_DOMAIN` and each is named as a `sed` target in the README of its own directory (`scripts/check-placeholders.sh` enforces it; this phase adds `TRUST_DOMAIN` to its list); no `$(VAR)` shell templating in ConfigMaps.
- Commits: one per task, `git add` the listed files, message via two `-m` flags ending with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **A SPIRE agent socket that accepts the connection but never answers must not hang the Identity page.** The adapter passes a gRPC deadline; Task 1 tests it against a real Unix socket that accepts and stays silent (must reject within the timeout).
2. **Every SPIFFE load must close its gRPC channel, even when both RPCs fail;** otherwise one channel leaks per TTL. Task 2 asserts `close` is called exactly once on the success path and on the double-failure path.
3. **Node read forbidden but pod read allowed must still show the pod** with a hint naming the node-reader component (spec §9). Task 3 tests a 403 on `readNode` only.
4. **Off-cluster (no `KUBERNETES_SERVICE_HOST`) or `K8S_INFO_ENABLED=false` must not even construct the Kubernetes client** — `loadFromCluster()` would throw on the missing token file. Task 3 asserts the factory is never called.
5. **`POST /api/aws/refresh` must clear the SPIFFE and Kubernetes caches too;** a demo that rotates the SVID and clicks "Refresh all" expects new `iat`/`exp`. Tasks 2 and 3 each add a refresh test.

---

### Task 1: Workload API adapter (`spiffe` behind an app-level interface)

**Files:**
- Create: `src/identity/workload-api.ts`, `tests/workload-api.test.ts`
- Modify: `package.json` (+ `package-lock.json` via `npm install`)

**Interfaces:**
- Consumes: nothing from earlier tasks; `firstLine` from `src/aws/aws-error.ts`.
- Produces: `interface X509SvidRaw { spiffe_id: string; certificate: Uint8Array; hint: string }` (DER chain, leaf first — never the key); `interface JwtSvidRaw { spiffe_id: string; token: string }`; `interface WorkloadApi { fetchX509(): Promise<X509SvidRaw>; fetchJwt(audience: string): Promise<JwtSvidRaw>; close(): void }`; `type WorkloadApiFactory = (socket: string, timeoutMs: number) => WorkloadApi`; `createWorkloadApi: WorkloadApiFactory`; `describeWorkloadApiError(err: unknown, socket: string): string`.
- Facts (verified 2026-09-28 against the shipped `.d.mts`): `createClient()` from `spiffe` has no `close()`, so we build `GrpcTransport` + `SpiffeWorkloadAPIClient` ourselves; `fetchX509SVID` is server-streaming (take the first message), `fetchJWTSVID` is unary; `RpcOptions` supports `timeout` (ms) and `abort` (AbortSignal); errors are `RpcError` with a string `code` such as `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `PERMISSION_DENIED`. `spiffe`'s `package.json` `types` points at a missing `dist/index.d.ts`; TypeScript falls back to `index.d.mts` — do not "fix" imports if an editor complains.

- [ ] **Step 1: Install the libraries**

Run:
```bash
npm install --save-exact spiffe@0.5.1 @protobuf-ts/grpc-transport@2.11.1 @grpc/grpc-js@1.14.5
test "$(find node_modules -name '*.node' | wc -l)" -eq 0 && echo "no native addons"
```
Expected: `package.json` gains the three exact versions under `dependencies`; "no native addons".

- [ ] **Step 2: Write the failing test**

`tests/workload-api.test.ts`:
```ts
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkloadApi, describeWorkloadApiError } from "../src/identity/workload-api.js";

describe("describeWorkloadApiError", () => {
  const sock = "unix:///spiffe-workload-api/spire-agent.sock";
  it.each([
    [{ code: "UNAVAILABLE", message: "No connection established" }, /SPIRE agent not reachable at unix:\/\/\/spiffe-workload-api\/spire-agent.sock: is the csi.spiffe.io volume mounted and the agent running\? \(No connection established\)/],
    [{ code: "DEADLINE_EXCEEDED", message: "Deadline exceeded" }, /did not answer within the deadline at unix:\/\/\/spiffe-workload-api\/spire-agent.sock/],
    [{ code: "PERMISSION_DENIED", message: "no identity issued" }, /no registration entry matches this pod \(no identity issued\)/],
    [{ code: "INTERNAL", message: "boom\nsecond line" }, /^INTERNAL: boom$/],
    [new Error("plain failure"), /^plain failure$/],
  ])("maps %o", (err, expected) => {
    expect(describeWorkloadApiError(err, sock)).toMatch(expected);
  });
});

describe("createWorkloadApi against a local Unix socket", () => {
  let dir = "";
  let server: net.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("fails fast with a reachable-but-silent socket and never exceeds the deadline", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "aws-dash-spiffe-"));
    const sockPath = path.join(dir, "agent.sock");
    server = net.createServer(() => { /* accept and say nothing */ });
    await new Promise<void>((resolve) => server!.listen(sockPath, resolve));
    const api = createWorkloadApi(`unix://${sockPath}`, 300);
    const started = Date.now();
    await expect(api.fetchJwt("aws-dash")).rejects.toMatchObject({ code: expect.stringMatching(/UNAVAILABLE|DEADLINE_EXCEEDED|INTERNAL/) });
    expect(Date.now() - started).toBeLessThan(2000);
    api.close();
  }, 10_000);

  it("reports a missing socket as not reachable", async () => {
    const api = createWorkloadApi("unix:///nonexistent/aws-dash/agent.sock", 300);
    let message = "";
    try {
      await api.fetchX509();
    } catch (err) {
      message = describeWorkloadApiError(err, "unix:///nonexistent/aws-dash/agent.sock");
    } finally {
      api.close();
    }
    expect(message).toMatch(/not reachable at unix:\/\/\/nonexistent\/aws-dash\/agent.sock|did not answer within the deadline/);
  }, 10_000);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/workload-api.test.ts`
Expected: FAIL — `Cannot find module '../src/identity/workload-api.js'`.

- [ ] **Step 4: Write the adapter**

`src/identity/workload-api.ts`:
```ts
// The only file that imports the SPIFFE Workload API libraries. Opens one gRPC channel per instance;
// callers must close() it. Never returns the SVID private key.
import { ChannelCredentials } from "@grpc/grpc-js";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { SpiffeWorkloadAPIClient } from "spiffe";
import { firstLine } from "../aws/aws-error.js";

/** An X.509-SVID as the agent returned it: the DER chain (leaf first) and the ID it certifies. */
export interface X509SvidRaw {
  spiffe_id: string;
  certificate: Uint8Array;
  hint: string;
}

export interface JwtSvidRaw {
  spiffe_id: string;
  token: string;
}

export interface WorkloadApi {
  fetchX509(): Promise<X509SvidRaw>;
  fetchJwt(audience: string): Promise<JwtSvidRaw>;
  close(): void;
}

export type WorkloadApiFactory = (socket: string, timeoutMs: number) => WorkloadApi;

/** `socket` is the SPIFFE endpoint URI, e.g. unix:///spiffe-workload-api/spire-agent.sock; `timeoutMs` is the gRPC deadline per call. */
export const createWorkloadApi: WorkloadApiFactory = (socket, timeoutMs) => {
  const transport = new GrpcTransport({
    host: socket,
    channelCredentials: ChannelCredentials.createInsecure(),
    meta: { "workload.spiffe.io": "true" },
  });
  const client = new SpiffeWorkloadAPIClient(transport);
  return {
    async fetchX509() {
      const abort = new AbortController();
      const call = client.fetchX509SVID({}, { timeout: timeoutMs, abort: abort.signal });
      // The call object is also a promise for the whole exchange; aborting after the first message
      // rejects it with CANCELLED, which nobody awaits — observe it so Node sees no unhandled rejection.
      void call.then(undefined, () => undefined);
      try {
        for await (const message of call.responses) {
          const svid = message.svids[0];
          if (svid === undefined) throw new Error("the Workload API returned no X.509-SVID for this workload (no registration entry matches this pod)");
          return { spiffe_id: svid.spiffeId, certificate: svid.x509Svid, hint: svid.hint };
        }
        throw new Error("the Workload API stream ended without an X.509-SVID");
      } finally {
        abort.abort();
      }
    },
    async fetchJwt(audience) {
      const { response } = await client.fetchJWTSVID({ audience: [audience], spiffeId: "" }, { timeout: timeoutMs });
      const svid = response.svids[0];
      if (svid === undefined) throw new Error(`the Workload API returned no JWT-SVID for audience ${audience}`);
      return { spiffe_id: svid.spiffeId, token: svid.svid };
    },
    close() {
      transport.close();
    },
  };
};

/** One line for the card: gRPC status names become operator-actionable hints. */
export function describeWorkloadApiError(err: unknown, socket: string): string {
  const e = err as { code?: unknown; message?: string };
  const code = typeof e.code === "string" ? e.code : null;
  const msg = firstLine(e.message ?? String(err));
  switch (code) {
    case "UNAVAILABLE":
      return `SPIRE agent not reachable at ${socket}: is the csi.spiffe.io volume mounted and the agent running? (${msg})`;
    case "DEADLINE_EXCEEDED":
      return `the Workload API did not answer within the deadline at ${socket} (${msg})`;
    case "PERMISSION_DENIED":
      return `the SPIRE agent refused this workload: no registration entry matches this pod (${msg})`;
    default:
      return code === null ? msg : `${code}: ${msg}`;
  }
}
```
If `firstLine` is not exported from `src/aws/aws-error.ts` under that name, use the exported helper that returns the first line of a message (Phase 2 named it `firstLine`).

- [ ] **Step 5: Run the test to verify it passes; typecheck**

Run: `npx vitest run tests/workload-api.test.ts && npm run typecheck`
Expected: 7 tests PASS (5 table rows + 2 socket tests), typecheck clean. If the silent-socket test rejects with a code outside the regex, print the code and widen the regex — the requirement is *rejects within 2 s*, not a specific code.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/identity/workload-api.ts tests/workload-api.test.ts
git commit -m "feat: SPIRE Workload API adapter with per-call deadlines and explicit channel close" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: SPIFFE panel service, routes, card

**Files:**
- Create: `src/identity/spiffe-panel.ts`, `views/partials/spiffe.eta`, `tests/fixtures/spiffe-leaf.pem`, `tests/support/fake-workload-api.ts`, `tests/spiffe-panel.test.ts`
- Modify: `src/app.ts` (`AppDeps.createWorkloadApi`, `AppDeps.spiffeTimeoutMs`, `AppDeps.spiffe`; wiring), `src/routes/identity.ts` (two routes), `src/routes/inventory.ts` (refresh invalidates), `views/pages/identity.eta` (fourth card), `tests/support/app-factory.ts` (inject the fake, return `workloadApi`)

**Interfaces:**
- Consumes: `WorkloadApi`, `WorkloadApiFactory`, `X509SvidRaw`, `describeWorkloadApiError` (Task 1); `decodeJwtForDisplay`, `JwtSummary` (`src/identity/jwt-display.ts`); `TtlCache`, `Clock`; `AppSettings.spiffeEndpointSocket: string | undefined`, `AppSettings.spiffeJwtAudience: string` (already parsed by `src/config.ts`); `IdentityService.peek()` for the token `sub` cross-check; `isRefresh`; `fmt.time`/`fmt.until`.
- Produces: `interface X509Summary { spiffe_id: string; san_uris: string[]; serial: string; issuer: string; not_before: string; not_after: string; expires_in_seconds: number }`; `interface JwtSvidSummary extends JwtSummary { spiffe_id: string | null; audience: string }`; `interface SpiffeInfo { available: boolean; reason: string | null; socket: string | null; x509: X509Summary | null; x509_error: string | null; jwt: JwtSvidSummary | null; fetched_at: string }`; `summarizeX509(raw: X509SvidRaw, now: Date): X509Summary`; `class SpiffePanel { constructor(opts: { socket: string | undefined; audience: string; clock: Clock; cache: TtlCache; createApi: WorkloadApiFactory; timeoutMs?: number }); get(force?): Promise<SpiffeInfo>; peek(): SpiffeInfo | null; invalidateAll(): void }`; routes `GET /api/spiffe[?refresh=true]`, `GET /partials/spiffe`; `AppDeps.createWorkloadApi: WorkloadApiFactory`, `AppDeps.spiffeTimeoutMs: number`, `AppDeps.spiffe: SpiffePanel`; `testApp()` returns `workloadApi: FakeWorkloadApi`; `tests/support/fake-workload-api.ts` exports `FIXTURE_PEM`, `FIXTURE_CERT`, `FIXTURE_DER`, `FIXTURE_SPIFFE_ID`, `rpcError(code, message)`, `FakeWorkloadApi`.
- Semantics: `available` is true when at least one SVID fetch succeeded; when both fail, `available:false` and `reason` is the X.509 error. `socket === undefined` → unavailable without constructing an API. Every load closes the API exactly once.

- [ ] **Step 1: Write the fixture and the fake**

`tests/fixtures/spiffe-leaf.pem` (self-signed EC P-256, URI SAN `spiffe://example.org/ns/aws-dash-ztwim/sa/aws-dash`, valid 2026-09-28 → 2126-09-04; generated with `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/O=SPIRE/C=US" -days 36500 -addext "subjectAltName=URI:spiffe://…"`; the key was discarded):
```
-----BEGIN CERTIFICATE-----
MIIB0jCCAXigAwIBAgIUfV7RGT2FY6tFaWXOK+CWsAzoL6EwCgYIKoZIzj0EAwIw
HTEOMAwGA1UECgwFU1BJUkUxCzAJBgNVBAYTAlVTMCAXDTI2MDkyODIwNTUwM1oY
DzIxMjYwOTA0MjA1NTAzWjAdMQ4wDAYDVQQKDAVTUElSRTELMAkGA1UEBhMCVVMw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQvVXgWk73mxguH263rPWaxHkqSUE8t
+fnz0gQXkUamivt4LxZ+x3xlrwsCFPplkvpHr//mD8yRzpszShRmDMwUo4GTMIGQ
MB0GA1UdDgQWBBQyIUerdxdnYaH3UR5RO/fj5aCIUjAfBgNVHSMEGDAWgBQyIUer
dxdnYaH3UR5RO/fj5aCIUjAPBgNVHRMBAf8EBTADAQH/MD0GA1UdEQQ2MDSGMnNw
aWZmZTovL2V4YW1wbGUub3JnL25zL2F3cy1kYXNoLXp0d2ltL3NhL2F3cy1kYXNo
MAoGCCqGSM49BAMCA0gAMEUCIQDFnaBu+crLCNeNojaEUaugWW7NOQbNYsbhD7U8
QoG4pgIgDL1K1Rqo4VRE+SkWQUVPVWMF5s2L0Cd3rPkbxDuC9KY=
-----END CERTIFICATE-----
```

`tests/support/fake-workload-api.ts`:
```ts
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { JwtSvidRaw, WorkloadApi, X509SvidRaw } from "../../src/identity/workload-api.js";
import { makeJwt } from "./test-jwt.js";

export const FIXTURE_PEM = readFileSync(new URL("../fixtures/spiffe-leaf.pem", import.meta.url), "utf8");
export const FIXTURE_CERT = new X509Certificate(FIXTURE_PEM);
export const FIXTURE_DER = new Uint8Array(FIXTURE_CERT.raw);
export const FIXTURE_SPIFFE_ID = "spiffe://example.org/ns/aws-dash-ztwim/sa/aws-dash";
/** The base64 body of the fixture — must never appear in any output. */
export const FIXTURE_PEM_BODY = FIXTURE_PEM.replace(/-----[A-Z ]+-----|\s/g, "");
export const NOW = 1_767_225_600; // 2026-01-01T00:00:00Z, the FakeClock start

export const rpcError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** Scripted Workload API: hands back the fixture chain (leaf twice, as a real chain would) and a JWT-SVID built with makeJwt. */
export class FakeWorkloadApi implements WorkloadApi {
  calls = { x509: 0, jwt: 0, close: 0 };
  spiffeId = FIXTURE_SPIFFE_ID;
  certificate: Uint8Array = new Uint8Array([...FIXTURE_DER, ...FIXTURE_DER]);
  token = makeJwt({ iss: "https://oidc-discovery.apps.example.org", sub: FIXTURE_SPIFFE_ID, aud: "aws-dash", iat: NOW, exp: NOW + 300 });
  x509Error: Error | null = null;
  jwtError: Error | null = null;
  audiences: string[] = [];

  async fetchX509(): Promise<X509SvidRaw> {
    this.calls.x509++;
    if (this.x509Error) throw this.x509Error;
    return { spiffe_id: this.spiffeId, certificate: this.certificate, hint: "" };
  }

  async fetchJwt(audience: string): Promise<JwtSvidRaw> {
    this.calls.jwt++;
    this.audiences.push(audience);
    if (this.jwtError) throw this.jwtError;
    return { spiffe_id: this.spiffeId, token: this.token };
  }

  close(): void {
    this.calls.close++;
  }
}
```

- [ ] **Step 2: Write the failing tests**

`tests/spiffe-panel.test.ts`:
```ts
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { SpiffePanel, summarizeX509 } from "../src/identity/spiffe-panel.js";
import { TtlCache } from "../src/inventory/ttl-cache.js";
import { testApp } from "./support/app-factory.js";
import { FakeClock } from "./support/fake-clock.js";
import { FakeWorkloadApi, FIXTURE_CERT, FIXTURE_DER, FIXTURE_PEM_BODY, FIXTURE_SPIFFE_ID, NOW, rpcError } from "./support/fake-workload-api.js";
import { makeJwt, TEST_SIGNATURE } from "./support/test-jwt.js";

const SOCKET = "unix:///spiffe-workload-api/spire-agent.sock";

function panel(api: FakeWorkloadApi, socket: string | undefined = SOCKET) {
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/spiffe-panel.test.ts`
Expected: FAIL — `Cannot find module '../src/identity/spiffe-panel.js'`.

- [ ] **Step 4: Write the service**

`src/identity/spiffe-panel.ts`:
```ts
import { X509Certificate } from "node:crypto";
import type { Clock } from "../clock.js";
import type { TtlCache } from "../inventory/ttl-cache.js";
import { decodeJwtForDisplay, type JwtSummary } from "./jwt-display.js";
import { describeWorkloadApiError, type WorkloadApiFactory, type X509SvidRaw } from "./workload-api.js";

export interface X509Summary {
  spiffe_id: string;
  san_uris: string[];
  serial: string;
  issuer: string;
  not_before: string;
  not_after: string;
  expires_in_seconds: number;
}

export interface JwtSvidSummary extends JwtSummary {
  spiffe_id: string | null;
  audience: string;
}

/** GET /api/spiffe. Display only: the credential path never touches this; "unavailable" is the normal state outside ZTWIM. */
export interface SpiffeInfo {
  available: boolean;
  reason: string | null;
  socket: string | null;
  x509: X509Summary | null;
  x509_error: string | null;
  jwt: JwtSvidSummary | null;
  fetched_at: string;
}

export interface SpiffePanelOptions {
  socket: string | undefined;
  audience: string;
  clock: Clock;
  cache: TtlCache;
  createApi: WorkloadApiFactory;
  timeoutMs?: number;
}

/** Facts about the leaf certificate only — Node's X509Certificate parses the first certificate of a DER chain. */
export function summarizeX509(raw: X509SvidRaw, now: Date): X509Summary {
  const cert = new X509Certificate(Buffer.from(raw.certificate));
  const san = cert.subjectAltName ?? "";
  return {
    spiffe_id: raw.spiffe_id,
    san_uris: san.split(", ").filter((name) => name.startsWith("URI:")).map((name) => name.slice("URI:".length)),
    serial: cert.serialNumber,
    issuer: cert.issuer.replace(/\n/g, ", "),
    not_before: cert.validFromDate.toISOString(),
    not_after: cert.validToDate.toISOString(),
    expires_in_seconds: Math.floor((cert.validToDate.getTime() - now.getTime()) / 1000),
  };
}

export class SpiffePanel {
  private static readonly KEY = "spiffe";
  private readonly timeoutMs: number;

  constructor(private readonly opts: SpiffePanelOptions) {
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  async get(force = false): Promise<SpiffeInfo> {
    const socket = this.opts.socket;
    if (socket === undefined) return this.unavailable("SPIFFE_ENDPOINT_SOCKET is not set: no SPIRE Workload API socket is mounted (normal outside the ztwim overlay)");
    const entry = await this.opts.cache.get<SpiffeInfo>(SpiffePanel.KEY, () => this.load(socket), force);
    return entry.value as SpiffeInfo;
  }

  peek(): SpiffeInfo | null {
    return this.opts.cache.peek<SpiffeInfo>(SpiffePanel.KEY)?.value ?? null;
  }

  invalidateAll(): void {
    this.opts.cache.invalidateAll();
  }

  private unavailable(reason: string): SpiffeInfo {
    return { available: false, reason, socket: this.opts.socket ?? null, x509: null, x509_error: null, jwt: null, fetched_at: this.opts.clock.now().toISOString() };
  }

  private async load(socket: string): Promise<SpiffeInfo> {
    const now = this.opts.clock.now();
    const api = this.opts.createApi(socket, this.timeoutMs);
    try {
      let x509: X509Summary | null = null;
      let x509Error: string | null = null;
      try {
        x509 = summarizeX509(await api.fetchX509(), now);
      } catch (err) {
        x509Error = describeWorkloadApiError(err, socket);
      }
      let jwt: JwtSvidSummary;
      try {
        const raw = await api.fetchJwt(this.opts.audience);
        jwt = { ...decodeJwtForDisplay(raw.token), spiffe_id: raw.spiffe_id, audience: this.opts.audience };
      } catch (err) {
        jwt = { claims: {}, issued_at: null, expires_at: null, error: describeWorkloadApiError(err, socket), spiffe_id: null, audience: this.opts.audience };
      }
      if (x509 === null && jwt.error !== null) return { ...this.unavailable(x509Error ?? jwt.error), fetched_at: now.toISOString() };
      return { available: true, reason: null, socket, x509, x509_error: x509Error, jwt, fetched_at: now.toISOString() };
    } finally {
      api.close();
    }
  }
}
```

- [ ] **Step 5: Wire deps, routes, refresh, card, test factory**

`src/app.ts` — add imports `import { SpiffePanel } from "./identity/spiffe-panel.js";` and `import { createWorkloadApi, type WorkloadApiFactory } from "./identity/workload-api.js";`. In `AppDeps` add after `imds: ImdsClient;`:
```ts
  /** Opens a SPIRE Workload API channel for one load; tests inject a fake. */
  createWorkloadApi: WorkloadApiFactory;
  spiffeTimeoutMs: number;
  spiffe: SpiffePanel;
```
In `createDeps` after the `imds` block:
```ts
  const createWorkloadApiFn = overrides.createWorkloadApi ?? createWorkloadApi;
  const spiffeTimeoutMs = overrides.spiffeTimeoutMs ?? 3000;
  const spiffe = overrides.spiffe ?? new SpiffePanel({
    socket: settings.spiffeEndpointSocket, audience: settings.spiffeJwtAudience, clock, createApi: createWorkloadApiFn, timeoutMs: spiffeTimeoutMs,
    cache: new TtlCache(settings.cacheTtlSeconds * 1000, clock, (err) => awsErrorFrom(err).message),
  });
```
and add `createWorkloadApi: createWorkloadApiFn, spiffeTimeoutMs, spiffe,` to the returned object.

`src/routes/identity.ts` — append inside `registerIdentityRoutes`:
```ts
  app.get("/api/spiffe", (req) => deps.spiffe.get(isRefresh(req)));
  app.get("/partials/spiffe", async (req, reply) =>
    reply.partial("partials/spiffe", {
      info: await deps.spiffe.get(isRefresh(req)),
      token_sub: deps.identity.peek()?.token?.claims["sub"] ?? null,
      now: deps.clock.now().toISOString(),
    }));
```

`src/routes/inventory.ts` — in the `POST /api/aws/refresh` handler add `deps.spiffe.invalidateAll();` after `deps.imds.invalidateAll();`.

`views/pages/identity.eta` — add after the IMDS section:
```eta
  <section class="card" data-spiffe-panel hx-get="/partials/spiffe" hx-trigger="load">
    <h2>SPIFFE workload identity</h2>
    <p class="muted">Loading…</p>
  </section>
```

`views/partials/spiffe.eta`:
```eta
<% const i = it.info, fmt = it.fmt; %>
<h2>SPIFFE workload identity</h2>
<% if (!i.available) { %>
<p class="muted">Unavailable: <%= i.reason %></p>
<% } else { %>
<p class="muted">Read live from the SPIRE agent over <code><%= i.socket %></code> (Zero Trust Workload Identity Manager). Raw SVIDs — certificates, keys and tokens — are never displayed.</p>
<h3>X.509-SVID</h3>
<% if (i.x509 === null) { %>
<div class="error"><%= i.x509_error %></div>
<% } else { %>
<dl class="kv">
  <dt>SPIFFE ID</dt><dd><%= i.x509.spiffe_id %><% if (it.token_sub !== null) { %> <span class="badge <%= it.token_sub === i.x509.spiffe_id ? "ok" : "warn" %>"><%= it.token_sub === i.x509.spiffe_id ? "same as the token sub presented to STS" : "differs from the token sub presented to STS" %></span><% } %></dd>
  <dt>SAN URIs</dt><dd><%= i.x509.san_uris.length ? i.x509.san_uris.join(", ") : "—" %></dd>
  <dt>Serial</dt><dd><%= i.x509.serial %></dd>
  <dt>Issuer</dt><dd><%= i.x509.issuer %></dd>
  <dt>Valid</dt><dd><%= fmt.time(i.x509.not_before) %> → <%= fmt.time(i.x509.not_after) %> (<%= fmt.until(i.x509.not_after, it.now) %>)</dd>
</dl>
<% } %>
<h3>JWT-SVID for audience <code><%= i.jwt.audience %></code></h3>
<p class="muted">Fetched for display only. The AWS credential path uses the file spiffe-helper writes for the SDK, not this call.</p>
<%~ include("/partials/claims-table", { summary: i.jwt, now: it.now, fmt }) %>
<% } %>
<p class="muted">Checked <%= fmt.time(i.fetched_at) %> · <a href="#" hx-get="/partials/spiffe?refresh=1" hx-target="closest [data-spiffe-panel]">refresh</a></p>
```

`tests/support/app-factory.ts` — import `FakeWorkloadApi` from `./fake-workload-api.js`; in `testApp()` create `const workloadApi = new FakeWorkloadApi();`, pass `createWorkloadApi: () => workloadApi, spiffeTimeoutMs: 20,` to `createDeps`, and add `workloadApi` to the returned object.

- [ ] **Step 6: Run the tests; full suite; typecheck**

Run: `npx vitest run tests/spiffe-panel.test.ts && npm test && npm run typecheck`
Expected: 11 new tests PASS; whole suite green (237 + 7 + 11 = 255); typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/identity/spiffe-panel.ts views/partials/spiffe.eta views/pages/identity.eta src/app.ts src/routes/identity.ts src/routes/inventory.ts tests/fixtures/spiffe-leaf.pem tests/support/fake-workload-api.ts tests/support/app-factory.ts tests/spiffe-panel.test.ts
git commit -m "feat: SPIFFE card reads the pod's X.509 and JWT SVIDs from the Workload API without exposing them" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Kubernetes pod/node card

**Files:**
- Create: `src/k8s/k8s-client.ts`, `src/k8s/k8s-info.ts`, `views/partials/k8s.eta`, `tests/support/fake-k8s.ts`, `tests/k8s-info.test.ts`
- Modify: `package.json` (+ lock), `src/app.ts` (`AppDeps.createK8sClient`, `AppDeps.k8sTimeoutMs`, `AppDeps.k8s`; wiring), `src/routes/identity.ts` (two routes), `src/routes/inventory.ts` (refresh invalidates), `views/pages/identity.eta` (fifth card), `public/css/site.css` (`table.k8s` rule), `tests/support/app-factory.ts` (inject `FakeK8sClient`, return `k8s`)

**Interfaces:**
- Consumes: `TtlCache`, `Clock`, `EnvLookup` (`src/env.ts`), `AppSettings.k8sInfoEnabled`, `isRefresh`, `fmt.time`/`fmt.or`.
- Produces: `interface K8sReadClient { readNamespacedPod(p: { name: string; namespace: string }): Promise<V1Pod>; readNode(p: { name: string }): Promise<V1Node> }`; `type K8sClientFactory = () => K8sReadClient`; `createInClusterClient: K8sClientFactory`; `interface K8sContainer { name: string; image: string; ready: boolean; restart_count: number; state: string; started_at: string | null; last_terminated: { reason: string | null; exit_code: number; finished_at: string | null } | null }`; `interface K8sPod { name: string; namespace: string; node: string | null; phase: string | null; started_at: string | null; service_account: string | null; qos_class: string | null; containers: K8sContainer[] }`; `interface K8sNode { name: string; instance_type: string | null; zone: string | null; region: string | null; arch: string | null; os_image: string | null; kubelet_version: string | null; container_runtime: string | null; provider_id: string | null; allocatable_cpu: string | null; allocatable_memory: string | null }`; `interface K8sInfo { available: boolean; reason: string | null; pod: K8sPod | null; node: K8sNode | null; node_error: string | null; fetched_at: string }`; `class K8sInfoService { constructor(opts: { enabled: boolean; env: EnvLookup; clock: Clock; cache: TtlCache; createClient: K8sClientFactory; timeoutMs?: number }); get(force?): Promise<K8sInfo>; peek(): K8sInfo | null; invalidateAll(): void }`; `describeK8sError(err: unknown, what: string): string`; routes `GET /api/k8s[?refresh=true]`, `GET /partials/k8s`; `AppDeps.createK8sClient: K8sClientFactory`, `AppDeps.k8sTimeoutMs: number`, `AppDeps.k8s: K8sInfoService`; `testApp()` returns `k8s: FakeK8sClient`.
- Facts (verified 2026-09-28): `@kubernetes/client-node@2.0.0` — `KubeConfig.loadFromCluster()` reads `KUBERNETES_SERVICE_HOST`/`_PORT` and `/var/run/secrets/kubernetes.io/serviceaccount/{ca.crt,token}`; `kc.makeApiClient(CoreV1Api)`; object parameters `readNamespacedPod({ name, namespace })` / `readNode({ name })` return `V1Pod`/`V1Node` directly; errors are `ApiException` with numeric `code` (HTTP status) and `body`; no per-call timeout option, so the service races each call against a timer. The package pulls `ws` without types; `tsconfig.json` already has `skipLibCheck: true`, which is what makes it compile — do not remove it.

- [ ] **Step 1: Install the library**

Run: `npm install --save-exact @kubernetes/client-node@2.0.0 && test "$(find node_modules -name '*.node' | wc -l)" -eq 0 && npm run typecheck && echo ok`
Expected: exact version added; no native addons; typecheck clean.

- [ ] **Step 2: Write the fake and the failing tests**

`tests/support/fake-k8s.ts`:
```ts
import type { V1Node, V1Pod } from "@kubernetes/client-node";
import type { K8sReadClient } from "../../src/k8s/k8s-client.js";

export const apiError = (code: number, message: string): Error => Object.assign(new Error(message), { code, body: { message } });

export const HEALTHY_POD: V1Pod = {
  metadata: { name: "aws-dash-7d9f-abcde", namespace: "aws-dash" },
  spec: { nodeName: "ip-10-0-1-23.ec2.internal", serviceAccountName: "aws-dash", containers: [{ name: "aws-dash", image: "ghcr.io/kenmoini/aws-dash:main" }] },
  status: {
    phase: "Running", qosClass: "Burstable", startTime: new Date("2025-12-31T23:00:00Z"),
    containerStatuses: [{
      name: "aws-dash", image: "ghcr.io/kenmoini/aws-dash:main", imageID: "sha256:abc", ready: true, restartCount: 2,
      state: { running: { startedAt: new Date("2025-12-31T23:50:00Z") } },
      lastState: { terminated: { reason: "OOMKilled", exitCode: 137, finishedAt: new Date("2025-12-31T23:49:00Z") } },
    }],
  },
};

export const NODE: V1Node = {
  metadata: { name: "ip-10-0-1-23.ec2.internal", labels: { "node.kubernetes.io/instance-type": "m6i.large", "topology.kubernetes.io/zone": "us-east-1a", "topology.kubernetes.io/region": "us-east-1", "kubernetes.io/arch": "amd64" } },
  spec: { providerID: "aws:///us-east-1a/i-0abc123" },
  status: { allocatable: { cpu: "1930m", memory: "7220Mi" }, nodeInfo: { kubeletVersion: "v1.33.1-eks-1", containerRuntimeVersion: "containerd://1.7.27", osImage: "Amazon Linux 2023", architecture: "amd64", operatingSystem: "linux", kernelVersion: "6.1", machineID: "", systemUUID: "", bootID: "", kubeProxyVersion: "" } },
};

/** Scripted API server: answers with fixtures; `fail()` throws an ApiException-shaped error; `hang` waits forever. */
export class FakeK8sClient implements K8sReadClient {
  calls = { pod: 0, node: 0 };
  pod: V1Pod = structuredClone(HEALTHY_POD);
  node: V1Node = structuredClone(NODE);
  podError: Error | null = null;
  nodeError: Error | null = null;
  hang = false;

  fail(what: "pod" | "node", code: number, message: string): void {
    if (what === "pod") this.podError = apiError(code, message);
    else this.nodeError = apiError(code, message);
  }

  async readNamespacedPod(): Promise<V1Pod> {
    this.calls.pod++;
    if (this.hang) await new Promise(() => undefined);
    if (this.podError) throw this.podError;
    return this.pod;
  }

  async readNode(): Promise<V1Node> {
    this.calls.node++;
    if (this.nodeError) throw this.nodeError;
    return this.node;
  }
}
```

`tests/k8s-info.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { TtlCache } from "../src/inventory/ttl-cache.js";
import { K8sInfoService } from "../src/k8s/k8s-info.js";
import { testApp } from "./support/app-factory.js";
import { FakeClock } from "./support/fake-clock.js";
import { FakeK8sClient } from "./support/fake-k8s.js";

const IN_CLUSTER = { KUBERNETES_SERVICE_HOST: "10.100.0.1", KUBERNETES_SERVICE_PORT: "443", POD_NAME: "aws-dash-7d9f-abcde", POD_NAME_UNUSED: "", POD_NAMESPACE: "aws-dash", NODE_NAME: "ip-10-0-1-23.ec2.internal" };

function service(client: FakeK8sClient, vars: Record<string, string> = IN_CLUSTER, extra: { enabled?: boolean; timeoutMs?: number } = {}) {
  const clock = new FakeClock();
  let created = 0;
  const svc = new K8sInfoService({
    enabled: extra.enabled ?? true, env: (name) => vars[name], clock, cache: new TtlCache(60_000, clock), timeoutMs: extra.timeoutMs ?? 20,
    createClient: () => { created++; return client; },
  });
  return { svc, clock, created: () => created };
}

describe("K8sInfoService", () => {
  it("maps the pod, its containers (with the OOMKilled last state) and the node", async () => {
    const client = new FakeK8sClient();
    const { svc } = service(client);
    const info = await svc.get();
    expect(info).toEqual({
      available: true, reason: null, node_error: null, fetched_at: "2026-01-01T00:00:00.000Z",
      pod: {
        name: "aws-dash-7d9f-abcde", namespace: "aws-dash", node: "ip-10-0-1-23.ec2.internal", phase: "Running", started_at: "2025-12-31T23:00:00.000Z", service_account: "aws-dash", qos_class: "Burstable",
        containers: [{ name: "aws-dash", image: "ghcr.io/kenmoini/aws-dash:main", ready: true, restart_count: 2, state: "running", started_at: "2025-12-31T23:50:00.000Z",
          last_terminated: { reason: "OOMKilled", exit_code: 137, finished_at: "2025-12-31T23:49:00.000Z" } }],
      },
      node: { name: "ip-10-0-1-23.ec2.internal", instance_type: "m6i.large", zone: "us-east-1a", region: "us-east-1", arch: "amd64", os_image: "Amazon Linux 2023", kubelet_version: "v1.33.1-eks-1",
        container_runtime: "containerd://1.7.27", provider_id: "aws:///us-east-1a/i-0abc123", allocatable_cpu: "1930m", allocatable_memory: "7220Mi" },
    });
    expect(client.calls).toEqual({ pod: 1, node: 1 });
  });

  it("describes waiting and terminated container states", async () => {
    const client = new FakeK8sClient();
    client.pod.status!.containerStatuses![0]!.state = { waiting: { reason: "CrashLoopBackOff" } };
    client.pod.status!.containerStatuses![0]!.lastState = { terminated: { exitCode: 3 } };
    const info = await service(client).svc.get();
    expect(info.pod?.containers[0]).toMatchObject({ state: "waiting (CrashLoopBackOff)", started_at: null, last_terminated: { reason: null, exit_code: 3, finished_at: null } });
  });

  it("still shows the pod when the node read is forbidden, with the node-reader hint", async () => {
    const client = new FakeK8sClient();
    client.fail("node", 403, 'nodes "ip-10-0-1-23.ec2.internal" is forbidden');
    const info = await service(client).svc.get();
    expect(info.available).toBe(true);
    expect(info.pod?.name).toBe("aws-dash-7d9f-abcde");
    expect(info.node).toBeNull();
    expect(info.node_error).toBe("forbidden: the service account cannot get nodes — add the node-reader component (deploy/components/node-reader) to your overlay (nodes \"ip-10-0-1-23.ec2.internal\" is forbidden)");
  });

  it("is unavailable with the rbac.yaml hint when the pod read is forbidden", async () => {
    const client = new FakeK8sClient();
    client.fail("pod", 403, "pods is forbidden");
    const info = await service(client).svc.get();
    expect(info).toMatchObject({ available: false, pod: null, node: null, reason: "forbidden: the service account cannot get pods — apply deploy/kubernetes/rbac.yaml (Role aws-dash-pod-reader) (pods is forbidden)" });
    expect(client.calls.node).toBe(0);
  });

  it.each([
    [{ ...IN_CLUSTER, KUBERNETES_SERVICE_HOST: "" }, "not running in Kubernetes (KUBERNETES_SERVICE_HOST is not set)"],
    [{ ...IN_CLUSTER, POD_NAME: "" }, "POD_NAME / POD_NAMESPACE are not set: add the downward API env entries from deploy/kubernetes/deployment.yaml"],
  ])("never builds a client off-cluster: %o", async (vars, reason) => {
    const client = new FakeK8sClient();
    const { svc, created } = service(client, vars);
    expect(await svc.get()).toMatchObject({ available: false, reason });
    expect(created()).toBe(0);
  });

  it("never builds a client when disabled", async () => {
    const { svc, created } = service(new FakeK8sClient(), IN_CLUSTER, { enabled: false });
    expect(await svc.get()).toMatchObject({ available: false, reason: "disabled (K8S_INFO_ENABLED=false)" });
    expect(created()).toBe(0);
  });

  it("reports a client that cannot be built (no service-account token) as unavailable", async () => {
    const clock = new FakeClock();
    const svc = new K8sInfoService({ enabled: true, env: (n) => IN_CLUSTER[n as keyof typeof IN_CLUSTER], clock, cache: new TtlCache(60_000, clock), createClient: () => { throw new Error("ENOENT: /var/run/secrets/kubernetes.io/serviceaccount/token"); } });
    expect(await svc.get()).toMatchObject({ available: false, reason: "cannot load the in-cluster config: ENOENT: /var/run/secrets/kubernetes.io/serviceaccount/token" });
  });

  it("gives up on a silent API server after the timeout", async () => {
    const client = new FakeK8sClient();
    client.hang = true;
    const info = await service(client).svc.get();
    expect(info).toMatchObject({ available: false, reason: "the Kubernetes API did not answer within 20ms" });
  });

  it("caches for the TTL, force reloads, invalidateAll expires, peek never loads", async () => {
    const client = new FakeK8sClient();
    const { svc, clock } = service(client);
    expect(svc.peek()).toBeNull();
    await svc.get();
    await svc.get();
    expect(client.calls.pod).toBe(1);
    await svc.get(true);
    expect(client.calls.pod).toBe(2);
    clock.advance(61_000);
    await svc.get();
    expect(client.calls.pod).toBe(3);
    svc.invalidateAll();
    await svc.get();
    expect(client.calls.pod).toBe(4);
  });
});

describe("Kubernetes routes", () => {
  let close = async () => {};
  afterEach(() => close());

  it("GET /api/k8s is snake_case JSON and the Identity page carries the card", async () => {
    const { app } = await testApp({ env: IN_CLUSTER });
    close = () => app.close();
    const res = await app.inject({ url: "/api/k8s" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ available: true, pod: { name: "aws-dash-7d9f-abcde", containers: [{ restart_count: 2 }] }, node: { instance_type: "m6i.large" } });
    expect((await app.inject({ url: "/identity" })).body).toContain('data-k8s-panel hx-get="/partials/k8s" hx-trigger="load"');
  });

  it("the partial highlights OOMKilled, shows the node, and offers refresh", async () => {
    const { app } = await testApp({ env: IN_CLUSTER });
    close = () => app.close();
    const html = (await app.inject({ url: "/partials/k8s" })).body;
    for (const text of ["This pod", "aws-dash-7d9f-abcde", '<span class="badge ok">Running</span>', '<span class="badge bad">OOMKilled (exit 137)</span>', "restarts</th>", "This node", "m6i.large", "us-east-1a",
      "containerd://1.7.27", 'hx-get="/partials/k8s?refresh=1"']) {
      expect(html, text).toContain(text);
    }
  });

  it("renders the node hint inline and Unavailable off-cluster; refresh-all invalidates", async () => {
    const { app, k8s } = await testApp({ env: IN_CLUSTER });
    close = () => app.close();
    k8s.fail("node", 403, "forbidden");
    expect((await app.inject({ url: "/partials/k8s" })).body).toContain("add the node-reader component");
    expect((await app.inject({ method: "POST", url: "/api/aws/refresh" })).statusCode).toBe(204);
    await app.inject({ url: "/api/k8s" });
    expect(k8s.calls.pod).toBe(2);
    await app.close();
    const bare = await testApp({ env: { AWS_REGION: "us-east-1" } });
    close = () => bare.app.close();
    expect((await bare.app.inject({ url: "/partials/k8s" })).body).toContain("Unavailable: not running in Kubernetes");
  });
});
```
(`POD_NAME_UNUSED` in `IN_CLUSTER` is a harmless extra key; keep the object literal as written so the `it.each` spreads compile.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/k8s-info.test.ts`
Expected: FAIL — `Cannot find module '../src/k8s/k8s-info.js'`.

- [ ] **Step 4: Write the client adapter and the service**

`src/k8s/k8s-client.ts`:
```ts
// The only file that imports @kubernetes/client-node at runtime.
import { CoreV1Api, KubeConfig, type V1Node, type V1Pod } from "@kubernetes/client-node";

export interface K8sReadClient {
  readNamespacedPod(param: { name: string; namespace: string }): Promise<V1Pod>;
  readNode(param: { name: string }): Promise<V1Node>;
}

export type K8sClientFactory = () => K8sReadClient;

/** In-cluster config: KUBERNETES_SERVICE_HOST/PORT plus the mounted service-account token and CA. Throws when the token file is missing. */
export const createInClusterClient: K8sClientFactory = () => {
  const kc = new KubeConfig();
  kc.loadFromCluster();
  return kc.makeApiClient(CoreV1Api);
};
```

`src/k8s/k8s-info.ts`:
```ts
import type { V1ContainerStatus, V1Node, V1Pod } from "@kubernetes/client-node";
import { firstLine } from "../aws/aws-error.js";
import type { Clock } from "../clock.js";
import type { EnvLookup } from "../env.js";
import type { TtlCache } from "../inventory/ttl-cache.js";
import type { K8sClientFactory, K8sReadClient } from "./k8s-client.js";

export interface K8sContainer {
  name: string;
  image: string;
  ready: boolean;
  restart_count: number;
  state: string;
  started_at: string | null;
  last_terminated: { reason: string | null; exit_code: number; finished_at: string | null } | null;
}

export interface K8sPod {
  name: string;
  namespace: string;
  node: string | null;
  phase: string | null;
  started_at: string | null;
  service_account: string | null;
  qos_class: string | null;
  containers: K8sContainer[];
}

export interface K8sNode {
  name: string;
  instance_type: string | null;
  zone: string | null;
  region: string | null;
  arch: string | null;
  os_image: string | null;
  kubelet_version: string | null;
  container_runtime: string | null;
  provider_id: string | null;
  allocatable_cpu: string | null;
  allocatable_memory: string | null;
}

/** GET /api/k8s: this pod and its node as the API server sees them; off-cluster is a normal, displayable state. */
export interface K8sInfo {
  available: boolean;
  reason: string | null;
  pod: K8sPod | null;
  node: K8sNode | null;
  node_error: string | null;
  fetched_at: string;
}

export interface K8sInfoOptions {
  enabled: boolean;
  env: EnvLookup;
  clock: Clock;
  cache: TtlCache;
  createClient: K8sClientFactory;
  timeoutMs?: number;
}

const blank = (v: string | undefined): string | undefined => (v === undefined || v.trim() === "" ? undefined : v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" && v !== "" ? new Date(v).toISOString() : null);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`the Kubernetes API did not answer within ${ms}ms`), { name: "TimeoutError" })), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** One line per failure; 403s name the manifest that grants the missing permission. */
export function describeK8sError(err: unknown, what: "pods" | "nodes"): string {
  const e = err as { code?: unknown; name?: string; message?: string; body?: { message?: string } };
  const msg = firstLine(e.body?.message ?? e.message ?? String(err));
  if (e.name === "TimeoutError") return msg;
  switch (typeof e.code === "number" ? e.code : null) {
    case 403:
      return what === "pods"
        ? `forbidden: the service account cannot get pods — apply deploy/kubernetes/rbac.yaml (Role aws-dash-pod-reader) (${msg})`
        : `forbidden: the service account cannot get nodes — add the node-reader component (deploy/components/node-reader) to your overlay (${msg})`;
    case 401:
      return `unauthorized: the API server rejected the service-account token (${msg})`;
    case 404:
      return `${what === "pods" ? "pod" : "node"} not found (${msg})`;
    default:
      return msg;
  }
}

function mapContainer(c: V1ContainerStatus): K8sContainer {
  const state = c.state?.running ? "running" : c.state?.waiting ? `waiting (${c.state.waiting.reason ?? "unknown"})` : c.state?.terminated ? `terminated (${c.state.terminated.reason ?? `exit ${c.state.terminated.exitCode}`})` : "unknown";
  const t = c.lastState?.terminated;
  return {
    name: c.name,
    image: c.image,
    ready: c.ready,
    restart_count: c.restartCount,
    state,
    started_at: iso(c.state?.running?.startedAt),
    last_terminated: t ? { reason: str(t.reason), exit_code: t.exitCode, finished_at: iso(t.finishedAt) } : null,
  };
}

function mapPod(pod: V1Pod, name: string, namespace: string): K8sPod {
  return {
    name: pod.metadata?.name ?? name,
    namespace: pod.metadata?.namespace ?? namespace,
    node: str(pod.spec?.nodeName),
    phase: str(pod.status?.phase),
    started_at: iso(pod.status?.startTime),
    service_account: str(pod.spec?.serviceAccountName),
    qos_class: str(pod.status?.qosClass),
    containers: (pod.status?.containerStatuses ?? []).map(mapContainer),
  };
}

function mapNode(node: V1Node, name: string): K8sNode {
  const labels = node.metadata?.labels ?? {};
  return {
    name: node.metadata?.name ?? name,
    instance_type: str(labels["node.kubernetes.io/instance-type"]),
    zone: str(labels["topology.kubernetes.io/zone"]),
    region: str(labels["topology.kubernetes.io/region"]),
    arch: str(labels["kubernetes.io/arch"]),
    os_image: str(node.status?.nodeInfo?.osImage),
    kubelet_version: str(node.status?.nodeInfo?.kubeletVersion),
    container_runtime: str(node.status?.nodeInfo?.containerRuntimeVersion),
    provider_id: str(node.spec?.providerID),
    allocatable_cpu: str(node.status?.allocatable?.["cpu"]),
    allocatable_memory: str(node.status?.allocatable?.["memory"]),
  };
}

export class K8sInfoService {
  private static readonly KEY = "k8s";
  private readonly timeoutMs: number;

  constructor(private readonly opts: K8sInfoOptions) {
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  async get(force = false): Promise<K8sInfo> {
    if (!this.opts.enabled) return this.unavailable("disabled (K8S_INFO_ENABLED=false)");
    if (blank(this.opts.env("KUBERNETES_SERVICE_HOST")) === undefined) return this.unavailable("not running in Kubernetes (KUBERNETES_SERVICE_HOST is not set)");
    const name = blank(this.opts.env("POD_NAME"));
    const namespace = blank(this.opts.env("POD_NAMESPACE"));
    if (name === undefined || namespace === undefined) return this.unavailable("POD_NAME / POD_NAMESPACE are not set: add the downward API env entries from deploy/kubernetes/deployment.yaml");
    const entry = await this.opts.cache.get<K8sInfo>(K8sInfoService.KEY, () => this.load(name, namespace), force);
    return entry.value as K8sInfo;
  }

  peek(): K8sInfo | null {
    return this.opts.cache.peek<K8sInfo>(K8sInfoService.KEY)?.value ?? null;
  }

  invalidateAll(): void {
    this.opts.cache.invalidateAll();
  }

  private unavailable(reason: string): K8sInfo {
    return { available: false, reason, pod: null, node: null, node_error: null, fetched_at: this.opts.clock.now().toISOString() };
  }

  private async load(name: string, namespace: string): Promise<K8sInfo> {
    let client: K8sReadClient;
    try {
      client = this.opts.createClient();
    } catch (err) {
      return this.unavailable(`cannot load the in-cluster config: ${firstLine((err as Error).message ?? String(err))}`);
    }
    let pod: K8sPod;
    try {
      pod = mapPod(await withTimeout(client.readNamespacedPod({ name, namespace }), this.timeoutMs), name, namespace);
    } catch (err) {
      return this.unavailable(describeK8sError(err, "pods"));
    }
    const nodeName = pod.node ?? blank(this.opts.env("NODE_NAME")) ?? null;
    let node: K8sNode | null = null;
    let nodeError: string | null = null;
    if (nodeName === null) {
      nodeError = "the pod is not scheduled to a node yet";
    } else {
      try {
        node = mapNode(await withTimeout(client.readNode({ name: nodeName }), this.timeoutMs), nodeName);
      } catch (err) {
        nodeError = describeK8sError(err, "nodes");
      }
    }
    return { available: true, reason: null, pod, node, node_error: nodeError, fetched_at: this.opts.clock.now().toISOString() };
  }
}
```

- [ ] **Step 5: Wire deps, routes, refresh, card, CSS, test factory**

`src/app.ts` — imports `import { createInClusterClient, type K8sClientFactory } from "./k8s/k8s-client.js";` and `import { K8sInfoService } from "./k8s/k8s-info.js";`. `AppDeps` gains:
```ts
  /** Builds the in-cluster API client on first load; tests inject a fake. */
  createK8sClient: K8sClientFactory;
  k8sTimeoutMs: number;
  k8s: K8sInfoService;
```
`createDeps` after the `spiffe` block:
```ts
  const createK8sClientFn = overrides.createK8sClient ?? createInClusterClient;
  const k8sTimeoutMs = overrides.k8sTimeoutMs ?? 3000;
  const k8s = overrides.k8s ?? new K8sInfoService({
    enabled: settings.k8sInfoEnabled, env, clock, createClient: createK8sClientFn, timeoutMs: k8sTimeoutMs,
    cache: new TtlCache(settings.cacheTtlSeconds * 1000, clock, (err) => awsErrorFrom(err).message),
  });
```
and `createK8sClient: createK8sClientFn, k8sTimeoutMs, k8s,` in the return.

`src/routes/identity.ts` — append:
```ts
  app.get("/api/k8s", (req) => deps.k8s.get(isRefresh(req)));
  app.get("/partials/k8s", async (req, reply) => reply.partial("partials/k8s", { info: await deps.k8s.get(isRefresh(req)) }));
```
`src/routes/inventory.ts` — add `deps.k8s.invalidateAll();` to the refresh handler.

`views/pages/identity.eta` — add after the SPIFFE section:
```eta
  <section class="card" data-k8s-panel hx-get="/partials/k8s" hx-trigger="load">
    <h2>Kubernetes</h2>
    <p class="muted">Loading…</p>
  </section>
```

`views/partials/k8s.eta`:
```eta
<% const i = it.info, fmt = it.fmt; %>
<% const phaseBadge = (p) => p === "Running" ? "ok" : p === "Pending" ? "warn" : p === null ? "muted" : "bad"; %>
<h2>Kubernetes</h2>
<% if (!i.available) { %>
<p class="muted">Unavailable: <%= i.reason %></p>
<% } else { %>
<p class="muted">Read live from the API server with this pod's service-account token: the Role in <code>deploy/kubernetes/rbac.yaml</code> allows <code>get pods</code>; the <code>node-reader</code> component allows <code>get nodes</code>.</p>
<h3>This pod</h3>
<dl class="kv">
  <dt>Name</dt><dd><%= i.pod.name %></dd>
  <dt>Namespace</dt><dd><%= i.pod.namespace %></dd>
  <dt>Phase</dt><dd><span class="badge <%= phaseBadge(i.pod.phase) %>"><%= fmt.or(i.pod.phase) %></span></dd>
  <dt>Node</dt><dd><%= fmt.or(i.pod.node) %></dd>
  <dt>Started</dt><dd><%= fmt.time(i.pod.started_at) %></dd>
  <dt>Service account</dt><dd><%= fmt.or(i.pod.service_account) %></dd>
  <dt>QoS class</dt><dd><%= fmt.or(i.pod.qos_class) %></dd>
</dl>
<table class="k8s">
  <thead><tr><th>container</th><th>ready</th><th>restarts</th><th>state</th><th>last terminated</th></tr></thead>
  <tbody>
<% for (const c of i.pod.containers) { %>
    <tr>
      <td><%= c.name %></td>
      <td><span class="badge <%= c.ready ? "ok" : "warn" %>"><%= c.ready ? "yes" : "no" %></span></td>
      <td><%= c.restart_count %></td>
      <td><%= c.state %><% if (c.started_at !== null) { %> since <%= fmt.time(c.started_at) %><% } %></td>
      <td><% if (c.last_terminated === null) { %>—<% } else { %><span class="badge <%= c.last_terminated.reason === "Completed" ? "muted" : "bad" %>"><%= c.last_terminated.reason ?? "terminated" %> (exit <%= c.last_terminated.exit_code %>)</span><% if (c.last_terminated.finished_at !== null) { %> at <%= fmt.time(c.last_terminated.finished_at) %><% } %><% } %></td>
    </tr>
<% } %>
  </tbody>
</table>
<h3>This node</h3>
<% if (i.node === null) { %>
<p class="muted"><%= i.node_error %></p>
<% } else { %>
<dl class="kv">
  <dt>Name</dt><dd><%= i.node.name %></dd>
  <dt>Instance type</dt><dd><%= fmt.or(i.node.instance_type) %></dd>
  <dt>Zone / region</dt><dd><%= fmt.or(i.node.zone) %> / <%= fmt.or(i.node.region) %></dd>
  <dt>Architecture</dt><dd><%= fmt.or(i.node.arch) %></dd>
  <dt>OS image</dt><dd><%= fmt.or(i.node.os_image) %></dd>
  <dt>Kubelet</dt><dd><%= fmt.or(i.node.kubelet_version) %></dd>
  <dt>Container runtime</dt><dd><%= fmt.or(i.node.container_runtime) %></dd>
  <dt>Provider ID</dt><dd><%= fmt.or(i.node.provider_id) %></dd>
  <dt>Allocatable</dt><dd><%= fmt.or(i.node.allocatable_cpu) %> CPU · <%= fmt.or(i.node.allocatable_memory) %></dd>
</dl>
<% } %>
<% } %>
<p class="muted">Checked <%= fmt.time(i.fetched_at) %> · <a href="#" hx-get="/partials/k8s?refresh=1" hx-target="closest [data-k8s-panel]">refresh</a></p>
```
The test asserts `'<span class="badge bad">OOMKilled (exit 137)</span>'` — keep that markup on one line exactly as above (no whitespace inside the span).

`public/css/site.css` — next to the existing table rules add:
```css
table.k8s { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 13px; }
table.k8s th, table.k8s td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
table.k8s th { color: var(--muted); font-weight: 600; }
```
If an equivalent generic `table` rule already styles inventory tables, reuse its class instead and drop the new rule; the test only checks `restarts</th>`.

`tests/support/app-factory.ts` — import `FakeK8sClient` from `./fake-k8s.js`; create `const k8s = new FakeK8sClient();`, pass `createK8sClient: () => k8s, k8sTimeoutMs: 20,` to `createDeps`, return `k8s`.

- [ ] **Step 6: Run the tests; full suite; typecheck**

Run: `npx vitest run tests/k8s-info.test.ts && npm test && npm run typecheck`
Expected: 13 new tests PASS (10 service incl. 2 `it.each` rows + 3 route); suite 268; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/k8s/k8s-client.ts src/k8s/k8s-info.ts views/partials/k8s.eta views/pages/identity.eta public/css/site.css src/app.ts src/routes/identity.ts src/routes/inventory.ts tests/support/fake-k8s.ts tests/support/app-factory.ts tests/k8s-info.test.ts
git commit -m "feat: Kubernetes card shows this pod (restarts, OOMKilled) and its node from the API server" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: RBAC — pod-reader Role in the base, node-reader Component for overlays

**Files:**
- Create: `deploy/kubernetes/rbac.yaml`, `deploy/components/node-reader/kustomization.yaml`, `deploy/components/node-reader/clusterrole.yaml`, `deploy/components/node-reader/clusterrolebinding.yaml`
- Modify: `deploy/kubernetes/kustomization.yaml`, `deploy/eks-irsa/kustomization.yaml`, `deploy/eks-pod-identity/kustomization.yaml`, `deploy/kubernetes/README.md`, `deploy/eks-irsa/README.md`, `deploy/eks-pod-identity/README.md`, `deploy/README.md`

**Interfaces:**
- Consumes: the base (`namespace: aws-dash`, SA `aws-dash`).
- Produces: Role `aws-dash-pod-reader` + RoleBinding in every overlay; ClusterRole/ClusterRoleBinding `aws-dash-node-reader` (subject namespace `aws-dash`) wherever `components: [../components/node-reader]` is listed. Fact (verified with `kubectl kustomize` 2026-09-28): kustomize's namespace transformer does **not** rewrite a ClusterRoleBinding's `subjects[].namespace`, so an overlay that changes the namespace (Task 5's `ztwim`) must patch the subject and rename the binding.
- `scripts/kustomize-check.sh` iterates `deploy/*/` and skips directories without a `kustomization.yaml`, so `deploy/components/` is skipped and the component is validated through the overlays that use it.

- [ ] **Step 1: Base Role**

`deploy/kubernetes/rbac.yaml`:
```yaml
# The Kubernetes card reads this pod through the API server; nothing else in the app needs RBAC.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: aws-dash-pod-reader
rules:
  - apiGroups: [""]
    resources: [pods]
    verbs: [get]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: aws-dash-pod-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: aws-dash-pod-reader
subjects:
  - kind: ServiceAccount
    name: aws-dash
```
Add `  - rbac.yaml` to `deploy/kubernetes/kustomization.yaml` after `serviceaccount.yaml`.

- [ ] **Step 2: node-reader Component**

`deploy/components/node-reader/kustomization.yaml`:
```yaml
# Opt-in ClusterRole so the Kubernetes card can show the node (instance type, zone, kubelet). Overlays list it under `components:`.
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
resources:
  - clusterrole.yaml
  - clusterrolebinding.yaml
```
`deploy/components/node-reader/clusterrole.yaml`:
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: aws-dash-node-reader
rules:
  - apiGroups: [""]
    resources: [nodes]
    verbs: [get]
```
`deploy/components/node-reader/clusterrolebinding.yaml`:
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: aws-dash-node-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: aws-dash-node-reader
subjects:
  - kind: ServiceAccount
    name: aws-dash
    namespace: aws-dash   # kustomize does not rewrite this; overlays that change the namespace patch it (see deploy/ztwim)
```

- [ ] **Step 3: Opt the EKS overlays in and document**

In `deploy/eks-irsa/kustomization.yaml` and `deploy/eks-pod-identity/kustomization.yaml` add, after `resources:` and before `patches:`:
```yaml
components:
  - ../components/node-reader
```
`deploy/kubernetes/README.md`: add one bullet to the manifest list: "`rbac.yaml` — Role `aws-dash-pod-reader` (`get pods`) so the Kubernetes card can read this pod; node details need the `node-reader` component (`deploy/components/node-reader`, `get nodes`), which the EKS and ztwim overlays include."
`deploy/eks-irsa/README.md` and `deploy/eks-pod-identity/README.md`: add one sentence to the "what you should see" section: "The **Kubernetes** card shows this pod and, because this overlay includes the `node-reader` component, the node's instance type and zone."
`deploy/README.md`: add a paragraph after the matrix: "Every overlay grants the pod `get pods` on itself (`deploy/kubernetes/rbac.yaml`). `deploy/components/node-reader` adds `get nodes` for the Kubernetes card's node section; `eks-irsa`, `eks-pod-identity` and `ztwim` include it, `kubernetes`, `openshift` and `openshift-native-oidc` do not (the card then shows the pod and a hint)."

- [ ] **Step 4: Render and verify**

Run:
```bash
scripts/kustomize-check.sh
kubectl kustomize deploy/kubernetes | grep -cE "^kind: (Role|RoleBinding)$"
kubectl kustomize deploy/eks-irsa | grep -A3 "kind: ClusterRoleBinding" | head -8
kubectl kustomize deploy/eks-irsa | grep -B2 -A3 "^subjects:" | grep namespace
kubectl kustomize deploy/openshift | grep -c ClusterRole
scripts/check-placeholders.sh
```
Expected: five `ok` lines; base renders 2 (Role + RoleBinding); eks-irsa renders the ClusterRoleBinding with `namespace: aws-dash`; openshift renders 0 ClusterRole objects; placeholder check exit 0.

- [ ] **Step 5: Commit**

```bash
git add deploy/kubernetes/rbac.yaml deploy/kubernetes/kustomization.yaml deploy/components deploy/eks-irsa/kustomization.yaml deploy/eks-pod-identity/kustomization.yaml deploy/kubernetes/README.md deploy/eks-irsa/README.md deploy/eks-pod-identity/README.md deploy/README.md
git commit -m "deploy: pod-reader Role in the base and an opt-in node-reader component for the Kubernetes card" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `deploy/ztwim` overlay, trust-policy template and runbook

**Files:**
- Create: `deploy/ztwim/kustomization.yaml`, `deploy/ztwim/route.yaml`, `deploy/ztwim/identity-configmap.yaml`, `deploy/ztwim/spiffe-helper-configmap.yaml`, `deploy/ztwim/clusterspiffeid.yaml`, `deploy/ztwim/README.md`, `deploy/aws/trust-ztwim.json`
- Modify: `scripts/check-placeholders.sh` (add `TRUST_DOMAIN`), `deploy/aws/README.md`, `deploy/README.md` (matrix row)

**Interfaces:**
- Consumes: the base, the `node-reader` component (Task 4), the app's env contract (`AUTH_MODE=web-identity`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_ROLE_SESSION_NAME`, `SPIFFE_ENDPOINT_SOCKET`, `SPIFFE_JWT_AUDIENCE`, `AWS_EC2_METADATA_DISABLED`), the SPIFFE card (Task 2) and Kubernetes card (Task 3) for "what you should see".
- Produces: an overlay that renders with `kubectl kustomize`; placeholders exactly `AWS_ACCOUNT_ID` (identity ConfigMap) and `AWS_ACCOUNT_ID`, `OIDC_ISSUER_HOST`, `TRUST_DOMAIN` (trust policy), each named as a `sed` target in the README of its directory.
- Facts (verified 2026-09-28): spiffe-helper writes the JWT-SVID file as the raw compact JWT (`jwtSVID.Marshal()` + `os.WriteFile`), which is exactly what `fromTokenFile` reads; `ClusterSPIFFEID` is `spire.spiffe.io/v1alpha1` (the operator's own CRs are `operator.openshift.io/v1alpha1`); the operator's auto-created ClusterSPIFFEID is a `fallback`, so an explicit one for this namespace takes precedence without an entry conflict; the CSI driver is `csi.spiffe.io` and the socket file is `spire-agent.sock`; native sidecars (`initContainers[].restartPolicy: Always`) are GA in Kubernetes 1.33 and enabled from OpenShift 4.16; the Red Hat spiffe-helper image tag both sibling repos pin is `v0.11.0-1787560110`.

- [ ] **Step 1: Manifests**

`deploy/ztwim/route.yaml` — identical to `deploy/openshift/route.yaml` (copy it).

`deploy/ztwim/identity-configmap.yaml`:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: aws-dash-identity
data:
  AWS_ROLE_ARN: arn:aws:iam::AWS_ACCOUNT_ID:role/aws-dash-ztwim
  AWS_ROLE_SESSION_NAME: aws-dash
```

`deploy/ztwim/spiffe-helper-configmap.yaml`:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: spiffe-helper
data:
  # Static config on purpose (no shell templating): the audience must equal the "aud" the IAM role trusts.
  # spiffe-helper writes the JWT-SVID as a raw compact JWT, which is what the AWS SDK's fromTokenFile reads.
  helper.conf: |
    agent_address = "/spiffe-workload-api/spire-agent.sock"
    jwt_svids = [{jwt_audience = "aws-dash", jwt_svid_file_name = "/var/run/secrets/aws/token"}]
    jwt_svid_file_mode = 0644
```

`deploy/ztwim/clusterspiffeid.yaml`:
```yaml
# Explicit registration for this namespace; the operator's own ClusterSPIFFEID is a fallback, so this one wins for these pods.
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: aws-dash-ztwim
spec:
  spiffeIDTemplate: "spiffe://{{ .TrustDomain }}/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  namespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: aws-dash-ztwim
  podSelector:
    matchLabels:
      app: aws-dash
```

`deploy/ztwim/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: aws-dash-ztwim
resources:
  - ../kubernetes
  - route.yaml
  - identity-configmap.yaml
  - spiffe-helper-configmap.yaml
  - clusterspiffeid.yaml
components:
  - ../components/node-reader
patches:
  - target: {kind: Namespace, name: aws-dash}
    patch: |-
      - op: replace
        path: /metadata/name
        value: aws-dash-ztwim
  # The component binds the SA in namespace aws-dash; this overlay lives elsewhere, so rename and repoint the binding.
  - target: {kind: ClusterRoleBinding, name: aws-dash-node-reader}
    patch: |-
      - op: replace
        path: /metadata/name
        value: aws-dash-node-reader-ztwim
      - op: replace
        path: /subjects/0/namespace
        value: aws-dash-ztwim
  - target: {kind: ConfigMap, name: aws-dash-config}
    patch: |-
      - op: replace
        path: /data/AUTH_MODE
        value: web-identity
  - target: {kind: Deployment, name: aws-dash}
    patch: |-
      - op: add
        path: /spec/template/spec/volumes/-
        value:
          name: spiffe-workload-api
          csi:
            driver: csi.spiffe.io
            readOnly: true
      - op: add
        path: /spec/template/spec/volumes/-
        value:
          name: spiffe-helper-config
          configMap:
            name: spiffe-helper
      - op: add
        path: /spec/template/spec/volumes/-
        value:
          name: aws-token
          emptyDir:
            medium: Memory
      # Native sidecar: starts before the app, restarts with the pod, keeps the JWT-SVID file fresh (ZTWIM JWT TTL ≈ 5 min).
      - op: add
        path: /spec/template/spec/initContainers/-
        value:
          name: spiffe-helper
          image: registry.redhat.io/zero-trust-workload-identity-manager/spiffe-helper-rhel9:v0.11.0-1787560110
          restartPolicy: Always
          command: ["/spiffe-helper"]
          args: ["-config", "/etc/spiffe-helper/helper.conf", "-daemon-mode=true"]
          resources:
            requests: {cpu: 10m, memory: 32Mi}
            limits: {cpu: 100m, memory: 64Mi}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: {drop: [ALL]}
          volumeMounts:
            - {name: spiffe-workload-api, mountPath: /spiffe-workload-api, readOnly: true}
            - {name: spiffe-helper-config, mountPath: /etc/spiffe-helper, readOnly: true}
            - {name: aws-token, mountPath: /var/run/secrets/aws}
      - op: add
        path: /spec/template/spec/containers/0/volumeMounts/-
        value: {name: aws-token, mountPath: /var/run/secrets/aws, readOnly: true}
      - op: add
        path: /spec/template/spec/containers/0/volumeMounts/-
        value: {name: spiffe-workload-api, mountPath: /spiffe-workload-api, readOnly: true}
      - op: add
        path: /spec/template/spec/containers/0/envFrom/-
        value: {configMapRef: {name: aws-dash-identity}}
      - op: add
        path: /spec/template/spec/containers/0/env/-
        value: {name: AWS_WEB_IDENTITY_TOKEN_FILE, value: /var/run/secrets/aws/token}
      - op: add
        path: /spec/template/spec/containers/0/env/-
        value: {name: SPIFFE_ENDPOINT_SOCKET, value: unix:///spiffe-workload-api/spire-agent.sock}
      - op: add
        path: /spec/template/spec/containers/0/env/-
        value: {name: SPIFFE_JWT_AUDIENCE, value: aws-dash}
      - op: add
        path: /spec/template/spec/containers/0/env/-
        value: {name: AWS_EC2_METADATA_DISABLED, value: "true"}
```

`deploy/aws/trust-ztwim.json`:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "arn:aws:iam::AWS_ACCOUNT_ID:oidc-provider/OIDC_ISSUER_HOST" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "OIDC_ISSUER_HOST:aud": "aws-dash",
          "OIDC_ISSUER_HOST:sub": "spiffe://TRUST_DOMAIN/ns/aws-dash-ztwim/sa/aws-dash"
        }
      }
    }
  ]
}
```

- [ ] **Step 2: Placeholder list, aws README, matrix**

`scripts/check-placeholders.sh`: change the list to `PLACEHOLDERS='AWS_ACCOUNT_ID|OIDC_ISSUER_HOST|TRUST_DOMAIN|000000000000|REPLACE_ME'`.
`deploy/aws/README.md`: add the bullet "`trust-ztwim.json` — role trust for OpenShift + Zero Trust Workload Identity Manager (SPIRE JWT-SVID). Placeholders: `AWS_ACCOUNT_ID`, `OIDC_ISSUER_HOST` (the SPIRE OIDC discovery host), `TRUST_DOMAIN` (the SPIRE trust domain, e.g. `apps.example.com`)." and extend the last sentence to "…fills `AWS_ACCOUNT_ID`, `OIDC_ISSUER_HOST` and `TRUST_DOMAIN`…".
`deploy/README.md`: replace the `ztwim` matrix row with:
```markdown
| `ztwim` | OpenShift + Zero Trust Workload Identity Manager | SPIRE JWT-SVID written by a spiffe-helper native sidecar → `sts:AssumeRoleWithWebIdentity` | no | `Federated` SPIRE OIDC discovery provider | `<issuer>:aud` = `aws-dash`, `<issuer>:sub` = `spiffe://<trust-domain>/ns/aws-dash-ztwim/sa/aws-dash` |
```

- [ ] **Step 3: Runbook**

`deploy/ztwim/README.md` (write the file with 3-backtick code fences; the 4-backtick fence below only wraps this plan block):
````markdown
# aws-dash on OpenShift with Zero Trust Workload Identity Manager (SPIFFE/SPIRE) → AWS

SPIRE issues this pod a **JWT-SVID** whose `sub` is its SPIFFE ID. IAM trusts SPIRE's OIDC discovery endpoint as an
OIDC identity provider, and STS exchanges the JWT-SVID for role credentials with `AssumeRoleWithWebIdentity`.

- A spiffe-helper **native sidecar** (`initContainers` with `restartPolicy: Always`, Red Hat image) fetches the JWT-SVID
  over the SPIRE agent socket, mounted with the `csi.spiffe.io` CSI driver, and writes it to `/var/run/secrets/aws/token`
  as a raw compact JWT. It keeps the file fresh; ZTWIM's default JWT-SVID lifetime is about 5 minutes.
- The AWS SDK's `fromTokenFile` **re-reads that file on every credential resolve**, so rotation needs no app code.
- The app also mounts the socket itself, read-only, for the **SPIFFE** card: it reads the X.509-SVID and a JWT-SVID
  for display and never shows raw material. `AUTH_MODE=web-identity` keeps the credential path on the file.

## 0. ZTWIM prerequisites AWS enforces

The operator must be installed with its `cluster` CRs (`ZeroTrustWorkloadIdentityManager`, `SpireServer`, `SpireAgent`,
`SpiffeCSIDriver`, `SpireOIDCDiscoveryProvider`) healthy. AWS needs three things:

1. **RSA signing.** Use `jwtKeyType: rsa-2048` on the `SpireServer` (`operator.openshift.io/v1alpha1`) — the same
   server can serve azure-dash, which needs RSA too. (Whether IAM also accepts SPIRE's default EC keys is spec §15
   risk 1 — record what you observe.)
2. **Public discovery endpoint with a publicly trusted certificate.** `SpireOIDCDiscoveryProvider.spec.jwtIssuer` must
   equal `SpireServer.spec.jwtIssuer`; `managedRoute: "true"` creates the Route; point `externalSecretRef` at a
   cert-manager/ACME certificate. STS fetches `/.well-known/openid-configuration` and the JWKS from the public internet.
3. **A SPIFFE ID of the form** `spiffe://<trust-domain>/ns/aws-dash-ztwim/sa/aws-dash`. This overlay ships an explicit
   `ClusterSPIFFEID` for the namespace (`spire.spiffe.io/v1alpha1`); the operator's own one is a fallback.

```bash
export JWT_ISSUER=$(oc get spireoidcdiscoveryprovider cluster -o jsonpath='{.spec.jwtIssuer}')
export TRUST_DOMAIN=$(oc get spireserver cluster -o jsonpath='{.spec.trustDomain}')
export OIDC_ISSUER_HOST=${JWT_ISSUER#https://}
curl -fsS "$JWT_ISSUER/.well-known/openid-configuration" | jq '{issuer, jwks_uri}'
curl -fsS "$(curl -fsS "$JWT_ISSUER/.well-known/openid-configuration" | jq -r .jwks_uri)" | jq '.keys[0] | {kty, alg, use}'
openssl s_client -connect "$OIDC_ISSUER_HOST:443" -servername "$OIDC_ISSUER_HOST" </dev/null 2>/dev/null | grep -E "Verify return code|issuer="
```

`issuer` must equal `$JWT_ISSUER` byte for byte (scheme, host, no trailing slash), `kty` must be `RSA`, and the verify
return code must be `0 (ok)` — a private CA here is the most common reason for `InvalidIdentityToken`.

## 1. IAM OIDC provider, role, permissions

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
if [ -z "$(aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?ends_with(Arn, '$OIDC_ISSUER_HOST')].Arn" --output text)" ]; then
  aws iam create-open-id-connect-provider --url "$JWT_ISSUER" --client-id-list aws-dash
fi
sed -e "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/g" -e "s#OIDC_ISSUER_HOST#$OIDC_ISSUER_HOST#g" -e "s#TRUST_DOMAIN#$TRUST_DOMAIN#g" deploy/aws/trust-ztwim.json > /tmp/aws-dash-trust.json
aws iam create-role --role-name aws-dash-ztwim --assume-role-policy-document file:///tmp/aws-dash-trust.json
aws iam create-policy --policy-name aws-dash-readonly --policy-document file://deploy/aws/aws-dash-readonly-policy.json 2>/dev/null || true
aws iam attach-role-policy --role-name aws-dash-ztwim --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/aws-dash-readonly"
```

The trust policy pins `aud = aws-dash` (the audience spiffe-helper requests) and `sub = spiffe://$TRUST_DOMAIN/ns/aws-dash-ztwim/sa/aws-dash`.

## 2. Deploy

```bash
sed -i.bak "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/" deploy/ztwim/identity-configmap.yaml
oc apply -k deploy/ztwim
oc -n aws-dash-ztwim rollout status deploy/aws-dash
oc -n aws-dash-ztwim logs deploy/aws-dash -c spiffe-helper --tail=20
oc -n aws-dash-ztwim exec deploy/aws-dash -c aws-dash -- head -c 20 /var/run/secrets/aws/token; echo   # expect: eyJ...
oc -n aws-dash-ztwim get route aws-dash -o jsonpath='https://{.spec.host}{"\n"}'
```

`oc apply -k` needs cluster-admin once for the `ClusterSPIFFEID` and the `node-reader` ClusterRoleBinding.

## 3. What you should see

- **Identity** — mode `web-identity`, flavor **SPIFFE JWT-SVID (spiffe-helper)**, `iss = $JWT_ISSUER`,
  `sub = spiffe://$TRUST_DOMAIN/ns/aws-dash-ztwim/sa/aws-dash`, `aud = aws-dash`; STS returns
  `assumed-role/aws-dash-ztwim/aws-dash`; credentials `ASIA…`, source `h: web-identity token file`, `k: AssumeRoleWithWebIdentity`.
- **SPIFFE workload identity** — the X.509-SVID's SPIFFE ID with the badge *same as the token sub presented to STS*,
  its validity window, and the JWT-SVID claims for audience `aws-dash`. Reload a few minutes apart: `iat`/`exp` advance.
- **Kubernetes** — this pod with the `spiffe-helper` sidecar absent from the container table (it is an init container)
  and the node's instance type via the `node-reader` component.
- After the STS credential's expiry passes, **Refresh all** on the AWS tab still succeeds: the SDK re-read the rotated file.

## 4. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `InvalidIdentityToken: No OpenIDConnect provider found` | provider URL ≠ token `iss` | compare `aws iam get-open-id-connect-provider` URL with the Identity card's `iss` |
| `InvalidIdentityToken: Couldn't retrieve verification key` | Route certificate not publicly trusted, or JWKS unreachable | step 0.2; check `externalSecretRef` |
| `AccessDenied` on `AssumeRoleWithWebIdentity` | trust `sub`/`aud` mismatch | compare the decoded claims on the Identity card with `/tmp/aws-dash-trust.json` |
| token file missing / empty | sidecar not running or no registration entry | `oc logs -c spiffe-helper`; `oc get clusterspiffeid`; `oc -n zero-trust-workload-identity-manager logs deploy/spire-controller-manager` |
| SPIFFE card: *SPIRE agent not reachable* | CSI volume not mounted, agent DaemonSet unhealthy | `oc get csidriver csi.spiffe.io`; `oc -n zero-trust-workload-identity-manager get ds` |
| SPIFFE card: *no registration entry matches this pod* | ClusterSPIFFEID selectors do not match | labels `app: aws-dash`, namespace label `kubernetes.io/metadata.name` |
| `ExpiredToken` | clock skew or spiffe-helper stopped rotating | `oc logs -c spiffe-helper --since=10m` |

## 5. Alternative: one annotation instead of this overlay

`github.com/kenmoini/ztwim-oidc-shims` is a mutating webhook that injects the spiffe-helper sidecar, the CSI volume and the
whole `AWS_*`/`SPIFFE_*` env set from a single pod annotation. With it, `deploy/openshift` plus that annotation reaches
the same state as this overlay.

## 6. Record what you saw

Fill in `docs/verification/ztwim-phase4.md` (JWT key type accepted, file format, native-sidecar behaviour, socket path)
and copy corrections back here and into spec §15.
````

- [ ] **Step 4: Render and verify**

Run:
```bash
scripts/kustomize-check.sh
kubectl kustomize deploy/ztwim | grep -nE "^kind:|namespace: aws-dash-ztwim|aws-dash-node-reader-ztwim|restartPolicy: Always|csi.spiffe.io|SPIFFE_ENDPOINT_SOCKET|AUTH_MODE"
kubectl kustomize deploy/ztwim | grep -c runAsUser
node -e 'JSON.parse(require("fs").readFileSync("deploy/aws/trust-ztwim.json","utf8")); console.log("json ok")'
scripts/check-placeholders.sh
```
Expected: six `ok` lines from kustomize-check (`eks-irsa`, `eks-pod-identity`, `kubernetes`, `openshift`, `openshift-native-oidc`, `ztwim`); the ztwim render shows a `ClusterSPIFFEID`, the renamed ClusterRoleBinding with subject namespace `aws-dash-ztwim`, `restartPolicy: Always`, the CSI driver, both env vars and `AUTH_MODE: web-identity`; `runAsUser` count 0; `json ok`; placeholder check lists `deploy/aws/trust-ztwim.json` (3 tokens) and `deploy/ztwim/identity-configmap.yaml` (1) as `ok`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add deploy/ztwim deploy/aws/trust-ztwim.json deploy/aws/README.md deploy/README.md scripts/check-placeholders.sh
git commit -m "deploy: ztwim overlay — spiffe-helper native sidecar, CSI socket, ClusterSPIFFEID, trust policy and runbook" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: README, verification record, drift checks

**Files:**
- Modify: `README.md`
- Create: `docs/verification/ztwim-phase4.md`

**Interfaces:**
- Consumes: everything above; the README must match `src/routes/identity.ts` and `src/config.ts`.

- [ ] **Step 1: README.md**

- **Status** → `Phase 4: the SPIFFE card (X.509 and JWT SVIDs read from the SPIRE Workload API, display only), the Kubernetes card (this pod, restarts, OOMKilled, the node), the pod-reader Role and node-reader component, and the ZTWIM overlay with a spiffe-helper native sidecar. Phase 5 is documentation.`
- **Endpoints**: add rows `GET /api/spiffe[?refresh=true]` → `{available, reason, socket, x509{spiffe_id, san_uris, serial, issuer, not_before, not_after, expires_in_seconds}, x509_error, jwt{claims, issued_at, expires_at, error, spiffe_id, audience}, fetched_at}`; `GET /partials/spiffe`; `GET /api/k8s[?refresh=true]` → `{available, reason, pod{name, namespace, node, phase, started_at, service_account, qos_class, containers[…]}, node{…}, node_error, fetched_at}`; `GET /partials/k8s`; extend the `/identity` row's list with "SPIFFE card, Kubernetes card" and the `/api/aws/refresh` row with "spiffe and k8s".
- **Configuration**: replace the "used from Phase 4 onward" row with three rows: `K8S_INFO_ENABLED` (`true`; `false` → the Kubernetes card renders a disabled state and never builds an API client), `SPIFFE_ENDPOINT_SOCKET` (unset; e.g. `unix:///spiffe-workload-api/spire-agent.sock`; unset → the SPIFFE card says so and never opens the socket), `SPIFFE_JWT_AUDIENCE` (`aws-dash`; audience of the *display* JWT-SVID fetch — the credential path's audience is spiffe-helper's `helper.conf`). Extend the `AWS_CACHE_TTL_SECONDS` row's list with "SPIFFE, Kubernetes".
- **Permissions**: add a sentence: "The Kubernetes card needs the Role in `deploy/kubernetes/rbac.yaml` (`get pods`) and, for the node section, the `node-reader` component (`get nodes`)."
- **Deploy**: add [`deploy/ztwim`](deploy/ztwim/README.md) to the overlay list.
- **Demo**: add `10. Trigger the memory control past the limit, wait for the restart, then open Identity → Kubernetes: the container's last state reads OOMKilled (exit 137) and the restart count went up.` and `11. On the ztwim overlay, compare the SPIFFE card's X.509 SPIFFE ID with the Identity card's sub — the badge says they match — and reload after five minutes to watch iat/exp advance.`

- [ ] **Step 2: Verification record**

`docs/verification/ztwim-phase4.md`:
````markdown
# Phase 4 live verification on OpenShift + ZTWIM (pending)

Not yet run: this machine has no cluster access. Run on a real cluster with the operator installed and fill in the
observations; several are spec §15 risks the docs currently state as expectations.

| Check | Command / where to look | Observed |
|---|---|---|
| IAM accepts the SPIRE issuer (RSA `jwtKeyType`; does EC work too?) | Identity card → STS section; `aws iam create-open-id-connect-provider` | |
| Exact `iss` equality (scheme, path, trailing slash) | Identity card `iss` vs `aws iam get-open-id-connect-provider` | |
| spiffe-helper file format is a raw compact JWT | `oc exec … -- head -c 20 /var/run/secrets/aws/token` | |
| `jwt_svid_file_mode` honoured under the arbitrary UID | `oc exec … -- ls -l /var/run/secrets/aws/token` | |
| Native sidecar with the Red Hat image (`restartPolicy: Always`) | `oc get pod -o jsonpath='{.items[0].spec.initContainers[0].restartPolicy}'`; pod restarts keep the sidecar | |
| SPIFFE card X.509 SPIFFE ID == token `sub` | SPIFFE card badge | |
| `iat`/`exp` advance between loads minutes apart | SPIFFE and Identity cards | |
| SDK re-reads the rotated file after the STS credential expires | AWS tab "Refresh all" after ~1 h | |
| Kubernetes card: node via `node-reader`; OOMKilled after the memory control | Identity → Kubernetes | |
| Socket path in the CSI volume is `spire-agent.sock` | `oc exec … -- ls /spiffe-workload-api` | |

Record the exact strings observed and copy corrections back into `deploy/ztwim/README.md` and spec §15.
````

- [ ] **Step 3: Drift checks**

Run:
```bash
grep -oE '`/(api|partials)/(spiffe|k8s)[^`]*`' README.md | sort -u
grep -nE 'app\.get\("/(api|partials)/(spiffe|k8s)"' src/routes/identity.ts
grep -oE '^\| `[A-Z_]+`' README.md | tr -d '`| ' | sort -u > /private/tmp/claude-501/-Users-kemo-Development-aws-dash/374cc4ea-6a9e-4a63-a874-15547341036f/scratchpad/readme-vars.txt
grep -oE 'env\("[A-Z_]+"\)' src/config.ts | grep -oE '[A-Z_]+' | sort -u > /private/tmp/claude-501/-Users-kemo-Development-aws-dash/374cc4ea-6a9e-4a63-a874-15547341036f/scratchpad/config-vars.txt
comm -23 /private/tmp/claude-501/-Users-kemo-Development-aws-dash/374cc4ea-6a9e-4a63-a874-15547341036f/scratchpad/readme-vars.txt /private/tmp/claude-501/-Users-kemo-Development-aws-dash/374cc4ea-6a9e-4a63-a874-15547341036f/scratchpad/config-vars.txt
scripts/check-placeholders.sh >/dev/null && echo placeholders ok
```
Expected: four README endpoints, four matching routes, empty `comm` output, `placeholders ok`.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/verification/ztwim-phase4.md
git commit -m "docs: README for the SPIFFE and Kubernetes cards, the ztwim overlay, and the pending ZTWIM verification record" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 4 exit criteria

- `npm test` green (Phase 3's 237 + ≈31 new), `npm run typecheck` clean; no test reaches the network or a cluster; `find node_modules -name '*.node'` finds nothing after `npm prune --omit=dev --omit=optional`.
- The Identity page shows five cards; SPIFFE and Kubernetes say "Unavailable: …" with an accurate reason on a laptop and never throw; raw SVID material appears in no HTML, JSON or log line (tests).
- `scripts/kustomize-check.sh` renders six overlays; `scripts/check-placeholders.sh` passes with `TRUST_DOMAIN` in its list; the ztwim render carries the native sidecar, the CSI socket and the repointed ClusterRoleBinding.
- `docs/verification/ztwim-phase4.md` exists and is honest about what has not been run.

Next: Phase 5 — documentation pass (top-level README modes table and demo script, `deploy/README.md`, drift pass) — written after Phase 4 ships and, ideally, after the EKS and ZTWIM verification records are filled in.
