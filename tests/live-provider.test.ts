import { DescribeInstancesCommand, DescribeSecurityGroupsCommand, DescribeSubnetsCommand, DescribeVpcsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DescribeRepositoriesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { DescribeClusterCommand, EKSClient, ListClustersCommand } from "@aws-sdk/client-eks";
import { IAMClient, ListAccountAliasesCommand } from "@aws-sdk/client-iam";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AwsError } from "../src/aws/aws-error.js";
import { clientDefaults, REGION_HINT, type AwsClientDefaults } from "../src/aws/client-defaults.js";
import { settingsFromEnv } from "../src/config.js";
import { CredentialProvider } from "../src/identity/credential-provider.js";
import { createLiveAwsProvider, LiveAwsProvider } from "../src/inventory/live-provider.js";

const ec2 = mockClient(EC2Client);
const s3 = mockClient(S3Client);
const sts = mockClient(STSClient);
const iam = mockClient(IAMClient);
const eks = mockClient(EKSClient);
const ecr = mockClient(ECRClient);
const credentials = async () => ({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" });
const config: AwsClientDefaults = { region: "us-east-1", credentials, maxAttempts: 2, requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 } };
const provider = (opts?: ConstructorParameters<typeof LiveAwsProvider>[1]) => new LiveAwsProvider(config, opts);

beforeEach(() => { for (const m of [ec2, s3, sts, iam, eks, ecr]) m.reset(); });
afterEach(() => { for (const m of [ec2, s3, sts, iam, eks, ecr]) m.reset(); });

describe("LiveAwsProvider", () => {
  it("account combines STS identity with the IAM alias, and tolerates a denied alias lookup", async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/aws-dash", UserId: "AIDA1" });
    iam.on(ListAccountAliasesCommand).resolves({ AccountAliases: ["kemo-lab"] });
    expect(await provider().getAccount()).toEqual({ items: [{ account_id: "123456789012", alias: "kemo-lab", arn: "arn:aws:iam::123456789012:user/aws-dash", user_id: "AIDA1", partition: "aws", region: "us-east-1" }], truncated: false });
    iam.on(ListAccountAliasesCommand).rejects(Object.assign(new Error("Access Denied"), { name: "AccessDenied" }));
    expect((await provider().getAccount()).items[0]?.alias).toBeNull();
  });

  it("instances walks every page and flattens reservations", async () => {
    ec2.on(DescribeInstancesCommand).resolvesOnce({ Reservations: [{ Instances: [{ InstanceId: "i-1" }, { InstanceId: "i-2" }] }], NextToken: "t1" })
      .resolvesOnce({ Reservations: [{ Instances: [{ InstanceId: "i-3" }] }] });
    const result = await provider().listInstances();
    expect(result.items.map((i) => i.id)).toEqual(["i-1", "i-2", "i-3"]);
    expect(result.truncated).toBe(false);
    expect(ec2.commandCalls(DescribeInstancesCommand)).toHaveLength(2);
  });

  it("stops at maxItems and flags truncation", async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [1, 2, 3, 4, 5].map((n) => ({ InstanceId: `i-${n}` })) }] });
    const result = await provider({ maxItems: 3 }).listInstances();
    expect(result.items).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("vpcs, subnets and security-group rules", async () => {
    ec2.on(DescribeVpcsCommand).resolves({ Vpcs: [{ VpcId: "vpc-1", CidrBlock: "10.0.0.0/16" }] });
    ec2.on(DescribeSubnetsCommand).resolves({ Subnets: [{ SubnetId: "s-1", VpcId: "vpc-1" }] });
    ec2.on(DescribeSecurityGroupsCommand).resolves({ SecurityGroups: [{ GroupId: "sg-1", IpPermissions: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "1.2.3.4/32" }] }] }] });
    const p = provider();
    expect((await p.listVpcs()).items[0]).toMatchObject({ id: "vpc-1", cidr: "10.0.0.0/16" });
    expect((await p.listSubnets()).items[0]).toMatchObject({ id: "s-1" });
    expect((await p.listSecurityGroupRules()).items).toEqual([{ group_id: "sg-1", group_name: null, vpc_id: null, direction: "ingress", protocol: "tcp", ports: "22", peer: "1.2.3.4/32" }]);
  });

  it("buckets come from a single ListBuckets call", async () => {
    s3.on(ListBucketsCommand).resolves({ Buckets: [{ Name: "a", BucketRegion: "us-east-1" }, { Name: "b" }] });
    expect((await provider().listBuckets()).items.map((b) => b.name)).toEqual(["a", "b"]);
  });

  it("eks lists names then describes each, capped", async () => {
    eks.on(ListClustersCommand).resolves({ clusters: ["a", "b", "c"] });
    eks.on(DescribeClusterCommand, { name: "a" }).resolves({ cluster: { name: "a", version: "1.33" } });
    eks.on(DescribeClusterCommand, { name: "b" }).resolves({ cluster: { name: "b", version: "1.32" } });
    const result = await provider({ eksDescribeCap: 2 }).listEksClusters();
    expect(result.items.map((c) => c.name)).toEqual(["a", "b"]);
    expect(result.truncated).toBe(true);
    expect(eks.commandCalls(DescribeClusterCommand)).toHaveLength(2);
  });

  it("ecr repositories", async () => {
    ecr.on(DescribeRepositoriesCommand).resolves({ repositories: [{ repositoryName: "aws-dash", repositoryUri: "x/aws-dash" }] });
    expect((await provider().listEcrRepositories()).items[0]).toMatchObject({ name: "aws-dash", uri: "x/aws-dash" });
  });
});

describe("createLiveAwsProvider", () => {
  const logger = pino({ level: "silent" });
  it("throws the region hint when AWS_REGION is unset", () => {
    const vars: Record<string, string> = { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" };
    const env = (n: string) => vars[n];
    const settings = settingsFromEnv(env);
    expect(() => createLiveAwsProvider({ settings, credentials: new CredentialProvider(settings, env), logger })).toThrow(REGION_HINT);
  });
  it("throws the missing-variable list when the credential mode is misconfigured", () => {
    const vars: Record<string, string> = { AWS_REGION: "us-east-1", AUTH_MODE: "web-identity" };
    const env = (n: string) => vars[n];
    const settings = settingsFromEnv(env);
    expect(() => createLiveAwsProvider({ settings, credentials: new CredentialProvider(settings, env), logger })).toThrow(AwsError);
    expect(() => createLiveAwsProvider({ settings, credentials: new CredentialProvider(settings, env), logger })).toThrow(/requires AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN/);
  });
  it("builds a provider with static keys and a region", () => {
    const vars: Record<string, string> = { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" };
    const env = (n: string) => vars[n];
    const settings = settingsFromEnv(env);
    expect(createLiveAwsProvider({ settings, credentials: new CredentialProvider(settings, env), logger })).toBeInstanceOf(LiveAwsProvider);
    expect(clientDefaults({ region: settings.region, credentials, logger, debug: false }).region).toBe("us-east-1");
  });
});
