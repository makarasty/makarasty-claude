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
#   fleet.sh next    <run-dir> <chip> [lane]       claim the first free task in that lane, print it. exit 3 =
#                                                  drained, or waiting on an `after:` dependency (it says which)
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
#   fleet.sh recover <run-dir> [--release]         cold start after a crash: which chips reopen with
#                                                  `claude -r`, which must be respawned, what is unheld
#   fleet.sh width   <run-dir>                     how many repo workers this queue and this machine want
#   fleet.sh pane-ask   <run-dir> <chip>           file a browser walk for a pane host to run, on stdin
#   fleet.sh pane-next  <run-dir> <host>           claim the oldest pending walk. exit 3 = none pending
#   fleet.sh pane-serve <run-dir> <host> <id>      answer one walk with JSON on stdin, gate reading included
#   fleet.sh pane-status <run-dir>                 backlog depth, oldest wait, median lease
#   fleet.sh summary <run-dir> [chip]              the end banner: counts from disk, plus one JSON line
#   fleet.sh worktree <run-dir> <chip> [path]      a worktree worker registers its tree (default cwd)
#   fleet.sh unlink  <worktree-path>               unlink every junction/symlink in it, targets untouched
#   fleet.sh clean   <run-dir> [--remove]          remove THIS run's worktrees safely; dry run without --remove
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

# WHY THIS EXISTS, before what it does - because the reason is what makes the rule survive an edit:
#
# A path is almost never got wrong in the middle. It is got wrong at the END, and always the same way: a
# variable that was empty, a `dirname` taken once too often, a split on the wrong character, a prefix
# stripped twice. Every one of those turns a path into its own PARENT. So the depth of a path is exactly
# its margin for error, counted in mistakes:
#
#   C:/wtmerge                        one slip from C:/ - the whole drive
#   <project>/.claude/worktrees/wtA   seven slips from C:/, and the first four land in directories this
#                                     plugin owns and would refuse
#
# A worktree at the root of a drive has no margin at all. Nothing about it is wrong today; it becomes
# wrong the first time somebody edits the deletion code and is slightly careless, and by then it takes the
# disk with it. Depth is the cheapest defence there is against a mistake nobody has made yet.
#
# Therefore: this plugin deletes nothing that is not absolute, deep, free of `..`, inside a directory it
# owns, and outside its own working directory.
#
# Callers set MIN_PATH_SEGMENTS once with `min_floor` before their loop, because `unsafe_path` usually
# runs inside a command substitution and a value cached inside it would not survive the subshell.
min_floor() {
  _m=$(cal min_path_segments 4)
  # A floor that is not a whole number silently disables the comparison: `[ 3 -lt 2.5 ]` errors out
  # rather than answering, so a malformed calibration file would remove the guard instead of tightening it.
  case ${_m:-} in ''|*[!0-9]*) _m=4 ;; esac
  [ "$_m" -lt 2 ] && _m=2
  echo "$_m"
}

