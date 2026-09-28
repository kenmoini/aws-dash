# Phase 4 live verification on OpenShift + ZTWIM (pending)

Not yet run: this machine has no cluster access. Run on a real cluster with the operator installed and fill in the
observations; several are spec §15 risks the docs currently state as expectations.

| Check | Command / where to look | Observed |
|---|---|---|
| IAM accepts the SPIRE issuer (RSA `jwtKeyType`; does EC work too?) | Identity card → STS section; `aws iam create-open-id-connect-provider` | |
| Exact `iss` equality (scheme, path, trailing slash) | Identity card `iss` vs `aws iam get-open-id-connect-provider` | |
| spiffe-helper file format is a raw compact JWT | `oc exec … -- head -c 20 /var/run/secrets/aws/token` | |
| `jwt_svid_file_mode` honoured under the arbitrary UID | `oc exec … -- ls -l /var/run/secrets/aws/token` | |
| Native sidecar with the Red Hat image (`restartPolicy: Always`) | `oc get pod -o jsonpath='{.items[0].spec.initContainers[0].restartPolicy}'`; pod restarts keep the sidecar | |
| SPIFFE card X.509 SPIFFE ID == token `sub` | SPIFFE card badge | |
| `iat`/`exp` advance between loads minutes apart | SPIFFE and Identity cards | |
| SDK re-reads the rotated file after the STS credential expires | AWS tab "Refresh all" after ~1 h | |
| Kubernetes card: node via `node-reader`; OOMKilled after the memory control | Identity → Kubernetes | |
| Socket path in the CSI volume is `spire-agent.sock` | `oc exec … -- ls /spiffe-workload-api` | |

Record the exact strings observed and copy corrections back into `deploy/ztwim/README.md` and spec §15.
