#!/bin/sh
# fleet.sh - the protocol bookkeeping of a pull mode run, one call per boundary.
#
# Measured 2026-08-27 over a six worker run: 235 of 612 worker shell calls, 38 percent, were protocol
# paperwork done by hand - walk ready, mkdir the claim, write owner, read the task, append a finding,
# touch the done marker. Every one of them is a model round trip. This collapses them to one call each,
# and validates the finding schema on the way in, which is the only place a contract can be enforced
# rather than requested.
#
# Usage, from anywhere:
#   fleet.sh next    <run-dir> <chip> [lane]       claim the first free task in that lane, print it. exit 3 = drained
#   fleet.sh beat    <run-dir> <chip> <task-id>    refresh heartbeat. exit 4 = claim lost, take another
#   fleet.sh clock   <run-dir> <chip> <task-id> [budget-min]   print the self-disarming abort clock to background
#   fleet.sh finish  <run-dir> <chip> <task-id>    mark the task done; its clock then exits on its own
#   fleet.sh find    <run-dir> <chip>              read one JSON finding on stdin, validate, append
#   fleet.sh ask     <run-dir> <chip>              read a question on stdin, file it, print the path
#   fleet.sh drained <run-dir> <chip>              queue empty: write <chip>.done. exit 5 = queue still open
#   fleet.sh status  <run-dir>                     planner view: claims, ages, markers, questions
#   fleet.sh width   <run-dir>                     how many repo workers this queue and this machine want
#   fleet.sh pane-ask   <run-dir> <chip>           file a browser walk for a pane host to run, on stdin
#   fleet.sh pane-next  <run-dir> <host>           claim the oldest pending walk. exit 3 = none pending
#   fleet.sh pane-serve <run-dir> <host> <id>      answer one walk with JSON on stdin, gate reading included
#   fleet.sh pane-status <run-dir>                 backlog depth, oldest wait, median lease
#   fleet.sh summary <run-dir> [chip]              the end banner: counts from disk, plus one JSON line
#   fleet.sh landed  <run-dir> <expected-chips>    is the run genuinely finished? exit 0 yes, 1 no
#   fleet.sh merge   <run-dir>                     findings -> backlog.jsonl, reconciled or refused
#   fleet.sh render  <run-dir>                     backlog.jsonl -> backlog.md and skipped.md
#   fleet.sh fixqueue <run-dir>                    backlog.jsonl -> a queue a second fleet can claim
#
# The run directory carries a RUN_FORMAT file naming the layout's major version. A newer format is
# refused rather than misread.
#
# POSIX sh. Works in Git Bash on Windows. Node is used only to validate a finding, and its absence
# downgrades that to a warning rather than a failure.

set -eu

cmd=${1:-}; run=${2:-}
[ -n "$cmd" ] && [ -n "$run" ] || { echo "usage: fleet.sh <command> <run-dir> [args]" >&2; exit 2; }
[ -d "$run" ] || { echo "no such run directory: $run" >&2; exit 2; }
now() { date -Iseconds 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ; }

