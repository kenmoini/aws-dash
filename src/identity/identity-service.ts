import { GetCallerIdentityCommand, type GetCallerIdentityCommandOutput } from "@aws-sdk/client-sts";
import type { AttributedAwsCredentialIdentity } from "@aws-sdk/types";
import type { Logger } from "pino";
import { awsErrorFrom } from "../aws/aws-error.js";
import { clientDefaults, type AwsClientDefaults } from "../aws/client-defaults.js";
import type { Clock } from "../clock.js";
import type { AppSettings } from "../config.js";
import { blank, type EnvLookup } from "../env.js";
import type { TtlCache } from "../inventory/ttl-cache.js";
import type { CredentialProvider } from "./credential-provider.js";
import type { CredentialSpec } from "./credential-factory.js";
import { decodeJwtForDisplay, FEDERATED_CLAIMS } from "./jwt-display.js";

export interface TokenSummary {
  claims: Record<string, string>;
  issued_at: string | null;
  expires_at: string | null;
  expires_in_seconds: number | null;
  error: string | null;
}

export interface StsIdentity {
  account: string | null;
  arn: string | null;
  user_id: string | null;
  principal_type: string | null;
  role_name: string | null;
  session_name: string | null;
  error: string | null;
  hint: string | null;
}

export interface CredentialFacts {
  key_prefix: string | null;
  key_id_masked: string | null;
  temporary: boolean | null;
  expiration: string | null;
  expires_in_seconds: number | null;
  account_id: string | null;
  source: string[];
  error: string | null;
}

/** GET /api/identity — spec §5. Keys are ordered exactly as serialized. */
export interface IdentityInfo {
  mode: string;
  reason: string;
  flavor: string | null;
  credential_type: string | null;
  region: string | null;
  role_arn: string | null;
  role_session_name: string | null;
  token_file: string | null;
  container_credentials_uri: string | null;
  profile: string | null;
  error: string | null;
  token: TokenSummary | null;
  sts: StsIdentity | null;
  credentials: CredentialFacts | null;
  fetched_at: string;
}

export interface StsLike {
  send(command: GetCallerIdentityCommand): Promise<GetCallerIdentityCommandOutput>;
}

const SOURCE_LABELS: Record<string, string> = {
  g: "environment variables",
  h: "web-identity token file",
  k: "sts:AssumeRoleWithWebIdentity",
  i: "sts:AssumeRole",
  z: "container credentials endpoint",
  "0": "EC2 instance metadata",
  n: "shared config profile",
  o: "profile: source_profile",
  p: "profile: named provider",
  q: "profile: web-identity token",
  r: "profile: SSO",
  s: "SSO",
  v: "profile: credential_process",
  w: "credential_process",
  e: "code",
  T: "account id resolved",
};

/** `$source` is a map of feature name → one-or-two-character id; we show the ids with a human label. */
export function decodeSources(source: Record<string, string> | undefined): string[] {
  if (!source) return [];
  return Object.values(source).map((id) => `${id}: ${SOURCE_LABELS[id] ?? "(unknown)"}`).sort();
}

export function maskKeyId(id: string | undefined): string | null {
  if (id === undefined) return null;
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : "…";
}

export function parsePrincipal(arn: string | undefined): Pick<StsIdentity, "principal_type" | "role_name" | "session_name"> {
  const resource = arn?.split(":").slice(5).join(":");
  if (!resource) return { principal_type: null, role_name: null, session_name: null };
  const [kind, ...rest] = resource.split("/");
  if (kind === "assumed-role") return { principal_type: "assumed-role", role_name: rest[0] ?? null, session_name: rest.slice(1).join("/") || null };
  if (kind === "root") return { principal_type: "root", role_name: null, session_name: null };
  return { principal_type: kind ?? null, role_name: null, session_name: null };
}

export function flavorOf(spec: Pick<CredentialSpec, "mode" | "container_credentials_uri">, claims: Record<string, string>): string {
  switch (spec.mode) {
    case "web-identity": {
      if (claims["sub"]?.startsWith("spiffe://")) return "SPIFFE JWT-SVID (spiffe-helper)";
      if (claims["iss"]?.includes("oidc.eks.")) return "EKS IRSA";
      if (claims["sub"]?.startsWith("system:serviceaccount:")) return "Kubernetes projected service-account token";
      return "OIDC token file";
    }
    case "pod-identity": {
      const uri = spec.container_credentials_uri ?? "";
      if (uri.includes("169.254.170.23") || uri.includes("[fd00:ec2::23]")) return "EKS Pod Identity";
      if (uri.startsWith("/")) return "ECS task role";
      return "container credentials endpoint";
    }
    case "static": return "long-lived IAM user access key";
    case "profile": return "shared config profile";
    case "imds": return "EC2 instance role (IMDS)";
    default: return spec.mode;
  }
}

const NOT_ATTEMPTED: StsIdentity = { account: null, arn: null, user_id: null, principal_type: null, role_name: null, session_name: null, error: "not attempted: credentials could not be resolved", hint: null };

export interface IdentityServiceOptions {
  settings: AppSettings;
  env: EnvLookup;
  clock: Clock;
  logger: Logger;
  credentials: CredentialProvider;
  createStsClient: (config: AwsClientDefaults) => StsLike;
  cache: TtlCache;
  readFile?: (path: string) => string;
}

