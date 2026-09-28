# aws-dash on OpenShift with Zero Trust Workload Identity Manager (SPIFFE/SPIRE) → AWS

SPIRE issues this pod a **JWT-SVID** whose `sub` is its SPIFFE ID. IAM trusts SPIRE's OIDC discovery endpoint as an
OIDC identity provider, and STS exchanges the JWT-SVID for role credentials with `AssumeRoleWithWebIdentity`.

- A spiffe-helper **native sidecar** (`initContainers` with `restartPolicy: Always`, Red Hat image) fetches the JWT-SVID
  over the SPIRE agent socket, mounted with the `csi.spiffe.io` CSI driver, and writes it to `/var/run/secrets/aws/token`
  as a raw compact JWT. It keeps the file fresh; ZTWIM's default JWT-SVID lifetime is about 5 minutes.
- The AWS SDK's `fromTokenFile` **re-reads that file on every credential resolve**, so rotation needs no app code.
- The app also mounts the socket itself, read-only, for the **SPIFFE** card: it reads the X.509-SVID and a JWT-SVID
  for display and never shows raw material. `AUTH_MODE=web-identity` keeps the credential path on the file.

## 0. ZTWIM prerequisites AWS enforces

The operator must be installed with its `cluster` CRs (`ZeroTrustWorkloadIdentityManager`, `SpireServer`, `SpireAgent`,
`SpiffeCSIDriver`, `SpireOIDCDiscoveryProvider`) healthy. AWS needs three things:

1. **RSA signing.** Use `jwtKeyType: rsa-2048` on the `SpireServer` (`operator.openshift.io/v1alpha1`) — the same
   server can serve azure-dash, which needs RSA too. (Whether IAM also accepts SPIRE's default EC keys is spec §15
   risk 1 — record what you observe.)
2. **Public discovery endpoint with a publicly trusted certificate.** `SpireOIDCDiscoveryProvider.spec.jwtIssuer` must
   equal `SpireServer.spec.jwtIssuer`; `managedRoute: "true"` creates the Route; point `externalSecretRef` at a
   cert-manager/ACME certificate. STS fetches `/.well-known/openid-configuration` and the JWKS from the public internet.
3. **A SPIFFE ID of the form** `spiffe://<trust-domain>/ns/aws-dash-ztwim/sa/aws-dash`. This overlay ships an explicit
   `ClusterSPIFFEID` for the namespace (`spire.spiffe.io/v1alpha1`); the operator's own one is a fallback.

```bash
export JWT_ISSUER=$(oc get spireoidcdiscoveryprovider cluster -o jsonpath='{.spec.jwtIssuer}')
export TRUST_DOMAIN=$(oc get spireserver cluster -o jsonpath='{.spec.trustDomain}')
export OIDC_ISSUER_HOST=${JWT_ISSUER#https://}
curl -fsS "$JWT_ISSUER/.well-known/openid-configuration" | jq '{issuer, jwks_uri}'
curl -fsS "$(curl -fsS "$JWT_ISSUER/.well-known/openid-configuration" | jq -r .jwks_uri)" | jq '.keys[0] | {kty, alg, use}'
openssl s_client -connect "$OIDC_ISSUER_HOST:443" -servername "$OIDC_ISSUER_HOST" </dev/null 2>/dev/null | grep -E "Verify return code|issuer="
```

`issuer` must equal `$JWT_ISSUER` byte for byte (scheme, host, no trailing slash), `kty` must be `RSA`, and the verify
return code must be `0 (ok)` — a private CA here is the most common reason for `InvalidIdentityToken`.

## 1. IAM OIDC provider, role, permissions

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
if [ -z "$(aws iam list-open-id-connect-providers --query "OpenIDConnectProviderList[?ends_with(Arn, '$OIDC_ISSUER_HOST')].Arn" --output text)" ]; then
  aws iam create-open-id-connect-provider --url "$JWT_ISSUER" --client-id-list aws-dash
