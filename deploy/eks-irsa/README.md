# aws-dash on EKS with IAM Roles for Service Accounts (IRSA)

The pod's projected service-account token (issued by the cluster's OIDC provider, audience `sts.amazonaws.com`) is
exchanged with STS for the role `aws-dash-irsa` via `AssumeRoleWithWebIdentity`. The EKS pod-identity webhook injects
`AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE` into pods whose service account carries the
`eks.amazonaws.com/role-arn` annotation; the overlay sets `AUTH_MODE=web-identity` so a missing injection is an
error, not a silent fall-through to the node role. AWS now recommends Pod Identity for new clusters
(`deploy/eks-pod-identity`); IRSA is still what ROSA-style and older clusters use.

## 1. Variables and the cluster's OIDC provider

```bash
export CLUSTER=my-cluster AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export OIDC_ISSUER=$(aws eks describe-cluster --name "$CLUSTER" --query cluster.identity.oidc.issuer --output text)
export OIDC_ISSUER_HOST=${OIDC_ISSUER#https://}
# Register the issuer as an IAM OIDC provider once per cluster (skip if it already exists):
if [ -z "$(aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?ends_with(Arn, '$OIDC_ISSUER_HOST')].Arn" --output text)" ]; then
  aws iam create-open-id-connect-provider --url "$OIDC_ISSUER" --client-id-list sts.amazonaws.com
fi
# eksctl equivalent: eksctl utils associate-iam-oidc-provider --cluster "$CLUSTER" --approve
```

## 2. Role, trust policy and permissions

```bash
sed -e "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/g" -e "s#OIDC_ISSUER_HOST#$OIDC_ISSUER_HOST#g" deploy/aws/trust-eks-irsa.json > /tmp/aws-dash-trust.json
aws iam create-role --role-name aws-dash-irsa --assume-role-policy-document file:///tmp/aws-dash-trust.json
aws iam create-policy --policy-name aws-dash-readonly --policy-document file://deploy/aws/aws-dash-readonly-policy.json 2>/dev/null || true
aws iam attach-role-policy --role-name aws-dash-irsa --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/aws-dash-readonly"
```

## 3. Deploy

```bash
sed -i.bak "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/" deploy/eks-irsa/kustomization.yaml
sed -i.bak "s/AWS_REGION: us-east-1/AWS_REGION: $AWS_REGION/" deploy/kubernetes/configmap.yaml   # only if your region differs
kubectl apply -k deploy/eks-irsa
kubectl -n aws-dash rollout status deploy/aws-dash
kubectl -n aws-dash exec deploy/aws-dash -- printenv | grep -E '^AWS_(ROLE_ARN|WEB_IDENTITY_TOKEN_FILE|REGION)'
kubectl -n aws-dash port-forward svc/aws-dash 8080:8080
```

If the pods existed before the annotation (for example an earlier apply with the placeholder), the webhook never mutated
them: `kubectl -n aws-dash rollout restart deploy/aws-dash`.

Open **Identity**. You should see mode `web-identity`, flavor **EKS IRSA**, a token with
`sub = system:serviceaccount:aws-dash:aws-dash` and `aud = sts.amazonaws.com`, STS returning
`arn:aws:sts::…:assumed-role/aws-dash-irsa/<session>`, an `ASIA…` key, and SDK sources `h` and `k`.
**IMDS** shows the node (unless the node's hop limit is 1 or the cluster is EKS Auto Mode — then "unavailable" is
expected). The access-check matrix is all green; detach `aws-dash-readonly` and re-run to watch it flip.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Identity shows `AUTH_MODE web-identity requires AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN` | The webhook did not inject: check the annotation on the ServiceAccount and `rollout restart`. |
| `InvalidIdentityToken` | The IAM OIDC provider for `$OIDC_ISSUER` is missing, or `aud` is not `sts.amazonaws.com`. |
| `AccessDenied … sts:AssumeRoleWithWebIdentity` | The trust policy's `:sub`/`:aud` do not match the token; compare with the decoded claims on the Identity tab. |
| Panels show the read-only policy hint | The policy is not attached to `aws-dash-irsa`. |
