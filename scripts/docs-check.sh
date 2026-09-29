#!/usr/bin/env bash
# Fails when README.md drifts from the code: every route, config variable and metric must be documented, every
# documented endpoint must exist, and every deploy placeholder must be named in its README. Pure bash/grep/sed so
# it runs without Node (the docs-check workflow calls it on Markdown-only changes).
set -euo pipefail
cd "$(dirname "$0")/.."
README="${README_FILE:-README.md}"
status=0
ok()   { echo "ok   $1"; }
fail() { echo "FAIL $1"; status=1; }

# 1. Routes <-> the README "Endpoints" table, both directions. Path params are written {kind} in the README.
#    Matches any verb on any instance (`app.get("/x")`, the encapsulated `ctl.post("/controls/x")`, `app.put('/y')`).
q="[\"']"
routes=$(grep -hoE "\\.(get|post|put|delete|patch|all)\\($q/[^\"']*$q" src/routes/*.ts | sed -E "s/.*\\($q//; s/$q\$//; s/:kind/{kind}/" | sort -u)
documented=$(sed -n '/^## Endpoints/,/^## Configuration/p' "$README" | grep -oE '`/[^` ]*`' | grep -v '[*]' | tr -d '`' \
  | sed -E 's/\[\?[^]]*\]$//; s/\?[a-z_]+=[A-Za-z0-9]+$//' | sort -u)
for r in $routes; do
  if grep -qxF -- "$r" <<<"$documented"; then ok "route $r documented"; else fail "route $r is missing from the README Endpoints table"; fi
done
for d in $documented; do
  grep -qxF -- "$d" <<<"$routes" || fail "README documents $d but no route registers it"
done

# 2. Every variable config.ts reads is mentioned in the README (as a code span).
for v in $(grep -oE 'env\("[A-Z0-9_]+"\)' src/config.ts | grep -oE '[A-Z][A-Z0-9_]+' | sort -u); do
  if grep -qF -- "\`$v\`" "$README"; then ok "config $v documented"; else fail "config variable $v is not documented in the README"; fi
done

# 3. Every metric name is in the README.
for m in $(grep -oE '"aws_dash_[a-z_]+"' src/metrics/metrics.ts | tr -d '"' | sort -u); do
  if grep -qF -- "$m" "$README"; then ok "metric $m documented"; else fail "metric $m is not documented in the README"; fi
done

# 4. Deploy placeholders are named in their READMEs.
if scripts/check-placeholders.sh >/dev/null; then ok "deploy placeholders documented"; else fail "scripts/check-placeholders.sh failed (run it for details)"; fi

exit $status
