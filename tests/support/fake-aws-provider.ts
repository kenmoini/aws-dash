import type { InventoryKind } from "../../src/inventory/kinds.js";
import type {
  AccountInfo, BucketInfo, EcrRepositoryInfo, EksClusterInfo, InstanceInfo, ListResult, SecurityGroupRuleInfo, SubnetInfo, VpcInfo,
} from "../../src/inventory/models.js";
import type { AwsProvider } from "../../src/inventory/provider.js";

const list = <T>(...items: T[]): ListResult<T> => ({ items, truncated: false });

/** Fixture-backed AwsProvider: counts calls per kind and can be told to fail a kind with an SDK-shaped AccessDenied. */
export class FakeAwsProvider implements AwsProvider {
  readonly calls: Partial<Record<InventoryKind, number>> = {};
  private readonly failing = new Set<InventoryKind>();

  account: ListResult<AccountInfo> = list({ account_id: "123456789012", alias: "kemo-lab", arn: "arn:aws:iam::123456789012:user/aws-dash", user_id: "AIDAEXAMPLE", partition: "aws", region: "us-east-1" });
  instances: ListResult<InstanceInfo> = list({ id: "i-0abc", name: "web-1", type: "t3.micro", state: "running", az: "us-east-1a", private_ip: "10.0.1.5", public_ip: null, vpc_id: "vpc-1", subnet_id: "subnet-1", launch_time: "2026-01-01T00:00:00.000Z", iam_profile: "arn:aws:iam::123456789012:instance-profile/web" });
  vpcs: ListResult<VpcInfo> = list({ id: "vpc-1", name: "demo", cidr: "10.0.0.0/16", is_default: false, state: "available" });
  subnets: ListResult<SubnetInfo> = list({ id: "subnet-1", name: "demo-a", vpc_id: "vpc-1", cidr: "10.0.1.0/24", az: "us-east-1a", available_ips: 250, map_public_ip: false });
  securitygroups: ListResult<SecurityGroupRuleInfo> = list({ group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "ingress", protocol: "tcp", ports: "443", peer: "0.0.0.0/0" });
  s3buckets: ListResult<BucketInfo> = list({ name: "demo-bucket", region: "us-east-1", created: "2025-06-01T00:00:00.000Z" });
  eksclusters: ListResult<EksClusterInfo> = list({ name: "demo", version: "1.33", status: "ACTIVE", platform_version: "eks.5", oidc_issuer: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", endpoint_public: true, endpoint_private: false, auth_mode: "API_AND_CONFIG_MAP" });
  ecrrepos: ListResult<EcrRepositoryInfo> = list({ name: "aws-dash", uri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/aws-dash", created: "2025-06-01T00:00:00.000Z", tag_mutability: "MUTABLE", scan_on_push: true });

  fail(kind: InventoryKind): void { this.failing.add(kind); }
  recover(kind: InventoryKind): void { this.failing.delete(kind); }

  getAccount() { return this.answer("account", this.account); }
  listInstances() { return this.answer("instances", this.instances); }
  listVpcs() { return this.answer("vpcs", this.vpcs); }
  listSubnets() { return this.answer("subnets", this.subnets); }
  listSecurityGroupRules() { return this.answer("securitygroups", this.securitygroups); }
  listBuckets() { return this.answer("s3buckets", this.s3buckets); }
  listEksClusters() { return this.answer("eksclusters", this.eksclusters); }
  listEcrRepositories() { return this.answer("ecrrepos", this.ecrrepos); }

  private async answer<T>(kind: InventoryKind, result: ListResult<T>): Promise<ListResult<T>> {
    this.calls[kind] = (this.calls[kind] ?? 0) + 1;
    if (this.failing.has(kind)) {
      throw Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    }
    return { items: [...result.items], truncated: result.truncated };
  }
}
