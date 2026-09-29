#!/bin/sh
# One fix task with an executable reproduction, in a git tree so `prove` can digest it.
set -eu
run=.fleet/2026-09-29-eval-fix
mkdir -p "$run/tasks/ready" src
printf 'export const total = (xs) => xs.slice(1).reduce((a, b) => a + b, 0);\n' > src/total.mjs
printf "import { total } from './src/total.mjs';\nprocess.exit(total([2, 3]) === 5 ? 0 : 1);\n" > repro.mjs
git init -q . && git add -A && git -c user.email=eval@example.invalid -c user.name=eval commit -qm seed
cat > "$run/tasks/ready/task-01-total.md" <<'TASK'
---
task-id: task-01-total
kind: fix
needs: repo
budget: 15
---
## Steps
1. `total()` in `src/total.mjs` drops the first element. Reproduction: `node repro.mjs` (exits 1 today).
## Correct looks like
`node repro.mjs` exits 0.
TASK
