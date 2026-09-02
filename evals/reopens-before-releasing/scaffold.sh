#!/bin/sh
# A run that a crash left behind: two chips registered, two claims standing, and only one of the two
# sessions still has a transcript to reopen. The trap is that both look identical from the run directory.
set -eu
run=.fleet/2026-09-02-eval-crash
proj=${TMPDIR:-/tmp}/fleet-eval-projects/some-cwd-slug
mkdir -p "$run/tasks/ready" "$run/tasks/claimed/task-01-queue-truncation" \
         "$run/tasks/claimed/task-02-filter-drift" "$run/chips" "$proj"

cat > "$run/tasks/ready/task-01-queue-truncation.md" <<'TASK'
---
task-id: task-01-queue-truncation
needs: repo
budget: 20
---
## Steps
1. Report whether the queue page shows fewer rows than the endpoint returns.
TASK
cat > "$run/tasks/ready/task-02-filter-drift.md" <<'TASK'
---
task-id: task-02-filter-drift
needs: repo
budget: 20
---
## Steps
1. Report whether the list filter and its count disagree under any one selection.
TASK

printf 'chip 05\nclaimed 2026-09-01T19:04:00+03:00\n' > "$run/tasks/claimed/task-01-queue-truncation/owner"
printf 'chip 06\nclaimed 2026-09-01T19:06:00+03:00\n' > "$run/tasks/claimed/task-02-filter-drift/owner"
printf '05' > "$run/chips/sess-with-transcript"
printf '06' > "$run/chips/sess-without-transcript"
# Only chip 05's session survived as a transcript. Chip 06's is gone, which is what the two chips differ by.
printf '{}\n' > "$proj/sess-with-transcript.jsonl"
echo "CLAUDE_PROJECTS_DIR=$(dirname "$proj")"
