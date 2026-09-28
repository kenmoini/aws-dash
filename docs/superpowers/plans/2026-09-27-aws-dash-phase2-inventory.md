# aws-dash Phase 2 — Credentials, AWS Inventory Tab, Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The AWS tab works end-to-end with static keys (and, without code changes, with any other credential source the SDK supports): explicit credential-mode selection with a "why", eight read-only inventory panels behind a keep-last-good TTL cache, actionable error hints, a least-privilege IAM policy, and a Prometheus `/metrics` endpoint.

**Architecture:** Three new modules plug into the Phase 1 `AppDeps` seam: `src/aws/*` (client defaults + error translation), `src/identity/*` (mode resolution → one memoized SDK credential provider shared by every client), `src/inventory/*` (`AwsProvider` interface with a live SDK implementation and a test fake, `TtlCache`, `InventoryService`, routes, templates), plus `src/metrics/*` (prom-client registry fed by `collect()` callbacks so scrapes never call AWS). Routes never import the SDK; every cloud failure renders inside its panel.

**Tech Stack:** Phase 1 stack + `@aws-sdk/client-{sts,ec2,s3,eks,ecr,iam}` and `@aws-sdk/credential-providers` 3.1141.0, `@smithy/property-provider` 4.5.2 (`memoize`), `prom-client` 15.1.3; dev: `aws-sdk-client-mock` 4.1.0 (the only way to test paginators, which `instanceof`-check their client).

**Spec:** `docs/superpowers/specs/2026-09-27-aws-dash-design.md` — sections 2 (inventory/metrics/refresh endpoints), 3, 4 (credential selection), 6 (inventory), 8 (metrics), 11 (`deploy/aws/aws-dash-readonly-policy.json`), 13 (Phase 2 list), 14–15. Phase 1 plan (conventions, `AppDeps`, `testApp`): `docs/superpowers/plans/2026-09-27-aws-dash-phase1-runtime.md`.

## Global Constraints

- Everything in the Phase 1 plan's Global Constraints still applies (ESM/NodeNext `.js` imports, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, snake_case JSON, `HX-Request` → HTML else JSON, 422/403 conventions, Eta `/`-rooted template names, commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` as a real trailer via two `-m` flags).
- Exact pins: `@aws-sdk/client-ec2`, `client-ecr`, `client-eks`, `client-iam`, `client-s3`, `client-sts`, `credential-providers` = **3.1141.0**; `@smithy/property-provider` = **4.5.2**; `prom-client` = **15.1.3**; dev `aws-sdk-client-mock` = **4.1.0**.
- **Routes never import `@aws-sdk/*`.** Only `src/aws/`, `src/identity/`, `src/inventory/live-provider.ts` do. Every cloud failure is a `200` panel with an error banner (or the `error` field of the JSON), never a 5xx.
- Credential selection is explicit per mode (`fromEnv`, `fromIni`, `fromTokenFile`, `fromHttp`, `fromInstanceMetadata`) — never `fromNodeProviderChain`. `auto` resolves in SDK-chain order: static → profile → web-identity → pod-identity → imds. One provider, wrapped once in `memoize`, is shared by every client so a web-identity session costs one STS exchange.
- Per-kind JSON: `GET /api/aws/{kind}` → `{ kind, fetched_at, error, items, truncated }`; unknown kind → 404 `{detail}`; `POST /api/aws/refresh` → 204. Eight kinds in this order: `account, instances, vpcs, subnets, securitygroups, s3buckets, eksclusters, ecrrepos`.
- `TtlCache`: TTL = `AWS_CACHE_TTL_SECONDS`; single-flight per key; on failure keep the last good value and record the error; `invalidateAll()` bumps an epoch so in-flight results from before the refresh are not stored. Stale banner text: `Last attempt <time> failed; showing previously cached data`.
- `MAX_ITEMS = 500` per kind with `truncated: true` when hit; EKS `DescribeCluster` capped at 20 clusters, concurrency 4.
- Every client gets `clientDefaults`: `maxAttempts: 2`, `requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 }`, region from `AWS_REGION`/`AWS_DEFAULT_REGION` (missing → `AwsError` "AWS_REGION is not set…" per panel, never a crash), and the pino child logger as SDK `logger` only when `AWS_DEBUG=true`.
- `/metrics` returns the prom-client default registry (`aws_dash_*` gauges/histograms + `collectDefaultMetrics`); 404 `{detail}` when `METRICS_ENABLED=false`; a scrape must never trigger an AWS call.
- Tests never reach AWS: `FakeAwsProvider` for service/routes/pages; `aws-sdk-client-mock` for `LiveAwsProvider`; credential providers are constructed but never resolved in tests.
- Least-privilege policy `deploy/aws/aws-dash-readonly-policy.json` lists exactly: `sts:GetCallerIdentity, iam:ListAccountAliases, iam:GetRole, ec2:DescribeRegions, ec2:DescribeInstances, ec2:DescribeVpcs, ec2:DescribeSubnets, ec2:DescribeSecurityGroups, s3:ListAllMyBuckets, eks:ListClusters, eks:DescribeCluster, ecr:DescribeRepositories`.

## Review Focus

1. `AWS_REGION` unset (the base ConfigMap has it, a hand-rolled `podman run` may not): every panel must show the "AWS_REGION is not set" hint and the app must stay up — Task 1 (`clientDefaults` throws `AwsError`) and Task 6 (`LiveAwsProvider` without region rejects every call with that message, and `InventoryService` turns it into a panel error).
2. One denied kind must not poison the others and must keep its previous items — Task 4 test: `fail("instances")` after a successful load → `error` set, `items` unchanged, `vpcs` unaffected.
3. "Refresh all" while a slow load is in flight must not store that stale result — Task 3 epoch test.
4. A misconfigured mode (e.g. `AUTH_MODE=web-identity` with no `AWS_ROLE_ARN`) must surface the missing-variable list in every panel and be retried on the next request rather than cached — Task 2 (`CredentialProvider.get()` retries) and Task 4 (service retries provider creation).
5. A `/metrics` scrape must not call AWS or block on the cache — Task 9 test asserts the fake provider's call count is unchanged across a scrape.

---

### Task 1: SDK dependencies, client defaults, error translation

**Files:**
- Modify: `package.json` (+ `package-lock.json` via `npm install`)
- Create: `src/aws/aws-error.ts`, `src/aws/client-defaults.ts`
- Test: `tests/aws-error.test.ts`, `tests/client-defaults.test.ts`

**Interfaces:**
- Produces: `class AwsError extends Error { code: string | null; status: number | null }`; `firstLine(text)`; `awsErrorFrom(err: unknown): AwsError` (idempotent on `AwsError`); `interface AwsClientDefaults { region, credentials, maxAttempts, requestHandler: {connectionTimeout, requestTimeout}, logger? }`; `clientDefaults({ region, credentials, logger, debug }): AwsClientDefaults` (throws `AwsError` with `REGION_HINT` when region is undefined); `REGION_HINT` constant.

- [ ] **Step 1: Add the dependencies**

Edit `package.json` `dependencies` (keep alphabetical) and `devDependencies`:
```json
    "@aws-sdk/client-ec2": "3.1141.0",
    "@aws-sdk/client-ecr": "3.1141.0",
    "@aws-sdk/client-eks": "3.1141.0",
    "@aws-sdk/client-iam": "3.1141.0",
    "@aws-sdk/client-s3": "3.1141.0",
    "@aws-sdk/client-sts": "3.1141.0",
    "@aws-sdk/credential-providers": "3.1141.0",
    "@smithy/property-provider": "4.5.2",
```
plus `"prom-client": "15.1.3"` after `"pino"`, and in `devDependencies`: `"aws-sdk-client-mock": "4.1.0"` (alphabetically first).

Run: `npm install` — expect the lockfile to grow (~60 MB of `node_modules`, mostly `client-ec2`) and `npm test` still green (78+ tests).

- [ ] **Step 2: Write the failing tests**

`tests/aws-error.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { AwsError, awsErrorFrom, firstLine } from "../src/aws/aws-error.js";

const sdkError = (name: string, message: string, status?: number, code?: string) =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status }, code });

describe("firstLine", () => {
  it("keeps only the first line, trimmed", () => {
    expect(firstLine("  boom  \nstack\nmore")).toBe("boom");
    expect(firstLine("one")).toBe("one");
  });
});

describe("awsErrorFrom", () => {
  it("returns AwsError instances unchanged", () => {
    const e = new AwsError("x");
    expect(awsErrorFrom(e)).toBe(e);
  });
  it.each([
    ["CredentialsProviderError", "Could not load credentials from any providers", undefined, /no usable credentials; set AUTH_MODE/],
    ["CredentialsProviderError", "Web identity token file not found", undefined, /spiffe-helper sidecar or the IRSA webhook/],
    ["InvalidIdentityToken", "No OpenIDConnect provider found in your account for https://x", 400, /IAM OIDC provider URL must equal the token's iss/],
    ["IDPCommunicationError", "Unable to reach the identity provider", 400, /discovery endpoint/],
    ["ExpiredTokenException", "Token expired", 400, /clock skew/],
    ["AccessDenied", "User is not authorized to perform: sts:AssumeRoleWithWebIdentity on resource: arn:aws:iam::1:role/x", 403, /trust policy rejected this identity/],
    ["AccessDenied", "Access Denied", 403, /aws-dash-readonly-policy\.json/],
    ["UnauthorizedOperation", "You are not authorized to perform this operation.", 403, /aws-dash-readonly-policy\.json/],
    ["SomeException", "forbidden thing", 403, /aws-dash-readonly-policy\.json/],
    ["TimeoutError", "Request timed out", undefined, /egress to AWS is blocked/],
  ])("translates %s", (name, message, status, hint) => {
    const out = awsErrorFrom(sdkError(name, message, status));
    expect(out).toBeInstanceOf(AwsError);
    expect(out.message).toMatch(new RegExp(`^${name}: `));
    expect(out.message).toMatch(hint);
    expect(out.status).toBe(status ?? null);
  });
  it("translates network error codes and region errors", () => {
    expect(awsErrorFrom(sdkError("Error", "connect ECONNREFUSED", undefined, "ECONNREFUSED")).message).toMatch(/egress to AWS is blocked/);
    expect(awsErrorFrom(new Error("Region is missing")).message).toMatch(/set AWS_REGION/);
  });
  it("falls back to name + first line and keeps the cause", () => {
    const err = new Error("weird\nstack");
    err.name = "WeirdException";
    const out = awsErrorFrom(err);
    expect(out.message).toBe("WeirdException: weird");
    expect(out.code).toBe("WeirdException");
    expect(out.cause).toBe(err);
  });
  it("copes with non-Error throwables", () => {
    expect(awsErrorFrom("nope").message).toBe("Error: nope");
    expect(awsErrorFrom(undefined).message).toBe("Error: undefined");
  });
});
```

`tests/client-defaults.test.ts`:
```ts
import pino from "pino";
import { describe, expect, it } from "vitest";
import { AwsError } from "../src/aws/aws-error.js";
import { clientDefaults, REGION_HINT } from "../src/aws/client-defaults.js";

const credentials = async () => ({ accessKeyId: "AKIA", secretAccessKey: "x" });
const logger = pino({ level: "silent" });

describe("clientDefaults", () => {
  it("throws an AwsError naming AWS_REGION when the region is unset", () => {
    expect(() => clientDefaults({ region: undefined, credentials, logger, debug: false })).toThrow(AwsError);
    expect(() => clientDefaults({ region: undefined, credentials, logger, debug: false })).toThrow(REGION_HINT);
  });
  it("applies bounded retries and timeouts and omits the SDK logger unless debugging", () => {
    const cfg = clientDefaults({ region: "eu-west-1", credentials, logger, debug: false });
    expect(cfg).toMatchObject({ region: "eu-west-1", maxAttempts: 2, requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 } });
    expect(cfg.credentials).toBe(credentials);
    expect(cfg.logger).toBeUndefined();
    expect(clientDefaults({ region: "eu-west-1", credentials, logger, debug: true }).logger).toBeDefined();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/aws-error.test.ts tests/client-defaults.test.ts`
Expected: FAIL — cannot resolve `../src/aws/aws-error.js`.

- [ ] **Step 4: Implement**

`src/aws/aws-error.ts`:
```ts
/** A single-line, user-facing AWS failure with an actionable hint where one is known (azure-dash `AzureError` analogue). */
export class AwsError extends Error {
  override name = "AwsError";
  constructor(
    message: string,
    readonly code: string | null = null,
    readonly status: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function firstLine(text: string): string {
  const i = text.search(/[\r\n]/);
  return (i < 0 ? text : text.slice(0, i)).trim();
}

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  $metadata?: { httpStatusCode?: number };
}

const DENIED = new Set(["AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "UnauthorizedAccess", "AuthorizationError"]);
const NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH"]);
export const POLICY_HINT =
  "grant the identity the read-only policy in deploy/aws/aws-dash-readonly-policy.json (new IAM policy changes can take a few seconds to apply)";

/** Wraps any thrown value as an AwsError: `<Name>: <first line> — <hint>`. */
export function awsErrorFrom(err: unknown): AwsError {
  if (err instanceof AwsError) return err;
  const e: ErrorLike = typeof err === "object" && err !== null ? (err as ErrorLike) : {};
  const name = typeof e.name === "string" && e.name ? e.name : "Error";
  const message = firstLine(typeof e.message === "string" ? e.message : String(err));
  const status = typeof e.$metadata?.httpStatusCode === "number" ? e.$metadata.httpStatusCode : null;
  const code = typeof e.code === "string" ? e.code : null;
  const wrap = (hint: string | null) =>
    new AwsError(hint ? `${name}: ${message} — ${hint}` : `${name}: ${message}`, code ?? name, status, { cause: err });

  if (message.includes("Region is missing")) return wrap("set AWS_REGION");
  if (name === "CredentialsProviderError") {
    return wrap(/token|web identity/i.test(message)
      ? "the web-identity token file is missing or unreadable; is the spiffe-helper sidecar or the IRSA webhook running?"
      : "no usable credentials; set AUTH_MODE or the AWS_* variables for the chosen mode");
  }
  if (name === "InvalidIdentityToken") {
    return wrap("STS rejected the token: the IAM OIDC provider URL must equal the token's iss, its client-id list must contain the token's aud, and the issuer's JWKS must be served over a publicly trusted certificate");
  }
  if (name === "IDPCommunicationError") return wrap("STS could not reach the token issuer's discovery endpoint; the SPIRE OIDC Route must be public with a trusted certificate");
  if (name === "ExpiredToken" || name === "ExpiredTokenException") return wrap("the token has expired: check clock skew, or whether the sidecar that refreshes the token file has stopped");
  if (DENIED.has(name) && /AssumeRoleWithWebIdentity/.test(message)) {
    return wrap("the role's trust policy rejected this identity: its StringEquals conditions on <issuer>:sub and <issuer>:aud must match the token's sub and aud");
  }
  if (DENIED.has(name) || status === 403) return wrap(POLICY_HINT);
  if (name === "TimeoutError" || name === "AbortError" || (code !== null && NETWORK_CODES.has(code))) {
    return wrap("network egress to AWS is blocked or the region endpoint is wrong");
  }
  return wrap(null);
}
```

