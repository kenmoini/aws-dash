import { describe, expect, it } from "vitest";
import { decodeJwtForDisplay, FEDERATED_CLAIMS, normalizeToken } from "../src/identity/jwt-display.js";
import { makeJwt, TEST_SIGNATURE } from "./support/test-jwt.js";

const NOW = 1_767_225_600; // 2026-01-01T00:00:00Z

describe("decodeJwtForDisplay", () => {
  it("returns only the allow-listed claims, with iat/exp as ISO timestamps", () => {
    const token = makeJwt({ iss: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", sub: "system:serviceaccount:aws-dash:aws-dash", aud: "sts.amazonaws.com", iat: NOW, exp: NOW + 3600, "kubernetes.io": { namespace: "aws-dash" }, secret: "x" });
    const out = decodeJwtForDisplay(token);
    expect(out).toEqual({
      claims: { iss: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", sub: "system:serviceaccount:aws-dash:aws-dash", aud: "sts.amazonaws.com", iat: "2026-01-01T00:00:00.000Z", exp: "2026-01-01T01:00:00.000Z" },
      issued_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2026-01-01T01:00:00.000Z",
      error: null,
    });
    expect(JSON.stringify(out)).not.toContain(TEST_SIGNATURE);
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("joins array audiences and stringifies non-string claims", () => {
    const out = decodeJwtForDisplay(makeJwt({ aud: ["aws-dash", "sts.amazonaws.com"], sub: 42 }), ["aud", "sub"]);
    expect(out.claims).toEqual({ aud: "aws-dash, sts.amazonaws.com", sub: "42" });
  });

  it("unwraps a base64-wrapped token (spiffe-helper style) and tolerates whitespace", () => {
    const token = makeJwt({ sub: "spiffe://example.org/ns/aws-dash/sa/aws-dash", aud: "aws-dash" });
    const wrapped = `\n${Buffer.from(token).toString("base64")}\n`;
    expect(normalizeToken(wrapped)).toBe(token);
    expect(normalizeToken(`  ${token}  `)).toBe(token);
    expect(decodeJwtForDisplay(wrapped).claims.sub).toBe("spiffe://example.org/ns/aws-dash/sa/aws-dash");
  });

  it.each([
    [undefined, "no token"],
    ["", "no token"],
    ["abc.def", "could not decode token: expected 3 dot-separated segments, found 2"],
    ["a.!!!.c", "could not decode token: payload is not a JSON object"],
    [`a.${Buffer.from("[1,2]").toString("base64url")}.c`, "could not decode token: payload is not a JSON object"],
  ])("reports %j as an error without throwing", (raw, error) => {
    expect(decodeJwtForDisplay(raw)).toEqual({ claims: {}, issued_at: null, expires_at: null, error });
  });

  it("exposes the federated claim list", () => {
    expect(FEDERATED_CLAIMS).toEqual(["iss", "sub", "aud", "iat", "exp"]);
  });
});
