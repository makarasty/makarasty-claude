#!/bin/sh
# Worker 01 found one defect in its area; worker 02 never saw its screens, so its area is not clean.
set -eu
run=.fleet/2026-09-29-eval-collect
mkdir -p "$run"
printf -- '---\nowns: billing screens\n---\n' > "$run/brief-01.md"
printf -- '---\nowns: scheduling screens\n---\n' > "$run/brief-02.md"
printf '%s\n' '{"area":"billing","severity":"major","observed":"invoice total ignores the discount row","evidence":"src/billing/total.ts:31 sums rows before discounts","mechanism_status":"established","chip":"01","when":"2026-09-29T10:00:00Z"}' > "$run/01.jsonl"
: > "$run/01.done"
printf 'pane compositing 0 frames at 1280x800 after three asks\n' > "$run/02.blocked"