# The on-disk run layout is the thing this tool promises to keep working. Stamp its major version into the
# run at the first write, so a reader a year from now can refuse a shape it does not know instead of
# quietly misreading it. The schema has already had one breaking rename (`what` -> `observed`); the next
# one should not be silent.
RUN_FORMAT=1
stamp() { [ -e "$run/RUN_FORMAT" ] || printf '%s
' "$RUN_FORMAT" > "$run/RUN_FORMAT" 2>/dev/null || true; }
readable() {
  [ -e "$run/RUN_FORMAT" ] || return 0
  have=$(head -1 "$run/RUN_FORMAT" 2>/dev/null | tr -dc 0-9)
  [ -n "$have" ] || return 0
  if [ "$have" -gt "$RUN_FORMAT" ]; then
    echo "REFUSED: this run is format $have and this fleet.sh reads format $RUN_FORMAT" >&2
    echo "  Update the plugin rather than reading it with the wrong shape." >&2
    exit 2
  fi
}
readable

case "$cmd" in

next)
  chip=${3:?chip id required}
  lane=${4:-}
  stamp
  mkdir -p "$run/tasks/claimed" "$run/tasks/done"
  for f in "$run"/tasks/ready/*.md; do
    [ -e "$f" ] || continue
    id=$(basename "$f" .md)
    [ -e "$run/tasks/done/$id" ] && continue
    # A worker with no pane must not claim a pane task, and finding that out after the claim costs a
    # reclaim. Measured 2026-08-31: `next` had no lane filter, the planner worked around it by telling
    # nine workers in their chip prompt to walk `ready/` by hand instead, and the helper went unused for
    # the whole run - 75 hand rolled claims, and every finding appended without passing the schema gate.
    if [ -n "$lane" ]; then
      want=$(sed -n 's/^needs:[[:space:]]*\([a-z][a-z]*\).*/\1/p' "$f" | head -1)
      [ -n "$want" ] || want=repo
      [ "$want" = "$lane" ] || continue
    fi
    if mkdir "$run/tasks/claimed/$id" 2>/dev/null; then
      t=$(now)
      printf 'chip %s\nclaimed %s\n' "$chip" "$t" > "$run/tasks/claimed/$id/owner"
      printf '%s\n' "$t" > "$run/tasks/claimed/$id/heartbeat"
      b=$(sed -n 's/^budget:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$f" | head -1)
      [ -n "$b" ] || b=25
      echo "CLAIMED $id"
      echo "LANE ${lane:-any}"
      echo "BUDGET_MIN $b"
      echo "ABORT_AFTER_SEC $((b * 120))"
      echo "ARM_CLOCK background what this prints: sh fleet.sh clock $run $chip $id $b"
      echo "---"
      cat "$f"
      exit 0
    fi
  done
  echo "QUEUE DRAINED${lane:+ for lane $lane}"
  exit 3
  ;;

clock)
  # The abort clock, printed rather than described. Background exactly what this prints.
  #
  # It used to be a plain `sleep <2x budget>` that somebody had to remember to stop, and across two
  # measured runs 87 of them were armed and none stopped, waking finished sessions for 1,090 minutes.
  # A rule asked for 87 times and obeyed 0 times is not a rule. So the clock now reads the same disk the
  # rest of the protocol writes: it wakes every 30 seconds, exits silently the moment its task is closed
  # or its worker is finished, and only speaks if the budget really did elapse. Nothing to disarm,
  # because nothing outlives its obligation.
  chip=${3:?chip id required}; id=${4:?task id required}; mins=${5:-25}
  rounds=$(( mins * 2 * 60 / 30 ))
  printf 'i=0; while [ $i -lt %s ]; do sleep 30; i=$((i+1)); [ -e "%s/tasks/done/%s" ] && exit 0; [ -e "%s/%s.done" ] && exit 0; done; echo budget-elapsed-%s\n' \
    "$rounds" "$run" "$id" "$run" "$chip" "$id"
  ;;

width)
  # The repo lane's width, computed rather than retyped. Inputs: how many repo tasks are ready, and what
  # the machine has free. A formula in prose drifts every time somebody restates it; this one has a
  # single spelling.
  ready=0
  for f in "$run"/tasks/ready/*.md; do
    [ -e "$f" ] || continue; id=$(basename "$f" .md)
    [ -e "$run/tasks/done/$id" ] && continue
    lane=$(sed -n 's/^needs:[[:space:]]*\([a-z][a-z]*\).*/\1/p' "$f" | head -1)
    [ -n "$lane" ] || lane=repo
    [ "$lane" = repo ] && ready=$((ready + 1))
  done
  want=$(( (ready + 2) / 3 ))
  [ "$want" -lt 1 ] && want=1
  cap=""
  loader=$(ls -t "$(dirname "$0")/fleet-load.mjs" ~/.claude/plugins/cache/*/makarasty/*/scripts/fleet-load.mjs 2>/dev/null | head -1)
  if [ -n "$loader" ] && command -v node >/dev/null 2>&1; then
    cap=$(node "$loader" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const byRam=Math.floor(o.freeGB-2);console.log(Math.max(1,Math.min(byRam,12)));}catch{console.log("")}})')
  fi
  [ -n "$cap" ] || cap=6
  n=$want; [ "$n" -gt "$cap" ] && n=$cap
  echo "REPO_WORKERS $n"
  echo "  ready repo tasks $ready, one worker per three -> $want"
  echo "  machine cap $cap (free memory less the 2 GB the operator keeps, ceiling 12)"
  echo "  the pane lane is a display question and starts at 2; the verify lane is 1"
  ;;

beat)
  chip=${3:?chip id required}; id=${4:?task id required}
  d=$run/tasks/claimed/$id
  if [ ! -d "$d" ] || ! grep -q "chip $chip\$" "$d/owner" 2>/dev/null; then
    echo "CLAIM LOST $id"; exit 4
  fi
  now > "$d/heartbeat"
  echo "OK $id"
  ;;

