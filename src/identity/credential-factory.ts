import { fromEnv, fromHttp, fromIni, fromInstanceMetadata, fromTokenFile } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { memoize } from "@smithy/property-provider";
import { AwsError } from "../aws/aws-error.js";
import { REQUEST_HANDLER } from "../aws/client-defaults.js";
import type { AppSettings, AuthMode } from "../config.js";
import { blank, parseBool, type EnvLookup } from "../env.js";

/** The provider-factory functions this module calls; injectable so tests can spy on the STS client config passed through. */
export interface CredentialSdk {
  fromEnv: typeof fromEnv;
  fromIni: typeof fromIni;
  fromTokenFile: typeof fromTokenFile;
  fromHttp: typeof fromHttp;
  fromInstanceMetadata: typeof fromInstanceMetadata;
}

const defaultSdk: CredentialSdk = { fromEnv, fromIni, fromTokenFile, fromHttp, fromInstanceMetadata };

export interface CredentialSelection {
  mode: AuthMode;
  reason: string;
}

/** Everything the Identity tab shows about how the app authenticates, plus the SDK provider itself. */
export interface CredentialSpec extends CredentialSelection {
  credential_type: string;
  role_arn: string | null;
  role_session_name: string | null;
  token_file: string | null;
  container_credentials_uri: string | null;
  profile: string | null;
  provider: AwsCredentialIdentityProvider;
}

const IMDS_FALLBACK = "auto: no workload credentials in the environment; falling back to EC2 instance metadata (the node's role)";

