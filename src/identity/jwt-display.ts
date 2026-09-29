/** Decoded-for-display view of a JWT: allow-listed claims only, never the token itself. */
export interface JwtSummary {
  claims: Record<string, string>;
  issued_at: string | null;
  expires_at: string | null;
  error: string | null;
}

export const FEDERATED_CLAIMS: readonly string[] = ["iss", "sub", "aud", "iat", "exp"];

const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** Trims, and unwraps a base64/base64url-wrapped compact JWT (spiffe-helper may write one). */
export function normalizeToken(raw: string): string {
  const trimmed = raw.trim();
  if (COMPACT_JWT.test(trimmed)) return trimmed;
  // Buffer.from(…, "base64") never throws: invalid characters are dropped, so a non-JWT simply fails the regex.
  const inner = Buffer.from(trimmed, "base64").toString("utf8").trim();
  return COMPACT_JWT.test(inner) ? inner : trimmed;
}

function failed(error: string): JwtSummary {
  return { claims: {}, issued_at: null, expires_at: null, error };
}

function render(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(render).join(", ");
  if (value === null || typeof value !== "object") return String(value);
  return JSON.stringify(value);
}

function epoch(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

/** Decodes (never verifies) a JWT payload for display. Total: any problem becomes `error`. */
export function decodeJwtForDisplay(raw: string | null | undefined, allowed: readonly string[] = FEDERATED_CLAIMS): JwtSummary {
  if (raw === null || raw === undefined || raw.trim() === "") return failed("no token");
  const token = normalizeToken(raw);
  const parts = token.split(".");
  if (parts.length !== 3) return failed(`could not decode token: expected 3 dot-separated segments, found ${parts.length}`);
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return failed("could not decode token: payload is not a JSON object");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return failed("could not decode token: payload is not a JSON object");
  const body = payload as Record<string, unknown>;
  const claims: Record<string, string> = {};
  for (const name of allowed) {
    if (name in body) {
      const value = body[name];
      claims[name] = (name === "iat" || name === "exp") && typeof value === "number" ? (epoch(value) ?? String(value)) : render(value);
    }
  }
  return { claims, issued_at: epoch(body["iat"]), expires_at: epoch(body["exp"]), error: null };
}
