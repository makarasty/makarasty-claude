#!/bin/sh
# Builds the run directory the prompt talks about: one pane task and one repo task, in that order, so a
# worker that ignores its lane takes the wrong one first.
set -eu
run=.fleet/2026-09-01-eval
mkdir -p "$run/tasks/ready"
cat > "$run/tasks/ready/task-01-checkout-walk.md" <<'TASK'
---
task-id: task-01-checkout-walk
needs: pane
budget: 20
---
## Steps
1. Walk the checkout screen and report whether the total matches the line items.
TASK
cat > "$run/tasks/ready/task-02-log-scan.md" <<'TASK'
---
task-id: task-02-log-scan
needs: repo
budget: 15
---
## Steps
1. Search the repository for a log line that prints a value it should not, and report the file and line.
TASK