fi
sed -e "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/g" -e "s#OIDC_ISSUER_HOST#$OIDC_ISSUER_HOST#g" -e "s#TRUST_DOMAIN#$TRUST_DOMAIN#g" deploy/aws/trust-ztwim.json > /tmp/aws-dash-trust.json
aws iam create-role --role-name aws-dash-ztwim --assume-role-policy-document file:///tmp/aws-dash-trust.json
aws iam create-policy --policy-name aws-dash-readonly --policy-document file://deploy/aws/aws-dash-readonly-policy.json 2>/dev/null || true
aws iam attach-role-policy --role-name aws-dash-ztwim --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/aws-dash-readonly"
```

The trust policy pins `aud = aws-dash` (the audience spiffe-helper requests) and `sub = spiffe://$TRUST_DOMAIN/ns/aws-dash-ztwim/sa/aws-dash`.

## 2. Deploy

```bash
sed -i.bak "s/AWS_ACCOUNT_ID/$AWS_ACCOUNT_ID/" deploy/ztwim/identity-configmap.yaml
oc apply -f deploy/ztwim/clusterspiffeid.yaml   # cluster-scoped, so applied on its own rather than through kustomize
oc apply -k deploy/ztwim
oc -n aws-dash-ztwim rollout status deploy/aws-dash
oc -n aws-dash-ztwim logs deploy/aws-dash -c spiffe-helper --tail=20
oc -n aws-dash-ztwim exec deploy/aws-dash -c aws-dash -- head -c 20 /var/run/secrets/aws/token; echo   # expect: eyJ...
oc -n aws-dash-ztwim get route aws-dash -o jsonpath='https://{.spec.host}{"\n"}'
```

The `ClusterSPIFFEID` and the `node-reader` ClusterRoleBinding need cluster-admin once.

## 3. What you should see

- **Identity** — mode `web-identity`, flavor **SPIFFE JWT-SVID (spiffe-helper)**, `iss = $JWT_ISSUER`,
  `sub = spiffe://$TRUST_DOMAIN/ns/aws-dash-ztwim/sa/aws-dash`, `aud = aws-dash`; STS returns
  `assumed-role/aws-dash-ztwim/aws-dash`; credentials `ASIA…`, source `h: web-identity token file`, `k: AssumeRoleWithWebIdentity`.
- **SPIFFE workload identity** — the X.509-SVID's SPIFFE ID with the badge *same as the token sub presented to STS*,
  its validity window, and the JWT-SVID claims for audience `aws-dash`. Reload a few minutes apart: `iat`/`exp` advance.
- **Kubernetes** — this pod with the `spiffe-helper` sidecar absent from the container table (it is an init container)
  and the node's instance type via the `node-reader` component.
- After the STS credential's expiry passes, **Refresh all** on the AWS tab still succeeds: the SDK re-read the rotated file.

## 4. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `InvalidIdentityToken: No OpenIDConnect provider found` | provider URL ≠ token `iss` | compare `aws iam get-open-id-connect-provider` URL with the Identity card's `iss` |
| `InvalidIdentityToken: Couldn't retrieve verification key` | Route certificate not publicly trusted, or JWKS unreachable | step 0.2; check `externalSecretRef` |
| `AccessDenied` on `AssumeRoleWithWebIdentity` | trust `sub`/`aud` mismatch | compare the decoded claims on the Identity card with `/tmp/aws-dash-trust.json` |
| token file missing / empty | sidecar not running or no registration entry | `oc logs -c spiffe-helper`; `oc get clusterspiffeid`; `oc -n zero-trust-workload-identity-manager logs deploy/spire-controller-manager` |
| SPIFFE card: *SPIRE agent not reachable* | CSI volume not mounted, agent DaemonSet unhealthy | `oc get csidriver csi.spiffe.io`; `oc -n zero-trust-workload-identity-manager get ds` |
| SPIFFE card: *no registration entry matches this pod* | ClusterSPIFFEID selectors do not match | labels `app: aws-dash`, namespace label `kubernetes.io/metadata.name` |
| `ExpiredToken` | clock skew or spiffe-helper stopped rotating | `oc logs -c spiffe-helper --since=10m` |

## 5. Alternative: one annotation instead of this overlay

`github.com/kenmoini/ztwim-oidc-shims` is a mutating webhook that injects the spiffe-helper sidecar, the CSI volume and the
whole `AWS_*`/`SPIFFE_*` env set from a single pod annotation. With it, `deploy/openshift` plus that annotation reaches
the same state as this overlay.

## 6. Record what you saw

Fill in `docs/verification/ztwim-phase4.md` (JWT key type accepted, file format, native-sidecar behaviour, socket path)
and copy corrections back here and into spec §15.
