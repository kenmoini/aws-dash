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
