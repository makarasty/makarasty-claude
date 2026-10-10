---
description: Wait for a run's workers to finish without spending model turns, then collect. Use while workers are running, or to ask whether a run has finished.
argument-hint: <run-id> [expected worker count]
allowed-tools: Bash, Read, Write, Glob, Grep, Monitor, Agent, TaskStop, PushNotification, ToolSearch, mcp__ccd_session_mgmt__list_sessions, mcp__ccd_session_mgmt__send_message, mcp__ccd_session_mgmt__set_session_model, mcp__ccd_session_mgmt__set_session_effort
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
d=$(cd "$d" && pwd)
# .watch-seen holds paths relative to the run, wherever a watch was armed from; older watches wrote them
# from the cwd (.fleet/<run>/...) or absolute, and an entry in another spelling would be announced again.
seen="$d"/.watch-seen; touch "$seen"; sed -i "s|^.*\.fleet/$run/||" "$seen"
# A .waiting is keyed by its mtime, so a worker blind a second time is announced again; an older watch's
# bare entry gets the mtime of the file it announced.
while IFS= read -r e; do case "$e" in *.waiting) [ -e "$d/$e" ] && e="$e@$(date -r "$d/$e" +%s)";; esac; printf '%s\n' "$e"; done < "$seen" > "$seen.tmp" && mv "$seen.tmp" "$seen"
last=$(date +%s); down=""; tick=0; ps=0; acks=""; ps0=0; t0=$last; cr=$(printf '\r'); pl=""
tok="$$.$t0"; echo "$tok" > "$d/.watch-owner"   # one watch per run: arming a new one ends the one before
sf=$(grep -ls "\"sessionId\":\"${CLAUDE_CODE_SESSION_ID:-none}\"" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions"/*.json 2>/dev/null | head -1)  # this chat's record; gone when it ends
[ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && echo "$CLAUDE_CODE_SESSION_ID" > "$d/coordinator"  # whoever watches, coordinates
FS="${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh"
while true; do
  [ -e "$(cd "$d" 2>/dev/null && pwd)/FINISHED" ] && { echo "run landed"; break; }
  # It ends itself before the monitor's timeout: on Windows the timeout did not reach it, and a watch re-armed
  # every 30 minutes left one more loop running each time (2026-10-08: one ran three hours past its timeout).
  [ $(( $(date +%s) - t0 )) -ge 1780 ] && { echo "watch expired: re-arm it"; break; }
  cur=""; read -r cur < "$d/.watch-owner" 2>/dev/null; [ "$cur" = "$tok" ] || { echo "watch superseded: a newer watch runs this run"; break; }
  tick=$((tick+1))
  if [ $((tick % 6)) -eq 1 ]; then
    if [ -n "$sf" ] && [ ! -e "$sf" ]; then echo "coordinator chat gone"; break; fi
    for u in $svc; do
      curl -g -s -o /dev/null --max-time 5 "$u"; rc=$?
      case " $down " in *" $u "*) was=1;; *) was=0;; esac
      if [ $rc -eq 7 ] && [ $was = 0 ]; then down="$down $u"; echo "SERVICE DOWN: $u refuses connections"; fi
      if [ $rc -ne 7 ] && [ $was = 1 ]; then down=$(printf '%s\n' $down | grep -vxF "$u" | tr '\n' ' '); echo "SERVICE BACK: $u"; fi
    done
    [ -f "$FS" ] && sh "$FS" ctx "$d"
  fi
  if [ $((tick % 30)) -eq 2 ] && [ -f "$FS" ]; then   # every five minutes: what closed chats left running
    sh "$FS" procs "$d" 2>/dev/null | grep -E '^(CLOSED CHAT|ORPHANED RUN|CLOSED CHAT SERVING.*\))  pid ' | while IFS= read -r l; do
      p=$(printf '%s' "$l" | sed -n 's/.*  pid \([0-9]*\) .*/\1/p'); grep -qx "$p" "$d/.leftover-seen" 2>/dev/null && continue
      echo "$p" >> "$d/.leftover-seen"
      case "$l" in "CLOSED CHAT SERVING"*) echo "LEFTOVER, ASK THE OPERATOR: $l";; *) echo "LEFTOVER: $l";; esac; done
  fi
  if [ -e "$d/PAUSED" ]; then   # a pause is announced once, each ack once, and the stall timer rests
    [ $ps = 1 ] || { ps=1; acks=""; ps0=$(date +%s); last=$ps0; echo "PAUSED: $(head -1 "$d/PAUSED")"; }
    if [ $ps0 -gt 0 ] && [ $(( $(date +%s) - ps0 )) -ge 150 ]; then ps0=0   # once: who has not stopped 150 s in
      [ -f "$FS" ] && sh "$FS" status "$d" | sed -n '/^== PAUSED/,/^== /{/^== PAUSED/p;/still working/p;}'; fi
    for a in "$d"/stopped/*; do [ -e "$a" ] || continue; w=$(basename "$a"); case " $acks " in *" $w "*) continue;; esac
      acks="$acks $w"; last=$(date +%s); echo "worker $w stopped"; done
  elif [ $ps = 1 ]; then ps=0; last=$(date +%s); echo "RESUMED"; fi
  sl="|$(tr '\n' '|' < "$seen")"   # read each tick: a watch being superseded appends here too
  for f in "$d"/tasks/claimed/*/owner "$d"/tasks/done/* "$d"/ask/*.md "$d"/*.done "$d"/*.blocked "$d"/*.retired "$d"/*.waiting; do
    [ -e "$f" ] || continue; r=${f#"$d"/}; case "$f" in *.waiting) r="$r@$(date -r "$f" +%s)";; esac; case "$sl" in *"|$r|"*) continue;; esac; echo "$r" >> "$seen"; sl="$sl$r|"; last=$(date +%s)
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
    for c in "$d"/tasks/claimed/*/; do
      [ -d "$c" ] || continue; t=$(basename "$c"); [ -e "$d/tasks/done/$t" ] && continue
      echo "  held: $t by $(head -1 "$c/owner" 2>/dev/null || echo 'NO OWNER')"
    done
    rdy=$(ls "$d"/tasks/ready/*.md 2>/dev/null | wc -l); dne=$(ls "$d"/tasks/done 2>/dev/null | wc -l)
    lw=$(ls "$d"/*.done "$d"/*.blocked "$d"/*.retired 2>/dev/null | sed 's|.*/||; s|\.[^.]*$||' | sort -u | wc -l)
    echo "  progress: $dne of $rdy tasks done, $lw of $n workers landed"
    if [ -f "$FS" ]; then sh "$FS" status "$d" | sed -n '/^== \(markers\|lanes with work\|waits for ever\|bottlenecks\|waiting on the operator\|task files\)/,/^== workers/{/^== workers/!p;}'; fi
    if [ -d "$d/pane/requests" ] && [ -f "$FS" ]; then sh "$FS" pane-status "$d" | sed 's/^/  /'; fi
    last=$now
  fi
  # Every tick, right before the count: a retire writes the old worker's .retired and its replacement's
  # replaced/ in one command, and a count from a minute ago called the run complete in between.
  # The registered chips, read once per tick with the shell's own read, not a grep per offered chip (a chips
  # file has no last newline, so cat would run two of them together).
  reg="|"; for f in "$d"/chips/* "$d"/replaced/*; do [ -f "$f" ] || continue; l=""; read -r l < "$f"; reg="$reg${l%"$cr"}|"; done
  n2=0; for o in "$d"/offered/*; do [ -e "$o" ] || continue; oc=${o##*/}   # a chip that started, or a retire's replacement
    case "$reg" in *"|$oc|"*) n2=$((n2+1));; esac; done; [ "$n2" -gt "$n" ] && n=$n2
  c=$(ls "$d"/*.done "$d"/*.blocked "$d"/*.retired 2>/dev/null | sed 's|.*/||; s|\.[^.]*$||' | sort -u | wc -l)
  # Never while paused: a relaunch hands its workers back (their .retired) before its replacements exist. A
  # run whose workers all landed under a pause is said once, since `landed` refuses a paused run too.
  if [ -e "$d/PAUSED" ]; then
    [ "$c" -ge "$n" ] && [ -z "${pl:-}" ] && { pl=1; echo "ALL $c OF $n WORKERS LANDED, BUT THE RUN IS PAUSED: resume it (fleet.sh resume) to collect"; }
  else pl=""; [ "$c" -ge "$n" ] && { echo "run complete: $c of $n"; break; }; fi
  sleep 10
done
```

Run it with `Monitor`, `timeout_ms: 1800000`, the most a monitor can be given. A fleet run outlasts that,
so **re-arm the same loop on every expiry notice, and when it prints `watch expired: re-arm it`**, until it
prints `run complete` or `run landed`. A watch
that is not re-armed dies silently at thirty minutes and the run never collects. `seen` persists
across re-arms, so nothing already reported is reported twice. A run has one watch: arming a new one
makes the one before print `watch superseded` within ten seconds and end. That line is not an expiry; do
not re-arm on it. Two watches at once used to announce events twice or lose them, by how their ticks fell.

For a run with fixed briefs and no queue, drop the three `tasks/` globs from the `for` line. Everything
else, the stall timer included, still applies.

**A `LEFTOVER:` line is a process nobody waits for**: run `fleet.sh procs <run> --kill` in that turn
(`fleet-plan` 8b, "Watch the machine's memory"). `LEFTOVER, ASK THE OPERATOR:` is a closed chat's tree that
serves something (a dev server, an `http.server`; the line lists its pids leaves first): ask the operator once whether it can go, and only on
their word end its pids one at a time, children first - `taskkill /PID <n> /F` on Windows, never `/T`, which
follows reused pids; `kill <n>` elsewhere.

**A `WORKER MODEL NN` line means worker NN stopped itself at `whoami` and waits for you.** Make the calls
it names in that turn: `docs/MODELS.md`, "Switching a worker", steps 4 and 5. `WORKER MODEL NN DID NOT TAKE`
is step 5's failed switch.

**A `WORKER PLUGIN NN` line means worker NN last claimed on an older makarasty than the one installed.** A
worker keeps the `fleet.sh` path it resolved at its start, so a restart alone does not move it. Ask the
operator once to restart Claude Code, then message the worker as the line says and `touch` the mark it
names: invoking `fleet-run` again resolves the installed plugin, and its next claim records the new version. `WORKER PLUGIN NN STILL ON` is a
worker that claimed and kept the old one: it goes into the one relaunch ask below ("Replace workers NN only"),
with the fresh chips offered by you. A saved watch pinned to the old plugin's path is re-armed from this file
after the restart.

**`COORDINATOR CONTEXT <n>K` means you, the session reading this, are getting full, and a `WORKER CONTEXT`
line naming worker NN means that worker is.** Each prints once per mark and per session, from its
transcript: yours once the loop has recorded you as the coordinator (whoever arms the watch is the
coordinator), a worker's once it crosses `worker_relaunch_k` in `calibration.json`. **A queue worker's
line is yours to act on at once and unasked**: run the `fleet.sh retire` it names and do what it prints
(offer the replacement chip, PushNotification the operator to click it). The worker finishes the task it
holds and leaves at its next claim with its tree committed; the run does not pause and the watch counts the
new chip by itself. `REPLACEMENT NN ... has not started` means that chip was not clicked: notify again.
For any `ask/` question named after `unanswered:` in `<NN>.retired`, answer it under its own id, the text after
`ask/` without `.md` (`fleet.sh answer <run> <NN>-<n>`), and add the answer to the re-filed task's file in
`tasks/ready/`, which is what the replacement reads. If nothing was re-filed (a worker that `next` retired
held no claim), put the answer in a broadcast naming the replacement chip's lane, or in the next task you file
for it. `answer` refuses an id that names no question, so never answer under the replacement's number.
A `pane/requests/<NN>-<n>.md` entry there is a walk the old worker asked for: a host serves it, not you,
but its result lands in `pane/results/<NN>-<n>.json`, which only the old worker was told to read, so name
that path in the re-filed task or the broadcast.
**Your own line, and a brief worker's, you never act on alone**: you do not hand off by chip and you do not
relaunch unasked. Do what `fleet-plan` section 8b says at that line: `PushNotification`, one `AskUserQuestion` with the numbers and the options (a fourth, "Replace
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

Copy the `seen` matching as it stands: `*"|$r|"*` is a whole-entry test, and the substring version it
replaced let the presence of `task-22b` silently suppress every event for `task-22`, which is exactly the
pair a reclaimed task produces. It is matched in the shell, against `sl` read once a tick (a watch that is
being superseded still appends for up to one tick): a `grep` per file every ten seconds forked about a hundred processes
a tick on a 60-task run, 1.5 s on Git Bash [M37].

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

**If the chats stopped rather than went quiet, none of the above applies.** A stall report and a crash
look the same from the run directory — no file changes in either — so the next section decides which.

## After a restart, wake every worker before you re-arm

A Claude Code restart ends the turn of every session on the machine: your watch, and every worker's loop
with it. Claim files and heartbeats survive it, so `status` reads like a working run while nothing works
[M35].

**An expiry notice is not a restart: on one, re-arm and nothing else.** A restart is a turn that did not
start from the watch - the app's own "The app was quit while you were working. Please continue from where
you left off.", the operator writing "продолжи" or "continue", or saying the machine restarted - while
your watch task is missing from your task list and never printed `run complete` or `run landed`. On that,
run `/makarasty:fleet-resume <run-id>` before you read `status`: its step 0 wakes every worker the app still
lists, and its step 5 re-arms this watch. Done when it has reported which workers were woken, reopened and
written off, and you have told the operator that pane workers want their panes on screen again.

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

Every expected worker has a `.done`, a `.blocked` or a `.retired`, or you have said which ones are still outstanding and
for how long.

**When the whole run has landed, invoke `/makarasty:fleet-collect <run-id>` yourself.** Do not print it as
a command for someone else to run. A finished run that nobody merges is a directory of JSONL files, and
the operator who clicked the chips has moved on: measured 2026-08-26, seven finished workers and
74 findings sat unread because the next step was printed rather than taken.

If the operator asked to review the raw findings before merging, say so and stop instead.

## Report

Which workers finished, which were blocked, which are waiting on the operator and for what, and the raw
finding count each produced. Then collect.
