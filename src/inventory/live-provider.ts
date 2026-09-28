import { EC2Client, paginateDescribeInstances, paginateDescribeSecurityGroups, paginateDescribeSubnets, paginateDescribeVpcs } from "@aws-sdk/client-ec2";
import { ECRClient, paginateDescribeRepositories } from "@aws-sdk/client-ecr";
import { DescribeClusterCommand, EKSClient, paginateListClusters } from "@aws-sdk/client-eks";
import { IAMClient, ListAccountAliasesCommand } from "@aws-sdk/client-iam";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { Logger } from "pino";
import { clientDefaults, type AwsClientDefaults } from "../aws/client-defaults.js";
import type { AppSettings } from "../config.js";
import type { CredentialProvider } from "../identity/credential-provider.js";
import { flattenSecurityGroupRules, mapAccount, mapBucket, mapEcrRepository, mapEksCluster, mapInstance, mapSubnet, mapVpc } from "./mappers.js";
import { MAX_ITEMS, type AccountInfo, type BucketInfo, type EcrRepositoryInfo, type EksClusterInfo, type InstanceInfo, type ListResult, type SecurityGroupRuleInfo, type SubnetInfo, type VpcInfo } from "./models.js";
import type { AwsProvider } from "./provider.js";

export interface LiveAwsProviderOptions {
  maxItems?: number;
  eksDescribeCap?: number;
  eksConcurrency?: number;
}

/** Collects mapped rows from an async page iterator, stopping at `max` with `truncated: true`. */
async function collect<T, R>(pages: AsyncIterable<T>, pick: (page: T) => R[], max: number): Promise<ListResult<R>> {
  const items: R[] = [];
  for await (const page of pages) {
    for (const item of pick(page)) {
      if (items.length >= max) return { items, truncated: true };
      items.push(item);
    }
  }
  return { items, truncated: false };
}

/** The real AwsProvider: one lazily-created client per service, all sharing the same credentials and client defaults. */
export class LiveAwsProvider implements AwsProvider {
  private readonly maxItems: number;
  private readonly eksDescribeCap: number;
  private readonly eksConcurrency: number;
  private ec2Client: EC2Client | undefined;
  private s3Client: S3Client | undefined;
  private stsClient: STSClient | undefined;
  private iamClient: IAMClient | undefined;
  private eksClient: EKSClient | undefined;
  private ecrClient: ECRClient | undefined;

  constructor(private readonly config: AwsClientDefaults, opts: LiveAwsProviderOptions = {}) {
    this.maxItems = opts.maxItems ?? MAX_ITEMS;
    this.eksDescribeCap = opts.eksDescribeCap ?? 20;
    this.eksConcurrency = opts.eksConcurrency ?? 4;
  }

  private ec2(): EC2Client { return (this.ec2Client ??= new EC2Client(this.config)); }
  private s3(): S3Client { return (this.s3Client ??= new S3Client(this.config)); }
  private sts(): STSClient { return (this.stsClient ??= new STSClient(this.config)); }
  private iam(): IAMClient { return (this.iamClient ??= new IAMClient(this.config)); }
  private eks(): EKSClient { return (this.eksClient ??= new EKSClient(this.config)); }
  private ecr(): ECRClient { return (this.ecrClient ??= new ECRClient(this.config)); }

  async getAccount(): Promise<ListResult<AccountInfo>> {
    const identity = await this.sts().send(new GetCallerIdentityCommand({}));
    // The alias is a nicety; a missing iam:ListAccountAliases permission must not fail the panel.
    const alias = await this.iam().send(new ListAccountAliasesCommand({ MaxItems: 1 }))
      .then((r) => r.AccountAliases?.[0] ?? null, () => null);
    return { items: [mapAccount(identity, alias, this.config.region)], truncated: false };
  }

  listInstances(): Promise<ListResult<InstanceInfo>> {
    return collect(paginateDescribeInstances({ client: this.ec2() }, {}), (p) => (p.Reservations ?? []).flatMap((r) => (r.Instances ?? []).map(mapInstance)), this.maxItems);
  }

  listVpcs(): Promise<ListResult<VpcInfo>> {
    return collect(paginateDescribeVpcs({ client: this.ec2() }, {}), (p) => (p.Vpcs ?? []).map(mapVpc), this.maxItems);
  }

  listSubnets(): Promise<ListResult<SubnetInfo>> {
    return collect(paginateDescribeSubnets({ client: this.ec2() }, {}), (p) => (p.Subnets ?? []).map(mapSubnet), this.maxItems);
  }

  listSecurityGroupRules(): Promise<ListResult<SecurityGroupRuleInfo>> {
    return collect(paginateDescribeSecurityGroups({ client: this.ec2() }, {}), (p) => (p.SecurityGroups ?? []).flatMap(flattenSecurityGroupRules), this.maxItems);
  }

  async listBuckets(): Promise<ListResult<BucketInfo>> {
    const out = await this.s3().send(new ListBucketsCommand({}));
    const all = (out.Buckets ?? []).map(mapBucket);
    return { items: all.slice(0, this.maxItems), truncated: all.length > this.maxItems };
  }

  async listEksClusters(): Promise<ListResult<EksClusterInfo>> {
    const names = await collect(paginateListClusters({ client: this.eks() }, {}), (p) => p.clusters ?? [], this.eksDescribeCap);
    const items: EksClusterInfo[] = [];
    for (let i = 0; i < names.items.length; i += this.eksConcurrency) {
      const batch = names.items.slice(i, i + this.eksConcurrency);
      const described = await Promise.all(batch.map((name) => this.eks().send(new DescribeClusterCommand({ name }))));
      for (const d of described) if (d.cluster) items.push(mapEksCluster(d.cluster));
    }
    return { items, truncated: names.truncated };
  }

  listEcrRepositories(): Promise<ListResult<EcrRepositoryInfo>> {
    return collect(paginateDescribeRepositories({ client: this.ecr() }, {}), (p) => (p.repositories ?? []).map(mapEcrRepository), this.maxItems);
  }
}

/** Production factory: fails fast (as an AwsError) on a missing region or credential misconfiguration so the panels can show why. */
export function createLiveAwsProvider(deps: { settings: AppSettings; credentials: CredentialProvider; logger: Logger }): AwsProvider {
  const config = clientDefaults({
    region: deps.settings.region,
    credentials: deps.credentials.provider(),
    logger: deps.logger,
    debug: deps.settings.awsDebug,
  });
  return new LiveAwsProvider(config);
}
