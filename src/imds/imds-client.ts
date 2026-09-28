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
