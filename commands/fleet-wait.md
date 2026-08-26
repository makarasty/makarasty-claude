---
description: Wait for a fleet run's workers to finish, spending no model turns on the waiting. Use when workers are running, when asked whether a run has finished, or before collecting a run.
argument-hint: <run-id> [expected worker count]
allowed-tools: Bash, Read, Glob, Monitor
---

Watch `.fleet/<run-id>/` for workers finishing. The waiting belongs in the shell, where it is free, rather
than in a re-read each turn, which costs a model turn per empty check and needs the operator to prod you
between them.

## Pick the shape

**One event per worker**, using `Monitor`, where each stdout line arrives as a notification:

```bash
run=RUNID; seen=""; while true; do for f in .fleet/$run/*.done .fleet/$run/*.blocked; do [ -e "$f" ] || continue; case "$seen" in *"$f"*) ;; *) echo "finished: $f"; seen="$seen $f";; esac; done; sleep 5; done
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

## Report

Which workers finished, which were blocked, and the raw finding count each produced. Then stop. Merging
and ranking is `/makarasty:fleet-collect`.
