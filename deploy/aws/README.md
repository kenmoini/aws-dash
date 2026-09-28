# IAM policy and trust-policy templates

- `aws-dash-readonly-policy.json` — the only permissions the app needs (attach to the user or role).
- `trust-eks-irsa.json` — role trust for EKS IRSA. Placeholders: `AWS_ACCOUNT_ID`, `OIDC_ISSUER_HOST` (the cluster issuer without `https://`).
- `trust-eks-pod-identity.json` — role trust for EKS Pod Identity (no placeholders; the association binds it to the service account).
- `trust-openshift-oidc.json` — role trust for an OpenShift cluster whose service-account issuer is public. Placeholders: `AWS_ACCOUNT_ID`, `OIDC_ISSUER_HOST`.
- `trust-ztwim.json` — role trust for OpenShift + Zero Trust Workload Identity Manager (SPIRE JWT-SVID). Placeholders: `AWS_ACCOUNT_ID`, `OIDC_ISSUER_HOST` (the SPIRE OIDC discovery host), `TRUST_DOMAIN` (the SPIRE trust domain, e.g. `apps.example.com`).

Each overlay README shows the exact `sed` that fills `AWS_ACCOUNT_ID`, `OIDC_ISSUER_HOST` and `TRUST_DOMAIN` before `aws iam create-role`.
