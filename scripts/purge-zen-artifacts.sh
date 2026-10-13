#!/usr/bin/env bash
set -euo pipefail

repo="${1:?usage: purge-zen-artifacts.sh OWNER/REPO}"
: "${GH_TOKEN:?GH_TOKEN is required}"

removed=0
artifact_ids="$(gh api --paginate "repos/$repo/actions/artifacts" \
  --jq '.artifacts[] | select(.name | startswith("zen-pool-")) | .id')"
while IFS= read -r artifact_id; do
  [[ -n "$artifact_id" ]] || continue
  gh api --method DELETE "repos/$repo/actions/artifacts/$artifact_id" >/dev/null
  removed=$((removed + 1))
done <<< "$artifact_ids"

echo "$repo: removed $removed old zen-pool artifact(s)"