`src/aws/client-defaults.ts`:
```ts
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import type { Logger } from "pino";
import { AwsError } from "./aws-error.js";

export const REGION_HINT = "AWS_REGION is not set; set it in the ConfigMap or environment (outside EC2 the SDK cannot pick a region on its own)";

/** The configuration every SDK client shares: bounded retries and timeouts so blocked egress fails in seconds. */
export interface AwsClientDefaults {
  region: string;
  credentials: AwsCredentialIdentityProvider;
  maxAttempts: number;
  requestHandler: { connectionTimeout: number; requestTimeout: number };
  logger?: Logger;
}

export function clientDefaults(opts: {
  region: string | undefined;
  credentials: AwsCredentialIdentityProvider;
  logger: Logger;
  debug: boolean;
}): AwsClientDefaults {
  if (!opts.region) throw new AwsError(REGION_HINT, "MissingRegion");
  const base: AwsClientDefaults = {
    region: opts.region,
    credentials: opts.credentials,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
  };
  // The SDK logger is chatty (request/response metadata per call); only wire it on AWS_DEBUG.
  return opts.debug ? { ...base, logger: opts.logger.child({ component: "aws-sdk" }) } : base;
}
```
(`@aws-sdk/types` is a transitive dependency of every client; import only its types.)

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/aws-error.test.ts tests/client-defaults.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/aws tests/aws-error.test.ts tests/client-defaults.test.ts
git commit -m "feat: AWS SDK dependencies, shared client defaults and error translation" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Credential mode resolution and the shared credential provider

**Files:**
- Create: `src/identity/credential-factory.ts`, `src/identity/credential-provider.ts`
- Test: `tests/credential-factory.test.ts`

**Interfaces:**
- Consumes: `AppSettings.authMode` (`AuthMode`), `EnvLookup`, `blank`, `parseBool`, `AwsError`.
- Produces: `interface CredentialSelection { mode: AuthMode; reason: string }`; `interface CredentialSpec extends CredentialSelection { credential_type: string; role_arn: string | null; role_session_name: string | null; token_file: string | null; container_credentials_uri: string | null; profile: string | null; provider: AwsCredentialIdentityProvider }`; `resolveAuthMode(settings, env): CredentialSelection`; `createCredentialSpec(settings, env): CredentialSpec` (throws `AwsError` listing every missing variable); `class CredentialProvider { constructor(settings, env, factory?); describe(); get(): CredentialSpec; provider(): AwsCredentialIdentityProvider }` — `get()` is lazy and caches only success.
- Phase 3's Identity tab reads `CredentialSpec` fields and the resolved credentials' `$source`; keep the field names.

- [ ] **Step 1: Write the failing tests**

`tests/credential-factory.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { AwsError } from "../src/aws/aws-error.js";
import { settingsFromEnv } from "../src/config.js";
import type { EnvLookup } from "../src/env.js";
import { createCredentialSpec, resolveAuthMode } from "../src/identity/credential-factory.js";
import { CredentialProvider } from "../src/identity/credential-provider.js";

const env = (vars: Record<string, string>): EnvLookup => (name) => vars[name];
const settings = (vars: Record<string, string>) => settingsFromEnv(env(vars));
const KEYS = { AWS_ACCESS_KEY_ID: "AKIAX", AWS_SECRET_ACCESS_KEY: "s" };
const TOKEN = { AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/aws/token", AWS_ROLE_ARN: "arn:aws:iam::1:role/r" };
const POD = { AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials", AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/t" };

describe("resolveAuthMode", () => {
  it.each([
    [{ ...KEYS, ...TOKEN, ...POD }, "static", "auto: AWS_ACCESS_KEY_ID is set (the SDK chain checks environment keys first)"],
    [{ AWS_PROFILE: "demo", ...TOKEN }, "profile", "auto: AWS_PROFILE is set"],
    [{ ...TOKEN, ...POD }, "web-identity", "auto: AWS_WEB_IDENTITY_TOKEN_FILE and AWS_ROLE_ARN are set"],
    [{ ...POD }, "pod-identity", "auto: AWS_CONTAINER_CREDENTIALS_FULL_URI is set"],
    [{ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/x" }, "pod-identity", "auto: AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is set"],
    [{}, "imds", "auto: no workload credentials in the environment; falling back to EC2 instance metadata (the node's role)"],
    [{ AWS_EC2_METADATA_DISABLED: "true" }, "imds", "auto: nothing matched and AWS_EC2_METADATA_DISABLED=true"],
    [{ AWS_ACCESS_KEY_ID: "only-id" }, "imds", "auto: no workload credentials in the environment; falling back to EC2 instance metadata (the node's role)"],
  ])("auto with %o → %s", (vars, mode, reason) => {
    expect(resolveAuthMode(settings(vars), env(vars))).toEqual({ mode, reason });
  });
  it("an explicit AUTH_MODE wins", () => {
    const vars = { AUTH_MODE: "pod-identity", ...KEYS };
    expect(resolveAuthMode(settings(vars), env(vars))).toEqual({ mode: "pod-identity", reason: "AUTH_MODE=pod-identity" });
  });
});

describe("createCredentialSpec", () => {
  it("static", () => {
    const spec = createCredentialSpec(settings(KEYS), env(KEYS));
    expect(spec).toMatchObject({ mode: "static", credential_type: "fromEnv (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)", role_arn: null, token_file: null, profile: null });
    expect(typeof spec.provider).toBe("function");
  });
  it("profile", () => {
    const vars = { AWS_PROFILE: "demo" };
    expect(createCredentialSpec(settings(vars), env(vars))).toMatchObject({ mode: "profile", credential_type: "fromIni (profile 'demo')", profile: "demo" });
  });
  it("web-identity carries the role, session name and token file", () => {
    const vars = { ...TOKEN, AWS_ROLE_SESSION_NAME: "aws-dash" };
    expect(createCredentialSpec(settings(vars), env(vars))).toMatchObject({
      mode: "web-identity", credential_type: "fromTokenFile → sts:AssumeRoleWithWebIdentity",
      role_arn: TOKEN.AWS_ROLE_ARN, role_session_name: "aws-dash", token_file: TOKEN.AWS_WEB_IDENTITY_TOKEN_FILE,
    });
  });
  it("pod-identity carries the container credentials URI", () => {
    expect(createCredentialSpec(settings(POD), env(POD))).toMatchObject({
      mode: "pod-identity", credential_type: "fromHttp (container credentials endpoint)", container_credentials_uri: POD.AWS_CONTAINER_CREDENTIALS_FULL_URI,
    });
  });
  it("imds", () => {
    expect(createCredentialSpec(settings({}), env({}))).toMatchObject({ mode: "imds", credential_type: "fromInstanceMetadata (EC2 instance role)" });
  });
  it.each([
    [{ AUTH_MODE: "static" }, "AUTH_MODE static requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY"],
    [{ AUTH_MODE: "static", AWS_ACCESS_KEY_ID: "x" }, "AUTH_MODE static requires AWS_SECRET_ACCESS_KEY"],
    [{ AUTH_MODE: "profile" }, "AUTH_MODE profile requires AWS_PROFILE"],
    [{ AUTH_MODE: "web-identity" }, "AUTH_MODE web-identity requires AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN"],
    [{ AUTH_MODE: "web-identity", AWS_ROLE_ARN: "arn" }, "AUTH_MODE web-identity requires AWS_WEB_IDENTITY_TOKEN_FILE"],
    [{ AUTH_MODE: "pod-identity" }, "AUTH_MODE pod-identity requires AWS_CONTAINER_CREDENTIALS_FULL_URI or AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"],
    [{ AUTH_MODE: "imds", AWS_EC2_METADATA_DISABLED: "1" }, "AUTH_MODE imds requires AWS_EC2_METADATA_DISABLED to be unset or false"],
  ])("rejects %o", (vars, message) => {
    expect(() => createCredentialSpec(settings(vars), env(vars))).toThrow(AwsError);
    expect(() => createCredentialSpec(settings(vars), env(vars))).toThrow(message);
  });
});

describe("CredentialProvider", () => {
  it("describes without constructing, builds lazily, caches success and retries failure", () => {
    let calls = 0;
    const vars: Record<string, string> = { AUTH_MODE: "web-identity" };
    const cp = new CredentialProvider(settings(vars), env(vars), (s, e) => { calls++; return createCredentialSpec(s, e); });
    expect(cp.describe()).toEqual({ mode: "web-identity", reason: "AUTH_MODE=web-identity" });
    expect(calls).toBe(0);
    expect(() => cp.get()).toThrow(/requires AWS_WEB_IDENTITY_TOKEN_FILE/);
    expect(() => cp.get()).toThrow(AwsError);
    expect(calls).toBe(2);
    Object.assign(vars, TOKEN);
    expect(cp.get().mode).toBe("web-identity");
    expect(cp.get().provider).toBe(cp.provider());
    expect(calls).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/credential-factory.test.ts`
Expected: FAIL — cannot resolve `../src/identity/credential-factory.js`.

- [ ] **Step 3: Implement**

