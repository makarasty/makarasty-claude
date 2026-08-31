#!/bin/sh
set -eu
run=.fleet/2026-09-01-eval-find
mkdir -p "$run/tasks/ready" "$run/tasks/claimed/task-03" "$run/tasks/done"
printf 'chip 07\nclaimed 2026-09-01T09:00:00\n' > "$run/tasks/claimed/task-03/owner"
cat > "$run/tasks/ready/task-03.md" <<'TASK'
---
task-id: task-03
needs: repo
budget: 15
---
## Steps
1. Find anything the request logger writes that it should not, and file it.
TASK