finish)
  chip=${3:?chip id required}; id=${4:?task id required}
  d=$run/tasks/claimed/$id
  if [ -d "$d" ] && ! grep -q "chip $chip\$" "$d/owner" 2>/dev/null; then
    echo "CLAIM LOST $id, done marker NOT written"; exit 4
  fi
  [ -d "$d" ] && now > "$d/heartbeat"
  mkdir -p "$run/tasks/done"; : > "$run/tasks/done/$id"
  echo "DONE $id"
  echo "The clock guarding it sees this marker within 30 seconds and exits on its own."
  ;;

find)
  chip=${3:?chip id required}
  stamp
  tmp=$(mktemp); cat > "$tmp"
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs=require("fs");
      let o; try { o = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }
      catch (e) { console.error("REFUSED: not one JSON object: "+e.message); process.exit(1); }
      const sev=["blocker","major","minor","polish"];
      const problems=[];
      if (o.unreached) { if (!o.reason) problems.push("unreached line needs reason"); }
      else if (o.created || o.state_changed) { /* auxiliary shapes carry their own fields */ }
      else {
        for (const k of ["area","severity","observed","evidence","mechanism_status"])
          if (!o[k] || String(o[k]).trim()==="") problems.push("missing "+k);
        if (o.severity && !sev.includes(o.severity)) problems.push("severity not one of "+sev.join("|"));
        if (o.mechanism_status && !["established","hypothesis","unknown"].includes(o.mechanism_status))
          problems.push("mechanism_status not established|hypothesis|unknown");
        if (o.evidence && String(o.evidence).length < 12) problems.push("evidence too thin to reproduce from");
        if (o.what) problems.push("`what` is the retired field name, use `observed`");
        // A visual claim carries the two rectangles it is about, and they have to actually intersect.
        // A model shown a screenshot will report an overlap that is not there; geometry will not.
        if (o.rects) {
          const a = o.rects.a, b = o.rects.b;
          if (!a || !b) problems.push("rects needs both a and b");
          else {
            const ox = Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x, b.x);
            const oy = Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y);
            if (ox <= 0 || oy <= 0) problems.push("the rects in this finding do not intersect");
          }
          if (!/\d/.test(String(o.conditions||""))) problems.push("a visual finding states its viewport and zoom in conditions");
        }
      }
      if (problems.length) { console.error("REFUSED: "+problems.join("; ")); process.exit(1); }
      o.when = o.when || new Date().toISOString();
      o.chip = o.chip || process.argv[2];
      process.stdout.write(JSON.stringify(o)+"\n");
    ' "$tmp" "$chip" >> "$run/$chip.jsonl" || { rm -f "$tmp"; exit 1; }
  else
    echo "warning: node absent, finding appended unvalidated" >&2
    tr -d '\n' < "$tmp" >> "$run/$chip.jsonl"; echo >> "$run/$chip.jsonl"
  fi
  rm -f "$tmp"
  echo "FILED $(wc -l < "$run/$chip.jsonl" | tr -d ' ') lines in $chip.jsonl"
  ;;

ask)
  chip=${3:?chip id required}
  mkdir -p "$run/ask"
  n=1; while [ -e "$run/ask/$chip-$n.md" ]; do n=$((n + 1)); done
  cat > "$run/ask/$chip-$n.md"
  echo "ASKED $run/ask/$chip-$n.md, read $run/answers/$chip-$n.md at your next boundary"
  ;;

drained)
  chip=${3:?chip id required}
  # A drained queue is not the end of the run while the planner still intends to file work. The marker
  # says so, and it is what lets the repo lane run at full width from the first minute without closing
  # chats that will be needed again an hour later.
  if [ -e "$run/tasks/queue-open" ]; then
    echo "QUEUE OPEN: $(cat "$run/tasks/queue-open" 2>/dev/null | head -1)"
    echo "Nothing ready right now. Poll again rather than finishing: sleep 300; echo recheck"
    exit 5
  fi
  : > "$run/$chip.done"
  echo "QUEUE DRAINED, $chip.done written"
  echo
  sh "$0" summary "$run" "$chip"
  n=0; [ -e "$run/$chip.jsonl" ] && n=$(grep -c '"severity"' "$run/$chip.jsonl" 2>/dev/null || echo 0)
  echo
  echo "RENAME THIS SESSION TO: fleet $(basename "$run") $chip - done ${n}f"
  echo "That title is the only thing about you visible from the chat the operator is sitting in."
  ;;

