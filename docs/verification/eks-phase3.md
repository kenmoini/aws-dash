# Live verification on EKS (pending)

Not yet run: this machine has no usable AWS credentials or cluster access. Run on a real cluster and fill in the
observations; several are risks the docs currently state as expectations.

| Check | Overlay | Command / where to look | Observed |
|---|---|---|---|
| Identity flavor and decoded claims | eks-irsa | Identity tab → "Token presented to STS" | |
| STS session-name format | eks-pod-identity | Identity tab → "What AWS returned" → session | |
| `$source` ids | both | Identity tab → SDK source | |
| IMDS reachable from a pod? (hop limit / Auto Mode) | both | Identity tab → IMDS card | |
| Access-check all green, then detach policy → denied | both | Identity tab → Access check → re-run | |
| Projected token readable under arbitrary UID | openshift-native-oidc | pod logs / Identity token section | |
| `/metrics` credential/token expiry countdowns | any | `curl -s :8080/metrics \| grep aws_dash_credential` | |
| Static-key baseline (never run with a real key) | kubernetes | AWS tab panels + policy detach/re-attach | |

Record the exact strings observed and copy corrections back into the overlay READMEs and `deploy/README.md`.
