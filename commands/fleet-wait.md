---
description: Wait for a run's testers to finish without spending model turns on polling
argument-hint: <run-id> [expected chip count]
allowed-tools: Bash, Read, Glob, Monitor
---

Watch `.fleet/<run-id>/` for testers finishing. Do not re-read the directory each turn — that spends model
tokens on empty checks and needs the operator to prod you between them.

Use one of these. Both cost nothing while nothing happens, because the waiting runs in the shell.

**One event per tester** — `Monitor`, where each stdout line becomes a notification:

```bash
run=RUNID; seen=""; while true; do for f in .fleet/$run/*.done .fleet/$run/*.blocked; do [ -e "$f" ] || continue; case "$seen" in *"$f"*) ;; *) echo "finished: $f"; seen="$seen $f";; esac; done; sleep 5; done
```

**One event when all are done** — a backgrounded Bash command that exits by itself:

```bash
run=RUNID; n=N; until [ "$(ls .fleet/$run/*.done .fleet/$run/*.blocked 2>/dev/null | wc -l)" -ge "$n" ]; do sleep 5; done; echo "all $n testers finished"
```

Substitute the real run-id and count.

There is a third option when you spawned the sessions yourself and want a per-session signal rather than a
file one: `SendMessage` with `notify_when_idle: true` gives exactly one notice when that session next goes
idle, with no message body and no cost to it. Prefer the file watch anyway — a file has an address, and a
session handle does not.

While waiting, do useful work: read the briefs already marked done and start ranking their findings. Do
not sit idle, and never ask the operator whether the testers have finished.

## `.blocked` is not a pass

It means that tester's pane was never displayed, so it wrote no findings. Say so explicitly in the
summary. A screen nobody could see is not a screen that passed, and a run that reports "clean" when a
third of it was blind is worse than no run at all.

## Report

Which chips finished, which were blocked, and the raw finding count per chip. Then stop — merging and
ranking is `/makarasty:fleet-collect`.
