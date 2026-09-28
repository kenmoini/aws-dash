import type { Instance, IpPermission, SecurityGroup, Subnet, Tag, Vpc } from "@aws-sdk/client-ec2";
import type { Repository } from "@aws-sdk/client-ecr";
import type { Cluster } from "@aws-sdk/client-eks";
import type { Bucket } from "@aws-sdk/client-s3";
import type { GetCallerIdentityCommandOutput } from "@aws-sdk/client-sts";
import type {
  AccountInfo, BucketInfo, EcrRepositoryInfo, EksClusterInfo, InstanceInfo, SecurityGroupRuleInfo, SubnetInfo, VpcInfo,
} from "./models.js";

const iso = (d: Date | undefined): string | null => (d instanceof Date ? d.toISOString() : null);
const str = (v: string | undefined): string | null => (v === undefined || v === "" ? null : v);

export function tagName(tags: Tag[] | undefined): string | null {
  return str(tags?.find((t) => t.Key === "Name")?.Value);
}

/** `arn:<partition>:...`; defaults to the commercial partition when the ARN is missing. */
export function arnPartition(arn: string | undefined): string {
  return arn?.split(":")[1] || "aws";
}

export function mapAccount(identity: GetCallerIdentityCommandOutput, alias: string | null, region: string): AccountInfo {
  return {
    account_id: identity.Account ?? "",
    alias,
    arn: identity.Arn ?? "",
    user_id: identity.UserId ?? "",
    partition: arnPartition(identity.Arn),
    region,
  };
}

export function mapInstance(i: Instance): InstanceInfo {
  return {
    id: i.InstanceId ?? "",
    name: tagName(i.Tags),
    type: str(i.InstanceType),
    state: str(i.State?.Name),
    az: str(i.Placement?.AvailabilityZone),
    private_ip: str(i.PrivateIpAddress),
    public_ip: str(i.PublicIpAddress),
    vpc_id: str(i.VpcId),
    subnet_id: str(i.SubnetId),
    launch_time: iso(i.LaunchTime),
    iam_profile: str(i.IamInstanceProfile?.Arn),
  };
}

export function mapVpc(v: Vpc): VpcInfo {
  return { id: v.VpcId ?? "", name: tagName(v.Tags), cidr: str(v.CidrBlock), is_default: v.IsDefault === true, state: str(v.State) };
}

export function mapSubnet(s: Subnet): SubnetInfo {
  return {
    id: s.SubnetId ?? "",
    name: tagName(s.Tags),
    vpc_id: str(s.VpcId),
    cidr: str(s.CidrBlock),
    az: str(s.AvailabilityZone),
    available_ips: typeof s.AvailableIpAddressCount === "number" ? s.AvailableIpAddressCount : null,
    map_public_ip: s.MapPublicIpOnLaunch === true,
  };
}

function portRange(p: IpPermission): string {
  if (p.IpProtocol === "-1" || p.IpProtocol === undefined) return "all";
  const from = p.FromPort;
  const to = p.ToPort;
  if (from === undefined || from < 0) return "all";
  return to === undefined || to === from ? String(from) : `${from}-${to}`;
}

function peers(p: IpPermission): string[] {
  const out = [
    ...(p.IpRanges ?? []).map((r) => r.CidrIp),
    ...(p.Ipv6Ranges ?? []).map((r) => r.CidrIpv6),
    ...(p.UserIdGroupPairs ?? []).map((g) => g.GroupId),
    ...(p.PrefixListIds ?? []).map((l) => l.PrefixListId),
  ].filter((x): x is string => typeof x === "string" && x !== "");
  return out.length > 0 ? out : ["—"];
}

/** One row per (permission, peer); the NSG-rules view of the sibling apps. */
export function flattenSecurityGroupRules(g: SecurityGroup): SecurityGroupRuleInfo[] {
  const base = { group_id: g.GroupId ?? "", group_name: str(g.GroupName), vpc_id: str(g.VpcId) };
  const rows = (direction: "ingress" | "egress", permissions: IpPermission[] | undefined) =>
    (permissions ?? []).flatMap((p) => {
      const protocol = p.IpProtocol === "-1" || p.IpProtocol === undefined ? "all" : p.IpProtocol;
      const ports = portRange(p);
      return peers(p).map((peer) => ({ ...base, direction, protocol, ports, peer }));
    });
  return [...rows("ingress", g.IpPermissions), ...rows("egress", g.IpPermissionsEgress)];
}

export function mapBucket(b: Bucket): BucketInfo {
  return { name: b.Name ?? "", region: str(b.BucketRegion), created: iso(b.CreationDate) };
}

export function mapEksCluster(c: Cluster): EksClusterInfo {
  return {
    name: c.name ?? "",
    version: str(c.version),
    status: str(c.status),
    platform_version: str(c.platformVersion),
    oidc_issuer: str(c.identity?.oidc?.issuer),
    endpoint_public: c.resourcesVpcConfig?.endpointPublicAccess === true,
    endpoint_private: c.resourcesVpcConfig?.endpointPrivateAccess === true,
    auth_mode: str(c.accessConfig?.authenticationMode),
  };
}

export function mapEcrRepository(r: Repository): EcrRepositoryInfo {
  return {
    name: r.repositoryName ?? "",
    uri: str(r.repositoryUri),
    created: iso(r.createdAt),
    tag_mutability: str(r.imageTagMutability),
    scan_on_push: r.imageScanningConfiguration?.scanOnPush === true,
  };
}
