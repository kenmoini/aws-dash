#!/usr/bin/env bash
# Renders every Kustomize overlay so CI catches a broken patch before anyone applies it.
set -euo pipefail
cd "$(dirname "$0")/.."
status=0
for dir in deploy/*/; do
  [[ -f "$dir/kustomization.yaml" ]] || continue
  if out=$(kubectl kustomize "$dir" 2>&1 >/dev/null); then
    echo "ok   $dir"
  else
    echo "FAIL $dir"; echo "$out"; status=1
  fi
done
exit $status
