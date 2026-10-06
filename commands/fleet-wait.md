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

`svc` is every service the run depends on, as URLs. The loop builds it from the project's `FLEET.md`, from the
one line `- Services: <url> (start: <how>|operator); <url> (start: ...)` (`fleet-init` writes it; leave the
line out for a run that needs none), and you add the URL of the integration checkout's dev server when the
run has one (the commented line in the loop is an example to replace, not a default). Do not retype the
`FLEET.md` URLs. Only a URL that comes before an item's `(start: ...)` part is taken, so a start command that
mentions a URL is not probed. An empty `svc` prints `WATCH: no '- Services:' line in FLEET.md, services are
not being checked`: an old-format `FLEET.md` (`fleet-init` converts it) looks exactly like a run that needs
no services, and the notice is what tells them apart. On that notice, read `FLEET.md` before deciding: if it
names services in any other shape, convert the line (`fleet-init` section 3) and re-arm. The loop
finds `.fleet/<run>` and `FLEET.md` in the main checkout when the cwd, a worktree, lacks them. A refused connection prints `SERVICE DOWN` once, and `SERVICE BACK` when it answers again. A slow
answer is not down: only curl's "connection refused" counts.

```bash
run=RUNID; n=N; quiet=600
m=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")   # the main checkout, from any worktree of it
d=.fleet/$run; [ -d "$d" ] || d=$m/.fleet/$run
fm=FLEET.md; [ -f "$fm" ] || fm=$m/FLEET.md
svc=$(sed -n 's/^- Services: *//p' "$fm" 2>/dev/null | sed 's/(start:[^)]*)//g' | grep -oE '(^|; *)https?://[^ ;]+' | grep -oE 'https?://.*' | tr '\n' ' ')
# svc="$svc http://localhost:5199"   # EXAMPLE only: uncomment with the integration checkout's real dev-server URL
[ -z "$svc" ] && echo "WATCH: no '- Services:' line in FLEET.md, services are not being checked"
[ -d "$d" ] || { echo "NO RUN DIR $d from $(pwd)"; exit 1; }
seen=$d/.watch-seen; touch "$seen"; last=$(date +%s); down=""; tick=0; ps=0; acks=""; ps0=0
[ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && echo "$CLAUDE_CODE_SESSION_ID" > "$d/coordinator"  # whoever watches, coordinates
FS="${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh"
while true; do
  [ -e "$(cd "$d" 2>/dev/null && pwd)/FINISHED" ] && { echo "run landed"; break; }
  tick=$((tick+1))
  if [ $((tick % 6)) -eq 1 ]; then
    for u in $svc; do
      curl -g -s -o /dev/null --max-time 5 "$u"; rc=$?
      case " $down " in *" $u "*) was=1;; *) was=0;; esac
      if [ $rc -eq 7 ] && [ $was = 0 ]; then down="$down $u"; echo "SERVICE DOWN: $u refuses connections"; fi
      if [ $rc -ne 7 ] && [ $was = 1 ]; then down=$(printf '%s\n' $down | grep -vxF "$u" | tr '\n' ' '); echo "SERVICE BACK: $u"; fi
    done
    [ -f "$FS" ] && sh "$FS" ctx "$d"
  fi
  if [ -e "$d/PAUSED" ]; then   # a pause is announced once, each ack once, and the stall timer rests
    [ $ps = 1 ] || { ps=1; acks=""; ps0=$(date +%s); last=$ps0; echo "PAUSED: $(head -1 "$d/PAUSED")"; }
    if [ $ps0 -gt 0 ] && [ $(( $(date +%s) - ps0 )) -ge 150 ]; then ps0=0   # once: who has not stopped 150 s in
      [ -f "$FS" ] && sh "$FS" status "$d" | sed -n '/^== PAUSED/,/^== /{/^== PAUSED/p;/still working/p;}'; fi
    for a in $d/stopped/*; do [ -e "$a" ] || continue; w=$(basename "$a"); case " $acks " in *" $w "*) continue;; esac
      acks="$acks $w"; last=$(date +%s); echo "worker $w stopped"; done
  elif [ $ps = 1 ]; then ps=0; last=$(date +%s); echo "RESUMED"; fi
  for f in $d/tasks/claimed/*/owner $d/tasks/done/* $d/ask/*.md $d/*.done $d/*.blocked $d/*.retired $d/*.waiting; do
    [ -e "$f" ] || continue; grep -Fxq "$f" "$seen" && continue; echo "$f" >> "$seen"; last=$(date +%s)
    case "$f" in
      *.waiting) echo "NEEDS OPERATOR: $f -- $(cat "$f")";;
      */ask/*) echo "QUESTION FOR PLANNER: $f -- $(head -c 300 "$f")";;
      */owner) ;;
      */tasks/done/*) echo "task finished: $f";;
      *.retired) echo "worker retired: $f";;
      *) echo "worker finished queue: $f";;
    esac
  done
  now=$(date +%s)
  if [ $ps = 0 ] && [ $((now-last)) -ge $quiet ]; then
    echo "STALL: nothing on disk changed for $(( (now-last)/60 ))m"
    for c in $d/tasks/claimed/*/; do
      [ -d "$c" ] || continue; t=$(basename "$c"); [ -e "$d/tasks/done/$t" ] && continue
      echo "  held: $t by $(head -1 "$c/owner" 2>/dev/null || echo 'NO OWNER')"
    done
    rdy=$(ls $d/tasks/ready/*.md 2>/dev/null | wc -l); dne=$(ls $d/tasks/done 2>/dev/null | wc -l)
    echo "  progress: $dne of $rdy tasks done, $(ls $d/*.done $d/*.retired 2>/dev/null | wc -l) of $n workers landed"
    if [ -f "$FS" ]; then sh "$FS" status "$d" | sed -n '/^== \(lanes with work\|waits for ever\|bottlenecks\|waiting on the operator\|task files\)/,/^== workers/{/^== workers/!p;}'; fi
    if [ -d "$d/pane/requests" ] && [ -f "$FS" ]; then sh "$FS" pane-status "$d" | sed 's/^/  /'; fi
    last=$now
  fi
  c=$(ls $d/*.done $d/*.blocked $d/*.retired 2>/dev/null | wc -l)
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

**A `WORKER PLUGIN NN` line means worker NN runs an older makarasty than the one installed**, so a pause or
a retirement may not hold it: it goes into the same one relaunch ask below ("Replace workers NN only"), and
you offer the fresh chips yourself, saying in that same ask that a fresh chip runs the new version only if
Claude Code was restarted after the update; the operator should not have to ask whether old workers need replacing.

**`COORDINATOR CONTEXT <n>K` means you, the session reading this, are getting full, and a `WORKER CONTEXT`
line naming worker NN means that worker is.** Each prints once per mark and per session, from its
transcript: yours once the loop has recorded you as the coordinator (whoever arms the watch is the
coordinator), a worker's once it crosses `worker_relaunch_k` in `calibration.json`. You act on neither
alone: you do not hand off by chip and you do not relaunch unasked. Do what `fleet-plan` section 8b says
at that line: `PushNotification`, one `AskUserQuestion` with the numbers and the options (a fourth, "Replace
workers NN only", when only workers are over), and on "yes" `fleet.sh relaunch`, run with
`run_in_background` and in two calls: it pauses the run, hands the named workers' tasks back, asks you to
update `STATE.md`, and on the second call prints one coordinator chip and fresh worker chips (with
`--keep-coordinator`, only the worker chips, and you stay). Stop this watch with `TaskStop` before you offer them (and with `--keep-coordinator` re-arm it at once, `n` raised to every chip ever offered): two watches share
`seen`, and the old one would report every event first and mark it seen, so the new coordinator never hears
it. The new coordinator re-arms the watch itself. `fleet.sh contexts <run>` lists every session's context
and marks the ones `OVER`. A coordinator that ignores the line holds the review state of the whole run in a
context that is about to be compacted.

**`PAUSED`, `RESUMED` and `worker NN stopped` are the loop's three pause lines.** `PAUSED: <time and
reason>` prints once when `<run>/PAUSED` appears (the operator ran `/makarasty:fleet-pause`, or a
relaunch did). `worker NN stopped` prints as each worker that holds claims acknowledges, which is its file
under `<run>/stopped/`; `fleet.sh status` shows `k of n` stopped. `RESUMED` prints once when the pause is
lifted. The loop stays armed through a pause, prints no `STALL` while it lasts (heartbeats stop on purpose),
and restarts the quiet timer on `RESUMED`. 150 seconds into a pause (`pause_still_working_seconds`) it prints, once, the `status` header
`== PAUSED since <time>: <k> of <n> workers holding claims have stopped` and a line for each worker `still
working`; message those by title (`fleet-pause` says how). On `PAUSED` there is nothing to do but watch the acks; do not
message the workers, the hooks already stop them. A worker silent past that may be inside
one long tool call: it stops at its next one. `worker retired: <path>` is a worker a relaunch replaced; it
counts as finished.

**`task finished` is reviewed by a subagent, not by you**, as `fleet-plan` section 8b says: you read the
verdict and file the fix tasks it names, and your context grows by the verdict rather than the diff. A
code task's done marker holds a `branch <name>` line (`fleet.sh finish` writes it): that is the branch to
review and merge.

**`NO RUN DIR <path> from <cwd>` means the loop could not find the run** in the cwd or in the main checkout and
exited at once, rather than looping silently on a run it cannot see. Check the run id, and start it from the
project root. **A stall report ends
with the lanes that have ready work and no worker**, taken from `fleet.sh status`: that line, not a worker,
is what is missing when the counts stop moving and no claim is held.

**`SERVICE DOWN` is acted on in the turn it arrives.** Restart the service yourself when its `start:` field
on `FLEET.md`'s `Services` line names how; when it says `operator`, tell the operator in one line, with `PushNotification`, naming the
service and what stops working without it. Measured 2026-10-05: the functions emulator died at 16:47 and
again at 19:08, a run was live both times, and the operator noticed it in their own terminal.

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

The loop's exit condition is `.done`, `.blocked` and `.retired` reaching the expected count. That condition has a
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
