import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { JwtSvidRaw, WorkloadApi, X509SvidRaw } from "../../src/identity/workload-api.js";
import { makeJwt } from "./test-jwt.js";

export const FIXTURE_PEM = readFileSync(new URL("../fixtures/spiffe-leaf.pem", import.meta.url), "utf8");
export const FIXTURE_CERT = new X509Certificate(FIXTURE_PEM);
export const FIXTURE_DER = new Uint8Array(FIXTURE_CERT.raw);
export const FIXTURE_SPIFFE_ID = "spiffe://example.org/ns/aws-dash-ztwim/sa/aws-dash";
/** The base64 body of the fixture — must never appear in any output. */
export const FIXTURE_PEM_BODY = FIXTURE_PEM.replace(/-----[A-Z ]+-----|\s/g, "");
export const NOW = 1_767_225_600; // 2026-01-01T00:00:00Z, the FakeClock start

export const rpcError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** Scripted Workload API: hands back the fixture chain (leaf twice, as a real chain would) and a JWT-SVID built with makeJwt. */
export class FakeWorkloadApi implements WorkloadApi {
  calls = { x509: 0, jwt: 0, close: 0 };
  spiffeId = FIXTURE_SPIFFE_ID;
  certificate: Uint8Array = new Uint8Array([...FIXTURE_DER, ...FIXTURE_DER]);
  token = makeJwt({ iss: "https://oidc-discovery.apps.example.org", sub: FIXTURE_SPIFFE_ID, aud: "aws-dash", iat: NOW, exp: NOW + 300 });
  x509Error: Error | null = null;
  jwtError: Error | null = null;
  audiences: string[] = [];

  async fetchX509(): Promise<X509SvidRaw> {
    this.calls.x509++;
    if (this.x509Error) throw this.x509Error;
    return { spiffe_id: this.spiffeId, certificate: this.certificate, hint: "" };
  }

  async fetchJwt(audience: string): Promise<JwtSvidRaw> {
    this.calls.jwt++;
    this.audiences.push(audience);
    if (this.jwtError) throw this.jwtError;
    return { spiffe_id: this.spiffeId, token: this.token };
  }

  close(): void {
    this.calls.close++;
  }
}
