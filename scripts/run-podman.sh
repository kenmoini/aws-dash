#!/usr/bin/env bash
# Run aws-dash locally in podman.
#   scripts/run-podman.sh [image]                       # no credentials: Runtime tab + controls only
#   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-east-1 scripts/run-podman.sh
#   AWS_PROFILE=demo scripts/run-podman.sh              # mounts ~/.aws read-only for profile mode
# The 512m memory limit is deliberate: the memory-load control can be pushed past it to show an OOM kill (exit 137).
set -euo pipefail
IMAGE="${1:-localhost/aws-dash:dev}"
args=()
for v in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION AWS_DEFAULT_REGION AWS_PROFILE \
         AUTH_MODE AWS_CACHE_TTL_SECONDS CONTROLS_ENABLED LOG_LEVEL AWS_DEBUG IMDS_ENABLED MEMORY_LOAD_MAX_MIB; do
  if [[ -n "${!v:-}" ]]; then args+=(-e "$v"); fi
done
if [[ -n "${AWS_PROFILE:-}" && -d "$HOME/.aws" ]]; then
  args+=(-v "$HOME/.aws:/opt/app-root/src/.aws:ro,Z" -e AWS_SHARED_CREDENTIALS_FILE=/opt/app-root/src/.aws/credentials -e AWS_CONFIG_FILE=/opt/app-root/src/.aws/config)
fi
# Off AWS there is no instance metadata service; skip the chain's IMDS timeout.
args+=(-e AWS_EC2_METADATA_DISABLED=true)
exec podman run --rm -it --name aws-dash --cpus 1 --memory 512m -p 8080:8080 ${args[@]+"${args[@]}"} "$IMAGE"
