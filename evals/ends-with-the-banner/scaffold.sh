#!/bin/sh
# A drained queue with one finished task and two findings already filed, so the banner has counts to print.
set -eu
run=.fleet/2026-09-01-eval-end
mkdir -p "$run/tasks/ready" "$run/tasks/claimed/task-01" "$run/tasks/done"
printf 'chip 05\nclaimed 2026-09-01T09:00:00\n' > "$run/tasks/claimed/task-01/owner"
: > "$run/tasks/done/task-01"
cat > "$run/tasks/ready/task-01.md" <<'TASK'
---
task-id: task-01
needs: repo
budget: 15
---
## Steps
1. Nothing; this task is already finished.
TASK
cat > "$run/05.jsonl" <<'JSONL'
{"area":"logging","severity":"major","observed":"the request logger prints the bearer token","evidence":"server/log.ts:44 logs the whole header","mechanism_status":"established","chip":"05","when":"2026-09-01T09:10:00Z"}
{"area":"logging","severity":"minor","observed":"two log lines describe one request","evidence":"server/log.ts:51 and :58 both fire per request","mechanism_status":"hypothesis","chip":"05","when":"2026-09-01T09:12:00Z"}
JSONL
