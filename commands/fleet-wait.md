---
description: Wait for a run's workers to finish without spending model turns, then collect. Use while workers are running, or to ask whether a run has finished.
argument-hint: <run-id> [expected worker count]
allowed-tools: Bash, Read, Write, Glob, Grep, Monitor, Agent, TaskStop, PushNotification
---

Watch `.fleet/<run-id>/` for workers finishing. Do the waiting in the shell, where it is free. A re-read
each turn costs a model turn per empty check and needs the operator to prod you between them.

The loop below emits on silence as well as on progress, because a watch that fires only when a file appears
cannot tell a busy fleet from a dead one and a stalled fleet writes no files [M17]. Every `quiet` seconds with
no change on disk it names each claim still outstanding and who holds it, alongside how many tasks and
workers have landed. That line is the cue to send a status check to the worker holding a claim nobody is
advancing, which is the only thing that revives a dead session.

## The loop

`run` and `n` are the run id and the expected worker count. `quiet` is the stall interval in seconds:
`quiet_interval_seconds` in the plugin's `calibration.json`, 600 as shipped.

```bash
run=RUNID; n=N; quiet=600
d=.fleet/$run; seen=$d/.watch-seen; touch "$seen"; last=$(date +%s)
FS="${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh"
while true; do
  [ -e "$(cd "$d" 2>/dev/null && pwd)/FINISHED" ] && { echo "run landed"; break; }
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
    rdy=$(ls $d/tasks/ready/*.md 2>/dev/null | wc -l); dne=$(ls $d/tasks/done 2>/dev/null | wc -l)
    echo "  progress: $dne of $rdy tasks done, $(ls $d/*.done 2>/dev/null | wc -l) of $n workers landed"
    if [ -d "$d/pane/requests" ] && [ -n "$FS" ]; then sh "$FS" pane-status "$d" | sed 's/^/  /'; fi
    last=$now
  fi
  c=$(ls $d/*.done $d/*.blocked 2>/dev/null | wc -l)
  [ "$c" -ge "$n" ] && { echo "run complete: $c of $n"; break; }
  sleep 10
done
```

Run it with `Monitor`, `timeout_ms: 1800000`, the most a monitor can be given. A fleet run outlasts that,
so **re-arm the same loop on every expiry notice** until it prints `run complete` or `run landed`. A watch
that is not re-armed dies silently at thirty minutes and the run never collects. `seen` persists
across re-arms, so nothing already reported is reported twice.

For a run with fixed briefs and no queue, drop the three `tasks/` globs from the `for` line. Everything
else, the stall timer included, still applies.

**A claim is tracked but not announced.** It is entered in `seen`, which resets the quiet timer, and it
shows up by name in the stall report, but it does not wake you on its own. A claim needs nothing from the
planner: of 62 notifications one planner received, 13 were claims it took no action on, each costing a full
model turn to read and dismiss [M18].

Copy the `seen` matching as it stands: `grep -Fxq` is a whole-line test, and the substring version it
replaced let the presence of `task-22b` silently suppress every event for `task-22`, which is exactly the
pair a reclaimed task produces.

**A stall report whose counts moved since the last one is a fleet doing long tasks; one whose counts are
identical is a fleet that has stopped.** You can tell them apart without opening a worker chat, and the next
section acts on the difference.

## The run ends by declaration, not by a count that may never arrive

The loop's exit condition is `.done` plus `.blocked` reaching the expected count. That condition has a
hole: a worker that dies without writing either marker never lands, so the count never completes, the
watch never breaks, collection never runs, no notification ever fires, and the run ends in fact while
never ending on paper. From the operator's side that is indistinguishable from a run still working, which
is exactly the state the 2026-08-31 run left its operator in for an hour.

So keep the count as the happy path and give yourself a fallback with a threshold, not a feeling:

> **After three consecutive stall reports naming the same unmoving claims and the same counts**, the run
> is over whether or not every marker landed. Message the workers holding those claims once, with
> `mcp__ccd_session_mgmt__send_message` to the session titled `fleet <run-id> NN`, since a cross-session
> status check is the only thing that revives a dead session. If the next stall report is
> identical again, end the run by decision: name the missing workers, reclaim or write off their tasks,
> collect what is on disk, and report the missing ones as unaccounted rather than as clean.

A `.done` that lands after that is orphaned unless collection is re-run. Say so in the summary; do not
pretend the count closed.

**If the chats are gone rather than quiet, none of the above applies.** A stall report and a crash look the
same from the run directory — no file changes in either — and the difference is whether the workers still
exist. When `mcp__ccd_session_mgmt__list_sessions` no longer lists them, or the operator says the machine restarted, stop messaging
and run `/makarasty:fleet-resume <run-id>`: the sessions with transcripts are reopened with their context,
and only the rest are written off.

## The watch must end

Measured 2026-08-27: a planner armed a `while true` watch with no exit condition, on a host that then
allowed an unbounded monitor. It ran for **five hours and forty two minutes**, long past every worker finishing, and was killed only when
the operator asked what the six hour task in the task list was.

The loop above breaks on its own when the expected count lands. It is still yours to stop when the run ends
some other way, when you re-arm a replacement, or when the operator cancels the run: call `TaskStop` with
the watch's task id. `fleet-collect` stops it as its last act.

## While waiting

Use the wait. In pull mode there is real work: answer the questions
in `ask/`, re-file the remainders workers hand back, add tasks when a finding points somewhere new, check
claims against the three-term dead test in `docs/PULL.md`.

**Answer with `fleet.sh answer <run> <id> [id...]`, and put anything the whole fleet needs in
`fleet.sh broadcast`.** One reply usually settles several questions, and a combined file named after none
of them reaches none of them: four answered questions still read as open an hour later, and four workers
filed the same broken tool inside nine minutes, two of them after it was fixed [M19]. A broadcast is what
stops the fifth. With fixed briefs, read the briefs whose workers
have landed and start ranking their findings.

Do not start a second run before the first one is collected. Measured 2026-08-27: a planner moved straight
from a finished run into planning the next one, and the first run's six finished workers sat unmerged for
**two hours forty nine minutes**. Collection is cheap and the findings are already on disk; the cost is
entirely in forgetting.

## Read `.blocked` as an absence, not a pass

It means that worker's pane never composited, so it wrote no findings. Say so in the summary, by name. A
run reporting clean while a third of it saw nothing is worse than no run, and the marker is the only place
that shows it.

## Done when

Every expected worker has a `.done` or a `.blocked`, or you have said which ones are still outstanding and
for how long.

**When the whole run has landed, invoke `/makarasty:fleet-collect <run-id>` yourself.** Do not print it as
a command for someone else to run. A finished run that nobody merges is a directory of JSONL files, and
the operator who clicked the chips has moved on: measured 2026-08-26, seven finished workers and
74 findings sat unread because the next step was printed rather than taken.

If the operator asked to review the raw findings before merging, say so and stop instead.

## Report

Which workers finished, which were blocked, which are waiting on the operator and for what, and the raw
finding count each produced. Then collect.
