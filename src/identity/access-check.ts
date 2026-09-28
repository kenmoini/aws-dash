import { DescribeInstancesCommand, DescribeRegionsCommand, DescribeSecurityGroupsCommand, DescribeSubnetsCommand, DescribeVpcsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DescribeRepositoriesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { EKSClient, ListClustersCommand } from "@aws-sdk/client-eks";
import { GetRoleCommand, IAMClient, ListAccountAliasesCommand } from "@aws-sdk/client-iam";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient, type GetCallerIdentityCommandOutput } from "@aws-sdk/client-sts";
import type { Logger } from "pino";
import { awsErrorFrom, firstLine } from "../aws/aws-error.js";
import { clientDefaults, type AwsClientDefaults } from "../aws/client-defaults.js";
import type { Clock } from "../clock.js";
import type { AppSettings } from "../config.js";
import type { TtlCache } from "../inventory/ttl-cache.js";
import { ACCESS_CHECK_ACTION_NAMES, type AccessCheckAction } from "./access-check-actions.js";
import type { CredentialProvider } from "./credential-provider.js";
import { parsePrincipal } from "./identity-service.js";

export type AccessCheckResult = "allowed" | "denied" | "credential" | "error" | "skipped";

export interface AccessCheckRow {
  action: AccessCheckAction;
  service: string;
  result: AccessCheckResult;
  code: string | null;
  message: string | null;
  duration_ms: number;
}

export interface AccessCheckReport {
  enabled: boolean;
  fetched_at: string | null;
  principal_arn: string | null;
  error: string | null;
  rows: AccessCheckRow[];
}

export interface SendLike {
  send(command: unknown): Promise<unknown>;
}

export interface AccessCheckClients {
  sts: SendLike;
  iam: SendLike;
  ec2: SendLike;
  s3: SendLike;
  eks: SendLike;
  ecr: SendLike;
}

export interface AccessCheckObserver {
  checked(rows: AccessCheckRow[]): void;
}

