#!/bin/sh
# No FLEET.md at all. The task needs nothing from it; the worker must not start fleet-init's interview.
set -eu
run=.fleet/2026-09-29-eval-noinit
mkdir -p "$run/tasks/ready" server
printf 'log.info("auth", req.headers.authorization);\n' > server/log.mjs
printf -- '---\ntask-id: task-01-log\nneeds: repo\nbudget: 15\n---\n## Steps\n1. Find where a secret reaches a log line and file it with file:line.\n' > "$run/tasks/ready/task-01-log.md"
