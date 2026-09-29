#!/bin/sh
# Nothing claimable, but the planner still holds queue-open: the worker must wait, not write .done.
set -eu
run=.fleet/2026-09-29-eval-open
mkdir -p "$run/tasks/ready" "$run/tasks/claimed/task-01" "$run/tasks/done"
printf 'more log tasks coming once the first sweep lands\n' > "$run/tasks/queue-open"
printf -- '---\ntask-id: task-01\nneeds: repo\nbudget: 15\n---\n## Steps\n1. Already done by chip 02.\n' > "$run/tasks/ready/task-01.md"
printf 'chip 02\nclaimed 2026-09-29T09:00:00\n' > "$run/tasks/claimed/task-01/owner"
: > "$run/tasks/done/task-01"
