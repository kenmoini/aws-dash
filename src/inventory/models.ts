/** Rows shown on the AWS tab. Keys are snake_case because they are served as JSON verbatim. */
export interface AccountInfo {
  account_id: string;
  alias: string | null;
  arn: string;
  user_id: string;
  partition: string;
  region: string;
}

export interface InstanceInfo {
  id: string;
  name: string | null;
  type: string | null;
  state: string | null;
  az: string | null;
  private_ip: string | null;
  public_ip: string | null;
  vpc_id: string | null;
  subnet_id: string | null;
  launch_time: string | null;
  iam_profile: string | null;
}

export interface VpcInfo {
  id: string;
  name: string | null;
  cidr: string | null;
  is_default: boolean;
  state: string | null;
}

export interface SubnetInfo {
  id: string;
  name: string | null;
  vpc_id: string | null;
  cidr: string | null;
  az: string | null;
  available_ips: number | null;
  map_public_ip: boolean;
}

/** One security-group rule, flattened (the azure-dash NSG-rules analogue). */
export interface SecurityGroupRuleInfo {
  group_id: string;
  group_name: string | null;
  vpc_id: string | null;
  direction: "ingress" | "egress";
  protocol: string;
  ports: string;
  peer: string;
}

export interface BucketInfo {
  name: string;
  region: string | null;
  created: string | null;
}

export interface EksClusterInfo {
  name: string;
  version: string | null;
  status: string | null;
  platform_version: string | null;
  oidc_issuer: string | null;
  endpoint_public: boolean;
  endpoint_private: boolean;
  auth_mode: string | null;
}

export interface EcrRepositoryInfo {
  name: string;
  uri: string | null;
  created: string | null;
  tag_mutability: string | null;
  scan_on_push: boolean;
}

export type InventoryItem =
  | AccountInfo | InstanceInfo | VpcInfo | SubnetInfo | SecurityGroupRuleInfo | BucketInfo | EksClusterInfo | EcrRepositoryInfo;

export interface ListResult<T> {
  items: T[];
  /** True when the listing stopped at MAX_ITEMS. */
  truncated: boolean;
}

export const MAX_ITEMS = 500;
