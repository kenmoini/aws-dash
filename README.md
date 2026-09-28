# aws-dash

An intro to zero-trust workload identity on AWS: a small dashboard that shows where its container is running,
lets you break its health probes, burn CPU, fill memory or crash it, and (from Phase 2) lists AWS resources using
whatever credentials the platform hands it — EKS Pod Identity or IRSA, static keys on any Kubernetes, or a
SPIFFE JWT-SVID from the Zero Trust Workload Identity Manager on OpenShift. Same image everywhere; only env vars change.

The AWS sibling of [gcp-dash](https://github.com/kenmoini/gcp-dash) and [azure-dash](https://github.com/kenmoini/azure-dash).

## Status

Phase 2: the AWS tab (eight read-only inventory panels), explicit credential-mode selection, and Prometheus
`/metrics`. The Identity tab is not implemented yet (its nav link 404s).

## Run locally

```bash
npm install
npm run dev            # http://localhost:8080 — JSON logs; pipe through `npx pino-pretty` for colour
AWS_PROFILE=<profile> AWS_REGION=us-east-1 npm run dev   # AWS tab with your local credentials
npm test               # vitest; nothing touches the network
npm run typecheck
```

Container (the `HEALTHCHECK` is only kept with `--format docker`):

```bash
podman build --format docker -t localhost/aws-dash:dev .
scripts/run-podman.sh   # --cpus 1 --memory 512m; allocate >512 MiB with the memory control to see exit 137
```

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
| POST | `/api/aws/refresh` | drop every cached kind → 204 |
| GET | `/metrics` | Prometheus text; 404 when `METRICS_ENABLED=false` |

Requests with `HX-Request: true` get HTML fragments; everything else gets JSON. Bad input → 422 `{"detail":…}`;
all controls → 403 when `CONTROLS_ENABLED=false`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | listen address |
| `CONTROLS_ENABLED` | `true` | `false` hides and blocks the controls |
| `LOG_LEVEL` | `info` | pino level |
| `MEMORY_LOAD_MAX_MIB` | `4096` | upper bound for the memory control |
| `CPU_LOAD_MAX_WORKERS` | CPU count | upper bound for the CPU control |
| `AUTH_MODE` | `auto` | `auto\|static\|profile\|web-identity\|pod-identity\|imds` — `auto` follows the SDK chain order |
| `AWS_REGION` | — | falls back to `AWS_DEFAULT_REGION`; required for the AWS tab |
| `AWS_CACHE_TTL_SECONDS` | `60` | how long an inventory kind's result is served from cache before it's refetched |
| `AWS_DEBUG` | `false` | logs SDK request metadata |
| `METRICS_ENABLED` | `true` | `false` → `/metrics` returns 404 |
| `IMDS_ENABLED`, `K8S_INFO_ENABLED`, `ACCESS_CHECK_ENABLED`, `SPIFFE_ENDPOINT_SOCKET`, `SPIFFE_JWT_AUDIENCE` | see `src/config.ts` | parsed now, used from Phase 3 onward |

Downward API variables shown on the Runtime tab: `POD_NAME`, `POD_NAMESPACE`, `NODE_NAME`, `POD_IP`, `SERVICE_ACCOUNT`.

### Credential modes

`auto` checks the sources in this order; note the SDK's own default chain prefers `AWS_PROFILE` over environment
keys when both are set — set only one. Any mode can also be forced explicitly by setting `AUTH_MODE`.

| Mode | Selected in `auto` when | SDK provider |
|---|---|---|
| `static` | `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are both set | `fromEnv` |
| `profile` | `AWS_PROFILE` is set | `fromIni` |
| `web-identity` | `AWS_WEB_IDENTITY_TOKEN_FILE` and `AWS_ROLE_ARN` are both set | `fromTokenFile` → `sts:AssumeRoleWithWebIdentity` |
| `pod-identity` | `AWS_CONTAINER_CREDENTIALS_FULL_URI` or `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` is set | `fromHttp` (container credentials endpoint) |
| `imds` | none of the above matched (the fallback) | `fromInstanceMetadata` (the node's/instance's role) |

## Deploy

See [deploy/README.md](deploy/README.md). Quick start on any cluster: `kubectl apply -k deploy/kubernetes`.

## Permissions

The AWS tab needs nothing beyond [`deploy/aws/aws-dash-readonly-policy.json`](deploy/aws/aws-dash-readonly-policy.json)
attached to whichever principal `AUTH_MODE` resolves to. `sts:GetCallerIdentity` (the Account panel's identity
check) needs no IAM permission at all; every other panel fails closed with an actionable hint — keeping its
last successfully fetched data — when the policy is missing or incomplete.

## Demo

1. **Readiness off** → `kubectl -n aws-dash get endpoints -w` shows the pod leave the Service.
2. **Liveness off** → the container restarts after ~15 s and the flags reset.
3. **CPU load** → `kubectl top pod -n aws-dash`.
4. **Memory load** above the 512 Mi limit → `kubectl -n aws-dash get pod -o jsonpath='{.items[0].status.containerStatuses[0].lastState}'` shows `OOMKilled`.
5. **Crash** with exit code 3 → `lastState.terminated.exitCode: 3` and the restart count goes up.
6. Detach the read-only policy and click "Refresh all" → every panel except Account shows an AccessDenied hint
   (`sts:GetCallerIdentity` needs no permission) but keeps its last data; re-attach to recover.
7. Scrape `/metrics` (e.g. `curl -s localhost:8080/metrics | grep aws_dash_`) while doing the above.

## Security

The controls are unauthenticated and have no CSRF protection by design — this is a demo. Do not expose it to the
internet with `CONTROLS_ENABLED=true`.