pane-ask)
  # A browser walk, filed as a file, for whichever session is holding a pane. The requester does not need
  # a pane, does not wait, and claims a repo task while the answer is being produced.
  chip=${3:?chip id required}
  mkdir -p "$run/pane/requests" "$run/pane/results" "$run/pane/running"
  n=1; while [ -e "$run/pane/requests/$chip-$n.md" ] || [ -e "$run/pane/results/$chip-$n.json" ]; do n=$((n + 1)); done
  cat > "$run/pane/requests/$chip-$n.md"
  echo "FILED $run/pane/requests/$chip-$n.md"
  echo "READ  $run/pane/results/$chip-$n.json at your next task boundary"
  ;;

pane-next)
  host=${3:?host chip id required}
  mkdir -p "$run/pane/requests" "$run/pane/results" "$run/pane/running"
  for f in "$run"/pane/requests/*.md; do
    [ -e "$f" ] || continue
    id=$(basename "$f" .md)
    [ -e "$run/pane/results/$id.json" ] && continue
    if mkdir "$run/pane/running/$id" 2>/dev/null; then
      printf 'host %s\nclaimed %s\n' "$host" "$(now)" > "$run/pane/running/$id/owner"
      echo "WALK $id"
      echo "---"
      cat "$f"
      exit 0
    fi
  done
  echo "NO WALKS PENDING"
  exit 3
  ;;

pane-serve)
  host=${3:?host chip id required}; id=${4:?walk id required}
  [ -d "$run/pane/running/$id" ] || { echo "no claimed walk $id" >&2; exit 2; }
  grep -q "host $host\$" "$run/pane/running/$id/owner" 2>/dev/null || { echo "WALK LOST $id" >&2; exit 4; }
  tmp=$(mktemp); cat > "$tmp"
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs=require("fs");
      let o; try { o = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }
      catch (e) { console.error("REFUSED: not one JSON object: "+e.message); process.exit(1); }
      const p=[];
      // The requester never saw the pane, so the result has to carry the proof the pane was real. This is
      // the one thing a session driving its own pane could never check about itself.
      if (typeof o.gate !== "number") p.push("gate: the frame count this walk was measured under, as a number");
      else if (o.gate < 60) p.push("gate reads "+o.gate+", which is blind: do not serve a blind walk");
      if (!o.conditions || !/\d/.test(String(o.conditions))) p.push("conditions naming viewport and zoom");
      if (!Array.isArray(o.observations)) p.push("observations: an array, empty is a real answer");
      if (p.length) { console.error("REFUSED: "+p.join("; ")); process.exit(1); }
      o.served_at = new Date().toISOString(); o.host = process.argv[2];
      process.stdout.write(JSON.stringify(o)+"\n");
    ' "$tmp" "$host" > "$run/pane/results/$id.json" || { rm -f "$tmp" "$run/pane/results/$id.json"; exit 1; }
  else
    cat "$tmp" > "$run/pane/results/$id.json"
  fi
  rm -f "$tmp"
  rm -rf "$run/pane/running/$id"
  echo "SERVED $id -> $run/pane/results/$id.json"
  ;;

pane-status)
  [ -d "$run/pane/requests" ] || { echo "no pane broker in this run"; exit 0; }
  pend=0; oldest=0; nowsec=$(date +%s)
  for f in "$run"/pane/requests/*.md; do
    [ -e "$f" ] || continue; id=$(basename "$f" .md)
    [ -e "$run/pane/results/$id.json" ] && continue
    pend=$((pend + 1))
    t=$(date -r "$f" +%s 2>/dev/null || echo "$nowsec")
    age=$(( (nowsec - t) / 60 )); [ "$age" -gt "$oldest" ] && oldest=$age
  done
  served=$(ls "$run"/pane/results/*.json 2>/dev/null | wc -l | tr -d ' ')
  echo "pane walks: $pend pending, oldest waiting ${oldest}m, $served served"
  if [ "$pend" -gt 0 ] && [ "$oldest" -gt 20 ]; then
    echo "  the pane lane is behind: offer one more host chip"
  fi
  exit 0
  ;;

answer)
  # One answer, addressed to every question it settles. The planner keeps combining answers into one file
  # with a name of its own - `05-1-2-3.md` - and then nothing finds it: the worker looks for
  # `answers/05-1.md` and `status` goes on reporting the question as open for the rest of the run.
  # Measured 2026-08-31: four questions answered, all four still listed as unanswered an hour later.
  shift 2
  [ $# -gt 0 ] || { echo "usage: fleet.sh answer <run-dir> <question-id> [question-id...]" >&2; exit 2; }
  mkdir -p "$run/answers"
  tmp=$(mktemp); cat > "$tmp"
  [ -s "$tmp" ] || { rm -f "$tmp"; echo "refusing to write an empty answer" >&2; exit 2; }
  for id in "$@"; do
    id=${id%.md}
    [ -e "$run/ask/$id.md" ] || echo "warning: no question $id.md in ask/" >&2
    cp "$tmp" "$run/answers/$id.md"
    echo "ANSWERED $id"
  done
  rm -f "$tmp"
  ;;

broadcast)
  # Something every worker must read, rather than an answer to one of them. Workers read it at each task
  # boundary, so it is the cheapest way to stop five chats rediscovering the same broken tool.
  mkdir -p "$run/answers"
  cat >> "$run/answers/00-broadcast.md"
  echo "BROADCAST appended to $run/answers/00-broadcast.md"
  ;;

status)
  echo "== claims"
  for d in "$run"/tasks/claimed/*/; do
    [ -d "$d" ] || continue
    id=$(basename "$d")
    [ -e "$run/tasks/done/$id" ] && continue
    o=$(head -1 "$d/owner" 2>/dev/null || echo "NO OWNER")
    hb=$(cat "$d/heartbeat" 2>/dev/null || echo "none")
    cl=$(sed -n 's/^claimed //p' "$d/owner" 2>/dev/null || echo "?")
    flag=""; [ "$hb" = "$cl" ] && flag=" NEVER-BEAT"
    echo "  $id  $o  claimed $cl  beat $hb$flag"
  done
  echo "== markers"
  ls "$run"/*.done "$run"/*.blocked "$run"/*.waiting 2>/dev/null | sed 's|.*/|  |' || echo "  none"
  echo "== questions without answers"
  bc="$run/answers/00-broadcast.md"
  for q in "$run"/ask/*.md; do
    [ -e "$q" ] || continue
    b=$(basename "$q")
    [ -e "$run/answers/$b" ] && continue
    # A broadcast written after the question may already have settled it, and the planner will not
    # remember which. Say so rather than reporting a closed question as open for the rest of the run.
    if [ -e "$bc" ] && [ "$bc" -nt "$q" ]; then
      echo "  $b  (a broadcast landed after it - answer it by name with 'fleet.sh answer' if it is settled)"
    else
      echo "  $b"
    fi
  done
  ;;

summary)
  # The end banner. A finished chat has to be readable at a glance from the sidebar and from three feet
  # away, so this is the same block for a worker and for the run, generated from disk rather than from
  # anyone's memory of what they did. The trailing JSON line is there so a later script can read it back.
  one=${3:-}
  sev() { grep -c "\"severity\"[[:space:]]*:[[:space:]]*\"$2\"" "$1" 2>/dev/null || true; }
  row() {
    c=$1; f=$run/$c.jsonl
    n=0; [ -e "$f" ] && n=$(grep -c . "$f" 2>/dev/null || echo 0)
    b=$(sev "$f" blocker); m=$(sev "$f" major); mi=$(sev "$f" minor); po=$(sev "$f" polish)
    u=$(grep -c '"unreached"' "$f" 2>/dev/null || true)
    t=0; for o in "$run"/tasks/claimed/*/owner; do
      [ -e "$o" ] || continue; id=$(basename "$(dirname "$o")")
      if grep -q "chip $c\$" "$o" 2>/dev/null && [ -e "$run/tasks/done/$id" ]; then t=$((t + 1)); fi
    done
    st=running
    if [ -e "$run/$c.done" ]; then st=done; fi
    if [ -e "$run/$c.blocked" ]; then st=BLIND; fi
    if [ -e "$run/$c.waiting" ]; then st=WAITING; fi
    printf '  %-4s %-8s tasks %-3s findings %-4s  blocker %-3s major %-3s minor %-3s polish %-3s unreached %s\n' \
      "$c" "$st" "$t" "$n" "$b" "$m" "$mi" "$po" "$u"
  }
  echo "=============================================================="
  if [ -n "$one" ]; then
    echo " WORKER $one FINISHED - $(basename "$run")"
    echo "=============================================================="
    row "$one"
    if [ -e "$run/$one.blocked" ]; then echo "  blind: $(head -1 "$run/$one.blocked")"; fi
    echo "  findings: $run/$one.jsonl     notes: $run/$one.notes.md"
  else
    echo " RUN FINISHED - $(basename "$run")"
    echo "=============================================================="
    for f in "$run"/*.jsonl; do
      [ -e "$f" ] || continue
      c=$(basename "$f" .jsonl); case "$c" in backlog|skipped|unreached) continue;; esac
      row "$c"
    done
    echo "--------------------------------------------------------------"
    tot=$(cat "$run"/[0-9]*.jsonl 2>/dev/null | grep -c '"severity"' || true)
    tb=$(cat "$run"/[0-9]*.jsonl 2>/dev/null | grep -c '"severity"[[:space:]]*:[[:space:]]*"blocker"' || true)
    tm=$(cat "$run"/[0-9]*.jsonl 2>/dev/null | grep -c '"severity"[[:space:]]*:[[:space:]]*"major"' || true)
    dn=$(ls "$run"/*.done 2>/dev/null | wc -l | tr -d ' ')
    bl=$(ls "$run"/*.blocked 2>/dev/null | wc -l | tr -d ' ')
    wt=$(ls "$run"/*.waiting 2>/dev/null | wc -l | tr -d ' ')
    rd=$(ls "$run"/tasks/ready/*.md 2>/dev/null | wc -l | tr -d ' ')
    td=$(ls "$run"/tasks/done 2>/dev/null | wc -l | tr -d ' ')
    echo "  workers done $dn, blind $bl, waiting on the operator $wt"
    echo "  tasks $td of $rd finished, findings $tot, blockers $tb, majors $tm"
    echo "  backlog: $run/backlog.md"
    printf 'fleet-summary: {"run":"%s","workers_done":%s,"blind":%s,"waiting":%s,"tasks_done":%s,"tasks_total":%s,"findings":%s,"blockers":%s,"majors":%s}\n' \
      "$(basename "$run")" "$dn" "$bl" "$wt" "$td" "$rd" "$tot" "$tb" "$tm"
  fi
  echo "=============================================================="
  ;;

landed)
  want=${3:?expected chip count required}
  fail=0
  have=$(ls "$run"/*.done "$run"/*.blocked 2>/dev/null | wc -l | tr -d ' ')
  [ "$have" -ge "$want" ] || { echo "NOT LANDED: $have of $want workers finished"; fail=1; }
  for d in "$run"/tasks/claimed/*/; do
    [ -d "$d" ] || continue; id=$(basename "$d")
    # A claim the planner took back is renamed rather than deleted, so the graveyard entry keeps its
    # evidence and a slow worker's late write lands somewhere harmless. Those are closed, not open.
    case "$id" in *.dead-*|*.released-*) continue;; esac
    [ -e "$run/tasks/done/$id" ] || { echo "NOT LANDED: claim without a done marker: $id"; fail=1; }
  done
  for f in "$run"/tasks/ready/*.md; do
    [ -e "$f" ] || continue; id=$(basename "$f" .md)
    [ -d "$run/tasks/claimed/$id" ] || { echo "NOT LANDED: task nobody ever claimed: $id"; fail=1; }
  done
  [ -s "$run/backlog.jsonl" ] || { echo "NOT LANDED: backlog.jsonl is missing or empty"; fail=1; }
  if ls "$run"/*.waiting >/dev/null 2>&1; then echo "NOT LANDED: a worker is waiting on the operator"; fail=1; fi
  if [ -e "$run/tasks/queue-open" ]; then echo "NOT LANDED: the planner has not closed the queue"; fail=1; fi
  if [ "$fail" = 0 ]; then
    # The run ends by declaration, not by a count somebody read once. This file is the durable answer to
    # "did it finish", readable from any chat and after every notification has been missed.
    printf 'finished %s\nworkers %s\n' "$(now)" "$have" > "$run/FINISHED"
    echo "LANDED: $have workers, every claim closed, backlog written, FINISHED written"
  fi
  exit "$fail"
  ;;

merge|render|fixqueue)
  m=$(ls -t "$(dirname "$0")/fleet-merge.mjs" ~/.claude/plugins/cache/*/makarasty/*/scripts/fleet-merge.mjs 2>/dev/null | head -1)
  [ -n "$m" ] || { echo "fleet-merge.mjs not found beside fleet.sh" >&2; exit 2; }
  exec node "$m" "$cmd" "$run"
  ;;

*)
  echo "unknown command: $cmd" >&2; exit 2 ;;
esac
