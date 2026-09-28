/** Panel order on the AWS tab. */
export const INVENTORY_KINDS = [
  { kind: "account", title: "Account" },
  { kind: "instances", title: "EC2 instances" },
  { kind: "vpcs", title: "VPCs" },
  { kind: "subnets", title: "Subnets" },
  { kind: "securitygroups", title: "Security group rules" },
  { kind: "s3buckets", title: "S3 buckets" },
  { kind: "eksclusters", title: "EKS clusters" },
  { kind: "ecrrepos", title: "ECR repositories" },
] as const;

export type InventoryKind = (typeof INVENTORY_KINDS)[number]["kind"];

export function isInventoryKind(value: string): value is InventoryKind {
  return INVENTORY_KINDS.some((k) => k.kind === value);
}

export function kindTitle(kind: InventoryKind): string {
  return INVENTORY_KINDS.find((k) => k.kind === kind)?.title ?? kind;
}
