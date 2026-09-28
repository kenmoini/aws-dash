#!/usr/bin/env bash
# Every placeholder in a deploy manifest or policy template must be named in the README next to it, so no runbook
# can forget the sed that fills it in. Add new placeholder tokens to PLACEHOLDERS when you introduce them.
set -euo pipefail
cd "$(dirname "$0")/.."
PLACEHOLDERS='AWS_ACCOUNT_ID|OIDC_ISSUER_HOST|TRUST_DOMAIN|000000000000|REPLACE_ME'
status=0
while IFS= read -r file; do
  dir=$(dirname "$file")
  readme="$dir/README.md"
  for token in $(grep -oE "$PLACEHOLDERS" "$file" | sort -u); do
    if [[ -f "$readme" ]] && grep -q -- "$token" "$readme"; then
      echo "ok   $file: $token documented in $readme"
    else
      echo "FAIL $file: placeholder $token is not documented in $readme"
      status=1
    fi
  done
done < <(find deploy -type f \( -name '*.yaml' -o -name '*.json' \) | sort)
exit $status