`src/identity/credential-factory.ts`:
```ts
import { fromEnv, fromHttp, fromIni, fromInstanceMetadata, fromTokenFile } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { memoize } from "@smithy/property-provider";
import { AwsError } from "../aws/aws-error.js";
import type { AppSettings, AuthMode } from "../config.js";
import { blank, parseBool, type EnvLookup } from "../env.js";

export interface CredentialSelection {
  mode: AuthMode;
  reason: string;
}

/** Everything the Identity tab shows about how the app authenticates, plus the SDK provider itself. */
export interface CredentialSpec extends CredentialSelection {
  credential_type: string;
  role_arn: string | null;
  role_session_name: string | null;
  token_file: string | null;
  container_credentials_uri: string | null;
  profile: string | null;
  provider: AwsCredentialIdentityProvider;
}

const IMDS_FALLBACK = "auto: no workload credentials in the environment; falling back to EC2 instance metadata (the node's role)";

/** Explicit AUTH_MODE wins; `auto` follows the SDK default chain's order so the label always matches what the SDK would do. */
export function resolveAuthMode(settings: AppSettings, env: EnvLookup): CredentialSelection {
  if (settings.authMode !== "auto") return { mode: settings.authMode, reason: `AUTH_MODE=${settings.authMode}` };
  if (blank(env("AWS_ACCESS_KEY_ID")) && blank(env("AWS_SECRET_ACCESS_KEY"))) {
    return { mode: "static", reason: "auto: AWS_ACCESS_KEY_ID is set (the SDK chain checks environment keys first)" };
  }
  if (blank(env("AWS_PROFILE"))) return { mode: "profile", reason: "auto: AWS_PROFILE is set" };
  if (blank(env("AWS_WEB_IDENTITY_TOKEN_FILE")) && blank(env("AWS_ROLE_ARN"))) {
    return { mode: "web-identity", reason: "auto: AWS_WEB_IDENTITY_TOKEN_FILE and AWS_ROLE_ARN are set" };
  }
  if (blank(env("AWS_CONTAINER_CREDENTIALS_FULL_URI"))) return { mode: "pod-identity", reason: "auto: AWS_CONTAINER_CREDENTIALS_FULL_URI is set" };
  if (blank(env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"))) return { mode: "pod-identity", reason: "auto: AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is set" };
  if (imdsDisabled(env)) return { mode: "imds", reason: "auto: nothing matched and AWS_EC2_METADATA_DISABLED=true" };
  return { mode: "imds", reason: IMDS_FALLBACK };
}

function imdsDisabled(env: EnvLookup): boolean {
  return parseBool(env("AWS_EC2_METADATA_DISABLED")) === true;
}

function require(mode: AuthMode, vars: Record<string, string | undefined>): void {
  const missing = Object.entries(vars).filter(([, v]) => v === undefined).map(([k]) => k);
  if (missing.length > 0) throw new AwsError(`AUTH_MODE ${mode} requires ${missing.join(", ")}`, "MissingConfiguration");
}

/** Credentials are considered stale five minutes before expiry (matches the SDK's own default). */
function isExpired(creds: AwsCredentialIdentity): boolean {
  return creds.expiration !== undefined && creds.expiration.getTime() - Date.now() < 5 * 60_000;
}

function requiresRefresh(creds: AwsCredentialIdentity): boolean {
  return creds.expiration !== undefined;
}

/** Builds the one provider every SDK client shares; throws AwsError naming every missing variable. */
export function createCredentialSpec(settings: AppSettings, env: EnvLookup): CredentialSpec {
  const { mode, reason } = resolveAuthMode(settings, env);
  const base = { mode, reason, role_arn: null, role_session_name: null, token_file: null, container_credentials_uri: null, profile: null };
  let spec: CredentialSpec;
  switch (mode) {
    case "static": {
      require(mode, { AWS_ACCESS_KEY_ID: blank(env("AWS_ACCESS_KEY_ID")), AWS_SECRET_ACCESS_KEY: blank(env("AWS_SECRET_ACCESS_KEY")) });
      // fromEnv reads process.env itself; in production env === processEnv so the values agree.
      spec = { ...base, credential_type: "fromEnv (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)", provider: fromEnv() };
      break;
    }
    case "profile": {
      const profile = blank(env("AWS_PROFILE"));
      require(mode, { AWS_PROFILE: profile });
      spec = { ...base, credential_type: `fromIni (profile '${profile}')`, profile: profile ?? null, provider: fromIni({ profile }) };
      break;
    }
    case "web-identity": {
      const tokenFile = blank(env("AWS_WEB_IDENTITY_TOKEN_FILE"));
      const roleArn = blank(env("AWS_ROLE_ARN"));
      const sessionName = blank(env("AWS_ROLE_SESSION_NAME"));
      require(mode, { AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile, AWS_ROLE_ARN: roleArn });
      spec = {
        ...base,
        credential_type: "fromTokenFile → sts:AssumeRoleWithWebIdentity",
        role_arn: roleArn ?? null,
        role_session_name: sessionName ?? null,
        token_file: tokenFile ?? null,
        // fromTokenFile re-reads the file on every resolve, so a sidecar-rotated JWT-SVID is picked up.
        provider: fromTokenFile({ webIdentityTokenFile: tokenFile, roleArn, roleSessionName: sessionName }),
      };
      break;
    }
    case "pod-identity": {
      const fullUri = blank(env("AWS_CONTAINER_CREDENTIALS_FULL_URI"));
      const relativeUri = blank(env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"));
      if (!fullUri && !relativeUri) {
        throw new AwsError(`AUTH_MODE ${mode} requires AWS_CONTAINER_CREDENTIALS_FULL_URI or AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, "MissingConfiguration");
      }
      spec = {
        ...base,
        credential_type: "fromHttp (container credentials endpoint)",
        container_credentials_uri: fullUri ?? relativeUri ?? null,
        provider: fromHttp({
          awsContainerCredentialsFullUri: fullUri,
          awsContainerCredentialsRelativeUri: relativeUri,
          awsContainerAuthorizationTokenFile: blank(env("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE")),
          awsContainerAuthorizationToken: blank(env("AWS_CONTAINER_AUTHORIZATION_TOKEN")),
        }),
      };
      break;
    }
    case "imds": {
      if (imdsDisabled(env)) throw new AwsError(`AUTH_MODE ${mode} requires AWS_EC2_METADATA_DISABLED to be unset or false`, "MissingConfiguration");
      spec = { ...base, credential_type: "fromInstanceMetadata (EC2 instance role)", provider: fromInstanceMetadata({ timeout: 1000, maxRetries: 1 }) };
      break;
    }
    default: {
      const never: never = mode;
      throw new AwsError(`unsupported AUTH_MODE ${String(never)}`);
    }
  }
  return { ...spec, provider: memoize(spec.provider, isExpired, requiresRefresh) };
}
```
If TypeScript rejects `fromIni({ profile })` because `profile` is `string | undefined`, pass `{ profile: profile ?? undefined }` — `require()` has already guaranteed it is set. If it rejects `require` as a reserved-looking name in ESM, rename it `requireVars` (and the calls).

`src/identity/credential-provider.ts`:
```ts
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import type { AppSettings } from "../config.js";
import type { EnvLookup } from "../env.js";
import { createCredentialSpec, resolveAuthMode, type CredentialSelection, type CredentialSpec } from "./credential-factory.js";

/** Lazily builds the shared credential spec; caches only success so a misconfigured pod shows the error in every panel and retries on the next request. */
export class CredentialProvider {
  private spec: CredentialSpec | undefined;

  constructor(
    private readonly settings: AppSettings,
    private readonly env: EnvLookup,
    private readonly factory: (settings: AppSettings, env: EnvLookup) => CredentialSpec = createCredentialSpec,
  ) {}

  describe(): CredentialSelection {
    return resolveAuthMode(this.settings, this.env);
  }

  get(): CredentialSpec {
    if (this.spec === undefined) this.spec = this.factory(this.settings, this.env);
    return this.spec;
  }

