const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString("base64url");

/** A signature that must never appear in any rendered output or log. */
export const TEST_SIGNATURE = "c2lnbmF0dXJlLURPLU5PVC1MRUFL";

/** Builds an unsigned-but-well-formed compact JWT for display tests. */
export function makeJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: "test" }): string {
  return `${b64url(header)}.${b64url(payload)}.${TEST_SIGNATURE}`;
}
