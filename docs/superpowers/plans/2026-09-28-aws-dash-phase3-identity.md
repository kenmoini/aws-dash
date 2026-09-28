# aws-dash Phase 3 — Identity Tab, Access Check, IMDS, EKS/OIDC Overlays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workload identity *visible*: an Identity tab that shows how the app authenticates (mode + why + flavor), the decoded token it presents to STS, what STS says it is, and which of the demo's read-only actions the identity is allowed to perform — plus an IMDS "this is the node, not the pod" card — and ship the EKS (IRSA + Pod Identity) and OpenShift native-issuer overlays with runbooks and CI placeholder checks.

**Architecture:** Three new services plug into the Phase 2 `AppDeps` seam: `IdentityService` (decodes the token file for display only, resolves the shared memoized credentials to read `$source`/expiration/key prefix, calls `sts:GetCallerIdentity`, translates errors into hints), `AccessCheckService` (runs a matrix of minimal read-only calls with concurrency 4 and classifies each as allowed/denied/credential/error/skipped), and `ImdsClient` (IMDSv2 with a 1 s timeout, unavailable is a normal state). All three cache through `TtlCache` and are invalidated by `POST /api/aws/refresh`. Metrics gain credential/token expiry gauges fed from cached identity state (never a call on scrape). Raw tokens and full key ids are never rendered, serialized or logged — tested.

