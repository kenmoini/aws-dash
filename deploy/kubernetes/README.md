# aws-dash on any Kubernetes with static IAM access keys

The baseline the workload-identity overlays exist to eliminate: a long-lived IAM user key in a Secret.
`AUTH_MODE=auto` picks `static` because `AWS_ACCESS_KEY_ID` is present (the SDK chain checks env first).

The AWS tab only reads. Create the least-privilege policy once and attach it to the user:

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws iam create-policy --policy-name aws-dash-readonly --policy-document file://deploy/aws/aws-dash-readonly-policy.json
aws iam attach-user-policy --user-name aws-dash --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/aws-dash-readonly"
```

```bash
aws iam create-user --user-name aws-dash
aws iam create-access-key --user-name aws-dash --query 'AccessKey.{AWS_ACCESS_KEY_ID:AccessKeyId,AWS_SECRET_ACCESS_KEY:SecretAccessKey}' -o json
cp deploy/kubernetes/secret.example.yaml deploy/kubernetes/secret.yaml   # paste the two values; secret.yaml is gitignored
kubectl apply -k deploy/kubernetes
kubectl apply -f deploy/kubernetes/secret.yaml
kubectl -n aws-dash rollout restart deploy/aws-dash          # env vars are read at start
kubectl -n aws-dash port-forward svc/aws-dash 8080:8080
```

Off AWS (kind, minikube, on-prem) set `AWS_EC2_METADATA_DISABLED=true` in the ConfigMap so the SDK never waits on
the instance metadata service; the `openshift` overlay does this for you.

Demo: `aws iam detach-user-policy --user-name aws-dash --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/aws-dash-readonly"`, then click
"Refresh all" — every panel shows an `AccessDenied` hint but keeps its last data; re-attach and refresh to recover.

Delete the key when you are done: `aws iam delete-access-key --user-name aws-dash --access-key-id <id>`.
