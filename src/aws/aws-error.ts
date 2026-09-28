/** A single-line, user-facing AWS failure with an actionable hint where one is known (azure-dash `AzureError` analogue). */
export class AwsError extends Error {
  override name = "AwsError";
  constructor(
    message: string,
    readonly code: string | null = null,
    readonly status: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function firstLine(text: string): string {
  const i = text.search(/[\r\n]/);
  return (i < 0 ? text : text.slice(0, i)).trim();
}

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  $metadata?: { httpStatusCode?: number };
}

const DENIED = new Set(["AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "UnauthorizedAccess", "AuthorizationError"]);
const NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH"]);
export const POLICY_HINT =
  "grant the identity the read-only policy in deploy/aws/aws-dash-readonly-policy.json (new IAM policy changes can take a few seconds to apply)";

/** Wraps any thrown value as an AwsError: `<Name>: <first line> — <hint>`. */
export function awsErrorFrom(err: unknown): AwsError {
  if (err instanceof AwsError) return err;
  const e: ErrorLike = typeof err === "object" && err !== null ? (err as ErrorLike) : {};
  const name = typeof e.name === "string" && e.name ? e.name : "Error";
  const message = firstLine(typeof e.message === "string" ? e.message : String(err));
  const status = typeof e.$metadata?.httpStatusCode === "number" ? e.$metadata.httpStatusCode : null;
  const code = typeof e.code === "string" ? e.code : null;
  const wrap = (hint: string | null) =>
    new AwsError(hint ? `${name}: ${message} — ${hint}` : `${name}: ${message}`, code ?? name, status, { cause: err });

  if (message.includes("Region is missing")) return wrap("set AWS_REGION");
  if (name === "CredentialsProviderError") {
    return wrap(/token|web identity/i.test(message)
      ? "the web-identity token file is missing or unreadable; is the spiffe-helper sidecar or the IRSA webhook running?"
      : "no usable credentials; set AUTH_MODE or the AWS_* variables for the chosen mode");
  }
  if (name === "InvalidIdentityToken") {
    return wrap("STS rejected the token: the IAM OIDC provider URL must equal the token's iss, its client-id list must contain the token's aud, and the issuer's JWKS must be served over a publicly trusted certificate");
  }
  if (name === "IDPCommunicationError") return wrap("STS could not reach the token issuer's discovery endpoint; the SPIRE OIDC Route must be public with a trusted certificate");
  if (name === "ExpiredToken" || name === "ExpiredTokenException") return wrap("the token has expired: check clock skew, or whether the sidecar that refreshes the token file has stopped");
  if (DENIED.has(name) && /AssumeRoleWithWebIdentity/.test(message)) {
    return wrap("the role's trust policy rejected this identity: its StringEquals conditions on <issuer>:sub and <issuer>:aud must match the token's sub and aud");
  }
  if (DENIED.has(name) || status === 403) return wrap(POLICY_HINT);
  if (name === "TimeoutError" || name === "AbortError" || (code !== null && NETWORK_CODES.has(code))) {
    return wrap("network egress to AWS is blocked or the region endpoint is wrong");
  }
  return wrap(null);
}
