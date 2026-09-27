# aws-dash on any Kubernetes with static IAM access keys

The baseline the workload-identity overlays exist to eliminate: a long-lived IAM user key in a Secret.
`AUTH_MODE=auto` picks `static` because `AWS_ACCESS_KEY_ID` is present (the SDK chain checks env first).

The app makes no AWS calls in Phase 1, so the user needs no permissions yet; the read-only policy used by the
AWS tab arrives with Phase 2 as `deploy/aws/aws-dash-readonly-policy.json`.

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

Delete the key when you are done: `aws iam delete-access-key --user-name aws-dash --access-key-id <id>`.