unsafe_path() { # unsafe_path <path> <required-segment>; prints the reason and returns 0 when UNSAFE
  _p=${1:-}; _need=${2:-}
  [ -n "$_p" ] || { echo "the path is empty"; return 0; }
  _p=${_p%/}   # a trailing slash must not change any answer below
  case "$_p" in
    //*) echo "$_p is a network path, which this does not delete"; return 0 ;;
    /*|[A-Za-z]:/*) ;;
    *) echo "$_p is not absolute, so what it points at depends on where this ran"; return 0 ;;
  esac
  case "/$_p/" in
    */../*) echo "$_p contains .., so where it lands cannot be read off the path"; return 0 ;;
    */./*)  echo "$_p contains a . segment, which hides how deep it really is"; return 0 ;;
  esac
  # Count named components with any drive letter dropped first, so Windows and POSIX are measured on one
  # scale: C:/a/b/c and /a/b/c are both three.
  _bare=${_p#[A-Za-z]:}
  _depth=$(printf '%s\n' "$_bare" | tr '/' '\n' | grep -c . || true)
  _min=${MIN_PATH_SEGMENTS:-4}
  if [ "${_depth:-0}" -lt "$_min" ]; then
    echo "$_p is ${_depth:-0} level(s) below the root and the floor is $_min: too shallow to delete safely"
    return 0
  fi
  if [ -n "$_need" ]; then
    # Something must FOLLOW the segment: the `worktrees` directory itself is not a worktree, and deleting
    # it would take every other run's trees with it.
    case "/$_p/" in
      *"/$_need/"?*) ;;
      *) echo "$_p is not inside a $_need directory, the only place this may delete"; return 0 ;;
    esac
  fi
  # Deleting the directory this shell is standing in, or one above it, is how a script removes its own
  # footing and then keeps going. Read the working directory in git's own spelling: under Git Bash `pwd`
  # says /c/Users/... while git says C:/Users/..., so the plain form never matched and this guard was
  # inert on the platform it was written for.
  _here=$(pwd -W 2>/dev/null || pwd 2>/dev/null || echo "")
  if [ -n "$_here" ]; then
    _lh=$(printf '%s' "${_here%/}" | tr 'A-Z' 'a-z')
    _lp=$(printf '%s' "$_p" | tr 'A-Z' 'a-z')
    case "$_lh/" in "$_lp"/*) echo "$_p contains this shell's working directory"; return 0 ;; esac
  fi
  return 1
}

# Unlink every reparse point inside a tree, at any depth, leaving what they point at alone. This is the
# step that makes a later recursive delete safe: `git worktree remove` follows a junction and removes the
# target's contents, at the top level and nested [M32]. `find -type l` sees junctions on Windows and does
# not descend into them.
unlink_links() { # unlink_links <dir>; prints how many it removed
  _d=$1; _t=$(tmpfile); _n=0
  find "$_d" -type l -print > "$_t" 2>/dev/null || true
  while IFS= read -r _e; do
    [ -n "$_e" ] || continue
    rm "$_e" 2>/dev/null || true
    # Windows: coreutils sometimes will not drop a junction. `rmdir` removes the link, never its target.
    if [ -e "$_e" ] && command -v cmd >/dev/null 2>&1; then
      _dd=$(dirname "$_e"); _bb=$(basename "$_e")
      ( cd "$_dd" && MSYS_NO_PATHCONV=1 cmd //c "rmdir \"$_bb\"" >/dev/null 2>&1 ) || true
    fi
    _n=$((_n + 1))
  done < "$_t"
  rm -f "$_t"
  echo "$_n"
}

case "$cmd" in

next)
  chip=${3:?chip id required}
  lane=${4:-}
  waiting=0
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
    # A task can wait for another to finish: `after: task-02-primitives` in the frontmatter, one id or
    # several separated by spaces or commas. The queue is the only place a wave order can be enforced
    # without asking anybody to remember it, and a mission with waves - `kind: design` is the one this was
    # written for - is otherwise a rule in prose, which this repository has watched fail before. A worker
    # that claims a screen while the shared primitives are still being restyled either collides with that
    # work or inherits a defect it is not allowed to fix.
    deps=$(sed -n 's/^after:[[:space:]]*\(.*\)/\1/p' "$f" | head -1 | tr ',' ' ')
    if [ -n "$deps" ]; then
      blocked=""
      for d in $deps; do
        [ -n "$d" ] || continue
        [ -e "$run/tasks/done/$d" ] || blocked=1
      done
      if [ -n "$blocked" ]; then
        waiting=$((waiting + 1))
        continue
      fi
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
      # Each task worked inline leaves 20-30 k of context behind it, and four workers who never spawned a
      # subagent were all compacted near their thirtieth task [M30]. Past the first few, a task belongs in
      # its own subagent. Said here, on a path every worker walks, because the same rule in prose was
      # obeyed zero times in 184 claims.
      need=$(sed -n 's/^needs:[[:space:]]*\([a-z][a-z]*\).*/\1/p' "$f" | head -1)
      if [ "${need:-repo}" != pane ]; then
        dn=0
        for o in "$run"/tasks/claimed/*/owner; do
          [ -e "$o" ] || continue
          if grep -q "^chip $chip\$" "$o" 2>/dev/null && [ -e "$run/tasks/done/$(basename "$(dirname "$o")")" ]; then dn=$((dn + 1)); fi
        done
        if [ "$dn" -ge "$(cal delegate_past_tasks 3)" ]; then
          echo "DELEGATE: you have finished $dn tasks in this session and each left 20-30 k of context behind [M30]."
          echo "  Hand this task to ONE subagent at the task's model - task file, RULES.md, your notes - with findings filed through find. Keep your own context flat."
        fi
      fi
      echo "ARM_CLOCK background what this prints: sh \"$0\" clock $run $chip $id $b"
      echo "---"
      cat "$f"
      exit 0
    fi
  done
  # "Drained" and "waiting on a wave that has not landed" are different states, and a worker told the
  # first when the second is true writes its `.done` and ends a session that still had work coming.
  if [ "$waiting" -gt 0 ]; then
    echo "QUEUE WAITING${lane:+ for lane $lane}: $waiting task(s) held by an unfinished \`after:\` dependency"
    echo "  Poll rather than finishing: this queue opens again when those tasks land."
    exit 3
  fi
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
  behind=$median
  if [ -z "$behind" ]; then
    behind=20
    [ "$pend" -gt 0 ] && echo "  no walk has been served yet, so this compares against a flat 20 minutes"
  fi
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

recover)
  # A cold start, after the machine died rather than after a worker stalled.
  #
  # `sweep` and the revive message both assume the sessions are still there: one names a claim nobody is
  # advancing, the other pokes the chat holding it. Neither survives a power cut, because a message needs a
  # live receiver and after a reboot there are none. Measured 2026-09-01: 26 worker sessions of two runs
  # were gone from `ListAgents` (five unrelated chats, started minutes earlier) and from the app's own
  # session list (twenty rows, not one of them a fleet chip) - so a planner asked to bring the run back
  # correctly answered that it could not, and the operator was left choosing between a fresh run and
  # walking the queue by hand.
  #
  # What did survive is on disk and is enough: `chips/<session-id>` was written at the first claim, the
  # claims are still standing, and Claude Code keeps every session's transcript under
  # ~/.claude/projects/<slug>/<session-id>.jsonl. A session with a transcript can be reopened with its
  # context intact (`claude -r <session-id>`), which is worth far more than a fresh chip on the same task.
  #
  # So this prints three lists and nothing else, unless asked:
  #   RESUME   the worker has a transcript and unfinished business - reopen it, do not respawn it
  #   RESPAWN  no transcript, or it landed nothing - the task goes back in the queue under a new id
  #   LANDED   done or blocked, no open claim - leave it alone
  #
  #   fleet.sh recover <run-dir>            report only
  #   fleet.sh recover <run-dir> --release  also release the claims of chips that cannot be resumed
  release=""
  [ "${3:-}" = "--release" ] && release=1
  nowsec=$(date +%s 2>/dev/null || echo 0)
  # The host lets an operator move its whole configuration directory, transcripts included. Reading only
  # `$HOME/.claude` on such a machine reports every chip as RESPAWN, and `--release` would then free every
  # open claim including live workers' - the one destructive path here, driven by an absence that means
  # nothing. Honour the host's own variable, and keep the plugin-private one as the override.
  proj=${CLAUDE_PROJECTS_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects}

  # Where a chip's transcript lives. The project directory is the working directory with every separator
  # replaced, and one run can span worktrees, so search rather than reconstruct the slug.
  transcript() { # transcript <session-id>
    ls "$proj"/*/"$1".jsonl 2>/dev/null | head -1
  }

  # The directory a session was started in, read from its own first line. A worker in a worktree has a
  # different one from the planner, and reopening a session from the wrong directory either refuses on an
  # older CLI or resumes against the wrong tree.
  # Not line 1: the first record is often a queued prompt, which carries no `cwd`. Read the first few and
  # take the first one that has it.
  sessioncwd() { # sessioncwd <transcript-path>
    head -20 "$1" 2>/dev/null | sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p' | head -1 | sed 's/\\\\/\\/g'
  }

  # A transcript corpus that holds nothing is not evidence that the workers are gone; it is evidence that
  # this is not the machine, or not the directory, that ran them.
  havecorpus=""
  ls "$proj"/*/*.jsonl >/dev/null 2>&1 && havecorpus=1
  if [ -z "$havecorpus" ]; then
    echo "== no session transcripts under $proj"
    echo "  Every chip below will read as RESPAWN, and that is this command's blindness rather than a fact"
    echo "  about the workers. Set CLAUDE_CONFIG_DIR or CLAUDE_PROJECTS_DIR if they live elsewhere."
    if [ -n "$release" ]; then
      echo "REFUSED: --release with no transcripts to judge by would free live workers' claims." >&2
      echo "  Use 'fleet.sh sweep --release', which asks the heartbeat question instead." >&2
      exit 2
    fi
  fi
  livemin=$(cal hook_claim_window_minutes 10)

  # A run that already declared itself finished is not automatically nothing to do: `landed` counts markers
  # and a worker that died before writing one is invisible to that count. Say both facts rather than either.
  if [ -e "$run/FINISHED" ]; then
    echo "== this run declared itself finished"
    sed 's/^/  /' "$run/FINISHED"
    echo "  Anything listed as RESUME or RESPAWN below was open when that was written."
  fi

  echo "== chips this run registered"
  any=0
  for f in "$run"/chips/*; do
    [ -e "$f" ] || continue
    sid=$(basename "$f")
    # `<session>.warned-<task>` is the Stop hook's own bookkeeping, not a chip.
    case "$sid" in *.warned-*) continue;; esac
    chip=$(cat "$f" 2>/dev/null | tr -d ' \n')
    [ -n "$chip" ] || continue
    any=$((any + 1))

    marker=""
    [ -e "$run/$chip.done" ] && marker="done"
    [ -e "$run/$chip.blocked" ] && marker="${marker:+$marker+}blocked"
    [ -e "$run/$chip.waiting" ] && marker="${marker:+$marker+}waiting"

    # Claims this chip is still holding. A released or dead claim is already accounted for.
    open=""
    for d in "$run"/tasks/claimed/*/; do
      [ -d "$d" ] || continue
      id=$(basename "$d")
      case "$id" in *.dead-*|*.released-*) continue;; esac
      [ -e "$run/tasks/done/$id" ] && continue
      grep -q "chip $chip\$" "$d/owner" 2>/dev/null && open="${open:+$open }$id"
    done

    t=$(transcript "$sid")
    quiet=""
    if [ -n "$t" ] && [ "$nowsec" -gt 0 ]; then
      m=$(mtime "$t"); [ -n "$m" ] && quiet=$(( (nowsec - m) / 60 ))
    fi
    findings=0
    [ -e "$run/$chip.jsonl" ] && findings=$(grep -c . "$run/$chip.jsonl" 2>/dev/null || echo 0)

    if [ -z "$open" ] && [ -n "$marker" ]; then
      # The session id belongs on this line too. A landed worker is the one whose context a follow-up run
      # wants most - it read the code that produced the findings - and "leave it alone" is advice about
      # this run, not about the next one.
      echo "  LANDED  chip $chip  $marker, $findings findings  ($sid)"
    elif [ -n "$t" ] && [ -n "$quiet" ] && [ "$quiet" -lt "$livemin" ]; then
      # A transcript exists for a session that is still running, too. Reopening one of those puts a second
      # writer on an open file, so say what the evidence actually supports and print no command.
      echo "  LIVE?   chip $chip  ${marker:-no marker}, $findings findings, holding: ${open:-nothing}, written ${quiet}m ago"
      echo "          Wrote to its transcript inside the last ${livemin}m, so it may still be alive. Message it, or wait."
    elif [ -n "$t" ]; then
      echo "  RESUME  chip $chip  ${marker:-no marker}, $findings findings, holding: ${open:-nothing}${quiet:+, quiet ${quiet}m}"
      # The command as the operator needs it: the right directory, and a first instruction, because a
      # session reopened with no prompt sits there until somebody types into it - which is twenty-six
      # sessions of silence in a run this size. The heartbeat is the first thing it should write: that is
      # what turns "I ran the command" into something `fleet.sh status` can see.
      cwd=$(sessioncwd "$t")
      first=$(printf '%s' "$open" | cut -d' ' -f1)
      echo "          ${cwd:+cd \"$cwd\" && }claude -r $sid \"Resumed after a crash. ${first:+Run fleet.sh beat on $first, then }continue the run.\""
      if [ -z "$cwd" ]; then
        echo "          (its working directory is not in the transcript - run this from the directory the chip was started in)"
      fi
    else
      echo "  RESPAWN chip $chip  ${marker:-no marker}, $findings findings, holding: ${open:-nothing}"
      echo "          no transcript under $proj - its context is gone, so re-file the task and spawn a fresh chip"
    fi
  done
  if [ "$any" = 0 ]; then echo "  none: no chip ever claimed through fleet.sh in this run"; fi

  # Work nobody is holding. After a cold start this is what decides how many chips to open, and it is not
  # the same number as the chips that died: a worker usually finished several tasks before the lights went.
  free=0
  for f in "$run"/tasks/ready/*.md; do
    [ -e "$f" ] || continue
    id=$(basename "$f" .md)
    [ -e "$run/tasks/done/$id" ] && continue
    [ -d "$run/tasks/claimed/$id" ] && continue
    free=$((free + 1))
  done
  echo "== queue"
  echo "  $free ready tasks nobody holds"
  if [ -d "$run/tasks/released" ]; then
    echo "  $(ls "$run"/tasks/released/*.md 2>/dev/null | wc -l | tr -d ' ') released tasks waiting to be re-filed under a new id"
  fi

  if [ -n "$release" ]; then
    echo "== releasing claims held by chips that cannot be resumed"
    freed=0; openclaims=0
    for d in "$run"/tasks/claimed/*/; do
      [ -d "$d" ] || continue
      id=$(basename "$d")
      case "$id" in *.dead-*|*.released-*) continue;; esac
      [ -e "$run/tasks/done/$id" ] && continue
      openclaims=$((openclaims + 1))
      # The chip that owns this claim, and whether its session can still be reopened. A resumable worker
      # keeps its claim: taking it away is how a live worker's finished work lands in the graveyard.
      ochip=$(sed -n 's/^chip //p' "$d/owner" 2>/dev/null | head -1)
      keep=""; known=""
      for f in "$run"/chips/*; do
        [ -e "$f" ] || continue
        s=$(basename "$f"); case "$s" in *.warned-*) continue;; esac
        [ "$(cat "$f" 2>/dev/null | tr -d ' \n')" = "$ochip" ] || continue
        known=1
        [ -n "$(transcript "$s")" ] && keep=1
      done
      [ -n "$keep" ] && continue
      # A chip that never registered a session id is not evidence of death, it is evidence of nothing:
      # registration needs CLAUDE_CODE_SESSION_ID, and a claim made without it looks identical to one made
      # by a worker that is alive and working. `sweep` is the instrument for that case, because it asks the
      # three-term question about heartbeats; this command only speaks about sessions it can look up.
      if [ -z "$known" ]; then
        echo "  UNKNOWN $id (chip ${ochip:-unknown}) - no session id was ever registered for that chip, so"
        echo "          this cannot tell a dead worker from a live one. Use 'fleet.sh sweep --release'."
        continue
      fi
      stampsuffix=$(date +%Y%m%dT%H%M%S 2>/dev/null || echo recovered)
      mv "$d" "$run/tasks/claimed/$id.released-$stampsuffix"
      if [ -e "$run/tasks/ready/$id.md" ]; then
        mkdir -p "$run/tasks/released"
        mv "$run/tasks/ready/$id.md" "$run/tasks/released/$id.md"
      fi
      freed=$((freed + 1))
      echo "  released $id (chip ${ochip:-unknown}) - re-file it under a NEW id, never this one"
    done
    if [ "$freed" = 0 ]; then
      if [ "$openclaims" = 0 ]; then
        echo "  nothing to release: no claim is open"
      else
        echo "  nothing to release: all $openclaims open claims belong to chips that can be resumed"
      fi
    fi
  else
    echo "== nothing was changed"
    echo "  Resume what you can first. Add --release once you have reopened the resumable chips, so a"
    echo "  worker that comes back does not find its own task handed to somebody else."
  fi
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
  # Exists, not non-empty: merge writes an empty backlog when the workers filed nothing, and a run that
  # refuted nothing - a call run, a canvas run without a compare stage - has still ended.
  [ -e "$run/backlog.jsonl" ] || { echo "NOT LANDED: backlog.jsonl is missing: run merge first"; fail=1; }
  if ls "$run"/*.waiting >/dev/null 2>&1; then echo "NOT LANDED: a worker is waiting on the operator"; fail=1; fi
  if [ -e "$run/tasks/queue-open" ]; then echo "NOT LANDED: the planner has not closed the queue"; fail=1; fi
  if [ "$fail" = 0 ]; then
    # The run ends by declaration, not by a count somebody read once. This file is the durable answer to
    # "did it finish", readable from any chat and after every notification has been missed.
    first=""; [ -e "$run/FINISHED" ] || first=1
    printf 'finished %s\nworkers %s\n' "$(now)" "$have" > "$run/FINISHED"
    echo "LANDED: $have workers, every claim closed, backlog written, FINISHED written"
    # Then the phone, through the tools plugin's notifier when it is installed: the headline only, never a
    # finding, and only the first time FINISHED is written, so a second landing check does not page twice.
    # FINISHED is already on disk, so a message that never arrives loses nothing.
    nf=$(ls -t "$(dirname "$0")/../tools/hooks/notify.mjs" ~/.claude/plugins/cache/*/makarasty-tools/*/hooks/notify.mjs 2>/dev/null | head -1)
    if [ -n "$first" ] && [ -n "$nf" ]; then
      tot=$(cat "$run"/[0-9]*.jsonl 2>/dev/null | grep -c '"severity"' || true)
      tb=$(cat "$run"/[0-9]*.jsonl 2>/dev/null | grep -c '"severity"[[:space:]]*:[[:space:]]*"blocker"' || true)
      bl=$(ls "$run"/*.blocked 2>/dev/null | wc -l | tr -d ' ')
      node "$nf" send "fleet $(basename "$run") FINISHED: $tot findings, $tb blockers, $bl blind, backlog at $run/backlog.md" || true
    fi
  fi
  exit "$fail"
  ;;

worktree)
  # A worktree worker records its tree at its first claim, so `clean` later acts on THIS run's worktrees
  # and no other run's. Refuse a path that is not under a `.claude/worktrees/` segment: a worker not
  # actually in a worktree has nothing to register, and recording its cwd would point `clean` at the
  # project root. See docs/WORKTREES.md.
  chip=${3:?chip id required}
  wt=${4:-$(pwd)}
  # Store the path in git's own spelling, so `clean` can match it against `git worktree list` exactly.
  # `/tmp/x` and `C:/.../x` are the same tree, and only git's form compares reliably across Git Bash.
  canon=$(git -C "$wt" rev-parse --show-toplevel 2>/dev/null || echo "")
  [ -n "$canon" ] && wt=$canon
  MIN_PATH_SEGMENTS=$(min_floor)
  # Catch a tree that can never be cleaned at the moment it is CREATED rather than at the end of the run,
  # because that is the moment somebody can still move it: a worktree at `C:/wtmerge` is one slip from the
  # drive root, so cleanup will refuse it forever and it accumulates instead.
  if why=$(unsafe_path "$wt" ".claude/worktrees"); then
    echo "REFUSED to register this worktree: $why" >&2
    echo "  A worktree this plugin can clean up lives under <project>/.claude/worktrees/, which is where" >&2
    echo "  the harness's own EnterWorktree puts it. Move it with:  git worktree move \"$wt\" <project>/.claude/worktrees/<name>" >&2
    exit 2
  fi
  br=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  mkdir -p "$run/worktrees"
  printf 'path %s\nbranch %s\nchip %s\n' "$wt" "$br" "$chip" > "$run/worktrees/$chip"
  echo "registered worktree $wt (branch ${br:-unknown}) for chip $chip"
  ;;

unlink)
  # A worker leaving its worktree needs the unlink as a command rather than as a sentence in a document.
  # It is the step most likely to be skipped, and this repository's own ledger says a rule that is only
  # written down does not hold. Safe to run twice and safe to run on a tree with no links.
  # The path is this command's second argument, which every other command spends on the run directory.
  wt=$run
  c=$(git -C "$wt" rev-parse --show-toplevel 2>/dev/null || echo ""); [ -n "$c" ] && wt=$c
  MIN_PATH_SEGMENTS=$(min_floor)
  if why=$(unsafe_path "$wt" ".claude/worktrees"); then
    echo "REFUSED: $why" >&2; exit 2
  fi
  n=$(unlink_links "$wt")
  echo "unlinked $n reparse point(s) under $wt"
  ;;

clean)
  # Remove the worktrees this run created. Dry run unless --remove. The procedure and the measurement
  # behind the unlink-first step are in docs/WORKTREES.md [M32]; the reasoning behind the guards is in
  # docs/SAFETY.md. There is deliberately no flag that deletes a tree holding work: the operator does
  # that in git, having seen the reason printed here.
  do_remove=""
  for a in "$@"; do
    case "$a" in --remove) do_remove=1 ;; esac
  done
  MIN_PATH_SEGMENTS=$(min_floor)
  main=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
  # One listing for the whole command: it is asked once per worktree otherwise, and the pipeline also put
  # the stray scan in a subshell.
  wtlist=$(git worktree list --porcelain 2>/dev/null || echo "")
  # A worktree this run cannot clean is named rather than ignored: it sits there forever and only the
  # operator can move it. Reported before anything else, because a run that registered nothing is exactly
  # the run where a stray would otherwise go unmentioned. Never touched.
  printf '%s\n' "$wtlist" | sed -n 's/^worktree //p' | while IFS= read -r w; do
    [ -n "$w" ] || continue
    [ "$w" = "$main" ] && continue
    if why=$(unsafe_path "$w" ".claude/worktrees"); then
      echo "STRAY $why"
      echo "      nothing here will delete it. Move it under <project>/.claude/worktrees/ with 'git worktree move', or remove it yourself."
    fi
  done
  reg="$run/worktrees"
  if [ ! -d "$reg" ] || [ -z "$(ls -A "$reg" 2>/dev/null)" ]; then
    echo "no worktrees registered for this run; nothing to clean"
    echo "(a worktree worker registers itself with 'fleet.sh worktree $run <chip>'; a run with none is not swept)"
    exit 0
  fi
  removed=0; kept=0
  for entry in "$reg"/*; do
    [ -e "$entry" ] || continue
    wt=$(sed -n 's/^path //p' "$entry" | head -1)
    chip=$(basename "$entry")
    # Normalise to git's own spelling when the tree is still on disk, so the membership test matches
    # whatever form `git worktree list` prints regardless of how the path was registered.
    if [ -e "$wt" ]; then c=$(git -C "$wt" rev-parse --show-toplevel 2>/dev/null || echo ""); [ -n "$c" ] && wt=$c; fi
    # The branch is read from the worktree NOW, never from the registration: a worker that switched
    # branches after registering would otherwise have the wrong branch checked and the wrong one deleted.
    br=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    [ -n "$br" ] || br=$(sed -n 's/^branch //p' "$entry" | head -1)

    # 1. The path gate, before anything reads the tree.
    if why=$(unsafe_path "$wt" ".claude/worktrees"); then
      echo "SKIP  $chip: $why"; kept=$((kept+1)); continue
    fi
    if [ -n "$main" ] && [ "$wt" = "$main" ]; then
      echo "SKIP  $chip: $wt is the main checkout"; kept=$((kept+1)); continue
    fi
    if ! printf '%s\n' "$wtlist" | grep -Fxq "worktree $wt"; then
      if [ -e "$wt" ]; then
        echo "SKIP  $chip: $wt exists but git does not call it a worktree - leaving it for a human"; kept=$((kept+1))
      else
        echo "gone  $chip: $wt already removed"
        [ -n "$do_remove" ] && git worktree prune >/dev/null 2>&1
      fi
      continue
    fi
    # 2. A locked worktree is one git will refuse. Find that out BEFORE unlinking anything, or the unlink
    #    happens, the removal fails, and the tree is left in a worse state than it was found in while the
    #    message claims nothing changed.
    if printf '%s\n' "$wtlist" | awk -v w="worktree $wt" 'BEGIN{f=0} $0==w{f=1;next} /^worktree /{f=0} f&&/^locked/{print;exit}' | grep -q .; then
      echo "SKIP  $chip: $wt is locked. Unlock it with 'git worktree unlock' if you meant to remove it"
      kept=$((kept+1)); continue
    fi
    # 3. Keep anything holding work. Uncommitted changes, or commits that are neither in the main
    #    checkout's branch nor on this branch's upstream.
    dirty=""; unpushed=""
    [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ] && dirty=1
    if [ -z "$br" ] || [ "$br" = "HEAD" ]; then
      # Detached HEAD: the commits belong to no branch, so removing the tree makes them unreachable and
      # `git branch -d` cannot object on their behalf. Nothing here can prove they are safe, so keep.
      unpushed=1; brdesc="a detached HEAD"
    else
      brdesc="$br"
      # The question `git branch -d` asks, answered BEFORE the tree is removed so the whole tree is kept
      # and not merely the branch. Fail safe: anything not provably merged or pushed counts as work.
      merged=""
      mb=""
      if [ -n "$main" ]; then mb=$(git -C "$main" rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""); fi
      # A detached main checkout - mid-rebase, mid-bisect - reports the literal "HEAD", which resolves
      # inside the worktree to the worktree's own tip and would call every branch merged.
      [ "$mb" = "HEAD" ] && mb=""
      if [ -n "$mb" ] && git -C "$wt" merge-base --is-ancestor "$br" "$mb" 2>/dev/null; then merged=1; fi
      if [ -z "$merged" ]; then
        up=$(git -C "$wt" rev-parse --abbrev-ref "$br@{upstream}" 2>/dev/null || echo "")
        if [ -n "$up" ] && git -C "$wt" merge-base --is-ancestor "$br" "$up" 2>/dev/null; then merged=1; fi
      fi
      [ -z "$merged" ] && unpushed=1
    fi
    if [ -n "$dirty" ] || [ -n "$unpushed" ]; then
      why=""
      [ -n "$dirty" ] && why="uncommitted changes"
      [ -n "$unpushed" ] && why="${why:+$why, }commits on $brdesc neither merged nor pushed"
      echo "KEEP  $chip: $wt has $why"
      echo "      it stays. If you have written it off: git worktree remove --force \"$wt\" (after 'fleet.sh unlink' on it), then git branch -D $br"
      kept=$((kept+1)); continue
    fi
    # 4. Ignored files are invisible to every check above and go with the tree. Say what they are, because
    #    a .env or a local config is exactly the thing a person did not mean to lose.
    ign=$(git -C "$wt" status --porcelain --ignored 2>/dev/null | sed -n 's/^!! //p' | head -5 | tr '\n' ' ')
    if [ -z "$do_remove" ]; then
      links=$(find "$wt" -type l 2>/dev/null | wc -l | tr -d ' ')
      echo "would remove  $chip: $wt${br:+  then branch -d $br}"
      [ "${links:-0}" != 0 ] && echo "              unlinks $links reparse point(s) first"
      [ -n "$ign" ] && echo "              ignored files that go with it: $ign"
      continue
    fi
    [ -n "$ign" ] && echo "      ignored files removed with the tree: $ign"
    # 5. Unlink every reparse point, at any depth, before anything recursive runs [M32].
    unlink_links "$wt" >/dev/null
    # 6. Remove the worktree. No --force: a tree holding work was kept above, so a refusal here is
    #    something this code did not anticipate and the tree stays as it is.
    if git worktree remove "$wt" 2>/dev/null; then
      git worktree prune >/dev/null 2>&1
      # 7. The branch, by the merge-checking form only. -D is never used here.
      if [ -n "$br" ] && [ "$br" != "HEAD" ]; then
        if git branch -d "$br" >/dev/null 2>&1; then
          echo "removed  $chip: $wt and branch $br"
        else
          echo "removed  $chip: $wt (branch $br kept: git will not delete it, so it still holds something)"
        fi
      else
        echo "removed  $chip: $wt"
      fi
      rm -f "$entry"; removed=$((removed+1))
    else
      echo "SKIP  $chip: git refused to remove $wt. Its links were unlinked first, so re-run once the"
      echo "      reason is cleared; nothing else about the tree was changed"
      kept=$((kept+1))
    fi
  done
  if [ -z "$do_remove" ]; then
    echo "dry run: nothing was changed. Add --remove to act."
  else
    echo "clean: $removed removed, $kept kept"
  fi
  ;;


merge|render|fixqueue)
  m=$(ls -t "$(dirname "$0")/fleet-merge.mjs" ~/.claude/plugins/cache/*/makarasty/*/scripts/fleet-merge.mjs 2>/dev/null | head -1)
  [ -n "$m" ] || { echo "fleet-merge.mjs not found beside fleet.sh" >&2; exit 2; }
  exec node "$m" "$cmd" "$run"
  ;;

*)
  echo "unknown command: $cmd" >&2; exit 2 ;;
esac
