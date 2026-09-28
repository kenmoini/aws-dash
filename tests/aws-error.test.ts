import { describe, expect, it } from "vitest";
import { AwsError, awsErrorFrom, firstLine } from "../src/aws/aws-error.js";

const sdkError = (name: string, message: string, status?: number, code?: string) =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status }, code });

describe("firstLine", () => {
  it("keeps only the first line, trimmed", () => {
    expect(firstLine("  boom  \nstack\nmore")).toBe("boom");
    expect(firstLine("one")).toBe("one");
  });
});

describe("awsErrorFrom", () => {
  it("returns AwsError instances unchanged", () => {
    const e = new AwsError("x");
    expect(awsErrorFrom(e)).toBe(e);
  });
  it.each([
    ["CredentialsProviderError", "Could not load credentials from any providers", undefined, /no usable credentials; set AUTH_MODE/],
    ["CredentialsProviderError", "Web identity token file not found", undefined, /spiffe-helper sidecar or the IRSA webhook/],
    ["InvalidIdentityToken", "No OpenIDConnect provider found in your account for https://x", 400, /IAM OIDC provider URL must equal the token's iss/],
    ["IDPCommunicationError", "Unable to reach the identity provider", 400, /discovery endpoint/],
    ["ExpiredTokenException", "Token expired", 400, /clock skew/],
    ["AccessDenied", "User is not authorized to perform: sts:AssumeRoleWithWebIdentity on resource: arn:aws:iam::1:role/x", 403, /trust policy rejected this identity/],
    ["AccessDenied", "Access Denied", 403, /aws-dash-readonly-policy\.json/],
    ["UnauthorizedOperation", "You are not authorized to perform this operation.", 403, /aws-dash-readonly-policy\.json/],
    ["SomeException", "forbidden thing", 403, /aws-dash-readonly-policy\.json/],
    ["TimeoutError", "Request timed out", undefined, /egress to AWS is blocked/],
    ["ProviderError", "TimeoutError from instance metadata service", undefined, /instance metadata service is unreachable/],
    ["CredentialsProviderError", "Could not fetch role name: connect ETIMEDOUT 169.254.169.254:80", undefined, /instance metadata service is unreachable/],
  ])("translates %s", (name, message, status, hint) => {
    const out = awsErrorFrom(sdkError(name, message, status));
    expect(out).toBeInstanceOf(AwsError);
    expect(out.message).toMatch(new RegExp(`^${name}: `));
    expect(out.message).toMatch(hint);
    expect(out.status).toBe(status ?? null);
  });
  it("translates network error codes and region errors", () => {
    expect(awsErrorFrom(sdkError("Error", "connect ECONNREFUSED", undefined, "ECONNREFUSED")).message).toMatch(/egress to AWS is blocked/);
    expect(awsErrorFrom(new Error("Region is missing")).message).toMatch(/set AWS_REGION/);
  });
  it("falls back to name + first line and keeps the cause", () => {
    const err = new Error("weird\nstack");
    err.name = "WeirdException";
    const out = awsErrorFrom(err);
    expect(out.message).toBe("WeirdException: weird");
    expect(out.code).toBe("WeirdException");
    expect(out.cause).toBe(err);
  });
  it("copes with non-Error throwables", () => {
    expect(awsErrorFrom("nope").message).toBe("Error: nope");
    expect(awsErrorFrom(undefined).message).toBe("Error: undefined");
  });
});