**Tech Stack:** Phase 2 stack; no new dependencies (`@aws-sdk/client-{sts,iam,ec2,s3,eks,ecr}` already installed; IMDS uses Node's global `fetch` with an injectable `fetchFn`; JWT decoding is `Buffer.from(…, "base64url")` + `JSON.parse`).

**Spec:** `docs/superpowers/specs/2026-09-27-aws-dash-design.md` — §2 (identity/access-check/imds endpoints), §3 (`ACCESS_CHECK_ACTIONS`, `IMDS_ENABLED`), §4 (flavor), §5 (Identity tab + access-check matrix), §8 (identity/access-check metrics), §9 (IMDS card), §11 (`eks-irsa`, `eks-pod-identity`, `openshift-native-oidc`, `check-placeholders.sh`), §13 Phase 3, §15 risks 3–4. Phase 2 plan for conventions: `docs/superpowers/plans/2026-09-27-aws-dash-phase2-inventory.md`.

## Global Constraints

- Everything in the Phase 1 and Phase 2 Global Constraints still applies (ESM/NodeNext `.js` imports, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, snake_case JSON, `HX-Request` → HTML else JSON, 422/403/404 `{detail}` conventions, routes never import `@aws-sdk/*`, every cloud failure is a 200 with an error field, tests never reach AWS or the network, commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` via two `-m` flags).
- **Raw tokens and secrets are never exposed:** `decodeJwtForDisplay` returns allow-listed claims only; `IdentityInfo` carries a masked key id (`ASIA…7Q2K`: first 4 + `…` + last 4) and never `secretAccessKey`/`sessionToken`; nothing logs a token. A test asserts the HTML, the JSON and the pino log stream contain neither the token nor its signature.
- Identity JSON shape is spec §5 verbatim: top-level `mode, reason, flavor, credential_type, region, role_arn, role_session_name, token_file, container_credentials_uri, profile, error, token, sts, credentials, fetched_at`; `token = { claims, issued_at, expires_at, expires_in_seconds, error }`; `sts = { account, arn, user_id, principal_type, role_name, session_name, error, hint }`; `credentials = { key_prefix, key_id_masked, temporary, expiration, expires_in_seconds, account_id, source, error }` where `source` is an array of `"<id>: <label>"` decoded from the SDK's `$source` feature ids (`g` environment variables, `h` web-identity token file, `k` sts:AssumeRoleWithWebIdentity, `i` sts:AssumeRole, `z` container credentials endpoint, `0` EC2 instance metadata, `n` shared config profile, `o` profile source_profile, `p` profile named provider, `q` profile web-identity token, `r` profile SSO, `s` SSO, `v` profile credential_process, `w` credential_process, `e` code, `T` account id resolved; unknown ids shown raw) with the caption "internal SDK ids, may change".
- Flavor (spec §4): web-identity token `sub` starting `spiffe://` → `SPIFFE JWT-SVID (spiffe-helper)`; `iss` containing `oidc.eks.` → `EKS IRSA`; `sub` starting `system:serviceaccount:` → `Kubernetes projected service-account token`; other web-identity → `OIDC token file`; pod-identity host `169.254.170.23` → `EKS Pod Identity`, relative URI → `ECS task role`, other → `container credentials endpoint`; static → `long-lived IAM user access key`; profile → `shared config profile`; imds → `EC2 instance role (IMDS)`.
- Access-check actions, in order: `sts:GetCallerIdentity` (first; if it is not `allowed`, every later row is `skipped`), `iam:ListAccountAliases` (`MaxItems: 1`), `ec2:DescribeRegions` (`RegionNames: [region]`), `ec2:DescribeInstances`/`DescribeVpcs`/`DescribeSubnets`/`DescribeSecurityGroups` (`MaxResults: 5` — the EC2 minimum), `s3:ListAllMyBuckets` (`MaxBuckets: 1`), `eks:ListClusters` (`maxResults: 1`), `ecr:DescribeRepositories` (`maxResults: 1`), `iam:GetRole` (`RoleName` = the role parsed from the STS ARN; only when the principal is an assumed role, otherwise `skipped`). Classification: `denied` when the error name ∈ {AccessDenied, AccessDeniedException, UnauthorizedOperation, UnauthorizedAccess, AuthorizationError} or HTTP 403; `credential` when name ∈ {CredentialsProviderError, ProviderError, ExpiredToken, ExpiredTokenException, InvalidClientTokenId, InvalidIdentityToken, UnrecognizedClientException, AuthFailure}; else `error`. Concurrency 4. Row: `{ action, service, result, code, message, duration_ms }`. `ACCESS_CHECK_ACTIONS` (comma-separated subset of the action names; unknown → startup `ConfigError`) limits the matrix; `ACCESS_CHECK_ENABLED=false` → the card says disabled and the JSON has `enabled: false`.
- IMDS card: IMDSv2 only (`PUT /latest/api/token` with `X-aws-ec2-metadata-token-ttl-seconds: 60`, then `GET /latest/dynamic/instance-identity/document` with the token); 1 s total timeout via `AbortSignal.timeout`; base URL `http://169.254.169.254`; fields `instance_id, instance_type, availability_zone, region, account_id, image_id, private_ip`; `available: false` with a `reason` for disabled / timeout ("not running on EC2, or the pod cannot reach IMDS: hop limit 1, EKS Auto Mode") / non-2xx / bad JSON / network error; cached for the TTL; the card caption says it describes the **node**, not the pod.
- `POST /api/aws/refresh` now invalidates inventory, identity, access-check and IMDS caches.
- Metrics (spec §8): `aws_dash_credential_expiry_seconds{mode}` (seconds until the cached credentials expire; −1 when unknown or non-expiring), `aws_dash_token_file_expiry_seconds` (−1 when no token), `aws_dash_credential_resolutions_total{mode,result}` (result `ok`|`error`), `aws_dash_access_check_allowed{action}` (1 allowed / 0 otherwise, set on each run). Every gauge reads cached state; a scrape never calls AWS, IMDS or reads the token file.
- Overlays: `deploy/eks-irsa`, `deploy/eks-pod-identity`, `deploy/openshift-native-oidc` (Kustomize, patching the Phase 1 base; no `runAsUser`; placeholders are `AWS_ACCOUNT_ID` and `OIDC_ISSUER_HOST`, replaced by `sed` lines in that overlay's README); trust-policy templates in `deploy/aws/trust-*.json`; `scripts/check-placeholders.sh` fails when a placeholder in an overlay's YAML/JSON is not named in that overlay's README; CI's `manifests` job runs it. `deploy/components/node-reader` and `rbac.yaml` stay in Phase 4 with the Kubernetes card.

## Review Focus

1. A pod-identity token file (`AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`) is also a JWT (`aud pods.eks.amazonaws.com`) — the Identity tab must decode and show it like the web-identity token — Task 2 test.
2. A token file that is base64-wrapped (Red Hat's spiffe-helper docs say "base64-encoded") must still decode for display — Task 1 `normalizeToken` test. (The SDK path is unaffected: `fromTokenFile` reads the raw file; Phase 4 verifies the real format.)
3. When STS fails, the credential facts must still render (and vice versa), and the access-check matrix must skip rather than hammer STS — Task 2 (independent sections) and Task 4 (skip-on-credential-failure) tests.
4. `ACCESS_CHECK_ACTIONS=ec2:DescribeInstances` must still run `sts:GetCallerIdentity` first (it is the gate) — Task 4 test.
5. `/metrics` must not read the token file or resolve credentials — Task 6 test: a scrape leaves the fake STS/readFile call counts unchanged.

---

### Task 1: JWT decoding for display

**Files:**
- Create: `src/identity/jwt-display.ts`, `tests/support/test-jwt.ts`
- Test: `tests/jwt-display.test.ts`

**Interfaces:**
- Produces: `interface JwtSummary { claims: Record<string, string>; issued_at: string | null; expires_at: string | null; error: string | null }`; `FEDERATED_CLAIMS = ["iss", "sub", "aud", "iat", "exp"]`; `normalizeToken(raw: string): string` (trims; unwraps a base64/base64url-wrapped compact JWT); `decodeJwtForDisplay(raw: string | null | undefined, allowed?: readonly string[]): JwtSummary` — never throws, never returns the token; test helper `makeJwt(payload, header?)` and `TEST_SIGNATURE`.

- [ ] **Step 1: Write the test helper and failing tests**

`tests/support/test-jwt.ts`:
```ts
const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString("base64url");

/** A signature that must never appear in any rendered output or log. */
export const TEST_SIGNATURE = "c2lnbmF0dXJlLURPLU5PVC1MRUFL";

/** Builds an unsigned-but-well-formed compact JWT for display tests. */
export function makeJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: "test" }): string {
  return `${b64url(header)}.${b64url(payload)}.${TEST_SIGNATURE}`;
}
```

`tests/jwt-display.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { decodeJwtForDisplay, FEDERATED_CLAIMS, normalizeToken } from "../src/identity/jwt-display.js";
import { makeJwt, TEST_SIGNATURE } from "./support/test-jwt.js";

const NOW = 1_767_225_600; // 2026-01-01T00:00:00Z

describe("decodeJwtForDisplay", () => {
  it("returns only the allow-listed claims, with iat/exp as ISO timestamps", () => {
    const token = makeJwt({ iss: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", sub: "system:serviceaccount:aws-dash:aws-dash", aud: "sts.amazonaws.com", iat: NOW, exp: NOW + 3600, "kubernetes.io": { namespace: "aws-dash" }, secret: "x" });
    const out = decodeJwtForDisplay(token);
    expect(out).toEqual({
      claims: { iss: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", sub: "system:serviceaccount:aws-dash:aws-dash", aud: "sts.amazonaws.com", iat: "2026-01-01T00:00:00.000Z", exp: "2026-01-01T01:00:00.000Z" },
      issued_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2026-01-01T01:00:00.000Z",
      error: null,
    });
    expect(JSON.stringify(out)).not.toContain(TEST_SIGNATURE);
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("joins array audiences and stringifies non-string claims", () => {
    const out = decodeJwtForDisplay(makeJwt({ aud: ["aws-dash", "sts.amazonaws.com"], sub: 42 }), ["aud", "sub"]);
    expect(out.claims).toEqual({ aud: "aws-dash, sts.amazonaws.com", sub: "42" });
  });

  it("unwraps a base64-wrapped token (spiffe-helper style) and tolerates whitespace", () => {
    const token = makeJwt({ sub: "spiffe://example.org/ns/aws-dash/sa/aws-dash", aud: "aws-dash" });
    const wrapped = `\n${Buffer.from(token).toString("base64")}\n`;
    expect(normalizeToken(wrapped)).toBe(token);
    expect(normalizeToken(`  ${token}  `)).toBe(token);
    expect(decodeJwtForDisplay(wrapped).claims.sub).toBe("spiffe://example.org/ns/aws-dash/sa/aws-dash");
  });

  it.each([
    [undefined, "no token"],
    ["", "no token"],
    ["abc.def", "could not decode token: expected 3 dot-separated segments, found 2"],
    ["a.!!!.c", "could not decode token: payload is not a JSON object"],
    [`a.${Buffer.from("[1,2]").toString("base64url")}.c`, "could not decode token: payload is not a JSON object"],
  ])("reports %j as an error without throwing", (raw, error) => {
    expect(decodeJwtForDisplay(raw)).toEqual({ claims: {}, issued_at: null, expires_at: null, error });
  });

  it("exposes the federated claim list", () => {
    expect(FEDERATED_CLAIMS).toEqual(["iss", "sub", "aud", "iat", "exp"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/jwt-display.test.ts`
Expected: FAIL — cannot resolve `../src/identity/jwt-display.js`.

- [ ] **Step 3: Implement jwt-display.ts**

`src/identity/jwt-display.ts`:
```ts
/** Decoded-for-display view of a JWT: allow-listed claims only, never the token itself. */
export interface JwtSummary {
  claims: Record<string, string>;
  issued_at: string | null;
  expires_at: string | null;
  error: string | null;
}

export const FEDERATED_CLAIMS: readonly string[] = ["iss", "sub", "aud", "iat", "exp"];

const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** Trims, and unwraps a base64/base64url-wrapped compact JWT (spiffe-helper may write one). */
export function normalizeToken(raw: string): string {
  const trimmed = raw.trim();
  if (COMPACT_JWT.test(trimmed)) return trimmed;
  try {
    const inner = Buffer.from(trimmed, "base64").toString("utf8").trim();
    if (COMPACT_JWT.test(inner)) return inner;
  } catch {
    // fall through: not base64
  }
  return trimmed;
}

function failed(error: string): JwtSummary {
  return { claims: {}, issued_at: null, expires_at: null, error };
}

function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(render).join(", ");
  if (value === null || typeof value !== "object") return String(value);
  return JSON.stringify(value);
}

function epoch(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

/** Decodes (never verifies) a JWT payload for display. Total: any problem becomes `error`. */
export function decodeJwtForDisplay(raw: string | null | undefined, allowed: readonly string[] = FEDERATED_CLAIMS): JwtSummary {
  if (raw === null || raw === undefined || raw.trim() === "") return failed("no token");
  const token = normalizeToken(raw);
  const parts = token.split(".");
  if (parts.length !== 3) return failed(`could not decode token: expected 3 dot-separated segments, found ${parts.length}`);
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return failed("could not decode token: payload is not a JSON object");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return failed("could not decode token: payload is not a JSON object");
  const body = payload as Record<string, unknown>;
  const claims: Record<string, string> = {};
  for (const name of allowed) {
    if (name in body) {
      const value = body[name];
      claims[name] = (name === "iat" || name === "exp") && typeof value === "number" ? (epoch(value) ?? String(value)) : render(value);
    }
  }
  return { claims, issued_at: epoch(body["iat"]), expires_at: epoch(body["exp"]), error: null };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/jwt-display.test.ts && npm run typecheck`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/identity/jwt-display.ts tests/jwt-display.test.ts tests/support/test-jwt.ts
git commit -m "feat: decode JWTs for display without ever exposing the token" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: IdentityService — mode, token, STS identity, credential facts

**Files:**
- Create: `src/identity/identity-service.ts`, `tests/support/fake-credentials.ts`, `tests/support/fake-sts.ts`
- Modify: `src/inventory/ttl-cache.ts` (add `peek(key)`), `src/app.ts` (`AppDeps.createStsClient`, `AppDeps.identity`, wiring), `src/routes/inventory.ts` (`/api/aws/refresh` also invalidates identity), `tests/support/app-factory.ts` (inject `FakeSts`, return `sts`; helper `withFakeCredentials`)
- Test: `tests/identity-service.test.ts`, `tests/ttl-cache.test.ts` (one `peek` test)

**Interfaces:**
- Consumes: `CredentialProvider.describe()/get()` and `CredentialSpec` (Phase 2), `decodeJwtForDisplay`, `clientDefaults`/`AwsClientDefaults`/`REGION_HINT`, `awsErrorFrom`, `TtlCache`, `Clock`, `AttributedAwsCredentialIdentity` (type, `@aws-sdk/types`).
- Produces: `interface TokenSummary { claims; issued_at; expires_at; expires_in_seconds: number | null; error }`; `interface StsIdentity { account, arn, user_id, principal_type, role_name, session_name: string | null; error: string | null; hint: string | null }`; `interface CredentialFacts { key_prefix, key_id_masked, expiration, account_id: string | null; temporary: boolean | null; expires_in_seconds: number | null; source: string[]; error: string | null }`; `interface IdentityInfo` (spec §5 shape); `interface StsLike { send(command: GetCallerIdentityCommand): Promise<GetCallerIdentityCommandOutput> }`; `interface IdentityObserver { resolved(mode: string, ok: boolean): void }`; `class IdentityService { constructor(opts: { settings, env, clock, logger, credentials, createStsClient: (cfg: AwsClientDefaults) => StsLike, cache: TtlCache, readFile?: (path: string) => string, observer?: IdentityObserver }); get(force?): Promise<IdentityInfo>; peek(): IdentityInfo | null; invalidateAll(): void }`; `flavorOf(spec, tokenClaims)`; `parsePrincipal(arn)`; `decodeSources($source)`; `maskKeyId(id)`; `TtlCache.peek<T>(key): CacheEntry<T> | null` (returns the stored entry — fresh or stale — without loading); `AppDeps.createStsClient`, `AppDeps.identity`; `testApp()` returns `sts: FakeSts` and accepts `opts.credentials` (a `CredentialProvider` override built by `fakeCredentialProvider`).
- The service never throws: every section carries its own `error`; the top-level `error` is set only when the credential spec itself cannot be built.

- [ ] **Step 1: Write the fakes and failing tests**

`tests/support/fake-sts.ts`:
```ts
import type { GetCallerIdentityCommand, GetCallerIdentityCommandOutput } from "@aws-sdk/client-sts";
import type { StsLike } from "../../src/identity/identity-service.js";

/** Answers GetCallerIdentity with a fixture, or throws the configured SDK-shaped error; counts calls. */
export class FakeSts implements StsLike {
  calls = 0;
  identity: GetCallerIdentityCommandOutput = { Account: "123456789012", Arn: "arn:aws:sts::123456789012:assumed-role/aws-dash-irsa/aws-dash", UserId: "AROAEXAMPLE:aws-dash", $metadata: {} };
  failure: Error | null = null;

  fail(name: string, message: string, status?: number): void {
    this.failure = Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
  }

  async send(_command: GetCallerIdentityCommand): Promise<GetCallerIdentityCommandOutput> {
    this.calls++;
    if (this.failure) throw this.failure;
    return { ...this.identity };
  }
}
```

`tests/support/fake-credentials.ts`:
```ts
import type { AttributedAwsCredentialIdentity } from "@aws-sdk/types";
import type { AppSettings } from "../../src/config.js";
import type { EnvLookup } from "../../src/env.js";
import { resolveAuthMode, type CredentialSpec } from "../../src/identity/credential-factory.js";
import { CredentialProvider } from "../../src/identity/credential-provider.js";

export const FAKE_TEMPORARY_CREDENTIALS: AttributedAwsCredentialIdentity = {
  accessKeyId: "ASIAEXAMPLE1234567Q2K",
  secretAccessKey: "SECRET-DO-NOT-LEAK",
  sessionToken: "SESSION-TOKEN-DO-NOT-LEAK",
  expiration: new Date("2026-01-01T00:55:00.000Z"),
  accountId: "123456789012",
  $source: { CREDENTIALS_ENV_VARS_STS_WEB_ID_TOKEN: "h", CREDENTIALS_STS_ASSUME_ROLE_WEB_ID: "k" },
};

export interface FakeCredentialOptions {
  spec?: Partial<Omit<CredentialSpec, "provider">>;
  /** Resolved credentials, or an Error to throw on resolve. Defaults to FAKE_TEMPORARY_CREDENTIALS. */
  credentials?: AttributedAwsCredentialIdentity | Error;
  /** Throw this from the factory itself (simulates a misconfigured mode). */
  factoryError?: Error;
}

/** A CredentialProvider whose spec resolves fixture credentials instead of calling AWS. Counts resolves. */
export function fakeCredentialProvider(settings: AppSettings, env: EnvLookup, opts: FakeCredentialOptions = {}) {
  const counter = { resolves: 0 };
  const provider = new CredentialProvider(settings, env, (s, e) => {
    if (opts.factoryError) throw opts.factoryError;
    const selection = resolveAuthMode(s, e);
    return {
      ...selection,
      credential_type: "fake",
      role_arn: null, role_session_name: null, token_file: null, container_credentials_uri: null, profile: null,
      ...opts.spec,
      provider: async () => {
        counter.resolves++;
        const creds = opts.credentials ?? FAKE_TEMPORARY_CREDENTIALS;
        if (creds instanceof Error) throw creds;
        return creds;
      },
    };
  });
  return { provider, counter };
}
```

Add to `tests/support/app-factory.ts`: import `FakeSts` and `fakeCredentialProvider`/`FakeCredentialOptions`; extend `TestAppOptions` with `credentials?: FakeCredentialOptions` and `readFile?: (path: string) => string`; inside `testApp` create `const sts = new FakeSts();` and, when `opts.credentials` is given, `const fake = fakeCredentialProvider(settings, env, opts.credentials)` and pass `credentials: fake.provider`; pass `createStsClient: () => sts` and (when given) `readFile: opts.readFile` via a `createIdentity` override? No — keep it simple: `AppDeps` gets `identityReadFile: (path: string) => string` (default `fs.readFileSync(path, "utf8")`) which `createDeps` hands to `IdentityService`; `testApp` passes `identityReadFile: opts.readFile ?? (() => { throw Object.assign(new Error("ENOENT: no token file in tests"), { code: "ENOENT" }); })`. Return `sts` and `credentialResolves: () => fake?.counter.resolves ?? 0` from `testApp`.

`tests/identity-service.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { decodeSources, flavorOf, maskKeyId, parsePrincipal } from "../src/identity/identity-service.js";
import { testApp } from "./support/app-factory.js";
import { FAKE_TEMPORARY_CREDENTIALS } from "./support/fake-credentials.js";
import { makeJwt, TEST_SIGNATURE } from "./support/test-jwt.js";

const NOW = 1_767_225_600;
const IRSA_TOKEN = makeJwt({ iss: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", sub: "system:serviceaccount:aws-dash:aws-dash", aud: "sts.amazonaws.com", iat: NOW, exp: NOW + 3600 });
const SPIFFE_TOKEN = makeJwt({ iss: "https://oidc-discovery.apps.example.com", sub: "spiffe://example.com/ns/aws-dash-ztwim/sa/aws-dash", aud: "aws-dash", iat: NOW, exp: NOW + 300 });
const POD_TOKEN = makeJwt({ iss: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", sub: "system:serviceaccount:aws-dash:aws-dash", aud: "pods.eks.amazonaws.com", exp: NOW + 86400 });
const WEB = { AWS_REGION: "us-east-1", AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/aws/token", AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/aws-dash-irsa", AWS_ROLE_SESSION_NAME: "aws-dash" };

describe("helpers", () => {
  it("parsePrincipal classifies ARNs", () => {
    expect(parsePrincipal("arn:aws:sts::123456789012:assumed-role/aws-dash-irsa/aws-dash")).toEqual({ principal_type: "assumed-role", role_name: "aws-dash-irsa", session_name: "aws-dash" });
    expect(parsePrincipal("arn:aws:iam::123456789012:user/aws-dash")).toEqual({ principal_type: "user", role_name: null, session_name: null });
    expect(parsePrincipal("arn:aws:iam::123456789012:root")).toEqual({ principal_type: "root", role_name: null, session_name: null });
    expect(parsePrincipal("arn:aws:sts::123456789012:federated-user/bob")).toEqual({ principal_type: "federated-user", role_name: null, session_name: null });
    expect(parsePrincipal(undefined)).toEqual({ principal_type: null, role_name: null, session_name: null });
  });
  it("decodeSources maps known feature ids and keeps unknown ones raw, sorted", () => {
    expect(decodeSources({ CREDENTIALS_STS_ASSUME_ROLE_WEB_ID: "k", CREDENTIALS_ENV_VARS_STS_WEB_ID_TOKEN: "h", X: "ZZ" })).toEqual(["ZZ: (unknown)", "h: web-identity token file", "k: sts:AssumeRoleWithWebIdentity"]);
    expect(decodeSources(undefined)).toEqual([]);
  });
  it("maskKeyId keeps only the first and last four characters", () => {
    expect(maskKeyId("ASIAEXAMPLE1234567Q2K")).toBe("ASIA…7Q2K");
    expect(maskKeyId("short")).toBe("…");
    expect(maskKeyId(undefined)).toBeNull();
  });
  it("flavorOf", () => {
    const spec = (mode: string, extra: Record<string, unknown> = {}) => ({ mode, container_credentials_uri: null, ...extra }) as never;
    expect(flavorOf(spec("web-identity"), { sub: "spiffe://x/ns/a/sa/b" })).toBe("SPIFFE JWT-SVID (spiffe-helper)");
    expect(flavorOf(spec("web-identity"), { iss: "https://oidc.eks.us-east-1.amazonaws.com/id/A", sub: "system:serviceaccount:a:b" })).toBe("EKS IRSA");
    expect(flavorOf(spec("web-identity"), { sub: "system:serviceaccount:a:b" })).toBe("Kubernetes projected service-account token");
    expect(flavorOf(spec("web-identity"), {})).toBe("OIDC token file");
    expect(flavorOf(spec("pod-identity", { container_credentials_uri: "http://169.254.170.23/v1/credentials" }), {})).toBe("EKS Pod Identity");
    expect(flavorOf(spec("pod-identity", { container_credentials_uri: "/v2/credentials/abc" }), {})).toBe("ECS task role");
    expect(flavorOf(spec("static"), {})).toBe("long-lived IAM user access key");
    expect(flavorOf(spec("profile"), {})).toBe("shared config profile");
    expect(flavorOf(spec("imds"), {})).toBe("EC2 instance role (IMDS)");
  });
});

describe("IdentityService via /api/identity", () => {
  let close = async () => {};
  afterEach(() => close());

  it("assembles mode, decoded token, STS identity and credential facts (IRSA)", async () => {
    const { app, sts } = await testApp({ env: WEB, credentials: { spec: { credential_type: "fromTokenFile → sts:AssumeRoleWithWebIdentity", role_arn: WEB.AWS_ROLE_ARN, role_session_name: "aws-dash", token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE } }, readFile: () => IRSA_TOKEN });
    close = () => app.close();
    const res = await app.inject({ url: "/api/identity" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      mode: "web-identity", reason: "auto: AWS_WEB_IDENTITY_TOKEN_FILE and AWS_ROLE_ARN are set", flavor: "EKS IRSA",
      credential_type: "fromTokenFile → sts:AssumeRoleWithWebIdentity", region: "us-east-1", role_arn: WEB.AWS_ROLE_ARN, role_session_name: "aws-dash",
      token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE, container_credentials_uri: null, profile: null, error: null, fetched_at: "2026-01-01T00:00:00.000Z",
      token: { claims: { sub: "system:serviceaccount:aws-dash:aws-dash", aud: "sts.amazonaws.com" }, expires_at: "2026-01-01T01:00:00.000Z", expires_in_seconds: 3600, error: null },
      sts: { account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/aws-dash-irsa/aws-dash", user_id: "AROAEXAMPLE:aws-dash", principal_type: "assumed-role", role_name: "aws-dash-irsa", session_name: "aws-dash", error: null, hint: null },
      credentials: { key_prefix: "ASIA", key_id_masked: "ASIA…7Q2K", temporary: true, expiration: "2026-01-01T00:55:00.000Z", expires_in_seconds: 3300, account_id: "123456789012", source: ["h: web-identity token file", "k: sts:AssumeRoleWithWebIdentity"], error: null },
    });
    expect(Object.keys(body)).toEqual(["mode", "reason", "flavor", "credential_type", "region", "role_arn", "role_session_name", "token_file", "container_credentials_uri", "profile", "error", "token", "sts", "credentials", "fetched_at"]);
    expect(sts.calls).toBe(1);
    const text = res.body;
    expect(text).not.toContain(TEST_SIGNATURE);
    expect(text).not.toContain(IRSA_TOKEN);
    expect(text).not.toContain(FAKE_TEMPORARY_CREDENTIALS.secretAccessKey);
    expect(text).not.toContain(FAKE_TEMPORARY_CREDENTIALS.sessionToken);
    expect(text).not.toContain(FAKE_TEMPORARY_CREDENTIALS.accessKeyId);
  });

  it("is cached for the TTL and refreshed on demand or by POST /api/aws/refresh", async () => {
    const { app, sts } = await testApp({ env: WEB, credentials: { spec: { token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE } }, readFile: () => IRSA_TOKEN });
    close = () => app.close();
    await app.inject({ url: "/api/identity" });
    await app.inject({ url: "/api/identity" });
    expect(sts.calls).toBe(1);
    await app.inject({ url: "/api/identity?refresh=true" });
    expect(sts.calls).toBe(2);
    await app.inject({ method: "POST", url: "/api/aws/refresh" });
    await app.inject({ url: "/api/identity" });
    expect(sts.calls).toBe(3);
  });

  it("recognises SPIFFE and Pod Identity tokens", async () => {
    const spiffe = await testApp({ env: { ...WEB, AWS_ROLE_SESSION_NAME: "" }, credentials: { spec: { token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE } }, readFile: () => SPIFFE_TOKEN });
    const a = (await spiffe.app.inject({ url: "/api/identity" })).json();
    await spiffe.app.close();
    expect(a.flavor).toBe("SPIFFE JWT-SVID (spiffe-helper)");
    expect(a.token.claims.sub).toBe("spiffe://example.com/ns/aws-dash-ztwim/sa/aws-dash");
    expect(a.token.expires_in_seconds).toBe(300);
    const pod = await testApp({
      env: { AWS_REGION: "us-east-1", AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials", AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token" },
      credentials: { spec: { container_credentials_uri: "http://169.254.170.23/v1/credentials", token_file: "/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token" }, credentials: { ...FAKE_TEMPORARY_CREDENTIALS, $source: { CREDENTIALS_HTTP: "z" } } },
      readFile: () => POD_TOKEN,
    });
    close = () => pod.app.close();
    const b = (await pod.app.inject({ url: "/api/identity" })).json();
    expect(b.mode).toBe("pod-identity");
    expect(b.flavor).toBe("EKS Pod Identity");
    expect(b.token.claims.aud).toBe("pods.eks.amazonaws.com");
    expect(b.credentials.source).toEqual(["z: container credentials endpoint"]);
  });

  it("keeps sections independent: an unreadable token file and an STS failure each report only their own error", async () => {
    const { app, sts } = await testApp({ env: WEB, credentials: { spec: { token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE } }, readFile: () => { throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }); } });
    close = () => app.close();
    sts.fail("AccessDenied", "User is not authorized to perform: sts:AssumeRoleWithWebIdentity on resource: arn:aws:iam::123456789012:role/aws-dash-irsa", 403);
    const body = (await app.inject({ url: "/api/identity" })).json();
    expect(body.error).toBeNull();
    expect(body.token).toMatchObject({ claims: {}, error: "could not read /var/run/secrets/aws/token: ENOENT: no such file" });
    expect(body.sts.error).toMatch(/^AccessDenied: /);
    expect(body.sts.hint).toMatch(/trust policy rejected this identity/);
    expect(body.credentials.key_prefix).toBe("ASIA");
  });

  it("static keys: no token, AKIA prefix, non-expiring credentials", async () => {
    const { app } = await testApp({ env: { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE0000001234", AWS_SECRET_ACCESS_KEY: "s" }, credentials: { credentials: { accessKeyId: "AKIAEXAMPLE0000001234", secretAccessKey: "s", $source: { CREDENTIALS_ENV_VARS: "g" } } } });
    close = () => app.close();
    const body = (await app.inject({ url: "/api/identity" })).json();
    expect(body).toMatchObject({ mode: "static", flavor: "long-lived IAM user access key", token: null, credentials: { key_prefix: "AKIA", key_id_masked: "AKIA…1234", temporary: false, expiration: null, expires_in_seconds: null, source: ["g: environment variables"] } });
  });

  it("credential resolution failure: facts carry the error and STS is not attempted", async () => {
    const { app, sts } = await testApp({ env: WEB, credentials: { spec: { token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE }, credentials: Object.assign(new Error("Web identity token file not found"), { name: "CredentialsProviderError" }) }, readFile: () => IRSA_TOKEN });
    close = () => app.close();
    const body = (await app.inject({ url: "/api/identity" })).json();
    expect(body.credentials.error).toMatch(/^CredentialsProviderError: .*spiffe-helper sidecar or the IRSA webhook/);
    expect(body.sts).toMatchObject({ account: null, error: "not attempted: credentials could not be resolved", hint: null });
    expect(sts.calls).toBe(0);
  });

  it("a mode that cannot be built reports the top-level error and nothing else", async () => {
    const { app } = await testApp({ env: { AUTH_MODE: "web-identity" }, credentials: { factoryError: Object.assign(new Error("AUTH_MODE web-identity requires AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN"), { name: "AwsError" }) } });
    close = () => app.close();
    const body = (await app.inject({ url: "/api/identity" })).json();
    expect(body).toMatchObject({ mode: "web-identity", reason: "AUTH_MODE=web-identity", error: expect.stringContaining("requires AWS_WEB_IDENTITY_TOKEN_FILE"), token: null, sts: null, credentials: null });
  });

  it("missing region is reported in the STS section, not as a crash", async () => {
    const { app } = await testApp({ env: { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }, credentials: {} });
    close = () => app.close();
    const body = (await app.inject({ url: "/api/identity" })).json();
    expect(body.region).toBeNull();
    expect(body.sts.error).toMatch(/AWS_REGION is not set/);
    expect(body.credentials.error).toBeNull();
  });
});
```

Add to `tests/ttl-cache.test.ts`:
```ts
  it("peek returns the stored entry (even when stale) without loading, or null", async () => {
    const clock = new FakeClock();
    const cache = new TtlCache(1000, clock);
    expect(cache.peek("k")).toBeNull();
    await cache.get("k", async () => "v");
    clock.advance(5000);
    expect(cache.peek<string>("k")).toEqual({ value: "v", fetched_at: "2026-01-01T00:00:00.000Z", error: null });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/identity-service.test.ts tests/ttl-cache.test.ts`
Expected: FAIL — cannot resolve `../src/identity/identity-service.js`; `peek` is not a function.

- [ ] **Step 3: Implement**

Add to `src/inventory/ttl-cache.ts` (inside the class):
```ts
  /** The stored entry for `key` — fresh or stale — without triggering a load; null when nothing was ever stored. */
  peek<T>(key: string): CacheEntry<T> | null {
    const slot = this.slots.get(key);
    return slot ? (slot.entry as CacheEntry<T>) : null;
  }
```

`src/identity/identity-service.ts`:
```ts
import { GetCallerIdentityCommand, type GetCallerIdentityCommandOutput } from "@aws-sdk/client-sts";
import type { AttributedAwsCredentialIdentity } from "@aws-sdk/types";
import type { Logger } from "pino";
import { awsErrorFrom } from "../aws/aws-error.js";
import { clientDefaults, type AwsClientDefaults } from "../aws/client-defaults.js";
import type { Clock } from "../clock.js";
import type { AppSettings } from "../config.js";
import { blank, type EnvLookup } from "../env.js";
import type { TtlCache } from "../inventory/ttl-cache.js";
import type { CredentialProvider } from "./credential-provider.js";
import type { CredentialSpec } from "./credential-factory.js";
import { decodeJwtForDisplay, FEDERATED_CLAIMS } from "./jwt-display.js";

export interface TokenSummary {
  claims: Record<string, string>;
  issued_at: string | null;
  expires_at: string | null;
  expires_in_seconds: number | null;
  error: string | null;
}

export interface StsIdentity {
  account: string | null;
  arn: string | null;
  user_id: string | null;
  principal_type: string | null;
  role_name: string | null;
  session_name: string | null;
  error: string | null;
  hint: string | null;
}

export interface CredentialFacts {
  key_prefix: string | null;
  key_id_masked: string | null;
  temporary: boolean | null;
  expiration: string | null;
  expires_in_seconds: number | null;
  account_id: string | null;
  source: string[];
  error: string | null;
}

/** GET /api/identity — spec §5. Keys are ordered exactly as serialized. */
export interface IdentityInfo {
  mode: string;
  reason: string;
  flavor: string | null;
  credential_type: string | null;
  region: string | null;
  role_arn: string | null;
  role_session_name: string | null;
  token_file: string | null;
  container_credentials_uri: string | null;
  profile: string | null;
  error: string | null;
  token: TokenSummary | null;
  sts: StsIdentity | null;
  credentials: CredentialFacts | null;
  fetched_at: string;
}

export interface StsLike {
  send(command: GetCallerIdentityCommand): Promise<GetCallerIdentityCommandOutput>;
}

export interface IdentityObserver {
  resolved(mode: string, ok: boolean): void;
}

const SOURCE_LABELS: Record<string, string> = {
  g: "environment variables",
  h: "web-identity token file",
  k: "sts:AssumeRoleWithWebIdentity",
  i: "sts:AssumeRole",
  z: "container credentials endpoint",
  "0": "EC2 instance metadata",
  n: "shared config profile",
  o: "profile: source_profile",
  p: "profile: named provider",
  q: "profile: web-identity token",
  r: "profile: SSO",
  s: "SSO",
  v: "profile: credential_process",
  w: "credential_process",
  e: "code",
  T: "account id resolved",
};

/** `$source` is a map of feature name → one-or-two-character id; we show the ids with a human label. */
export function decodeSources(source: Record<string, string> | undefined): string[] {
  if (!source) return [];
  return Object.values(source).map((id) => `${id}: ${SOURCE_LABELS[id] ?? "(unknown)"}`).sort();
}

export function maskKeyId(id: string | undefined): string | null {
  if (id === undefined) return null;
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : "…";
}

export function parsePrincipal(arn: string | undefined): Pick<StsIdentity, "principal_type" | "role_name" | "session_name"> {
  const resource = arn?.split(":").slice(5).join(":");
  if (!resource) return { principal_type: null, role_name: null, session_name: null };
  const [kind, ...rest] = resource.split("/");
  if (kind === "assumed-role") return { principal_type: "assumed-role", role_name: rest[0] ?? null, session_name: rest.slice(1).join("/") || null };
  if (kind === "root") return { principal_type: "root", role_name: null, session_name: null };
  return { principal_type: kind ?? null, role_name: null, session_name: null };
}

export function flavorOf(spec: Pick<CredentialSpec, "mode" | "container_credentials_uri">, claims: Record<string, string>): string {
  switch (spec.mode) {
    case "web-identity": {
      if (claims["sub"]?.startsWith("spiffe://")) return "SPIFFE JWT-SVID (spiffe-helper)";
      if (claims["iss"]?.includes("oidc.eks.")) return "EKS IRSA";
      if (claims["sub"]?.startsWith("system:serviceaccount:")) return "Kubernetes projected service-account token";
      return "OIDC token file";
    }
    case "pod-identity": {
      const uri = spec.container_credentials_uri ?? "";
      if (uri.includes("169.254.170.23")) return "EKS Pod Identity";
      if (uri.startsWith("/")) return "ECS task role";
      return "container credentials endpoint";
    }
    case "static": return "long-lived IAM user access key";
    case "profile": return "shared config profile";
    case "imds": return "EC2 instance role (IMDS)";
    default: return spec.mode;
  }
}

const NOT_ATTEMPTED: StsIdentity = { account: null, arn: null, user_id: null, principal_type: null, role_name: null, session_name: null, error: "not attempted: credentials could not be resolved", hint: null };

export interface IdentityServiceOptions {
  settings: AppSettings;
  env: EnvLookup;
  clock: Clock;
  logger: Logger;
  credentials: CredentialProvider;
  createStsClient: (config: AwsClientDefaults) => StsLike;
  cache: TtlCache;
  readFile?: (path: string) => string;
  observer?: IdentityObserver;
}

/** Explains the credential chain end to end; never throws — each section carries its own error. */
export class IdentityService {
  private static readonly KEY = "identity";
  private readonly readFile: (path: string) => string;
  private readonly observer: IdentityObserver;
  private stsClient: StsLike | undefined;

  constructor(private readonly opts: IdentityServiceOptions) {
    this.readFile = opts.readFile ?? ((path) => { throw new Error(`no readFile configured for ${path}`); });
    this.observer = opts.observer ?? { resolved: () => undefined };
  }

  async get(force = false): Promise<IdentityInfo> {
    const entry = await this.opts.cache.get<IdentityInfo>(IdentityService.KEY, () => this.load(), force);
    // load() never rejects, so value is always present.
    return entry.value as IdentityInfo;
  }

  peek(): IdentityInfo | null {
    return this.opts.cache.peek<IdentityInfo>(IdentityService.KEY)?.value ?? null;
  }

  invalidateAll(): void {
    this.opts.cache.invalidateAll();
  }

  private async load(): Promise<IdentityInfo> {
    const now = this.opts.clock.now();
    const selection = this.opts.credentials.describe();
    const base = {
      mode: selection.mode, reason: selection.reason, flavor: null as string | null, credential_type: null as string | null,
      region: this.opts.settings.region ?? null, role_arn: null as string | null, role_session_name: null as string | null,
      token_file: null as string | null, container_credentials_uri: null as string | null, profile: null as string | null,
    };
    let spec: CredentialSpec;
    try {
      spec = this.opts.credentials.get();
    } catch (err) {
      return { ...base, error: awsErrorFrom(err).message, token: null, sts: null, credentials: null, fetched_at: now.toISOString() };
    }

    const tokenFile = spec.token_file ?? (spec.mode === "pod-identity" ? (blank(this.opts.env("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE")) ?? null) : null);
    const token = tokenFile ? this.readToken(tokenFile, now) : null;
    const credentials = await this.resolveCredentials(spec, now);
    const sts = credentials.error === null ? await this.callerIdentity(spec) : NOT_ATTEMPTED;

    return {
      ...base,
      flavor: flavorOf(spec, token?.claims ?? {}),
      credential_type: spec.credential_type,
      role_arn: spec.role_arn,
      role_session_name: spec.role_session_name,
      token_file: tokenFile,
      container_credentials_uri: spec.container_credentials_uri,
      profile: spec.profile,
      error: null,
      token,
      sts,
      credentials,
      fetched_at: now.toISOString(),
    };
  }

  private readToken(path: string, now: Date): TokenSummary {
    let raw: string;
    try {
      raw = this.readFile(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { claims: {}, issued_at: null, expires_at: null, expires_in_seconds: null, error: `could not read ${path}: ${message}` };
    }
    const summary = decodeJwtForDisplay(raw, FEDERATED_CLAIMS);
    return { ...summary, expires_in_seconds: secondsUntil(summary.expires_at, now) };
  }

  private async resolveCredentials(spec: CredentialSpec, now: Date): Promise<CredentialFacts> {
    try {
      const creds = (await spec.provider()) as AttributedAwsCredentialIdentity;
      this.observer.resolved(spec.mode, true);
      const expiration = creds.expiration?.toISOString() ?? null;
      return {
        key_prefix: creds.accessKeyId ? creds.accessKeyId.slice(0, 4) : null,
        key_id_masked: maskKeyId(creds.accessKeyId),
        temporary: creds.sessionToken !== undefined || creds.expiration !== undefined,
        expiration,
        expires_in_seconds: secondsUntil(expiration, now),
        account_id: creds.accountId ?? null,
        source: decodeSources(creds.$source),
        error: null,
      };
    } catch (err) {
      this.observer.resolved(spec.mode, false);
      const error = awsErrorFrom(err);
      this.opts.logger.warn({ mode: spec.mode, error: error.message }, "credential resolution failed");
      return { key_prefix: null, key_id_masked: null, temporary: null, expiration: null, expires_in_seconds: null, account_id: null, source: [], error: error.message };
    }
  }

  private async callerIdentity(spec: CredentialSpec): Promise<StsIdentity> {
    try {
      this.stsClient ??= this.opts.createStsClient(clientDefaults({
        region: this.opts.settings.region, credentials: spec.provider, logger: this.opts.logger, debug: this.opts.settings.awsDebug,
      }));
      const out = await this.stsClient.send(new GetCallerIdentityCommand({}));
      return { account: out.Account ?? null, arn: out.Arn ?? null, user_id: out.UserId ?? null, ...parsePrincipal(out.Arn), error: null, hint: null };
    } catch (err) {
      const error = awsErrorFrom(err);
      const [head, ...hint] = error.message.split(" — ");
      return { account: null, arn: null, user_id: null, principal_type: null, role_name: null, session_name: null, error: head ?? error.message, hint: hint.length ? hint.join(" — ") : null };
    }
  }
}

function secondsUntil(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  return Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
}
```
Note: `clientDefaults` throws `AwsError(REGION_HINT)` when the region is unset; the `catch` in `callerIdentity` turns it into `sts.error` (the test "missing region" expects that). The STS client is cached per service instance; it is rebuilt only if construction threw.

Modify `src/app.ts`:
- imports: `import fs from "node:fs"; import { STSClient } from "@aws-sdk/client-sts"; import { IdentityService, type StsLike } from "./identity/identity-service.js"; import type { AwsClientDefaults } from "./aws/client-defaults.js";` — **exception to "app.ts never imports the SDK"**: the STS client *constructor* is the one SDK value `app.ts` needs to build the default factory; keep it to this single import and note it in a comment.
- `AppDeps` gains `createStsClient: (config: AwsClientDefaults) => StsLike;`, `identityReadFile: (path: string) => string;`, `identity: IdentityService;`.
- `createDeps`: after `metrics`:
```ts
  const createStsClient = overrides.createStsClient ?? ((config: AwsClientDefaults) => new STSClient(config));
  const identityReadFile = overrides.identityReadFile ?? ((path: string) => fs.readFileSync(path, "utf8"));
  const identity = overrides.identity ?? new IdentityService({
    settings, env, clock, logger, credentials, createStsClient,
    cache: new TtlCache(settings.cacheTtlSeconds * 1000, clock, (err) => awsErrorFrom(err).message),
    readFile: identityReadFile,
  });
```
and return `createStsClient, identityReadFile, identity`. (Task 6 adds `observer: metrics`.)
- Routes: in `src/routes/inventory.ts` the refresh handler becomes `deps.inventory.invalidateAll(); deps.identity.invalidateAll();` (Tasks 4–5 add access-check and IMDS). Add to the same file, next to the inventory routes:
```ts
  app.get("/api/identity", (req) => deps.identity.get(isRefresh(req)));
```
(the page and partial come in Task 3; putting the JSON route here keeps this task testable — move it to `src/routes/identity.ts` in Task 3).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/identity-service.test.ts tests/ttl-cache.test.ts && npm test && npm run typecheck`
Expected: all pass (the earlier suites still pass with the extended `testApp`).

- [ ] **Step 5: Commit**

```bash
git add src/identity/identity-service.ts src/inventory/ttl-cache.ts src/app.ts src/routes/inventory.ts tests/support/fake-credentials.ts tests/support/fake-sts.ts tests/support/app-factory.ts tests/identity-service.test.ts tests/ttl-cache.test.ts
git commit -m "feat: identity service explaining mode, token, STS identity and credential facts" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Identity page, identity partial and claims table

**Files:**
- Create: `src/routes/identity.ts`, `views/pages/identity.eta`, `views/partials/identity.eta`, `views/partials/claims-table.eta`
- Modify: `src/routes/inventory.ts` (remove the temporary `/api/identity` route), `src/routes/pages.ts` (`GET /identity`), `src/app.ts` (register identity routes)
- Test: `tests/identity-pages.test.ts`

**Interfaces:**
- Consumes: `IdentityService.get(force)`, `isRefresh`, `reply.page`/`reply.partial`, `fmt.time`/`fmt.until`/`fmt.or`, `testApp` (Task 2 additions).
- Produces: `registerIdentityRoutes(app, deps)` with `GET /api/identity[?refresh=true]`, `GET /partials/identity[?refresh=1]`; `GET /identity` page with a lazy `data-identity-panel` card (the access-check and IMDS cards are added by Tasks 4 and 5); `partials/claims-table` takes `{ summary, now, fmt }`; `partials/identity` takes `{ info, now }`.
- Sections per spec §5: error banner → "How the app authenticates" → "Token presented to STS" (caption per flavor) → "What AWS returned" (STS identity, then credential facts with the AKIA/ASIA legend and decoded `$source` + caption) → "Checked … Raw tokens are never displayed · refresh".

- [ ] **Step 1: Write the failing tests**

`tests/identity-pages.test.ts`:
```ts
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "./support/app-factory.js";
import { FAKE_TEMPORARY_CREDENTIALS } from "./support/fake-credentials.js";
import { makeJwt, TEST_SIGNATURE } from "./support/test-jwt.js";

const NOW = 1_767_225_600;
const TOKEN = makeJwt({ iss: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", sub: "system:serviceaccount:aws-dash:aws-dash", aud: "sts.amazonaws.com", iat: NOW, exp: NOW + 3600 });
const WEB = { AWS_REGION: "us-east-1", AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/aws/token", AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/aws-dash-irsa", AWS_DEBUG: "true" };
const irsa = (extra = {}) => testApp({ env: WEB, credentials: { spec: { credential_type: "fromTokenFile → sts:AssumeRoleWithWebIdentity", role_arn: WEB.AWS_ROLE_ARN, token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE } }, readFile: () => TOKEN, ...extra });

describe("identity page and partial", () => {
  let close = async () => {};
  afterEach(() => close());

  it("GET /identity renders the layout with a lazy identity card", async () => {
    const { app } = await testApp();
    close = () => app.close();
    const html = (await app.inject({ url: "/identity" })).body;
    expect(html).toContain("<title>Identity · aws-dash</title>");
    expect(html).toContain('<a href="/identity" class="active">Identity</a>');
    expect(html).toContain('data-identity-panel hx-get="/partials/identity" hx-trigger="load"');
  });

  it("the partial shows every section and never the raw token, key id or secrets", async () => {
    const { app } = await irsa();
    close = () => app.close();
    const res = await app.inject({ url: "/partials/identity" });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    for (const text of ["How the app authenticates", "web-identity", "EKS IRSA", "Token presented to STS", "system:serviceaccount:aws-dash:aws-dash", "sts.amazonaws.com",
      "expires</dt><dd>2026-01-01 01:00:00 UTC (in 1h 0m)", "What AWS returned", "assumed-role/aws-dash-irsa/aws-dash", "ASIA…7Q2K", "ASIA = temporary", "h: web-identity token file",
      "internal and may change", "Raw tokens are never displayed", 'hx-get="/partials/identity?refresh=1"']) {
      expect(html, text).toContain(text);
    }
    for (const secret of [TOKEN, TEST_SIGNATURE, FAKE_TEMPORARY_CREDENTIALS.accessKeyId, FAKE_TEMPORARY_CREDENTIALS.secretAccessKey, FAKE_TEMPORARY_CREDENTIALS.sessionToken!]) {
      expect(html, secret).not.toContain(secret);
    }
  });

  it("nothing token-shaped reaches the logs, even at trace level with AWS_DEBUG on", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "trace" }, { write: (chunk: string) => { lines.push(chunk); } });
    const { app } = await irsa({ overrides: { logger } });
    close = () => app.close();
    await app.inject({ url: "/api/identity" });
    await app.inject({ url: "/partials/identity?refresh=1" });
    const joined = lines.join("\n");
    for (const secret of [TOKEN, TEST_SIGNATURE, FAKE_TEMPORARY_CREDENTIALS.accessKeyId, FAKE_TEMPORARY_CREDENTIALS.secretAccessKey, FAKE_TEMPORARY_CREDENTIALS.sessionToken!]) {
      expect(joined, secret).not.toContain(secret);
    }
  });

  it("renders section errors and the top-level error as banners with 200", async () => {
    const { app, sts } = await irsa();
    close = () => app.close();
    sts.fail("InvalidIdentityToken", "No OpenIDConnect provider found in your account for https://x", 400);
    const html = (await app.inject({ url: "/partials/identity" })).body;
    expect(html).toContain('<div class="error">InvalidIdentityToken: No OpenIDConnect provider found');
    expect(html).toContain("IAM OIDC provider URL must equal the token");
    const broken = await testApp({ env: { AUTH_MODE: "pod-identity" }, credentials: { factoryError: Object.assign(new Error("AUTH_MODE pod-identity requires AWS_CONTAINER_CREDENTIALS_FULL_URI or AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"), { name: "AwsError" }) } });
    const res = await broken.app.inject({ url: "/partials/identity" });
    await broken.app.close();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("requires AWS_CONTAINER_CREDENTIALS_FULL_URI");
    expect(res.body).not.toContain("What AWS returned");
  });

  it("static keys show the AKIA legend and no token section", async () => {
    const { app } = await testApp({ env: { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE0000001234", AWS_SECRET_ACCESS_KEY: "s" }, credentials: { credentials: { accessKeyId: "AKIAEXAMPLE0000001234", secretAccessKey: "s", $source: { CREDENTIALS_ENV_VARS: "g" } } } });
    close = () => app.close();
    const html = (await app.inject({ url: "/partials/identity" })).body;
    expect(html).toContain("AKIA = long-lived IAM user key");
    expect(html).toContain("never (long-lived)");
    expect(html).not.toContain("Token presented to STS");
    expect(html).not.toContain("AKIAEXAMPLE0000001234");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/identity-pages.test.ts`
Expected: FAIL — `/identity` and `/partials/identity` return 404.

- [ ] **Step 3: Write the templates and routes**

`views/pages/identity.eta`:
```eta
<% layout("/layout", { title: "Identity", nav: "identity" }) %>
<div class="grid">
  <section class="card" data-identity-panel hx-get="/partials/identity" hx-trigger="load">
    <h2>Workload identity</h2>
    <p class="muted">Loading…</p>
  </section>
</div>
```

`views/partials/claims-table.eta`:
```eta
<% const s = it.summary, fmt = it.fmt; %>
<% if (s.error !== null) { %>
<div class="error"><%= s.error %></div>
<% } else { %>
<dl class="kv">
<% for (const [name, value] of Object.entries(s.claims)) { %>
  <dt><%= name %></dt><dd><%= value %></dd>
<% } %>
<% if (s.expires_at !== null) { %>
  <dt>expires</dt><dd><%= fmt.time(s.expires_at) %> (<%= fmt.until(s.expires_at, it.now) %>)</dd>
<% } %>
</dl>
<% } %>
```

`views/partials/identity.eta`:
```eta
<% const i = it.info, fmt = it.fmt; %>
<% const captions = {
  "EKS IRSA": "Issued by the EKS cluster's OIDC provider for this pod's service account; STS checks its iss, sub and aud against the role's trust policy.",
  "SPIFFE JWT-SVID (spiffe-helper)": "Issued by SPIRE (Zero Trust Workload Identity Manager) and written to a file by spiffe-helper; STS trusts it through an IAM OIDC provider that points at the SPIRE discovery endpoint.",
  "Kubernetes projected service-account token": "Issued by the cluster's own service-account issuer, which must be publicly discoverable for STS to validate it.",
  "EKS Pod Identity": "Issued by EKS for Pod Identity; the SDK exchanges it with the eks-pod-identity-agent on the node, never with STS directly.",
}; %>
<% const legend = i.credentials && i.credentials.key_prefix === "ASIA" ? "ASIA = temporary" : i.credentials && i.credentials.key_prefix === "AKIA" ? "AKIA = long-lived IAM user key" : null; %>
<h2>Workload identity</h2>
<% if (i.error !== null) { %>
<div class="error"><%= i.error %></div>
<% } %>
<h3>How the app authenticates</h3>
<dl class="kv">
  <dt>Auth mode</dt><dd><%= i.mode %></dd>
  <dt>Why</dt><dd><%= i.reason %></dd>
  <dt>Flavor</dt><dd><%= fmt.or(i.flavor) %></dd>
  <dt>Credential</dt><dd><%= fmt.or(i.credential_type) %></dd>
  <dt>Region</dt><dd><%= fmt.or(i.region, "not set (AWS_REGION)") %></dd>
  <dt>Role ARN</dt><dd><%= fmt.or(i.role_arn) %></dd>
  <dt>Session name</dt><dd><%= fmt.or(i.role_session_name) %></dd>
  <dt>Token file</dt><dd><%= fmt.or(i.token_file) %></dd>
  <dt>Credentials URI</dt><dd><%= fmt.or(i.container_credentials_uri) %></dd>
  <dt>Profile</dt><dd><%= fmt.or(i.profile) %></dd>
</dl>
<% if (i.token !== null) { %>
<h3>Token presented to STS</h3>
<p class="muted"><%= captions[i.flavor] || "Presented to STS for AssumeRoleWithWebIdentity; STS matches iss, sub and aud against the role's trust policy." %></p>
<%~ include("/partials/claims-table", { summary: i.token, now: it.now, fmt }) %>
<% } %>
<% if (i.sts !== null || i.credentials !== null) { %>
<h3>What AWS returned</h3>
<% if (i.sts !== null) { %>
<% if (i.sts.error !== null) { %>
<div class="error"><%= i.sts.error %><% if (i.sts.hint !== null) { %> — <%= i.sts.hint %><% } %></div>
<% } else { %>
<dl class="kv">
  <dt>Account</dt><dd><%= fmt.or(i.sts.account) %></dd>
  <dt>Caller ARN</dt><dd><%= fmt.or(i.sts.arn) %></dd>
  <dt>User ID</dt><dd><%= fmt.or(i.sts.user_id) %></dd>
  <dt>Principal</dt><dd><%= fmt.or(i.sts.principal_type) %><% if (i.sts.role_name) { %> · role <%= i.sts.role_name %><% } %><% if (i.sts.session_name) { %> · session <%= i.sts.session_name %><% } %></dd>
</dl>
<% } %>
<% } %>
<% if (i.credentials !== null) { %>
<% if (i.credentials.error !== null) { %>
<div class="error"><%= i.credentials.error %></div>
<% } else { %>
<dl class="kv">
  <dt>Access key</dt><dd><%= fmt.or(i.credentials.key_id_masked) %><% if (legend) { %> (<%= legend %>)<% } %></dd>
  <dt>Temporary</dt><dd><%= i.credentials.temporary === null ? "—" : i.credentials.temporary ? "yes" : "no" %></dd>
  <dt>Expires</dt><dd><% if (i.credentials.expiration !== null) { %><%= fmt.time(i.credentials.expiration) %> (<%= fmt.until(i.credentials.expiration, it.now) %>)<% } else { %>never (long-lived)<% } %></dd>
  <dt>Account</dt><dd><%= fmt.or(i.credentials.account_id) %></dd>
  <dt>SDK source</dt><dd><%= i.credentials.source.length ? i.credentials.source.join("; ") : "—" %></dd>
</dl>
<p class="muted">SDK source ids are internal and may change between SDK releases.</p>
<% } %>
<% } %>
<% } %>
<p class="muted">Checked <%= fmt.time(i.fetched_at) %>. Raw tokens are never displayed. · <a href="#" hx-get="/partials/identity?refresh=1" hx-target="closest [data-identity-panel]">refresh</a></p>
```

`src/routes/identity.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.js";
import { isRefresh } from "./inventory.js";

export function registerIdentityRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/api/identity", (req) => deps.identity.get(isRefresh(req)));
  app.get("/partials/identity", async (req, reply) =>
    reply.partial("partials/identity", { info: await deps.identity.get(isRefresh(req)), now: deps.clock.now().toISOString() }));
}
```
Remove the temporary `/api/identity` route from `src/routes/inventory.ts`. In `src/routes/pages.ts` add `app.get("/identity", (_req, reply) => reply.page("pages/identity", {}));`. In `src/app.ts` import and call `registerIdentityRoutes(app, deps);` after `registerInventoryRoutes`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/identity-pages.test.ts tests/identity-service.test.ts && npm test && npm run typecheck`
Expected: all pass. Manual: `npm run dev` → http://localhost:8080/identity shows the card with the "no credentials found" hint when nothing is configured.

- [ ] **Step 5: Commit**

```bash
git add src/routes/identity.ts src/routes/inventory.ts src/routes/pages.ts src/app.ts views/pages/identity.eta views/partials/identity.eta views/partials/claims-table.eta tests/identity-pages.test.ts
git commit -m "feat: Identity tab explaining the credential chain without exposing tokens" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Access-check matrix

**Files:**
- Create: `src/identity/access-check-actions.ts`, `src/identity/access-check.ts`, `views/partials/access-check.eta`, `tests/support/fake-access-clients.ts`
- Modify: `src/config.ts` (`accessCheckActions`), `src/app.ts` (`AppDeps.createAccessCheckClients`, `AppDeps.accessCheck`), `src/routes/identity.ts` (routes), `src/routes/inventory.ts` (refresh invalidates), `views/pages/identity.eta` (second card), `public/css/site.css` (`.badge.muted`), `tests/support/app-factory.ts` (inject `FakeAccessCheckClients`, return `accessClients`)
- Test: `tests/access-check.test.ts`, `tests/config.test.ts` (2 cases)

**Interfaces:**
- Consumes: `clientDefaults`, `awsErrorFrom`, `CredentialProvider`, `TtlCache`, `parsePrincipal` (Task 2), SDK commands (`GetCallerIdentityCommand`, `ListAccountAliasesCommand`, `GetRoleCommand`, `DescribeRegionsCommand`, `DescribeInstancesCommand`, `DescribeVpcsCommand`, `DescribeSubnetsCommand`, `DescribeSecurityGroupsCommand`, `ListBucketsCommand`, `ListClustersCommand`, `DescribeRepositoriesCommand`) — only inside `access-check.ts`.
- Produces: `ACCESS_CHECK_ACTION_NAMES` (ordered, 11 names), `type AccessCheckAction`; `AppSettings.accessCheckActions: readonly AccessCheckAction[] | undefined`; `type AccessCheckResult = "allowed" | "denied" | "credential" | "error" | "skipped"`; `interface AccessCheckRow { action; service; result; code: string | null; message: string | null; duration_ms: number }`; `interface AccessCheckReport { enabled: boolean; fetched_at: string | null; principal_arn: string | null; error: string | null; rows: AccessCheckRow[] }`; `interface SendLike { send(command: unknown): Promise<unknown> }`; `interface AccessCheckClients { sts; iam; ec2; s3; eks; ecr: SendLike }`; `interface AccessCheckObserver { checked(rows: AccessCheckRow[]): void }`; `classify(err): { result, code, message }`; `class AccessCheckService { constructor(opts: { settings, clock, logger, credentials, createClients: (cfg: AwsClientDefaults) => AccessCheckClients, cache: TtlCache, observer? }); run(force?): Promise<AccessCheckReport>; peek(); invalidateAll() }`; routes `GET /api/access-check[?refresh=true]`, `GET /partials/access-check[?refresh=1]`; `testApp()` returns `accessClients: FakeAccessCheckClients`.
- `POST /api/aws/refresh` now also calls `deps.accessCheck.invalidateAll()`.

- [ ] **Step 1: Write the fake clients and failing tests**

`tests/support/fake-access-clients.ts`:
```ts
import { setImmediate as yieldNow } from "node:timers/promises";
import type { AccessCheckClients, SendLike } from "../../src/identity/access-check.js";
import type { FakeSts } from "./fake-sts.js";

type Answer = () => unknown;

/** One fake per service; answers `{}` by default, or the configured failure, keyed by the command class name. Tracks concurrency. */
export class FakeAccessCheckClients implements AccessCheckClients {
  readonly calls: Record<string, number> = {};
  readonly inputs: Record<string, unknown> = {};
  inFlight = 0;
  maxInFlight = 0;
  private readonly answers = new Map<string, Answer>();

  constructor(readonly sts: SendLike & { calls: number }) {}

  readonly iam = this.service();
  readonly ec2 = this.service();
  readonly s3 = this.service();
  readonly eks = this.service();
  readonly ecr = this.service();

  deny(commandName: string): void {
    this.answers.set(commandName, () => { throw Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }); });
  }

  fail(commandName: string, name: string, message: string, status?: number): void {
    this.answers.set(commandName, () => { throw Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } }); });
  }

  private service(): SendLike {
    return {
      send: async (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        this.calls[name] = (this.calls[name] ?? 0) + 1;
        this.inputs[name] = (command as { input?: unknown }).input;
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
          await yieldNow();
          const answer = this.answers.get(name);
          return answer ? answer() : {};
        } finally {
          this.inFlight--;
        }
      },
    };
  }
}
```
(`FakeSts` from Task 2 is passed as `sts`; `testApp` constructs `new FakeAccessCheckClients(sts)` and passes `createAccessCheckClients: () => accessClients`.)

`tests/access-check.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { ACCESS_CHECK_ACTION_NAMES } from "../src/identity/access-check-actions.js";
import { classify } from "../src/identity/access-check.js";
import { testApp } from "./support/app-factory.js";

const ENV = { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" };
const sdkError = (name: string, message: string, status?: number) => Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });

describe("classify", () => {
  it.each([
    [sdkError("AccessDenied", "x", 403), "denied"],
    [sdkError("UnauthorizedOperation", "x", 403), "denied"],
    [sdkError("SomethingElse", "x", 403), "denied"],
    [sdkError("ExpiredTokenException", "x", 400), "credential"],
    [sdkError("InvalidClientTokenId", "x", 403), "credential"],
    [Object.assign(new Error("no creds"), { name: "CredentialsProviderError" }), "credential"],
    [sdkError("ThrottlingException", "x", 400), "error"],
    [Object.assign(new Error("ECONNREFUSED"), { name: "Error", code: "ECONNREFUSED" }), "error"],
  ])("%o → %s", (err, result) => {
    expect(classify(err).result).toBe(result);
  });
  it("records the error name as code and the first line as message", () => {
    expect(classify(sdkError("AccessDenied", "Access Denied\nmore", 403))).toEqual({ result: "denied", code: "AccessDenied", message: "Access Denied" });
  });
});

describe("access-check matrix", () => {
  let close = async () => {};
  afterEach(() => close());

  it("runs every action with the gate first, GetRole against the assumed role, concurrency ≤ 4", async () => {
    const { app, accessClients, sts } = await testApp({ env: ENV, credentials: {} });
    close = () => app.close();
    const res = await app.inject({ url: "/api/access-check" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ enabled: true, fetched_at: "2026-01-01T00:00:00.000Z", principal_arn: "arn:aws:sts::123456789012:assumed-role/aws-dash-irsa/aws-dash", error: null });
    expect(body.rows.map((r: { action: string }) => r.action)).toEqual([...ACCESS_CHECK_ACTION_NAMES]);
    expect(body.rows.every((r: { result: string }) => r.result === "allowed")).toBe(true);
    expect(body.rows[0]).toMatchObject({ action: "sts:GetCallerIdentity", service: "sts", code: null, message: null });
    expect(typeof body.rows[0].duration_ms).toBe("number");
    expect(sts.calls).toBe(1);
    expect(accessClients.inputs["GetRoleCommand"]).toEqual({ RoleName: "aws-dash-irsa" });
    expect(accessClients.inputs["DescribeInstancesCommand"]).toEqual({ MaxResults: 5 });
    expect(accessClients.inputs["DescribeRegionsCommand"]).toEqual({ RegionNames: ["us-east-1"] });
    expect(accessClients.inputs["ListBucketsCommand"]).toEqual({ MaxBuckets: 1 });
    expect(accessClients.inputs["ListClustersCommand"]).toEqual({ maxResults: 1 });
    expect(accessClients.inputs["DescribeRepositoriesCommand"]).toEqual({ maxResults: 1 });
    expect(accessClients.inputs["ListAccountAliasesCommand"]).toEqual({ MaxItems: 1 });
    expect(accessClients.maxInFlight).toBeLessThanOrEqual(4);
    expect(accessClients.maxInFlight).toBeGreaterThan(1);
  });

  it("classifies denied actions and keeps going", async () => {
    const { app, accessClients } = await testApp({ env: ENV, credentials: {} });
    close = () => app.close();
    accessClients.deny("DescribeInstancesCommand");
    accessClients.fail("ListClustersCommand", "ThrottlingException", "Rate exceeded", 400);
    const rows = (await app.inject({ url: "/api/access-check" })).json().rows;
    const byAction = Object.fromEntries(rows.map((r: { action: string }) => [r.action, r]));
    expect(byAction["ec2:DescribeInstances"]).toMatchObject({ result: "denied", code: "AccessDenied", message: "Access Denied" });
    expect(byAction["eks:ListClusters"]).toMatchObject({ result: "error", code: "ThrottlingException" });
    expect(byAction["ec2:DescribeVpcs"].result).toBe("allowed");
  });

  it("skips everything when the gate fails as a credential error", async () => {
    const { app, accessClients, sts } = await testApp({ env: ENV, credentials: {} });
    close = () => app.close();
    sts.fail("ExpiredTokenException", "The security token included in the request is expired", 400);
    const rows = (await app.inject({ url: "/api/access-check" })).json().rows;
    expect(rows[0]).toMatchObject({ action: "sts:GetCallerIdentity", result: "credential", code: "ExpiredTokenException" });
    expect(rows.slice(1).every((r: { result: string; message: string }) => r.result === "skipped" && r.message === "skipped: sts:GetCallerIdentity did not succeed")).toBe(true);
    expect(Object.keys(accessClients.calls)).toEqual([]);
  });

  it("skips iam:GetRole when the principal is not an assumed role", async () => {
    const { app, sts } = await testApp({ env: ENV, credentials: {} });
    close = () => app.close();
    sts.identity = { Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/aws-dash", UserId: "AIDA1", $metadata: {} };
    const rows = (await app.inject({ url: "/api/access-check" })).json().rows;
    expect(rows.at(-1)).toMatchObject({ action: "iam:GetRole", result: "skipped", message: "skipped: the caller is not an assumed role" });
  });

  it("ACCESS_CHECK_ACTIONS narrows the matrix but always keeps the gate", async () => {
    const { app, accessClients } = await testApp({ env: { ...ENV, ACCESS_CHECK_ACTIONS: "ec2:DescribeInstances, s3:ListAllMyBuckets" }, credentials: {} });
    close = () => app.close();
    const rows = (await app.inject({ url: "/api/access-check" })).json().rows;
    expect(rows.map((r: { action: string }) => r.action)).toEqual(["sts:GetCallerIdentity", "ec2:DescribeInstances", "s3:ListAllMyBuckets"]);
    expect(Object.keys(accessClients.calls).sort()).toEqual(["DescribeInstancesCommand", "ListBucketsCommand"]);
  });

  it("is cached, refreshable, and invalidated by POST /api/aws/refresh", async () => {
    const { app, sts } = await testApp({ env: ENV, credentials: {} });
    close = () => app.close();
    await app.inject({ url: "/api/access-check" });
    await app.inject({ url: "/api/access-check" });
    expect(sts.calls).toBe(1);
    await app.inject({ url: "/api/access-check?refresh=true" });
    expect(sts.calls).toBe(2);
    await app.inject({ method: "POST", url: "/api/aws/refresh" });
    await app.inject({ url: "/api/access-check" });
    expect(sts.calls).toBe(3);
  });

  it("reports disabled, missing region and unbuildable credentials without calling anything", async () => {
    const off = await testApp({ env: { ...ENV, ACCESS_CHECK_ENABLED: "false" }, credentials: {} });
    expect((await off.app.inject({ url: "/api/access-check" })).json()).toEqual({ enabled: false, fetched_at: null, principal_arn: null, error: null, rows: [] });
    await off.app.close();
    const noRegion = await testApp({ env: { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }, credentials: {} });
    const nr = (await noRegion.app.inject({ url: "/api/access-check" })).json();
    await noRegion.app.close();
    expect(nr.error).toMatch(/AWS_REGION is not set/);
    expect(nr.rows).toEqual([]);
    const { app, sts } = await testApp({ env: { AUTH_MODE: "web-identity", AWS_REGION: "us-east-1" }, credentials: { factoryError: Object.assign(new Error("AUTH_MODE web-identity requires AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN"), { name: "AwsError" }) } });
    close = () => app.close();
    const body = (await app.inject({ url: "/api/access-check" })).json();
    expect(body.error).toMatch(/requires AWS_WEB_IDENTITY_TOKEN_FILE/);
    expect(sts.calls).toBe(0);
  });

  it("renders the matrix partial with result badges and a re-run link, and the page has the card", async () => {
    const { app, accessClients } = await testApp({ env: ENV, credentials: {} });
    close = () => app.close();
    accessClients.deny("ListBucketsCommand");
    const html = (await app.inject({ url: "/partials/access-check" })).body;
    expect(html).toContain("<h2>Access check</h2>");
    expect(html).toContain('<span class="badge ok">allowed</span>');
    expect(html).toContain('<span class="badge bad">denied</span>');
    expect(html).toContain("s3:ListAllMyBuckets");
    expect(html).toContain('hx-get="/partials/access-check?refresh=1"');
    expect((await app.inject({ url: "/identity" })).body).toContain('data-access-check-panel hx-get="/partials/access-check" hx-trigger="load"');
    const off = await testApp({ env: { ACCESS_CHECK_ENABLED: "false" } });
    expect((await off.app.inject({ url: "/partials/access-check" })).body).toContain("Disabled (ACCESS_CHECK_ENABLED=false)");
    await off.app.close();
  });
});
```

Add to `tests/config.test.ts` (inside the `settingsFromEnv` describe): a parse case `expect(settingsFromEnv(env({ ACCESS_CHECK_ACTIONS: " ec2:DescribeVpcs ,s3:ListAllMyBuckets" })).accessCheckActions).toEqual(["ec2:DescribeVpcs", "s3:ListAllMyBuckets"]);` plus `expect(settingsFromEnv(env({})).accessCheckActions).toBeUndefined();`, and an `it.each` row `[{ ACCESS_CHECK_ACTIONS: "ec2:DescribeVpcs,ec2:Nope" }, "ACCESS_CHECK_ACTIONS must be a comma-separated subset of sts:GetCallerIdentity, iam:ListAccountAliases, ec2:DescribeRegions, ec2:DescribeInstances, ec2:DescribeVpcs, ec2:DescribeSubnets, ec2:DescribeSecurityGroups, s3:ListAllMyBuckets, eks:ListClusters, ecr:DescribeRepositories, iam:GetRole, got 'ec2:Nope'"]`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/access-check.test.ts tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/identity/access-check-actions.js`.

- [ ] **Step 3: Implement**

`src/identity/access-check-actions.ts`:
```ts
/** The read-only actions the Identity tab probes, in display order. Kept SDK-free so config.ts can import it. */
export const ACCESS_CHECK_ACTION_NAMES = [
  "sts:GetCallerIdentity",
  "iam:ListAccountAliases",
  "ec2:DescribeRegions",
  "ec2:DescribeInstances",
  "ec2:DescribeVpcs",
  "ec2:DescribeSubnets",
  "ec2:DescribeSecurityGroups",
  "s3:ListAllMyBuckets",
  "eks:ListClusters",
  "ecr:DescribeRepositories",
  "iam:GetRole",
] as const;

export type AccessCheckAction = (typeof ACCESS_CHECK_ACTION_NAMES)[number];

export function isAccessCheckAction(value: string): value is AccessCheckAction {
  return (ACCESS_CHECK_ACTION_NAMES as readonly string[]).includes(value);
}
```

`src/config.ts`: import `{ ACCESS_CHECK_ACTION_NAMES, isAccessCheckAction, type AccessCheckAction } from "./identity/access-check-actions.js"`; add `readonly accessCheckActions: readonly AccessCheckAction[] | undefined;` to `AppSettings` (after `accessCheckEnabled`) and in `settingsFromEnv`: `accessCheckActions: actionList("ACCESS_CHECK_ACTIONS", env("ACCESS_CHECK_ACTIONS")),` with
```ts
function actionList(name: string, value: string | undefined): readonly AccessCheckAction[] | undefined {
  const v = blank(value);
  if (v === undefined) return undefined;
  const names = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const bad = names.find((n) => !isAccessCheckAction(n));
  if (bad !== undefined) throw invalid(name, bad, `a comma-separated subset of ${ACCESS_CHECK_ACTION_NAMES.join(", ")}`);
  return names.filter(isAccessCheckAction);
}
```

`src/identity/access-check.ts`:
```ts
import { DescribeInstancesCommand, DescribeRegionsCommand, DescribeSecurityGroupsCommand, DescribeSubnetsCommand, DescribeVpcsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DescribeRepositoriesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { EKSClient, ListClustersCommand } from "@aws-sdk/client-eks";
import { GetRoleCommand, IAMClient, ListAccountAliasesCommand } from "@aws-sdk/client-iam";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient, type GetCallerIdentityCommandOutput } from "@aws-sdk/client-sts";
import type { Logger } from "pino";
import { awsErrorFrom, firstLine } from "../aws/aws-error.js";
import { clientDefaults, type AwsClientDefaults } from "../aws/client-defaults.js";
import type { Clock } from "../clock.js";
import type { AppSettings } from "../config.js";
import type { TtlCache } from "../inventory/ttl-cache.js";
import { ACCESS_CHECK_ACTION_NAMES, type AccessCheckAction } from "./access-check-actions.js";
import type { CredentialProvider } from "./credential-provider.js";
import { parsePrincipal } from "./identity-service.js";

export type AccessCheckResult = "allowed" | "denied" | "credential" | "error" | "skipped";

export interface AccessCheckRow {
  action: AccessCheckAction;
  service: string;
  result: AccessCheckResult;
  code: string | null;
  message: string | null;
  duration_ms: number;
}

export interface AccessCheckReport {
  enabled: boolean;
  fetched_at: string | null;
  principal_arn: string | null;
  error: string | null;
  rows: AccessCheckRow[];
}

export interface SendLike {
  send(command: unknown): Promise<unknown>;
}

export interface AccessCheckClients {
  sts: SendLike;
  iam: SendLike;
  ec2: SendLike;
  s3: SendLike;
  eks: SendLike;
  ecr: SendLike;
}

export interface AccessCheckObserver {
  checked(rows: AccessCheckRow[]): void;
}

const DENIED = new Set(["AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "UnauthorizedAccess", "AuthorizationError"]);
const CREDENTIAL = new Set(["CredentialsProviderError", "ProviderError", "ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId", "InvalidIdentityToken", "UnrecognizedClientException", "AuthFailure"]);

export function classify(err: unknown): { result: AccessCheckResult; code: string | null; message: string | null } {
  const e = (typeof err === "object" && err !== null ? err : {}) as { name?: unknown; message?: unknown; $metadata?: { httpStatusCode?: number } };
  const name = typeof e.name === "string" && e.name ? e.name : "Error";
  const message = firstLine(typeof e.message === "string" ? e.message : String(err));
  const status = e.$metadata?.httpStatusCode;
  if (CREDENTIAL.has(name)) return { result: "credential", code: name, message };
  if (DENIED.has(name) || status === 403) return { result: "denied", code: name, message };
  return { result: "error", code: name, message };
}

interface Context {
  region: string;
  roleName: string | null;
}

interface ActionDef {
  action: AccessCheckAction;
  service: keyof AccessCheckClients;
  /** Returns the command to send, or a skip reason. */
  command: (ctx: Context) => { send: unknown } | { skip: string };
}

const ACTIONS: readonly ActionDef[] = [
  { action: "sts:GetCallerIdentity", service: "sts", command: () => ({ send: new GetCallerIdentityCommand({}) }) },
  { action: "iam:ListAccountAliases", service: "iam", command: () => ({ send: new ListAccountAliasesCommand({ MaxItems: 1 }) }) },
  { action: "ec2:DescribeRegions", service: "ec2", command: (c) => ({ send: new DescribeRegionsCommand({ RegionNames: [c.region] }) }) },
  { action: "ec2:DescribeInstances", service: "ec2", command: () => ({ send: new DescribeInstancesCommand({ MaxResults: 5 }) }) },
  { action: "ec2:DescribeVpcs", service: "ec2", command: () => ({ send: new DescribeVpcsCommand({ MaxResults: 5 }) }) },
  { action: "ec2:DescribeSubnets", service: "ec2", command: () => ({ send: new DescribeSubnetsCommand({ MaxResults: 5 }) }) },
  { action: "ec2:DescribeSecurityGroups", service: "ec2", command: () => ({ send: new DescribeSecurityGroupsCommand({ MaxResults: 5 }) }) },
  { action: "s3:ListAllMyBuckets", service: "s3", command: () => ({ send: new ListBucketsCommand({ MaxBuckets: 1 }) }) },
  { action: "eks:ListClusters", service: "eks", command: () => ({ send: new ListClustersCommand({ maxResults: 1 }) }) },
  { action: "ecr:DescribeRepositories", service: "ecr", command: () => ({ send: new DescribeRepositoriesCommand({ maxResults: 1 }) }) },
  { action: "iam:GetRole", service: "iam", command: (c) => (c.roleName ? { send: new GetRoleCommand({ RoleName: c.roleName }) } : { skip: "skipped: the caller is not an assumed role" }) },
];

export function createAccessCheckClients(config: AwsClientDefaults): AccessCheckClients {
  return { sts: new STSClient(config), iam: new IAMClient(config), ec2: new EC2Client(config), s3: new S3Client(config), eks: new EKSClient(config), ecr: new ECRClient(config) };
}

export interface AccessCheckServiceOptions {
  settings: AppSettings;
  clock: Clock;
  logger: Logger;
  credentials: CredentialProvider;
  createClients: (config: AwsClientDefaults) => AccessCheckClients;
  cache: TtlCache;
  observer?: AccessCheckObserver;
  concurrency?: number;
}

/** Probes each read-only action once; the STS gate runs first and a failed gate skips the rest. Never throws. */
export class AccessCheckService {
  private static readonly KEY = "access-check";
  private readonly observer: AccessCheckObserver;
  private readonly concurrency: number;
  private clients: AccessCheckClients | undefined;

  constructor(private readonly opts: AccessCheckServiceOptions) {
    this.observer = opts.observer ?? { checked: () => undefined };
    this.concurrency = opts.concurrency ?? 4;
  }

  async run(force = false): Promise<AccessCheckReport> {
    if (!this.opts.settings.accessCheckEnabled) return { enabled: false, fetched_at: null, principal_arn: null, error: null, rows: [] };
    const entry = await this.opts.cache.get<AccessCheckReport>(AccessCheckService.KEY, () => this.load(), force);
    return entry.value as AccessCheckReport;
  }

  peek(): AccessCheckReport | null {
    return this.opts.cache.peek<AccessCheckReport>(AccessCheckService.KEY)?.value ?? null;
  }

  invalidateAll(): void {
    this.opts.cache.invalidateAll();
  }

  private selected(): readonly ActionDef[] {
    const wanted = this.opts.settings.accessCheckActions;
    const chosen = wanted === undefined ? ACTIONS : ACTIONS.filter((a) => a.action === "sts:GetCallerIdentity" || wanted.includes(a.action));
    return [...chosen].sort((a, b) => ACCESS_CHECK_ACTION_NAMES.indexOf(a.action) - ACCESS_CHECK_ACTION_NAMES.indexOf(b.action));
  }

  private getClients(): AccessCheckClients {
    if (this.clients === undefined) {
      const config = clientDefaults({
        region: this.opts.settings.region, credentials: this.opts.credentials.provider(), logger: this.opts.logger, debug: this.opts.settings.awsDebug,
      });
      this.clients = this.opts.createClients(config);
    }
    return this.clients;
  }

  private async load(): Promise<AccessCheckReport> {
    const fetchedAt = this.opts.clock.now().toISOString();
    let clients: AccessCheckClients;
    try {
      clients = this.getClients();
    } catch (err) {
      return { enabled: true, fetched_at: fetchedAt, principal_arn: null, error: awsErrorFrom(err).message, rows: [] };
    }
    const region = this.opts.settings.region ?? "";
    const [gateDef, ...rest] = this.selected();
    const gate = await this.probe(clients, gateDef as ActionDef, { region, roleName: null });
    let principalArn: string | null = null;
    let roleName: string | null = null;
    if (gate.row.result === "allowed") {
      const out = gate.output as GetCallerIdentityCommandOutput | undefined;
      principalArn = out?.Arn ?? null;
      roleName = parsePrincipal(out?.Arn).role_name;
    }
    const rows: AccessCheckRow[] = [gate.row];
    if (gate.row.result !== "allowed") {
      for (const def of rest) rows.push({ action: def.action, service: def.service, result: "skipped", code: null, message: "skipped: sts:GetCallerIdentity did not succeed", duration_ms: 0 });
    } else {
      const results = await this.pool(rest.map((def) => () => this.probe(clients, def, { region, roleName })));
      for (const r of results) rows.push(r.row);
    }
    this.observer.checked(rows);
    this.opts.logger.info({ allowed: rows.filter((r) => r.result === "allowed").length, total: rows.length }, "access check complete");
    return { enabled: true, fetched_at: fetchedAt, principal_arn: principalArn, error: null, rows };
  }

  private async probe(clients: AccessCheckClients, def: ActionDef, ctx: Context): Promise<{ row: AccessCheckRow; output?: unknown }> {
    const built = def.command(ctx);
    if ("skip" in built) return { row: { action: def.action, service: def.service, result: "skipped", code: null, message: built.skip, duration_ms: 0 } };
    const started = performance.now();
    try {
      const output = await clients[def.service].send(built.send);
      return { row: { action: def.action, service: def.service, result: "allowed", code: null, message: null, duration_ms: Math.round(performance.now() - started) }, output };
    } catch (err) {
      const c = classify(err);
      return { row: { action: def.action, service: def.service, ...c, duration_ms: Math.round(performance.now() - started) } };
    }
  }

  /** Runs tasks with bounded concurrency, preserving order. */
  private async pool<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await (tasks[i] as () => Promise<T>)();
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, tasks.length) }, worker));
    return results;
  }
}
```

`views/partials/access-check.eta` (data: `it.report`, `it.now`):
```eta
<% const r = it.report, fmt = it.fmt; const badge = { allowed: "ok", denied: "bad", credential: "bad", error: "warn", skipped: "muted" }; %>
<h2>Access check</h2>
<% if (!r.enabled) { %>
<p class="muted">Disabled (ACCESS_CHECK_ENABLED=false).</p>
<% } else { %>
<p class="muted">One minimal read-only call per action, run as <%= fmt.or(r.principal_arn, "the current identity") %>. Detach the read-only policy and re-run to watch the rows flip.</p>
<% if (r.error !== null) { %>
<div class="error"><%= r.error %></div>
<% } %>
<% if (r.rows.length > 0) { %>
<div class="table-wrap"><table class="matrix">
<thead><tr><th>Action</th><th>Service</th><th>Result</th><th>Code</th><th>Message</th><th>ms</th></tr></thead>
<tbody>
<% for (const row of r.rows) { %>
<tr><td><%= row.action %></td><td><%= row.service %></td><td><span class="badge <%= badge[row.result] %>"><%= row.result %></span></td><td><%= fmt.or(row.code) %></td><td><%= fmt.or(row.message) %></td><td><%= row.duration_ms %></td></tr>
<% } %>
</tbody></table></div>
<% } %>
<p class="muted">Checked <%= fmt.time(r.fetched_at) %> · <a href="#" hx-get="/partials/access-check?refresh=1" hx-target="closest [data-access-check-panel]">re-run</a></p>
<% } %>
```
Add to `public/css/site.css` after the `.badge.warn` rule: `.badge.muted { background: #eceef1; color: var(--muted); }`.

Add to `views/pages/identity.eta` after the identity section:
```eta
  <section class="card" data-access-check-panel hx-get="/partials/access-check" hx-trigger="load">
    <h2>Access check</h2>
    <p class="muted">Loading…</p>
  </section>
```

Routes — add to `src/routes/identity.ts`:
```ts
  app.get("/api/access-check", (req) => deps.accessCheck.run(isRefresh(req)));
  app.get("/partials/access-check", async (req, reply) =>
    reply.partial("partials/access-check", { report: await deps.accessCheck.run(isRefresh(req)), now: deps.clock.now().toISOString() }));
```
and in `src/routes/inventory.ts` the refresh handler also calls `deps.accessCheck.invalidateAll()`.

`src/app.ts`: import `{ AccessCheckService, createAccessCheckClients, type AccessCheckClients } from "./identity/access-check.js"`; `AppDeps` gains `createAccessCheckClients: (config: AwsClientDefaults) => AccessCheckClients;` and `accessCheck: AccessCheckService;`; in `createDeps` after `identity`:
```ts
  const createAccessClients = overrides.createAccessCheckClients ?? createAccessCheckClients;
  const accessCheck = overrides.accessCheck ?? new AccessCheckService({
    settings, clock, logger, credentials, createClients: createAccessClients,
    cache: new TtlCache(settings.cacheTtlSeconds * 1000, clock, (err) => awsErrorFrom(err).message),
  });
```
and return `createAccessCheckClients: createAccessClients, accessCheck`. `tests/support/app-factory.ts`: `const accessClients = new FakeAccessCheckClients(sts);` passed as `createAccessCheckClients: () => accessClients`; returned as `accessClients`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/access-check.test.ts tests/config.test.ts && npm test && npm run typecheck`
Expected: all pass; no test reaches the network (every client is the fake).

- [ ] **Step 5: Commit**

```bash
git add src/identity/access-check-actions.ts src/identity/access-check.ts src/config.ts src/app.ts src/routes/identity.ts src/routes/inventory.ts views/partials/access-check.eta views/pages/identity.eta public/css/site.css tests/support/fake-access-clients.ts tests/support/app-factory.ts tests/access-check.test.ts tests/config.test.ts
git commit -m "feat: access-check matrix of read-only actions on the Identity tab" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: IMDS client and "node, not pod" card

**Files:**
- Create: `src/imds/imds-client.ts`, `views/partials/imds.eta`
- Modify: `src/app.ts` (`AppDeps.imdsFetch`, `AppDeps.imds`), `src/routes/identity.ts` (routes), `src/routes/inventory.ts` (refresh invalidates), `views/pages/identity.eta` (third card), `tests/support/app-factory.ts` (inject a fake fetch, return `imdsFetch`)
- Test: `tests/imds.test.ts`

**Interfaces:**
- Consumes: `TtlCache` (+ `peek`), `Clock`, `AppSettings.imdsEnabled/cacheTtlSeconds`, global `fetch` (production) via an injectable `FetchLike`.
- Produces: `interface ImdsInstance { instance_id, instance_type, availability_zone, region, account_id, image_id, private_ip: string | null }`; `interface ImdsInfo { available: boolean; reason: string | null; instance: ImdsInstance | null; fetched_at: string }`; `type ImdsFetch = (url: string, init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>`; `class ImdsClient { constructor(opts: { enabled: boolean; clock: Clock; cache: TtlCache; fetchFn?: ImdsFetch; baseUrl?: string; timeoutMs?: number }); get(force?): Promise<ImdsInfo>; peek(); invalidateAll() }`; routes `GET /api/imds[?refresh=true]`, `GET /partials/imds[?refresh=1]`; `AppDeps.imdsFetch`, `AppDeps.imds`; `testApp()` returns `imdsFetch: FakeImdsFetch`.
- IMDSv2 flow: `PUT {base}/latest/api/token` with `X-aws-ec2-metadata-token-ttl-seconds: 60` → token text; `GET {base}/latest/dynamic/instance-identity/document` with `X-aws-ec2-metadata-token`; both under one `AbortSignal.timeout(timeoutMs)` (default 1000 ms). Unavailable reasons (all `available: false`): `disabled (IMDS_ENABLED=false)`; `IMDS did not answer within 1s: not running on EC2, or the pod cannot reach IMDS (hop limit 1, EKS Auto Mode)`; `IMDS token request returned <status>`; `IMDS returned <status>`; `IMDS response is not a JSON object`; `IMDS not reachable: <message>`.

- [ ] **Step 1: Write the failing tests**

`tests/imds.test.ts`:
```ts
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
    [{ hang: true }, /did not answer within 1s: not running on EC2, or the pod cannot reach IMDS \(hop limit 1, EKS Auto Mode\)/],
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
    expect(html).toContain("Unavailable: IMDS did not answer within 1s");
    const off = await testApp({ env: { IMDS_ENABLED: "false" } });
    expect((await off.app.inject({ url: "/partials/imds" })).body).toContain("Unavailable: disabled (IMDS_ENABLED=false)");
    await off.app.close();
  });
});
```

Add to `tests/support/app-factory.ts` a small scripted fake (exported from the same file for simplicity):
```ts
/** Minimal IMDS fake for route tests: answers the token PUT then the document GET; `mode: "hang"` waits for the abort signal. */
export class FakeImdsFetch {
  calls = 0;
  mode: "ok" | "hang" = "ok";
  document: Record<string, string> = { instanceId: "i-test", instanceType: "t3.micro", availabilityZone: "us-east-1a", region: "us-east-1", accountId: "123456789012", imageId: "ami-test", privateIp: "10.0.0.1" };
  readonly fn: ImdsFetch = async (url, init) => {
    this.calls++;
    if (this.mode === "hang") await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    if (url.endsWith("/latest/api/token")) return { ok: true, status: 200, text: async () => "T" };
    return { ok: true, status: 200, text: async () => JSON.stringify(this.document) };
  };
}
```
and inside `testApp`: `const imdsFetch = new FakeImdsFetch();` passed as `imdsFetch: imdsFetch.fn` (and `imdsTimeoutMs: 20`), returned as `imdsFetch`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/imds.test.ts`
Expected: FAIL — cannot resolve `../src/imds/imds-client.js`.

- [ ] **Step 3: Implement**

`src/imds/imds-client.ts`:
```ts
import type { Clock } from "../clock.js";
import type { TtlCache } from "../inventory/ttl-cache.js";

export interface ImdsInstance {
  instance_id: string | null;
  instance_type: string | null;
  availability_zone: string | null;
  region: string | null;
  account_id: string | null;
  image_id: string | null;
  private_ip: string | null;
}

/** GET /api/imds. On EKS this describes the NODE, not the pod; unreachable IMDS is a normal, displayable state. */
export interface ImdsInfo {
  available: boolean;
  reason: string | null;
  instance: ImdsInstance | null;
  fetched_at: string;
}

export type ImdsFetch = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ImdsClientOptions {
  enabled: boolean;
  clock: Clock;
  cache: TtlCache;
  fetchFn?: ImdsFetch;
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE = "http://169.254.169.254";
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** IMDSv2 only (token PUT, then the instance-identity document), one short deadline for both calls, no proxy. */
export class ImdsClient {
  private static readonly KEY = "imds";
  private readonly fetchFn: ImdsFetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ImdsClientOptions) {
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.timeoutMs = opts.timeoutMs ?? 1000;
  }

  async get(force = false): Promise<ImdsInfo> {
    if (!this.opts.enabled) return this.unavailable("disabled (IMDS_ENABLED=false)");
    const entry = await this.opts.cache.get<ImdsInfo>(ImdsClient.KEY, () => this.load(), force);
    return entry.value as ImdsInfo;
  }

  peek(): ImdsInfo | null {
    return this.opts.cache.peek<ImdsInfo>(ImdsClient.KEY)?.value ?? null;
  }

  invalidateAll(): void {
    this.opts.cache.invalidateAll();
  }

  private unavailable(reason: string): ImdsInfo {
    return { available: false, reason, instance: null, fetched_at: this.opts.clock.now().toISOString() };
  }

  private async load(): Promise<ImdsInfo> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const tokenRes = await this.fetchFn(`${this.baseUrl}/latest/api/token`, { method: "PUT", headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" }, signal });
      if (!tokenRes.ok) return this.unavailable(`IMDS token request returned ${tokenRes.status}`);
      const token = (await tokenRes.text()).trim();
      const docRes = await this.fetchFn(`${this.baseUrl}/latest/dynamic/instance-identity/document`, { method: "GET", headers: { "X-aws-ec2-metadata-token": token }, signal });
      if (!docRes.ok) return this.unavailable(`IMDS returned ${docRes.status}`);
      let doc: unknown;
      try {
        doc = JSON.parse(await docRes.text());
      } catch {
        return this.unavailable("IMDS response is not a JSON object");
      }
      if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return this.unavailable("IMDS response is not a JSON object");
      const d = doc as Record<string, unknown>;
      return {
        available: true,
        reason: null,
        instance: {
          instance_id: str(d["instanceId"]),
          instance_type: str(d["instanceType"]),
          availability_zone: str(d["availabilityZone"]),
          region: str(d["region"]),
          account_id: str(d["accountId"]),
          image_id: str(d["imageId"]),
          private_ip: str(d["privateIp"]),
        },
        fetched_at: this.opts.clock.now().toISOString(),
      };
    } catch (err) {
      const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        return this.unavailable(`IMDS did not answer within ${this.timeoutMs >= 1000 ? `${this.timeoutMs / 1000}s` : `${this.timeoutMs}ms`}: not running on EC2, or the pod cannot reach IMDS (hop limit 1, EKS Auto Mode)`);
      }
      return this.unavailable(`IMDS not reachable: ${e.cause?.code ?? e.cause?.message ?? e.message ?? String(err)}`);
    }
  }
}
```
(The timeout message must read "within 1s" for the production default; the tests use `timeoutMs: 20` and match the rest of the sentence with a regex, so keep the wording exactly as above.)

`views/partials/imds.eta` (data: `it.info`):
```eta
<% const i = it.info, fmt = it.fmt; %>
<h2>Instance metadata (IMDS)</h2>
<% if (!i.available) { %>
<p class="muted">Unavailable: <%= i.reason %></p>
<% } else { %>
<p class="muted">This describes the <strong>node</strong> (the EC2 instance) this pod runs on, not the pod. On EKS Auto Mode and nodes with hop limit 1, pods cannot reach IMDS at all.</p>
<dl class="kv">
  <dt>Instance</dt><dd><%= fmt.or(i.instance.instance_id) %></dd>
  <dt>Type</dt><dd><%= fmt.or(i.instance.instance_type) %></dd>
  <dt>Availability zone</dt><dd><%= fmt.or(i.instance.availability_zone) %></dd>
  <dt>Region</dt><dd><%= fmt.or(i.instance.region) %></dd>
  <dt>Account</dt><dd><%= fmt.or(i.instance.account_id) %></dd>
  <dt>Image</dt><dd><%= fmt.or(i.instance.image_id) %></dd>
  <dt>Private IP</dt><dd><%= fmt.or(i.instance.private_ip) %></dd>
</dl>
<% } %>
<p class="muted">Checked <%= fmt.time(i.fetched_at) %> · <a href="#" hx-get="/partials/imds?refresh=1" hx-target="closest [data-imds-panel]">refresh</a></p>
```

Add to `views/pages/identity.eta` after the access-check section:
```eta
  <section class="card" data-imds-panel hx-get="/partials/imds" hx-trigger="load">
    <h2>Instance metadata (IMDS)</h2>
    <p class="muted">Loading…</p>
  </section>
```

Routes — add to `src/routes/identity.ts`:
```ts
  app.get("/api/imds", (req) => deps.imds.get(isRefresh(req)));
  app.get("/partials/imds", async (req, reply) => reply.partial("partials/imds", { info: await deps.imds.get(isRefresh(req)) }));
```
and the refresh handler in `src/routes/inventory.ts` also calls `deps.imds.invalidateAll()`.

`src/app.ts`: import `{ ImdsClient, type ImdsFetch } from "./imds/imds-client.js"`; `AppDeps` gains `imdsFetch: ImdsFetch;`, `imdsTimeoutMs: number;`, `imds: ImdsClient;`; in `createDeps` after `accessCheck`:
```ts
  const imdsFetch = overrides.imdsFetch ?? ((url: string, init: Parameters<ImdsFetch>[1]) => fetch(url, init));
  const imdsTimeoutMs = overrides.imdsTimeoutMs ?? 1000;
  const imds = overrides.imds ?? new ImdsClient({
    enabled: settings.imdsEnabled, clock, fetchFn: imdsFetch, timeoutMs: imdsTimeoutMs,
    cache: new TtlCache(settings.cacheTtlSeconds * 1000, clock, (err) => awsErrorFrom(err).message),
  });
```
and return `imdsFetch, imdsTimeoutMs, imds`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/imds.test.ts && npm test && npm run typecheck`
Expected: all pass. Manual: `npm run dev` → the Identity page's IMDS card shows "Unavailable: IMDS did not answer within 1s…" on a laptop within ~1 s.

- [ ] **Step 5: Commit**

```bash
git add src/imds/imds-client.ts views/partials/imds.eta views/pages/identity.eta src/routes/identity.ts src/routes/inventory.ts src/app.ts tests/support/app-factory.ts tests/imds.test.ts
git commit -m "feat: IMDSv2 node-metadata card with unavailable as a normal state" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Identity, token and access-check metrics

**Files:**
- Modify: `src/metrics/metrics.ts`, `src/app.ts` (wire observers and the identity source), `tests/metrics.test.ts`

**Interfaces:**
- Consumes: `IdentityObserver` (Task 2), `AccessCheckObserver`/`AccessCheckRow` (Task 4), `IdentityInfo`, `IdentityService.peek()`, `Clock`.
- Produces: `Metrics implements InventoryObserver, IdentityObserver, AccessCheckObserver`; `MetricsSources` gains `now: () => Date`; `metrics.setIdentitySource(fn: () => IdentityInfo | null)`; new metrics `aws_dash_credential_expiry_seconds{mode}`, `aws_dash_token_file_expiry_seconds`, `aws_dash_credential_resolutions_total{mode,result}`, `aws_dash_access_check_allowed{action}`; `createDeps` passes `observer: metrics` to `IdentityService` and `AccessCheckService` and calls `metrics.setIdentitySource(() => identity.peek())`.
- The expiry gauges are computed at scrape time from the *cached* `IdentityInfo` — never resolving credentials, calling STS or reading the token file.

- [ ] **Step 1: Write the failing tests**

Append to `tests/metrics.test.ts` (imports: add `makeJwt` from `./support/test-jwt.js`):
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/metrics.test.ts`
Expected: FAIL — the new metric names are absent.

- [ ] **Step 3: Implement**

`src/metrics/metrics.ts` changes:
- imports: `import type { AccessCheckObserver, AccessCheckRow } from "../identity/access-check.js"; import type { IdentityObserver, IdentityInfo } from "../identity/identity-service.js";`
- `MetricsSources` gains `now: () => Date;`
- class: `export class Metrics implements InventoryObserver, IdentityObserver, AccessCheckObserver`; new private fields `resolutions: Counter<"mode" | "result">`, `accessAllowed: Gauge<"action">`, and `private identitySource: () => IdentityInfo | null = () => null;`
- in the constructor, after the cgroup gauges:
```ts
    const secondsUntil = (iso: string | null | undefined): number => (iso ? Math.round((new Date(iso).getTime() - sources.now().getTime()) / 1000) : -1);
    new Gauge({
      name: "aws_dash_credential_expiry_seconds", help: "Seconds until the cached AWS credentials expire; -1 when unknown or non-expiring.", labelNames: ["mode"], registers,
      collect() {
        const info = self.identitySource();
        this.set({ mode: info?.mode ?? sources.authMode }, secondsUntil(info?.credentials?.expiration));
      },
    });
    new Gauge({
      name: "aws_dash_token_file_expiry_seconds", help: "Seconds until the web-identity token file expires; -1 when there is no token.", registers,
      collect() { this.set(secondsUntil(self.identitySource()?.token?.expires_at)); },
    });
    this.resolutions = new Counter({ name: "aws_dash_credential_resolutions_total", help: "Credential resolutions by mode and result.", labelNames: ["mode", "result"], registers });
    this.accessAllowed = new Gauge({ name: "aws_dash_access_check_allowed", help: "1 when the last access check allowed the action, else 0.", labelNames: ["action"], registers });
```
where `const self = this;` is declared at the top of the constructor (the `collect()` methods run with the Gauge as `this`).
- methods:
```ts
  setIdentitySource(source: () => IdentityInfo | null): void {
    this.identitySource = source;
  }

  resolved(mode: string, ok: boolean): void {
    this.resolutions.inc({ mode, result: ok ? "ok" : "error" });
  }

  checked(rows: AccessCheckRow[]): void {
    for (const row of rows) this.accessAllowed.set({ action: row.action }, row.result === "allowed" ? 1 : 0);
  }
```

`src/app.ts`: pass `now: () => clock.now()` in `new Metrics({...})`; pass `observer: metrics` in both `new IdentityService({...})` and `new AccessCheckService({...})`; after `identity` is built: `metrics.setIdentitySource(() => identity.peek());`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/metrics.test.ts && npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/metrics/metrics.ts src/app.ts tests/metrics.test.ts
git commit -m "feat: credential, token and access-check metrics from cached identity state" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: EKS IRSA, EKS Pod Identity and OpenShift native-issuer overlays

**Files:**
- Create: `deploy/aws/trust-eks-irsa.json`, `deploy/aws/trust-eks-pod-identity.json`, `deploy/aws/trust-openshift-oidc.json`, `deploy/aws/README.md`, `deploy/eks-irsa/{kustomization.yaml,README.md}`, `deploy/eks-pod-identity/{kustomization.yaml,README.md}`, `deploy/openshift-native-oidc/{kustomization.yaml,route.yaml,identity-configmap.yaml,README.md}`
- Modify: `deploy/README.md` (overlay matrix), `.gitignore` (`deploy/**/*.bak`)

**Interfaces:**
- Consumes: the Phase 1 base (`deploy/kubernetes`, empty `volumes`/`volumeMounts` for `/-` patches), `deploy/aws/aws-dash-readonly-policy.json`, the app's `AUTH_MODE`/`AWS_*` handling (Phase 2), the Identity tab (Tasks 2–5) for the "what you should see" sections.
- Produces: three overlays that render with `kubectl kustomize`; trust-policy templates whose placeholders are exactly `AWS_ACCOUNT_ID` and `OIDC_ISSUER_HOST`; overlay placeholders exactly `AWS_ACCOUNT_ID`; every placeholder named (as a `sed` target) in the README of the directory that contains it (Task 8 enforces this).
- No `runAsUser` anywhere; the EKS overlays do not add RBAC (the Kubernetes card and `node-reader` component arrive in Phase 4).

- [ ] **Step 1: Trust-policy templates**

`deploy/aws/trust-eks-irsa.json`:
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
          "OIDC_ISSUER_HOST:aud": "sts.amazonaws.com",
          "OIDC_ISSUER_HOST:sub": "system:serviceaccount:aws-dash:aws-dash"
        }
      }
    }
  ]
}
```

`deploy/aws/trust-eks-pod-identity.json`:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "pods.eks.amazonaws.com" },
      "Action": ["sts:AssumeRole", "sts:TagSession"]
    }
  ]
}
```