const DENIED = new Set(["AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "UnauthorizedAccess", "AuthorizationError"]);
const CREDENTIAL = new Set(["CredentialsProviderError", "ProviderError", "ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId", "InvalidIdentityToken", "UnrecognizedClientException", "AuthFailure"]);

export function classify(err: unknown): { result: AccessCheckResult; code: string | null; message: string | null } {
  const e = (typeof err === "object" && err !== null ? err : {}) as { name?: unknown; message?: unknown; $metadata?: { httpStatusCode?: number } };
  const name = typeof e.name === "string" && e.name ? e.name : "Error";
  const message = firstLine(typeof e.message === "string" ? e.message : String(err));
  const status = e.$metadata?.httpStatusCode;
  if (CREDENTIAL.has(name)) return { result: "credential", code: name, message };
  if (DENIED.has(name) || status === 403) return { result: "denied", code: name, message };
  return { result: "error", code: name, message };
}

interface Context {
  region: string;
  roleName: string | null;
}

interface ActionDef {
  action: AccessCheckAction;
  service: keyof AccessCheckClients;
  /** Returns the command to send, or a skip reason. */
  command: (ctx: Context) => { send: unknown } | { skip: string };
}

const ACTIONS: readonly ActionDef[] = [
  { action: "sts:GetCallerIdentity", service: "sts", command: () => ({ send: new GetCallerIdentityCommand({}) }) },
  { action: "iam:ListAccountAliases", service: "iam", command: () => ({ send: new ListAccountAliasesCommand({ MaxItems: 1 }) }) },
  { action: "ec2:DescribeRegions", service: "ec2", command: (c) => ({ send: new DescribeRegionsCommand({ RegionNames: [c.region] }) }) },
  { action: "ec2:DescribeInstances", service: "ec2", command: () => ({ send: new DescribeInstancesCommand({ MaxResults: 5 }) }) },
  { action: "ec2:DescribeVpcs", service: "ec2", command: () => ({ send: new DescribeVpcsCommand({ MaxResults: 5 }) }) },
  { action: "ec2:DescribeSubnets", service: "ec2", command: () => ({ send: new DescribeSubnetsCommand({ MaxResults: 5 }) }) },
  { action: "ec2:DescribeSecurityGroups", service: "ec2", command: () => ({ send: new DescribeSecurityGroupsCommand({ MaxResults: 5 }) }) },
  { action: "s3:ListAllMyBuckets", service: "s3", command: () => ({ send: new ListBucketsCommand({ MaxBuckets: 1 }) }) },
  { action: "eks:ListClusters", service: "eks", command: () => ({ send: new ListClustersCommand({ maxResults: 1 }) }) },
  { action: "ecr:DescribeRepositories", service: "ecr", command: () => ({ send: new DescribeRepositoriesCommand({ maxResults: 1 }) }) },
  { action: "iam:GetRole", service: "iam", command: (c) => (c.roleName ? { send: new GetRoleCommand({ RoleName: c.roleName }) } : { skip: "skipped: the caller is not an assumed role" }) },
];

export function createAccessCheckClients(config: AwsClientDefaults): AccessCheckClients {
  return { sts: new STSClient(config), iam: new IAMClient(config), ec2: new EC2Client(config), s3: new S3Client(config), eks: new EKSClient(config), ecr: new ECRClient(config) };
}

export interface AccessCheckServiceOptions {
  settings: AppSettings;
  clock: Clock;
  logger: Logger;
  credentials: CredentialProvider;
  createClients: (config: AwsClientDefaults) => AccessCheckClients;
  cache: TtlCache;
  observer?: AccessCheckObserver;
  concurrency?: number;
}

/** Probes each read-only action once; the STS gate runs first and a failed gate skips the rest. Never throws. */
export class AccessCheckService {
  private static readonly KEY = "access-check";
  private readonly observer: AccessCheckObserver;
  private readonly concurrency: number;
  private clients: AccessCheckClients | undefined;

  constructor(private readonly opts: AccessCheckServiceOptions) {
    this.observer = opts.observer ?? { checked: () => undefined };
    this.concurrency = opts.concurrency ?? 4;
  }

  async run(force = false): Promise<AccessCheckReport> {
    if (!this.opts.settings.accessCheckEnabled) return { enabled: false, fetched_at: null, principal_arn: null, error: null, rows: [] };
    const entry = await this.opts.cache.get<AccessCheckReport>(AccessCheckService.KEY, () => this.load(), force);
    return entry.value as AccessCheckReport;
  }

  peek(): AccessCheckReport | null {
    return this.opts.cache.peek<AccessCheckReport>(AccessCheckService.KEY)?.value ?? null;
  }

  invalidateAll(): void {
    this.opts.cache.invalidateAll();
  }

  private selected(): readonly ActionDef[] {
    const wanted = this.opts.settings.accessCheckActions;
    const chosen = wanted === undefined ? ACTIONS : ACTIONS.filter((a) => a.action === "sts:GetCallerIdentity" || wanted.includes(a.action));
    return [...chosen].sort((a, b) => ACCESS_CHECK_ACTION_NAMES.indexOf(a.action) - ACCESS_CHECK_ACTION_NAMES.indexOf(b.action));
  }

  private getClients(): AccessCheckClients {
    if (this.clients === undefined) {
      const config = clientDefaults({
        region: this.opts.settings.region, credentials: this.opts.credentials.provider(), logger: this.opts.logger, debug: this.opts.settings.awsDebug,
      });
      this.clients = this.opts.createClients(config);
    }
    return this.clients;
  }

  private async load(): Promise<AccessCheckReport> {
    const fetchedAt = this.opts.clock.now().toISOString();
    let clients: AccessCheckClients;
    try {
      clients = this.getClients();
    } catch (err) {
      return { enabled: true, fetched_at: fetchedAt, principal_arn: null, error: awsErrorFrom(err).message, rows: [] };
    }
    const region = this.opts.settings.region ?? "";
    const [gateDef, ...rest] = this.selected();
    const gate = await this.probe(clients, gateDef as ActionDef, { region, roleName: null });
    let principalArn: string | null = null;
    let roleName: string | null = null;
    if (gate.row.result === "allowed") {
      const out = gate.output as GetCallerIdentityCommandOutput | undefined;
      principalArn = out?.Arn ?? null;
      roleName = parsePrincipal(out?.Arn).role_name;
    }
    const rows: AccessCheckRow[] = [gate.row];
    if (gate.row.result !== "allowed") {
      for (const def of rest) rows.push({ action: def.action, service: def.service, result: "skipped", code: null, message: "skipped: sts:GetCallerIdentity did not succeed", duration_ms: 0 });
    } else {
      const results = await this.pool(rest.map((def) => () => this.probe(clients, def, { region, roleName })));
      for (const r of results) rows.push(r.row);
    }
    this.observer.checked(rows);
    this.opts.logger.info({ allowed: rows.filter((r) => r.result === "allowed").length, total: rows.length }, "access check complete");
    return { enabled: true, fetched_at: fetchedAt, principal_arn: principalArn, error: null, rows };
  }

  private async probe(clients: AccessCheckClients, def: ActionDef, ctx: Context): Promise<{ row: AccessCheckRow; output?: unknown }> {
    const built = def.command(ctx);
    if ("skip" in built) return { row: { action: def.action, service: def.service, result: "skipped", code: null, message: built.skip, duration_ms: 0 } };
    const started = performance.now();
    try {
      const output = await clients[def.service].send(built.send);
      return { row: { action: def.action, service: def.service, result: "allowed", code: null, message: null, duration_ms: Math.round(performance.now() - started) }, output };
    } catch (err) {
      const c = classify(err);
      return { row: { action: def.action, service: def.service, ...c, duration_ms: Math.round(performance.now() - started) } };
    }
  }

  /** Runs tasks with bounded concurrency, preserving order. */
  private async pool<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await (tasks[i] as () => Promise<T>)();
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, tasks.length) }, worker));
    return results;
  }
}
