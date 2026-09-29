import { X509Certificate } from "node:crypto";
import type { Clock } from "../clock.js";
import type { TtlCache } from "../inventory/ttl-cache.js";
import { decodeJwtForDisplay, type JwtSummary } from "./jwt-display.js";
import { describeWorkloadApiError, type WorkloadApi, type WorkloadApiFactory, type X509SvidRaw } from "./workload-api.js";

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
    const info = entry.value as SpiffeInfo;
    if (info.x509 === null) return info;
    // The cached summary ages for up to a TTL; the countdown is recomputed for every caller.
    const expiresIn = Math.floor((new Date(info.x509.not_after).getTime() - this.opts.clock.now().getTime()) / 1000);
    return { ...info, x509: { ...info.x509, expires_in_seconds: expiresIn } };
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
    let api: WorkloadApi | undefined;
    try {
      api = this.opts.createApi(socket, this.timeoutMs);
      // Both RPCs share one channel and one deadline; running them together bounds the worst case to one deadline, not two.
      const [x509Result, jwtResult] = await Promise.allSettled([api.fetchX509(), api.fetchJwt(this.opts.audience)]);
      let x509: X509Summary | null = null;
      let x509Error: string | null = null;
      if (x509Result.status === "fulfilled") {
        try {
          x509 = summarizeX509(x509Result.value, now);
        } catch (err) {
          x509Error = describeWorkloadApiError(err, socket);
        }
      } else {
        x509Error = describeWorkloadApiError(x509Result.reason, socket);
      }
      let jwt: JwtSvidSummary;
      if (jwtResult.status === "fulfilled") {
        jwt = { ...decodeJwtForDisplay(jwtResult.value.token), spiffe_id: jwtResult.value.spiffe_id, audience: this.opts.audience };
      } else {
        jwt = { claims: {}, issued_at: null, expires_at: null, error: describeWorkloadApiError(jwtResult.reason, socket), spiffe_id: null, audience: this.opts.audience };
      }
      if (x509 === null && jwt.error !== null) return { ...this.unavailable(x509Error ?? jwt.error), fetched_at: now.toISOString() };
      return { available: true, reason: null, socket, x509, x509_error: x509Error, jwt, fetched_at: now.toISOString() };
    } catch (err) {
      // A throwing factory (e.g. an unparseable target) must not reject load(), or TtlCache would cache
      // `value: null` and every consumer would crash on `info.available`.
      return { ...this.unavailable(describeWorkloadApiError(err, socket)), fetched_at: now.toISOString() };
    } finally {
      api?.close();
    }
  }
}
