# Deploying aws-dash

One image, several credential sources. Pick the overlay for your platform:

| Overlay | Platform | Credential source | Secret in cluster? | Trust principal | Condition keys |
|---|---|---|---|---|---|
| `kubernetes` | any Kubernetes | IAM user access key in a Secret (`AUTH_MODE=static`) | yes | — | — |
| `openshift` | OpenShift | same, plus a Route and IMDS disabled | yes | — | — |
| `eks-irsa` | EKS | IAM Roles for Service Accounts | no | `Federated` OIDC provider | `<issuer>:sub`, `<issuer>:aud` |
| `eks-pod-identity` | EKS | EKS Pod Identity | no | `Service pods.eks.amazonaws.com` | none — session tags instead |
| `openshift-native-oidc` | OpenShift / ROSA with a public SA issuer | projected SA token → `sts:AssumeRoleWithWebIdentity` | no | `Federated` issuer | `<issuer>:sub`, `<issuer>:aud` |
| `ztwim` | OpenShift + Zero Trust Workload Identity Manager | SPIRE JWT-SVID written by a spiffe-helper native sidecar → `sts:AssumeRoleWithWebIdentity` | no | `Federated` SPIRE OIDC discovery provider | `<issuer>:aud` = `aws-dash`, `<issuer>:sub` = `spiffe://<trust-domain>/ns/aws-dash-ztwim/sa/aws-dash` |

Render any overlay without a cluster: `kubectl kustomize deploy/<overlay>`; `scripts/kustomize-check.sh` renders all of them.
Trust-policy templates live in `deploy/aws/`.

Every overlay grants the pod `get pods` on itself (`deploy/kubernetes/rbac.yaml`). `deploy/components/node-reader` adds `get nodes` for the Kubernetes card's node section; `eks-irsa`, `eks-pod-identity` and `ztwim` include it, `kubernetes`, `openshift` and `openshift-native-oidc` do not (the card then shows the pod and a hint).

## Shared AWS prerequisites

Every overlay grants the same read-only permissions, `deploy/aws/aws-dash-readonly-policy.json`, to whichever principal the
overlay authenticates as (an IAM user for `kubernetes`/`openshift`, an IAM role for the workload-identity overlays):

```bash
aws iam create-policy --policy-name aws-dash-readonly --policy-document file://deploy/aws/aws-dash-readonly-policy.json
```

`sts:GetCallerIdentity` needs no permission; everything else on the AWS tab fails closed with an actionable hint when the policy is missing.
`ec2:DescribeRegions` and `iam:GetRole` back the Identity tab's access-check matrix.
