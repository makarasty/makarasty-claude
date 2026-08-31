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
#   fleet.sh ask     <run-dir> <chip>              worker: read a question on stdin, file it, print the path
#   fleet.sh answer  <run-dir> <id> [id...]        planner: one answer on stdin, filed under every id it settles
#   fleet.sh broadcast <run-dir>                   planner: append something every worker reads at its next boundary
#   fleet.sh drained <run-dir> <chip>              queue empty: write <chip>.done. exit 5 = queue still open
#   fleet.sh status  <run-dir>                     planner view: claims, ages, markers, questions
#   fleet.sh sweep   <run-dir> [--release]         claims nobody is advancing; --release moves claim and
#                                                  task aside so the planner re-files under a new id
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

# Sorting, matching and character classes change under a non-C locale, and a run directory is compared
# across machines. Pin it rather than inherit whatever the operator's shell has.
LC_ALL=C
export LC_ALL

# A bare `mktemp` is not portable between GNU and BSD, and the template keeps the file recognisable when
# something goes wrong mid-run.
tmpfile() { mktemp "${TMPDIR:-/tmp}/fleet.XXXXXX"; }

# `date -r FILE` reads a file's mtime on GNU and reinterprets the argument as epoch seconds on BSD, so the
# same line returns a plausible wrong number on macOS. Ask node, which this script already needs.
mtime() {
  if command -v node >/dev/null 2>&1; then
    node -e 'try{process.stdout.write(String(Math.floor(require("fs").statSync(process.argv[1]).mtimeMs/1000)))}catch{}' "$1" 2>/dev/null
  fi
}

cmd=${1:-}; run=${2:-}
[ -n "$cmd" ] && [ -n "$run" ] || { echo "usage: fleet.sh <command> <run-dir> [args]" >&2; exit 2; }
[ -d "$run" ] || { echo "no such run directory: $run" >&2; exit 2; }
now() { date -Iseconds 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ; }

# The on-disk run layout is the thing this tool promises to keep working. Stamp its major version into the
# run at the first write, so a reader a year from now can refuse a shape it does not know instead of
# quietly misreading it. The schema has already had one breaking rename (`what` -> `observed`); the next
# one should not be silent.
RUN_FORMAT=1

