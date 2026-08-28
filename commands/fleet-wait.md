---
description: Wait for a fleet run's workers to finish, spending no model turns on the waiting. Use when workers are running, when asked whether a run has finished, or before collecting a run.
argument-hint: <run-id> [expected worker count]
allowed-tools: Bash, Read, Write, Glob, Grep, Monitor, Agent, TaskStop, PushNotification
---

Watch `.fleet/<run-id>/` for workers finishing. The waiting belongs in the shell, where it is free, rather
than in a re-read each turn, which costs a model turn per empty check and needs the operator to prod you
between them.

## The watch must emit on silence, not only on progress

A watch that fires only when a file appears cannot tell a busy fleet from a dead one. Both look like an
empty inbox.

Measured 2026-08-27: three of six workers stalled at the same minute, no file in the run directory changed
for nearly three hours, the watch stayed silent because silence was all it had to say, and the planner
slept for 65 minutes until the operator typed "I think the chat has hung". The `Monitor` tool's own
guidance names this failure: if the thing you are watching died right now, would your filter emit
anything?

So the loop below carries a quiet timer. Every ten minutes with no change on disk it says so and names
every claim still outstanding and who holds it. That line is the planner's cue to send a status check to
the worker holding it, which is the only thing that revives a dead session.

## The loop

`run` and `n` are the run id and the expected worker count. `quiet` is the stall interval in seconds.

```bash
run=RUNID; n=N; quiet=600
d=.fleet/$run; seen=$d/.watch-seen; : > "$seen"; last=$(date +%s)
while true; do
  for f in $d/tasks/claimed/*/owner $d/tasks/done/* $d/ask/*.md $d/*.done $d/*.blocked $d/*.waiting; do
    [ -e "$f" ] || continue; grep -Fxq "$f" "$seen" && continue; echo "$f" >> "$seen"; last=$(date +%s)
    case "$f" in
      *.waiting) echo "NEEDS OPERATOR: $f -- $(cat "$f")";;
      */ask/*) echo "QUESTION FOR PLANNER: $f -- $(head -c 300 "$f")";;
      */owner) ;;
      */tasks/done/*) echo "task finished: $f";;
      *) echo "worker finished queue: $f";;
    esac
  done
  now=$(date +%s)
  if [ $((now-last)) -ge $quiet ]; then
    echo "STALL: nothing on disk changed for $(( (now-last)/60 ))m"
    for c in $d/tasks/claimed/*/; do
      [ -d "$c" ] || continue; t=$(basename "$c"); [ -e "$d/tasks/done/$t" ] && continue
      echo "  held: $t by $(head -1 "$c/owner" 2>/dev/null || echo 'NO OWNER')"
    done
    last=$now
  fi
  c=$(ls $d/*.done $d/*.blocked 2>/dev/null | wc -l)
  [ "$c" -ge "$n" ] && { echo "run complete: $c of $n"; break; }
  sleep 10
done
```

Run it with `Monitor`, `persistent: true`. A fleet run outlasts the hour a bounded monitor can be given,
and the loop ends itself the moment the last worker lands.

For a run with fixed briefs and no queue, drop the three `tasks/` globs from the `for` line. Everything
else, the stall timer included, still applies.

**A claim is tracked but not announced.** It is entered in `seen`, which resets the quiet timer, and it
shows up by name in the stall report, but it does not wake you on its own: a claim needs nothing from the
planner. Measured 2026-08-27: of 62 notifications one planner received, 13 were claims it took no action
on, each costing a full model turn to read and dismiss.

**Two details in that loop are load bearing.** The `seen` file is matched with `grep -Fxq`, whole line, not
by substring: the previous version tested `case "$seen" in *"$f"*`, under which the presence of `task-22b`
silently suppressed every event for `task-22`, and a reclaimed task always produces exactly that pair. And
the file lives inside the run directory rather than in a temp path, so a restarted watch on a different
machine or shell finds it.

## The watch must end

Measured 2026-08-27: a planner armed a `while true` watch with `persistent: true` and no exit condition.
It ran for **five hours and forty two minutes**, long past every worker finishing, and was killed only when
the operator asked what the six hour task in the task list was.

The loop above breaks on its own when the expected count lands. It is still yours to stop when the run ends
some other way, when you re-arm a replacement, or when the operator cancels the run: call `TaskStop` with
the watch's task id. `fleet-collect` stops it as its last act.

## While waiting

The wait is free only if you spend it on something. In pull mode there is real work: answer the questions
in `ask/`, re-file the remainders workers hand back, add tasks when a finding points somewhere new, check
claims against the three-term dead test in `docs/PULL.md`. With fixed briefs, read the briefs whose workers
have landed and start ranking their findings.

Do not start a second run before the first one is collected. Measured 2026-08-27: a planner moved straight
from a finished run into planning the next one, and the first run's six finished workers sat unmerged for
**two hours forty nine minutes**. Collection is cheap and the findings are already on disk; the cost is
entirely in forgetting.

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
