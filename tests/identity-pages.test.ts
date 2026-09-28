import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "./support/app-factory.js";
import { FAKE_TEMPORARY_CREDENTIALS } from "./support/fake-credentials.js";
import { makeJwt, TEST_SIGNATURE } from "./support/test-jwt.js";

const NOW = 1_767_225_600;
const TOKEN = makeJwt({ iss: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", sub: "system:serviceaccount:aws-dash:aws-dash", aud: "sts.amazonaws.com", iat: NOW, exp: NOW + 3600 });
const WEB = { AWS_REGION: "us-east-1", AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/aws/token", AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/aws-dash-irsa", AWS_DEBUG: "true" };
const irsa = (extra = {}) => testApp({ env: WEB, credentials: { spec: { credential_type: "fromTokenFile → sts:AssumeRoleWithWebIdentity", role_arn: WEB.AWS_ROLE_ARN, token_file: WEB.AWS_WEB_IDENTITY_TOKEN_FILE } }, readFile: () => TOKEN, ...extra });

describe("identity page and partial", () => {
  let close = async () => {};
  afterEach(() => close());

  it("GET /identity renders the layout with a lazy identity card", async () => {
    const { app } = await testApp();
    close = () => app.close();
    const html = (await app.inject({ url: "/identity" })).body;
    expect(html).toContain("<title>Identity · aws-dash</title>");
    expect(html).toContain('<a href="/identity" class="active">Identity</a>');
    expect(html).toContain('data-identity-panel hx-get="/partials/identity" hx-trigger="load"');
  });

  it("the partial shows every section and never the raw token, key id or secrets", async () => {
    const { app } = await irsa();
    close = () => app.close();
    const res = await app.inject({ url: "/partials/identity" });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    for (const text of ["How the app authenticates", "web-identity", "EKS IRSA", "Token presented to STS", "system:serviceaccount:aws-dash:aws-dash", "sts.amazonaws.com",
      "expires</dt><dd>2026-01-01 01:00:00 UTC (in 1h 0m)", "What AWS returned", "assumed-role/aws-dash-irsa/aws-dash", "ASIA…7Q2K", "ASIA = temporary", "h: web-identity token file",
      "internal and may change", "Raw tokens are never displayed", 'hx-get="/partials/identity?refresh=1"']) {
      expect(html, text).toContain(text);
    }
    for (const secret of [TOKEN, TEST_SIGNATURE, FAKE_TEMPORARY_CREDENTIALS.accessKeyId, FAKE_TEMPORARY_CREDENTIALS.secretAccessKey, FAKE_TEMPORARY_CREDENTIALS.sessionToken!]) {
      expect(html, secret).not.toContain(secret);
    }
  });

  it("nothing token-shaped reaches the logs, even at trace level with AWS_DEBUG on", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "trace" }, { write: (chunk: string) => { lines.push(chunk); } });
    const { app } = await irsa({ overrides: { logger } });
    close = () => app.close();
    await app.inject({ url: "/api/identity" });
    await app.inject({ url: "/partials/identity?refresh=1" });
    const joined = lines.join("\n");
    for (const secret of [TOKEN, TEST_SIGNATURE, FAKE_TEMPORARY_CREDENTIALS.accessKeyId, FAKE_TEMPORARY_CREDENTIALS.secretAccessKey, FAKE_TEMPORARY_CREDENTIALS.sessionToken!]) {
      expect(joined, secret).not.toContain(secret);
    }
  });

  it("renders section errors and the top-level error as banners with 200", async () => {
    const { app, sts } = await irsa();
    close = () => app.close();
    sts.fail("InvalidIdentityToken", "No OpenIDConnect provider found in your account for https://x", 400);
    const html = (await app.inject({ url: "/partials/identity" })).body;
    expect(html).toContain('<div class="error">InvalidIdentityToken: No OpenIDConnect provider found');
    expect(html).toContain("IAM OIDC provider URL must equal the token");
    const broken = await testApp({ env: { AUTH_MODE: "pod-identity" }, credentials: { factoryError: Object.assign(new Error("AUTH_MODE pod-identity requires AWS_CONTAINER_CREDENTIALS_FULL_URI or AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"), { name: "AwsError" }) } });
    const res = await broken.app.inject({ url: "/partials/identity" });
    await broken.app.close();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("requires AWS_CONTAINER_CREDENTIALS_FULL_URI");
    expect(res.body).not.toContain("What AWS returned");
  });

  it("static keys show the AKIA legend and no token section", async () => {
    const { app } = await testApp({ env: { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "AKIAEXAMPLE0000001234", AWS_SECRET_ACCESS_KEY: "s" }, credentials: { credentials: { accessKeyId: "AKIAEXAMPLE0000001234", secretAccessKey: "s", $source: { CREDENTIALS_ENV_VARS: "g" } } } });
    close = () => app.close();
    const html = (await app.inject({ url: "/partials/identity" })).body;
    expect(html).toContain("AKIA = long-lived IAM user key");
    expect(html).toContain("never (long-lived)");
    expect(html).not.toContain("Token presented to STS");
    expect(html).not.toContain("AKIAEXAMPLE0000001234");
  });
});
