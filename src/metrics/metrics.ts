import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { AccessCheckObserver, AccessCheckRow } from "../identity/access-check.js";
import type { IdentityObserver, IdentityInfo } from "../identity/identity-service.js";
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
  now: () => Date;
}

const MIB = 1024 * 1024;
const orMinusOne = (v: number | null): number => (v === null ? -1 : v);

/** Prometheus registry for the app. Gauges are computed at scrape time from in-memory state; nothing here calls AWS. */
export class Metrics implements InventoryObserver, IdentityObserver, AccessCheckObserver {
  readonly registry = new Registry();
  private readonly fetchDuration: Histogram<"kind">;
  private readonly fetchErrors: Counter<"kind">;
  private readonly lastSuccess: Gauge<"kind">;
  private readonly httpRequests: Counter<"method" | "route" | "status">;
  private readonly resolutions: Counter<"mode" | "result">;
  private readonly accessAllowed: Gauge<"action">;
  private identitySource: () => IdentityInfo | null = () => null;

  constructor(sources: MetricsSources) {
    const self = this;
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
  }

  fetched(kind: InventoryKind, ok: boolean, seconds: number): void {
    this.fetchDuration.observe({ kind }, seconds);
    if (ok) this.lastSuccess.set({ kind }, Math.floor(Date.now() / 1000));
    else this.fetchErrors.inc({ kind });
  }

  httpRequest(method: string, route: string, status: number): void {
    this.httpRequests.inc({ method, route, status: String(status) });
  }

  setIdentitySource(source: () => IdentityInfo | null): void {
    this.identitySource = source;
  }

  resolved(mode: string, ok: boolean): void {
    this.resolutions.inc({ mode, result: ok ? "ok" : "error" });
  }

  checked(rows: AccessCheckRow[]): void {
    for (const row of rows) this.accessAllowed.set({ action: row.action }, row.result === "allowed" ? 1 : 0);
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
