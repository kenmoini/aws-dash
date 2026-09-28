import { afterEach, describe, expect, it } from "vitest";
import { decodeSources, flavorOf, maskKeyId, parsePrincipal } from "../src/identity/identity-service.js";
import { testApp } from "./support/app-factory.js";
import { FAKE_TEMPORARY_CREDENTIALS } from "./support/fake-credentials.js";
import { makeJwt, TEST_SIGNATURE } from "./support/test-jwt.js";

const NOW = 1_767_225_600;
const IRSA_TOKEN = makeJwt({ iss: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", sub: "system:serviceaccount:aws-dash:aws-dash", aud: "sts.amazonaws.com", iat: NOW, exp: NOW + 3600 });
const SPIFFE_TOKEN = makeJwt({ iss: "https://oidc-discovery.apps.example.com", sub: "spiffe://example.com/ns/aws-dash-ztwim/sa/aws-dash", aud: "aws-dash", iat: NOW, exp: NOW + 300 });
const POD_TOKEN = makeJwt({ iss: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", sub: "system:serviceaccount:aws-dash:aws-dash", aud: "pods.eks.amazonaws.com", exp: NOW + 86400 });
const WEB = { AWS_REGION: "us-east-1", AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/aws/token", AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/aws-dash-irsa", AWS_ROLE_SESSION_NAME: "aws-dash" };

describe("helpers", () => {
  it("parsePrincipal classifies ARNs", () => {
    expect(parsePrincipal("arn:aws:sts::123456789012:assumed-role/aws-dash-irsa/aws-dash")).toEqual({ principal_type: "assumed-role", role_name: "aws-dash-irsa", session_name: "aws-dash" });
    expect(parsePrincipal("arn:aws:iam::123456789012:user/aws-dash")).toEqual({ principal_type: "user", role_name: null, session_name: null });
    expect(parsePrincipal("arn:aws:iam::123456789012:root")).toEqual({ principal_type: "root", role_name: null, session_name: null });
    expect(parsePrincipal("arn:aws:sts::123456789012:federated-user/bob")).toEqual({ principal_type: "federated-user", role_name: null, session_name: null });
    expect(parsePrincipal(undefined)).toEqual({ principal_type: null, role_name: null, session_name: null });
  });
  it("decodeSources maps known feature ids and keeps unknown ones raw, sorted", () => {
    expect(decodeSources({ CREDENTIALS_STS_ASSUME_ROLE_WEB_ID: "k", CREDENTIALS_ENV_VARS_STS_WEB_ID_TOKEN: "h", X: "ZZ" })).toEqual(["ZZ: (unknown)", "h: web-identity token file", "k: sts:AssumeRoleWithWebIdentity"]);
    expect(decodeSources(undefined)).toEqual([]);
  });
  it("maskKeyId keeps only the first and last four characters", () => {
    expect(maskKeyId("ASIAEXAMPLE1234567Q2K")).toBe("ASIA…7Q2K");
    expect(maskKeyId("short")).toBe("…");
    expect(maskKeyId(undefined)).toBeNull();
  });
  it("flavorOf", () => {
    const spec = (mode: string, extra: Record<string, unknown> = {}) => ({ mode, container_credentials_uri: null, ...extra }) as never;
    expect(flavorOf(spec("web-identity"), { sub: "spiffe://x/ns/a/sa/b" })).toBe("SPIFFE JWT-SVID (spiffe-helper)");
    expect(flavorOf(spec("web-identity"), { iss: "https://oidc.eks.us-east-1.amazonaws.com/id/A", sub: "system:serviceaccount:a:b" })).toBe("EKS IRSA");
    expect(flavorOf(spec("web-identity"), { sub: "system:serviceaccount:a:b" })).toBe("Kubernetes projected service-account token");
    expect(flavorOf(spec("web-identity"), {})).toBe("OIDC token file");
    expect(flavorOf(spec("pod-identity", { container_credentials_uri: "http://169.254.170.23/v1/credentials" }), {})).toBe("EKS Pod Identity");
    expect(flavorOf(spec("pod-identity", { container_credentials_uri: "http://[fd00:ec2::23]/v1/credentials" }), {})).toBe("EKS Pod Identity");
    expect(flavorOf(spec("pod-identity", { container_credentials_uri: "/v2/credentials/abc" }), {})).toBe("ECS task role");
    expect(flavorOf(spec("static"), {})).toBe("long-lived IAM user access key");
    expect(flavorOf(spec("profile"), {})).toBe("shared config profile");
    expect(flavorOf(spec("imds"), {})).toBe("EC2 instance role (IMDS)");
  });
});

describe("IdentityService via /api/identity", () => {
  let close = async () => {};
  afterEach(() => close());

  it("assembles mode, decoded token, STS identity and credential facts (IRSA)", async () => {
    const { app, sts } = await testApp({ env: WEB, credentials: { spec: { credential_type: "fromTokenFile → sts:AssumeRoleWithWebIdentity", role_arn: WEB.AWS_ROLE_ARN, role_session_name: "aws-dash", token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE } }, readFile: () => IRSA_TOKEN });
    close = () => app.close();
    const res = await app.inject({ url: "/api/identity" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      mode: "web-identity", reason: "auto: AWS_WEB_IDENTITY_TOKEN_FILE and AWS_ROLE_ARN are set", flavor: "EKS IRSA",
      credential_type: "fromTokenFile → sts:AssumeRoleWithWebIdentity", region: "us-east-1", role_arn: WEB.AWS_ROLE_ARN, role_session_name: "aws-dash",
      token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE, container_credentials_uri: null, profile: null, error: null, fetched_at: "2026-01-01T00:00:00.000Z",
      token: { claims: { sub: "system:serviceaccount:aws-dash:aws-dash", aud: "sts.amazonaws.com" }, expires_at: "2026-01-01T01:00:00.000Z", expires_in_seconds: 3600, error: null },
      sts: { account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/aws-dash-irsa/aws-dash", user_id: "AROAEXAMPLE:aws-dash", principal_type: "assumed-role", role_name: "aws-dash-irsa", session_name: "aws-dash", error: null, hint: null },
      credentials: { key_prefix: "ASIA", key_id_masked: "ASIA…7Q2K", temporary: true, expiration: "2026-01-01T00:55:00.000Z", expires_in_seconds: 3300, account_id: "123456789012", source: ["h: web-identity token file", "k: sts:AssumeRoleWithWebIdentity"], error: null },
    });
    expect(Object.keys(body)).toEqual(["mode", "reason", "flavor", "credential_type", "region", "role_arn", "role_session_name", "token_file", "container_credentials_uri", "profile", "error", "token", "sts", "credentials", "fetched_at"]);
    expect(sts.calls).toBe(1);
    const text = res.body;
    expect(text).not.toContain(TEST_SIGNATURE);
    expect(text).not.toContain(IRSA_TOKEN);
    expect(text).not.toContain(FAKE_TEMPORARY_CREDENTIALS.secretAccessKey);
    expect(text).not.toContain(FAKE_TEMPORARY_CREDENTIALS.sessionToken);
    expect(text).not.toContain(FAKE_TEMPORARY_CREDENTIALS.accessKeyId);
  });

  it("is cached for the TTL and refreshed on demand or by POST /api/aws/refresh", async () => {
    const { app, sts } = await testApp({ env: WEB, credentials: { spec: { token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE } }, readFile: () => IRSA_TOKEN });
    close = () => app.close();
    await app.inject({ url: "/api/identity" });
    await app.inject({ url: "/api/identity" });
    expect(sts.calls).toBe(1);
    await app.inject({ url: "/api/identity?refresh=true" });
    expect(sts.calls).toBe(2);
    await app.inject({ method: "POST", url: "/api/aws/refresh" });
    await app.inject({ url: "/api/identity" });
    expect(sts.calls).toBe(3);
  });

  it("recognises SPIFFE and Pod Identity tokens", async () => {
    const spiffe = await testApp({ env: { ...WEB, AWS_ROLE_SESSION_NAME: "" }, credentials: { spec: { token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE } }, readFile: () => SPIFFE_TOKEN });
    const a = (await spiffe.app.inject({ url: "/api/identity" })).json();
    await spiffe.app.close();
    expect(a.flavor).toBe("SPIFFE JWT-SVID (spiffe-helper)");
    expect(a.token.claims.sub).toBe("spiffe://example.com/ns/aws-dash-ztwim/sa/aws-dash");
    expect(a.token.expires_in_seconds).toBe(300);
    const pod = await testApp({
      env: { AWS_REGION: "us-east-1", AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials", AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token" },
      credentials: { spec: { container_credentials_uri: "http://169.254.170.23/v1/credentials", token_file: "/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token" }, credentials: { ...FAKE_TEMPORARY_CREDENTIALS, $source: { CREDENTIALS_HTTP: "z" } } },
      readFile: () => POD_TOKEN,
    });
    close = () => pod.app.close();
    const b = (await pod.app.inject({ url: "/api/identity" })).json();
    expect(b.mode).toBe("pod-identity");
    expect(b.flavor).toBe("EKS Pod Identity");
    expect(b.token.claims.aud).toBe("pods.eks.amazonaws.com");
    expect(b.credentials.source).toEqual(["z: container credentials endpoint"]);
  });

  it("keeps sections independent: an unreadable token file and an STS failure each report only their own error", async () => {
    const { app, sts } = await testApp({ env: WEB, credentials: { spec: { token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE } }, readFile: () => { throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }); } });
    close = () => app.close();
    sts.fail("AccessDenied", "User is not authorized to perform: sts:AssumeRoleWithWebIdentity on resource: arn:aws:iam::123456789012:role/aws-dash-irsa", 403);
    const body = (await app.inject({ url: "/api/identity" })).json();
    expect(body.error).toBeNull();
    expect(body.token).toMatchObject({ claims: {}, error: "could not read /var/run/secrets/aws/token: ENOENT: no such file" });
    expect(body.sts.error).toMatch(/^AccessDenied: /);
    expect(body.sts.hint).toMatch(/trust policy rejected this identity/);
    expect(body.credentials.key_prefix).toBe("ASIA");
  });

  it("static keys: no token, AKIA prefix, non-expiring credentials", async () => {
    const { app } = await testApp({ env: { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE0000001234", AWS_SECRET_ACCESS_KEY: "s" }, credentials: { credentials: { accessKeyId: "AKIAEXAMPLE0000001234", secretAccessKey: "s", $source: { CREDENTIALS_ENV_VARS: "g" } } } });
    close = () => app.close();
    const body = (await app.inject({ url: "/api/identity" })).json();
    expect(body).toMatchObject({ mode: "static", flavor: "long-lived IAM user access key", token: null, credentials: { key_prefix: "AKIA", key_id_masked: "AKIA…1234", temporary: false, expiration: null, expires_in_seconds: null, source: ["g: environment variables"] } });
  });

  it("credential resolution failure: facts carry the error and STS is not attempted", async () => {
    const { app, sts } = await testApp({ env: WEB, credentials: { spec: { token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE }, credentials: Object.assign(new Error("Web identity token file not found"), { name: "CredentialsProviderError" }) }, readFile: () => IRSA_TOKEN });
    close = () => app.close();
    const body = (await app.inject({ url: "/api/identity" })).json();
    expect(body.credentials.error).toMatch(/^CredentialsProviderError: .*spiffe-helper sidecar or the IRSA webhook/);
    expect(body.sts).toMatchObject({ account: null, error: "not attempted: credentials could not be resolved", hint: null });
    expect(sts.calls).toBe(0);
  });

  it("a mode that cannot be built reports the top-level error and nothing else", async () => {
    const { app } = await testApp({ env: { AUTH_MODE: "web-identity" }, credentials: { factoryError: Object.assign(new Error("AUTH_MODE web-identity requires AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN"), { name: "AwsError" }) } });
    close = () => app.close();
    const body = (await app.inject({ url: "/api/identity" })).json();
    expect(body).toMatchObject({ mode: "web-identity", reason: "AUTH_MODE=web-identity", error: expect.stringContaining("requires AWS_WEB_IDENTITY_TOKEN_FILE"), token: null, sts: null, credentials: null });
  });

  it("missing region is reported in the STS section, not as a crash", async () => {
    const { app } = await testApp({ env: { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }, credentials: {} });
    close = () => app.close();
    const body = (await app.inject({ url: "/api/identity" })).json();
    expect(body.region).toBeNull();
    expect(body.sts.error).toMatch(/AWS_REGION is not set/);
    expect(body.credentials.error).toBeNull();
  });
});
