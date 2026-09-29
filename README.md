# aws-dash

A small dashboard that shows where its container is running, lets you break its health probes, burn CPU, fill memory
or crash it, lists AWS resources, and explains — claim by claim — how it authenticated to AWS. It exists to make one
point visible: **the same image runs unchanged on EKS (Pod Identity or IRSA), on any Kubernetes with static keys, and
on OpenShift with the cluster's own OIDC issuer or a SPIFFE JWT-SVID from the Zero Trust Workload Identity Manager.
Only environment variables change.**

The AWS sibling of [gcp-dash](https://github.com/kenmoini/gcp-dash) and [azure-dash](https://github.com/kenmoini/azure-dash).

## What you see

- **Runtime** — hostname, container runtime, orchestrator, downward-API pod fields, cgroup CPU/memory limits and
  usage, Node version, uid/gid, load average; refreshes every 5 s. **Controls**: readiness and liveness toggles, a CPU
  burner, a memory filler that can push the container past its cgroup limit (exit 137, `OOMKilled`), and a crash button.
- **AWS** — eight read-only inventory panels (account, instances, VPCs, subnets, security-group rules, S3 buckets, EKS
  clusters, ECR repositories), each cached for a TTL and failing closed with an actionable hint that keeps the last good data.
- **Identity** — five cards: how the app authenticates (mode, why, flavor, decoded federated token, what STS returned,
  credential facts with the key prefix and SDK source ids), an access-check matrix of eleven read-only IAM actions, the
  node's EC2 instance metadata, the pod's SPIFFE X.509/JWT SVIDs read from the SPIRE Workload API, and the pod and node
  as the Kubernetes API sees them. Raw tokens, keys and SVIDs are never displayed or logged.
- **/metrics** — Prometheus text, including credential and token expiry countdowns computed from cached state.

## Run locally

```bash
npm install
npm run dev            # http://localhost:8080 — JSON logs; pipe through `npx pino-pretty` for colour
AWS_PROFILE=<profile> AWS_REGION=us-east-1 npm run dev   # AWS tab with your local credentials
npm test               # vitest; nothing touches the network
npm run typecheck
npm run docs:check     # README routes/variables/metrics and deploy placeholders match the code
```

What to expect on a laptop: the Runtime tab shows `orchestrator: none` and no cgroup limits; with `AWS_PROFILE` the AWS
tab lists your account's resources (or an explicit IAM error per panel); the Identity tab shows mode `profile`, the STS
caller ARN and the access-check matrix, while the IMDS, SPIFFE and Kubernetes cards read "Unavailable" with the reason.
Without credentials, `auto` falls through to `imds`: the Identity card reads mode `imds` with the hint "the EC2 instance
metadata service is unreachable…", and the AWS panels ask for `AWS_REGION` if none is set. Run
`AWS_EC2_METADATA_DISABLED=true npm run dev` (what the container always does) to see the "no credentials found" hint
instead. Either is the expected state on a laptop.

Container (the `HEALTHCHECK` is only kept with `--format docker`):

```bash
podman build --format docker -t localhost/aws-dash:dev .
scripts/run-podman.sh                       # no credentials: Runtime tab + controls only
AWS_PROFILE=demo scripts/run-podman.sh      # mounts ~/.aws read-only
```

`run-podman.sh` forwards `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`,
`AWS_DEFAULT_REGION`, `AWS_PROFILE`, `AUTH_MODE`, `AWS_CACHE_TTL_SECONDS`, `CONTROLS_ENABLED`, `LOG_LEVEL`, `AWS_DEBUG`,
`IMDS_ENABLED` and `MEMORY_LOAD_MAX_MIB` when set, always sets `AWS_EC2_METADATA_DISABLED=true`, and runs with
`--cpus 1 --memory 512m` so the memory control can demonstrate an OOM kill: allocate more than 512 MiB and the container
exits 137.

Published image: `ghcr.io/kenmoini/aws-dash:main` (also `latest`, tags and short SHAs), multi-arch, built from
`registry.access.redhat.com/ubi10/nodejs-24-minimal`; it runs as UID 1001 / GID 0 and needs no `runAsUser`.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/` | Runtime page (refreshes every 5 s) + Controls |
| GET | `/healthz/live`, `/healthz/ready` | `{"status":"ok"}` or 503 `{"status":"failing","reason":"…"}` |
| GET | `/api/state`, `/api/runtime` | JSON |
| GET | `/partials/runtime`, `/partials/controls` | htmx fragments |
| POST | `/controls/liveness`, `/controls/readiness` | form/query `enabled=true\|false` |
| POST | `/controls/cpu` | `enabled`, `workers` 1–64 (clamped to cores) |
| POST | `/controls/memory` | `enabled`, `mib` 1–`MEMORY_LOAD_MAX_MIB`; 409 if already active |
| POST | `/controls/crash` | `exit_code` 0–255 → 202, exits 500 ms later |
| GET | `/aws` | AWS page: header card + 8 lazy panels |
| GET | `/api/aws/{kind}[?refresh=true]` | `{kind, fetched_at, error, items, truncated}`; kinds: account, instances, vpcs, subnets, securitygroups, s3buckets, eksclusters, ecrrepos |
| GET | `/partials/aws/{kind}[?refresh=1]` | htmx panel |
| POST | `/api/aws/refresh` | expire every cache — inventory, identity, access-check, IMDS, SPIFFE, Kubernetes → 204 |
| GET | `/identity` | Identity page: auth-mode card, decoded token, STS identity, credential facts, access-check matrix, IMDS card, SPIFFE card, Kubernetes card |
| GET | `/api/identity[?refresh=true]` | `{mode, reason, flavor, …, token, sts, credentials, fetched_at}` — how the app authenticates, the decoded token, what STS returned, and credential facts |
| GET | `/partials/identity` | htmx fragment |
| GET | `/api/access-check[?refresh=true]` | `{enabled, fetched_at, principal_arn, error, rows[{action, service, result, code, message, duration_ms}]}` |
| GET | `/partials/access-check` | htmx fragment |
| GET | `/api/imds[?refresh=true]` | `{available, reason, instance, fetched_at}` |
| GET | `/partials/imds` | htmx fragment |
| GET | `/api/spiffe[?refresh=true]` | `{available, reason, socket, x509{spiffe_id, san_uris, serial, issuer, not_before, not_after, expires_in_seconds}, x509_error, jwt{claims, issued_at, expires_at, error, spiffe_id, audience}, fetched_at}` |
| GET | `/partials/spiffe` | htmx fragment |
| GET | `/api/k8s[?refresh=true]` | `{available, reason, pod{name, namespace, node, phase, started_at, service_account, qos_class, containers[…]}, node{…}, node_error, fetched_at}` |
| GET | `/partials/k8s` | htmx fragment |
| GET | `/metrics` | Prometheus text; 404 when `METRICS_ENABLED=false` |

Requests with `HX-Request: true` get HTML fragments; everything else gets JSON. `refresh=true` (or `1`) bypasses the
cache for that call. Bad input → 422 `{"detail":…}`; all controls → 403 `{"detail":"controls are disabled (CONTROLS_ENABLED=false)"}`
when `CONTROLS_ENABLED=false`. Unknown paths → 404 `{"detail":"not found: METHOD /path"}`. Every cloud or cluster failure
is a 200 whose body carries an `error`/`reason` field — the cards render it; nothing returns a 500 for a failed lookup.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | listen address |
| `CONTROLS_ENABLED` | `true` | `false` hides and blocks the controls |
| `LOG_LEVEL` | `info` | pino level |
| `MEMORY_LOAD_MAX_MIB` | `4096` | upper bound for the memory control |
| `CPU_LOAD_MAX_WORKERS` | CPU count | upper bound for the CPU control |
| `AUTH_MODE` | `auto` | `auto\|static\|profile\|web-identity\|pod-identity\|imds` — `auto` checks the sources in the order under Credential modes |
| `AWS_REGION` | — | falls back to `AWS_DEFAULT_REGION`; required for the AWS tab |
| `AWS_CACHE_TTL_SECONDS` | `60` | how long a cached result — inventory, identity, access-check, IMDS, SPIFFE, Kubernetes — is served before it's refetched |
| `AWS_DEBUG` | `false` | logs SDK request metadata |
| `METRICS_ENABLED` | `true` | `false` → `/metrics` returns 404 |
| `IMDS_ENABLED` | `true` | `false` → the IMDS card renders an "Unavailable: disabled…" state and skips the probe, instead of being hidden |
| `ACCESS_CHECK_ENABLED` | `true` | `false` → the access-check matrix renders a "Disabled (…)" state instead of being hidden |
| `ACCESS_CHECK_ACTIONS` | unset = all | comma-separated subset of the 11 access-check actions (see `src/identity/access-check-actions.ts`); `sts:GetCallerIdentity` always runs |
| `K8S_INFO_ENABLED` | `true` | `false` → the Kubernetes card renders a disabled state and never builds an API client |
| `SPIFFE_ENDPOINT_SOCKET` | unset | e.g. `unix:///spiffe-workload-api/spire-agent.sock` (a plain path is accepted too); unset → the SPIFFE card says so and never opens the socket |
| `SPIFFE_JWT_AUDIENCE` | `aws-dash` | audience of the *display* JWT-SVID fetch — the credential path's audience is spiffe-helper's `helper.conf` |

Read by the AWS SDK rather than the app, and shown on the Identity card when set: `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`,
`AWS_ROLE_SESSION_NAME`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`,
`AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`, `AWS_EC2_METADATA_DISABLED` (set it to `true` anywhere that is not EC2, so the
chain never waits on the instance metadata service). `NODE_ENV=production` (set in the image) turns on template caching.

Downward API variables shown on the Runtime tab and used by the Kubernetes card: `POD_NAME`, `POD_NAMESPACE`,
`NODE_NAME`, `POD_IP`, `SERVICE_ACCOUNT`; `KUBERNETES_SERVICE_HOST` is how the app knows it is in a cluster.

### Credential modes

`auto` checks the sources in this order; note the SDK's own default chain prefers `AWS_PROFILE` over environment
keys when both are set — set only one. Any mode can also be forced explicitly by setting `AUTH_MODE`, in which case a
missing variable is reported on the Identity card and the AWS panels instead of silently falling through.

| Mode | Selected in `auto` when | SDK provider | Identity card flavor |
|---|---|---|---|
| `static` | `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are both set | `fromEnv` | long-lived IAM user access key (`AKIA…`) |
| `profile` | `AWS_PROFILE` is set | `fromIni` | shared config profile |
| `web-identity` | `AWS_WEB_IDENTITY_TOKEN_FILE` and `AWS_ROLE_ARN` are both set | `fromTokenFile` → `sts:AssumeRoleWithWebIdentity` | EKS IRSA / Kubernetes projected service-account token / SPIFFE JWT-SVID (spiffe-helper), from the token's `iss`/`sub` |
| `pod-identity` | `AWS_CONTAINER_CREDENTIALS_FULL_URI` or `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` is set | `fromHttp` (container credentials endpoint) | EKS Pod Identity / ECS task role |
| `imds` | none of the above matched (the fallback) | `fromInstanceMetadata` (the node's/instance's role) | EC2 instance role (IMDS) |

## Metrics

`/metrics` serves the Node process defaults plus these. Gauges are computed from cached state at scrape time: a scrape
never calls AWS, IMDS, the SPIRE agent or the Kubernetes API.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `aws_dash_info` | gauge | `version`, `node_version`, `auth_mode` | always 1; `auth_mode` is the resolved mode |
| `aws_dash_start_time_seconds` | gauge | | process start, epoch seconds |
| `aws_dash_probe_live`, `aws_dash_probe_ready` | gauge | | 1 while the probe is enabled via the controls |
| `aws_dash_cpu_load_workers` | gauge | | CPU-burner worker threads running |
| `aws_dash_memory_load_allocated_bytes`, `aws_dash_memory_load_target_bytes` | gauge | | memory control progress |
| `aws_dash_cgroup_memory_limit_bytes`, `aws_dash_cgroup_memory_usage_bytes`, `aws_dash_cgroup_cpu_limit_cores` | gauge | | from the container's cgroup; -1 when unlimited or unknown |
| `aws_dash_inventory_fetch_duration_seconds` | histogram | `kind` | AWS panel fetches |
| `aws_dash_inventory_fetch_errors_total` | counter | `kind` | failed fetches |
| `aws_dash_inventory_last_success_timestamp_seconds` | gauge | `kind` | last good fetch per kind |
| `aws_dash_http_requests_total` | counter | `method`, `route`, `status` | every response, by route pattern |
| `aws_dash_credential_expiry_seconds` | gauge | `mode` | seconds until the AWS credentials actually in use expire; fed by a tap inside the shared credential provider, so any panel's resolution updates it; -1 until the first resolution, and for long-lived keys with no expiry |
| `aws_dash_token_file_expiry_seconds` | gauge | | seconds until the web-identity token file expires, as of the last Identity-tab load |
| `aws_dash_credential_resolutions_total` | counter | `mode`, `result` | real credential resolutions (a memoized cache hit does not count) |
| `aws_dash_access_check_allowed` | gauge | `action` | 1 when the last access check allowed the action, else 0 |

## Deploy

See [deploy/README.md](deploy/README.md) for the overlay matrix and what each one should show. Quick start on any
cluster: `kubectl apply -k deploy/kubernetes` (static keys). Workload-identity overlays:
[`deploy/eks-irsa`](deploy/eks-irsa/README.md), [`deploy/eks-pod-identity`](deploy/eks-pod-identity/README.md),
[`deploy/openshift-native-oidc`](deploy/openshift-native-oidc/README.md), [`deploy/ztwim`](deploy/ztwim/README.md).

## Permissions

The AWS tab needs nothing beyond [`deploy/aws/aws-dash-readonly-policy.json`](deploy/aws/aws-dash-readonly-policy.json)
attached to whichever principal `AUTH_MODE` resolves to. `sts:GetCallerIdentity` (the Account panel's identity
check) needs no IAM permission at all; every other panel fails closed with an actionable hint — keeping its
last successfully fetched data — when the policy is missing or incomplete.

The Kubernetes card needs the Role in `deploy/kubernetes/rbac.yaml` (`get pods`) and, for the node section, the
`node-reader` component (`get nodes`). The SPIFFE card needs only the SPIRE agent socket mounted by the `ztwim` overlay.

## Demo

Three acts; each step names what to click, what to run, and what you should see. Steps 1–5 work with no credentials at
all; 6–9 need the AWS tab working; 10–12 need a workload-identity overlay.

Reach the app with `kubectl -n aws-dash port-forward svc/aws-dash 8080:8080` (namespace `aws-dash-ztwim` on the `ztwim`
overlay, and substitute it in every `kubectl -n aws-dash` below). A port-forward keeps working while the pod is unready; a
Route answers 503 as soon as step 1 removes the only replica from the Service, so through a Route you cannot click step 2
until the pod restarts or you `kubectl -n aws-dash delete pod -l app=aws-dash`. Step 3 needs metrics-server, which EKS
does not install by default.

**Act 1 — the container is a real thing (Runtime tab)**

1. **Fail readiness** → `kubectl -n aws-dash get endpoints -w` shows the pod leave the Service; `/healthz/ready` returns 503.
2. **Fail liveness** → the container restarts after ~15 s (three failed probes) and every control resets.
3. **CPU load → Start** with 2 workers → `kubectl top pod -n aws-dash`; `aws_dash_cpu_load_workers` reads 2.
4. **Memory load → Allocate** more than the 512 Mi limit → the Memory load bar in Controls climbs, then the container dies:
   `kubectl -n aws-dash get pod -o jsonpath='{.items[0].status.containerStatuses[0].lastState}'` shows `OOMKilled`, exit 137.
5. **Crash** with exit code 3 → `lastState.terminated.exitCode: 3` and the restart count goes up.

**Act 2 — least privilege, live (AWS tab)**

6. Open **AWS**: each panel lists resources or an explicit hint. Scrape `/metrics` (`curl -s localhost:8080/metrics | grep aws_dash_`) meanwhile.
7. Detach the read-only policy from the principal, click **Refresh all** → every panel except Account shows the
   `AccessDenied` hint but keeps its last data (`sts:GetCallerIdentity` needs no permission); re-attach to recover.
8. Open **Identity → Access check**, click **re-run** while the policy is detached: every row except `sts:GetCallerIdentity`
   flips to *denied* (`iam:GetRole` reads *skipped* when the caller is an IAM user rather than an assumed role); re-attach and
    re-run to watch them turn *allowed*.
9. Wait past `AWS_CACHE_TTL_SECONDS` and reload: `aws_dash_credential_resolutions_total` did not increment — the
   memoized credentials are reused until they expire.

**Act 3 — who am I, and how does AWS know (Identity tab)**

10. Read the **Workload identity** card top to bottom: the mode and *why* it was chosen, the flavor, the decoded
    `iss`/`sub`/`aud` of the token presented to STS, the STS caller ARN (`assumed-role/…`), the `ASIA…` key prefix and the
    SDK source ids. The raw token is never shown.
11. Trigger the memory control past the limit again, wait for the restart, then open **Kubernetes**: the container's
    last state reads `OOMKilled (exit 137)` and the restart count went up; on the EKS and ztwim overlays the node section
    shows the instance type and zone.
12. On the `ztwim` overlay, open **SPIFFE workload identity**: the X.509 SPIFFE ID carries the badge *same as the token sub
    presented to STS*; reload after five minutes to watch the JWT-SVID's `iat`/`exp` advance while STS keeps working —
    the SDK re-reads the file spiffe-helper rotates.

## Troubleshooting

Every hint below is the text the app renders; search for it in the card or panel you are looking at.

| You see | It means | Do |
|---|---|---|
| `auto: no credentials found (set AWS_ACCESS_KEY_ID/…)` | `AUTH_MODE=auto` matched nothing and `AWS_EC2_METADATA_DISABLED=true` (otherwise you see the IMDS row below) | set the variables for one mode, or on Kubernetes create the Secret and restart the pod |
| `AWS_REGION is not set; set it in the ConfigMap or environment` | no region for the SDK | set `AWS_REGION` (or `AWS_DEFAULT_REGION`) |
| `AccessDenied … grant the identity the read-only policy in deploy/aws/aws-dash-readonly-policy.json` | the principal lacks the policy | attach it; new policies take a few seconds to apply |
| `the web-identity token file is missing or unreadable; is the spiffe-helper sidecar or the IRSA webhook running?` | `AWS_WEB_IDENTITY_TOKEN_FILE` points at nothing | `kubectl exec … -- ls -l <file>`; check the sidecar/webhook |
| `InvalidIdentityToken … the IAM OIDC provider URL must equal the token's iss …` | STS could not validate the token | compare the provider URL with the card's `iss`; check `aud` is in the client-id list and the JWKS is served over a publicly trusted certificate |
| `IDPCommunicationError … the SPIRE OIDC Route must be public with a trusted certificate` | STS could not fetch the issuer's discovery document | expose the Route publicly with a cert-manager/ACME certificate |
| `AccessDenied … the role's trust policy rejected this identity: its StringEquals conditions …` | trust policy `sub`/`aud` mismatch | compare the decoded claims on the card with the trust policy |
| `ExpiredToken … check clock skew, or whether the sidecar that refreshes the token file has stopped` | stale token file | `oc logs -c spiffe-helper`; check node time |
| `the EC2 instance metadata service is unreachable …` (credential error) | the chain fell through to IMDS off EC2 | provide credentials for another mode or set `AWS_EC2_METADATA_DISABLED=true` |
| `network egress to AWS is blocked or the region endpoint is wrong` | timeouts / DNS failures to AWS | check egress, proxies, the region |
| IMDS card: `IMDS did not answer within 1s: not running on EC2, or the pod cannot reach IMDS (hop limit 1, EKS Auto Mode)` | normal off EC2 and on hardened nodes | nothing; it describes the node, not the pod |
| Kubernetes card: `forbidden: the service account cannot get pods — apply deploy/kubernetes/rbac.yaml` | missing Role | apply the base again |
| Kubernetes card: `forbidden: the service account cannot get nodes — add the node-reader component` | node section needs cluster RBAC | add `components: [../components/node-reader]` to your overlay |
| Kubernetes card: `not running in Kubernetes (KUBERNETES_SERVICE_HOST is not set)` | running outside a cluster | expected locally |
| SPIFFE card: `SPIFFE_ENDPOINT_SOCKET is not set: no SPIRE Workload API socket is mounted` | not the `ztwim` overlay | expected everywhere else |
| SPIFFE card: `SPIRE agent not reachable at unix:///…: is the csi.spiffe.io volume mounted and the agent running?` | socket present but no agent | `oc get csidriver csi.spiffe.io`; check the agent DaemonSet |
| SPIFFE card: `the SPIRE agent refused this workload: no registration entry matches this pod` | no ClusterSPIFFEID matches | `oc get clusterspiffeid`; check the namespace and `app: aws-dash` labels |
| Controls return 403 `controls are disabled (CONTROLS_ENABLED=false)` | controls switched off in the ConfigMap | set `CONTROLS_ENABLED: "true"` for the demo, then turn it off again |
| No `HEALTHCHECK` in `podman inspect` | image built in OCI format | rebuild with `podman build --format docker` |

Verification records for the live platforms — what has and has not been observed on real clusters — are in
[docs/verification/eks-phase3.md](docs/verification/eks-phase3.md) and [docs/verification/ztwim-phase4.md](docs/verification/ztwim-phase4.md).

## Security

The controls are unauthenticated and have no CSRF protection by design — this is a demo. Do not expose it to the
internet with `CONTROLS_ENABLED=true`; on OpenShift, set `CONTROLS_ENABLED: "false"` in the ConfigMap or delete the
Route when the demo is not running. The dashboard shows account ids, role ARNs, instance ids and node private IPs to
anyone who can reach it — that is the point, and the reason it should not be reachable from outside your audience.
