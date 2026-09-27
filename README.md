# aws-dash

An intro to zero-trust workload identity on AWS: a small dashboard that shows where its container is running,
lets you break its health probes, burn CPU, fill memory or crash it, and (from Phase 2) lists AWS resources using
whatever credentials the platform hands it — EKS Pod Identity or IRSA, static keys on any Kubernetes, or a
SPIFFE JWT-SVID from the Zero Trust Workload Identity Manager on OpenShift. Same image everywhere; only env vars change.

The AWS sibling of [gcp-dash](https://github.com/kenmoini/gcp-dash) and [azure-dash](https://github.com/kenmoini/azure-dash).

## Status

Phase 1: Runtime tab, five controls, health probes, container image, CI, `kubernetes` and `openshift` overlays.
The AWS and Identity tabs are not implemented yet (the nav links 404).

## Run locally

```bash
npm install
npm run dev            # http://localhost:8080 — JSON logs; pipe through `npx pino-pretty` for colour
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
| `AUTH_MODE`, `AWS_REGION`, `AWS_CACHE_TTL_SECONDS`, `AWS_DEBUG`, `IMDS_ENABLED`, `K8S_INFO_ENABLED`, `METRICS_ENABLED`, `ACCESS_CHECK_ENABLED`, `SPIFFE_ENDPOINT_SOCKET`, `SPIFFE_JWT_AUDIENCE` | see `src/config.ts` | parsed now, used from Phase 2 onward |

Downward API variables shown on the Runtime tab: `POD_NAME`, `POD_NAMESPACE`, `NODE_NAME`, `POD_IP`, `SERVICE_ACCOUNT`.

## Deploy

See [deploy/README.md](deploy/README.md). Quick start on any cluster: `kubectl apply -k deploy/kubernetes`.

## Demo (Phase 1)

1. **Readiness off** → `kubectl -n aws-dash get endpoints -w` shows the pod leave the Service.
2. **Liveness off** → the container restarts after ~15 s and the flags reset.
3. **CPU load** → `kubectl top pod -n aws-dash`.
4. **Memory load** above the 512 Mi limit → `kubectl -n aws-dash get pod -o jsonpath='{.items[0].status.containerStatuses[0].lastState}'` shows `OOMKilled`.
5. **Crash** with exit code 3 → `lastState.terminated.exitCode: 3` and the restart count goes up.

## Security

The controls are unauthenticated and have no CSRF protection by design — this is a demo. Do not expose it to the
internet with `CONTROLS_ENABLED=true`.
