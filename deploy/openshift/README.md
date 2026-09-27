# aws-dash on OpenShift with static IAM access keys

Same as `deploy/kubernetes` (see its README for creating the IAM user and key) plus an edge-terminated Route and
`AWS_EC2_METADATA_DISABLED=true`, because an on-prem OpenShift node has no EC2 instance metadata service.
The image runs under the `restricted-v2` SCC as-is: arbitrary UID, GID 0, no writes to disk.

```bash
cp deploy/kubernetes/secret.example.yaml deploy/openshift/secret.yaml   # paste the key; secret.yaml is gitignored
oc apply -k deploy/openshift
oc apply -f deploy/openshift/secret.yaml
oc -n aws-dash rollout restart deploy/aws-dash
oc -n aws-dash get route aws-dash -o jsonpath='https://{.spec.host}{"\n"}'
```

For SPIFFE/SPIRE via the Zero Trust Workload Identity Manager use the `ztwim` overlay (Phase 4).

The Route publishes the unauthenticated controls (crash, CPU/memory load, liveness/readiness toggles) to anyone who can reach
the router; set `CONTROLS_ENABLED: "false"` in the ConfigMap (or delete the Route) when the demo is not running.
