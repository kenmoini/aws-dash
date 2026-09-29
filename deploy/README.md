# Deploying aws-dash

One image, several credential sources. Pick the overlay for your platform:

| Overlay | Platform | Credential source | Secret in cluster? | Trust principal | Condition keys |
|---|---|---|---|---|---|
| `kubernetes` | any Kubernetes | IAM user access key in a Secret (`AUTH_MODE=auto` → `static`) | yes | — | — |
| `openshift` | OpenShift | same, plus a Route and IMDS disabled | yes | — | — |
| `eks-irsa` | EKS | IAM Roles for Service Accounts | no | `Federated` OIDC provider | `<issuer>:sub`, `<issuer>:aud` |
| `eks-pod-identity` | EKS | EKS Pod Identity | no | `Service pods.eks.amazonaws.com` | none — session tags instead |
| `openshift-native-oidc` | OpenShift / ROSA with a public SA issuer | projected SA token → `sts:AssumeRoleWithWebIdentity` | no | `Federated` issuer | `<issuer>:sub`, `<issuer>:aud` |
| `ztwim` | OpenShift + Zero Trust Workload Identity Manager | SPIRE JWT-SVID written by a spiffe-helper native sidecar → `sts:AssumeRoleWithWebIdentity` | no | `Federated` SPIRE OIDC discovery provider | `<issuer>:aud` = `aws-dash`, `<issuer>:sub` = `spiffe://<trust-domain>/ns/aws-dash-ztwim/sa/aws-dash` |

Runbooks: [`kubernetes`](kubernetes/README.md) · [`openshift`](openshift/README.md) · [`eks-irsa`](eks-irsa/README.md) ·
[`eks-pod-identity`](eks-pod-identity/README.md) · [`openshift-native-oidc`](openshift-native-oidc/README.md) ·
[`ztwim`](ztwim/README.md). IAM policy and trust-policy templates: [`aws/`](aws/README.md).

Render any overlay without a cluster: `kubectl kustomize deploy/<overlay>`; `scripts/kustomize-check.sh` renders all of them.

## What each overlay should show

The Identity tab is the proof. After `rollout status` succeeds, open it and compare:

| Overlay | Auth mode | Flavor | Token `sub` / `aud` | STS caller | Key prefix / source ids | Cards that say "Unavailable" |
|---|---|---|---|---|---|---|
| `kubernetes` | `static` | long-lived IAM user access key | — | `user/aws-dash` | `AKIA` / `g` | IMDS (off EC2), SPIFFE; Kubernetes shows the pod, node needs `node-reader` |
| `openshift` | `static` | long-lived IAM user access key | — | `user/aws-dash` | `AKIA` / `g` | IMDS, SPIFFE; Kubernetes shows the pod only |
| `eks-irsa` | `web-identity` | EKS IRSA | `system:serviceaccount:aws-dash:aws-dash` / `sts.amazonaws.com` | `assumed-role/aws-dash-irsa/aws-sdk-js-session-<epoch-ms>` (no session name set; SDK default) | `ASIA` / `h`, `k` | SPIFFE; IMDS depends on the node's hop limit |
| `eks-pod-identity` | `pod-identity` | EKS Pod Identity | (no token file) | `assumed-role/aws-dash-pod-identity/…` | `ASIA` / `z` | SPIFFE; IMDS depends on the node's hop limit |
| `openshift-native-oidc` | `web-identity` | Kubernetes projected service-account token | `system:serviceaccount:aws-dash:aws-dash` / `sts.amazonaws.com` | `assumed-role/aws-dash-openshift/aws-dash` | `ASIA` / `h`, `k` | SPIFFE; IMDS depends on whether the node is EC2 (ROSA) and its hop limit; Kubernetes shows the pod only |
| `ztwim` | `web-identity` | SPIFFE JWT-SVID (spiffe-helper) | `spiffe://<trust-domain>/ns/aws-dash-ztwim/sa/aws-dash` / `aws-dash` | `assumed-role/aws-dash-ztwim/aws-dash` | `ASIA` / `h`, `k` | none on AWS nodes (IMDS depends on the node and its hop limit; off AWS it is unavailable); SPIFFE and Kubernetes both populated |

The session-name part of the STS caller ARN and the exact `$source` ids are recorded from real clusters in
[`../docs/verification/eks-phase3.md`](../docs/verification/eks-phase3.md) and
[`../docs/verification/ztwim-phase4.md`](../docs/verification/ztwim-phase4.md); until those are filled in, treat the
table as the expectation. The demo script itself is in the [top-level README](../README.md#demo), and every hint the
cards can show is explained under [Troubleshooting](../README.md#troubleshooting).

## Placeholders

Manifests and trust policies contain exactly three placeholders — `AWS_ACCOUNT_ID`, `OIDC_ISSUER_HOST`, `TRUST_DOMAIN` —
and every runbook shows the `sed` that fills them. `scripts/check-placeholders.sh` (run by CI) fails when a placeholder
appears in a file whose directory README does not name it, so a runbook cannot forget one. `sed -i.bak` leaves
`*.bak` files that are gitignored.

## RBAC

Every overlay grants the pod's service account `get pods` in its namespace (`deploy/kubernetes/rbac.yaml`). `deploy/components/node-reader` adds `get nodes` for the Kubernetes card's node section; `eks-irsa`, `eks-pod-identity` and `ztwim` include it, `kubernetes`, `openshift` and `openshift-native-oidc` do not (the card then shows the pod and a hint).

## Shared AWS prerequisites

Every overlay grants the same read-only permissions, `deploy/aws/aws-dash-readonly-policy.json`, to whichever principal the
overlay authenticates as (an IAM user for `kubernetes`/`openshift`, an IAM role for the workload-identity overlays):

```bash
aws iam create-policy --policy-name aws-dash-readonly --policy-document file://deploy/aws/aws-dash-readonly-policy.json
```

`sts:GetCallerIdentity` needs no permission; everything else on the AWS tab fails closed with an actionable hint when the policy is missing.
`ec2:DescribeRegions` and `iam:GetRole` back the Identity tab's access-check matrix.

## Alternative for ZTWIM: one annotation

[`kenmoini/ztwim-oidc-shims`](https://github.com/kenmoini/ztwim-oidc-shims) is a mutating webhook that injects the spiffe-helper
sidecar, the CSI volume and the `AWS_*`/`SPIFFE_*` environment from a single pod annotation; with it, `deploy/openshift` plus
that annotation reaches the same state as `deploy/ztwim`.
