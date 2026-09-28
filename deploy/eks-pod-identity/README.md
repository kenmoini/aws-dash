# aws-dash on EKS with EKS Pod Identity

EKS Pod Identity (AWS's current recommendation) binds an IAM role to a Kubernetes service account through a
`PodIdentityAssociation`. The `eks-pod-identity-agent` DaemonSet injects `AWS_CONTAINER_CREDENTIALS_FULL_URI`
(`http://169.254.170.23/v1/credentials`) and `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` into the pod; the SDK's
container-credentials provider exchanges the projected token (audience `pods.eks.amazonaws.com`) with the agent. No
OIDC provider and no ServiceAccount annotation are needed. EKS Auto Mode has the agent built in.

## 1. Add-on, role, permissions

```bash
export CLUSTER=my-cluster AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws eks create-addon --cluster-name "$CLUSTER" --addon-name eks-pod-identity-agent   # skip on EKS Auto Mode
aws iam create-role --role-name aws-dash-pod-identity --assume-role-policy-document file://deploy/aws/trust-eks-pod-identity.json
aws iam create-policy --policy-name aws-dash-readonly --policy-document file://deploy/aws/aws-dash-readonly-policy.json 2>/dev/null || true
aws iam attach-role-policy --role-name aws-dash-pod-identity --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/aws-dash-readonly"
```

## 2. Association and deploy

```bash
aws eks create-pod-identity-association --cluster-name "$CLUSTER" --namespace aws-dash --service-account aws-dash \
  --role-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:role/aws-dash-pod-identity"
sed -i.bak "s/AWS_REGION: us-east-1/AWS_REGION: $AWS_REGION/" deploy/kubernetes/configmap.yaml   # only if your region differs
kubectl apply -k deploy/eks-pod-identity
kubectl -n aws-dash rollout restart deploy/aws-dash    # pods created before the association are not mutated
kubectl -n aws-dash rollout status deploy/aws-dash
kubectl -n aws-dash exec deploy/aws-dash -- printenv | grep ^AWS_CONTAINER_
kubectl -n aws-dash port-forward svc/aws-dash 8080:8080
```

Open **Identity**: mode `pod-identity`, flavor **EKS Pod Identity**, the decoded token's `aud` is
`pods.eks.amazonaws.com`, STS shows `assumed-role/aws-dash-pod-identity/<session>` (record the session-name format
you observe — it is documented nowhere reliable), SDK source `z`. Pod Identity adds session tags
(`kubernetes-namespace`, `kubernetes-service-account`, `eks-cluster-name`) you can use in IAM conditions.

The **Kubernetes** card shows this pod and, because this overlay includes the `node-reader` component, the node's instance type and zone.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `AUTH_MODE pod-identity requires AWS_CONTAINER_CREDENTIALS_FULL_URI …` | The agent did not inject: is the add-on running (`kubectl -n kube-system get ds eks-pod-identity-agent`) and does the association exist (`aws eks list-pod-identity-associations --cluster-name $CLUSTER`)? Then `rollout restart`. |
| `CredentialsProviderError` mentioning 169.254.170.23 | The agent pod on that node is unhealthy, or a NetworkPolicy blocks link-local traffic. |
| Panels show the read-only policy hint | Attach `aws-dash-readonly` to `aws-dash-pod-identity`. |
