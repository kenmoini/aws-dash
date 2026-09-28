# Deploying aws-dash

One image, several credential sources. Pick the overlay for your platform:

| Overlay | Platform | Credential source | Secret in cluster? | Trust principal | Condition keys |
|---|---|---|---|---|---|
| `kubernetes` | any Kubernetes | IAM user access key in a Secret (`AUTH_MODE=static`) | yes | — | — |
| `openshift` | OpenShift | same, plus a Route and IMDS disabled | yes | — | — |
| `eks-irsa` | EKS | IAM Roles for Service Accounts | no | `Federated` OIDC provider | `<issuer>:sub`, `<issuer>:aud` |
| `eks-pod-identity` | EKS | EKS Pod Identity | no | `Service pods.eks.amazonaws.com` | none — session tags instead |
| `openshift-native-oidc` | OpenShift / ROSA with a public SA issuer | projected SA token → `sts:AssumeRoleWithWebIdentity` | no | `Federated` issuer | `<issuer>:sub`, `<issuer>:aud` |
| `ztwim` | OpenShift + Zero Trust Workload Identity Manager | SPIRE JWT-SVID → `sts:AssumeRoleWithWebIdentity` (Phase 4) | no | — | — |

Render any overlay without a cluster: `kubectl kustomize deploy/<overlay>`; `scripts/kustomize-check.sh` renders all of them.
Trust-policy templates live in `deploy/aws/`.

## Shared AWS prerequisites

Every overlay grants the same read-only permissions, `deploy/aws/aws-dash-readonly-policy.json`, to whichever principal the
overlay authenticates as (an IAM user for `kubernetes`/`openshift`, an IAM role for the workload-identity overlays):

```bash
aws iam create-policy --policy-name aws-dash-readonly --policy-document file://deploy/aws/aws-dash-readonly-policy.json
```

`sts:GetCallerIdentity` needs no permission; everything else on the AWS tab fails closed with an actionable hint when the policy is missing.
`ec2:DescribeRegions` and `iam:GetRole` are unused until Phase 3's access-check matrix; they are granted now so the policy does not change later.
