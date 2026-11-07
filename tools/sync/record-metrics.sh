#!/usr/bin/env bash
set -euo pipefail
mkdir -p .cache
for attempt in 1 2 3; do
  parent=''
  if git ls-remote --exit-code origin refs/heads/metrics > .cache/metrics-ref; then
    git fetch origin refs/heads/metrics:refs/remotes/origin/metrics
    parent=$(git rev-parse refs/remotes/origin/metrics)
    git show "$parent:autonomy.jsonl" > .cache/autonomy.jsonl
  else
    status=$?
    if [ "$status" -ne 2 ]; then exit "$status"; fi
    : > .cache/autonomy.jsonl
  fi
  jq -s 'last // {}' .cache/autonomy.jsonl > .cache/previous-metrics.json
  for report in sync-report earn-check; do
    if [ ! -f ".cache/$report.json" ]; then echo null > ".cache/$report.json"; fi
  done
  bun run cli review tasks --date "$(date -u +%F)" --run "$RUN_URL" --outcomes "$OUTCOMES" --out .cache/review-tasks.json
  jq -c .metrics .cache/review-tasks.json > .cache/autonomy.json
  cat .cache/autonomy.json >> .cache/autonomy.jsonl
  blob=$(git hash-object -w .cache/autonomy.jsonl)
  index=$(mktemp)
  rm "$index"
  GIT_INDEX_FILE="$index" git read-tree --empty
  GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "100644,$blob,autonomy.jsonl"
  tree=$(GIT_INDEX_FILE="$index" git write-tree)
  rm "$index"
  parents=()
  if [ -n "$parent" ]; then parents=(-p "$parent"); fi
  commit=$(GIT_AUTHOR_NAME='github-actions[bot]' GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com' \
    GIT_COMMITTER_NAME='github-actions[bot]' GIT_COMMITTER_EMAIL='41898282+github-actions[bot]@users.noreply.github.com' \
    git commit-tree "$tree" "${parents[@]}" -m "Daily autonomy metrics: $GITHUB_RUN_ID")
  if git push origin "$commit:refs/heads/metrics"; then
    { printf '### Daily autonomy metrics\n\n```json\n'; jq . .cache/autonomy.json; printf '```\n'; } >> "$GITHUB_STEP_SUMMARY"
    exit 0
  fi
done
exit 1