`deploy/aws/trust-openshift-oidc.json`: identical to `trust-eks-irsa.json` (the cluster's service-account issuer is the OIDC provider; `sub` is the same `system:serviceaccount:aws-dash:aws-dash`).

`deploy/aws/README.md`:
````markdown
# IAM policy and trust-policy templates

- `aws-dash-readonly-policy.json` — the only permissions the app needs (attach to the user or role).
- `trust-eks-irsa.json` — role trust for EKS IRSA. Placeholders: `AWS_ACCOUNT_ID`, `OIDC_ISSUER_HOST` (the cluster issuer without `https://`).
- `trust-eks-pod-identity.json` — role trust for EKS Pod Identity (no placeholders; the association binds it to the service account).
- `trust-openshift-oidc.json` — role trust for an OpenShift cluster whose service-account issuer is public. Placeholders: `AWS_ACCOUNT_ID`, `OIDC_ISSUER_HOST`.

Each overlay README shows the exact `sed` that fills `AWS_ACCOUNT_ID` and `OIDC_ISSUER_HOST` before `aws iam create-role`.
````

- [ ] **Step 2: `deploy/eks-irsa`**

`deploy/eks-irsa/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: aws-dash
resources:
  - ../kubernetes
patches:
  # Replace AWS_ACCOUNT_ID before applying (see README). The EKS pod-identity webhook reads this annotation and
  # injects AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE plus a projected token with audience sts.amazonaws.com.
  - target: {kind: ServiceAccount, name: aws-dash}
    patch: |-
      - op: add
        path: /metadata/annotations
        value:
          eks.amazonaws.com/role-arn: arn:aws:iam::AWS_ACCOUNT_ID:role/aws-dash-irsa
          eks.amazonaws.com/sts-regional-endpoints: "true"
  - target: {kind: ConfigMap, name: aws-dash-config}
    patch: |-
      - op: replace
        path: /data/AUTH_MODE
        value: web-identity
```

`deploy/eks-irsa/README.md`:
````markdown
# aws-dash on EKS with IAM Roles for Service Accounts (IRSA)

The pod's projected service-account token (issued by the cluster's OIDC provider, audience `sts.amazonaws.com`) is
exchanged with STS for the role `aws-dash-irsa` via `AssumeRoleWithWebIdentity`. The EKS pod-identity webhook injects
`AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE` into pods whose service account carries the
`eks.amazonaws.com/role-arn` annotation; the overlay sets `AUTH_MODE=web-identity` so a missing injection is an
error, not a silent fall-through to the node role. AWS now recommends Pod Identity for new clusters
(`deploy/eks-pod-identity`); IRSA is still what ROSA-style and older clusters use.