/** Explains the credential chain end to end; never throws — each section carries its own error. */
export class IdentityService {
  private static readonly KEY = "identity";
  private readonly readFile: (path: string) => string;
  private stsClient: StsLike | undefined;

  constructor(private readonly opts: IdentityServiceOptions) {
    this.readFile = opts.readFile ?? ((path) => { throw new Error(`no readFile configured for ${path}`); });
  }

  async get(force = false): Promise<IdentityInfo> {
    const entry = await this.opts.cache.get<IdentityInfo>(IdentityService.KEY, () => this.load(), force);
    // load() never rejects, so value is always present.
    const info = entry.value as IdentityInfo;
    // Unresolved credentials (no token file yet, misconfigured mode) are shown but not cached for the TTL: the next
    // request retries, so a pod whose sidecar had not written the token at startup recovers on its own.
    if (info.error !== null || (info.credentials !== null && info.credentials.error !== null)) this.opts.cache.invalidateAll();
    return info;
  }

  peek(): IdentityInfo | null {
    return this.opts.cache.peek<IdentityInfo>(IdentityService.KEY)?.value ?? null;
  }

  invalidateAll(): void {
    this.opts.cache.invalidateAll();
  }

  private async load(): Promise<IdentityInfo> {
    const now = this.opts.clock.now();
    const selection = this.opts.credentials.describe();
    const base = {
      mode: selection.mode, reason: selection.reason, flavor: null as string | null, credential_type: null as string | null,
      region: this.opts.settings.region ?? null, role_arn: null as string | null, role_session_name: null as string | null,
      token_file: null as string | null, container_credentials_uri: null as string | null, profile: null as string | null,
    };
    let spec: CredentialSpec;
    try {
      spec = this.opts.credentials.get();
    } catch (err) {
      return { ...base, error: awsErrorFrom(err).message, token: null, sts: null, credentials: null, fetched_at: now.toISOString() };
    }

    const tokenFile = spec.token_file ?? (spec.mode === "pod-identity" ? (blank(this.opts.env("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE")) ?? null) : null);
    const token = tokenFile ? this.readToken(tokenFile, now) : null;
    const credentials = await this.resolveCredentials(spec, now);
    const sts = credentials.error === null ? await this.callerIdentity(spec) : NOT_ATTEMPTED;

    return {
      ...base,
      flavor: flavorOf(spec, token?.claims ?? {}),
      credential_type: spec.credential_type,
      role_arn: spec.role_arn,
      role_session_name: spec.role_session_name,
      token_file: tokenFile,
      container_credentials_uri: spec.container_credentials_uri,
      profile: spec.profile,
      error: null,
      token,
      sts,
      credentials,
      fetched_at: now.toISOString(),
    };
  }

  private readToken(path: string, now: Date): TokenSummary {
    let raw: string;
    try {
      raw = this.readFile(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { claims: {}, issued_at: null, expires_at: null, expires_in_seconds: null, error: `could not read ${path}: ${message}` };
    }
    const summary = decodeJwtForDisplay(raw, FEDERATED_CLAIMS);
    return { ...summary, expires_in_seconds: secondsUntil(summary.expires_at, now) };
  }

  private async resolveCredentials(spec: CredentialSpec, now: Date): Promise<CredentialFacts> {
    try {
      const creds = (await spec.provider()) as AttributedAwsCredentialIdentity;
      const expiration = creds.expiration?.toISOString() ?? null;
      return {
        key_prefix: creds.accessKeyId ? creds.accessKeyId.slice(0, 4) : null,
        key_id_masked: maskKeyId(creds.accessKeyId),
        temporary: creds.sessionToken !== undefined || creds.expiration !== undefined,
        expiration,
        expires_in_seconds: secondsUntil(expiration, now),
        account_id: creds.accountId ?? null,
        source: decodeSources(creds.$source),
        error: null,
      };
    } catch (err) {
      const error = awsErrorFrom(err);
      this.opts.logger.warn({ mode: spec.mode, error: error.message }, "credential resolution failed");
      return { key_prefix: null, key_id_masked: null, temporary: null, expiration: null, expires_in_seconds: null, account_id: null, source: [], error: error.message };
    }
  }

  private async callerIdentity(spec: CredentialSpec): Promise<StsIdentity> {
    try {
      this.stsClient ??= this.opts.createStsClient(clientDefaults({
        region: this.opts.settings.region, credentials: spec.provider, logger: this.opts.logger, debug: this.opts.settings.awsDebug,
      }));
      const out = await this.stsClient.send(new GetCallerIdentityCommand({}));
      return { account: out.Account ?? null, arn: out.Arn ?? null, user_id: out.UserId ?? null, ...parsePrincipal(out.Arn), error: null, hint: null };
    } catch (err) {
      const error = awsErrorFrom(err);
      const [head, ...hint] = error.message.split(" — ");
      return { account: null, arn: null, user_id: null, principal_type: null, role_name: null, session_name: null, error: head ?? error.message, hint: hint.length ? hint.join(" — ") : null };
    }
  }
}

function secondsUntil(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  return Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
}
