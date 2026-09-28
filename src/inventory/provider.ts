import type { InventoryKind } from "./kinds.js";
import type {
  AccountInfo, BucketInfo, EcrRepositoryInfo, EksClusterInfo, InstanceInfo, InventoryItem, ListResult,
  SecurityGroupRuleInfo, SubnetInfo, VpcInfo,
} from "./models.js";

/** Everything the AWS tab needs from AWS; the live implementation talks to the SDK, the test fake returns fixtures. */
export interface AwsProvider {
  getAccount(): Promise<ListResult<AccountInfo>>;
  listInstances(): Promise<ListResult<InstanceInfo>>;
  listVpcs(): Promise<ListResult<VpcInfo>>;
  listSubnets(): Promise<ListResult<SubnetInfo>>;
  listSecurityGroupRules(): Promise<ListResult<SecurityGroupRuleInfo>>;
  listBuckets(): Promise<ListResult<BucketInfo>>;
  listEksClusters(): Promise<ListResult<EksClusterInfo>>;
  listEcrRepositories(): Promise<ListResult<EcrRepositoryInfo>>;
}

export function fetchKind(provider: AwsProvider, kind: InventoryKind): Promise<ListResult<InventoryItem>> {
  switch (kind) {
    case "account": return provider.getAccount();
    case "instances": return provider.listInstances();
    case "vpcs": return provider.listVpcs();
    case "subnets": return provider.listSubnets();
    case "securitygroups": return provider.listSecurityGroupRules();
    case "s3buckets": return provider.listBuckets();
    case "eksclusters": return provider.listEksClusters();
    case "ecrrepos": return provider.listEcrRepositories();
  }
}