## 1. Variables and the cluster's OIDC provider

```bash
export CLUSTER=my-cluster AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export OIDC_ISSUER=$(aws eks describe-cluster --name "$CLUSTER" --query cluster.identity.oidc.issuer --output text)
export OIDC_ISSUER_HOST=${OIDC_ISSUER#https://}
# Register the issuer as an IAM OIDC provider once per cluster (skip if it already exists):
aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?ends_with(Arn, '$OIDC_ISSUER_HOST')]" --output text \
  || aws iam create-open-id-connect-provider --url "$OIDC_ISSUER" --client-id-list sts.amazonaws.com
# eksctl equivalent: eksctl utils associate-iam-oidc-provider --cluster "$CLUSTER" --approve
```

## 2. Role, trust policy and permissions

```bash
sed -e "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/g" -e "s#OIDC_ISSUER_HOST#$OIDC_ISSUER_HOST#g" deploy/aws/trust-eks-irsa.json > /tmp/aws-dash-trust.json
aws iam create-role --role-name aws-dash-irsa --assume-role-policy-document file:///tmp/aws-dash-trust.json
aws iam create-policy --policy-name aws-dash-readonly --policy-document file://deploy/aws/aws-dash-readonly-policy.json 2>/dev/null || true
aws iam attach-role-policy --role-name aws-dash-irsa --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/aws-dash-readonly"
```