/** Explicit AUTH_MODE wins; `auto` follows the SDK default chain's order so the label always matches what the SDK would do. */
export function resolveAuthMode(settings: AppSettings, env: EnvLookup): CredentialSelection {
  if (settings.authMode !== "auto") return { mode: settings.authMode, reason: `AUTH_MODE=${settings.authMode}` };
  if (blank(env("AWS_ACCESS_KEY_ID")) && blank(env("AWS_SECRET_ACCESS_KEY"))) {
    return { mode: "static", reason: "auto: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set" };
  }
  if (blank(env("AWS_PROFILE"))) return { mode: "profile", reason: "auto: AWS_PROFILE is set" };
  if (blank(env("AWS_WEB_IDENTITY_TOKEN_FILE")) && blank(env("AWS_ROLE_ARN"))) {
    return { mode: "web-identity", reason: "auto: AWS_WEB_IDENTITY_TOKEN_FILE and AWS_ROLE_ARN are set" };
  }
  if (blank(env("AWS_CONTAINER_CREDENTIALS_FULL_URI"))) return { mode: "pod-identity", reason: "auto: AWS_CONTAINER_CREDENTIALS_FULL_URI is set" };
  if (blank(env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"))) return { mode: "pod-identity", reason: "auto: AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is set" };
  if (imdsDisabled(env)) return { mode: "imds", reason: "auto: nothing matched and AWS_EC2_METADATA_DISABLED=true" };
  return { mode: "imds", reason: IMDS_FALLBACK };
}

function imdsDisabled(env: EnvLookup): boolean {
  return parseBool(env("AWS_EC2_METADATA_DISABLED")) === true;
}

function requireVars(mode: AuthMode, vars: Record<string, string | undefined>): void {
  const missing = Object.entries(vars).filter(([, v]) => v === undefined).map(([k]) => k);
  if (missing.length > 0) throw new AwsError(`AUTH_MODE ${mode} requires ${missing.join(", ")}`, "MissingConfiguration");
}

/** Credentials are considered stale five minutes before expiry (matches the SDK's own default). */
function isExpired(creds: { expiration?: Date }): boolean {
  return creds.expiration !== undefined && creds.expiration.getTime() - Date.now() < 5 * 60_000;
}

function requiresRefresh(creds: { expiration?: Date }): boolean {
  return creds.expiration !== undefined;
}

const NO_CREDENTIALS_HINT =
  "auto: no credentials found (set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE, AWS_WEB_IDENTITY_TOKEN_FILE+AWS_ROLE_ARN, or AWS_CONTAINER_CREDENTIALS_*) and AWS_EC2_METADATA_DISABLED=true — on Kubernetes: is the credentials Secret created and the pod restarted?";

/** Builds the one provider every SDK client shares; throws AwsError naming every missing variable. */
export function createCredentialSpec(settings: AppSettings, env: EnvLookup, sdk: CredentialSdk = defaultSdk): CredentialSpec {
  const { mode, reason } = resolveAuthMode(settings, env);
  const base = { mode, reason, role_arn: null, role_session_name: null, token_file: null, container_credentials_uri: null, profile: null };
  // The STS client behind fromTokenFile/fromIni (assume-role) otherwise gets no region and no
  // timeouts: memoize calls the inner provider with no arguments, so the SDK's own
  // callerClientConfig plumbing never reaches it.
  const stsConfig = { region: settings.region, maxAttempts: 2, requestHandler: REQUEST_HANDLER };
  let spec: CredentialSpec;
  switch (mode) {
    case "auto":
      throw new AwsError("resolveAuthMode should never return 'auto'");
    case "static": {
      requireVars(mode, { AWS_ACCESS_KEY_ID: blank(env("AWS_ACCESS_KEY_ID")), AWS_SECRET_ACCESS_KEY: blank(env("AWS_SECRET_ACCESS_KEY")) });
      // fromEnv reads process.env itself; in production env === processEnv so the values agree.
      spec = { ...base, credential_type: "fromEnv (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)", provider: sdk.fromEnv() };
      break;
    }
    case "profile": {
      const profile = blank(env("AWS_PROFILE"));
      requireVars(mode, { AWS_PROFILE: profile });
      spec = {
        ...base,
        credential_type: `fromIni (profile '${profile}')`,
        profile: profile ?? null,
        provider: sdk.fromIni({ profile: profile ?? undefined, clientConfig: stsConfig }),
      };
      break;
    }
    case "web-identity": {
      const tokenFile = blank(env("AWS_WEB_IDENTITY_TOKEN_FILE"));
      const roleArn = blank(env("AWS_ROLE_ARN"));
      const sessionName = blank(env("AWS_ROLE_SESSION_NAME"));
      requireVars(mode, { AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile, AWS_ROLE_ARN: roleArn });
      spec = {
        ...base,
        credential_type: "fromTokenFile → sts:AssumeRoleWithWebIdentity",
        role_arn: roleArn ?? null,
        role_session_name: sessionName ?? null,
        token_file: tokenFile ?? null,
        // fromTokenFile re-reads the file on every resolve, so a sidecar-rotated JWT-SVID is picked up.
        provider: sdk.fromTokenFile({ webIdentityTokenFile: tokenFile, roleArn, roleSessionName: sessionName, clientConfig: stsConfig }),
      };
      break;
    }
    case "pod-identity": {
      const fullUri = blank(env("AWS_CONTAINER_CREDENTIALS_FULL_URI"));
      const relativeUri = blank(env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"));
      if (!fullUri && !relativeUri) {
        throw new AwsError(`AUTH_MODE ${mode} requires AWS_CONTAINER_CREDENTIALS_FULL_URI or AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, "MissingConfiguration");
      }
      spec = {
        ...base,
        credential_type: "fromHttp (container credentials endpoint)",
        container_credentials_uri: fullUri ?? relativeUri ?? null,
        provider: sdk.fromHttp({
          awsContainerCredentialsFullUri: fullUri,
          awsContainerCredentialsRelativeUri: relativeUri,
          awsContainerAuthorizationTokenFile: blank(env("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE")),
          awsContainerAuthorizationToken: blank(env("AWS_CONTAINER_AUTHORIZATION_TOKEN")),
        }),
      };
      break;
    }
    case "imds": {
      if (imdsDisabled(env)) {
        // `auto` only reaches `imds` with IMDS disabled as a last resort (nothing else matched);
        // "AUTH_MODE imds requires ..." would wrongly suggest the user asked for imds explicitly.
        if (settings.authMode === "auto") throw new AwsError(NO_CREDENTIALS_HINT, "MissingCredentials");
        throw new AwsError(`AUTH_MODE ${mode} requires AWS_EC2_METADATA_DISABLED to be unset or false`, "MissingConfiguration");
      }
      spec = { ...base, credential_type: "fromInstanceMetadata (EC2 instance role)", provider: sdk.fromInstanceMetadata({ timeout: 1000, maxRetries: 1 }) };
      break;
    }
    default: {
      const never: never = mode;
      throw new AwsError(`unsupported AUTH_MODE ${String(never)}`);
    }
  }
  return { ...spec, provider: memoize(spec.provider, isExpired, requiresRefresh) };
}
