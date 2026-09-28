/** The read-only actions the Identity tab probes, in display order. Kept SDK-free so config.ts can import it. */
export const ACCESS_CHECK_ACTION_NAMES = [
  "sts:GetCallerIdentity",
  "iam:ListAccountAliases",
  "ec2:DescribeRegions",
  "ec2:DescribeInstances",
  "ec2:DescribeVpcs",
  "ec2:DescribeSubnets",
  "ec2:DescribeSecurityGroups",
  "s3:ListAllMyBuckets",
  "eks:ListClusters",
  "ecr:DescribeRepositories",
  "iam:GetRole",
] as const;

export type AccessCheckAction = (typeof ACCESS_CHECK_ACTION_NAMES)[number];

export function isAccessCheckAction(value: string): value is AccessCheckAction {
  return (ACCESS_CHECK_ACTION_NAMES as readonly string[]).includes(value);
}