## 3. Deploy

```bash
sed -i.bak "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/" deploy/eks-irsa/kustomization.yaml
sed -i.bak "s/AWS_REGION: us-east-1/AWS_REGION: $AWS_REGION/" deploy/kubernetes/configmap.yaml   # only if your region differs
kubectl apply -k deploy/eks-irsa
kubectl -n aws-dash rollout status deploy/aws-dash
kubectl -n aws-dash exec deploy/aws-dash -- printenv | grep -E '^AWS_(ROLE_ARN|WEB_IDENTITY_TOKEN_FILE|REGION)'
kubectl -n aws-dash port-forward svc/aws-dash 8080:8080
```

If the pods existed before the annotation (for example an earlier apply with the placeholder), the webhook never mutated
them: `kubectl -n aws-dash rollout restart deploy/aws-dash`.

Open **Identity**. You should see mode `web-identity`, flavor **EKS IRSA**, a token with
`sub = system:serviceaccount:aws-dash:aws-dash` and `aud = sts.amazonaws.com`, STS returning
`arn:aws:sts::…:assumed-role/aws-dash-irsa/<session>`, an `ASIA…` key, and SDK sources `h` and `k`.
**IMDS** shows the node (unless the node's hop limit is 1 or the cluster is EKS Auto Mode — then "unavailable" is
expected). The access-check matrix is all green; detach `aws-dash-readonly` and re-run to watch it flip.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Identity shows `AUTH_MODE web-identity requires AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN` | The webhook did not inject: check the annotation on the ServiceAccount and `rollout restart`. |
| `InvalidIdentityToken` | The IAM OIDC provider for `$OIDC_ISSUER` is missing, or `aud` is not `sts.amazonaws.com`. |
| `AccessDenied … sts:AssumeRoleWithWebIdentity` | The trust policy's `:sub`/`:aud` do not match the token; compare with the decoded claims on the Identity tab. |
| Panels show the read-only policy hint | The policy is not attached to `aws-dash-irsa`. |
````

