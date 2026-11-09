#!/usr/bin/env bash
# Wait for the next comment job in one workspace, print it as JSON, and exit.
# A Claude Code session runs this in the background; the job arriving (script exiting) wakes it up.
#
#   poll.sh <workspace-id>        (the id printed by `docs serve <repo>`)
#
# Exit codes: 0 = printed a job, 1 = daemon unreachable (after 2 retries), 2 = usage.
# DOCS_URL overrides the daemon address (default http://127.0.0.1:3459).
set -u
WS="${1:-}"
[[ -n "$WS" ]] || { echo "Usage: poll.sh <workspace-id>" >&2; exit 2; }
URL="${DOCS_URL:-http://127.0.0.1:3459}"

fails=0
while true; do
  # The daemon holds each request up to 300s and answers as soon as a comment is waiting
  if ! r=$(curl -sf --max-time 320 "$URL/api/w/$WS/jobs/next?timeout=300"); then
    fails=$((fails + 1))
    if (( fails > 2 )); then  # first try + 2 retries
      echo "Docs daemon not reachable at $URL (or workspace $WS is not registered). Poller stopped."
      exit 1
    fi
    sleep 2
    continue
  fi
  fails=0
  if [[ "$r" != *'"job":null'* ]]; then
    echo "$r"
    exit 0
  fi
done