# Constants live in calibration.json, never in a script and never in prose: a number that a planner reads
# and a script reads must have one spelling. Falls back to the built-in default when node or the file is
# absent, so nothing here depends on it existing.
cal() { # cal <key> <default>
  _c=$(ls -t "$(dirname "$0")/../calibration.json" ~/.claude/plugins/cache/*/makarasty/*/calibration.json 2>/dev/null | head -1)
  if [ -n "$_c" ] && command -v node >/dev/null 2>&1; then
    _v=$(node -e 'try{const o=require(process.argv[1]);const v=o[process.argv[2]];if(typeof v==="number")console.log(v)}catch{}' "$_c" "$1" 2>/dev/null)
    [ -n "$_v" ] && { echo "$_v"; return; }
  fi
  echo "$2"
}
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
      # Who this session is, so the Stop hook can tell a worker holding an open claim from any other
      # chat on the machine. The harness exports the id; without it the hook simply never fires.
      if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
        mkdir -p "$run/chips" && printf '%s' "$chip" > "$run/chips/$CLAUDE_CODE_SESSION_ID" || true
      fi
      printf '%s\n' "$t" > "$run/tasks/claimed/$id/heartbeat"
      b=$(sed -n 's/^budget:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$f" | head -1)
      [ -n "$b" ] || b=25
      echo "CLAIMED $id"
      echo "LANE ${lane:-any}"
      echo "BUDGET_MIN $b"
      echo "ABORT_AFTER_SEC $(( b * $(cal budget_multiplier 2) * 60 ))"
      echo "ARM_CLOCK background what this prints: sh \"$0\" clock $run $chip $id $b"
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
  mult=$(cal budget_multiplier 2); poll=$(cal clock_poll_seconds 30)
  rounds=$(( mins * mult * 60 / poll ))
  printf 'i=0; while [ $i -lt %s ]; do sleep '"$poll"'; i=$((i+1)); [ -e "%s/tasks/done/%s" ] && exit 0; [ -e "%s/%s.done" ] && exit 0; done; echo budget-elapsed-%s\n' \
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
  per=$(cal repo_tasks_per_worker 3)
  want=$(( (ready + per - 1) / per ))
  [ "$want" -lt 1 ] && want=1
  cap=""
  loader=$(ls -t "$(dirname "$0")/fleet-load.mjs" ~/.claude/plugins/cache/*/makarasty/*/scripts/fleet-load.mjs 2>/dev/null | head -1)
  if [ -n "$loader" ] && command -v node >/dev/null 2>&1; then
    reserve=$(cal operator_reserve_gb 2); ceil=$(cal repo_worker_ceiling 12)
    cap=$(node "$loader" --json 2>/dev/null | RESERVE_GB="$reserve" CEIL_N="$ceil" node -e 'const RESERVE=+process.env.RESERVE_GB||2, CEIL=+process.env.CEIL_N||12; let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const byRam=Math.floor(o.freeGB-RESERVE);console.log(Math.max(1,Math.min(byRam,CEIL)));}catch{console.log("")}})')
  fi
  [ -n "$cap" ] || cap=6
  n=$want; [ "$n" -gt "$cap" ] && n=$cap
  echo "REPO_WORKERS $n"
  echo "  ready repo tasks $ready, one worker per three -> $want"
  echo "  machine cap $cap (free memory less the ${reserve:-2} GB the operator keeps, ceiling ${ceil:-12})"
  echo "  the pane lane is a display question and starts at $(cal pane_workers_default 2); the verify lane is 1"
  echo "  every constant above comes from calibration.json"
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
  # A claim that is gone was released or reclaimed while this worker was busy, and the work behind it was
  # never checked. Closing the task here would let `landed` pass over it, so refuse exactly as `beat` does.
  if [ ! -d "$d" ]; then
    echo "CLAIM LOST $id, done marker NOT written"; exit 4
  fi
  if ! grep -q "chip $chip\$" "$d/owner" 2>/dev/null; then
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
  tmp=$(tmpfile); cat > "$tmp"
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
  n=0; [ -e "$run/$chip.jsonl" ] && n=$(grep -c '"severity"' "$run/$chip.jsonl" 2>/dev/null || true)
  [ -n "$n" ] || n=0
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
  gate_min=$(cal frame_gate_min_fps 60)
  claimed_at=$(sed -n 's/^claimed //p' "$run/pane/running/$id/owner" 2>/dev/null | head -1)
  tmp=$(tmpfile); cat > "$tmp"
  if command -v node >/dev/null 2>&1; then
    GATE_MIN="$gate_min" CLAIMED_AT="$claimed_at" node -e '
      const fs=require("fs");
      let o; try { o = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }
      catch (e) { console.error("REFUSED: not one JSON object: "+e.message); process.exit(1); }
      const p=[];
      // The requester never saw the pane, so the result has to carry the proof the pane was real. This is
      // the one thing a session driving its own pane could never check about itself.
      const floor = Number(process.env.GATE_MIN || 60);
      if (typeof o.gate !== "number") p.push("gate: the frame count this walk was measured under, as a number");
      else if (o.gate < floor) p.push("gate reads "+o.gate+", which is blind below "+floor+": do not serve a blind walk");
      if (!o.conditions || !/\d/.test(String(o.conditions))) p.push("conditions naming viewport and zoom");
      if (!Array.isArray(o.observations)) p.push("observations: an array, empty is a real answer");
      if (p.length) { console.error("REFUSED: "+p.join("; ")); process.exit(1); }
      o.served_at = new Date().toISOString(); o.host = process.argv[2];
      // The claim time travels into the result because the claim directory is about to be deleted, and
      // without it nobody can say afterwards how long a walk actually took.
      if (process.env.CLAIMED_AT) o.claimed_at = process.env.CLAIMED_AT;
      process.stdout.write(JSON.stringify(o)+"\n");
    ' "$tmp" "$host" > "$run/pane/results/$id.json" || { rm -f "$tmp" "$run/pane/results/$id.json"; exit 1; }
  else
    echo "warning: node absent, this walk is served WITHOUT its gate reading being checked" >&2
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
    t=$(mtime "$f"); [ -n "$t" ] || t=$nowsec
    age=$(( (nowsec - t) / 60 )); [ "$age" -gt "$oldest" ] && oldest=$age
  done
  served=$(ls "$run"/pane/results/*.json 2>/dev/null | wc -l | tr -d ' ')
  median=""
  if command -v node >/dev/null 2>&1; then
    median=$(node -e '
      const fs=require("fs"), path=require("path"), d=process.argv[1];
      let mins=[];
      try { for (const f of fs.readdirSync(d)) {
        if (!f.endsWith(".json")) continue;
        const o=JSON.parse(fs.readFileSync(path.join(d,f),"utf8"));
        if (o.claimed_at && o.served_at) {
          const m=(Date.parse(o.served_at)-Date.parse(o.claimed_at))/60000;
          if (Number.isFinite(m) && m >= 0) mins.push(m);
        }
      } } catch {}
      if (mins.length) { mins.sort((a,b)=>a-b); process.stdout.write(String(Math.round(mins[Math.floor(mins.length/2)]))); }
    ' "$run/pane/results" 2>/dev/null)
  fi
  echo "pane walks: $pend pending, oldest waiting ${oldest}m, $served served${median:+, median lease ${median}m}"
  # One host is enough until a walk waits longer than a walk takes. Falls back to a flat twenty minutes
  # only while no walk has been served yet and there is no lease to compare against.
  behind=$median; [ -n "$behind" ] || behind=20
  if [ "$pend" -gt 0 ] && [ "$oldest" -gt "$behind" ]; then
    echo "  the pane lane is behind: the oldest walk has waited longer than a lease takes. Offer one more host chip"
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
  tmp=$(tmpfile); cat > "$tmp"
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

sweep)
  # Abandoned claims. A worker that dies holding a task leaves a claim directory that no atomic primitive
  # will ever clean up - the maildir lesson: `tmp/` needs a sweeper or it accumulates forever. This is the
  # planner's tool and it is deliberately conservative: it names candidates, and only releases them when
  # told to, because the three-term dead test exists for a reason.
  #
  #   fleet.sh sweep <run-dir>            list claims that look abandoned
  #   fleet.sh sweep <run-dir> --release  rename them aside so the task can be re-filed
  release=""
  [ "${3:-}" = "--release" ] && release=1
  nowsec=$(date +%s 2>/dev/null || echo 0)
  found=0
  for d in "$run"/tasks/claimed/*/; do
    [ -d "$d" ] || continue
    id=$(basename "$d")
    case "$id" in *.dead-*|*.released-*) continue;; esac
    [ -e "$run/tasks/done/$id" ] && continue
    owner=$(head -1 "$d/owner" 2>/dev/null || echo "NO OWNER")
    hb=$(mtime "$d/heartbeat"); [ -n "$hb" ] || hb=$(mtime "$d/owner")
    age=0; [ -n "$hb" ] && [ "$nowsec" -gt 0 ] && age=$(( (nowsec - hb) / 60 ))
    budget=$(sed -n 's/^budget:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$run/tasks/ready/$id.md" 2>/dev/null | head -1)
    [ -n "$budget" ] || budget=25
    # All three terms, as PULL.md requires: no done marker, nothing written for longer than one budget,
    # and the claim still standing. Anything younger is a worker doing slow work.
    if [ "$age" -gt "$budget" ]; then
      found=$((found + 1))
      echo "ABANDONED? $id  $owner  quiet ${age}m against a ${budget}m budget"
      if [ -n "$release" ]; then
        stampsuffix=$(date +%Y%m%dT%H%M%S 2>/dev/null || echo swept)
        mv "$d" "$run/tasks/claimed/$id.released-$stampsuffix"
        # The ready file leaves the queue with the claim. Leaving it would hand the same id straight back
        # to the next `next`, and a slow worker's late write would then land on live work rather than in
        # the graveyard - which is the whole reason a reclaimed task returns under a new id.
        if [ -e "$run/tasks/ready/$id.md" ]; then
          mkdir -p "$run/tasks/released"
          mv "$run/tasks/ready/$id.md" "$run/tasks/released/$id.md"
        fi
        echo "  released; the task file is in tasks/released/ - re-file it under a NEW id, never this one"
      fi
    fi
  done
  [ "$found" = 0 ] && echo "no abandoned claims"
  [ -n "$release" ] || { [ "$found" = 0 ] || echo "Nothing was changed. Add --release once you have checked the workers are really gone."; }
  ;;

status)
  # How long this run has been going, against the ceiling in calibration.json. Comparable tools have
  # documented runs that looped for days; a fleet has no way to stop itself, so the least it can do is say
  # when continuing has become a decision rather than a default.
  maxmin=$(cal max_run_minutes 480)
  first=""
  for f in "$run"/RUN_FORMAT "$run"/tasks/ready/*.md; do
    [ -e "$f" ] || continue; first=$(mtime "$f"); [ -n "$first" ] && break
  done
  if [ -n "$first" ]; then
    nowsec=$(date +%s 2>/dev/null || echo 0)
    if [ "$nowsec" -gt 0 ]; then
      runmin=$(( (nowsec - first) / 60 ))
      echo "== run age ${runmin}m of a ${maxmin}m ceiling"
      [ "$runmin" -gt "$maxmin" ] && echo "  PAST THE CEILING: continuing is a decision now. Land what exists or raise it in calibration.json."
    fi
  fi
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
    n=0; [ -e "$f" ] && n=$(grep -c . "$f" 2>/dev/null || true)
    [ -n "$n" ] || n=0
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
    # A claim that was released or declared dead still proves somebody took the task; what it does not
    # prove is that the work happened, which is why the planner re-files it under a new id.
    taken=""
    [ -d "$run/tasks/claimed/$id" ] && taken=1
    for g in "$run"/tasks/claimed/"$id".released-* "$run"/tasks/claimed/"$id".dead-*; do
      [ -d "$g" ] && taken=1
    done
    [ -n "$taken" ] || { echo "NOT LANDED: task nobody ever claimed: $id"; fail=1; }
  done
  # A task the sweep released left the queue, so the loop above cannot see it. It is still work somebody
  # started and nobody finished: either the planner re-filed it under a new id, in which case delete the
  # released file, or the run is landing over abandoned work.
  for f in "$run"/tasks/released/*.md; do
    [ -e "$f" ] || continue; id=$(basename "$f" .md)
    echo "NOT LANDED: $id was released and never accounted for. Either re-file its work under a NEW id"
    echo "            and delete tasks/released/$id.md, or delete that file alone to write the task off."
    fail=1
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