- [ ] **Step 3: `deploy/eks-pod-identity`**

`deploy/eks-pod-identity/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: aws-dash
resources:
  - ../kubernetes
patches:
  # Explicit so a missing PodIdentityAssociation is an error on the Identity tab instead of a silent fall-through
  # to the node's instance role via IMDS. The eks-pod-identity-agent injects AWS_CONTAINER_CREDENTIALS_FULL_URI and
  # AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE; nothing on the ServiceAccount needs annotating.
  - target: {kind: ConfigMap, name: aws-dash-config}
    patch: |-
      - op: replace
        path: /data/AUTH_MODE
        value: pod-identity
```

`deploy/eks-pod-identity/README.md`:
````markdown
# aws-dash on EKS with EKS Pod Identity

EKS Pod Identity (AWS's current recommendation) binds an IAM role to a Kubernetes service account through a
`PodIdentityAssociation`. The `eks-pod-identity-agent` DaemonSet injects `AWS_CONTAINER_CREDENTIALS_FULL_URI`
(`http://169.254.170.23/v1/credentials`) and `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` into the pod; the SDK's
container-credentials provider exchanges the projected token (audience `pods.eks.amazonaws.com`) with the agent. No
OIDC provider and no ServiceAccount annotation are needed. EKS Auto Mode has the agent built in.

## 1. Add-on, role, permissions

```bash
export CLUSTER=my-cluster AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws eks create-addon --cluster-name "$CLUSTER" --addon-name eks-pod-identity-agent   # skip on EKS Auto Mode
aws iam create-role --role-name aws-dash-pod-identity --assume-role-policy-document file://deploy/aws/trust-eks-pod-identity.json
aws iam create-policy --policy-name aws-dash-readonly --policy-document file://deploy/aws/aws-dash-readonly-policy.json 2>/dev/null || true
aws iam attach-role-policy --role-name aws-dash-pod-identity --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/aws-dash-readonly"
```

## 2. Association and deploy

```bash
aws eks create-pod-identity-association --cluster-name "$CLUSTER" --namespace aws-dash --service-account aws-dash \
  --role-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:role/aws-dash-pod-identity"
sed -i.bak "s/AWS_REGION: us-east-1/AWS_REGION: $AWS_REGION/" deploy/kubernetes/configmap.yaml   # only if your region differs
kubectl apply -k deploy/eks-pod-identity
kubectl -n aws-dash rollout restart deploy/aws-dash    # pods created before the association are not mutated
kubectl -n aws-dash rollout status deploy/aws-dash
kubectl -n aws-dash exec deploy/aws-dash -- printenv | grep ^AWS_CONTAINER_
kubectl -n aws-dash port-forward svc/aws-dash 8080:8080
```

Open **Identity**: mode `pod-identity`, flavor **EKS Pod Identity**, the decoded token's `aud` is
`pods.eks.amazonaws.com`, STS shows `assumed-role/aws-dash-pod-identity/<session>` (record the session-name format
you observe — it is documented nowhere reliable), SDK source `z`. Pod Identity adds session tags
(`kubernetes-namespace`, `kubernetes-service-account`, `eks-cluster-name`) you can use in IAM conditions.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `AUTH_MODE pod-identity requires AWS_CONTAINER_CREDENTIALS_FULL_URI …` | The agent did not inject: is the add-on running (`kubectl -n kube-system get ds eks-pod-identity-agent`) and does the association exist (`aws eks list-pod-identity-associations --cluster-name $CLUSTER`)? Then `rollout restart`. |
| `CredentialsProviderError` mentioning 169.254.170.23 | The agent pod on that node is unhealthy, or a NetworkPolicy blocks link-local traffic. |
| Panels show the read-only policy hint | Attach `aws-dash-readonly` to `aws-dash-pod-identity`. |
````

- [ ] **Step 4: `deploy/openshift-native-oidc`**

`deploy/openshift-native-oidc/route.yaml`: same content as `deploy/openshift/route.yaml`.

`deploy/openshift-native-oidc/identity-configmap.yaml`:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: aws-dash-identity
data:
  AWS_ROLE_ARN: arn:aws:iam::AWS_ACCOUNT_ID:role/aws-dash-openshift
  AWS_ROLE_SESSION_NAME: aws-dash
```

`deploy/openshift-native-oidc/kustomization.yaml`:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: aws-dash
resources:
  - ../kubernetes
  - route.yaml
  - identity-configmap.yaml
patches:
  - target: {kind: ConfigMap, name: aws-dash-config}
    patch: |-
      - op: replace
        path: /data/AUTH_MODE
        value: web-identity
  # Project the service-account token ourselves (audience sts.amazonaws.com), so this works without any webhook.
  - target: {kind: Deployment, name: aws-dash}
    patch: |-
      - op: add
        path: /spec/template/spec/volumes/-
        value:
          name: aws-token
          projected:
            sources:
              - serviceAccountToken:
                  path: token
                  audience: sts.amazonaws.com
                  expirationSeconds: 3600
      - op: add
        path: /spec/template/spec/containers/0/volumeMounts/-
        value:
          name: aws-token
          mountPath: /var/run/secrets/aws
          readOnly: true
      - op: add
        path: /spec/template/spec/containers/0/envFrom/-
        value:
          configMapRef:
            name: aws-dash-identity
      - op: add
        path: /spec/template/spec/containers/0/env/-
        value:
          name: AWS_WEB_IDENTITY_TOKEN_FILE
          value: /var/run/secrets/aws/token
      - op: add
        path: /spec/template/spec/containers/0/env/-
        value:
          name: AWS_EC2_METADATA_DISABLED
          value: "true"
```

`deploy/openshift-native-oidc/README.md`:
````markdown
# aws-dash on OpenShift using the cluster's own service-account issuer

Same mechanism as EKS IRSA, with OpenShift's service-account issuer as the OIDC provider: the overlay projects a token
with audience `sts.amazonaws.com` and sets `AWS_ROLE_ARN`/`AWS_WEB_IDENTITY_TOKEN_FILE` by hand, so no webhook is
involved. **Requirement:** STS must be able to fetch the issuer's discovery document and JWKS over public HTTPS.

## 1. Find the issuer and check it is public

```bash
export ISSUER=$(oc get authentication cluster -o jsonpath='{.spec.serviceAccountIssuer}')
echo "${ISSUER:-<empty: default https://kubernetes.default.svc, not public>}"
curl -fsS "$ISSUER/.well-known/openid-configuration" | jq '{issuer, jwks_uri}'
export OIDC_ISSUER_HOST=${ISSUER#https://}
```

- **ROSA / OpenShift installed in STS (manual) mode:** the issuer is public and an IAM OIDC provider for it already exists
  (`aws iam list-open-id-connect-providers`) — reuse it.
- **Default OCP install:** `serviceAccountIssuer` is empty → `https://kubernetes.default.svc`, which STS cannot reach.
  Use the ZTWIM overlay (`deploy/ztwim`, Phase 4) instead.

## 2. OIDC provider (if missing), role, permissions

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?ends_with(Arn, '$OIDC_ISSUER_HOST')]" --output text \
  || aws iam create-open-id-connect-provider --url "$ISSUER" --client-id-list sts.amazonaws.com
