import { describe, expect, it } from "vitest";
import { AwsError } from "../src/aws/aws-error.js";
import { settingsFromEnv } from "../src/config.js";
import type { EnvLookup } from "../src/env.js";
import { createCredentialSpec, resolveAuthMode } from "../src/identity/credential-factory.js";
import { CredentialProvider } from "../src/identity/credential-provider.js";

const env = (vars: Record<string, string>): EnvLookup => (name) => vars[name];
const settings = (vars: Record<string, string>) => settingsFromEnv(env(vars));
const KEYS = { AWS_ACCESS_KEY_ID: "AKIAX", AWS_SECRET_ACCESS_KEY: "s" };
const TOKEN = { AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/aws/token", AWS_ROLE_ARN: "arn:aws:iam::1:role/r" };
const POD = { AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials", AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/t" };

describe("resolveAuthMode", () => {
  it.each([
    [{ ...KEYS, ...TOKEN, ...POD }, "static", "auto: AWS_ACCESS_KEY_ID is set (the SDK chain checks environment keys first)"],
    [{ AWS_PROFILE: "demo", ...TOKEN }, "profile", "auto: AWS_PROFILE is set"],
    [{ ...TOKEN, ...POD }, "web-identity", "auto: AWS_WEB_IDENTITY_TOKEN_FILE and AWS_ROLE_ARN are set"],
    [{ ...POD }, "pod-identity", "auto: AWS_CONTAINER_CREDENTIALS_FULL_URI is set"],
    [{ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/x" }, "pod-identity", "auto: AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is set"],
    [{}, "imds", "auto: no workload credentials in the environment; falling back to EC2 instance metadata (the node's role)"],
    [{ AWS_EC2_METADATA_DISABLED: "true" }, "imds", "auto: nothing matched and AWS_EC2_METADATA_DISABLED=true"],
    [{ AWS_ACCESS_KEY_ID: "only-id" }, "imds", "auto: no workload credentials in the environment; falling back to EC2 instance metadata (the node's role)"],
  ])("auto with %o → %s", (vars, mode, reason) => {
    expect(resolveAuthMode(settings(vars), env(vars))).toEqual({ mode, reason });
  });
  it("an explicit AUTH_MODE wins", () => {
    const vars = { AUTH_MODE: "pod-identity", ...KEYS };
    expect(resolveAuthMode(settings(vars), env(vars))).toEqual({ mode: "pod-identity", reason: "AUTH_MODE=pod-identity" });
  });
});

describe("createCredentialSpec", () => {
  it("static", () => {
    const spec = createCredentialSpec(settings(KEYS), env(KEYS));
    expect(spec).toMatchObject({ mode: "static", credential_type: "fromEnv (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)", role_arn: null, token_file: null, profile: null });
    expect(typeof spec.provider).toBe("function");
  });
  it("profile", () => {
    const vars = { AWS_PROFILE: "demo" };
    expect(createCredentialSpec(settings(vars), env(vars))).toMatchObject({ mode: "profile", credential_type: "fromIni (profile 'demo')", profile: "demo" });
  });
  it("web-identity carries the role, session name and token file", () => {
    const vars = { ...TOKEN, AWS_ROLE_SESSION_NAME: "aws-dash" };
    expect(createCredentialSpec(settings(vars), env(vars))).toMatchObject({
      mode: "web-identity", credential_type: "fromTokenFile → sts:AssumeRoleWithWebIdentity",
      role_arn: TOKEN.AWS_ROLE_ARN, role_session_name: "aws-dash", token_file: TOKEN.AWS_WEB_IDENTITY_TOKEN_FILE,
    });
  });
  it("pod-identity carries the container credentials URI", () => {
    expect(createCredentialSpec(settings(POD), env(POD))).toMatchObject({
      mode: "pod-identity", credential_type: "fromHttp (container credentials endpoint)", container_credentials_uri: POD.AWS_CONTAINER_CREDENTIALS_FULL_URI,
    });
  });
  it("imds", () => {
    expect(createCredentialSpec(settings({}), env({}))).toMatchObject({ mode: "imds", credential_type: "fromInstanceMetadata (EC2 instance role)" });
  });
  it.each([
    [{ AUTH_MODE: "static" }, "AUTH_MODE static requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY"],
    [{ AUTH_MODE: "static", AWS_ACCESS_KEY_ID: "x" }, "AUTH_MODE static requires AWS_SECRET_ACCESS_KEY"],
    [{ AUTH_MODE: "profile" }, "AUTH_MODE profile requires AWS_PROFILE"],
    [{ AUTH_MODE: "web-identity" }, "AUTH_MODE web-identity requires AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN"],
    [{ AUTH_MODE: "web-identity", AWS_ROLE_ARN: "arn" }, "AUTH_MODE web-identity requires AWS_WEB_IDENTITY_TOKEN_FILE"],
    [{ AUTH_MODE: "pod-identity" }, "AUTH_MODE pod-identity requires AWS_CONTAINER_CREDENTIALS_FULL_URI or AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"],
    [{ AUTH_MODE: "imds", AWS_EC2_METADATA_DISABLED: "1" }, "AUTH_MODE imds requires AWS_EC2_METADATA_DISABLED to be unset or false"],
  ])("rejects %o", (vars, message) => {
    expect(() => createCredentialSpec(settings(vars), env(vars))).toThrow(AwsError);
    expect(() => createCredentialSpec(settings(vars), env(vars))).toThrow(message);
  });
});

describe("CredentialProvider", () => {
  it("describes without constructing, builds lazily, caches success and retries failure", () => {
    let calls = 0;
    const vars: Record<string, string> = { AUTH_MODE: "web-identity" };
    const cp = new CredentialProvider(settings(vars), env(vars), (s, e) => { calls++; return createCredentialSpec(s, e); });
    expect(cp.describe()).toEqual({ mode: "web-identity", reason: "AUTH_MODE=web-identity" });
    expect(calls).toBe(0);
    expect(() => cp.get()).toThrow(/requires AWS_WEB_IDENTITY_TOKEN_FILE/);
    expect(() => cp.get()).toThrow(AwsError);
    expect(calls).toBe(2);
    Object.assign(vars, TOKEN);
    expect(cp.get().mode).toBe("web-identity");
    expect(cp.get().provider).toBe(cp.provider());
    expect(calls).toBe(3);
  });
});
