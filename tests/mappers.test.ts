import { describe, expect, it } from "vitest";
import {
  arnPartition, flattenSecurityGroupRules, mapAccount, mapBucket, mapEcrRepository, mapEksCluster, mapInstance, mapSubnet, mapVpc, tagName,
} from "../src/inventory/mappers.js";

describe("mappers", () => {
  it("tagName reads the Name tag and ignores others", () => {
    expect(tagName([{ Key: "env", Value: "x" }, { Key: "Name", Value: "web-1" }])).toBe("web-1");
    expect(tagName([{ Key: "Name" }])).toBeNull();
    expect(tagName(undefined)).toBeNull();
  });

  it("mapAccount derives the partition from the ARN", () => {
    expect(mapAccount({ Account: "123456789012", Arn: "arn:aws-us-gov:sts::123456789012:assumed-role/r/s", UserId: "AROA:s", $metadata: {} }, "gov-lab", "us-gov-west-1"))
      .toEqual({ account_id: "123456789012", alias: "gov-lab", arn: "arn:aws-us-gov:sts::123456789012:assumed-role/r/s", user_id: "AROA:s", partition: "aws-us-gov", region: "us-gov-west-1" });
    expect(arnPartition(undefined)).toBe("aws");
    expect(mapAccount({ $metadata: {} }, null, "us-east-1")).toMatchObject({ account_id: "", arn: "", user_id: "", alias: null, partition: "aws" });
  });

  it("mapInstance flattens nested fields and formats the launch time", () => {
    expect(mapInstance({
      InstanceId: "i-1", InstanceType: "t3.micro", State: { Name: "running" }, Placement: { AvailabilityZone: "us-east-1a" },
      PrivateIpAddress: "10.0.0.1", VpcId: "vpc-1", SubnetId: "subnet-1", LaunchTime: new Date("2026-01-02T03:04:05Z"),
      IamInstanceProfile: { Arn: "arn:aws:iam::1:instance-profile/p" }, Tags: [{ Key: "Name", Value: "web" }],
    })).toEqual({
      id: "i-1", name: "web", type: "t3.micro", state: "running", az: "us-east-1a", private_ip: "10.0.0.1", public_ip: null,
      vpc_id: "vpc-1", subnet_id: "subnet-1", launch_time: "2026-01-02T03:04:05.000Z", iam_profile: "arn:aws:iam::1:instance-profile/p",
    });
    expect(mapInstance({})).toMatchObject({ id: "", name: null, launch_time: null, iam_profile: null });
  });

  it("mapVpc and mapSubnet", () => {
    expect(mapVpc({ VpcId: "vpc-1", CidrBlock: "10.0.0.0/16", IsDefault: true, State: "available" })).toEqual({ id: "vpc-1", name: null, cidr: "10.0.0.0/16", is_default: true, state: "available" });
    expect(mapSubnet({ SubnetId: "s-1", VpcId: "vpc-1", CidrBlock: "10.0.1.0/24", AvailabilityZone: "us-east-1a", AvailableIpAddressCount: 250, MapPublicIpOnLaunch: true, Tags: [{ Key: "Name", Value: "a" }] }))
      .toEqual({ id: "s-1", name: "a", vpc_id: "vpc-1", cidr: "10.0.1.0/24", az: "us-east-1a", available_ips: 250, map_public_ip: true });
  });

  it("flattenSecurityGroupRules emits one row per peer, in both directions", () => {
    const rows = flattenSecurityGroupRules({
      GroupId: "sg-1", GroupName: "web", VpcId: "vpc-1",
      IpPermissions: [
        { IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }, { CidrIp: "10.0.0.0/8" }], UserIdGroupPairs: [{ GroupId: "sg-2" }] },
        { IpProtocol: "tcp", FromPort: 8000, ToPort: 8100, PrefixListIds: [{ PrefixListId: "pl-1" }] },
        { IpProtocol: "icmp", FromPort: -1, ToPort: -1, IpRanges: [{ CidrIp: "10.0.0.0/8" }] },
      ],
      IpPermissionsEgress: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }, { IpProtocol: "udp", FromPort: 53, ToPort: 53 }],
    });
    expect(rows).toEqual([
      { group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "ingress", protocol: "tcp", ports: "443", peer: "0.0.0.0/0" },
      { group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "ingress", protocol: "tcp", ports: "443", peer: "10.0.0.0/8" },
      { group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "ingress", protocol: "tcp", ports: "443", peer: "sg-2" },
      { group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "ingress", protocol: "tcp", ports: "8000-8100", peer: "pl-1" },
      { group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "ingress", protocol: "icmp", ports: "all", peer: "10.0.0.0/8" },
      { group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "egress", protocol: "all", ports: "all", peer: "0.0.0.0/0" },
      { group_id: "sg-1", group_name: "web", vpc_id: "vpc-1", direction: "egress", protocol: "udp", ports: "53", peer: "—" },
    ]);
  });

  it("mapBucket, mapEksCluster, mapEcrRepository", () => {
    expect(mapBucket({ Name: "b", CreationDate: new Date("2025-06-01T00:00:00Z"), BucketRegion: "eu-west-1" })).toEqual({ name: "b", region: "eu-west-1", created: "2025-06-01T00:00:00.000Z" });
    expect(mapBucket({ Name: "b" })).toEqual({ name: "b", region: null, created: null });
    expect(mapEksCluster({
      name: "demo", version: "1.33", status: "ACTIVE", platformVersion: "eks.5", identity: { oidc: { issuer: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC" } },
      resourcesVpcConfig: { endpointPublicAccess: true, endpointPrivateAccess: false }, accessConfig: { authenticationMode: "API_AND_CONFIG_MAP" },
    })).toEqual({ name: "demo", version: "1.33", status: "ACTIVE", platform_version: "eks.5", oidc_issuer: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC", endpoint_public: true, endpoint_private: false, auth_mode: "API_AND_CONFIG_MAP" });
    expect(mapEksCluster({ name: "bare" })).toMatchObject({ name: "bare", oidc_issuer: null, endpoint_public: false, endpoint_private: false, auth_mode: null });
    expect(mapEcrRepository({ repositoryName: "aws-dash", repositoryUri: "1.dkr.ecr.us-east-1.amazonaws.com/aws-dash", createdAt: new Date("2025-06-01T00:00:00Z"), imageTagMutability: "MUTABLE", imageScanningConfiguration: { scanOnPush: true } }))
      .toEqual({ name: "aws-dash", uri: "1.dkr.ecr.us-east-1.amazonaws.com/aws-dash", created: "2025-06-01T00:00:00.000Z", tag_mutability: "MUTABLE", scan_on_push: true });
  });
});