sed -e "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/g" -e "s#OIDC_ISSUER_HOST#$OIDC_ISSUER_HOST#g" deploy/aws/trust-openshift-oidc.json > /tmp/aws-dash-trust.json
aws iam create-role --role-name aws-dash-openshift --assume-role-policy-document file:///tmp/aws-dash-trust.json
aws iam create-policy --policy-name aws-dash-readonly --policy-document file://deploy/aws/aws-dash-readonly-policy.json 2>/dev/null || true
aws iam attach-role-policy --role-name aws-dash-openshift --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/aws-dash-readonly"
```

## 3. Deploy

```bash
sed -i.bak "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/" deploy/openshift-native-oidc/identity-configmap.yaml
oc apply -k deploy/openshift-native-oidc
oc -n aws-dash rollout status deploy/aws-dash
oc -n aws-dash get route aws-dash -o jsonpath='https://{.spec.host}{"\n"}'
```

Open **Identity**: mode `web-identity`, flavor **Kubernetes projected service-account token**, `iss = $ISSUER`,
`sub = system:serviceaccount:aws-dash:aws-dash`. If the projected token file is unreadable under OpenShift's arbitrary
UID, add `defaultMode: 0640` to the projected volume (record what you observed). `InvalidIdentityToken` means the IAM
OIDC provider URL and the token's `iss` differ (scheme, path or trailing slash).
````

- [ ] **Step 5: Matrix, gitignore, render**

Update the overlay table in `deploy/README.md`: drop "(Phase 3)" from the three rows and add columns "Trust principal" and "Condition keys" (IRSA: `Federated` OIDC provider, `<issuer>:sub`/`:aud`; Pod Identity: `Service pods.eks.amazonaws.com`, none — session tags instead; native OIDC: `Federated` issuer, `<issuer>:sub`/`:aud`; ztwim stays "(Phase 4)"). Add a line: "Trust-policy templates live in `deploy/aws/`."

Append `deploy/**/*.bak` to `.gitignore`.

Run: `scripts/kustomize-check.sh` → five `ok` lines; `kubectl kustomize deploy/openshift-native-oidc | grep -c 'sts.amazonaws.com'` → 1; `kubectl kustomize deploy/eks-irsa | grep role-arn`; `node -e 'for (const f of ["trust-eks-irsa","trust-eks-pod-identity","trust-openshift-oidc"]) JSON.parse(require("fs").readFileSync("deploy/aws/"+f+".json","utf8")); console.log("json ok")'`.

- [ ] **Step 6: Commit**

```bash
git add deploy .gitignore
git commit -m "deploy: EKS IRSA, EKS Pod Identity and OpenShift native-issuer overlays with runbooks" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Placeholder check in CI

