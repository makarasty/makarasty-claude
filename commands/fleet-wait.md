---
description: Wait for a fleet run's workers to finish, spending no model turns on the waiting. Use when workers are running, when asked whether a run has finished, or before collecting a run.
argument-hint: <run-id> [expected worker count]
allowed-tools: Bash, Read, Write, Glob, Grep, Monitor, Agent
---

Watch `.fleet/<run-id>/` for workers finishing. The waiting belongs in the shell, where it is free, rather
than in a re-read each turn, which costs a model turn per empty check and needs the operator to prod you
between them.

## Pick the shape

**One event per worker**, using `Monitor`, where each stdout line arrives as a notification. It watches
`.waiting` alongside the finish markers, so a worker stopped on a question announces itself rather than
merely looking slow:

```bash
run=RUNID; n=N; seen=""; while true; do for f in .fleet/$run/*.done .fleet/$run/*.blocked .fleet/$run/*.waiting; do [ -e "$f" ] || continue; case "$seen" in *"$f"*) ;; *) case "$f" in *.waiting) echo "NEEDS YOU: $f -- $(cat "$f")";; *) echo "finished: $f";; esac; seen="$seen $f";; esac; done; c=$(ls .fleet/$run/*.done .fleet/$run/*.blocked 2>/dev/null | wc -l); [ "$c" -ge "$n" ] && { echo "run complete: $c of $n"; break; }; sleep 5; done
```

**One event when the whole run lands**, using a backgrounded Bash command that exits by itself:

```bash
run=RUNID; n=N; until [ "$(ls .fleet/$run/*.done .fleet/$run/*.blocked 2>/dev/null | wc -l)" -ge "$n" ]; do sleep 5; done; echo "all $n workers finished"
```

Substitute the real run id and count.

A third shape exists for sessions you spawned yourself: `SendMessage` with `notify_when_idle: true`
delivers exactly one notice when that session next goes idle, costing it nothing and needing no message
body. The file watch stays the default, because a file has an address and a session handle does not.

## While waiting

Read the briefs whose workers have already landed and start ranking their findings. The wait is free only
if you spend it on something.

## Read `.blocked` as an absence, not a pass

It means that worker's pane never composited, so it wrote no findings. Say so in the summary, by name. A
run reporting clean while a third of it saw nothing is worse than no run, and the marker is the only place
that shows.

## Done when

Every expected worker has a `.done` or a `.blocked`, or you have said which ones are still outstanding and
for how long.

**When the whole run has landed, invoke `/makarasty:fleet-collect <run-id>` yourself.** Do not print it as
a command for someone else to run. A finished run that nobody merges is a directory of JSONL files, and
the operator who clicked the chips has already moved on: measured 2026-08-26, seven finished workers and
74 findings sat unread because the next step was printed rather than taken.

If the operator asked to review the raw findings before merging, say so and stop instead.

## Report

Which workers finished, which were blocked, which are waiting on the operator and for what, and the raw
finding count each produced. Then collect.
