# aws-dash on OpenShift using the cluster's own service-account issuer

Same mechanism as EKS IRSA, with OpenShift's service-account issuer as the OIDC provider: the overlay projects a token
with audience `sts.amazonaws.com` and sets `AWS_ROLE_ARN`/`AWS_WEB_IDENTITY_TOKEN_FILE` by hand, so no webhook is
involved. **Requirement:** STS must be able to fetch the issuer's discovery document and JWKS over public HTTPS.

## 1. Find the issuer and check it is public

```bash
export ISSUER=$(oc get authentication cluster -o jsonpath='{.spec.serviceAccountIssuer}')
echo "${ISSUER:-<empty: default https://kubernetes.default.svc, not public>}"
curl -fsS "$ISSUER/.well-known/openid-configuration" | jq '{issuer, jwks_uri}'
export OIDC_ISSUER_HOST=${ISSUER#https://}
```

- **ROSA / OpenShift installed in STS (manual) mode:** the issuer is public and an IAM OIDC provider for it already exists
  (`aws iam list-open-id-connect-providers`) — reuse it.
- **Default OCP install:** `serviceAccountIssuer` is empty → `https://kubernetes.default.svc`, which STS cannot reach.
  Use the ZTWIM overlay (`deploy/ztwim`, Phase 4) instead.

## 2. OIDC provider (if missing), role, permissions

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?ends_with(Arn, '$OIDC_ISSUER_HOST')]" --output text \
  || aws iam create-open-id-connect-provider --url "$ISSUER" --client-id-list sts.amazonaws.com
sed -e "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/g" -e "s#OIDC_ISSUER_HOST#$OIDC_ISSUER_HOST#g" deploy/aws/trust-openshift-oidc.json > /tmp/aws-dash-trust.json
aws iam create-role --role-name aws-dash-openshift --assume-role-policy-document file:///tmp/aws-dash-trust.json
aws iam create-policy --policy-name aws-dash-readonly --policy-document file://deploy/aws/aws-dash-readonly-policy.json 2>/dev/null || true
aws iam attach-role-policy --role-name aws-dash-openshift --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/aws-dash-readonly"
```

## 3. Deploy

```bash
sed -i.bak "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/" deploy/openshift-native-oidc/identity-configmap.yaml
oc apply -k deploy/openshift-native-oidc
oc -n aws-dash rollout status deploy/aws-dash
oc -n aws-dash get route aws-dash -o jsonpath='https://{.spec.host}{"\n"}'
```

Open **Identity**: mode `web-identity`, flavor **Kubernetes projected service-account token**, `iss = $ISSUER`,
`sub = system:serviceaccount:aws-dash:aws-dash`. If the projected token file is unreadable under OpenShift's arbitrary
UID, add `defaultMode: 0640` to the projected volume (record what you observed). `InvalidIdentityToken` means the IAM
OIDC provider URL and the token's `iss` differ (scheme, path or trailing slash).