**Files:**
- Create: `scripts/check-placeholders.sh`
- Modify: `.github/workflows/build-container.yaml` (`manifests` job), `package.json` (`placeholders:check` script)

**Interfaces:**
- Produces: `scripts/check-placeholders.sh` — for every `deploy/**/*.{yaml,json}`, each placeholder token (`AWS_ACCOUNT_ID`, `OIDC_ISSUER_HOST`, `000000000000`, `REPLACE_ME`) it contains must appear in the `README.md` of the same directory; prints `ok`/`FAIL` per file+token and exits non-zero on any failure. Closes the sibling projects' "placeholder nobody sed-replaced" drift.

- [ ] **Step 1: Write the script**

`scripts/check-placeholders.sh`:
```bash
#!/usr/bin/env bash
# Every placeholder in a deploy manifest or policy template must be named in the README next to it, so no runbook
# can forget the sed that fills it in. Add new placeholder tokens to PLACEHOLDERS when you introduce them.
set -euo pipefail
cd "$(dirname "$0")/.."
PLACEHOLDERS='AWS_ACCOUNT_ID|OIDC_ISSUER_HOST|000000000000|REPLACE_ME'
status=0
while IFS= read -r file; do
  dir=$(dirname "$file")
  readme="$dir/README.md"
  for token in $(grep -oE "$PLACEHOLDERS" "$file" | sort -u); do
    if [[ -f "$readme" ]] && grep -q -- "$token" "$readme"; then
      echo "ok   $file: $token documented in $readme"
    else
      echo "FAIL $file: placeholder $token is not documented in $readme"
      status=1
    fi
  done
done < <(find deploy -type f \( -name '*.yaml' -o -name '*.json' \) | sort)
exit $status
```
Run: `chmod +x scripts/check-placeholders.sh && scripts/check-placeholders.sh` — expect `ok` lines for `deploy/aws/trust-eks-irsa.json` (2 tokens), `deploy/aws/trust-openshift-oidc.json` (2), `deploy/eks-irsa/kustomization.yaml` (1), `deploy/openshift-native-oidc/identity-configmap.yaml` (1), and exit 0. Prove the failure path once: `mkdir -p /tmp/pc && cp -r deploy /tmp/pc/ && rm /tmp/pc/deploy/eks-irsa/README.md && (cd /tmp/pc && bash "$OLDPWD/scripts/check-placeholders.sh"; echo "exit=$?")` → a `FAIL` line and `exit=1` (the script `cd`s to its own repo root, so instead test by temporarily renaming `deploy/eks-irsa/README.md`, running, then renaming back — restore before committing).

- [ ] **Step 2: Wire it in**

`package.json` scripts: add `"placeholders:check": "scripts/check-placeholders.sh"`. In `.github/workflows/build-container.yaml`, in the `manifests` job after `- run: scripts/kustomize-check.sh` add `- run: scripts/check-placeholders.sh`. Validate YAML with `npx --yes js-yaml .github/workflows/build-container.yaml >/dev/null && echo yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-placeholders.sh package.json .github/workflows/build-container.yaml
git commit -m "ci: fail when a deploy placeholder is not documented in its README" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: README, docs drift checks, and the EKS verification record

**Files:**
- Modify: `README.md`, `deploy/README.md` (if any Phase-3 wording remains)
- Create: `docs/verification/eks-phase3.md`

**Interfaces:**
- Consumes: everything above. The README must match the code: routes in `src/routes/{identity,inventory,pages,metrics}.ts`, variables in `src/config.ts`.

- [ ] **Step 1: README.md**

- **Status** → `Phase 3: the Identity tab (decoded token, STS identity, credential facts, access-check matrix, IMDS card), identity metrics, and the EKS IRSA / EKS Pod Identity / OpenShift native-issuer overlays. The SPIFFE panel, Kubernetes card and ZTWIM overlay are Phase 4.`
- **Endpoints**: add `GET /identity` (page), `GET /api/identity[?refresh=true]` (spec §5 JSON — one line describing the four sections), `GET /partials/identity`, `GET /api/access-check[?refresh=true]` (`{enabled, fetched_at, principal_arn, error, rows[{action, service, result, code, message, duration_ms}]}`), `GET /partials/access-check`, `GET /api/imds[?refresh=true]` (`{available, reason, instance, fetched_at}`), `GET /partials/imds`; note that `POST /api/aws/refresh` now clears the identity, access-check and IMDS caches too.
- **Configuration**: promote `IMDS_ENABLED` (true), `ACCESS_CHECK_ENABLED` (true) and add `ACCESS_CHECK_ACTIONS` (unset = all; comma-separated subset of the 11 action names; `sts:GetCallerIdentity` always runs) to their own rows; the remaining "used from Phase 4 onward" row lists `K8S_INFO_ENABLED`, `SPIFFE_ENDPOINT_SOCKET`, `SPIFFE_JWT_AUDIENCE`.
- **Metrics** paragraph (new, short): list the four identity/access-check metrics and note gauges come from cached state.
- **Demo**: add `8. Open Identity: read the mode, the decoded token's iss/sub/aud, and what STS returned — the raw token is never shown.` and `9. Detach the read-only policy and click re-run on the access check: every row except sts:GetCallerIdentity flips to denied; re-attach and re-run.`
- **Deploy** section: link the three new overlay READMEs.

- [ ] **Step 2: Verification record**

`docs/verification/eks-phase3.md`:
````markdown
# Phase 3 live verification on EKS (pending)

Not yet run: this machine has no usable AWS credentials or cluster access. Run on a real cluster and fill in the
observations; several are spec §15 risks the docs currently state as expectations.

| Check | Overlay | Command / where to look | Observed |
|---|---|---|---|
| Identity flavor and decoded claims | eks-irsa | Identity tab → "Token presented to STS" | |
| STS session-name format | eks-pod-identity | Identity tab → "What AWS returned" → session | |
| `$source` ids | both | Identity tab → SDK source | |
| IMDS reachable from a pod? (hop limit / Auto Mode) | both | Identity tab → IMDS card | |
| Access-check all green, then detach policy → denied | both | Identity tab → Access check → re-run | |
| Projected token readable under arbitrary UID | openshift-native-oidc | pod logs / Identity token section | |
| `/metrics` credential/token expiry countdowns | any | `curl -s :8080/metrics \| grep aws_dash_credential` | |
| Static-key baseline (waived in Phase 2) | kubernetes | AWS tab panels + policy detach/re-attach | |

Record the exact strings observed and copy corrections back into the overlay READMEs and spec §15.
````

- [ ] **Step 3: Drift checks**

Run:
```bash
grep -oE '`/(api|partials)/(identity|access-check|imds)[^`]*`|`/identity`' README.md | sort -u
grep -nE 'app\.get\("/(api/identity|partials/identity|api/access-check|partials/access-check|api/imds|partials/imds|identity)"' src/routes/*.ts
grep -oE '^\| `[A-Z_]+`' README.md | tr -d '`| ' | sort -u > /private/tmp/claude-501/-Users-kemo-Development-aws-dash/374cc4ea-6a9e-4a63-a874-15547341036f/scratchpad/readme-vars.txt
grep -oE 'env\("[A-Z_]+"\)' src/config.ts | grep -oE '[A-Z_]+' | sort -u > /private/tmp/claude-501/-Users-kemo-Development-aws-dash/374cc4ea-6a9e-4a63-a874-15547341036f/scratchpad/config-vars.txt
comm -23 /private/tmp/claude-501/-Users-kemo-Development-aws-dash/374cc4ea-6a9e-4a63-a874-15547341036f/scratchpad/readme-vars.txt /private/tmp/claude-501/-Users-kemo-Development-aws-dash/374cc4ea-6a9e-4a63-a874-15547341036f/scratchpad/config-vars.txt
```
Expected: every README endpoint has a route and every README variable row is read by `config.ts` (the `comm` output is empty).

- [ ] **Step 4: Commit**

```bash
git add README.md deploy/README.md docs/verification/eks-phase3.md
git commit -m "docs: README for the Identity increment and the pending EKS verification record" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Phase 3 exit criteria

- `npm test` green (Phase 2's 173 + ≈45 new), `npm run typecheck` clean; no test reaches AWS, IMDS or the network.
- The Identity page shows the four sections with fake credentials in tests and the "no credentials found" hint on a laptop; the access-check matrix renders and flips rows on denial; the IMDS card says unavailable within 1 s off-EC2.
- Raw tokens, full key ids, secret keys and session tokens appear in no HTML, JSON or log line (tests).
- `/metrics` exposes the four new metrics and a scrape performs no I/O.
- `scripts/kustomize-check.sh` renders five overlays; `scripts/check-placeholders.sh` passes; CI runs both.
- `docs/verification/eks-phase3.md` exists and is honest about what has not been run.

Next: `docs/superpowers/plans/…-phase4-ztwim.md` (SPIFFE panel, Kubernetes card, `rbac.yaml` + `node-reader`, the `ztwim` overlay and its README) — written after Phase 3 ships.