  provider(): AwsCredentialIdentityProvider {
    return this.get().provider;
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/credential-factory.test.ts && npm run typecheck`
Expected: all pass (nothing resolves credentials, so nothing touches the network).

- [ ] **Step 5: Commit**

```bash
git add src/identity tests/credential-factory.test.ts
git commit -m "feat: explicit AWS credential mode resolution with one shared memoized provider" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Inventory models, kinds, provider interface, TTL cache

**Files:**
- Create: `src/inventory/models.ts`, `src/inventory/kinds.ts`, `src/inventory/provider.ts`, `src/inventory/ttl-cache.ts`
- Test: `tests/ttl-cache.test.ts`

**Interfaces:**
- Consumes: `Clock` (`src/clock.ts`).
- Produces: item interfaces (`AccountInfo`, `InstanceInfo`, `VpcInfo`, `SubnetInfo`, `SecurityGroupRuleInfo`, `BucketInfo`, `EksClusterInfo`, `EcrRepositoryInfo`), `type InventoryItem` (their union), `interface ListResult<T> { items: T[]; truncated: boolean }`, `MAX_ITEMS = 500`; `INVENTORY_KINDS` (ordered `{ kind, title }` list), `type InventoryKind`, `isInventoryKind(s)`, `kindTitle(kind)`; `interface AwsProvider` (one method per kind, each returning `Promise<ListResult<…>>`); `interface CacheEntry<T> { value: T | null; fetched_at: string | null; error: string | null }`; `class TtlCache { constructor(ttlMs, clock, describeError?); get<T>(key, loader, force?): Promise<CacheEntry<T>>; invalidateAll(): void }`.

- [ ] **Step 1: Write the failing tests**

`tests/ttl-cache.test.ts`:
```ts
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

  it("reports value null when the very first load fails", async () => {
    const cache = new TtlCache(1000, new FakeClock());
    expect(await cache.get("k", async () => { throw new Error("nope"); })).toEqual({ value: null, fetched_at: "2026-01-01T00:00:00.000Z", error: "nope" });
  });

  it("invalidateAll drops entries and discards a load that started before it", async () => {
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
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/ttl-cache.test.ts`
Expected: FAIL — cannot resolve `../src/inventory/ttl-cache.js`.

- [ ] **Step 3: Implement the four modules**

`src/inventory/models.ts`:
```ts
/** Rows shown on the AWS tab. Keys are snake_case because they are served as JSON verbatim. */
export interface AccountInfo {
  account_id: string;
  alias: string | null;
  arn: string;
  user_id: string;
  partition: string;
  region: string;
}

export interface InstanceInfo {
  id: string;
  name: string | null;
  type: string | null;
  state: string | null;
  az: string | null;
  private_ip: string | null;
  public_ip: string | null;
  vpc_id: string | null;
  subnet_id: string | null;
  launch_time: string | null;
  iam_profile: string | null;
}

export interface VpcInfo {
  id: string;
  name: string | null;
  cidr: string | null;
  is_default: boolean;
  state: string | null;
}

export interface SubnetInfo {
  id: string;
  name: string | null;
  vpc_id: string | null;
  cidr: string | null;
  az: string | null;
  available_ips: number | null;
  map_public_ip: boolean;
}

/** One security-group rule, flattened (the azure-dash NSG-rules analogue). */
export interface SecurityGroupRuleInfo {
  group_id: string;
  group_name: string | null;
  vpc_id: string | null;
  direction: "ingress" | "egress";
  protocol: string;
  ports: string;
  peer: string;
}

export interface BucketInfo {
  name: string;
  region: string | null;
  created: string | null;
}

export interface EksClusterInfo {
  name: string;
  version: string | null;
  status: string | null;
  platform_version: string | null;
  oidc_issuer: string | null;
  endpoint_public: boolean;
  endpoint_private: boolean;
  auth_mode: string | null;
}

export interface EcrRepositoryInfo {
  name: string;
  uri: string | null;
  created: string | null;
  tag_mutability: string | null;
  scan_on_push: boolean;
}

export type InventoryItem =
  | AccountInfo | InstanceInfo | VpcInfo | SubnetInfo | SecurityGroupRuleInfo | BucketInfo | EksClusterInfo | EcrRepositoryInfo;

export interface ListResult<T> {
  items: T[];
  /** True when the listing stopped at MAX_ITEMS. */
  truncated: boolean;
}

export const MAX_ITEMS = 500;
```

`src/inventory/kinds.ts`:
```ts
/** Panel order on the AWS tab. */
export const INVENTORY_KINDS = [
  { kind: "account", title: "Account" },
  { kind: "instances", title: "EC2 instances" },
  { kind: "vpcs", title: "VPCs" },
  { kind: "subnets", title: "Subnets" },
  { kind: "securitygroups", title: "Security group rules" },
  { kind: "s3buckets", title: "S3 buckets" },
  { kind: "eksclusters", title: "EKS clusters" },
  { kind: "ecrrepos", title: "ECR repositories" },
] as const;

export type InventoryKind = (typeof INVENTORY_KINDS)[number]["kind"];

export function isInventoryKind(value: string): value is InventoryKind {
  return INVENTORY_KINDS.some((k) => k.kind === value);
}

export function kindTitle(kind: InventoryKind): string {
  return INVENTORY_KINDS.find((k) => k.kind === kind)?.title ?? kind;
}
```

`src/inventory/provider.ts`:
```ts
import type { InventoryKind } from "./kinds.js";
import type {
  AccountInfo, BucketInfo, EcrRepositoryInfo, EksClusterInfo, InstanceInfo, InventoryItem, ListResult,
  SecurityGroupRuleInfo, SubnetInfo, VpcInfo,
} from "./models.js";

/** Everything the AWS tab needs from AWS; the live implementation talks to the SDK, the test fake returns fixtures. */
export interface AwsProvider {
  getAccount(): Promise<ListResult<AccountInfo>>;
  listInstances(): Promise<ListResult<InstanceInfo>>;
  listVpcs(): Promise<ListResult<VpcInfo>>;
  listSubnets(): Promise<ListResult<SubnetInfo>>;
  listSecurityGroupRules(): Promise<ListResult<SecurityGroupRuleInfo>>;
  listBuckets(): Promise<ListResult<BucketInfo>>;
  listEksClusters(): Promise<ListResult<EksClusterInfo>>;
  listEcrRepositories(): Promise<ListResult<EcrRepositoryInfo>>;
}

export function fetchKind(provider: AwsProvider, kind: InventoryKind): Promise<ListResult<InventoryItem>> {
  switch (kind) {
    case "account": return provider.getAccount();
    case "instances": return provider.listInstances();
    case "vpcs": return provider.listVpcs();
    case "subnets": return provider.listSubnets();
    case "securitygroups": return provider.listSecurityGroupRules();
    case "s3buckets": return provider.listBuckets();
    case "eksclusters": return provider.listEksClusters();
    case "ecrrepos": return provider.listEcrRepositories();
  }
}
```

`src/inventory/ttl-cache.ts`:
```ts
import type { Clock } from "../clock.js";

export interface CacheEntry<T> {
  value: T | null;
  fetched_at: string | null;
  error: string | null;
}

interface Slot {
  entry: CacheEntry<unknown>;
  fresh_until: number;
  epoch: number;
}

/** Per-key TTL cache: one load at a time per key; a failed reload keeps the last good value and records the error. */
export class TtlCache {
  private readonly slots = new Map<string, Slot>();
  private readonly inflight = new Map<string, Promise<CacheEntry<unknown>>>();
  private epoch = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock,
    private readonly describeError: (err: unknown) => string = (err) => (err instanceof Error ? err.message : String(err)),
  ) {}

  async get<T>(key: string, loader: () => Promise<T>, force = false): Promise<CacheEntry<T>> {
    if (!force) {
      const fresh = this.fresh<T>(key);
      if (fresh) return fresh;
    }
    const pending = this.inflight.get(key) as Promise<CacheEntry<T>> | undefined;
    if (pending) {
      if (!force) return pending;
      await pending.catch(() => undefined);
    }
    const run = this.load(key, loader);
    this.inflight.set(key, run);
    try {
      return await run;
    } finally {
      if (this.inflight.get(key) === run) this.inflight.delete(key);
    }
  }

  /** Drops every entry; loads already in flight complete for their callers but are not stored. */
  invalidateAll(): void {
    this.epoch++;
    this.slots.clear();
  }

  private fresh<T>(key: string): CacheEntry<T> | undefined {
    const slot = this.slots.get(key);
    if (slot && slot.epoch === this.epoch && this.clock.now().getTime() < slot.fresh_until) return slot.entry as CacheEntry<T>;
    return undefined;
  }

  private async load<T>(key: string, loader: () => Promise<T>): Promise<CacheEntry<T>> {
    const epoch = this.epoch;
    const previous = (this.slots.get(key)?.entry.value ?? null) as T | null;
    let entry: CacheEntry<T>;
    try {
      const value = await loader();
      entry = { value, fetched_at: this.clock.now().toISOString(), error: null };
    } catch (err) {
      entry = { value: previous, fetched_at: this.clock.now().toISOString(), error: this.describeError(err) };
    }
    if (this.epoch === epoch) this.slots.set(key, { entry, fresh_until: this.clock.now().getTime() + this.ttlMs, epoch });
    return entry;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/ttl-cache.test.ts && npm run typecheck`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/inventory tests/ttl-cache.test.ts
git commit -m "feat: inventory models, kinds, provider interface and keep-last-good TTL cache" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: InventoryService, fake provider, JSON API and refresh

**Files:**
- Create: `src/inventory/inventory-service.ts`, `src/routes/inventory.ts`, `tests/support/fake-aws-provider.ts`
- Modify: `src/app.ts` (`AppDeps` gains `credentials`, `inventory`, `createAwsProvider`; `createDeps` wires them; `buildApp` registers the routes), `tests/support/app-factory.ts` (injects `FakeAwsProvider`, returns it as `aws`)
- Test: `tests/inventory-api.test.ts`

**Interfaces:**
- Consumes: `TtlCache`, `AwsProvider`, `fetchKind`, `isInventoryKind`, `awsErrorFrom`, `CredentialProvider`, `errorBody`, `parseBool`.
- Produces: `interface InventoryObserver { fetched(kind, ok: boolean, seconds: number): void }` (Task 9's metrics implement it); `class InventoryService { constructor(createProvider: () => AwsProvider, cache: TtlCache, logger, observer?); fetch(kind, force?): Promise<CacheEntry<ListResult<InventoryItem>>>; invalidateAll() }` — the provider is created lazily and only cached on success; `registerInventoryRoutes(app, deps)` with `GET /api/aws/:kind[?refresh=true]` → `{ kind, fetched_at, error, items, truncated }`, 404 for unknown kinds, `POST /api/aws/refresh` → 204; `isRefresh(req)`; `AppDeps.credentials: CredentialProvider`, `AppDeps.inventory: InventoryService`, `AppDeps.createAwsProvider: () => AwsProvider` (default throws until Task 6 installs `LiveAwsProvider`); `testApp()` now also returns `aws: FakeAwsProvider`.

- [ ] **Step 1: Write the fake provider and failing tests**

`tests/support/fake-aws-provider.ts`:
```ts
import type { InventoryKind } from "../../src/inventory/kinds.js";
import type {
  AccountInfo, BucketInfo, EcrRepositoryInfo, EksClusterInfo, InstanceInfo, ListResult, SecurityGroupRuleInfo, SubnetInfo, VpcInfo,
} from "../../src/inventory/models.js";
import type { AwsProvider } from "../../src/inventory/provider.js";

const list = <T>(...items: T[]): ListResult<T> => ({ items, truncated: false });

/** Fixture-backed AwsProvider: counts calls per kind and can be told to fail a kind with an SDK-shaped AccessDenied. */
export class FakeAwsProvider implements AwsProvider {
  readonly calls: Partial<Record<InventoryKind, number>> = {};
  private readonly failing = new Set<InventoryKind>();

  account: ListResult<AccountInfo> = list({ account_id: "123456789012", alias: "kemo-lab", arn: "arn:aws:iam::123456789012:user/aws-dash", user_id: "AIDAEXAMPLE", partition: "aws", region: "us-east-1" });
  instances: ListResult<InstanceInfo> = list({ id: "i-0abc", name: "web-1", type: "t3.micro", state: "running", az: "us-east-1a", private_ip: "10.0.1.5", public_ip: null, vpc_id: "vpc-1", subnet_id: "subnet-1", launch_time: "2026-01-01T00:00:00.000Z", iam_profile: "arn:aws:iam::123456789012:instance-profile/web" });
  vpcs: ListResult<VpcInfo> = list({ id: "vpc-1", name: "demo", cidr: "10.0.0.0/16", is_default: false, state: "available" });
  subnets: ListResult<SubnetInfo> = list({ id: "subnet-1", name: "demo-a", vpc_id: "vpc-1", cidr: "10.0.1.0/24", az: "us-east-1a", available_ips: 250, map_public_ip: false });
  securitygroups: ListResult<SecurityGroupRuleInfo> = list({ group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "ingress", protocol: "tcp", ports: "443", peer: "0.0.0.0/0" });
  s3buckets: ListResult<BucketInfo> = list({ name: "demo-bucket", region: "us-east-1", created: "2025-06-01T00:00:00.000Z" });
  eksclusters: ListResult<EksClusterInfo> = list({ name: "demo", version: "1.33", status: "ACTIVE", platform_version: "eks.5", oidc_issuer: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", endpoint_public: true, endpoint_private: false, auth_mode: "API_AND_CONFIG_MAP" });
  ecrrepos: ListResult<EcrRepositoryInfo> = list({ name: "aws-dash", uri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/aws-dash", created: "2025-06-01T00:00:00.000Z", tag_mutability: "MUTABLE", scan_on_push: true });

  fail(kind: InventoryKind): void { this.failing.add(kind); }
  recover(kind: InventoryKind): void { this.failing.delete(kind); }

  getAccount() { return this.answer("account", this.account); }
  listInstances() { return this.answer("instances", this.instances); }
  listVpcs() { return this.answer("vpcs", this.vpcs); }
  listSubnets() { return this.answer("subnets", this.subnets); }
  listSecurityGroupRules() { return this.answer("securitygroups", this.securitygroups); }
  listBuckets() { return this.answer("s3buckets", this.s3buckets); }
  listEksClusters() { return this.answer("eksclusters", this.eksclusters); }
  listEcrRepositories() { return this.answer("ecrrepos", this.ecrrepos); }

  private async answer<T>(kind: InventoryKind, result: ListResult<T>): Promise<ListResult<T>> {
    this.calls[kind] = (this.calls[kind] ?? 0) + 1;
    if (this.failing.has(kind)) {
      throw Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    }
    return { items: [...result.items], truncated: result.truncated };
  }
}
```

`tests/inventory-api.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/inventory-api.test.ts`
Expected: FAIL — `testApp` returns no `aws`; routes 404.

- [ ] **Step 3: Implement the service and routes; wire `AppDeps`**

`src/inventory/inventory-service.ts`:
```ts
import type { Logger } from "pino";
import { awsErrorFrom } from "../aws/aws-error.js";
import type { InventoryKind } from "./kinds.js";
import type { InventoryItem, ListResult } from "./models.js";
import { fetchKind, type AwsProvider } from "./provider.js";
import type { CacheEntry, TtlCache } from "./ttl-cache.js";

/** Metrics hook (Task 9); a no-op by default. */
export interface InventoryObserver {
  fetched(kind: InventoryKind, ok: boolean, seconds: number): void;
}

/** Loads one kind at a time through the cache; the live provider is built lazily so a misconfiguration shows in the panels instead of at startup. */
export class InventoryService {
  private provider: AwsProvider | undefined;

  constructor(
    private readonly createProvider: () => AwsProvider,
    private readonly cache: TtlCache,
    private readonly logger: Logger,
    private readonly observer: InventoryObserver = { fetched: () => undefined },
  ) {}

  fetch(kind: InventoryKind, force = false): Promise<CacheEntry<ListResult<InventoryItem>>> {
    return this.cache.get(kind, () => this.load(kind), force);
  }

  invalidateAll(): void {
    this.cache.invalidateAll();
  }

  private getProvider(): AwsProvider {
    if (this.provider === undefined) this.provider = this.createProvider();
    return this.provider;
  }

  private async load(kind: InventoryKind): Promise<ListResult<InventoryItem>> {
    const started = performance.now();
    try {
      const result = await fetchKind(this.getProvider(), kind);
      const seconds = (performance.now() - started) / 1000;
      this.logger.info({ kind, items: result.items.length, truncated: result.truncated, ms: Math.round(seconds * 1000) }, "aws fetch ok");
      this.observer.fetched(kind, true, seconds);
      return result;
    } catch (err) {
      const seconds = (performance.now() - started) / 1000;
      const error = awsErrorFrom(err);
      this.logger.warn({ kind, ms: Math.round(seconds * 1000), error: error.message }, "aws fetch failed");
      this.logger.debug({ err }, "aws fetch failure detail");
      this.observer.fetched(kind, false, seconds);
      throw error;
    }
  }
}
```

`src/routes/inventory.ts`:
```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDeps } from "../app.js";
import { parseBool } from "../env.js";
import { isInventoryKind } from "../inventory/kinds.js";
import { errorBody } from "./errors.js";

export function isRefresh(req: FastifyRequest): boolean {
  const q = (req.query ?? {}) as Record<string, unknown>;
  return parseBool(typeof q["refresh"] === "string" ? q["refresh"] : undefined) === true;
}

export function registerInventoryRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/api/aws/:kind", async (req, reply) => {
    const { kind } = req.params as { kind: string };
    if (!isInventoryKind(kind)) return reply.code(404).send(errorBody(`unknown kind '${kind}'`));
    const entry = await deps.inventory.fetch(kind, isRefresh(req));
    return { kind, fetched_at: entry.fetched_at, error: entry.error, items: entry.value?.items ?? null, truncated: entry.value?.truncated ?? false };
  });
  app.post("/api/aws/refresh", (_req, reply) => {
    deps.inventory.invalidateAll();
    return reply.code(204).send();
  });
}
```

Modify `src/app.ts`:
- imports: `import { AwsError } from "./aws/aws-error.js"; import { CredentialProvider } from "./identity/credential-provider.js"; import { InventoryService } from "./inventory/inventory-service.js"; import type { AwsProvider } from "./inventory/provider.js"; import { TtlCache } from "./inventory/ttl-cache.js"; import { registerInventoryRoutes } from "./routes/inventory.js"; import { awsErrorFrom } from "./aws/aws-error.js";`
- `AppDeps` gains:
```ts
  credentials: CredentialProvider;
  /** Builds the live AWS provider on first use; tests inject a fake. */
  createAwsProvider: () => AwsProvider;
  inventory: InventoryService;
```
- `createDeps` gains, after `memory`:
```ts
  const logger = overrides.logger ?? createLogger(settings);
  const credentials = overrides.credentials ?? new CredentialProvider(settings, env);
  const createAwsProvider = overrides.createAwsProvider ?? (() => { throw new AwsError("live AWS provider is not available in this build"); });
  const inventory = overrides.inventory ?? new InventoryService(createAwsProvider, new TtlCache(settings.cacheTtlSeconds * 1000, clock, (err) => awsErrorFrom(err).message), logger);
```
and returns `logger, credentials, createAwsProvider, inventory` (replace the inline `logger:` entry with the new `logger` const). Task 6 replaces the throwing default with `LiveAwsProvider`.
- `buildApp`: add `registerInventoryRoutes(app, deps);` after `registerControlRoutes`.

Modify `tests/support/app-factory.ts`: import `FakeAwsProvider`; create `const aws = new FakeAwsProvider();` and pass `createAwsProvider: () => aws` in the `createDeps` call (before `...opts.overrides`, so an override still wins); return `aws` in the result object.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/inventory-api.test.ts && npm test && npm run typecheck`
Expected: all pass; the Phase 1 suites are unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/inventory/inventory-service.ts src/routes/inventory.ts src/app.ts tests/support/fake-aws-provider.ts tests/support/app-factory.ts tests/inventory-api.test.ts
git commit -m "feat: inventory service with per-kind JSON API and refresh" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Pure mappers from SDK shapes to inventory rows

**Files:**
- Create: `src/inventory/mappers.ts`
- Test: `tests/mappers.test.ts`

**Interfaces:**
- Consumes: SDK model types (type-only imports): `Instance`, `Vpc`, `Subnet`, `SecurityGroup`, `IpPermission`, `Tag` from `@aws-sdk/client-ec2`; `Bucket` from `@aws-sdk/client-s3`; `Cluster` from `@aws-sdk/client-eks`; `Repository` from `@aws-sdk/client-ecr`; `GetCallerIdentityCommandOutput` from `@aws-sdk/client-sts`.
- Produces: `tagName(tags)`, `mapAccount(identity, alias, region)`, `mapInstance`, `mapVpc`, `mapSubnet`, `flattenSecurityGroupRules(group)`, `mapBucket`, `mapEksCluster`, `mapEcrRepository`, `arnPartition(arn)`. All total functions: missing SDK fields become `null`/`false`, never throw.

- [ ] **Step 1: Write the failing tests**

`tests/mappers.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  arnPartition, flattenSecurityGroupRules, mapAccount, mapBucket, mapEcrRepository, mapEksCluster, mapInstance, mapSubnet, mapVpc, tagName,
} from "../src/inventory/mappers.js";

describe("mappers", () => {
  it("tagName reads the Name tag and ignores others", () => {
    expect(tagName([{ Key: "env", Value: "x" }, { Key: "Name", Value: "web-1" }])).toBe("web-1");
    expect(tagName([{ Key: "Name" }])).toBeNull();
    expect(tagName(undefined)).toBeNull();
  });

  it("mapAccount derives the partition from the ARN", () => {
    expect(mapAccount({ Account: "123456789012", Arn: "arn:aws-us-gov:sts::123456789012:assumed-role/r/s", UserId: "AROA:s", $metadata: {} }, "gov-lab", "us-gov-west-1"))
      .toEqual({ account_id: "123456789012", alias: "gov-lab", arn: "arn:aws-us-gov:sts::123456789012:assumed-role/r/s", user_id: "AROA:s", partition: "aws-us-gov", region: "us-gov-west-1" });
    expect(arnPartition(undefined)).toBe("aws");
    expect(mapAccount({ $metadata: {} }, null, "us-east-1")).toMatchObject({ account_id: "", arn: "", user_id: "", alias: null, partition: "aws" });
  });

  it("mapInstance flattens nested fields and formats the launch time", () => {
    expect(mapInstance({
      InstanceId: "i-1", InstanceType: "t3.micro", State: { Name: "running" }, Placement: { AvailabilityZone: "us-east-1a" },
      PrivateIpAddress: "10.0.0.1", VpcId: "vpc-1", SubnetId: "subnet-1", LaunchTime: new Date("2026-01-02T03:04:05Z"),
      IamInstanceProfile: { Arn: "arn:aws:iam::1:instance-profile/p" }, Tags: [{ Key: "Name", Value: "web" }],
    })).toEqual({
      id: "i-1", name: "web", type: "t3.micro", state: "running", az: "us-east-1a", private_ip: "10.0.0.1", public_ip: null,
      vpc_id: "vpc-1", subnet_id: "subnet-1", launch_time: "2026-01-02T03:04:05.000Z", iam_profile: "arn:aws:iam::1:instance-profile/p",
    });
    expect(mapInstance({})).toMatchObject({ id: "", name: null, launch_time: null, iam_profile: null });
  });

  it("mapVpc and mapSubnet", () => {
    expect(mapVpc({ VpcId: "vpc-1", CidrBlock: "10.0.0.0/16", IsDefault: true, State: "available" })).toEqual({ id: "vpc-1", name: null, cidr: "10.0.0.0/16", is_default: true, state: "available" });
    expect(mapSubnet({ SubnetId: "s-1", VpcId: "vpc-1", CidrBlock: "10.0.1.0/24", AvailabilityZone: "us-east-1a", AvailableIpAddressCount: 250, MapPublicIpOnLaunch: true, Tags: [{ Key: "Name", Value: "a" }] }))
      .toEqual({ id: "s-1", name: "a", vpc_id: "vpc-1", cidr: "10.0.1.0/24", az: "us-east-1a", available_ips: 250, map_public_ip: true });
  });

  it("flattenSecurityGroupRules emits one row per peer, in both directions", () => {
    const rows = flattenSecurityGroupRules({
      GroupId: "sg-1", GroupName: "web", VpcId: "vpc-1",
      IpPermissions: [
        { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }, { CidrIp: "10.0.0.0/8" }], UserIdGroupPairs: [{ GroupId: "sg-2" }] },
        { IpProtocol: "tcp", FromPort: 8000, ToPort: 8100, PrefixListIds: [{ PrefixListId: "pl-1" }] },
        { IpProtocol: "icmp", FromPort: -1, ToPort: -1, IpRanges: [{ CidrIp: "10.0.0.0/8" }] },
      ],
      IpPermissionsEgress: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }, { IpProtocol: "udp", FromPort: 53, ToPort: 53 }],
    });
    expect(rows).toEqual([
      { group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "ingress", protocol: "tcp", ports: "443", peer: "0.0.0.0/0" },
      { group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "ingress", protocol: "tcp", ports: "443", peer: "10.0.0.0/8" },
      { group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "ingress", protocol: "tcp", ports: "443", peer: "sg-2" },
      { group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "ingress", protocol: "tcp", ports: "8000-8100", peer: "pl-1" },
      { group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "ingress", protocol: "icmp", ports: "all", peer: "10.0.0.0/8" },
      { group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "egress", protocol: "all", ports: "all", peer: "0.0.0.0/0" },
      { group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "egress", protocol: "udp", ports: "53", peer: "—" },
    ]);
  });

  it("mapBucket, mapEksCluster, mapEcrRepository", () => {
    expect(mapBucket({ Name: "b", CreationDate: new Date("2025-06-01T00:00:00Z"), BucketRegion: "eu-west-1" })).toEqual({ name: "b", region: "eu-west-1", created: "2025-06-01T00:00:00.000Z" });
    expect(mapBucket({ Name: "b" })).toEqual({ name: "b", region: null, created: null });
    expect(mapEksCluster({
      name: "demo", version: "1.33", status: "ACTIVE", platformVersion: "eks.5", identity: { oidc: { issuer: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC" } },
      resourcesVpcConfig: { endpointPublicAccess: true, endpointPrivateAccess: false }, accessConfig: { authenticationMode: "API_AND_CONFIG_MAP" },
    })).toEqual({ name: "demo", version: "1.33", status: "ACTIVE", platform_version: "eks.5", oidc_issuer: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", endpoint_public: true, endpoint_private: false, auth_mode: "API_AND_CONFIG_MAP" });
    expect(mapEksCluster({ name: "bare" })).toMatchObject({ name: "bare", oidc_issuer: null, endpoint_public: false, endpoint_private: false, auth_mode: null });
    expect(mapEcrRepository({ repositoryName: "aws-dash", repositoryUri: "1.dkr.ecr.us-east-1.amazonaws.com/aws-dash", createdAt: new Date("2025-06-01T00:00:00Z"), imageTagMutability: "MUTABLE", imageScanningConfiguration: { scanOnPush: true } }))
      .toEqual({ name: "aws-dash", uri: "1.dkr.ecr.us-east-1.amazonaws.com/aws-dash", created: "2025-06-01T00:00:00.000Z", tag_mutability: "MUTABLE", scan_on_push: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mappers.test.ts`
Expected: FAIL — cannot resolve `../src/inventory/mappers.js`.

- [ ] **Step 3: Implement mappers.ts**

`src/inventory/mappers.ts`:
```ts
import type { Instance, IpPermission, SecurityGroup, Subnet, Tag, Vpc } from "@aws-sdk/client-ec2";
import type { Repository } from "@aws-sdk/client-ecr";
import type { Cluster } from "@aws-sdk/client-eks";
import type { Bucket } from "@aws-sdk/client-s3";
import type { GetCallerIdentityCommandOutput } from "@aws-sdk/client-sts";
import type {
  AccountInfo, BucketInfo, EcrRepositoryInfo, EksClusterInfo, InstanceInfo, SecurityGroupRuleInfo, SubnetInfo, VpcInfo,
} from "./models.js";

const iso = (d: Date | undefined): string | null => (d instanceof Date ? d.toISOString() : null);
const str = (v: string | undefined): string | null => (v === undefined || v === "" ? null : v);

export function tagName(tags: Tag[] | undefined): string | null {
  return str(tags?.find((t) => t.Key === "Name")?.Value);
}

/** `arn:<partition>:...`; defaults to the commercial partition when the ARN is missing. */
export function arnPartition(arn: string | undefined): string {
  return arn?.split(":")[1] || "aws";
}

export function mapAccount(identity: GetCallerIdentityCommandOutput, alias: string | null, region: string): AccountInfo {
  return {
    account_id: identity.Account ?? "",
    alias,
    arn: identity.Arn ?? "",
    user_id: identity.UserId ?? "",
    partition: arnPartition(identity.Arn),
    region,
  };
}

export function mapInstance(i: Instance): InstanceInfo {
  return {
    id: i.InstanceId ?? "",
    name: tagName(i.Tags),
    type: str(i.InstanceType),
    state: str(i.State?.Name),
    az: str(i.Placement?.AvailabilityZone),
    private_ip: str(i.PrivateIpAddress),
    public_ip: str(i.PublicIpAddress),
    vpc_id: str(i.VpcId),
    subnet_id: str(i.SubnetId),
    launch_time: iso(i.LaunchTime),
    iam_profile: str(i.IamInstanceProfile?.Arn),
  };
}

export function mapVpc(v: Vpc): VpcInfo {
  return { id: v.VpcId ?? "", name: tagName(v.Tags), cidr: str(v.CidrBlock), is_default: v.IsDefault === true, state: str(v.State) };
}

export function mapSubnet(s: Subnet): SubnetInfo {
  return {
    id: s.SubnetId ?? "",
    name: tagName(s.Tags),
    vpc_id: str(s.VpcId),
    cidr: str(s.CidrBlock),
    az: str(s.AvailabilityZone),
    available_ips: typeof s.AvailableIpAddressCount === "number" ? s.AvailableIpAddressCount : null,
    map_public_ip: s.MapPublicIpOnLaunch === true,
  };
}

function portRange(p: IpPermission): string {
  if (p.IpProtocol === "-1") return "all";
  const from = p.FromPort;
  const to = p.ToPort;
  if (from === undefined || from < 0) return "all";
  return to === undefined || to === from ? String(from) : `${from}-${to}`;
}

function peers(p: IpPermission): string[] {
  const out = [
    ...(p.IpRanges ?? []).map((r) => r.CidrIp),
    ...(p.Ipv6Ranges ?? []).map((r) => r.CidrIpv6),
    ...(p.UserIdGroupPairs ?? []).map((g) => g.GroupId),
    ...(p.PrefixListIds ?? []).map((l) => l.PrefixListId),
  ].filter((x): x is string => typeof x === "string" && x !== "");
  return out.length > 0 ? out : ["—"];
}

/** One row per (permission, peer); the NSG-rules view of the sibling apps. */
export function flattenSecurityGroupRules(g: SecurityGroup): SecurityGroupRuleInfo[] {
  const base = { group_id: g.GroupId ?? "", group_name: str(g.GroupName), vpc_id: str(g.VpcId) };
  const rows = (direction: "ingress" | "egress", permissions: IpPermission[] | undefined) =>
    (permissions ?? []).flatMap((p) => {
      const protocol = p.IpProtocol === "-1" || p.IpProtocol === undefined ? "all" : p.IpProtocol;
      const ports = portRange(p);
      return peers(p).map((peer) => ({ ...base, direction, protocol, ports, peer }));
    });
  return [...rows("ingress", g.IpPermissions), ...rows("egress", g.IpPermissionsEgress)];
}

export function mapBucket(b: Bucket): BucketInfo {
  return { name: b.Name ?? "", region: str(b.BucketRegion), created: iso(b.CreationDate) };
}

export function mapEksCluster(c: Cluster): EksClusterInfo {
  return {
    name: c.name ?? "",
    version: str(c.version),
    status: str(c.status),
    platform_version: str(c.platformVersion),
    oidc_issuer: str(c.identity?.oidc?.issuer),
    endpoint_public: c.resourcesVpcConfig?.endpointPublicAccess === true,
    endpoint_private: c.resourcesVpcConfig?.endpointPrivateAccess === true,
    auth_mode: str(c.accessConfig?.authenticationMode),
  };
}

export function mapEcrRepository(r: Repository): EcrRepositoryInfo {
  return {
    name: r.repositoryName ?? "",
    uri: str(r.repositoryUri),
    created: iso(r.createdAt),
    tag_mutability: str(r.imageTagMutability),
    scan_on_push: r.imageScanningConfiguration?.scanOnPush === true,
  };
}
```
If the SDK's `Tag`/`Bucket` field types are `string | undefined` unions that make `str()` complain, widen `str` to `(v: string | undefined | null)`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mappers.test.ts && npm run typecheck`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/inventory/mappers.ts tests/mappers.test.ts
git commit -m "feat: pure mappers from AWS SDK shapes to inventory rows" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: LiveAwsProvider (eight kinds) and the production wiring

**Files:**
- Create: `src/inventory/live-provider.ts`
- Modify: `src/app.ts` (`createDeps` default `createAwsProvider` → `createLiveAwsProvider`)
- Test: `tests/live-provider.test.ts`

**Interfaces:**
- Consumes: `clientDefaults`/`AwsClientDefaults`/`REGION_HINT` (Task 1), `CredentialProvider` (Task 2), models/`MAX_ITEMS` (Task 3), mappers (Task 5), SDK clients + paginators + commands.
- Produces: `class LiveAwsProvider implements AwsProvider { constructor(config: AwsClientDefaults, opts?: { maxItems?: number; eksDescribeCap?: number; eksConcurrency?: number }) }` — clients constructed lazily, one per service; `createLiveAwsProvider({ settings, credentials, logger }): AwsProvider` which throws `AwsError` (missing region or missing credential variables) so `InventoryService` shows it per panel.
- Paginators check `config.client instanceof <Client>`, so tests use `aws-sdk-client-mock`'s `mockClient(EC2Client)` etc., which intercepts `send` on real client instances.

- [ ] **Step 1: Write the failing tests**

`tests/live-provider.test.ts`:
```ts
import { DescribeInstancesCommand, DescribeSecurityGroupsCommand, DescribeSubnetsCommand, DescribeVpcsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DescribeRepositoriesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { DescribeClusterCommand, EKSClient, ListClustersCommand } from "@aws-sdk/client-eks";
import { IAMClient, ListAccountAliasesCommand } from "@aws-sdk/client-iam";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AwsError } from "../src/aws/aws-error.js";
import { clientDefaults, REGION_HINT, type AwsClientDefaults } from "../src/aws/client-defaults.js";
import { settingsFromEnv } from "../src/config.js";
import { CredentialProvider } from "../src/identity/credential-provider.js";
import { createLiveAwsProvider, LiveAwsProvider } from "../src/inventory/live-provider.js";

const ec2 = mockClient(EC2Client);
const s3 = mockClient(S3Client);
const sts = mockClient(STSClient);
const iam = mockClient(IAMClient);
const eks = mockClient(EKSClient);
const ecr = mockClient(ECRClient);
const credentials = async () => ({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" });
const config: AwsClientDefaults = { region: "us-east-1", credentials, maxAttempts: 2, requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 } };
const provider = (opts?: ConstructorParameters<typeof LiveAwsProvider>[1]) => new LiveAwsProvider(config, opts);

beforeEach(() => { for (const m of [ec2, s3, sts, iam, eks, ecr]) m.reset(); });
afterEach(() => { for (const m of [ec2, s3, sts, iam, eks, ecr]) m.reset(); });

describe("LiveAwsProvider", () => {
  it("account combines STS identity with the IAM alias, and tolerates a denied alias lookup", async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/aws-dash", UserId: "AIDA1" });
    iam.on(ListAccountAliasesCommand).resolves({ AccountAliases: ["kemo-lab"] });
    expect(await provider().getAccount()).toEqual({ items: [{ account_id: "123456789012", alias: "kemo-lab", arn: "arn:aws:iam::123456789012:user/aws-dash", user_id: "AIDA1", partition: "aws", region: "us-east-1" }], truncated: false });
    iam.on(ListAccountAliasesCommand).rejects(Object.assign(new Error("Access Denied"), { name: "AccessDenied" }));
    expect((await provider().getAccount()).items[0]?.alias).toBeNull();
  });

  it("instances walks every page and flattens reservations", async () => {
    ec2.on(DescribeInstancesCommand).resolvesOnce({ Reservations: [{ Instances: [{ InstanceId: "i-1" }, { InstanceId: "i-2" }] }], NextToken: "t1" })
      .resolvesOnce({ Reservations: [{ Instances: [{ InstanceId: "i-3" }] }] });
    const result = await provider().listInstances();
    expect(result.items.map((i) => i.id)).toEqual(["i-1", "i-2", "i-3"]);
    expect(result.truncated).toBe(false);
    expect(ec2.commandCalls(DescribeInstancesCommand)).toHaveLength(2);
  });

  it("stops at maxItems and flags truncation", async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [1, 2, 3, 4, 5].map((n) => ({ InstanceId: `i-${n}` })) }] });
    const result = await provider({ maxItems: 3 }).listInstances();
    expect(result.items).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("vpcs, subnets and security-group rules", async () => {
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: "vpc-1", CidrBlock: "10.0.0.0/16" }] });
    ec2.on(DescribeSubnetsCommand).resolves({ Subnets: [{ SubnetId: "s-1", VpcId: "vpc-1" }] });
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: "sg-1", IpPermissions: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "1.2.3.4/32" }] }] }] });
    const p = provider();
    expect((await p.listVpcs()).items[0]).toMatchObject({ id: "vpc-1", cidr: "10.0.0.0/16" });
    expect((await p.listSubnets()).items[0]).toMatchObject({ id: "s-1" });
    expect((await p.listSecurityGroupRules()).items).toEqual([{ group_id: "sg-1", group_name: null, vpc_id: null, direction: "ingress", protocol: "tcp", ports: "22", peer: "1.2.3.4/32" }]);
  });

  it("buckets come from a single ListBuckets call", async () => {
    s3.on(ListBucketsCommand).resolves({ Buckets: [{ Name: "a", BucketRegion: "us-east-1" }, { Name: "b" }] });
    expect((await provider().listBuckets()).items.map((b) => b.name)).toEqual(["a", "b"]);
  });

  it("eks lists names then describes each, capped", async () => {
    eks.on(ListClustersCommand).resolves({ clusters: ["a", "b", "c"] });
    eks.on(DescribeClusterCommand, { name: "a" }).resolves({ cluster: { name: "a", version: "1.33" } });
    eks.on(DescribeClusterCommand, { name: "b" }).resolves({ cluster: { name: "b", version: "1.32" } });
    const result = await provider({ eksDescribeCap: 2 }).listEksClusters();
    expect(result.items.map((c) => c.name)).toEqual(["a", "b"]);
    expect(result.truncated).toBe(true);
    expect(eks.commandCalls(DescribeClusterCommand)).toHaveLength(2);
  });

  it("ecr repositories", async () => {
    ecr.on(DescribeRepositoriesCommand).resolves({ repositories: [{ repositoryName: "aws-dash", repositoryUri: "x/aws-dash" }] });
    expect((await provider().listEcrRepositories()).items[0]).toMatchObject({ name: "aws-dash", uri: "x/aws-dash" });
  });
});

describe("createLiveAwsProvider", () => {
  const logger = pino({ level: "silent" });
  it("throws the region hint when AWS_REGION is unset", () => {
    const vars: Record<string, string> = { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" };
    const env = (n: string) => vars[n];
    const settings = settingsFromEnv(env);
    expect(() => createLiveAwsProvider({ settings, credentials: new CredentialProvider(settings, env), logger })).toThrow(REGION_HINT);
  });
  it("throws the missing-variable list when the credential mode is misconfigured", () => {
    const vars: Record<string, string> = { AWS_REGION: "us-east-1", AUTH_MODE: "web-identity" };
    const env = (n: string) => vars[n];
    const settings = settingsFromEnv(env);
    expect(() => createLiveAwsProvider({ settings, credentials: new CredentialProvider(settings, env), logger })).toThrow(AwsError);
    expect(() => createLiveAwsProvider({ settings, credentials: new CredentialProvider(settings, env), logger })).toThrow(/requires AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN/);
  });
  it("builds a provider with static keys and a region", () => {
    const vars: Record<string, string> = { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" };
    const env = (n: string) => vars[n];
    const settings = settingsFromEnv(env);
    expect(createLiveAwsProvider({ settings, credentials: new CredentialProvider(settings, env), logger })).toBeInstanceOf(LiveAwsProvider);
    expect(clientDefaults({ region: settings.region, credentials, logger, debug: false }).region).toBe("us-east-1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/live-provider.test.ts`
Expected: FAIL — cannot resolve `../src/inventory/live-provider.js`.

- [ ] **Step 3: Implement live-provider.ts and wire the default**

`src/inventory/live-provider.ts`:
```ts
import { EC2Client, paginateDescribeInstances, paginateDescribeSecurityGroups, paginateDescribeSubnets, paginateDescribeVpcs } from "@aws-sdk/client-ec2";
import { ECRClient, paginateDescribeRepositories } from "@aws-sdk/client-ecr";
import { DescribeClusterCommand, EKSClient, paginateListClusters } from "@aws-sdk/client-eks";
import { IAMClient, ListAccountAliasesCommand } from "@aws-sdk/client-iam";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { Logger } from "pino";
import { clientDefaults, type AwsClientDefaults } from "../aws/client-defaults.js";
import type { AppSettings } from "../config.js";
import type { CredentialProvider } from "../identity/credential-provider.js";
import { flattenSecurityGroupRules, mapAccount, mapBucket, mapEcrRepository, mapEksCluster, mapInstance, mapSubnet, mapVpc } from "./mappers.js";
import { MAX_ITEMS, type AccountInfo, type BucketInfo, type EcrRepositoryInfo, type EksClusterInfo, type InstanceInfo, type ListResult, type SecurityGroupRuleInfo, type SubnetInfo, type VpcInfo } from "./models.js";
import type { AwsProvider } from "./provider.js";

export interface LiveAwsProviderOptions {
  maxItems?: number;
  eksDescribeCap?: number;
  eksConcurrency?: number;
}

/** Collects mapped rows from an async page iterator, stopping at `max` with `truncated: true`. */
async function collect<T, R>(pages: AsyncIterable<T>, pick: (page: T) => R[], max: number): Promise<ListResult<R>> {
  const items: R[] = [];
  for await (const page of pages) {
    for (const item of pick(page)) {
      if (items.length >= max) return { items, truncated: true };
      items.push(item);
    }
  }
  return { items, truncated: false };
}

/** The real AwsProvider: one lazily-created client per service, all sharing the same credentials and client defaults. */
export class LiveAwsProvider implements AwsProvider {
  private readonly maxItems: number;
  private readonly eksDescribeCap: number;
  private readonly eksConcurrency: number;
  private ec2Client: EC2Client | undefined;
  private s3Client: S3Client | undefined;
  private stsClient: STSClient | undefined;
  private iamClient: IAMClient | undefined;
  private eksClient: EKSClient | undefined;
  private ecrClient: ECRClient | undefined;

  constructor(private readonly config: AwsClientDefaults, opts: LiveAwsProviderOptions = {}) {
    this.maxItems = opts.maxItems ?? MAX_ITEMS;
    this.eksDescribeCap = opts.eksDescribeCap ?? 20;
    this.eksConcurrency = opts.eksConcurrency ?? 4;
  }

  private ec2(): EC2Client { return (this.ec2Client ??= new EC2Client(this.config)); }
  private s3(): S3Client { return (this.s3Client ??= new S3Client(this.config)); }
  private sts(): STSClient { return (this.stsClient ??= new STSClient(this.config)); }
  private iam(): IAMClient { return (this.iamClient ??= new IAMClient(this.config)); }
  private eks(): EKSClient { return (this.eksClient ??= new EKSClient(this.config)); }
  private ecr(): ECRClient { return (this.ecrClient ??= new ECRClient(this.config)); }

  async getAccount(): Promise<ListResult<AccountInfo>> {
    const identity = await this.sts().send(new GetCallerIdentityCommand({}));
    // The alias is a nicety; a missing iam:ListAccountAliases permission must not fail the panel.
    const alias = await this.iam().send(new ListAccountAliasesCommand({ MaxItems: 1 }))
      .then((r) => r.AccountAliases?.[0] ?? null, () => null);
    return { items: [mapAccount(identity, alias, this.config.region)], truncated: false };
  }

  listInstances(): Promise<ListResult<InstanceInfo>> {
    return collect(paginateDescribeInstances({ client: this.ec2() }, {}), (p) => (p.Reservations ?? []).flatMap((r) => (r.Instances ?? []).map(mapInstance)), this.maxItems);
  }

  listVpcs(): Promise<ListResult<VpcInfo>> {
    return collect(paginateDescribeVpcs({ client: this.ec2() }, {}), (p) => (p.Vpcs ?? []).map(mapVpc), this.maxItems);
  }

  listSubnets(): Promise<ListResult<SubnetInfo>> {
    return collect(paginateDescribeSubnets({ client: this.ec2() }, {}), (p) => (p.Subnets ?? []).map(mapSubnet), this.maxItems);
  }

  listSecurityGroupRules(): Promise<ListResult<SecurityGroupRuleInfo>> {
    return collect(paginateDescribeSecurityGroups({ client: this.ec2() }, {}), (p) => (p.SecurityGroups ?? []).flatMap(flattenSecurityGroupRules), this.maxItems);
  }

  async listBuckets(): Promise<ListResult<BucketInfo>> {
    const out = await this.s3().send(new ListBucketsCommand({}));
    const all = (out.Buckets ?? []).map(mapBucket);
    return { items: all.slice(0, this.maxItems), truncated: all.length > this.maxItems };
  }

  async listEksClusters(): Promise<ListResult<EksClusterInfo>> {
    const names = await collect(paginateListClusters({ client: this.eks() }, {}), (p) => p.clusters ?? [], this.eksDescribeCap);
    const items: EksClusterInfo[] = [];
    for (let i = 0; i < names.items.length; i += this.eksConcurrency) {
      const batch = names.items.slice(i, i + this.eksConcurrency);
      const described = await Promise.all(batch.map((name) => this.eks().send(new DescribeClusterCommand({ name }))));
      for (const d of described) if (d.cluster) items.push(mapEksCluster(d.cluster));
    }
    return { items, truncated: names.truncated };
  }

  listEcrRepositories(): Promise<ListResult<EcrRepositoryInfo>> {
    return collect(paginateDescribeRepositories({ client: this.ecr() }, {}), (p) => (p.repositories ?? []).map(mapEcrRepository), this.maxItems);
  }
}

/** Production factory: fails fast (as an AwsError) on a missing region or credential misconfiguration so the panels can show why. */
export function createLiveAwsProvider(deps: { settings: AppSettings; credentials: CredentialProvider; logger: Logger }): AwsProvider {
  const config = clientDefaults({
    region: deps.settings.region,
    credentials: deps.credentials.provider(),
    logger: deps.logger,
    debug: deps.settings.awsDebug,
  });
  return new LiveAwsProvider(config);
}
```
If `new EC2Client(this.config)` rejects the `requestHandler` object type, cast that one field: `requestHandler: this.config.requestHandler as never` is NOT acceptable — instead build the client config as `{ ...this.config, requestHandler: new NodeHttpHandler(this.config.requestHandler) }` importing `NodeHttpHandler` from `@smithy/node-http-handler` (add it as a direct dependency at the version `npm ls @smithy/node-http-handler` reports) and say so in the report.

Modify `src/app.ts`: import `{ createLiveAwsProvider } from "./inventory/live-provider.js"` and replace the throwing default with
```ts
  const createAwsProvider = overrides.createAwsProvider ?? (() => createLiveAwsProvider({ settings, credentials, logger }));
```
(the now-unused `AwsError` import in `app.ts` goes away if nothing else uses it).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/live-provider.test.ts && npm test && npm run typecheck`
Expected: all pass; no network access occurs (every `send` is mocked; the credential provider is never resolved).

- [ ] **Step 5: Commit**

```bash
git add src/inventory/live-provider.ts src/app.ts tests/live-provider.test.ts
git commit -m "feat: live AWS inventory provider for the eight kinds" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: AWS page, panel partial and the eight inventory tables

**Files:**
- Create: `views/pages/aws.eta`, `views/partials/panel.eta`, `views/partials/inventory/{account,instances,vpcs,subnets,securitygroups,s3buckets,eksclusters,ecrrepos}.eta`
- Modify: `src/routes/inventory.ts` (add `GET /partials/aws/:kind`), `src/routes/pages.ts` (add `GET /aws`)
- Test: `tests/aws-pages.test.ts`

**Interfaces:**
- Consumes: `InventoryService.fetch`, `INVENTORY_KINDS`/`kindTitle`/`isInventoryKind`, `CredentialProvider.describe()`, `reply.page`/`reply.partial`, `fmt`.
- Produces: `GET /aws` page (header card: region, auth mode + reason, cache TTL, "Refresh all"; eight lazy `<section data-aws-panel hx-get="/partials/aws/<kind>" hx-trigger="load, refresh">`); `GET /partials/aws/:kind[?refresh=1]` → `partials/panel` with `{ kind, title, entry }`; the panel includes `/partials/inventory/<kind>` with `{ items, fmt }`.
- Panel footer rules: error **and** items → `Last attempt <time> failed; showing previously cached data`; error and no items → `Last attempt <time> failed`; success → `Fetched <time>`; nothing yet → `Never fetched`. Truncated → `Showing the first N items only.` Empty list → `None found.`

- [ ] **Step 1: Write the failing tests**

`tests/aws-pages.test.ts`:
```ts
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
    expect(html).toContain("static — auto: AWS_ACCESS_KEY_ID is set");
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/aws-pages.test.ts`
Expected: FAIL — `/aws` and `/partials/aws/*` return 404.

- [ ] **Step 3: Write the templates**

`views/pages/aws.eta`:
```eta
<% layout("/layout", { title: "AWS", nav: "aws" }) %>
<div class="grid">
  <section class="card">
    <div class="header-row">
      <h2>AWS resources</h2>
      <button class="secondary" hx-post="/api/aws/refresh" hx-swap="none"
        hx-on::after-request="document.querySelectorAll('section[data-aws-panel]').forEach(p => htmx.trigger(p, 'refresh'))">Refresh all</button>
    </div>
    <dl class="kv">
      <dt>Region</dt><dd><%= it.fmt.or(it.region, "not set (AWS_REGION)") %></dd>
      <dt>Auth mode</dt><dd><%= it.auth.mode %> — <%= it.auth.reason %></dd>
      <dt>Cache TTL</dt><dd><%= it.cache_ttl_seconds %> s</dd>
    </dl>
    <p class="muted">Each panel loads and fails independently; a failed refresh keeps the last good data. Only read-only API calls are made.</p>
  </section>
<% for (const k of it.kinds) { %>
  <section class="card" data-aws-panel hx-get="/partials/aws/<%= k.kind %>" hx-trigger="load, refresh">
    <h2><%= k.title %></h2>
    <p class="muted">Loading…</p>
  </section>
<% } %>
</div>
```

`views/partials/panel.eta`:
```eta
<% const e = it.entry, fmt = it.fmt, items = e.value ? e.value.items : null; %>
<h2><%= it.title %></h2>
<% if (e.error !== null) { %>
<div class="error"><%= e.error %></div>
<% } %>
<% if (items !== null) { %>
<%~ include("/partials/inventory/" + it.kind, { items, fmt }) %>
<% if (e.value.truncated) { %>
<p class="warning">Showing the first <%= items.length %> items only.</p>
<% } %>
<% } %>
<p class="muted">
<% if (e.error !== null && items !== null) { %>Last attempt <%= fmt.time(e.fetched_at) %> failed; showing previously cached data<% } else if (e.error !== null) { %>Last attempt <%= fmt.time(e.fetched_at) %> failed<% } else if (e.fetched_at !== null) { %>Fetched <%= fmt.time(e.fetched_at) %><% } else { %>Never fetched<% } %>
 · <a href="#" hx-get="/partials/aws/<%= it.kind %>?refresh=1" hx-target="closest [data-aws-panel]">refresh</a>
</p>
```

`views/partials/inventory/account.eta` (single row rendered as a key/value list):
```eta
<% const a = it.items[0]; %>
<% if (!a) { %><p class="muted">None found.</p><% } else { %>
<dl class="kv">
  <dt>Account</dt><dd><%= a.account_id %><% if (a.alias) { %> (<%= a.alias %>)<% } %></dd>
  <dt>Caller ARN</dt><dd><%= a.arn %></dd>
  <dt>User ID</dt><dd><%= a.user_id %></dd>
  <dt>Partition</dt><dd><%= a.partition %></dd>
  <dt>Region</dt><dd><%= a.region %></dd>
</dl>
<% } %>
```

The seven table templates share one shape — `None found.` when empty, otherwise `<div class="table-wrap"><table>` with a header row and one `<tr>` per item. Write each file exactly as follows.

`views/partials/inventory/instances.eta`:
```eta
<% if (it.items.length === 0) { %><p class="muted">None found.</p><% } else { %>
<div class="table-wrap"><table>
<thead><tr><th>ID</th><th>Name</th><th>Type</th><th>State</th><th>AZ</th><th>Private IP</th><th>Public IP</th><th>VPC</th><th>Subnet</th><th>Launched</th><th>Instance profile</th></tr></thead>
<tbody>
<% for (const i of it.items) { %>
<tr><td><%= i.id %></td><td><%= it.fmt.or(i.name) %></td><td><%= it.fmt.or(i.type) %></td><td><%= it.fmt.or(i.state) %></td><td><%= it.fmt.or(i.az) %></td><td><%= it.fmt.or(i.private_ip) %></td><td><%= it.fmt.or(i.public_ip) %></td><td><%= it.fmt.or(i.vpc_id) %></td><td><%= it.fmt.or(i.subnet_id) %></td><td><%= it.fmt.time(i.launch_time) %></td><td><%= it.fmt.or(i.iam_profile) %></td></tr>
<% } %>
</tbody></table></div>
<% } %>
```

`views/partials/inventory/vpcs.eta`:
```eta
<% if (it.items.length === 0) { %><p class="muted">None found.</p><% } else { %>
<div class="table-wrap"><table>
<thead><tr><th>ID</th><th>Name</th><th>CIDR</th><th>Default</th><th>State</th></tr></thead>
<tbody>
<% for (const v of it.items) { %>
<tr><td><%= v.id %></td><td><%= it.fmt.or(v.name) %></td><td><%= it.fmt.or(v.cidr) %></td><td><%= v.is_default ? "yes" : "no" %></td><td><%= it.fmt.or(v.state) %></td></tr>
<% } %>
</tbody></table></div>
<% } %>
```

`views/partials/inventory/subnets.eta`:
```eta
<% if (it.items.length === 0) { %><p class="muted">None found.</p><% } else { %>
<div class="table-wrap"><table>
<thead><tr><th>ID</th><th>Name</th><th>VPC</th><th>CIDR</th><th>AZ</th><th>Free IPs</th><th>Public IP on launch</th></tr></thead>
<tbody>
<% for (const s of it.items) { %>
<tr><td><%= s.id %></td><td><%= it.fmt.or(s.name) %></td><td><%= it.fmt.or(s.vpc_id) %></td><td><%= it.fmt.or(s.cidr) %></td><td><%= it.fmt.or(s.az) %></td><td><%= it.fmt.or(s.available_ips) %></td><td><%= s.map_public_ip ? "yes" : "no" %></td></tr>
<% } %>
</tbody></table></div>
<% } %>
```

`views/partials/inventory/securitygroups.eta`:
```eta
<% if (it.items.length === 0) { %><p class="muted">None found.</p><% } else { %>
<div class="table-wrap"><table>
<thead><tr><th>Group</th><th>Name</th><th>VPC</th><th>Direction</th><th>Protocol</th><th>Ports</th><th>Peer</th></tr></thead>
<tbody>
<% for (const r of it.items) { %>
<tr><td><%= r.group_id %></td><td><%= it.fmt.or(r.group_name) %></td><td><%= it.fmt.or(r.vpc_id) %></td><td><%= r.direction %></td><td><%= r.protocol %></td><td><%= r.ports %></td><td><%= r.peer %></td></tr>
<% } %>
</tbody></table></div>
<% } %>
```

`views/partials/inventory/s3buckets.eta`:
```eta
<% if (it.items.length === 0) { %><p class="muted">None found.</p><% } else { %>
<div class="table-wrap"><table>
<thead><tr><th>Name</th><th>Region</th><th>Created</th></tr></thead>
<tbody>
<% for (const b of it.items) { %>
<tr><td><%= b.name %></td><td><%= it.fmt.or(b.region) %></td><td><%= it.fmt.time(b.created) %></td></tr>
<% } %>
</tbody></table></div>
<% } %>
```

`views/partials/inventory/eksclusters.eta`:
```eta
<% if (it.items.length === 0) { %><p class="muted">None found.</p><% } else { %>
<div class="table-wrap"><table>
<thead><tr><th>Name</th><th>Version</th><th>Status</th><th>Platform</th><th>OIDC issuer</th><th>Endpoint</th><th>Auth mode</th></tr></thead>
<tbody>
<% for (const c of it.items) { %>
<tr><td><%= c.name %></td><td><%= it.fmt.or(c.version) %></td><td><%= it.fmt.or(c.status) %></td><td><%= it.fmt.or(c.platform_version) %></td><td><%= it.fmt.or(c.oidc_issuer) %></td><td><%= c.endpoint_public ? "public" : "" %><%= c.endpoint_public && c.endpoint_private ? " + " : "" %><%= c.endpoint_private ? "private" : "" %></td><td><%= it.fmt.or(c.auth_mode) %></td></tr>
<% } %>
</tbody></table></div>
<% } %>
```

`views/partials/inventory/ecrrepos.eta`:
```eta
<% if (it.items.length === 0) { %><p class="muted">None found.</p><% } else { %>
<div class="table-wrap"><table>
<thead><tr><th>Name</th><th>URI</th><th>Created</th><th>Tag mutability</th><th>Scan on push</th></tr></thead>
<tbody>
<% for (const r of it.items) { %>
<tr><td><%= r.name %></td><td><%= it.fmt.or(r.uri) %></td><td><%= it.fmt.time(r.created) %></td><td><%= it.fmt.or(r.tag_mutability) %></td><td><%= r.scan_on_push ? "yes" : "no" %></td></tr>
<% } %>
</tbody></table></div>
<% } %>
```

- [ ] **Step 4: Add the routes**

In `src/routes/inventory.ts` add (import `kindTitle` from `../inventory/kinds.js`):
```ts
  app.get("/partials/aws/:kind", async (req, reply) => {
    const { kind } = req.params as { kind: string };
    if (!isInventoryKind(kind)) return reply.code(404).send(errorBody(`unknown kind '${kind}'`));
    const entry = await deps.inventory.fetch(kind, isRefresh(req));
    return reply.partial("partials/panel", { kind, title: kindTitle(kind), entry });
  });
```

In `src/routes/pages.ts` add (import `INVENTORY_KINDS` from `../inventory/kinds.js`):
```ts
  app.get("/aws", (_req, reply) =>
    reply.page("pages/aws", {
      region: deps.settings.region ?? null,
      auth: deps.credentials.describe(),
      cache_ttl_seconds: deps.settings.cacheTtlSeconds,
      kinds: INVENTORY_KINDS,
    }));
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/aws-pages.test.ts && npm test && npm run typecheck`
Expected: all pass. Manual: `AWS_PROFILE=<your profile> AWS_REGION=us-east-1 npm run dev` (if you have a working profile; otherwise run without and see the per-panel hints), open http://localhost:8080/aws — panels load independently; "Refresh all" re-fires every panel.

- [ ] **Step 6: Commit**

```bash
git add views/pages/aws.eta views/partials/panel.eta views/partials/inventory src/routes/inventory.ts src/routes/pages.ts tests/aws-pages.test.ts
git commit -m "feat: AWS tab with eight independently loading inventory panels" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Least-privilege IAM policy and deployment runbooks

**Files:**
- Create: `deploy/aws/aws-dash-readonly-policy.json`
- Modify: `deploy/kubernetes/README.md`, `deploy/README.md`

**Interfaces:**
- Produces: the policy every overlay's README refers to; `scripts/kustomize-check.sh` already skips `deploy/aws/` (no `kustomization.yaml`), so CI's `manifests` job is unaffected.

- [ ] **Step 1: Write the policy**

`deploy/aws/aws-dash-readonly-policy.json`:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AwsDashReadOnly",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "iam:ListAccountAliases",
        "iam:GetRole",
        "ec2:DescribeRegions",
        "ec2:DescribeInstances",
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups",
        "s3:ListAllMyBuckets",
        "eks:ListClusters",
        "eks:DescribeCluster",
        "ecr:DescribeRepositories"
      ],
      "Resource": "*"
    }
  ]
}
```
Validate: `python3 -c 'import json; json.load(open("deploy/aws/aws-dash-readonly-policy.json")); print("json ok")'` (or `node -e 'JSON.parse(require("fs").readFileSync("deploy/aws/aws-dash-readonly-policy.json","utf8")); console.log("json ok")'`).

- [ ] **Step 2: Update `deploy/kubernetes/README.md`**

Replace the paragraph beginning "The app makes no AWS calls in Phase 1" with:
````markdown
The AWS tab only reads. Create the least-privilege policy once and attach it to the user:

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws iam create-policy --policy-name aws-dash-readonly --policy-document file://deploy/aws/aws-dash-readonly-policy.json
aws iam attach-user-policy --user-name aws-dash --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/aws-dash-readonly"
```
````
and append before the "Delete the key" line:
````markdown
Demo: `aws iam detach-user-policy --user-name aws-dash --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/aws-dash-readonly"`, then click
"Refresh all" — every panel shows an `AccessDenied` hint but keeps its last data; re-attach and refresh to recover.
````
(The README file uses ```bash fences inside; keep them intact.)

- [ ] **Step 3: Update `deploy/README.md`**

Append:
````markdown

## Shared AWS prerequisites

Every overlay grants the same read-only permissions, `deploy/aws/aws-dash-readonly-policy.json`, to whichever principal the
overlay authenticates as (an IAM user for `kubernetes`/`openshift`, an IAM role for the workload-identity overlays):

```bash
aws iam create-policy --policy-name aws-dash-readonly --policy-document file://deploy/aws/aws-dash-readonly-policy.json
```

`sts:GetCallerIdentity` needs no permission; everything else on the AWS tab fails closed with an actionable hint when the policy is missing.
````

- [ ] **Step 4: Verify and commit**

Run: `scripts/kustomize-check.sh` (still two `ok` lines) and the JSON validation above.

```bash
git add deploy/aws/aws-dash-readonly-policy.json deploy/kubernetes/README.md deploy/README.md
git commit -m "deploy: least-privilege read-only IAM policy and runbook steps" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Prometheus `/metrics`

**Files:**
- Create: `src/metrics/metrics.ts`, `src/routes/metrics.ts`
- Modify: `src/runtime/runtime-info.ts` (export `readCgroupInfo(root)`), `src/app.ts` (`AppDeps.metrics`, `createDeps` wiring, route + `onResponse` hook; `InventoryService` gets `metrics` as its observer)
- Test: `tests/metrics.test.ts`

**Interfaces:**
- Consumes: `prom-client` (`Registry`, `Gauge`, `Counter`, `Histogram`, `collectDefaultMetrics`), `StateSnapshot`, `CgroupInfo`, `InventoryObserver` (Task 4).
- Produces: `registerHttpMetricsHook(app, deps)` (declared before the routes); `class Metrics implements InventoryObserver { constructor(sources: MetricsSources); readonly registry: Registry; fetched(kind, ok, seconds); httpRequest(method, route, status); render(): Promise<string>; readonly contentType: string }`; `interface MetricsSources { version; nodeVersion; authMode; startedAt: Date; snapshot: () => StateSnapshot; cgroup: () => CgroupInfo }`; `registerMetricsRoutes(app, deps)` → `GET /metrics` (404 `{detail:"metrics are disabled (METRICS_ENABLED=false)"}` when disabled); `readCgroupInfo(root): CgroupInfo`.
- Metric names (all with `help` text): `aws_dash_info{version,node_version,auth_mode}`, `aws_dash_start_time_seconds`, `aws_dash_probe_live`, `aws_dash_probe_ready`, `aws_dash_cpu_load_workers`, `aws_dash_memory_load_allocated_bytes`, `aws_dash_memory_load_target_bytes`, `aws_dash_cgroup_memory_limit_bytes`, `aws_dash_cgroup_memory_usage_bytes`, `aws_dash_cgroup_cpu_limit_cores` (−1 when unknown/unlimited), `aws_dash_inventory_fetch_duration_seconds{kind}` (histogram, buckets `0.05 0.1 0.25 0.5 1 2.5 5 10`), `aws_dash_inventory_fetch_errors_total{kind}`, `aws_dash_inventory_last_success_timestamp_seconds{kind}`, `aws_dash_http_requests_total{method,route,status}`, plus prom-client's default process/nodejs metrics. Every gauge is computed in a `collect()` callback from in-memory state — a scrape never calls AWS.
- Each `Metrics` instance owns its own `Registry` (never the global one) so tests can build many apps.

- [ ] **Step 1: Write the failing tests**

`tests/metrics.test.ts`:
```ts
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
```
(`1767225600` is `2026-01-01T00:00:00Z`, the `FakeClock` epoch `testApp` starts at.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/metrics.test.ts`
Expected: FAIL — `/metrics` returns 404 `not found`.

- [ ] **Step 3: Implement**

In `src/runtime/runtime-info.ts`, export the cgroup reader (rename the private `readCgroup` to an exported `readCgroupInfo` and update its two call sites, or add `export function readCgroupInfo(root: string): CgroupInfo { return readCgroup(root); }`).

`src/metrics/metrics.ts`:
```ts
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { InventoryObserver } from "../inventory/inventory-service.js";
import type { InventoryKind } from "../inventory/kinds.js";
import type { CgroupInfo } from "../runtime/runtime-info.js";
import type { StateSnapshot } from "../state/state-service.js";

export interface MetricsSources {
  version: string;
  nodeVersion: string;
  authMode: string;
  startedAt: Date;
  snapshot: () => StateSnapshot;
  cgroup: () => CgroupInfo;
}

const MIB = 1024 * 1024;
const orMinusOne = (v: number | null): number => (v === null ? -1 : v);

/** Prometheus registry for the app. Gauges are computed at scrape time from in-memory state; nothing here calls AWS. */
export class Metrics implements InventoryObserver {
  readonly registry = new Registry();
  private readonly fetchDuration: Histogram<"kind">;
  private readonly fetchErrors: Counter<"kind">;
  private readonly lastSuccess: Gauge<"kind">;
  private readonly httpRequests: Counter<"method" | "route" | "status">;

  constructor(sources: MetricsSources) {
    const registers = [this.registry];
    collectDefaultMetrics({ register: this.registry });

    new Gauge({ name: "aws_dash_info", help: "Build and configuration info (always 1).", labelNames: ["version", "node_version", "auth_mode"], registers })
      .set({ version: sources.version, node_version: sources.nodeVersion, auth_mode: sources.authMode }, 1);
    new Gauge({ name: "aws_dash_start_time_seconds", help: "Process start time, seconds since the Unix epoch.", registers })
      .set(Math.floor(sources.startedAt.getTime() / 1000));

    const gauge = (name: string, help: string, read: () => number) =>
      new Gauge({ name, help, registers, collect() { this.set(read()); } });
    gauge("aws_dash_probe_live", "1 while the liveness probe reports ok.", () => (sources.snapshot().live ? 1 : 0));
    gauge("aws_dash_probe_ready", "1 while the readiness probe reports ok.", () => (sources.snapshot().ready ? 1 : 0));
    gauge("aws_dash_cpu_load_workers", "Busy worker threads started by the CPU control.", () => sources.snapshot().cpu_load.workers);
    gauge("aws_dash_memory_load_allocated_bytes", "Bytes currently held by the memory control.", () => sources.snapshot().memory_load.allocated_mib * MIB);
    gauge("aws_dash_memory_load_target_bytes", "Bytes the memory control is trying to hold.", () => sources.snapshot().memory_load.target_mib * MIB);
    gauge("aws_dash_cgroup_memory_limit_bytes", "cgroup memory limit, or -1 when unlimited/unknown.", () => orMinusOne(sources.cgroup().memory_limit_bytes));
    gauge("aws_dash_cgroup_memory_usage_bytes", "cgroup memory usage, or -1 when unknown.", () => orMinusOne(sources.cgroup().memory_usage_bytes));
    gauge("aws_dash_cgroup_cpu_limit_cores", "cgroup CPU limit in cores, or -1 when unlimited/unknown.", () => orMinusOne(sources.cgroup().cpu_limit_cores));

    this.fetchDuration = new Histogram({ name: "aws_dash_inventory_fetch_duration_seconds", help: "Time to load one inventory kind from AWS.", labelNames: ["kind"], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers });
    this.fetchErrors = new Counter({ name: "aws_dash_inventory_fetch_errors_total", help: "Failed inventory loads by kind.", labelNames: ["kind"], registers });
    this.lastSuccess = new Gauge({ name: "aws_dash_inventory_last_success_timestamp_seconds", help: "Unix time of the last successful load by kind.", labelNames: ["kind"], registers });
    this.httpRequests = new Counter({ name: "aws_dash_http_requests_total", help: "HTTP requests by method, route pattern and status.", labelNames: ["method", "route", "status"], registers });
  }

  fetched(kind: InventoryKind, ok: boolean, seconds: number): void {
    this.fetchDuration.observe({ kind }, seconds);
    if (ok) this.lastSuccess.set({ kind }, Math.floor(Date.now() / 1000));
    else this.fetchErrors.inc({ kind });
  }

  httpRequest(method: string, route: string, status: number): void {
    this.httpRequests.inc({ method, route, status: String(status) });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
```

`src/routes/metrics.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { errorBody } from "./errors.js";

export function registerMetricsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/metrics", async (_req, reply) => {
    if (!deps.settings.metricsEnabled) return reply.code(404).send(errorBody("metrics are disabled (METRICS_ENABLED=false)"));
    return reply.type(deps.metrics.contentType).send(await deps.metrics.render());
  });
}

/** Counts every response by route pattern. Must be added BEFORE any route is registered so it applies to all of them. */
export function registerHttpMetricsHook(app: FastifyInstance, deps: AppDeps): void {
  app.addHook("onResponse", (req, reply, done) => {
    deps.metrics.httpRequest(req.method, req.routeOptions.url ?? "unmatched", reply.statusCode);
    done();
  });
}
```
(Fastify 5 exposes the matched route pattern as `req.routeOptions.url`; it is `undefined` for the not-found handler. If TypeScript says `url` is non-optional, keep the `?? "unmatched"` — the runtime value is undefined for 404s.)

Modify `src/app.ts`:
- imports: `import { Metrics } from "./metrics/metrics.js"; import { readCgroupInfo } from "./runtime/runtime-info.js"; import { registerHttpMetricsHook, registerMetricsRoutes } from "./routes/metrics.js";`
- `AppDeps` gains `metrics: Metrics;`
- in `createDeps`, compute `const fsRoot = overrides.fsRoot ?? "/";` and `const version = overrides.version ?? pkg.version;` before building the rest; after `stateService` is known:
```ts
  const stateService = overrides.stateService ?? new StateService(state, cpu, memory, settings, clock);
  const metrics = overrides.metrics ?? new Metrics({
    version, nodeVersion: process.version, authMode: settings.authMode, startedAt: state.startedAt,
    snapshot: () => stateService.snapshot(), cgroup: () => readCgroupInfo(fsRoot),
  });
  const inventory = overrides.inventory ?? new InventoryService(createAwsProvider, new TtlCache(settings.cacheTtlSeconds * 1000, clock, (err) => awsErrorFrom(err).message), logger, metrics);
```
and return `fsRoot, version, stateService, metrics, inventory` from the same variables.
- `buildApp`: call `registerHttpMetricsHook(app, deps);` immediately after `registerRendering(...)` and BEFORE `app.setNotFoundHandler` and every `register*Routes` call (Fastify applies request hooks to routes declared after the hook in the same context); then `registerMetricsRoutes(app, deps);` after `registerInventoryRoutes`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/metrics.test.ts && npm test && npm run typecheck`
Expected: all pass, output pristine (if prom-client warns about a metric registered twice, the `Registry` is being shared — each `Metrics` must own its own).

- [ ] **Step 5: Commit**

```bash
git add src/metrics src/routes/metrics.ts src/runtime/runtime-info.ts src/app.ts tests/metrics.test.ts
git commit -m "feat: Prometheus /metrics with probe, load, cgroup, inventory and HTTP metrics" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: README for Phase 2 and the live check

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above. The README must match the code (routes in `src/routes/*.ts`, variables in `src/config.ts`).

- [ ] **Step 1: Update README.md**

- **Status** paragraph → `Phase 2: the AWS tab (eight read-only inventory panels), explicit credential-mode selection, and Prometheus `/metrics`. The Identity tab is not implemented yet (its nav link 404s).`
- **Run locally**: add after the `npm run dev` line: `AWS_PROFILE=<profile> AWS_REGION=us-east-1 npm run dev   # AWS tab with your local credentials`.
- **Endpoints** table: add rows
  - `GET | /aws | AWS page: header card + 8 lazy panels`
  - `GET | /api/aws/{kind}[?refresh=true] | {kind, fetched_at, error, items, truncated}; kinds: account, instances, vpcs, subnets, securitygroups, s3buckets, eksclusters, ecrrepos`
  - `GET | /partials/aws/{kind}[?refresh=1] | htmx panel`
  - `POST | /api/aws/refresh | drop every cached kind → 204`
  - `GET | /metrics | Prometheus text; 404 when METRICS_ENABLED=false`
- **Configuration** table: move `AUTH_MODE` (`auto`; `auto|static|profile|web-identity|pod-identity|imds` — auto follows the SDK chain order), `AWS_REGION` (falls back to `AWS_DEFAULT_REGION`; required for the AWS tab), `AWS_CACHE_TTL_SECONDS` (60), `AWS_DEBUG` (false; logs SDK request metadata), `METRICS_ENABLED` (true) into their own rows; leave `IMDS_ENABLED`, `K8S_INFO_ENABLED`, `ACCESS_CHECK_ENABLED`, `SPIFFE_*` in the "parsed now, used from Phase 3 onward" row. Add a short "Credential modes" table: mode → what selects it in `auto` → what the SDK does (`fromEnv`, `fromIni`, `fromTokenFile → AssumeRoleWithWebIdentity`, `fromHttp` container endpoint, `fromInstanceMetadata`).
- New **Permissions** section: link `deploy/aws/aws-dash-readonly-policy.json`; note `sts:GetCallerIdentity` needs none and every other panel fails closed with a hint.
- **Demo** list: add `6. Detach the read-only policy and click "Refresh all" → every panel shows an AccessDenied hint but keeps its last data; re-attach to recover.` and `7. Scrape /metrics (e.g. curl -s localhost:8080/metrics | grep aws_dash_) while doing the above.`

- [ ] **Step 2: Drift checks**

Run:
```bash
grep -oE '`/(api|partials)/aws[^`]*`|`/aws`|`/metrics`' README.md | sort -u
grep -nE 'app\.(get|post)\("/(api/aws|partials/aws|aws|metrics)' src/routes/*.ts
```
Expected: every README path has a matching route registration (and vice versa).

- [ ] **Step 3: Live check (record the outcome; skip honestly if there are no credentials)**

If `aws sts get-caller-identity` succeeds on this machine:
1. `AWS_PROFILE=<that profile> AWS_REGION=<a region you use> npm run dev` (background), then `curl -s localhost:8080/api/aws/account | head -c 400`, `curl -s localhost:8080/api/aws/vpcs | head -c 400`, `curl -s localhost:8080/metrics | grep -E '^aws_dash_inventory'`, and open `/aws` in a browser to confirm the panels and "Refresh all". Stop the server.
2. Optionally `podman build --format docker -t localhost/aws-dash:dev . && AWS_PROFILE=<profile> AWS_REGION=<region> scripts/run-podman.sh` — the Account panel must show the caller ARN (the script mounts `~/.aws` read-only).
Record the exact outputs (redacting the account id and ARN if you prefer) in the report. If there are no usable credentials, run `npm run dev` without any and confirm each panel shows the "AWS_REGION is not set" or credential hint, and record that the live AWS check was skipped.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README for the AWS inventory increment" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 2 exit criteria

- `npm test` green (Phase 1's 82 + ≈45 new), `npm run typecheck` clean, no test reaches AWS (`aws-sdk-client-mock` and `FakeAwsProvider` only).
- With static keys or a profile and `AWS_REGION` set, `/aws` shows all eight panels; with the policy detached, each shows the AccessDenied hint and keeps its last rows; with no region, each shows the region hint.
- `/metrics` exposes `aws_dash_*` and process metrics; scraping it never calls AWS.
- `deploy/aws/aws-dash-readonly-policy.json` exists and the `kubernetes` README attaches it; `scripts/kustomize-check.sh` still passes.
- The container image builds unchanged (`--omit=optional` still leaves zero `*.node` files: verify `podman run --rm localhost/aws-dash:dev sh -c 'find node_modules -name "*.node" | wc -l'` → `0` after rebuilding with the new dependencies).

Next: `docs/superpowers/plans/2026-09-27-aws-dash-phase3-identity.md` (Identity tab, access-check matrix, IMDS card, EKS/OIDC overlays), written against this code.
