# aws-dash Design Spec

_Date: 2026-09-27 · Status: approved design, pending implementation plan · Siblings: `../gcp-dash` (Python), `../azure-dash` (.NET)_


## Context

gcp-dash and azure-dash are demo dashboards that show a container's own operating environment (runtime, cgroup limits, pod metadata), let a presenter actuate its state (toggle probes, burn CPU, crash), list cloud resources, and — the real point — prove that **one image runs unchanged** on the cloud's managed Kubernetes with workload identity, on any Kubernetes with static credentials, and on OpenShift using SPIFFE/SPIRE from the **Zero Trust Workload Identity Manager (ZTWIM)** operator. Only env/config differs.

aws-dash is the AWS sibling, in **Node 24 + TypeScript**. It should reach parity with azure-dash (the better reference: explicit auth-mode selection with a "why", an Identity tab that decodes both the federated token and the cloud-issued identity, IMDS "node-not-pod" card, ~135 tests with zero cloud calls) and close the gaps both siblings list as known: memory-pressure control, Prometheus metrics, a Kubernetes API pod/node card, and an IAM access-check matrix.

### Research findings that drive the design
- **AWS SDK v3 default chain** already covers all three targets from env vars alone: `fromEnv` (static keys) → `fromIni`/`fromProcess` → `fromTokenFile` (`AWS_WEB_IDENTITY_TOKEN_FILE`+`AWS_ROLE_ARN`; **re-reads the file on every resolve**, so a rotated spiffe-helper file works) → `fromHttp`/container (`AWS_CONTAINER_CREDENTIALS_FULL_URI` = EKS Pod Identity) → IMDS. Resolved credentials carry `$source` (internal feature-id map), `expiration`, `accountId`.
- **AWS now recommends EKS Pod Identity** over IRSA; both are cheap to support, IRSA is still what ROSA-style/OIDC clusters use.
- **ZTWIM → AWS** = IAM OIDC identity provider pointed at the SPIRE OIDC Discovery Provider Route (must serve a **publicly-trusted cert** — cert-manager/Let's Encrypt → `SpireOIDCDiscoveryProvider.spec.externalSecretRef`), trust policy `StringEquals {"<host>:aud":"aws-dash","<host>:sub":"spiffe://<td>/ns/aws-dash-ztwim/sa/aws-dash"}`. The operator auto-creates a fallback `ClusterSPIFFEID` with `spiffe://{{.TrustDomain}}/ns/{{ns}}/sa/{{sa}}`; there is **no** "jwt audiences" field — the workload (spiffe-helper) requests the audience. JWT-SVID TTL defaults to 5m; STS session is 1h — fine, SDK re-reads the file at refresh.
- gcp-dash's ZTWIM ConfigMap has a `$(VAR)` unquoted-heredoc bug (empty fields). azure-dash avoids it with a **static `helper.conf`**. Do the same.
- `spiffe/js-spiffe` does not exist; npm **`spiffe` 0.5.1** (depot/node-spiffe) is a small gRPC Workload API client — fine for a display-only panel, not for the credential path.
- Verified versions (npm, 2026-09-27): fastify 5.12.5, @fastify/static 10.1.5, @fastify/formbody 9.0.0, eta 4.6.0, pino 10.3.1, prom-client 15.1.3, undici 8.11.2, @aws-sdk/* 3.1141.0, @kubernetes/client-node 2.0.0, spiffe 0.5.1, **typescript 5.9.3 (pin — `latest` is 7.x)**, tsx 4.23.15, vitest 5.0.2. UBI: `ubi10/nodejs-24:10.2-1790228697`, `ubi10/nodejs-24-minimal:10.2-1790214703`. Local Node is 26 → pin 24 in `.nvmrc`/`engines`.

### Decisions (made with user)
| Decision | Choice |
|---|---|
| Language/stack | TypeScript (NodeNext ESM), Node 24 LTS, Fastify 5, Eta templates + vendored htmx 2, Pino, vitest |
| SPIFFE on OpenShift | spiffe-helper sidecar writes JWT-SVID file → `AWS_WEB_IDENTITY_TOKEN_FILE` (zero app code on credential path) **plus** a display-only SPIFFE panel via npm `spiffe` when `SPIFFE_ENDPOINT_SOCKET` is set |
| EKS overlays | both `eks-pod-identity` and `eks-irsa` |
| Extras | memory-pressure control, access-check matrix, `/metrics`, Kubernetes API pod/node card |
| Made on review | render Eta directly (no `@fastify/view`); spiffe-helper as a **native sidecar** (`initContainers` + `restartPolicy: Always`); explicit per-mode SDK providers (not `fromNodeProviderChain`) so the label always matches the credential used |

---

## 1. Repo layout

```
package.json  package-lock.json  .npmrc(save-exact)  .nvmrc(24)  tsconfig.json  tsconfig.build.json  vitest.config.ts
.gitignore  .containerignore  Containerfile  README.md
.github/workflows/build-container.yaml   .github/dependabot.yml
scripts/run-podman.sh  scripts/kustomize-check.sh  scripts/check-placeholders.sh
views/layout.eta  views/pages/{index,aws,identity}.eta
views/partials/{runtime,controls,panel,identity,claims-table,access-check,spiffe,k8s,imds}.eta
views/partials/inventory/{account,instances,vpcs,subnets,securitygroups,s3buckets,eksclusters,ecrrepos}.eta
public/css/site.css  public/js/htmx.min.js
src/
  server.ts            listen(); SIGTERM close
  app.ts               buildApp(deps: AppDeps) — every external thing injectable
  cli.ts               `--healthcheck` self-probe (no fastify import; GET 127.0.0.1:$PORT/healthz/live)
  config.ts  env.ts  clock.ts  logging.ts
  state/{runtime-state,process-exit}.ts
  load/{cpu-load,memory-load}.ts
  runtime/runtime-info.ts
  aws/{client-defaults,aws-error}.ts
  identity/{auth-mode,credential-factory,credential-provider,jwt-display,identity-service,access-check,spiffe-panel}.ts
  imds/imds-client.ts   k8s/k8s-info.ts
  inventory/{models,kinds,provider,live-provider,mappers,ttl-cache,inventory-service}.ts
  metrics/metrics.ts
  routes/{render,htmx,input,health,controls,runtime,inventory,identity,pages,metrics}.ts
  views/fmt.ts
tests/support/{app-factory,fake-clock,fake-exit,fake-root,test-jwt,fake-aws-provider,fake-credentials,fake-sts,fake-imds,fake-spiffe-client,fake-k8s,fake-worker-factory}.ts
tests/*.test.ts (one per module)
deploy/README.md  deploy/aws/aws-dash-readonly-policy.json  deploy/aws/trust-*.json
deploy/kubernetes/ (base)  deploy/components/node-reader/
deploy/{eks-pod-identity,eks-irsa,openshift,openshift-native-oidc,ztwim}/
docs/superpowers/specs/2026-09-27-aws-dash-design.md   (condensed copy of this plan, committed first)
```

Module rule (from gcp-dash plan): routes never import the AWS SDK directly; every cloud failure renders inside its panel, never a 500.

## 2. Endpoints

| Method | Path | Behavior |
|---|---|---|
| GET | `/` `/aws` `/identity` | Pages: Runtime+Controls · header card + 8 lazy inventory panels · Identity/Access-check/SPIFFE/Kubernetes/IMDS cards |
| GET | `/healthz/live` `/healthz/ready` | `{"status":"ok"}` or 503 `{"status":"failing","reason":"liveness disabled via controls"}` |
| GET | `/api/state` | `{live, ready, started_at, uptime_seconds, controls_enabled, cpu_load, memory_load}` |
| GET | `/api/runtime` · `/partials/runtime` · `/partials/controls` | RuntimeInfo JSON / HTML fragments |
| POST | `/controls/liveness` `/controls/readiness` | `enabled=true\|false` |
| POST | `/controls/cpu` | `enabled`, `workers` 1–64 (clamped to `os.availableParallelism()`) |
| POST | `/controls/memory` | `enabled`, `mib` 1–`MEMORY_LOAD_MAX_MIB`; 409 if already active |
| POST | `/controls/crash` | `exit_code` 0–255 → 202, exit after 500 ms via injected exit fn (stops cpu/memory first) |
| GET | `/api/aws/{kind}[?refresh=true]` · `/partials/aws/{kind}` | `{kind, fetched_at, error, items, truncated}`; unknown kind → 404 |
| POST | `/api/aws/refresh` | invalidate all caches → 204 |
| GET | `/api/identity` · `/partials/identity` | §5 |
| GET | `/api/access-check[?refresh=true]` · `/partials/access-check` | §5 matrix, cached |
| GET | `/api/spiffe` `/api/k8s` `/api/imds` (+ `/partials/*`) | side cards; "unavailable" is a normal 200 state |
| GET | `/metrics` | Prometheus text; 404 when `METRICS_ENABLED=false` |
| GET | `/public/*` | `@fastify/static` |

Conventions (parity with both siblings): `HX-Request: true` → HTML fragment else JSON; snake_case JSON; `/controls/*` → 403 `{detail:"controls are disabled (CONTROLS_ENABLED=false)"}` when disabled; bad input → 422 `{detail}`.

## 3. Configuration (`src/config.ts`, invalid → startup error naming the var)

| Var | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | 8080 / 0.0.0.0 | |
| `AUTH_MODE` | `auto` | `auto\|static\|profile\|web-identity\|pod-identity\|imds` |
| `AWS_REGION` (fallback `AWS_DEFAULT_REGION`) | — | missing → panel error "set AWS_REGION", not a crash |
| `AWS_CACHE_TTL_SECONDS` | 60 | inventory, access-check, identity, IMDS, k8s |
| `CONTROLS_ENABLED` | true | |
| `LOG_LEVEL` | info | pino |
| `AWS_DEBUG` | false | pino child as AWS SDK `logger` |
| `IMDS_ENABLED` `K8S_INFO_ENABLED` `METRICS_ENABLED` `ACCESS_CHECK_ENABLED` | true | |
| `ACCESS_CHECK_ACTIONS` | all | comma-separated subset of built-ins |
| `SPIFFE_ENDPOINT_SOCKET` | — | presence enables SPIFFE panel |
| `SPIFFE_JWT_AUDIENCE` | `aws-dash` | for the *display* JWT-SVID fetch only |
| `MEMORY_LOAD_MAX_MIB` | 4096 | |
| `CPU_LOAD_MAX_WORKERS` | `availableParallelism()` | |

Read but never re-defaulted: all standard `AWS_*` chain vars (`AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY/SESSION_TOKEN/ACCOUNT_ID/PROFILE/WEB_IDENTITY_TOKEN_FILE/ROLE_ARN/ROLE_SESSION_NAME/CONTAINER_CREDENTIALS_FULL_URI/…RELATIVE_URI/CONTAINER_AUTHORIZATION_TOKEN_FILE/EC2_METADATA_DISABLED`), Downward API `POD_NAME POD_NAMESPACE NODE_NAME POD_IP SERVICE_ACCOUNT`, `KUBERNETES_SERVICE_HOST`, `container`, `HOSTNAME`.

## 4. Credential selection (`identity/credential-factory.ts`) — mirrors azure-dash `CredentialFactory`

`resolve(settings, env) → {mode, reason}` — explicit `AUTH_MODE` wins; `auto` first-match **in SDK chain order**.
Note the SDK's own default chain actually prefers `AWS_PROFILE` over environment keys when both are set, which is
the opposite of the order below — set only one:
1. `AWS_ACCESS_KEY_ID`+`AWS_SECRET_ACCESS_KEY` → `static` ("auto: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set")
2. `AWS_PROFILE` → `profile`
3. `AWS_WEB_IDENTITY_TOKEN_FILE`+`AWS_ROLE_ARN` → `web-identity`
4. `AWS_CONTAINER_CREDENTIALS_FULL_URI`|`RELATIVE_URI` → `pod-identity`
5. `AWS_EC2_METADATA_DISABLED` not truthy → `imds` ("falling back to EC2 instance metadata — the node's role")
6. else `imds` with reason "nothing matched and IMDS is disabled"; `create()` throws.

| Mode | Provider (`@aws-sdk/credential-providers`) | Requires (error lists all missing) |
|---|---|---|
| static | `fromEnv()` | key id + secret |
| profile | `fromIni({profile})` | `AWS_PROFILE` |
| web-identity | `fromTokenFile()` → `sts:AssumeRoleWithWebIdentity` | token file + role ARN |
| pod-identity | `fromHttp()` | container URI (+ auth token file for 169.254.170.23) |
| imds | `fromInstanceMetadata({timeout:1000, maxRetries:1})` | IMDS not disabled |

Wrap with `memoize` (`@smithy/property-provider`) so all clients share one STS exchange. `credential-provider.ts`: `describe()` pure; `get()` lazy, caches success only (misconfig shows in panels, retried next request).

**Flavor** (computed in identity-service from the token file): `sub` starts `spiffe://` → "SPIFFE JWT-SVID (spiffe-helper)"; `iss` contains `oidc.eks.<region>.amazonaws.com/id/` → "EKS IRSA"; `sub` starts `system:serviceaccount:` → "Kubernetes projected SA token"; pod-identity host `169.254.170.23` → "EKS Pod Identity", RELATIVE_URI → "ECS task role".

`aws/client-defaults.ts`: `{region, credentials, maxAttempts: 2, requestHandler: {connectionTimeout: 3000, requestTimeout: 10000}}` on every client (blocked egress fails in seconds).

`aws/aws-error.ts` → single line + hint (azure-dash `AzureError.From` analogue): `CredentialsProviderError` (missing vars / "is spiffe-helper or the IRSA webhook running?"), `InvalidIdentityToken` (issuer URL = `iss`, aud in client-id list, JWKS cert publicly trusted), `AccessDenied` on AssumeRoleWithWebIdentity (trust-policy `sub`/`aud` mismatch, quoting the decoded values), `ExpiredToken*` (clock skew / helper stopped), `IDPCommunicationError` (Route not public), 403/`UnauthorizedOperation` (attach `deploy/aws/aws-dash-readonly-policy.json`), timeouts/ENOTFOUND (egress/region), "Region is missing" (set AWS_REGION).

## 5. Identity tab

`GET /api/identity` shape:
```jsonc
{ "mode","reason","flavor","credential_type","region","role_arn","role_session_name","token_file","container_credentials_uri","profile","error",
  "token": {"claims":{"iss","sub","aud","iat","exp"},"issued_at","expires_at","expires_in_seconds","error"},
  "sts": {"account","arn","user_id","principal_type","role_name","session_name","error","hint"},
  "credentials": {"key_prefix":"ASIA|AKIA","key_id_masked":"ASIA…7Q2K","temporary","expiration","expires_in_seconds","account_id","source":["h: token file","k: AssumeRoleWithWebIdentity"]},
  "fetched_at" }
```
Sections: (1) error banner; (2) "How the app authenticates" kv; (3) "Token presented to STS" claims table + expiry countdown (caption per flavor); (4) "What AWS returned" — `GetCallerIdentity`, key prefix legend (AKIA long-lived / ASIA temporary), credential expiry countdown, `$source` decoded (`g` env, `h` token-file env, `k` AssumeRoleWithWebIdentity, `z` HTTP/Pod Identity, `0` IMDS, `n–r,v` profile; unknown shown raw; caption "internal SDK ids, may change"); (5) "Checked at … Raw tokens are never displayed · refresh". `jwt-display.ts` decodes without verifying, returns allow-listed claims only, never the token string (tested on HTML, JSON, and log sink).

**Access-check matrix** (`identity/access-check.ts`): read-only, minimal-page calls — `sts:GetCallerIdentity` (first; if it fails as credential/error, the rest are `skipped`), `iam:ListAccountAliases`, `ec2:DescribeRegions`, `ec2:DescribeInstances/Vpcs/Subnets/SecurityGroups` (`MaxResults:5`), `s3:ListAllMyBuckets` (`MaxBuckets:1`), `eks:ListClusters`, `ecr:DescribeRepositories`, `iam:GetRole` (self, when assumed-role). Classification: `denied` = name ∈ {AccessDenied, AccessDeniedException, UnauthorizedOperation, …} or HTTP 403; `credential` = {CredentialsProviderError, ExpiredToken*, InvalidClientTokenId, InvalidIdentityToken, UnrecognizedClientException}; else `error`. Concurrency 4, cached in the shared TtlCache, "Re-run" = `?refresh=true`. Row: `{action, service, result, code, message, duration_ms}`. Demo: detach the policy → matrix flips to denied live.

## 6. Inventory (`src/inventory/`) — ports azure-dash `AzureService`/`TtlCache`/`LiveAzureProvider`

| Kind | SDK | Item fields |
|---|---|---|
| `account` | STS GetCallerIdentity + IAM ListAccountAliases (403 → "—") | account_id, alias, arn, user_id, partition, region |
| `instances` | EC2 paginateDescribeInstances | id, name(tag), type, state, az, private_ip, public_ip, vpc_id, subnet_id, launch_time, iam_profile |
| `vpcs` | EC2 paginateDescribeVpcs | id, name, cidr, is_default, state |
| `subnets` | EC2 paginateDescribeSubnets | id, name, vpc_id, cidr, az, available_ips, map_public_ip |
| `securitygroups` | EC2 paginateDescribeSecurityGroups → flattened rules (NSG-rules analogue) | group_id, group_name, vpc_id, direction, protocol, ports, peer |
| `s3buckets` | S3 ListBuckets (global; `BucketRegion` from response, no per-bucket calls) | name, region, created |
| `eksclusters` | EKS paginateListClusters + DescribeCluster (cap 20, concurrency 4) | name, version, status, oidc_issuer, endpoint_public/private, auth_mode |
| `ecrrepos` | ECR paginateDescribeRepositories | name, uri, created, tag_mutability, scan_on_push |

`provider.ts` interface + `FakeAwsProvider` (call counts, `fail(kind)`); `mappers.ts` pure; `ttl-cache.ts` = per-key single-flight, keep-last-good on error, epoch `invalidateAll`; `MAX_ITEMS=500` + `truncated`. Stale banner: "Last attempt … failed; showing previously cached data".

`deploy/aws/aws-dash-readonly-policy.json`: `sts:GetCallerIdentity, iam:ListAccountAliases, iam:GetRole, ec2:DescribeRegions/Instances/Vpcs/Subnets/SecurityGroups, s3:ListAllMyBuckets, eks:ListClusters, eks:DescribeCluster, ecr:DescribeRepositories` on `*`.

## 7. Load controls (Node specifics)

- **CPU** (`load/cpu-load.ts`): `worker_threads` `Worker` with `eval: true` inline script spinning on a `SharedArrayBuffer` stop flag (no dist-path issues under tsx/vitest/dist). `start(n)` clamps, idempotent; `stop()` sets flag, races exit vs 2 s then `terminate()`. Injectable `workerFactory` for tests.
- **Memory** (`load/memory-load.ts`): async loop allocating 64 MiB `Buffer.allocUnsafe` chunks and `fill(0x5a)` (touches pages), `await setImmediate()` between chunks so probes keep answering. Off-heap → not capped by `--max-old-space-size`; the cgroup limit is what kills it → **OOMKilled / exit 137** (k8s card then shows `lastState.terminated.reason`). Status `{active, target_mib, allocated_mib, phase, rss_bytes, external_bytes, constrained_bytes: process.constrainedMemory(), cgroup_limit_bytes}`; controls card warns when target > cgroup limit.

## 8. Metrics (`/metrics`, prom-client default registry + `collectDefaultMetrics()`)

`aws_dash_info{version,node_version,auth_mode}`, `aws_dash_start_time_seconds`, `aws_dash_probe_live/ready`, `aws_dash_cpu_load_workers`, `aws_dash_memory_load_allocated_bytes/target_bytes`, `aws_dash_cgroup_memory_limit_bytes/usage_bytes`, `aws_dash_cgroup_cpu_limit_cores`, `aws_dash_credential_expiry_seconds{mode}` (from memoized creds, no STS call on scrape), `aws_dash_token_file_expiry_seconds`, `aws_dash_credential_resolutions_total{mode,result}`, `aws_dash_inventory_fetch_duration_seconds{kind}` (histogram), `aws_dash_inventory_fetch_errors_total{kind}`, `aws_dash_inventory_last_success_timestamp_seconds{kind}`, `aws_dash_access_check_allowed{action}`, `aws_dash_http_requests_total{method,route,status}`.

## 9. Runtime card, side cards, UI

- **Runtime** (`runtime/runtime-info.ts`, `collect(root, env)` injectable as in both siblings): hostname; container runtime via `/run/.containerenv`, `/.dockerenv`, `$container`, `/proc/self/cgroup`; orchestrator via `KUBERNETES_SERVICE_HOST`/SA namespace file; downward API fields; cgroup v2 `cpu.max`/`memory.max`/`memory.current` with v1 fallback ("max"/negative/≥2^62 = unlimited; EACCES → null, never throw); `/etc/os-release`; Node version, `availableParallelism`, `constrainedMemory`, `availableMemory`; uid/gid/pid; loadavg; uptime; probe + load badges.
- **IMDS** (`imds/imds-client.ts`): IMDSv2 PUT token → GET instance-id, instance-type, AZ, region, local-ipv4, identity document. undici dispatcher injectable, 1 s timeout, no proxy, cached; "unavailable" is normal (hop-limit 1 / Auto Mode / off-AWS) with caption "this is the node, not the pod".
- **Kubernetes** (`k8s/k8s-info.ts`): `KubeConfig.loadFromCluster()`, `CoreV1Api.readNamespacedPod` + `readNode`; shows phase, restarts, `lastState.terminated` (OOMKilled!), node instance type/zone/labels; 403 on node → hint, pod still shown; off-cluster → unavailable.
- **SPIFFE** (`identity/spiffe-panel.ts`): `createClient()` from `SPIFFE_ENDPOINT_SOCKET`; `fetchX509SVID` first message → `parseCertificate` → SPIFFE ID SAN, not-after; `fetchJWTSVID({audience:[SPIFFE_JWT_AUDIENCE]})` → decoded claims via `jwt-display`. Never raw SVIDs. Socket unset → `available:false`.
- **UI**: `routes/render.ts` decorates `reply.page(name, data)` (wraps in `layout.eta`) and `reply.partial(name, data)` using one `Eta` instance (`autoEscape`, `cache` in prod). Pages `include` the same partials so each fragment has one template. htmx: runtime `every 5s`; inventory panels `load, refresh` + "Refresh all" (`hx-post=/api/aws/refresh` then `hx-on::after-request` triggers `refresh` on all panels — verbatim azure pattern); identity cards `load` + manual refresh; controls swap `#controls` outerHTML, crash uses `hx-confirm`. CSS ported from azure-dash `site.css` with `--accent:#ff9900`, `--topbar:#232f3e`; add matrix badges + memory progress bar.

## 10. Build & container

- `tsconfig`: NodeNext, ES2023, strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `outDir dist`; `.js` extensions in imports; `type: module`.
- Scripts: `dev` (tsx watch), `build` (tsc), `start`, `test` (vitest run), `typecheck`, `healthcheck`, `kustomize:check`. `engines: {"node": ">=24 <27"}`.
- **Containerfile**: build stage `--platform=$BUILDPLATFORM ubi10/nodejs-24` → `npm ci --ignore-scripts`, `npm run build`, `npm prune --omit=dev --omit=optional` (keeps node_modules pure-JS ⇒ arch-independent, single multi-platform build with no QEMU RUN in the final stage — same trick as azure-dash's cross-compile); runtime `ubi10/nodejs-24-minimal`, `COPY --chown=1001:0` dist/node_modules/views/public, `chmod g=u`, `USER 1001`, no `runAsUser` in manifests (restricted-v2 arbitrary UID), `EXPOSE 8080`, `HEALTHCHECK CMD ["node","dist/cli.js","--healthcheck"]` (needs `podman build --format docker`), `CMD ["node","dist/server.js"]`. OCI labels incl. `io.openshift.expose-services="8080:http"`.
- `scripts/run-podman.sh`: forwards `AWS_*`/`AUTH_MODE`/etc, optional `~/.aws` mount for profile mode, `--cpus 1 --memory 512m` so the memory control OOMs locally.
- CI: test job → multi-arch buildx push to `ghcr.io/kenmoini/aws-dash`; `kubectl kustomize` every overlay; placeholder check. Dependabot: npm, docker, github-actions.

## 11. Deploy (Kustomize; base has empty `initContainers`/`volumes`/`volumeMounts` so overlays JSON-patch `/-`)

**Base `deploy/kubernetes`**: ns `aws-dash`, SA, ConfigMap (`AUTH_MODE=auto`, `AWS_REGION`, TTL, flags), `secret.example.yaml` (`aws-dash-credentials`), Deployment (`envFrom` CM + optional secretRef, downward env, probes `/healthz/live` 10s/5s/3 & `/healthz/ready` 5s/2, 100m/128Mi→1/512Mi, `runAsNonRoot`, seccomp RuntimeDefault, drop ALL, no `runAsUser`), Service 8080, `rbac.yaml` (Role `get pods`). `deploy/components/node-reader` (ClusterRole `get nodes`) opted into by overlays.

| Overlay | Key objects/patches | README runbook essentials |
|---|---|---|
| `openshift` | Route (edge), `AWS_EC2_METADATA_DISABLED=true`, gitignored `secret.yaml` | `aws iam create-user/create-access-key` + attach policy — "the baseline you're eliminating"; Identity shows `static`, `AKIA`, `$source g` |
| `eks-irsa` | SA annotation `eks.amazonaws.com/role-arn`, `AUTH_MODE=web-identity`, node-reader | `eksctl utils associate-iam-oidc-provider`; trust policy Federated=cluster OIDC provider, `sub=system:serviceaccount:aws-dash:aws-dash`, `aud=sts.amazonaws.com`; `rollout restart` note; expect flavor "EKS IRSA" |
| `eks-pod-identity` | `AUTH_MODE=pod-identity` (explicit so a missing association errors instead of silently falling to node role), node-reader | `aws eks create-addon --addon-name eks-pod-identity-agent`; trust `Principal.Service=pods.eks.amazonaws.com`, `sts:AssumeRole`+`sts:TagSession`; `aws eks create-pod-identity-association`; expect `aud pods.eks.amazonaws.com`, session tags |
| `openshift-native-oidc` | Route; projected `serviceAccountToken` (aud `sts.amazonaws.com`, 3600s) at `/var/run/secrets/aws/token`; `AWS_ROLE_ARN` CM; `AUTH_MODE=web-identity`; IMDS disabled | `oc get authentication cluster -o jsonpath='{.spec.serviceAccountIssuer}'`; reuse existing IAM OIDC provider on ROSA/STS clusters else create; default `https://kubernetes.default.svc` issuer isn't public → use ztwim |
| `ztwim` | ns `aws-dash-ztwim`; Route; **`clusterspiffeid.yaml`** (explicit template, namespaceSelector); **static** `spiffe-helper` ConfigMap (`agent_address=/spiffe-workload-api/spire-agent.sock`, `jwt_svids=[{jwt_audience="aws-dash", jwt_svid_file_name="/var/run/secrets/aws/token"}]`, `jwt_svid_file_mode=0644`); volumes: CSI `csi.spiffe.io` ro, helper CM, `aws-token` emptyDir `medium: Memory`; **native sidecar** `spiffe-helper` (`initContainers`, `restartPolicy: Always`, `-daemon-mode=true`, image `registry.redhat.io/zero-trust-workload-identity-manager/spiffe-helper-rhel9:<pinned>`); app mounts token dir ro **and** CSI socket at `/spiffe-workload-api`; env `AUTH_MODE=web-identity`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_SESSION_NAME=aws-dash`, `SPIFFE_ENDPOINT_SOCKET=unix:///spiffe-workload-api/spire-agent.sock`, `SPIFFE_JWT_AUDIENCE=aws-dash`, IMDS disabled | Prereqs: ZTWIM CRs; `SpireServer.jwtIssuer` (+ `jwtKeyType: rsa-2048` — same server already serves azure-dash); `SpireOIDCDiscoveryProvider` `managedRoute` + cert-manager/LE `externalSecretRef`; curl `.well-known` + JWKS + cert chain; `aws iam create-open-id-connect-provider --url $JWT_ISSUER --client-id-list aws-dash`; trust policy `aud=aws-dash`, `sub=spiffe://$TD/ns/aws-dash-ztwim/sa/aws-dash`; verify token file starts `eyJ`, Identity flavor "SPIFFE JWT-SVID", SPIFFE panel X.509 SAN == `sub`, `iat/exp` advance between loads; alternative: `github.com/kenmoini/ztwim-oidc-shims` webhook injects all of this from one annotation; troubleshooting table |

`deploy/README.md`: overlay matrix (platform, credential, secret-in-cluster?, trust principal, condition keys) + shared AWS prereqs. `scripts/check-placeholders.sh` fails CI if a placeholder (`AWS_ACCOUNT_ID`, `000000000000`) isn't named in that overlay's README (closes the sibling drift gap).

## 12. Tests (vitest 5, `fastify.inject()`, hand-written fakes, zero AWS calls)

config (defaults, every invalid message) · health/state · controls (403, 422 table, HX vs JSON, crash → fake exit after 500 ms with cpu/memory stopped) · cpu-load (clamp, idempotent, one real worker < 2 s) · memory-load (incremental chunks, phases, 409, release, cap) · runtime-info (FakeRoot cgroup v1/v2/none, EACCES, podman/docker/cri-o, downward) · jwt-display (base64url, array aud, never raw) · credential-factory (table-driven auto order, explicit modes, missing-var messages, flavor) · identity-service (**never renders raw tokens** in HTML/JSON/log sink; token unreadable → error but STS still tried; hint per STS error; `$source` decode) · access-check (classification by name/403, skip-on-credential-failure, concurrency, cache/refresh, subset) · aws-error rows · ttl-cache (single-flight, keep-last-good, epoch) · inventory routes + mappers (rule flattening, tag→name) · imds (undici MockAgent, timeout, disabled, cached) · spiffe-panel (fake client, generated test cert SAN) · k8s-info (403 node, OOMKilled lastState, off-cluster) · metrics · pages (hx attrs, nav) · cli healthcheck.

## 13. Implementation phases (each a shippable increment; TDD per task)

**Phase 0** — commit `docs/superpowers/specs/2026-09-27-aws-dash-design.md` (this plan condensed).

**Phase 1 — Scaffold + runtime-only dashboard** (image works with no AWS at all): package/tsconfig/vitest/pinned deps → `env`/`config`/`logging`/`clock` → `app.ts`/`server.ts`/`render`/`htmx`/`input` → state + health → cpu-load → memory-load → controls routes → runtime-info → layout/index/runtime/controls views + CSS + htmx → `cli --healthcheck` → Containerfile + `run-podman.sh` + `podman build --format docker` smoke → CI + Dependabot → `deploy/kubernetes` base + `deploy/openshift` + `kustomize-check.sh`.

**Phase 2 — Credentials + inventory** (static keys end-to-end): client-defaults + aws-error → auth-mode + credential-factory + credential-provider → models/kinds/provider → ttl-cache → inventory-service + FakeAwsProvider → inventory routes → mappers → live-provider (8 kinds) → aws page + panels → readonly policy JSON + static-key README → metrics skeleton + `/metrics` with inventory metrics → live check via `run-podman.sh` with a real key.

**Phase 3 — Identity tab + EKS/OIDC overlays**: jwt-display → identity-service (+ raw-token test) → identity route/page/claims-table → access-check + partial → imds-client + partial → identity/token/access-check metrics → `eks-irsa`, `eks-pod-identity`, `openshift-native-oidc` overlays + READMEs + trust-policy JSON → `check-placeholders.sh` in CI → live EKS verification (record session-name format, `$source` values, IMDS hop-limit behaviour into docs).

**Phase 4 — SPIFFE panel, Kubernetes card, ZTWIM**: spiffe-panel + route/partial → k8s-info + route/partial → `rbac.yaml` + node-reader component → `deploy/ztwim` (kustomization, clusterspiffeid, static helper.conf CM, identity CM, route) → ztwim README → `aws_dash_http_requests_total` hook → live OpenShift/ZTWIM verification (capture spiffe-helper file format).

**Phase 5 — Docs**: top-level README (modes table, run locally, endpoints, config, demo script incl. memory→OOMKilled and policy-detach→matrix flips, security note: controls unauthenticated/no CSRF, troubleshooting), `deploy/README.md`, drift pass (README env vars ↔ `config.ts`, endpoints ↔ routes, placeholders ↔ sed).

## 14. Verification

- `npm test` — all green, nothing reaches AWS; `npm run typecheck`.
- `npm run dev` with `AWS_PROFILE` → `/`, `/aws` (each panel shows data or an explicit IAM error), `/identity` (mode `profile`, STS ARN, matrix, IMDS/k8s/SPIFFE unavailable), `/metrics`; controls flip probes; memory control grows RSS in `/api/state`.
- `podman build --format docker` + `scripts/run-podman.sh` in static mode: HEALTHCHECK healthy; `--memory 512m` + memory control 600 MiB → container exits 137.
- `kubectl kustomize deploy/<each>` renders; placeholder check passes.
- **EKS** (both overlays): Identity shows the right flavor, decoded `sub`/`aud`, STS `assumed-role/...`; `printenv | grep AWS_` matches README; demo script (readiness → endpoints drop; liveness → restart ~15 s; CPU → `kubectl top`; memory → `OOMKilled` in k8s card; crash → restart count; detach policy → matrix flips).
- **OpenShift + ZTWIM**: `oc logs -c spiffe-helper` shows SVID written; token file begins `eyJ`; Identity flavor "SPIFFE JWT-SVID", `sub` = SPIFFE ID = SPIFFE panel X.509 SAN; two loads minutes apart show `iat/exp` advance; after the STS credential `exp` passes, "Refresh all" still succeeds (SDK re-read the rotated file).

## 15. Risks to verify empirically (documented in READMEs as they're resolved)

1. AWS accepting the SPIRE issuer: public cert on the Route; ES256 vs `rsa-2048`; exact `iss` string equality (scheme/path/trailing slash) across `SpireServer.jwtIssuer`, token, and `--url`.
2. spiffe-helper file format — raw compact JWT (SDK `fromTokenFile` does no normalization) vs base64-wrapped; `jwt_svid_file_mode` honoured; native-sidecar support with the Red Hat image.
3. EKS Pod Identity session-name format; whether `AWS_ROLE_SESSION_NAME` is ignored; projected-token file mode under arbitrary UID (`openshift-native-oidc` may need `defaultMode: 0640`).
4. `$source` is `@internal` in the SDK — display with caveat, tolerate unknown ids.
5. `memoize` gives one STS call per session across clients and re-reads the rotated file on refresh.
6. cgroup EACCES on OpenShift; `process.constrainedMemory()` returning 0.
7. IMDS hop-limit 1 (Auto Mode) — 1 s timeout must hold on a silently dropped PUT.
8. `--omit=optional` leaves no native addon in node_modules (check in CI with `npm ls`).
9. `@kubernetes/client-node` 2.0 in-cluster on OpenShift (CA/token paths, `ws` optional deps absent).
