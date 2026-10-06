#!/bin/sh
# fleet-selftest.sh - run a whole fleet's protocol against a temporary directory, with no sessions, no
# browser and no tokens, and assert every boundary behaves.
#
# A fleet is expensive to test the honest way: fourteen chats, a live application, two hours. So the parts
# that are mechanical - the claim, the lane filter, the schema gate, the clocks, the completion markers,
# the landing check - are tested here instead, in about a second. When this passes, what remains untested
# is judgement and the browser, which is the correct division: a script cannot check whether a finding was
# worth filing, and it can check that an invalid one was refused.
#
#   sh scripts/fleet-selftest.sh            run every check
#   sh scripts/fleet-selftest.sh --keep     keep the temporary run directory and print its path
#
# Exit 0 = every check passed. Exit 1 = at least one failed, and the failing check names what it expected.

set -u

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet="$here/fleet.sh"
[ -f "$fleet" ] || { echo "fleet.sh not found beside this script" >&2; exit 2; }

LC_ALL=C; export LC_ALL
run=${TMPDIR:-/tmp}/fleet-selftest-$$
mkdir -p "$run/tasks/ready"
# Never the real config or the session running this: fleet.sh records sessions under the config dir, and
# the session id of the chat that runs the test would otherwise be recorded as a fleet coordinator there.
unset CLAUDE_CODE_SESSION_ID
CLAUDE_CONFIG_DIR=${TMPDIR:-/tmp}/fleet-cfg-$$; export CLAUDE_CONFIG_DIR
pass=0; fail=0

ok()   { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; [ -n "${2:-}" ] && printf '        got: %s\n' "$2"; }
check(){ # check <name> <expected-substring> <actual>
  case "$3" in *"$2"*) ok "$1";; *) bad "$1" "$(printf '%s' "$3" | tr '\n' '|' | cut -c1-160)";; esac
}
code() { # code <name> <expected-exit> <actual-exit>
  [ "$2" = "$3" ] && ok "$1" || bad "$1" "exit $3, wanted $2"
}

# The abort deadline and the clock's round count are derived from calibration.json, so an operator who
# edits it must not see a red self-test on a healthy install: read the same number the script reads.
mult=2; poll=30
if command -v node >/dev/null 2>&1; then
  _cal=$(ls -t "$here/../calibration.json" 2>/dev/null | head -1)
  if [ -n "$_cal" ]; then
    mult=$(node -e 'try{const v=require(process.argv[1]).budget_multiplier;if(typeof v==="number")console.log(v)}catch{}' "$_cal" 2>/dev/null)
    poll=$(node -e 'try{const v=require(process.argv[1]).clock_poll_seconds;if(typeof v==="number")console.log(v)}catch{}' "$_cal" 2>/dev/null)
  fi
  [ -n "$mult" ] || mult=2
  [ -n "$poll" ] || poll=30
fi
# The context marks and the pause numbers come from the same file, for the same reason.
calk() { # calk <key> <default>
  _v=""
  if command -v node >/dev/null 2>&1 && [ -n "${_cal:-}" ]; then
    _v=$(node -e 'try{const v=require(process.argv[1])[process.argv[2]];if(typeof v==="number")console.log(v)}catch{}' "$_cal" "$1" 2>/dev/null)
  fi
  echo "${_v:-$2}"
}
HAT=$(calk coordinator_handoff_k 700); WAT=$(calk worker_relaunch_k 700); GRACE=$(calk pause_grace_seconds 30)
CK=$((HAT + 40)); WK=$((WAT + 50))

# Every `next` asks the machine for free memory before it claims, so on a box that is actually full the
# queue checks below failed with exit 6 for a reason that had nothing to do with the queue. FLEET_LOAD
# points fleet.sh (and hooks/fleet-memory.mjs) at a census that always has room; the throttle's own cases
# further down replace it with the real one or a tight one.
loadstub="${TMPDIR:-/tmp}/fleet-load-stub-$$.mjs"
cat > "$loadstub" <<'STUB'
if (process.argv.includes('--clear')) process.exit(0);
console.log(JSON.stringify({ when: new Date().toISOString(), totalGB: 64, freeGB: 60, tight: false, sessions: 0, panes: 0, groups: {} }));
STUB
FLEET_LOAD=$loadstub; export FLEET_LOAD

task() { # task <id> <lane> <budget>
  cat > "$run/tasks/ready/$1.md" <<EOF
---
task-id: $1
needs: $2
budget: $3
---
## Steps
1. Nothing. This task exists to be claimed.
EOF
}

echo "fleet selftest, run dir $run"
echo
echo "the queue and its lanes"

task task-01 pane 20
task task-02 repo 15
task task-03 repo 10

out=$(sh "$fleet" next "$run" 07 repo); rc=$?
code "a repo worker claims something" 0 "$rc"
check "and it is not the pane task" "CLAIMED task-02" "$out"
check "the claim prints its lane" "LANE repo" "$out"
check "and its abort deadline in seconds" "ABORT_AFTER_SEC $((15 * mult * 60))" "$out"

out=$(sh "$fleet" next "$run" 08 pane); rc=$?
check "a pane worker gets the pane task the repo worker skipped" "CLAIMED task-01" "$out"

# Two claimers, one task, at the same time: exactly one may win. This is the property the whole queue
# rests on, and mkdir is the only reason it holds.
( sh "$fleet" next "$run" 20 repo > "$run/.a" 2>&1 ) &
( sh "$fleet" next "$run" 21 repo > "$run/.b" 2>&1 ) &
wait
won=$( { grep -l "CLAIMED task-03" "$run/.a" "$run/.b" 2>/dev/null || true; } | wc -l | tr -d ' ')
[ "$won" = "1" ] && ok "two concurrent claimers, exactly one wins task-03" || bad "two concurrent claimers, exactly one wins task-03" "$won won"

winner=$(sed -n 's/^chip //p' "$run/tasks/claimed/task-03/owner" 2>/dev/null | head -1)
sh "$fleet" finish "$run" "${winner:-20}" task-03 >/dev/null 2>&1
[ -e "$run/tasks/done/task-03" ] && ok "the winner can close the task it won" || bad "the winner can close the task it won"

sh "$fleet" next "$run" 09 repo >/dev/null 2>&1; rc=$?
code "an empty lane reports drained rather than handing out foreign work" 3 "$rc"

# The verify lane is one worker wide and no chip is ever told to ask for it - a chip prompt carries `pane`
# or `repo` - so a `needs: verify` task was claimable by nobody and `landed` refused the run over it.
vrun="${TMPDIR:-/tmp}/fleet-verify-$$"; mkdir -p "$vrun/tasks/ready" "$vrun/tasks/done"
for n in 1 2; do
  cat > "$vrun/tasks/ready/task-0$n-suite.md" <<EOF
---
task-id: task-0$n-suite
needs: verify
budget: 10
---
## Steps
1. Run the whole suite, which this machine has room for once.
EOF
done
out=$(sh "$fleet" next "$vrun" 41 repo); rc=$?
code "a repo worker may take a verify task, because nobody else can" 0 "$rc"
check "and is told it now holds the only verify lane there is" "VERIFY LANE" "$out"
out=$(sh "$fleet" next "$vrun" 42 repo 2>&1); rc=$?
code "a second worker is told to wait while that lane is held, not that the queue is empty" 7 "$rc"
# A worker that names no lane used to skip the width check entirely and take the second suite.
out=$(sh "$fleet" next "$vrun" 44 2>&1); rc=$?
code "a worker that named no lane is held by the verify lane too" 7 "$rc"
case "$out" in *CLAIMED*) bad "and is not handed a second verify task" "$out";; *) ok "and is not handed a second verify task";; esac
sh "$fleet" finish "$vrun" 41 task-01-suite >/dev/null 2>&1
out=$(sh "$fleet" next "$vrun" 42 repo); rc=$?
check "and gets the next verify task once it lands" "CLAIMED task-02-suite" "$out"
out=$(sh "$fleet" next "$vrun" 43 pane 2>&1); rc=$?
code "a pane worker never takes one: it is the machine's lane, not the browser's" 3 "$rc"
rm -rf "$vrun"

[ -e "$run/RUN_FORMAT" ] && ok "the run carries the layout version it was written under" || bad "the run carries the layout version it was written under"
cp "$run/RUN_FORMAT" "$run/.fmt"; echo 99 > "$run/RUN_FORMAT"
out=$(sh "$fleet" status "$run" 2>&1); rc=$?
code "a run from a newer format is refused rather than misread" 2 "$rc"
check "and it says which format it found" "format 99" "$out"
cp "$run/.fmt" "$run/RUN_FORMAT"

echo
echo "the schema gate"

good='{"area":"lists","severity":"major","observed":"the Completed tab counts 12 and lists 7","evidence":"cases.page.vue:184 slices before counting","mechanism_status":"hypothesis"}'
out=$(printf '%s' "$good" | sh "$fleet" find "$run" 07 2>&1); rc=$?
code "a finding with evidence is accepted" 0 "$rc"
check "and the file says how many it now holds" "FILED 1 lines" "$out"

out=$(printf '%s' '{"area":"a","severity":"major","observed":"x","mechanism_status":"unknown"}' | sh "$fleet" find "$run" 07 2>&1); rc=$?
code "a finding with no evidence is refused" 1 "$rc"
check "and says which field was missing" "missing evidence" "$out"

out=$(printf '%s' '{"area":"a","severity":"catastrophic","observed":"x","evidence":"file.ts:1 something","mechanism_status":"unknown"}' | sh "$fleet" find "$run" 07 2>&1); rc=$?
code "an invented severity is refused" 1 "$rc"

out=$(printf '%s' '{"area":"a","severity":"minor","what":"x","evidence":"file.ts:1 something","mechanism_status":"unknown"}' | sh "$fleet" find "$run" 07 2>&1); rc=$?
check "the retired field name is refused by name" "retired field" "$out"

out=$(printf '%s' '{"area":"a","severity":"minor","observed":"overlap","evidence":"two rects that do not touch","mechanism_status":"unknown","conditions":"1440px, zoom 100","rects":{"a":{"x":0,"y":0,"w":10,"h":10},"b":{"x":50,"y":50,"w":10,"h":10}}}' | sh "$fleet" find "$run" 07 2>&1); rc=$?
check "a visual claim whose rectangles miss each other is refused" "do not intersect" "$out"

out=$(printf '%s' '{"unreached":"steps 7-9","reason":"budget exceeded"}' | sh "$fleet" find "$run" 07 2>&1); rc=$?
code "an unreached line is a legitimate line" 0 "$rc"

# An auxiliary line records what this worker did to the environment, and it used to be the way past every
# check above: one extra key turned the gate off for the whole object.
out=$(printf '%s' '{"created":"note","severity":"blocker","area":"","observed":"","evidence":"","what":"x"}' | sh "$fleet" find "$run" 07 2>&1); rc=$?
code "an auxiliary key does not turn the gate off for the rest of the object" 1 "$rc"
check "and a severity on an auxiliary line is refused by name" "auxiliary line carries no severity" "$out"
out=$(printf '%s' '{"created":"user Ada Test, group QA-2"}' | sh "$fleet" find "$run" 07 2>&1); rc=$?
code "a created line with nowhere to look for the row is refused" 1 "$rc"
out=$(printf '%s' '{"state_changed":"active role a -> p"}' | sh "$fleet" find "$run" 07 2>&1); rc=$?
check "and a state change with no window is refused, because every later sighting was measured inside it" "state_changed needs when" "$out"
out=$(printf '%s' '{"created":"user Ada Test, group QA-2","where":"sandbox company 41"}' | sh "$fleet" find "$run" 07 2>&1); rc=$?
code "an auxiliary line in its own shape is filed" 0 "$rc"

# A chip's file existing at all is the difference between "filed nothing" and "never filed", and the
# append used to create it before node had read a byte.
out=$(printf '%s' '{"area":"a"}' | sh "$fleet" find "$run" 88 2>&1); rc=$?
code "a chip whose first finding is refused files nothing" 1 "$rc"
[ -e "$run/88.jsonl" ] && bad "and leaves no empty file to be read later as a chip that found nothing" "88.jsonl exists" \
  || ok "and leaves no empty file to be read later as a chip that found nothing"

echo
echo "clocks that disarm themselves"

out=$(sh "$fleet" clock "$run" 07 task-02 20 2>&1); rc=$?
code "a clock is printed for the worker to background" 0 "$rc"
check "it watches for its own task closing" "tasks/done/task-02" "$out"
check "and for its worker finishing" "07.done" "$out"
check "and for its worker going blind, which is as finished as done" "07.blocked" "$out"
check "and it speaks only if the budget really elapsed" "echo budget-elapsed-task-02" "$out"
# The paths are read from a shell standing somewhere else - a worktree, where `.fleet/` is gitignored and
# so does not exist at all - which is where every one of these is backgrounded from.
# Through `sh`, because that is the interpreter fleet.sh itself is run under: `pwd -W` is a Git Bash
# extension, so asking this shell would compare the run directory in two different spellings.
absrun=$(cd "$run" && sh -c 'pwd -W 2>/dev/null || pwd')
check "and every path in it is absolute, so a worker in a worktree can meet its exit conditions" "$absrun/tasks/done/task-02" "$out"
check "one landed run ends it wherever it is armed" "[ -e \"$absrun/FINISHED\" ] && exit 0; i=0" "$out"
rounds=$(printf '%s' "$out" | grep -o -- '-lt [0-9][0-9]*' | head -1 | tr -dc 0-9)
want_rounds=$(( 20 * mult * 60 / poll ))
[ "$rounds" = "$want_rounds" ] && ok "a 20 minute budget at the configured multiplier and poll interval" || bad "a 20 minute budget at the configured multiplier and poll interval" "$rounds rounds, wanted $want_rounds"
# The clock exits on the marker rather than on being stopped, so close the task first and let it run its
# whole budget at zero sleep: a clock that still speaks here is one that would wake a finished worker.
sh "$fleet" finish "$run" 07 task-02 >/dev/null 2>&1
( eval "$(printf '%s' "$out" | sed "s/sleep $poll/sleep 0/")" ) > "$run/.clockout" 2>&1
if grep -q "budget-elapsed" "$run/.clockout" 2>/dev/null; then
  bad "a closed task silences its clock" "clock still fired"
else
  ok "a closed task silences its clock"
fi

# And the same clock still fires when the task really is open, or it would be a clock that never rings.
task task-09 repo 1
sh "$fleet" next "$run" 07 repo >/dev/null 2>&1
out9=$(sh "$fleet" clock "$run" 07 task-09 1 2>&1)
( eval "$(printf '%s' "$out9" | sed "s/sleep $poll/sleep 0/")" ) > "$run/.clockout9" 2>&1
if grep -q "budget-elapsed-task-09" "$run/.clockout9" 2>/dev/null; then
  ok "an open task's clock still rings at twice its budget"
else
  bad "an open task's clock still rings at twice its budget" "$(cat "$run/.clockout9" 2>/dev/null)"
fi
# And the same open task's clock stops the moment the run declares itself finished, which is the only way
# to reach a clock armed hours ago in a chat nobody is sitting in.
: > "$run/FINISHED"
( eval "$(printf '%s' "$out9" | sed "s/sleep $poll/sleep 0/")" ) > "$run/.clockoutF" 2>&1
if grep -q "budget-elapsed" "$run/.clockoutF" 2>/dev/null; then
  bad "a landed run silences every clock still armed" "clock still fired"
else
  ok "a landed run silences every clock still armed"
fi
rm -f "$run/FINISHED"
sh "$fleet" finish "$run" 07 task-09 >/dev/null 2>&1

# A project path with a space in it used to arm the clock on a different directory entirely.
spacey="${TMPDIR:-/tmp}/fleet space $$"; mkdir -p "$spacey/tasks/ready"
cp "$run/tasks/ready/task-09.md" "$spacey/tasks/ready/task-09.md"
spaceabs=$(cd "$spacey" && sh -c 'pwd -W 2>/dev/null || pwd')
out=$(sh "$fleet" next "$spacey" 07 repo 2>&1)
check "the clock a run whose path has a space arms names that path in quotes" "clock \"$spaceabs\" 07" "$out"
rm -rf "$spacey"

out=$(sh "$fleet" finish "$run" 99 task-01 2>&1); rc=$?
code "a worker cannot close somebody else's claim" 4 "$rc"
check "and is told why" "CLAIM LOST" "$out"

echo
echo "finishing, and the difference between empty and over"

: > "$run/tasks/queue-open"
out=$(sh "$fleet" drained "$run" 07 2>&1); rc=$?
code "an empty queue the planner has not closed does not finish a worker" 5 "$rc"
check "and it is told to poll instead" "Poll again" "$out"
check "with a poll that stops itself when the run lands, like every other loop this prints" '/FINISHED" ] && { echo run-finished' "$out"
[ -e "$run/07.done" ] && bad "no done marker while the queue is open" "07.done exists" || ok "no done marker while the queue is open"

rm "$run/tasks/queue-open"
out=$(sh "$fleet" drained "$run" 07 2>&1)
[ -e "$run/07.done" ] && ok "closing the queue lets the worker finish" || bad "closing the queue lets the worker finish"
check "and finishing prints the end banner itself" "WORKER 07 FINISHED" "$out"
check "and the exact session title to set" "RENAME THIS SESSION TO: fleet" "$out"

out=$(sh "$fleet" summary "$run" 07 2>&1)
check "the worker banner names the worker" "WORKER 07 FINISHED" "$out"
check "and counts the majors it filed" "major 1" "$out"
check "and counts what it never reached" "unreached 1" "$out"

echo
echo "questions and answers"

printf 'the gate refuses every commit\n' | sh "$fleet" ask "$run" 05 >/dev/null 2>&1
printf 'the gate refuses every commit, again\n' | sh "$fleet" ask "$run" 06 >/dev/null 2>&1
out=$(sh "$fleet" status "$run" 2>&1)
check "an unanswered question is listed" "05-1.md" "$out"

printf 'Fixed on the shared branch at 16:56. Rebase and use the gate normally.\n' | sh "$fleet" answer "$run" 05-1 06-1 >/dev/null 2>&1
out=$(sh "$fleet" status "$run" 2>&1)
case "$out" in *05-1.md*) bad "one answer can close several questions at once" "$out";; *) ok "one answer can close several questions at once";; esac
[ -s "$run/answers/06-1.md" ] && ok "and it lands under every id it was addressed to" || bad "and it lands under every id it was addressed to"

out=$(printf '' | sh "$fleet" answer "$run" 05-1 2>&1); rc=$?
code "an empty answer is refused" 2 "$rc"

printf 'a question filed before the broadcast\n' | sh "$fleet" ask "$run" 07 >/dev/null 2>&1
sleep 1   # the flag compares mtimes, and both writes land in the same second otherwise
printf 'the tool everybody is tripping over is fixed\n' | sh "$fleet" broadcast "$run" >/dev/null 2>&1
out=$(sh "$fleet" status "$run" 2>&1)
check "a question older than the broadcast is flagged rather than left silently open" "broadcast landed after it" "$out"

# The heading used to be printed above nothing at all: its `|| echo none` hung off a pipeline whose exit
# status was sed's, and sed succeeds on empty input.
bare="${TMPDIR:-/tmp}/fleet-bare-$$"; mkdir -p "$bare/tasks/ready"
out=$(sh "$fleet" status "$bare" 2>&1)
check "a run where no worker has finished says so under the markers heading" "  none" "$out"
rm -rf "$bare"

echo
echo "sizing the repo lane"

out=$(sh "$fleet" width "$run" 2>&1); rc=$?
code "the width of the repo lane is computed, not retyped" 0 "$rc"
check "and it answers with a number" "REPO_WORKERS" "$out"
check "showing the queue term it came from" "ready repo tasks" "$out"

# The constants are read once at startup by sed rather than by a node run per lookup, so this checks the
# reading itself: a copy of the script beside a calibration of our own, with a provenance sentence that
# must not become a constant. The copy beside the script wins over any installed one.
calrun="${TMPDIR:-/tmp}/fleet-cal-$$"; mkdir -p "$calrun/scripts" "$calrun/run/tasks/ready"
cp "$fleet" "$calrun/scripts/fleet.sh"
cat > "$calrun/calibration.json" <<'CAL'
{
  "budget_multiplier": 3,
  "clock_poll_seconds": 7,
  "_provenance": { "clock_poll_seconds": "a sentence carrying 99, which is not a constant" }
}
CAL
out=$(sh "$calrun/scripts/fleet.sh" clock "$calrun/run" 07 task-01 20 2>&1)
check "a calibrated multiplier and poll interval are both read from the file" "-lt $(( 20 * 3 * 60 / 7 ))" "$out"
check "and the poll is the file's, not the built-in default" "sleep 7;" "$out"
# A decimal reached shell arithmetic after the claim was made: the claim stood and the task never printed.
printf '{\n  "budget_multiplier": 1.5,\n  "clock_poll_seconds": 0\n}\n' > "$calrun/calibration.json"
printf -- '---\ntask-id: task-01\nneeds: repo\nbudget: 5\n---\nBODY-OF-TASK\n' > "$calrun/run/tasks/ready/task-01.md"
out=$(sh "$calrun/scripts/fleet.sh" next "$calrun/run" 07 repo 2>&1); rc=$?
code "a decimal multiplier in the calibration does not break a claim" 0 "$rc"
check "which still prints its task" "BODY-OF-TASK" "$out"
check "at the built-in multiplier" "ABORT_AFTER_SEC $((5 * 2 * 60))" "$out"
check "and says which constant it could not use" "budget_multiplier = 1.5 is not a whole number" "$out"
out=$(sh "$calrun/scripts/fleet.sh" clock "$calrun/run" 07 task-01 5 2>&1); rc=$?
code "and a zero poll interval does not divide by zero" 0 "$rc"
rm -rf "$calrun"

echo
echo "abandoned claims"

mkdir -p "$run/tasks/claimed/task-77"
printf 'chip 99
claimed old
' > "$run/tasks/claimed/task-77/owner"
task task-77 repo 1
touch -t 202001010000 "$run/tasks/claimed/task-77/owner" 2>/dev/null
out=$(sh "$fleet" sweep "$run" 2>&1)
check "a claim nobody has advanced past its budget is named" "ABANDONED? task-77" "$out"
check "and nothing is changed until asked" "Nothing was changed" "$out"
[ -d "$run/tasks/claimed/task-77" ] && ok "the claim is still there after a listing sweep" || bad "the claim is still there after a listing sweep"
sh "$fleet" sweep "$run" --release >/dev/null 2>&1
[ -d "$run/tasks/claimed/task-77" ] && bad "--release hands the task back" "still claimed" || ok "--release hands the task back"
out=$(sh "$fleet" status "$run" 2>&1)
case "$out" in *task-77.released*) bad "and status no longer lists it as a live claim" "$out";; *) ok "and status no longer lists it as a live claim";; esac
out=$(sh "$fleet" sweep "$run" 2>&1)
check "and a released claim is not swept twice" "no abandoned claims" "$out"

# Every age in this script is one mtime reading, and without node that reading is empty: the sweep then
# called a claim quiet for 0 minutes and reported a dead fleet healthy. Build a PATH that still has the
# shell's own tools and nothing named node; skip where no such PATH exists.
nonode=""
for d in /usr/bin /bin; do [ -x "$d/sed" ] && nonode="${nonode:+$nonode:}$d"; done
if [ -n "$nonode" ] && ! PATH="$nonode" command -v node >/dev/null 2>&1; then
  out=$(PATH="$nonode" sh "$fleet" sweep "$run" 2>&1); rc=$?
  code "with no node to read an mtime, sweep refuses rather than calling every claim fresh" 2 "$rc"
  check "and says what it would have been guessing about" "how long a claim has been quiet" "$out"
  PATH="$nonode" sh "$fleet" recover "$run" >/dev/null 2>&1; rc=$?
  code "and recover refuses rather than sending a live session down the RESUME branch" 2 "$rc"
  out=$(PATH="$nonode" sh "$fleet" status "$run" 2>&1)
  check "while status, which is the planner's view, says the run age ceiling is not being checked" "run age unknown" "$out"
else
  echo "  skip  every PATH on this host carries node, so the blind case cannot be built"
fi
[ -e "$run/tasks/released/task-77.md" ] && ok "the released task leaves the queue with its claim" || bad "the released task leaves the queue with its claim"
[ -e "$run/tasks/ready/task-77.md" ] && bad "and cannot be handed straight back under the same id" "still in ready/" || ok "and cannot be handed straight back under the same id"
out=$(sh "$fleet" finish "$run" 99 task-77 2>&1); rc=$?
code "the worker whose claim was released cannot close the task" 4 "$rc"
out=$(sh "$fleet" landed "$run" 2 2>&1)
check "and the run cannot land over it until somebody accounts for it" "released and never accounted for" "$out"
rm -f "$run/tasks/released/task-77.md"

echo
echo "a wave that has not landed yet"

# `after:` in a task's frontmatter holds it until the task it names is done. Built in its own directory,
# because the queue in $run is already half claimed by the checks above.
depsrun="${TMPDIR:-/tmp}/fleet-deps-$$"
mkdir -p "$depsrun/tasks/ready" "$depsrun/tasks/done"
cat > "$depsrun/tasks/ready/task-01-primitives.md" <<'DEP'
---
task-id: task-01-primitives
needs: repo
budget: 20
---
## Steps
1. Own the shared components for this wave.
DEP
cat > "$depsrun/tasks/ready/task-02-screen.md" <<'DEP'
---
task-id: task-02-screen
needs: repo
budget: 20
after: task-01-primitives
---
## Steps
1. Rework one screen, once the primitives have landed.
DEP
out=$(sh "$fleet" next "$depsrun" 31 repo); rc=$?
check "the first wave's task is claimable" "CLAIMED task-01-primitives" "$out"
out=$(sh "$fleet" next "$depsrun" 32 repo 2>&1); rc=$?
code "a task waiting on an unfinished dependency is not handed out, and the exit says waiting" 7 "$rc"
check "and the worker is told to poll rather than that the queue is empty" "QUEUE WAITING" "$out"
check "naming how many tasks are held" "1 task(s) held" "$out"
# A worker that took that answer for the end used to write `.done` here while its wave was still coming.
out=$(sh "$fleet" drained "$depsrun" 32 2>&1); rc=$?
code "drained refuses while a ready task nobody holds is still waiting" 5 "$rc"
check "and says why" "QUEUE NOT EMPTY" "$out"
[ -e "$depsrun/32.done" ] && bad "and writes no done marker" "32.done exists" || ok "and writes no done marker"
out=$(sh "$fleet" drained "$depsrun" 32 repo 2>&1); rc=$?
code "a worker in the lane that task needs is held open too" 5 "$rc"
# The unheld task needs the repo lane, so a pane worker could never claim it and waiting would be for nothing.
out=$(sh "$fleet" drained "$depsrun" 33 pane 2>&1); rc=$?
code "a worker in another lane is not held open by it" 0 "$rc"
check "and drains" "QUEUE DRAINED" "$out"
sh "$fleet" finish "$depsrun" 31 task-01-primitives >/dev/null 2>&1
out=$(sh "$fleet" next "$depsrun" 32 repo); rc=$?
code "once the dependency lands the task is claimable" 0 "$rc"
check "and it is the task that was waiting" "CLAIMED task-02-screen" "$out"

# A released task is work nobody finished, so the tasks whose `after:` named it are waiting on a done
# marker nobody will write: the wave answered QUEUE WAITING for the rest of the run and `landed` refused
# over it. The later stages go back to the planner with the stage that died.
cat > "$depsrun/tasks/ready/task-03-polish.md" <<'DEP'
---
task-id: task-03-polish
needs: repo
budget: 20
after: task-02-screen
---
## Steps
1. Polish the screen, once it exists.
DEP
touch -t 202001010000 "$depsrun/tasks/claimed/task-02-screen/owner" "$depsrun/tasks/claimed/task-02-screen/heartbeat" 2>/dev/null
out=$(sh "$fleet" sweep "$depsrun" --release 2>&1)
check "releasing a task takes the tasks waiting on it with it" "also released task-03-polish" "$out"
out=$(sh "$fleet" next "$depsrun" 33 repo 2>&1); rc=$?
code "so the wave does not wait forever on a marker nobody will write" 3 "$rc"
check "and the queue says it is empty rather than waiting" "QUEUE DRAINED" "$out"
[ -e "$depsrun/tasks/released/task-03-polish.md" ] && ok "the dependent waits in released/ to be re-filed with the wave" \
  || bad "the dependent waits in released/ to be re-filed with the wave"
rm -rf "$depsrun"

echo
echo "a cold start, after the machine died"

# `recover` reads two things a crash leaves behind: the chip register written at the first claim, and
# whether that session still has a transcript to reopen. Point it at a project directory of our own so the
# test never depends on what is in the operator's ~/.claude/projects.
proj="${TMPDIR:-/tmp}/fleet-selftest-proj-$$"
mkdir -p "$proj/some-cwd-slug" "$run/chips"
printf '55' > "$run/chips/sess-alive"
printf '56' > "$run/chips/sess-gone"
printf '57' > "$run/chips/sess-still-running"
# The hooks keep their own once-only marks in the same directory, each holding a timestamp.
printf '2026-09-29T10:00:00.000Z' > "$run/chips/sess-alive.memory-warned"
printf '2026-09-29T10:00:00.000Z' > "$run/chips/sess-alive.contract-2f617069"
printf '2026-09-29T10:00:00.000Z' > "$run/chips/sess-alive.browser-warned"
printf '{"type":"user","cwd":"/tmp/some-worktree","timestamp":"2020-01-01T00:00:00Z"}
' > "$proj/some-cwd-slug/sess-alive.jsonl"
printf '{"type":"user","cwd":"/tmp/some-worktree","timestamp":"2020-01-01T00:00:00Z"}
' > "$proj/some-cwd-slug/sess-still-running.jsonl"
# A crashed session's transcript stopped being written when the machine did; a live one was written a
# moment ago. That difference is the only thing separating "reopen this" from "do not touch this".
touch -t 202001010000 "$proj/some-cwd-slug/sess-alive.jsonl" 2>/dev/null
mkdir -p "$run/tasks/claimed/task-88" "$run/tasks/claimed/task-89" "$run/tasks/claimed/task-90"
printf 'chip 55
claimed old
' > "$run/tasks/claimed/task-88/owner"
printf 'chip 56
claimed old
' > "$run/tasks/claimed/task-89/owner"
printf 'chip 57
claimed old
' > "$run/tasks/claimed/task-90/owner"
task task-88 repo 10
task task-89 repo 10
task task-90 repo 10
out=$(CLAUDE_PROJECTS_DIR="$proj" sh "$fleet" recover "$run" 2>&1)
check "a chip whose session stopped being written is offered back" "RESUME  chip 55" "$out"
check "with the command that reopens it" "claude -r sess-alive" "$out"
check "in the directory that session was started in" 'cd "/tmp/some-worktree"' "$out"
check "and a first instruction, so it does not sit there waiting to be typed at" "fleet.sh beat on task-88" "$out"
check "a chip with no transcript is a respawn, not a resume" "RESPAWN chip 56" "$out"
check "a session written to a moment ago is not offered for reopening" "LIVE?   chip 57" "$out"
check "and the report says what each chip is still holding" "holding: task-88" "$out"
check "nothing is released by a report" "nothing was changed" "$out"
case "$out" in *"chip 2026-09-29"*) bad "a hook's own mark is not read as a chip" "$out";; *) ok "a hook's own mark is not read as a chip";; esac
out=$(CLAUDE_PROJECTS_DIR="$proj" sh "$fleet" recover "$run" --release 2>&1)
check "--release frees the dead chip's claim" "released task-89" "$out"
[ -d "$run/tasks/claimed/task-88" ] && ok "and leaves the resumable chip's claim alone" || bad "and leaves the resumable chip's claim alone" "task-88 was released"
[ -d "$run/tasks/claimed/task-90" ] && ok "and the live chip's claim alone" || bad "and the live chip's claim alone" "task-90 was released"
# A corpus that holds nothing is not evidence the workers are gone, and the one destructive path here must
# not run on that absence.
empty="${TMPDIR:-/tmp}/fleet-selftest-empty-$$"; mkdir -p "$empty"
CLAUDE_PROJECTS_DIR="$empty" sh "$fleet" recover "$run" --release >/dev/null 2>&1; rc=$?
code "--release refuses when there are no transcripts to judge by" 2 "$rc"
rm -rf "$empty"
rm -f "$run/tasks/released/task-89.md" "$run/chips/sess-alive" "$run/chips/sess-gone" "$run/chips/sess-still-running" "$run/chips"/sess-alive.*
rm -rf "$proj"
rm -f "$run/tasks/ready/task-89.md" "$run/tasks/ready/task-90.md"
rm -rf "$run/tasks/claimed/task-90"
rm -rf "$run/tasks/claimed/task-88" "$run/tasks/claimed"/task-89.released-*
rm -f "$run/tasks/ready/task-88.md"

echo
echo "the hook that sees what no script can"

guard="$here/../hooks/fleet-guard.mjs"
if [ -f "$guard" ] && command -v node >/dev/null 2>&1; then
  mkdir -p "$run/chips"
  node -e 'require("fs").writeFileSync(process.argv[2], JSON.stringify({session_id:"sess-1", cwd:process.argv[1]}))' "$(dirname "$run")" "$run/.hookin"
  node "$guard" < "$run/.hookin" >/dev/null 2>&1; rc=$?
  code "a session with no chip registered is left alone" 0 "$rc"

  # A worker holding an unfinished claim, ending its turn: the failure that cost 516 minutes.
  hookrun="${TMPDIR:-/tmp}/fleet-hook-$$"; mkdir -p "$hookrun/.fleet/r1/chips" "$hookrun/.fleet/r1/tasks/claimed/task-05" "$hookrun/.fleet/r1/tasks/done"
  # The hook is handed whatever spelling the harness uses, and on Windows that is not the shell's. Ask
  # node, which reports the operating system's own idea of the directory on every platform - `pwd -W` is
  # a Git Bash extension that a stricter POSIX shell does not have.
  hookcwd=$(cd "$hookrun" && { node -e 'process.stdout.write(process.cwd())' 2>/dev/null || pwd; })
  printf '07' > "$hookrun/.fleet/r1/chips/sess-2"
  printf 'chip 07
claimed now
' > "$hookrun/.fleet/r1/tasks/claimed/task-05/owner"
  # A Windows path carries backslashes, which have to be escaped inside JSON. Let node write the payload
  # rather than printf, or the hook parses nothing and bails - which would make this test pass for the
  # wrong reason.
  node -e 'require("fs").writeFileSync(process.argv[2], JSON.stringify({session_id:"sess-2", cwd:process.argv[1]}))' "$hookcwd" "$hookrun/in.json"
  err=$(node "$guard" < "$hookrun/in.json" 2>&1 >/dev/null); rc=$?
  code "a worker ending its turn on an unfinished claim is stopped" 2 "$rc"
  check "and told which task it still holds" "task-05" "$err"
  node "$guard" < "$hookrun/in.json" >/dev/null 2>&1; rc=$?
  code "the same claim is never blocked twice" 0 "$rc"
  # A worker that has written a heartbeat is working, not dying: the hook must leave it alone.
  rm -f "$hookrun/.fleet/r1/chips/sess-2.warned-task-05"
  printf 'chip 07
claimed 2026-08-31T10:00:00
' > "$hookrun/.fleet/r1/tasks/claimed/task-05/owner"
  printf '2026-08-31T10:04:00
' > "$hookrun/.fleet/r1/tasks/claimed/task-05/heartbeat"
  node "$guard" < "$hookrun/in.json" >/dev/null 2>&1; rc=$?
  code "a worker that has beaten its heartbeat is left alone" 0 "$rc"

  # A claim older than the window is a worker doing long work, not one that claimed and walked away.
  rm -f "$hookrun/.fleet/r1/chips/sess-2.warned-task-05" "$hookrun/.fleet/r1/tasks/claimed/task-05/heartbeat"
  printf 'chip 07
claimed 2026-08-31T10:00:00
' > "$hookrun/.fleet/r1/tasks/claimed/task-05/owner"
  touch -t 202001010000 "$hookrun/.fleet/r1/tasks/claimed/task-05" 2>/dev/null
  node "$guard" < "$hookrun/in.json" >/dev/null 2>&1; rc=$?
  code "a claim older than the window is left alone" 0 "$rc"

  printf '' > "$hookrun/.fleet/r1/07.done"
  rm -f "$hookrun/.fleet/r1/chips/sess-2.warned-task-05"
  node "$guard" < "$hookrun/in.json" >/dev/null 2>&1; rc=$?
  code "a finished worker is never stopped" 0 "$rc"
  node -e 'require("fs").writeFileSync(process.argv[2], JSON.stringify({session_id:"sess-2", cwd:process.argv[1], stop_hook_active:true}))' "$hookcwd" "$hookrun/in2.json"
  node "$guard" < "$hookrun/in2.json" >/dev/null 2>&1; rc=$?
  code "and it stands down when the harness says it already fired" 0 "$rc"
  rm -rf "$hookrun"
else
  echo "  skip  no hook script or no node"
fi

echo
echo "the documents point at files that exist"

if command -v node >/dev/null 2>&1; then
  broken=$(node -e '
    const fs=require("fs"), path=require("path");
    const root = process.argv[1];
    const walk = d => fs.readdirSync(d, {withFileTypes:true}).flatMap(e => e.name === ".git" || e.name === "node_modules" ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    let bad = [];
    for (const f of walk(root).filter(f => f.endsWith(".md"))) {
      const text = fs.readFileSync(f, "utf8");
      for (const m of text.matchAll(/\]\((?!https?:)([^)#]+)\)/g)) {
        if (!fs.existsSync(path.resolve(path.dirname(f), m[1]))) bad.push(path.basename(f) + " -> " + m[1]);
      }
    }
    process.stdout.write(bad.join(", "));
  ' "$here/.." 2>/dev/null)
  [ -z "$broken" ] && ok "every link between the documents resolves" || bad "every link between the documents resolves" "$broken"
else
  echo "  skip  no node for the link check"
fi

echo
echo "the measurement ledger"

led="$here/../docs/MEASUREMENTS.md"
if [ -f "$led" ]; then
  missing=""
  for id in $(grep -rho '\[M[0-9][0-9]\]' "$here/../docs" "$here/../commands" 2>/dev/null | tr -d '[]' | sort -u); do
    grep -q "^## $id " "$led" || missing="$missing $id"
  done
  [ -z "$missing" ] && ok "every measurement a rule cites exists in the ledger" || bad "every measurement a rule cites exists in the ledger" "missing:$missing"
  uncited=""
  for id in $(grep -o '^## M[0-9][0-9]' "$led" | awk '{print $2}'); do
    grep -rq "\[$id\]" "$here/../docs" "$here/../commands" 2>/dev/null || uncited="$uncited $id"
  done
  [ -z "$uncited" ] && ok "every ledger entry is cited by a rule" || bad "every ledger entry is cited by a rule" "uncited:$uncited"
else
  echo "  skip  no ledger beside this checkout"
fi

echo
echo "the pane broker"

out=$(printf 'Walk the Completed tab and report whether its count equals the rows it lists.\n' | sh "$fleet" pane-ask "$run" 07 2>&1)
check "a paneless worker can file a browser walk" "FILED" "$out"
check "and is told where the answer will appear" "pane/results/07-1.json" "$out"

out=$(sh "$fleet" pane-next "$run" 02 2>&1); rc=$?
code "a pane host claims the oldest walk" 0 "$rc"
check "and receives the walk itself" "Walk the Completed tab" "$out"

sh "$fleet" pane-next "$run" 03 >/dev/null 2>&1; rc=$?
code "a second host finds nothing left to claim" 3 "$rc"

blind='{"gate":0,"conditions":"1440x900, zoom 100","observations":[]}'
out=$(printf '%s' "$blind" | sh "$fleet" pane-serve "$run" 02 07-1 2>&1); rc=$?
code "a walk measured through a blind pane is refused" 1 "$rc"
check "and says the reading that refused it" "which is blind" "$out"

nogate='{"conditions":"1440x900, zoom 100","observations":[]}'
out=$(printf '%s' "$nogate" | sh "$fleet" pane-serve "$run" 02 07-1 2>&1); rc=$?
code "a walk with no gate reading at all is refused" 1 "$rc"

good='{"gate":301,"conditions":"1440x900, zoom 100","observations":[{"observed":"count says 12, rows list 7","evidence":"cases.page.vue:184"}]}'
out=$(printf '%s' "$good" | sh "$fleet" pane-serve "$run" 02 07-1 2>&1); rc=$?
code "a walk with its gate reading is served" 0 "$rc"
[ -s "$run/pane/results/07-1.json" ] && ok "and the requester has a file to read" || bad "and the requester has a file to read"
grep -q '"host":"02"' "$run/pane/results/07-1.json" 2>/dev/null && ok "the result names the host that produced it" || bad "the result names the host that produced it"

out=$(sh "$fleet" pane-status "$run" 2>&1)
check "the broker reports its backlog" "0 pending" "$out"
check "and the lease it sizes hosts on, which survives the claim being removed" "median lease" "$out"
grep -q '"claimed_at"' "$run/pane/results/07-1.json" 2>/dev/null && ok "the served walk carries the time it was claimed" || bad "the served walk carries the time it was claimed"

# A walk is claimed with the same mkdir a task is, has no heartbeat, and nothing ever swept `pane/running`:
# a host that died holding one - or one whose result the gate refused - left it unclaimable by everybody
# while its requester waited for an answer nobody could produce.
printf 'Walk the Archived tab.\n' | sh "$fleet" pane-ask "$run" 07 >/dev/null 2>&1
sh "$fleet" pane-next "$run" 02 >/dev/null 2>&1
touch -t 202001010000 "$run/pane/running/07-2/owner" 2>/dev/null
out=$(sh "$fleet" sweep "$run" 2>&1)
check "a walk nobody is advancing is named by the sweep" "ABANDONED? walk 07-2" "$out"
sh "$fleet" sweep "$run" --release >/dev/null 2>&1
out=$(sh "$fleet" pane-next "$run" 03 2>&1); rc=$?
code "and --release hands it back to the next host" 0 "$rc"
check "which is the walk that was stuck" "WALK 07-2" "$out"
good='{"gate":301,"conditions":"1440x900, zoom 100","observations":[]}'
printf '%s' "$good" | sh "$fleet" pane-serve "$run" 03 07-2 >/dev/null 2>&1

# "The oldest walk" was the glob's lexical order, which puts `09-10` before `09-2` whatever waited longest.
printf 'Walk the tenth thing.\n' > "$run/pane/requests/09-10.md"
printf 'Walk the second thing.\n' > "$run/pane/requests/09-2.md"
touch -t 202001010100 "$run/pane/requests/09-10.md" 2>/dev/null
touch -t 202001010000 "$run/pane/requests/09-2.md" 2>/dev/null
out=$(sh "$fleet" pane-next "$run" 03 2>&1)
check "a host is handed the walk that has waited longest, not the first by name" "WALK 09-2" "$out"
rm -rf "$run/pane/requests/09-10.md" "$run/pane/requests/09-2.md" "$run/pane/running/09-10" "$run/pane/running/09-2"

echo
echo "landing the run"

out=$(sh "$fleet" landed "$run" 2 2>&1); rc=$?
code "a run with an open claim has not landed" 1 "$rc"
check "and the open claim is named" "claim without a done marker: task-01" "$out"

sh "$fleet" finish "$run" 08 task-01 >/dev/null 2>&1
sh "$fleet" drained "$run" 08 >/dev/null 2>&1
out=$(sh "$fleet" landed "$run" 2 2>&1); rc=$?
code "a run with no backlog has not landed" 1 "$rc"
check "and says so" "backlog.jsonl is missing" "$out"

if command -v node >/dev/null 2>&1; then
  sh "$fleet" merge "$run" >/dev/null 2>&1
  [ -s "$run/backlog.jsonl" ] && ok "merge writes a backlog from the findings" || bad "merge writes a backlog from the findings"
  sh "$fleet" render "$run" >/dev/null 2>&1
  [ -s "$run/backlog.md" ] && ok "render writes the markdown backlog" || bad "render writes the markdown backlog"

  # A line the merge cannot parse is a finding that would vanish from the backlog.
  printf '{"area":"x","severity":"minor","observed":"y","evidence":"file.ts:1 something long"
' >> "$run/07.jsonl"
  sh "$fleet" merge "$run" >/dev/null 2>&1; rc=$?
  code "a torn line refuses the merge rather than vanishing" 1 "$rc"
  # Not `sed -i`: BSD sed reads the script as the backup suffix, and the torn line stayed.
  sed '$d' "$run/07.jsonl" > "$run/07.jsonl.tmp" && mv "$run/07.jsonl.tmp" "$run/07.jsonl"
  sh "$fleet" merge "$run" >/dev/null 2>&1
else
  echo "  skip  merge and render, node is absent"
fi

: > "$run/03.waiting"
out=$(sh "$fleet" landed "$run" 2 2>&1); rc=$?
check "a worker still waiting on the operator blocks the landing" "waiting on the operator" "$out"
rm "$run/03.waiting"

# A worker that went blind and then finished writes both markers, and counting the files made one worker
# look like two - a run reading as complete with somebody still out, and a phone told so.
: > "$run/07.blocked"
out=$(sh "$fleet" landed "$run" 3 2>&1); rc=$?
code "a chip that wrote both a done and a blocked marker is one worker, not two" 1 "$rc"
check "and the count says which" "2 of 3 workers finished" "$out"
rm -f "$run/07.blocked"

out=$(sh "$fleet" landed "$run" 2 2>&1); rc=$?
code "a finished run lands" 0 "$rc"
[ -e "$run/FINISHED" ] && ok "and leaves the FINISHED file behind as the durable answer" || bad "and leaves the FINISHED file behind as the durable answer"

out=$(sh "$fleet" summary "$run" 2>&1)
check "the run banner carries a machine readable line" "fleet-summary: {" "$out"

# The rows walked every chip file while the totals walked `[0-9]*.jsonl`, so a chip id that is not a
# number printed rows full of findings above a total of nothing - and that nothing went to the phone.
printf '%s\n' '{"area":"lists","severity":"major","observed":"the tab is empty","evidence":"cases.page.vue:184 slices before counting","mechanism_status":"unknown"}' > "$run/cid-03.jsonl"
out=$(sh "$fleet" summary "$run" 2>&1)
check "a chip id that is not a number is counted in the totals, not only in its own row" '"majors":2' "$out"
rm -f "$run/cid-03.jsonl"

echo
echo "the design canvas"

# The canvas gate is a script for the same reason the finding gate is: an artboard that names no source,
# or claims a measurement through a blind pane, has to be refused somewhere a worker cannot route around.
cv="$here/fleet-canvas.mjs"
if [ -f "$cv" ] && command -v node >/dev/null 2>&1; then
  node --check "$here/design-probe.js" >/dev/null 2>&1 && ok "design-probe.js parses" || bad "design-probe.js parses"
  node --check "$here/visual-probe.js" >/dev/null 2>&1 && ok "visual-probe.js parses" || bad "visual-probe.js parses"
  cdir="${TMPDIR:-/tmp}/fleet-canvas-$$"; mkdir -p "$cdir/src" "$cdir/design"
  printf 'x' > "$cdir/src/Cases.vue"
  artboard() { cat > "$1" <<'ART'
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet><style>body { margin: 0; } a { color: #000; } a:hover { color: #333; }</style></helmet>
<div style="width: 1440px; height: 900px; background: #fff">Cases</div>
</x-dc>
</body>
</html>
ART
  }
  artboard "$cdir/design/Cases.dc.html"
  out=$(cd "$cdir" && node "$cv" check design 2>&1); rc=$?
  code "an artboard with no provenance is refused" 1 "$rc"
  check "and told what is missing" "no provenance block" "$out"
  # No `/route` here: Git Bash rewrites an argument that starts with `/` into a path under its own
  # install, and the variable that stops it would also stop the script's own path resolving. The guard
  # against that rewrite is tested on its own below, with an argument that never had the slash.
  out=$(cd "$cdir" && node "$cv" stamp design/Cases.dc.html --source src/Cases.vue --viewport 1440x900 --frames 301 --frame 1440x900 2>&1); rc=$?
  code "stamp writes the provenance block" 0 "$rc"
  out=$(cd "$cdir" && node "$cv" stamp design/Cases.dc.html --frames 12 2>&1); rc=$?
  code "a frame count under the gate is refused at the stamp" 1 "$rc"
  out=$(cd "$cdir" && node "$cv" stamp design/Cases.dc.html --route cases 2>&1); rc=$?
  code "a route that lost its leading slash is refused at the stamp" 1 "$rc"
  check "and the refusal names the Git Bash rewrite" "MSYS_NO_PATHCONV" "$out"
  out=$(cd "$cdir" && node "$cv" check design 2>&1); rc=$?
  code "a stamped artboard passes the gate" 0 "$rc"
  check "and the check says what it was measured at" "measured 1440x900" "$out"
  artboard "$cdir/design/Ghost.dc.html"
  (cd "$cdir" && node "$cv" stamp design/Ghost.dc.html --source src/Nope.vue >/dev/null 2>&1)
  out=$(cd "$cdir" && node "$cv" check design 2>&1); rc=$?
  code "an artboard naming a source file that does not exist is refused" 1 "$rc"
  check "by name" "src/Nope.vue does not exist" "$out"
  rm -f "$cdir/design/Ghost.dc.html"
  # `stamp` will not write a blind reading, so plant one by hand: the check has to refuse it on its own.
  cat > "$cdir/design/Blind.dc.html" <<'ART'
<!doctype html>
<!-- fleet-canvas
source: src/Cases.vue
route: /cases
viewport: 1440x900
frames: 0
-->
<html><head><meta charset="utf-8"><script src="./support.js"></script></head>
<body><x-dc><div>x</div></x-dc></body></html>
ART
  out=$(cd "$cdir" && node "$cv" check design 2>&1); rc=$?
  code "a measurement claimed through a blind pane is refused" 1 "$rc"
  check "with the reading that refused it" "frames 0 is under the gate" "$out"
  rm -f "$cdir/design/Blind.dc.html"
  cp "$cdir/design/Cases.dc.html" "$cdir/design/Cases.Proposed.dc.html"
  out=$(cd "$cdir" && node "$cv" layout design --title "Fixture" 2>&1); rc=$?
  code "layout writes a canvas.json" 0 "$rc"
  [ -e "$cdir/design/Main.dc.html" ] && ok "and a cover Main.dc.html when there is none" || bad "and a cover Main.dc.html when there is none"
  check "proposals land on their own page" "Proposed: Cases.Proposed" "$out"
  node -e '
    const c = require(process.argv[1]); const a = c.artboards;
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
      const p = a[i], q = a[j]; if ((p.page || "") !== (q.page || "")) continue;
      const gx = Math.max(p.x, q.x) - Math.min(p.x + p.w, q.x + q.w), gy = Math.max(p.y, q.y) - Math.min(p.y + p.h, q.y + q.h);
      if (gx < 80 && gy < 120) process.exit(1);
    }
    if (!c.pages || c.pages.length !== 2) process.exit(2);
  ' "$cdir/design/canvas.json" >/dev/null 2>&1; rc=$?
  code "frames on one page keep the gaps the editor needs, and both pages exist" 0 "$rc"
  node -e 'const fs=require("fs"),p=process.argv[1];const c=JSON.parse(fs.readFileSync(p,"utf8"));c.artboards.find(a=>a.file==="Cases.dc.html").x=4321;fs.writeFileSync(p,JSON.stringify(c))' "$cdir/design/canvas.json"
  (cd "$cdir" && node "$cv" layout design --title "Fixture" >/dev/null 2>&1)
  grep -q '"x": 4321' "$cdir/design/canvas.json" && ok "a second layout keeps a position the operator moved" || bad "a second layout keeps a position the operator moved"
  out=$(cd "$cdir" && node "$cv" plain design/Cases.dc.html --out "$cdir/plain.html" 2>&1); rc=$?
  code "plain renders a static artboard standalone" 0 "$rc"
  grep -q 'support.js' "$cdir/plain.html" && bad "and the runtime line is gone from it" || ok "and the runtime line is gone from it"
  printf '<x-dc><div>{{ hole }}</div></x-dc>' > "$cdir/design/Hole.dc.html"
  out=$(cd "$cdir" && node "$cv" plain design/Hole.dc.html 2>&1); rc=$?
  code "an artboard that needs the runtime cannot be rendered plain" 1 "$rc"
  rm -f "$cdir/design/Hole.dc.html"
  # The seed needs the design skill's helper, which is on a machine only after that skill has run once.
  # Either outcome is asserted: the real helper seeds and checks the page, or the refusal names the reason.
  out=$(cd "$cdir" && node "$cv" seed design --title "Fixture screens" --out "$cdir/fixture-screens.html" 2>&1); rc=$?
  case "$out" in
    *SEEDED*) ok "seed drives the design skill's helper and its check (the skill is on this machine)"
              [ -s "$cdir/fixture-screens.html" ] && ok "and the seeded page exists" || bad "and the seeded page exists";;
    *"is not on this machine"*) ok "seed refuses with the reason when the design skill is absent (run /design once to exercise the rest)";;
    *) bad "seed either seeds or says why it cannot" "$(printf '%s' "$out" | tail -3 | tr '\n' '|' | cut -c1-160)";;
  esac
  rm -rf "$cdir"
else
  echo "  skip  no fleet-canvas.mjs or no node"
fi

echo
echo "the call script"

# The call gate is a script for the reason the canvas gate is: a page that speaks a number no fact
# carries, or a digit in a line meant to be read aloud, has to be refused where a worker cannot route
# around it.
cl="$here/fleet-call.mjs"
if [ -f "$cl" ] && command -v node >/dev/null 2>&1; then
  ldir="${TMPDIR:-/tmp}/fleet-call-$$"; mkdir -p "$ldir/call/facts"
  printf '# Call\n- Read: ru\n- Speak: en\n' > "$ldir/call/CALL.md"
  printf '## F02-1 · Northwind refuses a third of the second rate checks\n- how known: measured\n- evidence: select count(*) over 2026-07-24..08-12\n- when: 2020-01-01\n\n## F02-2 · the retry helps\n- how known: guess\n- evidence: nobody checked\n- when: 2026-08-20\n' > "$ldir/call/facts/02-northwind.md"
  page() { # page <data-facts> <spoken line>
    printf '<article class="q" data-facts="%s"><div class="say"><span class="lbl">Say</span><p>%s</p></div></article>\n<table><tr><td class="say-cell">about eight hundred</td></tr></table>\n' "$1" "$2" > "$ldir/call/script.html"
  }
  page "F02-1" "About one Northwind check in three comes back with error forty three."
  out=$(node "$cl" check "$ldir" 2>&1); rc=$?
  code "a page whose every fact resolves and whose lines carry no digit passes" 0 "$rc"
  check "and the report counts the facts by how they are known" "1 measured" "$out"
  out=$(node "$cl" check "$ldir" --stale 14 2>&1); rc=$?
  check "a measured fact older than the window is listed as stale" "STALE" "$out"
  code "and is not a refusal" 0 "$rc"
  page "F02-1" "About 1 Northwind check in 3 comes back with error 43."
  out=$(node "$cl" check "$ldir" 2>&1); rc=$?
  code "a digit in a spoken line is refused" 1 "$rc"
  check "and the line is quoted" "error 43" "$out"
  page "F02-9" "About one Northwind check in three comes back with error forty three."
  out=$(node "$cl" check "$ldir" 2>&1); rc=$?
  code "a page citing a fact no file defines is refused" 1 "$rc"
  check "by id" "cites F02-9" "$out"
  page "" "About one Northwind check in three comes back with error forty three."
  out=$(node "$cl" check "$ldir" 2>&1); rc=$?
  code "a page citing no fact at all is refused" 1 "$rc"
  page "F02-1" "About one Northwind check in three comes back with error forty three."
  printf '## F03-1 · nothing behind it\n- how known: read\n- when: 2026-08-20\n' > "$ldir/call/facts/03-bare.md"
  out=$(node "$cl" check "$ldir" 2>&1); rc=$?
  code "a fact with no evidence is refused" 1 "$rc"
  check "by name" "F03-1 has no evidence" "$out"
  rm -f "$ldir/call/facts/03-bare.md" "$ldir/call/CALL.md"
  out=$(node "$cl" check "$ldir" 2>&1); rc=$?
  code "a run with no CALL.md is refused, because the live chat reads nothing else first" 1 "$rc"
  rm -rf "$ldir"
else
  echo "  skip  no fleet-call.mjs or no node"
fi

echo
echo
echo "worktree cleanup"

# The one destructive path in the plugin outside its own scratch. A junction left inside a worktree is a
# hole a recursive delete follows into the main checkout (docs/WORKTREES.md [M32]), so these assert the
# gate: registration refuses a non-worktree path, dry run changes nothing, unpushed work is kept, and a
# clean worktree with a node_modules junction is removed with the main checkout left whole.
if command -v git >/dev/null 2>&1; then
  wl="${TMPDIR:-/tmp}/fleet-wt-$$"; mkdir -p "$wl"
  ( cd "$wl" && git init -q main && cd main && git config user.email a@b && git config user.name t && git config core.autocrlf false \
    && printf 'node_modules\n' > .gitignore && git add .gitignore && git commit -qm init ) >/dev/null 2>&1
  # A .claude/worktrees path is the only shape the gate accepts. Make one and put a node_modules junction
  # (or a plain symlink off Windows) into the main checkout's node_modules, which carries a marker file.
  mkdir -p "$wl/main/node_modules"; echo KEEP > "$wl/main/node_modules/marker.txt"
  mkdir -p "$wl/main/.claude/worktrees"
  wt="$wl/main/.claude/worktrees/wtA"
  ( cd "$wl/main" && git worktree add -q "$wt" -b wtA ) >/dev/null 2>&1
  linkmade=""
  if command -v cmd >/dev/null 2>&1; then
    printf '@echo off\r\nmklink /J "%s" "%s"\r\n' "$(cygpath -w "$wt/node_modules")" "$(cygpath -w "$wl/main/node_modules")" > "$wl/mk.cmd"
    cmd //c "$(cygpath -w "$wl/mk.cmd")" >/dev/null 2>&1 && linkmade=1
  else
    ln -s "$wl/main/node_modules" "$wt/node_modules" 2>/dev/null && linkmade=1
  fi
  wrun="$wl/main/.fleet/run"; mkdir -p "$wrun"

  # The path gate. Depth is the margin for error: each of these is a shape that a future careless edit
  # could turn into its own parent, and the floor is what stops that landing on a drive root.
  out=$(sh "$fleet" worktree "$wrun" 01 "C:/wtmerge" 2>&1); rc=$?
  code "registering a worktree at a drive root is refused" 2 "$rc"
  check "and the reason is its depth" "too shallow to delete safely" "$out"
  check "and it names the floor" "the floor is" "$out"
  out=$(sh "$fleet" worktree "$wrun" 01 "some/relative/path/here" 2>&1); rc=$?
  code "registering a relative path is refused" 2 "$rc"
  check "because what it points at depends on the cwd" "is not absolute" "$out"
  out=$(sh "$fleet" worktree "$wrun" 01 "/a/b/../../../etc" 2>&1); rc=$?
  code "registering a path with .. is refused" 2 "$rc"

  # registration refuses a deep path that is not in the directory this plugin owns
  out=$(sh "$fleet" worktree "$wrun" 01 "$wl/main" 2>&1); rc=$?
  code "registering a non-worktree path is refused" 2 "$rc"
  check "and says why" "is not inside a .claude/worktrees directory" "$out"

  # registration accepts the worktree
  out=$(sh "$fleet" worktree "$wrun" 01 "$wt" 2>&1); rc=$?
  code "registering a worktree path is accepted" 0 "$rc"
  [ -f "$wrun/worktrees/01" ] && ok "and the registration file is written" || bad "and the registration file is written"

  # dry run lists and changes nothing
  out=$(cd "$wl/main" && sh "$fleet" clean "$wrun" 2>&1)
  check "dry run says it would remove the worktree" "would remove" "$out"
  [ -e "$wt" ] && ok "dry run left the worktree in place" || bad "dry run left the worktree in place"

  # a worktree with unpushed commits (no remote at all) is kept, not removed
  ( cd "$wt" && echo x > x && git add x && git commit -qm x ) >/dev/null 2>&1
  out=$(cd "$wl/main" && sh "$fleet" clean "$wrun" --remove 2>&1)
  check "a worktree with unpushed work is kept" "KEEP" "$out"
  [ -e "$wt" ] && ok "and it is still on disk" || bad "and it is still on disk"

  # drop the commit so the branch is merged, then --remove really removes, main node_modules survives
  ( cd "$wt" && git reset -q --hard HEAD~1 ) >/dev/null 2>&1
  out=$(cd "$wl/main" && sh "$fleet" clean "$wrun" --remove 2>&1)
  # Not bare "removed": the ignored-files line says "removed with the tree" before the removal is tried.
  check "a clean worktree is removed" "removed  01:" "$out"
  if [ -e "$wt" ]; then bad "and its directory is gone"; else ok "and its directory is gone"; fi
  if [ -n "$linkmade" ]; then
    [ -f "$wl/main/node_modules/marker.txt" ] && ok "the main checkout's node_modules survived the junction" \
      || bad "the main checkout's node_modules survived the junction" "marker.txt was deleted through the link"
  else
    echo "  skip  could not create a junction/symlink on this host"
  fi
  # A junction one level down is followed by `git worktree remove` exactly as a top-level one is [M32],
  # and the first version of the unlink walked only the top level. This is that bug's regression check.
  wtN="$wl/main/.claude/worktrees/wtN"
  ( cd "$wl/main" && git worktree add -q "$wtN" -b wtN ) >/dev/null 2>&1
  mkdir -p "$wtN/sub" "$wl/main/victimNested"; echo KEEP > "$wl/main/victimNested/keep.txt"
  printf 'node_modules\nsub/\n' > "$wl/main/.gitignore"
  ( cd "$wl/main" && git add .gitignore && git commit -qm ignore ) >/dev/null 2>&1
  nested=""
  if command -v cmd >/dev/null 2>&1; then
    printf '@echo off\r\nmklink /J "%s" "%s"\r\n' "$(cygpath -w "$wtN/sub/node_modules")" "$(cygpath -w "$wl/main/victimNested")" > "$wl/mk2.cmd"
    cmd //c "$(cygpath -w "$wl/mk2.cmd")" >/dev/null 2>&1 && nested=1
  else
    ln -s "$wl/main/victimNested" "$wtN/sub/node_modules" 2>/dev/null && nested=1
  fi
  if [ -n "$nested" ]; then
    ( cd "$wl/main" && sh "$fleet" worktree "$wrun" 03 "$wtN" ) >/dev/null 2>&1
    out=$(cd "$wl/main" && sh "$fleet" clean "$wrun" --remove 2>&1)
    # The removal has to have happened, or a surviving target proves nothing.
    [ -e "$wtN" ] && bad "the tree with a nested junction is actually removed" "$(printf '%s' "$out" | tr '\n' '|' | cut -c1-140)" \
      || ok "the tree with a nested junction is actually removed"
    if [ -f "$wl/main/victimNested/keep.txt" ]; then ok "a junction nested below the top level is unlinked, not followed"
    else bad "a junction nested below the top level is unlinked, not followed" "the target was deleted through it"; fi
  else
    echo "  skip  could not create a nested junction on this host"
  fi

  # A link that will not unlink is the hole itself, and `clean` used to count the attempt and remove the tree
  # anyway. Shadow `rm` and `cmd` with versions that refuse any link, and the tree has to be kept.
  wtF="$wl/main/.claude/worktrees/wtF"
  ( cd "$wl/main" && git worktree add -q "$wtF" -b wtF ) >/dev/null 2>&1
  mkdir -p "$wl/main/victimF"; echo KEEP > "$wl/main/victimF/keep.txt"
  stuck=""
  if command -v cmd >/dev/null 2>&1; then
    printf '@echo off\r\nmklink /J "%s" "%s"\r\n' "$(cygpath -w "$wtF/node_modules")" "$(cygpath -w "$wl/main/victimF")" > "$wl/mk3.cmd"
    cmd //c "$(cygpath -w "$wl/mk3.cmd")" >/dev/null 2>&1 && stuck=1
  else
    ln -s "$wl/main/victimF" "$wtF/node_modules" 2>/dev/null && stuck=1
  fi
  if [ -n "$stuck" ]; then
    realrm=$(command -v rm)
    mkdir -p "$wl/fakebin"
    printf '#!/bin/sh\nfor a; do case $a in -*) ;; *) [ -L "$a" ] && exit 1 ;; esac; done\nexec "%s" "$@"\n' "$realrm" > "$wl/fakebin/rm"
    printf '#!/bin/sh\nexit 1\n' > "$wl/fakebin/cmd"
    chmod +x "$wl/fakebin/rm" "$wl/fakebin/cmd"
    ( cd "$wl/main" && sh "$fleet" worktree "$wrun" 05 "$wtF" ) >/dev/null 2>&1
    out=$(cd "$wl/main" && PATH="$wl/fakebin:$PATH" sh "$fleet" clean "$wrun" --remove 2>&1)
    check "a link that would not unlink keeps its tree" "would not unlink" "$out"
    [ -d "$wtF" ] && ok "and the tree is still on disk" || bad "and the tree is still on disk"
    [ -f "$wl/main/victimF/keep.txt" ] && ok "and nothing was deleted through the link" || bad "and nothing was deleted through the link"
    out=$(PATH="$wl/fakebin:$PATH" sh "$fleet" unlink "$wtF" 2>&1); rc=$?
    code "unlink says so with its exit rather than claiming success" 1 "$rc"
    check "and names the link" "STILL LINKED" "$out"
    ( cd "$wl/main" && sh "$fleet" clean "$wrun" --remove ) >/dev/null 2>&1
  else
    echo "  skip  could not create a junction for the unlink-failure case on this host"
  fi

  # A detached-HEAD worktree has commits that belong to no branch, so `git branch -d` cannot object for
  # them. Removing the tree makes them unreachable; the guard has to keep it.
  wtD="$wl/main/.claude/worktrees/wtD"
  ( cd "$wl/main" && git worktree add -q --detach "$wtD" ) >/dev/null 2>&1
  ( cd "$wtD" && echo d > d.txt && git add d.txt && git commit -qm detached ) >/dev/null 2>&1
  ( cd "$wl/main" && sh "$fleet" worktree "$wrun" 04 "$wtD" ) >/dev/null 2>&1
  out=$(cd "$wl/main" && sh "$fleet" clean "$wrun" --remove 2>&1)
  case "$out" in
    *"detached HEAD"*) ok "a detached-HEAD worktree is kept, because nothing can vouch for its commits";;
    *) bad "a detached-HEAD worktree is kept, because nothing can vouch for its commits" "$(printf '%s' "$out" | tr '\n' '|' | cut -c1-140)";;
  esac
  [ -d "$wtD" ] && ok "and it is still on disk" || bad "and it is still on disk"
  ( cd "$wl/main" && git worktree remove --force "$wtD" ) >/dev/null 2>&1

  # The unlink is a command a worker can run, and it is gated by the same path rule as everything else.
  out=$(sh "$fleet" unlink "C:/wtmerge" 2>&1); rc=$?
  code "unlink refuses a path too shallow to be a worktree" 2 "$rc"

  # Every document tells the worker to unlink from inside the tree it is about to leave, and the guard
  # against deleting this shell's own footing refused exactly that: the path and the working directory
  # were the same. `unlink` removes the links inside a tree and never the tree, so standing in it is
  # safe - and it is the step [M32] exists to enforce, which means a refusal here leaves the junctions in.
  wtU="$wl/main/.claude/worktrees/wtU"
  ( cd "$wl/main" && git worktree add -q "$wtU" -b wtU ) >/dev/null 2>&1
  mkdir -p "$wtU/sub"
  out=$(cd "$wtU/sub" && sh "$fleet" unlink "$wtU" 2>&1); rc=$?
  code "unlink runs from inside the tree, which is the only way the documents call it" 0 "$rc"
  check "and says what it removed" "unlinked" "$out"
  out=$(cd "$wtU" && sh "$fleet" worktree "$wrun" 09 2>&1); rc=$?
  code "and a worker registers the tree it is standing in, which is that command's default argument" 0 "$rc"
  # The same term still refuses to DELETE the directory this shell is standing in, which is what it is for.
  out=$(cd "$wtU" && sh "$fleet" clean "$wrun" --remove 2>&1)
  check "but a deletion of the tree this shell stands in is still refused" "working directory" "$out"
  [ -d "$wtU" ] && ok "and that tree is still on disk" || bad "and that tree is still on disk"
  ( cd "$wl/main" && git worktree remove --force "$wtU" ) >/dev/null 2>&1
  git -C "$wl/main" branch -D wtU >/dev/null 2>&1

  # A worktree cleanup can never reach is named rather than ignored, because it sits there forever and
  # only the operator can move it. Build one that is too shallow and check it is reported, never touched.
  ( cd "$wl/main" && git worktree add -q "$wl/stray" -b strayB ) >/dev/null 2>&1
  ( cd "$wl/main" && sh "$fleet" worktree "$wrun" 02 "$wl/main/.claude/worktrees/wtA" ) >/dev/null 2>&1
  out=$(cd "$wl/main" && sh "$fleet" clean "$wrun" 2>&1)
  case "$out" in
    *STRAY*) ok "a worktree outside .claude/worktrees is reported as a stray";;
    *) bad "a worktree outside .claude/worktrees is reported as a stray" "$(printf '%s' "$out" | tr '\n' '|' | cut -c1-140)";;
  esac
  [ -e "$wl/stray" ] && ok "and the stray is left untouched" || bad "and the stray is left untouched"
  ( cd "$wl/main" && git worktree remove --force "$wl/stray" ) >/dev/null 2>&1
  git -C "$wl/main" worktree prune >/dev/null 2>&1
  rm -rf "$wl"
else
  echo "  skip  no git"
fi

echo
echo "the stage between a finding and a change"

# These cases build their own fixtures rather than reusing $run: the proof gate compares the state of a
# git tree before a change against its state after one, so they need a checkout of their own to move.
tmp="${TMPDIR:-/tmp}/fleet-gate-$$"
mkdir -p "$tmp"
FLEET_SCRIPTS="$here"
export FLEET_SCRIPTS

# --- fleet-gate.mjs: the judgement stage -----------------------------------------------------------
# Paste into scripts/fleet-selftest.sh. Uses the same `check`/`ok`/`bad` helpers and the same $tmp/$G
# conventions as the cases above it. G is the gate script beside fleet.sh.

G="$here/fleet-gate.mjs"
if ! command -v node >/dev/null 2>&1; then
  echo "  skip  fleet-gate cases: node is not on PATH"
else

# A run whose backlog holds one real cluster - two areas reaching one file - and one finding that reaches
# nothing else. The cluster is what a root task is for; the loner must be left alone.
gr=$tmp/gate/.fleet/r1
mkdir -p "$gr"
cat > "$gr/backlog.jsonl" <<'JSONL'
{"id":"f-1","severity":"blocker","area":"login","observed":"session drops on refresh","mechanism":"the sessionStore write is not awaited","evidence":"src/auth/session.ts:42","repro":"npm test -- session"}
{"id":"f-2","severity":"major","area":"export","observed":"export loses the last row","mechanism":"the sessionStore write is not awaited","evidence":"src/auth/session.ts:51","repro":"npm test -- export"}
{"id":"f-3","severity":"major","area":"billing","observed":"invoice total rounds down","mechanism":"integer division","evidence":"src/billing/total.ts:9","repro":"npm test -- billing"}
JSONL

out=$(cd "$tmp/gate" && node "$G" cluster .fleet/r1 2>&1)
check "two areas reaching one file are one candidate root" "1 candidate root" "$out"
out=$(cat "$gr/clusters.md")
check "and the root names the file they share" 'src/auth/session.ts' "$out"
case "$out" in *f-3*) bad "a finding nothing else reaches is not put under a root" "$out";; *) ok "a finding nothing else reaches is not put under a root";; esac

# The queue. One task per finding, as fixqueue writes them, then the gate wires the root in front.
q=$tmp/gate/.fleet/fix-r1/tasks/ready
mkdir -p "$q"
for f in 1 2 3; do
  printf -- '---\ntask-id: task-00%s-area\nkind: fix\nfinding-id: f-%s\nseverity: major\nneeds: repo\nbudget: 25\n---\n\n# area\n\n## Done when\n\n- something\n' "$f" "$f" > "$q/task-00$f-area.md"
done
out=$(cd "$tmp/gate" && node "$G" cluster .fleet/r1 --queue .fleet/fix-r1 2>&1)
check "the root task is written into the queue" "1 root task(s) written" "$out"
check "and its members are gated behind it" "2 task(s) gated" "$out"
check "the root task owns the shared seam" "kind: root" "$(cat "$q/task-root-001.md")"
check "and says which tasks wait on it" "gates: [task-001-area, task-002-area]" "$(cat "$q/task-root-001.md")"
check "a member waits for the root" "after: task-root-001" "$(cat "$q/task-001-area.md")"
check "and is told to re-run its reproduction first" "it may already pass" "$(cat "$q/task-001-area.md")"
case "$(cat "$q/task-003-area.md")" in *after:*) bad "an ungrouped task is not gated" "gated";; *) ok "an ungrouped task is not gated";; esac

# A second run over the same queue must not gate a task twice, or it can never be claimed.
out=$(cd "$tmp/gate" && node "$G" cluster .fleet/r1 --queue .fleet/fix-r1 2>&1)
check "running the gate twice does not gate a task twice" "0 task(s) gated" "$out"

# prove / check: a fix arrives with a reproduction that failed before it and passes after it.
pr=$tmp/gate/.fleet/r1/tasks/claimed/task-001-area
mkdir -p "$pr"
(cd "$tmp/gate" && git init -q . 2>/dev/null; git -C "$tmp/gate" config user.email t@t; git -C "$tmp/gate" config user.name t; echo one > "$tmp/gate/f.txt"; git -C "$tmp/gate" add -A >/dev/null 2>&1; git -C "$tmp/gate" commit -qm one >/dev/null 2>&1)

out=$(cd "$tmp/gate" && node "$G" check .fleet/r1 task-001-area 2>&1)
check "a task with no proof is refused" "no reproduction was recorded before" "$out"

out=$(cd "$tmp/gate" && node "$G" prove .fleet/r1 task-001-area before -- "grep -q two f.txt" 2>&1)
check "a failing reproduction is recorded" "before: exit 1" "$out"
out=$(cd "$tmp/gate" && node "$G" check .fleet/r1 task-001-area 2>&1)
check "and the task is still refused until there is an after" "no reproduction was recorded after" "$out"

out=$(cd "$tmp/gate" && node "$G" prove .fleet/r1 task-001-area after -- "grep -q two f.txt" 2>&1)
out=$(cd "$tmp/gate" && node "$G" check .fleet/r1 task-001-area 2>&1)
check "a reproduction that still fails is refused" "still fails after the change" "$out"

# The tree has to have moved. A green over the same bytes that were red is the false green a dead build
# daemon produced on a real run: BUILD SUCCESSFUL over a tree whose fix had been reverted.
echo two > "$tmp/gate/f.txt"
git -C "$tmp/gate" add -A >/dev/null 2>&1; git -C "$tmp/gate" commit -qm two >/dev/null 2>&1
out=$(cd "$tmp/gate" && node "$G" prove .fleet/r1 task-001-area after -- "grep -q two f.txt" 2>&1)
out=$(cd "$tmp/gate" && node "$G" check .fleet/r1 task-001-area 2>&1)
check "red before, green after, over a tree that changed" "PROVEN task-001-area" "$out"

git -C "$tmp/gate" revert --no-edit -q HEAD >/dev/null 2>&1; echo two > "$tmp/gate/f.txt"
out=$(cd "$tmp/gate" && node "$G" prove .fleet/r1 task-001-area before -- "grep -q two f.txt" 2>&1)
check "a reproduction that passes before the change is a refutation" "refuted, not fixed" "$out"

# A green whose tree is identical to the red one proves nothing, whatever the exit code says. This is the
# false green a dead build daemon produced on a real run - BUILD SUCCESSFUL over a tree whose fix had been
# reverted - and only a forced rebuild found it. Nothing here touches the checkout between the two runs.
mk=$tmp/outside-marker
rm -f "$mk"
mkdir -p "$tmp/gate/.fleet/r1/tasks/claimed/task-002-area"
out=$(cd "$tmp/gate" && node "$G" prove .fleet/r1 task-002-area before -- "test -f \"$mk\"" 2>&1)
: > "$mk"
out=$(cd "$tmp/gate" && node "$G" prove .fleet/r1 task-002-area after -- "test -f \"$mk\"" 2>&1)
out=$(cd "$tmp/gate" && node "$G" check .fleet/r1 task-002-area 2>&1)
check "a pass over an unchanged tree proves nothing" "byte for byte what it was" "$out"

# asks: the open questions as one round, and the decisions nobody was asked about beside them.
mkdir -p "$gr/ask" "$gr/answers"
printf 'The peace-mode ordering fix is a live behaviour change on a flag an operator may already have set.\nrecommend: fix it, and note it in the release\n' > "$gr/ask/07-2.md"
printf 'answered\n' > "$gr/answers/07-1.md"
printf 'closed one\n' > "$gr/ask/07-1.md"
out=$(cd "$tmp/gate" && node "$G" asks .fleet/r1 2>&1)
check "an unanswered question is in the round" "07-2.md" "$out"
check "and the worker's recommendation is shown with it" "the worker recommends" "$out"
case "$out" in *07-1.md*) bad "a question with an answer beside it is not re-asked" "$out";; *) ok "a question with an answer beside it is not re-asked";; esac

out=$(cd "$tmp/gate" && echo '{"token":"/api/server/status","why":"no caller outside the bundled frontend, checked the access log"}' | node "$G" decide .fleet/r1 07 2>&1)
check "a contract call taken without asking is recorded" "recorded: 07 changed /api/server/status" "$out"
out=$(cd "$tmp/gate" && node "$G" asks .fleet/r1 2>&1)
check "and it is shown to the operator with the questions" "1 contract change(s) were decided without asking" "$out"
out=$(cd "$tmp/gate" && echo '{"token":"/api/thing"}' | node "$G" decide .fleet/r1 07 2>&1) || true
check "a decision with no rationale is refused" "a silent one" "$out"

# surface: the names this project promised something outside it.
out=$(cd "$tmp/gate" && node "$G" surface . 2>&1)
check "the contract surface is generated from the checkout" "surface tokens to" "$out"

fi

# --- fleet-contract.mjs: the PreToolUse gate -------------------------------------------------------
# The hook is handed a payload on stdin and answers with an exit code: 0 lets the edit through, 2 refuses
# it with a sentence. Its cwd comes from the harness in the operating system's own spelling, so ask node
# for it exactly as the fleet-guard cases above do.

H="$here/../hooks/fleet-contract.mjs"
[ -f "$H" ] || H="$here/fleet-contract.mjs"
if [ ! -f "$H" ] || ! command -v node >/dev/null 2>&1; then
  echo "  skip  fleet-contract cases"
else
  hp="${TMPDIR:-/tmp}/fleet-contract-$$"
  mkdir -p "$hp/.fleet/r9/chips" "$hp/.fleet/r9/ask"
  hcwd=$(cd "$hp" && { node -e 'process.stdout.write(process.cwd())' 2>/dev/null || pwd; })
  for s in 9 10 11 12; do printf '%s' "$s" > "$hp/.fleet/r9/chips/sess-$s"; done
  printf 'route\t/api/server/status\tsrc/web/Controller.kt\nexport\tgetProgressNote\tsrc/api.ts\n' > "$hp/.fleet/contract-surface.txt"

  # <session> <old> <new> -> "<exit> <stderr>"
  hook() {
    node -e 'const [c,s,o,n]=process.argv.slice(1);process.stdout.write(JSON.stringify({session_id:s,cwd:c,tool_name:"Edit",tool_input:{file_path:"src/web/Controller.kt",old_string:o,new_string:n}}))' \
      "$hcwd" "$1" "$2" "$3" > "$hp/in.json"
    out=$(node "$H" < "$hp/in.json" 2>&1); printf '%s %s' "$?" "$out"
  }

  o=$(hook sess-9 'get("/api/server/status") { roster() }' 'authed("/api/private") { roster() }')
  check "an edit that drops a promised route is refused" "2 " "$o"
  check "and it names the route" "/api/server/status" "$o"
  check "and offers the question as one of two ways past it" "ask/9-" "$o"
  check "and the recorded decision as the other" "fleet-gate.mjs decide" "$o"

  # A substring count says the name survived this. It is the rename most likely to be made.
  o=$(hook sess-12 'get("/api/server/status")' 'get("/api/server/statistics")')
  check "renaming a route to a longer name that contains it is still a removal" "2 " "$o"

  o=$(hook sess-10 'get("/api/server/status") { roster() }' 'get("/api/server/status") { roster().sorted() }')
  check "an edit that leaves the route where it was is allowed" "0 " "$o"

  o=$(hook sess-9 'get("/api/server/status")' 'gone')
  check "the same name is not raised twice in one session" "0 " "$o"

  printf 'Moving /api/server/status behind auth. recommend: do it, note it in the release.\n' > "$hp/.fleet/r9/ask/10-1.md"
  o=$(hook sess-10 'get("/api/server/status")' 'authed("/x")')
  check "a name already asked about is allowed through" "0 " "$o"

  o=$(hook sess-11 'const a = 1' 'const a = 2')
  check "an edit touching no promised name is allowed" "0 " "$o"
  o=$(hook unregistered 'get("/api/server/status")' 'gone')
  check "a session that is not a fleet worker is never gated" "0 " "$o"

  node -e 'const [c]=process.argv.slice(1);process.stdout.write(JSON.stringify({session_id:"sess-11",cwd:c,tool_name:"Read",tool_input:{file_path:"x"}}))' "$hcwd" > "$hp/in.json"
  node "$H" < "$hp/in.json" >/dev/null 2>&1; code "reading is never gated" 0 "$?"

  rm -f "$hp/.fleet/contract-surface.txt"
  o=$(hook sess-11 'get("/api/server/status")' 'gone')
  check "a project that generated no contract surface is never gated" "0 " "$o"
  rm -rf "$hp"
fi

echo
echo "the merge, the retro and the canvas"

echo
echo "the merge, and the reconciliation that has to be able to fail"

# This block pastes into fleet-selftest.sh unchanged. The preamble fires only when the file is run on its
# own, and then FLEET_SCRIPTS says where the scripts are.
if ! command -v check >/dev/null 2>&1; then
  set -u
  LC_ALL=C; export LC_ALL
  here=${FLEET_SCRIPTS:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}
  pass=0; fail=0
  ok()   { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
  bad()  { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; [ -n "${2:-}" ] && printf '        got: %s\n' "$2"; }
  check(){ case "$3" in *"$2"*) ok "$1";; *) bad "$1" "$(printf '%s' "$3" | tr '\n' '|' | cut -c1-160)";; esac; }
  code() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "exit $3, wanted $2"; }
  _mjs_standalone=1
fi

mg="$here/fleet-merge.mjs"
if [ -f "$mg" ] && command -v node >/dev/null 2>&1; then
  mrun="${TMPDIR:-/tmp}/fleet-merge-$$/2026-09-08-full-audit"; mkdir -p "$mrun"
  # Two chips see one thing independently. One of them decided its own sighting was its dev server's fault;
  # the other reproduced it three times. A third chip is called `cid-03`, which fleet.sh find accepts.
  printf '%s\n' '{"chip":"07","area":"auth","severity":"blocker","observed":"login loops forever","evidence":"my dev server was on the wrong port","mechanism_status":"unknown","skip_reason":"my dev server was misconfigured"}' > "$mrun/07.jsonl"
  printf '%s\n' '{"chip":"08","area":"auth","severity":"blocker","observed":"login loops forever","evidence":"auth/session.ts:44 refreshes the cookie it just cleared, reproduced three times","mechanism_status":"established","confirmation":"confirmed"}' > "$mrun/08.jsonl"
  printf '%s\n%s\n' '{"chip":"cid-03","area":"billing","severity":"blocker","observed":"invoice total ignores tax","evidence":"billing/total.ts:12 sums before tax","mechanism_status":"established"}' '{"chip":"cid-03","area":"nav","severity":"minor","observed":"back button skips a page","evidence":"router/history.ts:9 pops twice","mechanism_status":"hypothesis"}' > "$mrun/cid-03.jsonl"

  out=$(node "$mg" merge "$mrun" 2>&1); rc=$?
  code "a merge whose files add up finishes" 0 "$rc"
  check "a chip id that is not a bare number is read like any other" "cid-03.jsonl" "$out"
  check "and its findings are counted" "input findings   4" "$out"
  check "the reconciliation names both halves it compared" "4 findings off 3 chip file(s)" "$out"
  grep -q 'billing/total.ts:12' "$mrun/backlog.jsonl" && ok "a blocker filed by cid-03 reaches the backlog" || bad "a blocker filed by cid-03 reaches the backlog"

  # One worker's skip reason is a statement about that worker, not about the finding.
  grep -q 'reproduced three times' "$mrun/backlog.jsonl" && ok "an independently reproduced blocker survives another worker's skip" || bad "an independently reproduced blocker survives another worker's skip"
  grep -q 'on the wrong port' "$mrun/backlog.jsonl" && bad "and the row keeps the stronger evidence" "the skipped sighting's evidence won" || ok "and the row keeps the stronger evidence"
  grep -q 'my dev server was misconfigured' "$mrun/backlog.jsonl" && ok "with the skip reason carried on the row rather than deleted with it" || bad "with the skip reason carried on the row rather than deleted with it"
  [ -s "$mrun/skipped.jsonl" ] && bad "and nothing was set aside" "skipped.jsonl is not empty" || ok "and nothing was set aside"

  # A group every one of whose sightings was skipped does leave the backlog.
  printf '%s\n' '{"chip":"09","area":"perf","severity":"major","observed":"the list takes nine seconds","evidence":"measured on a laptop that was compiling","mechanism_status":"unknown","skip_reason":"the machine was busy"}' > "$mrun/09.jsonl"
  node "$mg" merge "$mrun" >/dev/null 2>&1
  grep -q '"area":"perf"' "$mrun/skipped.jsonl" && ok "a group every sighting of which was skipped is set aside" || bad "a group every sighting of which was skipped is set aside"
  rm -f "$mrun/09.jsonl"

  # The merge's own output is output. Reading backlog.jsonl back as a chip file would let a second merge
  # count its own rows as findings.
  out=$(node "$mg" merge "$mrun" 2>&1)
  check "the files this merge writes are named as not-input" "backlog.jsonl (written by this merge, never read back as input)" "$out"
  check "and a second merge over the same run counts the same findings" "input findings   4" "$out"

  # Both halves of the reconciliation have to be able to disagree. Break the merge on purpose: the halves
  # that stood here before were the arrays the grouping had just built, and agreed by construction.
  sed "s|w('backlog.jsonl', merged);|w('backlog.jsonl', merged.slice(0, -1));|" "$mg" > "$mrun/short-write.mjs"
  grep -q 'merged.slice(0, -1)' "$mrun/short-write.mjs" && ok "the sabotaged copy really is sabotaged" || bad "the sabotaged copy really is sabotaged"
  out=$(node "$mrun/short-write.mjs" merge "$mrun" 2>&1); rc=$?
  code "a merge that writes fewer rows than it grouped is refused" 1 "$rc"
  check "and names the finding that reached no row" "reach no row on disk" "$out"
  [ -e "$mrun/backlog.jsonl" ] && bad "and leaves no backlog for the run to land over" "backlog.jsonl is still there" || ok "and leaves no backlog for the run to land over"

  # A file that was never opened files no findings, so nothing downstream of the read can miss it.
  sed "s|if (GENERATED.includes(f))|if (/^cid-/.test(f)) continue; if (GENERATED.includes(f))|" "$mg" > "$mrun/unread.mjs"
  out=$(node "$mrun/unread.mjs" merge "$mrun" 2>&1); rc=$?
  code "a chip file the merge never opened is refused" 1 "$rc"
  check "by name" "never opened: cid-03.jsonl" "$out"

  node "$mg" merge "$mrun" >/dev/null 2>&1; rc=$?
  code "and the honest merge still reconciles afterwards" 0 "$rc"
  node "$mg" render "$mrun" >/dev/null 2>&1
  grep -q 'one worker skipped this' "$mrun/backlog.md" && ok "the rendered backlog shows that a worker had skipped the row" || bad "the rendered backlog shows that a worker had skipped the row"
  rm -rf "${TMPDIR:-/tmp}/fleet-merge-$$"
else
  echo "  skip  no fleet-merge.mjs or no node"
fi

echo
echo "the retro, and which run a session belongs to"

rt="$here/fleet-retro.mjs"
if [ -f "$rt" ] && command -v node >/dev/null 2>&1; then
  rdir="${TMPDIR:-/tmp}/fleet-retro-$$"; mkdir -p "$rdir/tx" "$rdir/.fleet/2026-09-08-full-audit/chips"
  # Two sessions with the same chip number: one worked the run, one worked the fix run named after it. As
  # a substring the parent run id matches both, and the child's hours were charged against the parent's
  # completion marker. Let node write the transcripts, so the timestamps are exact.
  node -e '
    const fs = require("fs"), d = process.argv[1];
    const t = (m) => new Date(Date.UTC(2026, 8, 8, 10, m)).toISOString();
    const line = (o) => JSON.stringify(o) + "\n";
    const sess = (seed, t0, step) => {
      let s = line({ type: "user", timestamp: t(t0), message: { role: "user", content: seed } });
      for (let i = 1; i < 6; i++) s += line({ type: "assistant", timestamp: t(t0 + i * step), message: { usage: { output_tokens: 100 }, content: [] } });
      return s;
    };
    fs.writeFileSync(d + "/tx/sess-parent.jsonl", sess("Work .fleet/2026-09-08-full-audit/brief-07.md; your chip id is `07`", 0, 10));
    fs.writeFileSync(d + "/tx/sess-child.jsonl", sess("Work .fleet/fix-2026-09-08-full-audit/brief-07.md; your chip id is `07`", 120, 60));
    fs.writeFileSync(d + "/tx/sess-nochip.jsonl", sess("Have a look at .fleet/2026-09-08-full-audit and tell me what it holds", 0, 2));
    fs.writeFileSync(d + "/.fleet/2026-09-08-full-audit/chips/sess-parent", "07");
    fs.writeFileSync(d + "/.fleet/2026-09-08-full-audit/07.done", "");
    const done = new Date(Date.UTC(2026, 8, 8, 10, 30));
    fs.utimesSync(d + "/.fleet/2026-09-08-full-audit/07.done", done, done);
  ' "$rdir"

  out=$(cd "$rdir" && node "$rt" 2026-09-08-full-audit --dir "$rdir/tx" 2>&1)
  check "a run collects its own sessions" "1 sessions, 5 turns" "$out"
  check "and not the sessions of the fix run named after it" "20 minutes and 2 turns" "$out"
  check "counting the sessions it declined to attribute rather than guessing" "no chip id: left out" "$out"
  out=$(cd "$rdir" && node "$rt" fix-2026-09-08-full-audit --run-dir "$rdir/.fleet/fix-2026-09-08-full-audit" --dir "$rdir/tx" 2>&1)
  check "and the fix run collects its own" "1 sessions, 5 turns" "$out"
  check "without borrowing the parent run's completion marker" "NOT MEASURED" "$out"

  # A run directory that is not there is not a run that wasted nothing, and the zero it used to print was
  # indistinguishable from one.
  out=$(cd "${TMPDIR:-/tmp}" && node "$rt" 2026-09-08-full-audit --dir "$rdir/tx" 2>&1); rc=$?
  code "a retro with no run directory still reports" 0 "$rc"
  check "and says the markers were never found" "no run directory at" "$out"
  check "rather than printing a zero that reads as a clean run" "NOT MEASURED" "$out"
  out=$(cd "$rdir" && node "$rt" 2026-09-08-full-audit --dir "$rdir/tx" --json 2>/dev/null)
  printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>process.exit(JSON.parse(s).length===1?0:1))' 2>/dev/null; rc=$?
  code "the warnings stay off stdout, so --json still parses" 0 "$rc"
  rm -rf "$rdir"
else
  echo "  skip  no fleet-retro.mjs or no node"
fi

echo
echo "the canvas seed, and the cover it writes on the way"

cv2="$here/fleet-canvas.mjs"
if [ -f "$cv2" ] && command -v node >/dev/null 2>&1; then
  sdir="${TMPDIR:-/tmp}/fleet-seed-$$"; mkdir -p "$sdir/src" "$sdir/design" "$sdir/skill"
  printf 'x' > "$sdir/src/Cases.vue"
  cat > "$sdir/design/Cases.dc.html" <<'ART'
<!doctype html>
<html><head><meta charset="utf-8"><script src="./support.js"></script></head>
<body><x-dc><helmet><style>body { margin: 0; } a { color: #000; }</style></helmet>
<div style="width: 1440px; height: 900px">Cases</div></x-dc></body></html>
ART
  # A stand-in for the design skill's helper, so this asserts on every machine rather than only on one
  # where /design has run. It answers the only question that matters: was every artboard canvas.json names
  # actually handed to it.
  cat > "$sdir/skill/payload.template.html" <<'TPL'
<!-- template -->
TPL
  cat > "$sdir/skill/seed-canvas.mjs" <<'STUB'
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === '--check') { console.log('CHECK ok'); process.exit(0); }
const sent = a.filter((x, i) => a[i - 1] === '--artboard');
const named = JSON.parse(fs.readFileSync(a[a.indexOf('--canvas') + 1], 'utf8')).artboards.map((x) => x.file);
const miss = named.filter((n) => !sent.some((s) => s.endsWith(n)));
console.log(miss.length ? 'MISSING FROM PAYLOAD: ' + miss.join(', ') : 'PAYLOAD COMPLETE: ' + named.join(', '));
fs.writeFileSync(a[a.indexOf('--out') + 1], 'seeded');
STUB
  (cd "$sdir" && node "$cv2" stamp design/Cases.dc.html --source src/Cases.vue --frame 1440x900) >/dev/null 2>&1
  out=$(cd "$sdir" && node "$cv2" seed design --title "Fixture" --out "$sdir/out.html" --skill-dir "$sdir/skill" 2>&1); rc=$?
  code "the first seed of a canvas finishes" 0 "$rc"
  check "the cover the layout wrote is in the payload it shipped" "PAYLOAD COMPLETE: Main.dc.html" "$out"
  check "and the count it reports is the count it sent" "seeding 2 artboards" "$out"
  rm -rf "$sdir"
else
  echo "  skip  no fleet-canvas.mjs or no node"
fi

if [ -n "${_mjs_standalone:-}" ]; then
  echo
  echo "$pass passed, $fail failed"
  [ "$fail" = 0 ] || exit 1
fi

echo
echo "finish refuses a fix nobody proved"

if command -v node >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
  fg=$tmp/finishgate
  mkdir -p "$fg/r/tasks/ready"
  ( cd "$fg" && git init -q . && git config user.email t@t && git config user.name t )
  printf -- '---\ntask-id: t1\nkind: fix\nneeds: repo\nbudget: 5\n---\n\n# a fix task\n' > "$fg/r/tasks/ready/t1.md"
  ( cd "$fg" && sh "$fleet" next r 07 repo ) >/dev/null 2>&1
  out=$( cd "$fg" && sh "$fleet" finish r 07 t1 2>&1 ); rc=$?
  code "a fix task with no proof does not get its done marker" 1 "$rc"
  check "and the worker is told how to record one" " t1 before -- " "$out"
  [ -e "$fg/r/tasks/done/t1" ] && bad "and no done marker was written" "marker exists" || ok "and no done marker was written"

  echo one > "$fg/f.txt"
  ( cd "$fg" && git add -A >/dev/null 2>&1 && git commit -qm one >/dev/null 2>&1 )
  ( cd "$fg" && node "$here/fleet-gate.mjs" prove r t1 before -- "grep -q two f.txt" ) >/dev/null 2>&1
  echo two > "$fg/f.txt"
  ( cd "$fg" && git add -A >/dev/null 2>&1 && git commit -qm two >/dev/null 2>&1 )
  ( cd "$fg" && node "$here/fleet-gate.mjs" prove r t1 after -- "grep -q two f.txt" ) >/dev/null 2>&1
  out=$( cd "$fg" && sh "$fleet" finish r 07 t1 2>&1 ); rc=$?
  code "the same task finishes once the reproduction has been run both ways" 0 "$rc"
  check "and it says so" "DONE t1" "$out"

  # A task of any other kind is not asked for a reproduction: the demand belongs to the fix kinds.
  printf -- '---\ntask-id: t2\nkind: verify\nneeds: repo\nbudget: 5\n---\n\n# not a fix\n' > "$fg/r/tasks/ready/t2.md"
  ( cd "$fg" && sh "$fleet" next r 07 repo ) >/dev/null 2>&1
  out=$( cd "$fg" && sh "$fleet" finish r 07 t2 2>&1 ); rc=$?
  code "a task that is not a fix finishes without one" 0 "$rc"
else
  echo "  skip  finish-gate cases: node or git missing"
fi

echo
echo "the throttle that keeps a fleet off the page file"

if command -v node >/dev/null 2>&1; then
  mt=$tmp/tight
  mkdir -p "$mt/scripts" "$mt/r/tasks/ready"
  cp "$here/fleet.sh" "$here/fleet-load.mjs" "$mt/scripts/" 2>/dev/null
  printf -- '---\ntask-id: t1\nkind: fix\nneeds: repo\nbudget: 5\n---\n\n# a task\n' > "$mt/r/tasks/ready/t1.md"

  # A floor no machine can meet: the refusal must fire whatever this box happens to have free.
  node -e 'const f=require("fs"),p=process.argv[1];const c=JSON.parse(f.readFileSync(p+"/../calibration.json","utf8"));c.memory_floor_gb=99999;f.writeFileSync(p+"/../calibration.json",JSON.stringify(c,null,2))' "$mt/scripts" 2>/dev/null ||
    node -e 'const f=require("fs");f.writeFileSync(process.argv[1],JSON.stringify({memory_floor_gb:99999,memory_clear_gb:99999},null,2))' "$mt/calibration.json"
  out=$( cd "$mt" && unset FLEET_LOAD && sh scripts/fleet.sh next r 07 repo 2>&1 ); rc=$?
  code "a claim is refused when the machine has no memory left" 6 "$rc"
  check "and the worker is told the box is full, not that it did something wrong" "MACHINE TIGHT" "$out"
  check "and is given the wait to background rather than an ending" "until node" "$out"
  check "whose loader path is absolute, since a worktree worker has another working directory" "/scripts/fleet-load.mjs" "$out"
  check "and which ends itself when the run lands" "FINISHED" "$out"
  check "and it is told the one thing it can do while waiting" "close anything" "$out"
  [ -e "$mt/r/tight/07" ] && ok "the held worker is on disk where status can find it" || bad "the held worker is on disk where status can find it" "no marker"
  [ -e "$mt/r/tasks/claimed/t1" ] && bad "and nothing was claimed" "claimed anyway" || ok "and nothing was claimed"

  # Floor back to a number any machine meets: the same call must now hand the task out and clear the mark.
  node -e 'const f=require("fs");f.writeFileSync(process.argv[1],JSON.stringify({memory_floor_gb:0,memory_clear_gb:0},null,2))' "$mt/calibration.json"
  out=$( cd "$mt" && unset FLEET_LOAD && sh scripts/fleet.sh next r 07 repo 2>&1 ); rc=$?
  code "and with room again the same call claims" 0 "$rc"
  [ -e "$mt/r/tight/07" ] && bad "and the held mark is cleared" "still there" || ok "and the held mark is cleared"

  out=$( cd "$mt" && sh scripts/fleet.sh drained r 07 2>&1 )
  check "a drained worker is asked for its pane back" "CLOSE YOUR BROWSER PANE" "$out"
  rm -rf "$mt"
else
  echo "  skip  memory throttle cases: no node"
fi

echo
echo "the hook that refuses the whole machine"

M="$here/../hooks/fleet-memory.mjs"
[ -f "$M" ] || M="$here/fleet-memory.mjs"
if [ -f "$M" ] && command -v node >/dev/null 2>&1; then
  mh=$tmp/memhook
  mkdir -p "$mh/.fleet/r1/chips" "$mh/.fleet/r1/tasks/claimed" "$mh/.fleet/r1/tasks/ready"
  printf '07' > "$mh/.fleet/r1/chips/sess-a"
  mcwd=$(cd "$mh" && { node -e 'process.stdout.write(process.cwd())' 2>/dev/null || pwd; })
  bashcall() {
    node -e 'const [c,s,cmd]=process.argv.slice(1);process.stdout.write(JSON.stringify({session_id:s,cwd:c,tool_name:"Bash",tool_input:{command:cmd}}))' \
      "$mcwd" "$1" "$2" > "$mh/in.json"
    out=$(node "$M" < "$mh/in.json" 2>&1); printf '%s %s' "$?" "$out"
  }

  o=$(bashcall sess-a "git status")
  check "an ordinary command is never gated" "0 " "$o"
  o=$(bashcall sess-a "npx vitest run src/auth/session.test.ts")
  check "a scoped run is never gated" "0 " "$o"
  o=$(bashcall sess-a "npm test -- --changed")
  check "and neither is one over the changed set" "0 " "$o"
  o=$(bashcall sess-zz "npx vitest run")
  check "a session that is not a fleet worker is never gated" "0 " "$o"

  # A worker holding the verify lane is the one worker allowed to take the machine.
  mkdir -p "$mh/.fleet/r1/tasks/claimed/t-verify"
  printf 'chip 07\nclaimed now\n' > "$mh/.fleet/r1/tasks/claimed/t-verify/owner"
  printf -- '---\ntask-id: t-verify\nneeds: verify\nbudget: 30\n---\n\n# the suite\n' > "$mh/.fleet/r1/tasks/ready/t-verify.md"
  o=$(bashcall sess-a "npx vitest run")
  check "a worker holding the verify lane may run the whole suite" "0 " "$o"
  rm -rf "$mh/.fleet/r1/tasks/claimed/t-verify" "$mh/.fleet/r1/tasks/ready/t-verify.md"
  rm -f "$mh/.fleet/r1/chips/sess-a.memory-warned"

  # The refusal itself, with a census that always says the box is full. Without this the decisive case is
  # untestable, because whether the hook fires depends on what the machine happens to have free.
  cat > "$mh/tight-census.mjs" <<'STUB'
console.log(JSON.stringify({ when: new Date().toISOString(), totalGB: 31.2, freeGB: 0.9, tight: true,
  sessions: 4, panes: 3, groups: { 'browser pane or window': { n: 3, totalMB: 3200, maxMB: 2061 },
  'toolchain: typecheck': { n: 2, totalMB: 2100, maxMB: 1200 } } }));
STUB
  FLEET_LOAD="$mh/tight-census.mjs"; export FLEET_LOAD
  o=$(bashcall sess-a "npx vitest run")
  check "a full suite is refused when the machine is full" "2 " "$o"
  check "and the worker is told what is already running" "typecheck or test process" "$o"
  check "and offered the verify lane rather than only a refusal" "claim the verify lane" "$o"
  o=$(bashcall sess-a "npx vitest run")
  check "and it is not raised a second time in one session" "0 " "$o"

  rm -f "$mh/.fleet/r1/chips/sess-a.memory-warned"
  node -e 'const [c,s]=process.argv.slice(1);process.stdout.write(JSON.stringify({session_id:s,cwd:c,tool_name:"mcp__Claude_Browser__navigate",tool_input:{url:"http://x"}}))' "$mcwd" sess-a > "$mh/in.json"
  o=$(node "$M" < "$mh/in.json" 2>&1); rc=$?
  code "driving a browser on a full machine is refused too" 2 "$rc"
  check "and the worker is told a reload will not help" "reload returns none of it" "$o"
  FLEET_LOAD=$loadstub   # back to the roomy census the rest of this file runs on

  # A census that cannot answer must never block work: this hook sits on the Bash path of every worker, so
  # failing closed would stop the fleet over a broken reading rather than over a full machine.
  printf 'process.exit(3)\n' > "$mh/broken-census.mjs"
  printf 'console.log("not json at all")\n' > "$mh/garbage-census.mjs"
  rm -f "$mh/.fleet/r1/chips/sess-a.memory-warned"
  FLEET_LOAD="$mh/broken-census.mjs"; export FLEET_LOAD
  o=$(bashcall sess-a "npx vitest run")
  check "a census that exits non-zero lets the command through" "0 " "$o"
  FLEET_LOAD="$mh/garbage-census.mjs"
  o=$(bashcall sess-a "npx vitest run")
  check "and so does one that answers with nonsense" "0 " "$o"
  node -e 'const [c,s]=process.argv.slice(1);process.stdout.write(JSON.stringify({session_id:s,cwd:c,tool_name:"mcp__Claude_Browser__navigate",tool_input:{url:"http://x"}}))' "$mcwd" sess-a > "$mh/in.json"
  node "$M" < "$mh/in.json" >/dev/null 2>&1
  code "a browser call is not gated when the census is unreadable" 0 "$?"
  FLEET_LOAD=$loadstub
  rm -rf "$mh"
else
  echo "  skip  memory hook cases"
fi

echo
echo "the plugin finds itself the way the host records it"

# What rotted here was silent: the docs resolved `docs/` by sorting the plugin cache by modification time,
# the newest by mtime was nine days behind the newest by version, and sessions read a plugin they were not
# running. Nothing failed. So the shape is asserted rather than trusted.
# The glob is allowed, but only as a fallback after a `||` - never as the primary answer.
bad_glob=$(grep -rEn "ls -d?t ~/.claude/plugins/cache" "$here/../commands" "$here/../docs" 2>/dev/null | grep -cv "||" | tr -d " ")
if [ "${bad_glob:-0}" = 0 ]; then
  ok "no document resolves this plugin by modification time"
else
  bad "no document resolves this plugin by modification time" "$bad_glob line(s) still do"
fi

if grep -rqF '${CLAUDE_PLUGIN_ROOT}' "$here/../commands" 2>/dev/null; then
  ok "and the commands take their root from the host instead"
else
  bad "and the commands take their root from the host instead" 'no command names ${CLAUDE_PLUGIN_ROOT}'
fi

# `beside` must return the copy next to the script, whatever any cache holds - and must survive a host with
# no install record at all. This used to call fleet.sh with no arguments, which exits at the usage line
# before `beside` ever runs; and a failed record lookup killed the whole script, silently, under `set -e`.
bs=$tmp/beside/scripts
mkdir -p "$bs" "$tmp/beside/home" "$tmp/beside/r/tasks/ready"
cp "$here/fleet.sh" "$bs/"
printf 'if (process.argv.includes("--clear")) process.exit(1);\nconsole.log(JSON.stringify({freeGB:1.23}));\n' > "$bs/fleet-load.mjs"
printf -- '---\ntask-id: t1\nneeds: repo\nbudget: 5\n---\n' > "$tmp/beside/r/tasks/ready/t1.md"
out=$(cd "$tmp/beside" && unset FLEET_LOAD && HOME="$tmp/beside/home" USERPROFILE="$tmp/beside/home" sh scripts/fleet.sh status r 2>&1); rc=$?
code "a copy of fleet.sh on a host with no install record still runs" 0 "$rc"
out=$(cd "$tmp/beside" && unset FLEET_LOAD && HOME="$tmp/beside/home" USERPROFILE="$tmp/beside/home" sh scripts/fleet.sh next r 07 repo 2>&1); rc=$?
code "and asks the census beside it" 6 "$rc"
check "whose answer is the one it prints" "1.23 GB free" "$out"
check "by the path beside the script" "beside/scripts/fleet-load.mjs" "$out"
rm -rf "$tmp/beside"

echo "== chips"
out=$(sh "$fleet" chips "$run" 02-03 repo 2>&1); rc=$?
code "chips prints the workers of a queue run" 0 "$rc"
check "titled by the address every lookup uses" "title: fleet $(basename "$run") 03" "$out"
check "with the lane" "of run $(basename "$run"), lane repo." "$out"
case "$out" in *"fleet-run .fleet/"*) bad "and the run's absolute path, not a relative one" "$out";; *) ok "and the run's absolute path, not a relative one";; esac
check "and the path of the fleet-run beside it" "commands/fleet-run.md" "$out"
out=$(sh "$fleet" chips "$run" 04 2>&1); rc=$?
code "a queue worker with no lane is refused" 2 "$rc"
printf -- '---\nbrief\n---\n' > "$run/brief-05.md"
out=$(sh "$fleet" chips "$run" 05 2>&1)
check "a brief worker gets its brief, no lane needed" "$(basename "$run")/brief-05.md by following" "$out"
[ "$(cat "$run/offered/05" 2>/dev/null)" = brief ] && ok "and is recorded as a brief, not as a lane it never works" || bad "and is recorded as a brief, not as a lane it never works" "$(cat "$run/offered/05" 2>&1)"
rm -f "$run/brief-05.md"
out=$(sh "$fleet" chips "$run" 06 opus 2>&1); rc=$?
code "a model name is refused as a lane" 2 "$rc"
check "and the refusal says what a lane is" "use pane, repo or verify" "$out"
[ "$(cat "$run/offered/03" 2>/dev/null)" = repo ] && ok "an offered chip is recorded with its lane" || bad "an offered chip is recorded with its lane" "$(ls "$run/offered" 2>&1)"
out=$(sh "$fleet" chips "$run" 02-03 pane 2>&1); rc=$?
code "a number already offered for another lane is refused" 2 "$rc"
check "and the refusal says lanes take disjoint ranges" "disjoint ranges" "$out"
case "$out" in *"CHIP "*) bad "and nothing was printed before it" "$out";; *) ok "and nothing was printed before it";; esac
[ "$(cat "$run/offered/03" 2>/dev/null)" = repo ] && ok "and the recorded lane is left alone" || bad "and the recorded lane is left alone" "$(cat "$run/offered/03" 2>&1)"
out=$(sh "$fleet" chips "$run" 02-03 repo 2>&1); rc=$?
code "the same numbers for the same lane are fine to offer again" 0 "$rc"
for r in 5-3 x 02- -02 02-x; do
  out=$(sh "$fleet" chips "$run" "$r" repo 2>&1); rc=$?
  code "chips refuses the range '$r'" 2 "$rc"
done
cz=$tmp/chipzero; mkdir -p "$cz"
out=$(sh "$fleet" chips "$cz" 3 repo 2>&1); rc=$?
code "a single number is a chip, not a silent exit under set -e" 0 "$rc"
check "and the chip is printed" "CHIP 03" "$out"
check "the trailer says a chip is an offer the operator can decline" "A chip is an offer the operator can decline with one click, so offer every one of them." "$out"
check "and that a rule forbidding chips is quoted, never swapped for paste lines" "never replace chips with paste lines" "$out"
case "$out" in *"does not cover them"*) bad "and the old precedence sentence is gone" "$out";; *) ok "and the old precedence sentence is gone";; esac
case "$out" in *"browser pane on screen"*) bad "a repo chip does not ask for a pane on screen" "$out";; *) ok "a repo chip does not ask for a pane on screen";; esac
out=$(sh "$fleet" chips "$cz" 01 pane 2>&1)
check "a pane chip does" "Keep its browser pane on screen" "$out"

echo "== lane gaps, workers, budgets"
lg=${TMPDIR:-/tmp}/fleet-lanes-$$
mkdir -p "$lg/tasks/ready" "$lg/tasks/done" "$lg/tasks/claimed"
printf -- '---\ntask-id: a\nneeds: pane\nbudget: 60\n---\n' > "$lg/tasks/ready/a.md"
printf -- '---\ntask-id: b\nneeds: opus\nbudget: 60\n---\n' > "$lg/tasks/ready/b.md"
printf -- '---\ntask-id: c\nbudget: 60\n---\n' > "$lg/tasks/ready/c.md"
out=$(sh "$fleet" chips "$lg" 01 repo 2>&1)
check "chips names the lane still without a worker" "lane pane: 1 task(s) ready, no chip offered" "$out"
check "and a lane that is no lane" "needs: opus on 1 task(s) is not a lane" "$out"
check "as a task to fix, not a chip to offer" "FIX THE TASK, not the chips" "$out"
case "$out" in *"lane repo:"*) bad "a lane with a chip is not reported" "$out";; *) ok "a lane with a chip is not reported";; esac
sh "$fleet" whoami "$lg" 01 claude-opus-5-5 medium >/dev/null
out=$(sh "$fleet" status "$lg" 2>&1)
check "status lists each offered worker with its model" "01  lane repo  started no  claude-opus-5-5 medium" "$out"
check "status repeats the lane gap" "== lanes with work and no worker" "$out"
: > "$lg/01.done"
out=$(sh "$fleet" status "$lg" 2>&1)
check "a lane whose only chip wrote .done is a gap again" "lane repo: 1 task(s) ready, no chip offered" "$out"
rm -f "$lg/01.done"; : > "$lg/01.blocked"
out=$(sh "$fleet" status "$lg" 2>&1)
check "and so is one whose chip wrote .blocked" "lane repo: 1 task(s) ready, no chip offered" "$out"
rm -f "$lg/01.blocked"
for t in d e f; do
  mkdir -p "$lg/tasks/claimed/$t"
  printf 'chip 01\nclaimed %s\n' "$(date -u -d '-4 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)" > "$lg/tasks/claimed/$t/owner"
  printf -- '---\ntask-id: %s\nbudget: 90\n---\n' "$t" > "$lg/tasks/ready/$t.md"
  : > "$lg/tasks/done/$t"
done
out=$(sh "$fleet" status "$lg" 2>&1)
check "status measures work against budget" "3 tasks done: median" "$out"
check "and calls loose budgets loose" "BUDGETS TOO LOOSE" "$out"

echo "== coordinator context"
ch=${TMPDIR:-/tmp}/fleet-home-$$
mkdir -p "$ch/projects/p"
printf '{"type":"assistant","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":%s,"cache_creation_input_tokens":0}}}\n' "$((CK * 1000))" > "$ch/projects/p/sess-1.jsonl"
echo sess-1 > "$lg/coordinator"
out=$(CLAUDE_CONFIG_DIR="$ch" sh "$fleet" ctx "$lg" 2>&1)
check "ctx speaks past the mark" "COORDINATOR CONTEXT ${CK}K" "$out"
out=$(CLAUDE_CONFIG_DIR="$ch" sh "$fleet" ctx "$lg" 2>&1)
[ -z "$out" ] && ok "and only once per mark" || bad "and only once per mark" "$out"
printf '{"type":"assistant","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":120000}}}\n' >> "$ch/projects/p/sess-1.jsonl"
out=$(CLAUDE_CONFIG_DIR="$ch" sh "$fleet" ctx "$lg" 2>&1)
[ -z "$out" ] && ok "and is silent under the mark" || bad "and is silent under the mark" "$out"
out=$(CLAUDE_CONFIG_DIR="$ch" sh "$fleet" status "$lg" 2>&1); rc=$?
code "status exits 0 with the coordinator below the handoff mark" 0 "$rc"
check "and still prints its context" "== coordinator context: 120K" "$out"
rm -rf "$lg" "$ch"

echo "== a lane that is no lane, a branch on finish, a run seen from a worktree's cwd"
bl=$tmp/badlane; mkdir -p "$bl/tasks/ready"
printf -- '---\ntask-id: b\nneeds: opus\nbudget: 5\n---\n' > "$bl/tasks/ready/b.md"
out=$(sh "$fleet" drained "$bl" 01 repo 2>&1); rc=$?
code "drained refuses over a ready task no lane can claim" 5 "$rc"
check "and names that task's lane" "needs: opus on 1 task(s) is not a lane" "$out"
[ -e "$bl/01.done" ] && bad "and writes no .done" "01.done exists" || ok "and writes no .done"
out=$(sh "$fleet" next "$bl" 01 repo 2>&1); rc=$?
code "next still reports the queue drained" 3 "$rc"
check "but says which task nobody can claim" "is not a lane" "$out"
fb=$tmp/finishbr; mkdir -p "$fb/tasks/ready"
for t in t1 t2; do printf -- '---\ntask-id: %s\nneeds: repo\nbudget: 5\n---\n' "$t" > "$fb/tasks/ready/$t.md"; done
sh "$fleet" next "$fb" 01 repo >/dev/null 2>&1
out=$(sh "$fleet" finish "$fb" 01 t1 fleet/01/t1 2>&1); rc=$?
sh "$fleet" next "$fb" 01 repo >/dev/null 2>&1   # a chip holding a claim is refused a second, so t1 is finished first
code "finish takes the branch the work was committed on" 0 "$rc"
[ "$(cat "$fb/tasks/done/t1" 2>/dev/null)" = "branch fleet/01/t1" ] && ok "and writes it into the done marker" || bad "and writes it into the done marker" "$(cat "$fb/tasks/done/t1" 2>&1)"
sh "$fleet" finish "$fb" 01 t2 >/dev/null 2>&1
[ -e "$fb/tasks/done/t2" ] && [ ! -s "$fb/tasks/done/t2" ] && ok "without one the marker is empty, as before" || bad "without one the marker is empty, as before" "$(cat "$fb/tasks/done/t2" 2>&1)"
check "a branch that does not resolve is warned about" "does not resolve" "$out"
sh "$fleet" finish "$fb" 01 t1 >/dev/null 2>&1
[ "$(cat "$fb/tasks/done/t1" 2>/dev/null)" = "branch fleet/01/t1" ] && ok "a second finish without a branch keeps the branch line" || bad "a second finish without a branch keeps the branch line" "$(cat "$fb/tasks/done/t1" 2>&1)"
out=$(sh "$fleet" chips "$run" 00 repo 2>&1); rc=$?
code "chips refuses worker 00" 2 "$rc"
out=$(sh "$fleet" chips "$run" 00-02 repo 2>&1); rc=$?
code "and a range that starts at 00" 2 "$rc"
case "$out" in *"CHIP "*) bad "and prints no chip for it" "$out";; *) ok "and prints no chip for it";; esac
if command -v node >/dev/null 2>&1 && [ -f "$here/../hooks/run-dir.mjs" ]; then
  rd=$tmp/relhook; mkdir -p "$rd/.claude/worktrees/w/.fleet/r" "$rd/plain/.fleet/r"
  relof() { # relof <cwd> <dir>
    ( cd "$1" && node --input-type=module -e 'import {pathToFileURL} from "node:url"; const m = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(m.rel(process.argv[2]))' "$here/../hooks/run-dir.mjs" "$2" )
  }
  wcwd=$(cd "$rd/.claude/worktrees/w" && node -e 'process.stdout.write(process.cwd())')
  pcwd=$(cd "$rd/plain" && node -e 'process.stdout.write(process.cwd())')
  [ "$(relof "$rd/plain" "$pcwd/.fleet/r")" = ".fleet/r" ] && ok "a run under the cwd is printed relative" || bad "a run under the cwd is printed relative" "$(relof "$rd/plain" "$pcwd/.fleet/r")"
  o=$(relof "$rd/.claude/worktrees/w" "$wcwd/.fleet/r")
  [ "$o" = "$(printf '%s' "$wcwd/.fleet/r" | tr '\\' /)" ] && ok "but absolute from inside .claude/worktrees" || bad "but absolute from inside .claude/worktrees" "$o"
  o=$(relof "$rd/plain" "$pcwd/.fleet/nope")
  [ "$o" = "$(printf '%s' "$pcwd/.fleet/nope" | tr '\\' /)" ] && ok "and absolute when the relative form would not resolve" || bad "and absolute when the relative form would not resolve" "$o"
  rm -rf "$rd"
fi

echo "== worktree --create"
wr=${TMPDIR:-/tmp}/fleet-wtc-$$
mkdir -p "$wr" && git -C "$wr" init -q main && (
  cd "$wr/main" && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init &&
  mkdir -p node_modules/pkg node_modules/pkg/node_modules/y web/node_modules/x apps/web/node_modules/z && echo keep > node_modules/pkg/a &&
  printf 'node_modules/\n' > .gitignore && echo x > web/index.js && echo y > apps/web/index.js &&
  git add .gitignore web/index.js apps/web/index.js && git -c user.email=t@t -c user.name=t commit -qm two &&
  mkdir -p .fleet/r/tasks/ready && mkdir -p .git/info && printf 'foo' > .git/info/exclude
)
main=$(cd "$wr/main" && git rev-parse --show-toplevel)
# No global ignore file for this one call: a user whose own excludes already cover .claude/ never reaches the
# append this case is about.
out=$(cd "$wr/main" && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 sh "$fleet" worktree .fleet/r 02 --create HEAD 2>&1); rc=$?
code "a worker with no tree of its own gets one" 0 "$rc"
check "under .claude/worktrees" "WORKTREE $main/.claude/worktrees/fleet-" "$out"
check "with the dependencies linked" "linked node_modules" "$out"
check "and nested ones too" "linked web/node_modules" "$out"
check "three levels down, where a monorepo keeps them" "linked apps/web/node_modules" "$out"
case "$out" in *"linked node_modules/pkg"*) bad "and never a package inside a node_modules" "$out";; *) ok "and never a package inside a node_modules";; esac
check "and registered for clean" "registered worktree" "$out"
grep -qx foo "$wr/main/.git/info/exclude" && grep -qx '.claude/worktrees/' "$wr/main/.git/info/exclude" && ok "an exclude file with no final newline keeps its last line" || bad "an exclude file with no final newline keeps its last line" "$(cat "$wr/main/.git/info/exclude")"
st=$(cd "$wr/main" && git status --porcelain | grep -v '.fleet' || true)
[ -z "$st" ] && ok "the tree does not show as untracked work in the checkout" || bad "the tree does not show as untracked work in the checkout" "$st"
out=$(cd "$wr/main" && sh "$fleet" worktree .fleet/r 02 --create HEAD 2>&1)
check "a second call reuses it" "reusing" "$out"
case "$out" in *"linked "*) bad "and links nothing already linked" "$out";; *) ok "and links nothing already linked";; esac
wt2=$(sed -n 's/^path //p' "$wr/main/.fleet/r/worktrees/02")
sh "$fleet" unlink "$wt2" >/dev/null 2>&1
out=$(cd "$wr/main" && sh "$fleet" worktree .fleet/r 02 --create HEAD 2>&1)
check "a tree unlinked before drained gets its links back on reuse" "linked node_modules" "$out"
[ "$(cat "$wr/main/node_modules/pkg/a" 2>/dev/null)" = keep ] && ok "and the main node_modules is untouched by the relink" || bad "and the main node_modules is untouched by the relink" "$(ls "$wr/main/node_modules" 2>&1)"
out=$(cd "$wt2" && sh "$fleet" status .fleet/r 2>&1); rc=$?
code "a relative run directory resolves against the main checkout from a worktree" 0 "$rc"
check "and reads that run" "== claims" "$out"
out=$(cd "$wt2" && sh "$fleet" status .fleet/nope 2>&1); rc=$?
code "one that exists nowhere is still refused" 2 "$rc"
out=$(cd "$wr/main" && sh "$fleet" clean .fleet/r 2>&1)
check "the dry run names the tree" "would remove  02" "$out"
case "$out" in *"branch -d HEAD"*) bad "and never a branch named HEAD" "$out";; *) ok "and never a branch named HEAD";; esac
out=$(cd "$wr/main" && sh "$fleet" clean .fleet/r --remove 2>&1)
check "clean removes a tree left on a commit a branch holds" "removed  02" "$out"
[ "$(cat "$wr/main/node_modules/pkg/a" 2>/dev/null)" = keep ] && ok "and the main checkout's node_modules survives it" || bad "and the main checkout's node_modules survives it" "$(ls "$wr/main/node_modules" 2>&1)"
want=$(git -C "$wr/main" symbolic-ref --short HEAD)
out=$(cd "$wr/main" && sh "$fleet" worktree .fleet/r 03 --create 2>&1); rc=$?
code "the base may be left out" 0 "$rc"
check "and is the main checkout's current branch" "at $want" "$out"
wt3=$(sed -n 's/^path //p' "$wr/main/.fleet/r/worktrees/03")
git -C "$wt3" -c user.email=t@t -c user.name=t commit -q --allow-empty -m work
out=$(cd "$wr/main" && sh "$fleet" clean .fleet/r --remove 2>&1)
check "a detached tree holding a commit no branch has is kept" "KEEP  03" "$out"
case "$out" in *"branch -D HEAD"*) bad "and its hint never says branch -D HEAD" "$out";; *) ok "and its hint never says branch -D HEAD";; esac
out=$(cd "$wr/main" && sh "$fleet" worktree .fleet/r 04 --create HEAD 2>&1)
wt4=$(sed -n 's/^path //p' "$wr/main/.fleet/r/worktrees/04")
sh "$fleet" unlink "$wt4" >/dev/null 2>&1; rm -rf "$wt4"
out=$(cd "$wr/main" && sh "$fleet" worktree .fleet/r 04 --create HEAD 2>&1); rc=$?
code "a tree deleted by hand is made again" 0 "$rc"
check "rather than reused from git's stale record" "created $wt4" "$out"
git init -q "$wr/bare" && ( cd "$wr/bare" && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && rm -rf .git/info && mkdir -p .fleet/r )
out=$(cd "$wr/bare" && sh "$fleet" worktree .fleet/r 01 --create HEAD 2>&1); rc=$?
code "a clone with no .git/info still gets its tree" 0 "$rc"
for t in "$wr"/main/.claude/worktrees/* "$wr"/bare/.claude/worktrees/*; do [ -d "$t" ] && sh "$fleet" unlink "$t" >/dev/null 2>&1; done
rm -rf "$wr"


echo "== clean during a run with an integration branch"
ci=${TMPDIR:-/tmp}/fleet-ci-$$
mkdir -p "$ci" && git -C "$ci" init -q main && (
  cd "$ci/main" && G="git -c user.email=t@t -c user.name=t" &&
  $G commit -q --allow-empty -m init && mkdir -p node_modules/p && echo keep > node_modules/p/a &&
  printf 'node_modules/\n' > .gitignore && git add .gitignore && $G commit -qm two &&
  git branch integ && mkdir -p .fleet/r/tasks/ready
) >/dev/null 2>&1
out=$(cd "$ci/main" && sh "$fleet" worktree .fleet/r 05 --create integ 2>&1)
w5=$(sed -n 's/^path //p' "$ci/main/.fleet/r/worktrees/05")
G="git -c user.email=t@t -c user.name=t"
( cd "$w5" && git switch -q -c fleet/05/t1 integ && echo a > a.txt && git add a.txt && $G commit -qm t1 &&
  git switch -q -c fleet/05/t2 && echo b > b.txt && git add b.txt && $G commit -qm t2 ) >/dev/null 2>&1
git -C "$ci/main" -c user.email=t@t -c user.name=t merge -q --no-edit integ >/dev/null 2>&1
( cd "$w5" && git -C "$ci/main" branch -f integ fleet/05/t2 ) >/dev/null 2>&1
out=$(cd "$ci/main" && sh "$fleet" clean .fleet/r --remove 2>&1)
check "a tree whose branch is merged into the integration branch is removed mid-run" "removed  05" "$out"
[ "$(cat "$ci/main/node_modules/p/a" 2>/dev/null)" = keep ] && ok "and the main checkout's node_modules survives" || bad "and the main checkout's node_modules survives" "$out"
git -C "$ci/main" -c user.email=t@t -c user.name=t merge -q --no-edit integ >/dev/null 2>&1
out=$(cd "$ci/main" && sh "$fleet" worktree .fleet/r 06 --create integ 2>&1)
( cd "$ci/main" && git branch fleet/06/old integ ) >/dev/null 2>&1
out=$(cd "$ci/main" && sh "$fleet" clean .fleet/r --remove 2>&1)
check "and a worker's merged task branches are deleted with it" "branch fleet/06/old deleted (merged)" "$out"
for t in "$ci"/main/.claude/worktrees/*; do [ -d "$t" ] && sh "$fleet" unlink "$t" >/dev/null 2>&1; done
rm -rf "$ci"
echo
echo "== pause: a hard stop the hooks enforce"
pr=${TMPDIR:-/tmp}/fleet-pause-$$
pc=$pr/config                      # the global paused/ marker lives under the config directory: never the real one
mkdir -p "$pr/.fleet/r1/tasks/ready" "$pc"
R=$pr/.fleet/r1
CLAUDE_CONFIG_DIR=$pc; export CLAUDE_CONFIG_DIR
pcwd=$(cd "$pr" && { node -e 'process.stdout.write(process.cwd())' 2>/dev/null || pwd; })
for t in t-a t-b; do printf -- '---\ntask-id: %s\nneeds: repo\nbudget: 10\n---\nwork\n' "$t" > "$R/tasks/ready/$t.md"; done
printf -- '---\ntask-id: t-c\nneeds: repo\nafter: t-a\nbudget: 10\n---\nwork\n' > "$R/tasks/ready/t-c.md"
sh "$fleet" chips "$R" 03-04 repo >/dev/null 2>&1
out=$(CLAUDE_CODE_SESSION_ID=sess-w3 sh "$fleet" next "$R" 03 repo 2>&1)
check "worker 03 claims t-a" "CLAIMED t-a" "$out"
out=$(CLAUDE_CODE_SESSION_ID=sess-w4 sh "$fleet" next "$R" 04 repo 2>&1)
check "worker 04 claims t-b" "CLAIMED t-b" "$out"
out=$(CLAUDE_CODE_SESSION_ID=sess-w3 sh "$fleet" next "$R" 03 repo 2>&1); rc=$?
code "next for a chip that already holds an open claim exits 2" 2 "$rc"
check "and names the held task" "HOLDING t-a" "$out"
case "$out" in *CLAIMED*) bad "and claims nothing" "$out";; *) ok "and claims nothing";; esac

out=$(sh "$fleet" pause "$R" "operator asked" </dev/null 2>&1); rc=$?
code "pause exits 0" 0 "$rc"
check "it says the run is paused" "PAUSED r1" "$out"
check "and how many workers hold claims" "2 worker(s) hold claims: 03 04" "$out"
check "and which line to watch for the acks" "stopped/<chip>" "$out"
[ -e "$R/PAUSED" ] && ok "PAUSED is written" || bad "PAUSED is written"
check "with the reason" "operator asked" "$(cat "$R/PAUSED" 2>/dev/null)"
mk=$(ls "$pc"/makarasty/paused/* 2>/dev/null | head -1)
check "and the global marker holds the run's absolute path" "/.fleet/r1" "$(cat "$mk" 2>/dev/null)"
out=$(sh "$fleet" pause "$R" 2>&1)
check "a second pause keeps the first" "already paused" "$out"
sh "$fleet" pause "$R" - < /dev/null >/dev/null 2>&1; rc=$?
code "pause - reads its reason from stdin and does not hang on an empty one" 0 "$rc"

out=$(sh "$fleet" next "$R" 03 repo 2>&1); rc=$?
code "next hands out nothing while paused" 8 "$rc"
check "and says so" "RUN PAUSED" "$out"
check "with the wake loop to background" "until [ ! -e" "$out"
case "$out" in *CLAIMED*) bad "and claims nothing" "$out";; *) ok "and claims nothing";; esac
out=$(sh "$fleet" drained "$R" 03 repo 2>&1); rc=$?
code "drained exits 8 while paused" 8 "$rc"
[ -e "$R/03.done" ] && bad "and writes no .done" "03.done exists" || ok "and writes no .done"
case "$out" in *"CLOSE YOUR BROWSER PANE"*) bad "and does not tell a paused worker to close its pane first" "$out";; *) ok "and does not tell a paused worker to close its pane first";; esac
# A worker whose only calls are answered "paused" is still registered, so the hooks know it.
CLAUDE_CODE_SESSION_ID=sess-w9 sh "$fleet" next "$R" 09 repo >/dev/null 2>&1
[ "$(cat "$R/chips/sess-w9" 2>/dev/null)" = 09 ] && ok "next registers the session before its paused exit" || bad "next registers the session before its paused exit" "$(ls "$R/chips" 2>&1 | tr '\n' ' ')"
CLAUDE_CODE_SESSION_ID=sess-w8 sh "$fleet" drained "$R" 08 repo >/dev/null 2>&1
[ "$(cat "$R/chips/sess-w8" 2>/dev/null)" = 08 ] && ok "and drained does too" || bad "and drained does too"
# The coordinator is never registered as a worker, and cannot acknowledge a pause.
echo sess-cd > "$R/coordinator"
CLAUDE_CODE_SESSION_ID=sess-cd sh "$fleet" next "$R" 07 repo >/dev/null 2>&1
[ -e "$R/chips/sess-cd" ] && bad "the coordinator's own session is not registered by next" "chips/sess-cd exists" || ok "the coordinator's own session is not registered by next"
out=$(CLAUDE_CODE_SESSION_ID=sess-cd sh "$fleet" paused "$R" 07 2>&1); rc=$?
code "paused refuses when the session is the coordinator" 2 "$rc"
check "and says why" "this session is the coordinator" "$out"
rm -f "$R/coordinator" "$R/chips/sess-w9" "$R/chips/sess-w8"
out=$(sh "$fleet" landed "$R" 2 2>&1); rc=$?
check "landed refuses a paused run" "the run is paused" "$out"

touch -t 202001010000 "$R/tasks/claimed/t-a/heartbeat" 2>/dev/null
out=$(sh "$fleet" sweep "$R" --release 2>&1); rc=$?
code "sweep exits 0 while paused" 0 "$rc"
check "and says it reports and reclaims nothing" "no claim is reported or reclaimed" "$out"
[ -d "$R/tasks/claimed/t-a" ] && ok "so a quiet claim is not reclaimed" || bad "so a quiet claim is not reclaimed"

# The abort clock must not ring at a worker that was stopped on purpose: with the pause standing it never
# counts a round, so a short clock outlives the timeout; with the pause gone it rings.
clk=$(sh "$fleet" clock "$R" 03 t-a 1 | sed "s/sleep $poll/sleep 0/")
out=$(timeout 3 sh -c "$clk" 2>&1); rc=$?
code "the abort clock does not count paused time" 124 "$rc"
check "the clock exits on a retired chip" "03.retired" "$clk"

out=$(sh "$fleet" status "$R" 2>&1)
check "status names the pause and the count of stopped workers" "== PAUSED since" "$out"
check "as k of n holding claims" "0 of 2 workers holding claims have stopped" "$out"
check "a worker with no ack yet is not called silent early" "worker 04: no ack yet" "$out"

echo "== pause: the hooks"
touch "$R/PAUSED"   # the steps above took a while, and the grace counts from this file
MEM="$here/../hooks/fleet-memory.mjs"; CON="$here/../hooks/fleet-contract.mjs"; GRD="$here/../hooks/fleet-guard.mjs"
hp() { # hp <hook> <session> <tool> <command-or-json> [agent-id]
  node -e 'const [c,s,t,i,a]=process.argv.slice(1);const p={session_id:s,cwd:c,tool_name:t,tool_input:i.startsWith("{")?JSON.parse(i):{command:i}};if(a)p.agent_id=a;process.stdout.write(JSON.stringify(p))' \
    "$pcwd" "$2" "$3" "$4" "${5:-}" > "$pr/hp.json"
  out=$(node "$1" < "$pr/hp.json" 2>&1); printf '%s %s' "$?" "$out"
}
# an acknowledged worker is held to the list at once, grace or not
out=$(CLAUDE_CODE_SESSION_ID=sess-w3 sh "$fleet" paused "$R" 03 2>&1); rc=$?
code "paused (the ack) exits 0" 0 "$rc"
check "and says what the worker holds" "STOPPED 03: holding t-a" "$out"
[ -e "$R/stopped/03" ] && ok "and writes stopped/03" || bad "and writes stopped/03"
check "and prints the wake loop" "until [ ! -e" "$out"
check "that echoes resumed" "echo resumed" "$out"
check "or retired" "echo retired" "$out"
check "and says a resumed worker carries on with its claim" "carry on with the claim you hold; call next only if you hold none" "$out"
check "and asks for a note where it stopped" "<where you stopped, what is next>" "$out"
wake=$(printf '%s\n' "$out" | grep '^  until')
out=$(CLAUDE_CODE_SESSION_ID=sess-w3 sh "$fleet" paused "$R" 03 "before the retry loop" 2>&1)
check "a fourth argument is written into the chip's notes" "noted in 03.notes.md" "$out"
check "as a line saying where it stopped" "before the retry loop" "$(cat "$R/03.notes.md" 2>/dev/null)"
o=$(hp "$MEM" sess-w3 Bash "npm test")
check "an acked worker's other commands are refused at once" "2 RUN PAUSED" "$o"
check "and told it has stopped" "you have stopped: this call did not run" "$o"
o=$(hp "$MEM" sess-w3 Bash "git -C /x add -A && git -C /x commit -m \"wip: paused; again\"")
check "git, with a semicolon in its message, is allowed" "0 " "$o"
o=$(hp "$MEM" sess-w3 Bash "sh \"$fleet\" paused \"$R\" 03 \"where I stopped\"")
check "fleet.sh by its exact path, quoted, is allowed" "0 " "$o"
o=$(hp "$MEM" sess-w3 Bash "sh $fleet paused $R 03")
check "and unquoted" "0 " "$o"
o=$(hp "$MEM" sess-w3 Bash "$wake")
check "so is the wake loop it printed" "0 " "$o"
o=$(hp "$MEM" sess-w3 Bash "git status && npm test")
check "but a command chained after git is not" "2 RUN PAUSED" "$o"
o=$(hp "$MEM" sess-w3 PowerShell "git status; npm test")
check "and the PowerShell tool is held to the same list" "2 RUN PAUSED" "$o"
# The allow-list is a drift guard, and it closes the holes a reviewer found in it.
for c in 'git status | head -5' 'git status 2>&1 | tail -3' 'time git status' 'git -C "/x/2026-10-06-do-over-fix" log --oneline -3' \
         'git checkout fleet/01/do-it && git status' 'f=/a; sh "$f" paused /r 03' 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh" paused /r 03' \
         'git log --oneline -3 > /dev/null 2>&1' 'git commit -m "fix -c flag; do it"'; do
  o=$(hp "$MEM" sess-w3 Bash "$c"); check "allowed while paused: $c" "0 " "$o"
done
for c in 'git status & npm test' 'echo $(npm test)' 'echo `npm test`' 'git status > out.txt' 'git -c alias.x="!npm test" x' \
         'git rebase -x "npm test" main' 'git bisect run npm test' 'git submodule foreach npm test' 'git diff --ext-diff' \
         'sh ./fleet.sh next' 'sh /tmp/other/fleet.sh next' 'git status | npm test' 'git --exec-path=/x status' 'GIT_EXTERNAL_DIFF=x git diff' \
         'git filter-branch --tree-filter x' 'bash -c "npm test"'; do
  o=$(hp "$MEM" sess-w3 Bash "$c"); check "refused while paused: $c" "2 RUN PAUSED" "$o"
done
# Round 2: a quoted or escaped spelling, an abbreviation, a git program-runner, a PowerShell subexpression.
for c in 'git -C "/x y/wt" add -A; git -C "/x y/wt" commit -m "wip: paused"' 'git status 2>$null' 'git status 2>&1' '(git status)' 'git --git-dir /x/.git status'; do
  o=$(hp "$MEM" sess-w3 Bash "$c"); check "allowed while paused: $c" "0 " "$o"
done
for c in 'git "-c" alias.x=y status' 'git "rebase" -x npm' 'git rebase -x"npm test" main' 'git rebase --exe "npm test" main' 'git rebase \-x t' \
         'git --git-dir x -c alias.x=y status' 'git config alias.x "!npm t"' 'git difftool -x npm' 'git grep -O less foo' 'git fetch --upload-pack=x' \
         'PAGER=x git log' 'EDITOR=x git commit' 'VISUAL=x git commit' 'GIT_EDITOR=x git commit' 'HOME=/x git status' 'XDG_CONFIG_HOME=/x git status' \
         'git log (npm t)' 'echo @(npm t)' 'echo (npm t)' 'git status; (npm t)' 'g\it status'; do
  o=$(hp "$MEM" sess-w3 Bash "$c"); check "refused while paused: $c" "2 RUN PAUSED" "$o"
done
check "the printed commit hint joins with a semicolon, not &&" 'add -A; git -C' "$(hp "$MEM" sess-w4 Bash "npm test")"
o=$(hp "$MEM" sess-w3 Monitor '{"command":"npm test"}')
check "Monitor is held like Bash" "2 RUN PAUSED" "$o"
o=$(hp "$MEM" sess-w3 Monitor '{"command":"git status"}')
check "and passes what Bash passes" "0 " "$o"
o=$(hp "$CON" sess-w3 NotebookEdit '{"notebook_path":"/x/a.ipynb","new_source":"x"}')
check "NotebookEdit is held like Edit" "2 RUN PAUSED" "$o"
o=$(hp "$MEM" sess-w3 Skill '{"skill":"x"}')
check "a Skill is held once the worker has stopped" "2 RUN PAUSED" "$o"
o=$(hp "$CON" sess-w3 Edit '{"file_path":"/x/a.txt","old_string":"a","new_string":"b"}')
check "an edit by an acked worker is refused" "2 RUN PAUSED" "$o"
o=$(hp "$MEM" sess-w3 mcp__Claude_Browser__read_page '{}')
check "so is any browser tool, not only the heavy three" "2 RUN PAUSED" "$o"
o=$(hp "$MEM" sess-w3 Agent '{"prompt":"x"}')
check "and a new subagent" "2 RUN PAUSED" "$o"

# an unacked worker has the grace
touch "$R/PAUSED"
age_pause() { touch -d "$1 seconds ago" "$R/PAUSED" 2>/dev/null || touch -t "$(date -d "-$1 seconds" +%Y%m%d%H%M.%S 2>/dev/null)" "$R/PAUSED"; }
o=$(hp "$CON" sess-w4 NotebookEdit '{"notebook_path":"/x/a.ipynb","new_source":"x"}')
check "a notebook edit by an unacked worker is the first call and gets the notice" "2 RUN PAUSED by the operator. This call did not run" "$o"
rm -f "$R/chips/sess-w4.pause-notice"
# R2-1: the parent sits blocked inside Agent and has made no call, so the subagent's grace runs from the pause.
touch "$R/PAUSED"
o=$(hp "$MEM" sess-w4 Bash "npm test" agent-1)
check "a subagent whose parent has not called yet is let through inside the grace" "0 " "$o"
age_pause $((GRACE + 5))
o=$(hp "$MEM" sess-w4 Bash "npm test" agent-1)
check "and is refused once pause + grace has passed, not at four graces" "You are a subagent of worker 04" "$o"
touch "$R/PAUSED"
o=$(hp "$MEM" sess-w4 Bash "ls")
check "an unacked worker's first call is refused once with the notice" "2 RUN PAUSED by the operator. This call did not run; repeat it if it is part of finishing the step in hand." "$o"
check "naming the seconds it has from now" "You have ${GRACE} s from now" "$o"
check "and what to do first" "stop your subagents and background shells (TaskStop each one" "$o"
check "saying the abort clock needs no stopping" "the abort clock needs no stopping" "$o"
check "with the commit command and the ack, paths quoted" "paused \"" "$o"
o=$(hp "$MEM" sess-w4 Bash "npm test")
check "then calls pass for the rest of the grace" "0 " "$o"
o=$(hp "$CON" sess-w4 Edit '{"file_path":"/x/a.txt","old_string":"a","new_string":"b"}')
check "edits too, so the step in hand can be finished" "0 " "$o"
o=$(hp "$MEM" sess-w4 Agent '{"prompt":"x"}')
check "a new subagent is refused even in the grace" "2 RUN PAUSED" "$o"
o=$(hp "$MEM" sess-w4 Bash "npm test" agent-1)
check "a subagent's calls pass inside the grace" "0 " "$o"

# the grace over
# The grace starts at the worker's first call, not at the pause: a worker that was mid way through a long
# call a minute into the pause still gets its full grace.
age_pause $((GRACE * 2))
o=$(hp "$MEM" sess-w4 Bash "ls")
check "a worker whose first call comes after the grace length still gets the grace" "You have ${GRACE} s from now" "$o"
o=$(hp "$MEM" sess-w4 Bash "npm test")
check "and its next call passes" "0 " "$o"
# ...but never later than four graces after the pause.
age_pause $((GRACE * 4 - 10))
o=$(hp "$MEM" sess-w4 Bash "ls")
n=$(printf '%s' "$o" | sed -n 's/.*You have \([0-9][0-9]*\) s from now.*/\1/p')
[ -n "$n" ] && [ "$n" -le 11 ] && [ "$n" -ge 5 ] && ok "a first call near the ceiling gets only what is left of it ($n s)" || bad "a first call near the ceiling gets only what is left of it" "$o"
age_pause $((GRACE * 4 + 60))
o=$(hp "$MEM" sess-w4 Bash "npm test")
check "a worker that never called is held four graces after the pause" "2 RUN PAUSED" "$o"
check "told the grace is over and the call did not run" "the grace is over: this call did not run" "$o"
check "with the commit command" "commit -m \"wip: paused\"" "$o"
check "and the TaskStop line" "TaskStop each one" "$o"
o=$(hp "$MEM" sess-w4 Bash "npm test" agent-1)
check "and a subagent's call carrying agent_id is refused with it" "You are a subagent of worker 04" "$o"
o=$(hp "$MEM" sess-w4 Bash "git log --oneline")
check "git still passes" "0 " "$o"
o=$(hp "$CON" sess-w4 Write '{"file_path":"/x/a.txt","content":"b"}')
check "a write is refused" "2 RUN PAUSED" "$o"
o=$(hp "$MEM" sess-w4 Bash 'cd /x && git commit -m "fix `x`"')
check "a line refused for a backtick says its syntax was the cause" "refused for its shell syntax" "$o"
o=$(hp "$MEM" sess-w4 Bash "git log && npm test")
case "$o" in "2 "*) case "$o" in *"shell syntax"*) bad "a line refused for its commands does not blame its syntax" "$o";; *) ok "a line refused for its commands does not blame its syntax";; esac;; *) bad "a line refused for its commands does not blame its syntax" "$o";; esac
o=$(hp "$MEM" sess-zz Bash "npm test")
check "a session that is not a worker is never held" "0 " "$o"
o=$(hp "$CON" sess-zz Edit '{"file_path":"/x/a.txt","old_string":"a","new_string":"b"}')
check "not by the edit hook either" "0 " "$o"
out=$(sh "$fleet" status "$R" 2>&1)
check "status names a worker silent past pause_still_working_seconds as still working" "worker 04: still working" "$out"
check "and counts the one that stopped" "1 of 2 workers holding claims have stopped" "$out"

# no paused run anywhere: the fast path
o=$(CLAUDE_CONFIG_DIR=$pr/empty-config hp "$MEM" sess-w4 Bash "npm test")
check "with no paused run on the machine nothing is held" "0 " "$o"
o=$(CLAUDE_CONFIG_DIR=$pr/empty-config hp "$CON" sess-w4 Edit '{"file_path":"/x/a.txt","old_string":"a","new_string":"b"}')
check "and neither is an edit" "0 " "$o"
check "the hook matcher covers Monitor, Skill, subagent spawns and every browser tool" '^(Bash|PowerShell|Monitor|Agent|Task|Skill)$|^mcp__(.*[Bb]rowser|claude-in-chrome)__"' "$(cat "$here/../.claude-plugin/plugin.json")"
check "and the edit matcher covers NotebookEdit" '"matcher": "Edit|Write|MultiEdit|NotebookEdit"' "$(cat "$here/../.claude-plugin/plugin.json")"
# O-2: the context reminder must not read as an order to a fleet coordinator.
printf '{"type":"assistant","message":{"usage":{"input_tokens":650000}}}\n' > "$pr/ctx.jsonl"
o=$(cd "$pr" && printf '{"hook_event_name":"UserPromptSubmit","session_id":"s-ctx","transcript_path":"ctx.jsonl","prompt":"go on"}' | CLAUDE_CONFIG_DIR=$pr/ctxcfg node "$here/../tools/hooks/context.mjs" 2>&1)
check "the context reminder says it is at 650k" "context is at 650k tokens" "$o"
check "and that a fleet coordinator ignores it, its marks coming from the watch" "a fleet coordinator ignores this line; its marks come from the watch (COORDINATOR CONTEXT)" "$o"
case "$o" in *"use the relaunch in fleet-plan 8b instead"*) bad "and no longer tells a coordinator to relaunch at 400K" "$o";; *) ok "and no longer tells a coordinator to relaunch at 400K";; esac

out=$(sh "$fleet" resume "$R" 2>&1); rc=$?
code "resume exits 0" 0 "$rc"
check "and says so" "RESUMED r1" "$out"
check "and that a worker carries on with the claim it holds" "resumed: carry on with the claim you hold, call next only if you hold none" "$out"
{ [ -e "$R/PAUSED" ] || [ -e "$R/stopped/03" ] || ls "$pc"/makarasty/paused/* >/dev/null 2>&1; } && bad "it removes PAUSED, the acks and the global marker" "$(ls "$R" "$pc/makarasty/paused" 2>&1 | tr '\n' ' ')" || ok "it removes PAUSED, the acks and the global marker"
o=$(hp "$MEM" sess-w4 Bash "npm test")
check "after resume the worker is free again" "0 " "$o"
out=$(sh "$fleet" sweep "$R" 2>&1)
check "and the pause is not held against a claim: the sweep finds nothing quiet" "no abandoned claims" "$out"
out=$(eval "$wake" 2>&1)
check "a wake loop started during the pause says resumed once it lifts" "resumed" "$out"

echo "== a retired worker is finished: guard, next, drained"
mkdir -p "$pr/.fleet/g1/chips" "$pr/.fleet/g1/tasks/claimed/task-05" "$pr/.fleet/g1/tasks/done"
printf '07' > "$pr/.fleet/g1/chips/sess-g"
printf 'chip 07\nclaimed now\n' > "$pr/.fleet/g1/tasks/claimed/task-05/owner"
node -e 'require("fs").writeFileSync(process.argv[2], JSON.stringify({session_id:"sess-g", cwd:process.argv[1]}))' "$pcwd" "$pr/g.json"
node "$GRD" < "$pr/g.json" >/dev/null 2>&1; rc=$?
code "control: a worker with a fresh unfinished claim is stopped" 2 "$rc"
rm -f "$pr/.fleet/g1/chips/sess-g.warned-task-05"; : > "$pr/.fleet/g1/07.retired"
node "$GRD" < "$pr/g.json" >/dev/null 2>&1; rc=$?
code "the same worker, retired, is not blocked from stopping" 0 "$rc"
rm -f "$pr/.fleet/g1/07.retired" "$pr/.fleet/g1/chips/sess-g.warned-task-05"; : > "$pr/.fleet/g1/PAUSED"
node "$GRD" < "$pr/g.json" >/dev/null 2>&1; rc=$?
code "a worker holding a fresh claim is not blocked from stopping while the run is paused" 0 "$rc"
rm -f "$pr/.fleet/g1/PAUSED" "$pr/.fleet/g1/chips/sess-g.warned-task-05"
node "$GRD" < "$pr/g.json" >/dev/null 2>&1; rc=$?
code "and is again once the pause lifts" 2 "$rc"
rm -rf "$pr/.fleet/g1"

echo "== relaunch"
# a registered worktree on a branch, so the hand-back has a branch to continue from
mkdir -p "$pr/wt03" && ( cd "$pr/wt03" && git init -q . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git checkout -q -b fleet/03/t-a ) >/dev/null 2>&1
mkdir -p "$R/worktrees"; printf 'path %s\nbranch fleet/03/t-a\nchip 03\n' "$pr/wt03" > "$R/worktrees/03"
out=$(sh "$fleet" relaunch "$R" --wait 0 03 2>&1); rc=$?
code "relaunch's first call prints no chips with no STATE.md" 1 "$rc"
check "and says why" "STATE.md NOT CURRENT: " "$out"
check "that it is missing" "is missing. No chips are printed yet." "$out"
check "and what to do: update it, then the same command again" "run the same command again" "$out"
check "naming the ids it must list" "it must list the handed-back ids above" "$out"
case "$out" in *"CHIP "*) bad "and prints no chip" "$out";; *) ok "and prints no chip";; esac
check "it paused the run first" "PAUSED r1" "$out"
check "named a worker that never stopped" "NOT STOPPED after 0 min: 03 04" "$out"
check "handed the named chip's task back under a new id" "t-a -> t-a-r1  continue-from fleet/03/t-a" "$out"
check "and pointed the task waiting on it at the new id" "t-c: its after: now names t-a-r1" "$out"
[ -e "$R/03.retired" ] && ok "03.retired is written" || bad "03.retired is written"
ls "$R"/tasks/claimed/t-a.released-* >/dev/null 2>&1 && ok "the claim is renamed the way a release renames it" || bad "the claim is renamed the way a release renames it"
grep -q '^task-id: t-a-r1$' "$R/tasks/ready/t-a-r1.md" 2>/dev/null && grep -q '^continue-from: fleet/03/t-a$' "$R/tasks/ready/t-a-r1.md" && ok "the new task carries its own id and continue-from" || bad "the new task carries its own id and continue-from" "$(cat "$R/tasks/ready/t-a-r1.md" 2>&1)"
grep -q '^needs: repo$' "$R/tasks/ready/t-a-r1.md" 2>/dev/null && ok "and the rest of the frontmatter" || bad "and the rest of the frontmatter"
[ ! -e "$R/tasks/ready/t-a.md" ] && [ -e "$R/tasks/handed-back/t-a.md" ] && ok "the old task file leaves the queue without entering released/" || bad "the old task file leaves the queue without entering released/"
[ -d "$R/tasks/claimed/t-b" ] && ok "a worker not named keeps its claim" || bad "a worker not named keeps its claim"
out=$(sh "$fleet" next "$R" 03 repo 2>&1); rc=$?
code "next for the retired chip exits 9" 9 "$rc"
check "and tells it to end its turn" "You were retired: end this turn with one line, commit nothing, start nothing." "$out"
out=$(CLAUDE_CODE_SESSION_ID=sess-w3 sh "$fleet" paused "$R" 03 2>&1); rc=$?
code "paused for a retired chip exits 9" 9 "$rc"
check "and says the same, not 'commit'" "You were retired" "$out"
ls "$pc"/makarasty/paused/*.retired >/dev/null 2>&1 && ok "handback writes the second kind of global marker" || bad "handback writes the second kind of global marker" "$(ls "$pc/makarasty/paused" 2>&1)"
o=$(hp "$MEM" sess-w3 Bash "git status")
check "the retired worker's hook refuses even git" "2 RETIRED" "$o"
o=$(hp "$CON" sess-w3 Edit '{"file_path":"/x/a.txt","old_string":"a","new_string":"b"}')
check "and an edit" "2 RETIRED" "$o"
check "with the one-line instruction" "end this turn with one line, commit nothing, start nothing" "$o"
o=$(hp "$MEM" sess-zz Bash "npm test")
check "a session that is not a worker is untouched by a retirement" "0 " "$o"
out=$(sh "$fleet" drained "$R" 03 repo 2>&1); rc=$?
code "drained for the retired chip exits 9" 9 "$rc"
[ -e "$R/03.done" ] && bad "and writes no .done" || ok "and writes no .done"
case "$out" in *"CLOSE YOUR BROWSER PANE"*) bad "and prints no pane line first" "$out";; *) ok "and prints no pane line first";; esac
check "the first relaunch call stops for STATE.md with an instruction" "STATE.md NOT CURRENT" "$(sh "$fleet" relaunch "$R" --wait 0 03 2>&1)"
sleep 1; printf '# state\n' > "$R/STATE.md"
out=$(sh "$fleet" relaunch "$R" --wait 0 03 2>&1); rc=$?
code "with STATE.md written after the pause, relaunch prints the chips" 0 "$rc"
check "the second call does not wait for the acks again" "acks: 0 of 2 (not waited again)" "$out"
case "$out" in *"NOT STOPPED"*|*"waiting for:"*) bad "and prints no wait" "$out";; *) ok "and prints no wait";; esac
check "a fresh worker numbered after the highest offered" "CHIP 05" "$out"
check "titled like every worker" "title: fleet r1 05" "$out"
check "for the lane the retired one had" "lane repo" "$out"
check "and one coordinator chip" "title: fleet r1 coordinator" "$out"
check "whose prompt reads STATE.md in full" "STATE.md in full" "$out"
check "and takes the seat with --take-over" "resume $(cd "$R" && { pwd -W 2>/dev/null || pwd; }) --take-over" "$out"
check "then 3b and 8b of fleet-plan" "sections 3b and 8b of the makarasty fleet-plan command" "$out"
check "then resumes the run" "resume $(cd "$R" && { pwd -W 2>/dev/null || pwd; })" "$out"
check "and arms the watch with every chip ever offered" "arm /makarasty:fleet-wait r1 3" "$out"
check "the closing steps name TaskStop" "TaskStop" "$out"
check "and say STATE.md was checked against the handbacks" "newer than the pause and the handbacks" "$out"
check "and the order to click" "click the coordinator chip first, then the worker chips" "$out"
check "05 is recorded as offered" "repo" "$(cat "$R/offered/05" 2>/dev/null)"
out2=$(sh "$fleet" relaunch "$R" --wait 0 03 2>&1)
case "$out2" in *"CHIP 05"*) ok "run again, the same chip has the same replacement";; *) bad "run again, the same chip has the same replacement" "$out2";; esac
case "$out2" in *"CHIP 06"*) bad "and no second replacement is minted" "$out2";; *) ok "and no second replacement is minted";; esac
out=$(sh "$fleet" relaunch "$R" --wait 0 2>&1); rc=$?
code "with no chips only the coordinator is replaced" 0 "$rc"
check "the coordinator chip is printed" "title: fleet r1 coordinator" "$out"
case "$out" in *"CHIP 06"*) bad "and no worker chip" "$out";; *) ok "and no worker chip";; esac
sh "$fleet" relaunch "$R" --wait x 2>/dev/null; rc=$?
code "a wait that is not minutes is refused" 2 "$rc"
sh "$fleet" relaunch "$R" --wait 0 09 2>/dev/null; rc=$?
code "and so is a chip that was never offered" 2 "$rc"
out=$(sh "$fleet" relaunch "$R" 1 --wait 1 2>&1); rc=$?
code "a bare number before --wait is not a chip: it retired chip 01 once" 2 "$rc"
check "and the refusal says chips are two digits" "Chips are two digits" "$out"
[ -e "$R/01.retired" ] && bad "and retires nothing" "01.retired exists" || ok "and retires nothing"
sh "$fleet" relaunch "$R" --wait 1 3 2>/dev/null; rc=$?
code "nor is a one-digit chip after it" 2 "$rc"
sh "$fleet" relaunch "$R" --keep-coordinator --wait 0 2>/dev/null; rc=$?
code "--keep-coordinator with no chip is refused" 2 "$rc"

out=$(CLAUDE_CODE_SESSION_ID=sess-op sh "$fleet" resume "$R" 2>&1)
check "a plain resume from some other chat lifts the pause" "RESUMED r1" "$out"
check "and says the seat is waiting for --take-over" "coordinator-pending is set: the fresh coordinator takes the seat with:" "$out"
grep -q sess-op "$R/coordinator" 2>/dev/null && bad "and does not take the coordinator seat" "$(cat "$R/coordinator")" || ok "and does not take the coordinator seat"
[ -e "$R/coordinator-pending" ] && ok "coordinator-pending is still waiting" || bad "coordinator-pending is still waiting"
out=$(CLAUDE_CODE_SESSION_ID=sess-new sh "$fleet" resume "$R" --take-over 2>&1)
check "only resume --take-over takes the seat" "this session is now the coordinator" "$out"
check "recorded in the coordinator file" "sess-new" "$(cat "$R/coordinator" 2>/dev/null)"
[ -e "$R/coordinator-pending" ] && bad "and clears coordinator-pending" || ok "and clears coordinator-pending"
sh "$fleet" resume "$R" --bogus >/dev/null 2>&1; rc=$?
code "an unknown resume flag is refused" 2 "$rc"
o=$(hp "$MEM" sess-w3 Bash "git status")
check "after the resume the retired worker is still held" "2 RETIRED" "$o"
# R2-5: until the run lands, or its directory is gone.
touch "$R/FINISHED"
o=$(hp "$MEM" sess-w3 Bash "git status")
check "a finished run holds no retired worker" "0 " "$o"
rm -f "$R/FINISHED"
mv "$R" "$R.moved"
o=$(hp "$MEM" sess-w3 Bash "git status")
check "nor does a run directory that is gone" "0 " "$o"
mv "$R.moved" "$R"
o=$(hp "$MEM" sess-w3 Bash "git status")
check "while a standing run still does" "2 RETIRED" "$o"
o=$(hp "$MEM" sess-w4 Bash "npm test")
check "while a worker that was not replaced is free" "0 " "$o"
out=$(CLAUDE_CODE_SESSION_ID=sess-new sh "$fleet" paused "$R" 05 2>&1); rc=$?
code "and the new coordinator cannot acknowledge a pause" 2 "$rc"
out=$(CLAUDE_CODE_SESSION_ID=sess-w5 sh "$fleet" next "$R" 05 repo 2>&1)
check "the fresh worker claims the re-filed task" "CLAIMED t-a-r1" "$out"
check "whose body says where to continue from" "continue-from: fleet/03/t-a" "$out"
sh "$fleet" finish "$R" 05 t-a-r1 >/dev/null 2>&1
sh "$fleet" finish "$R" 04 t-b >/dev/null 2>&1
out=$(sh "$fleet" next "$R" 05 repo 2>&1)
check "t-c, which waited on t-a, opens once t-a-r1 is done" "CLAIMED t-c" "$out"
sh "$fleet" finish "$R" 05 t-c >/dev/null 2>&1
sh "$fleet" drained "$R" 04 repo >/dev/null 2>&1; sh "$fleet" drained "$R" 05 repo >/dev/null 2>&1
: > "$R/backlog.jsonl"
out=$(sh "$fleet" landed "$R" 3 2>&1); rc=$?
code "landed passes on a run that went through a relaunch" 0 "$rc"
check "counting the retired chip as finished" "LANDED: 3 workers" "$out"
ls "$pc"/makarasty/paused/*.retired >/dev/null 2>&1 && bad "landed removes the retired marker" "$(ls "$pc/makarasty/paused")" || ok "landed removes the retired marker"
out=$(sh "$fleet" status "$R" 2>&1)
check "status marks the retired worker" "RETIRED" "$out"

echo "== relaunch --keep-coordinator: unsaved work, the branch, the proof"
K=$pr/.fleet/k1; mkdir -p "$K/tasks/ready" "$K/worktrees"
for t in t-k1 t-k2 t-k3; do printf -- '---\ntask-id: %s\nneeds: repo\nkind: fix\nbudget: 10\n---\nwork\n' "$t" > "$K/tasks/ready/$t.md"; done
sh "$fleet" chips "$K" 01-02 repo >/dev/null 2>&1
CLAUDE_CODE_SESSION_ID=sess-k1 sh "$fleet" next "$K" 01 repo >/dev/null 2>&1
CLAUDE_CODE_SESSION_ID=sess-k2 sh "$fleet" next "$K" 02 repo >/dev/null 2>&1
CLAUDE_CODE_SESSION_ID=sess-k4 sh "$fleet" next "$K" 04 repo >/dev/null 2>&1
mkwt() { # mkwt <dir> <branch|detach> - a tree with one commit and one unsaved file
  mkdir -p "$1" && ( cd "$1" && git init -q . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init \
    && if [ "$2" = detach ]; then git checkout -q --detach; else git checkout -q -b "$2"; fi && echo unsaved > unsaved.txt ) >/dev/null 2>&1
}
mkwt "$pr/wtk1" fleet/01/t-k1; printf 'path %s\nbranch fleet/01/t-k1\nchip 01\n' "$pr/wtk1" > "$K/worktrees/01"
mkwt "$pr/wtk2" detach;        printf 'path %s\nchip 02\n' "$pr/wtk2" > "$K/worktrees/02"
mkwt "$pr/wtk4" feature/x;     printf 'path %s\nchip 04\n' "$pr/wtk4" > "$K/worktrees/04"
printf '{"phase":"before","exit":1,"cmd":"npm test -- login"}\n{"phase":"after","exit":0,"cmd":"npm test -- login"}\n' > "$K/tasks/claimed/t-k1/proof"
out=$(sh "$fleet" relaunch "$K" --keep-coordinator --wait 0 01 2>&1); rc=$?
code "keep-coordinator: the first call stops for STATE.md" 1 "$rc"
check "after handing the chip's work back" "HANDED BACK 01" "$out"
check "committing what the worker never saved" "COMMITTED the unsaved work of 01 on fleet/01/t-k1 as 'wip: handed back'" "$out"
check "and listing the files" "unsaved.txt" "$out"
[ "$(git -C "$pr/wtk1" log -1 --format=%s 2>/dev/null)" = "wip: handed back" ] && ok "the commit is on the task branch" || bad "the commit is on the task branch" "$(git -C "$pr/wtk1" log -1 --format=%s 2>&1)"
[ -z "$(git -C "$pr/wtk1" status --porcelain 2>/dev/null)" ] && ok "and the tree is clean" || bad "and the tree is clean"
grep -q '^continue-from: fleet/01/t-k1$' "$K/tasks/ready/t-k1-r1.md" && grep -q '^continued-from-chip: 01$' "$K/tasks/ready/t-k1-r1.md" && grep -q '^handback-of: t-k1$' "$K/tasks/ready/t-k1-r1.md" \
  && ok "the new task carries continue-from, continued-from-chip and handback-of" || bad "the new task carries continue-from, continued-from-chip and handback-of" "$(cat "$K/tasks/ready/t-k1-r1.md" 2>&1)"
sleep 1; printf '# state\n' > "$K/STATE.md"
out=$(sh "$fleet" relaunch "$K" --keep-coordinator --wait 0 01 2>&1); rc=$?
code "keep-coordinator: the same command again prints" 0 "$rc"
check "and does not wait for the acks again" "acks: 0 of 1 (not waited again)" "$out"
check "a fresh worker chip numbered after the highest offered" "CHIP 03" "$out"
case "$out" in *"title: fleet k1 coordinator"*) bad "and no coordinator chip" "$out";; *) ok "and no coordinator chip";; esac
[ -e "$K/coordinator-pending" ] && bad "and no coordinator-pending" || ok "and no coordinator-pending"
[ -e "$K/PAUSED" ] && bad "and the run is resumed by the call itself" || ok "and the run is resumed by the call itself"
check "saying the same coordinator carries on" "(same coordinator)" "$out"
check "and to re-arm the watch with the new count, which counts the retired chip" "arm /makarasty:fleet-wait k1 3" "$out"
out=$(CLAUDE_CODE_SESSION_ID=sess-k3 sh "$fleet" next "$K" 03 repo 2>&1)
check "the fresh worker claims the re-filed task" "CLAIMED t-k1-r1" "$out"
grep -q '"phase":"after"' "$K/tasks/claimed/t-k1-r1/proof" 2>/dev/null && bad "the old after is not carried over: the fresh worker proves its own tree" "$(cat "$K/tasks/claimed/t-k1-r1/proof" 2>&1)" || ok "the old after is not carried over: the fresh worker proves its own tree"
grep -q '"phase":"before"' "$K/tasks/claimed/t-k1-r1/proof" 2>/dev/null && ok "with the old claim's fix proof copied in" || bad "with the old claim's fix proof copied in" "$(cat "$K/tasks/claimed/t-k1-r1/proof" 2>&1)"
out=$(sh "$fleet" handback "$K" 02 2>&1)
check "a worktree on a detached HEAD gets a branch first" "was on a detached HEAD: its work is now on branch fleet/02/t-k2-handback" "$out"
check "the unsaved work is committed there" "COMMITTED the unsaved work of 02 on fleet/02/t-k2-handback" "$out"
grep -q '^continue-from: fleet/02/t-k2-handback$' "$K/tasks/ready/t-k2-r1.md" && ok "and the new task continues from it" || bad "and the new task continues from it" "$(cat "$K/tasks/ready/t-k2-r1.md" 2>&1)"
out=$(sh "$fleet" handback "$K" 04 2>&1)
check "a tree on some other branch is committed too" "COMMITTED the unsaved work of 04 on feature/x" "$out"
check "but the new task gets no continue-from, and says so" "WARNING: 04 has no registered worktree on fleet/04/t-k3 (it is on feature/x)" "$out"
grep -q '^continue-from:' "$K/tasks/ready/t-k3-r1.md" && bad "continue-from only for the task's own branch" "$(cat "$K/tasks/ready/t-k3-r1.md")" || ok "continue-from only for the task's own branch"
grep -q '^continued-from-chip: 04$' "$K/tasks/ready/t-k3-r1.md" && ok "while the chip whose notes to read is still named" || bad "while the chip whose notes to read is still named"
mkdir -p "$pr/wtk5"; ( cd "$pr/wtk5" && git init -q . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init && git checkout -q -b fleet/05/zz && echo y > y.txt ) >/dev/null 2>&1
printf -- '---\ntask-id: t-k5\nneeds: repo\nbudget: 10\n---\nwork\n' > "$K/tasks/ready/t-k5.md"; mkdir -p "$K/tasks/claimed/t-k5"; printf 'chip 05\nclaimed now\n' > "$K/tasks/claimed/t-k5/owner"
printf 'path %s\nchip 05\n' "$pr/wtk5" > "$K/worktrees/05"
out=$(GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null HOME=$pr/nohome sh "$fleet" handback "$K" 05 2>&1)
check "a commit with no git identity configured still lands" "COMMITTED the unsaved work of 05" "$out"

echo "== contexts"
cx=$pr/.fleet/c1; mkdir -p "$cx/chips" "$cx/tasks/claimed/t-x" "$cx/tasks/done"
printf 'chip 04\nclaimed now\n' > "$cx/tasks/claimed/t-x/owner"
printf 'sess-co\n' > "$cx/coordinator"
printf '04' > "$cx/chips/sess-w4"; printf '04' > "$cx/chips/sess-old"; printf '05' > "$cx/chips/sess-w5"
touch -t 202001010000 "$cx/chips/sess-old" 2>/dev/null
printf '04 x' > "$cx/chips/sess-w4.warned-t-x"; printf 'm' > "$cx/chips/04.model"
mkdir -p "$pc/projects/p"
tr_() { printf '{"type":"assistant","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":%s}}}\n' "$2" > "$pc/projects/p/$1.jsonl"; }
tr_ sess-co $((CK * 1000)); tr_ sess-w4 $((WK * 1000)); tr_ sess-old 990000; tr_ sess-w5 120000
out=$(sh "$fleet" contexts "$cx" 2>&1); rc=$?
code "contexts exits 0" 0 "$rc"
check "the coordinator line carries its context and OVER" "${CK}K  OVER (mark ${HAT}K)" "$out"
check "a worker over the mark is OVER, with its claim" "worker 04  sess-w4  ${WK}K  holds t-x  OVER (mark ${WAT}K)" "$out"
check "a worker under it is not, and holds nothing" "worker 05  sess-w5  120K  no claim" "$out"
if printf '%s
' "$out" | grep 'worker 05' | grep -q OVER; then bad "and carries no OVER" "$out"; else ok "and carries no OVER"; fi
case "$out" in *sess-old*|*900K*) bad "a reopened chip's older session is not read" "$out";; *) ok "a reopened chip's older session is not read";; esac
out=$(sh "$fleet" ctx "$cx" 2>&1)
check "ctx speaks for the coordinator" "COORDINATOR CONTEXT ${CK}K" "$out"
check "and for a worker past worker_relaunch_k, naming the chip" "WORKER CONTEXT 04 ${WK}K (mark ${WAT}K, holds t-x)" "$out"
case "$out" in *"WORKER CONTEXT 05"*) bad "and not for one under it" "$out";; *) ok "and not for one under it";; esac
case "$out" in *"relaunch in fleet-plan"*|*"fleet-plan, 8b"*) ok "both point at the relaunch in fleet-plan 8b" ;; *) bad "both point at the relaunch in fleet-plan 8b" "$out";; esac
case "$out" in *makarasty-tools:handoff*) bad "and neither sends a fleet coordinator to a handoff chip" "$out";; *) ok "and neither sends a fleet coordinator to a handoff chip";; esac
out=$(sh "$fleet" ctx "$cx" 2>&1)
[ -z "$out" ] && ok "each only once per mark" || bad "each only once per mark" "$out"
tr_ sess-w4 120000
out=$(sh "$fleet" ctx "$cx" 2>&1)
tr_ sess-w4 $((WK * 1000))
out=$(sh "$fleet" ctx "$cx" 2>&1)
check "a worker that fell back under the mark is named again when it crosses" "WORKER CONTEXT 04" "$out"
: > "$cx/05.done"
tr_ sess-w5 900000
out=$(sh "$fleet" ctx "$cx" 2>&1)
case "$out" in *"WORKER CONTEXT 05"*) bad "a finished worker is never named" "$out";; *) ok "a finished worker is never named";; esac
check "the context marks are in calibration.json: coordinator, step and worker" '"coordinator_handoff_k": 700,
  "coordinator_handoff_step_k": 100,
  "worker_relaunch_k": 700,' "$(cat "$here/../calibration.json")"
check "with the operator's provenance" '"worker_relaunch_k": "operator, 2026-10-06' "$(cat "$here/../calibration.json")"
check "and the 150 s a worker may take to answer a pause" '"pause_still_working_seconds": 150' "$(cat "$here/../calibration.json")"

CLAUDE_CONFIG_DIR=${TMPDIR:-/tmp}/fleet-cfg-$$; export CLAUDE_CONFIG_DIR
rm -rf "$pr"

echo "== brief workers are registered too"
bw=${TMPDIR:-/tmp}/fleet-bw-$$
mkdir -p "$bw/tasks/ready"; printf -- '---
brief
---
' > "$bw/brief-01.md"
CLAUDE_CODE_SESSION_ID=sess-brief sh "$fleet" whoami "$bw" 01 m x >/dev/null 2>&1
[ "$(cat "$bw/chips/sess-brief" 2>/dev/null)" = 01 ] && ok "a brief worker's whoami registers its session for the pause hooks" || bad "a brief worker's whoami registers its session for the pause hooks" "$(ls "$bw/chips" 2>&1)"
out=$(CLAUDE_CONFIG_DIR=$bw/cfg sh "$fleet" pause "$bw" 2>&1)
check "the pause counts a registered brief worker as holding work" "1 worker(s) hold claims: 01" "$out"
touch "$bw/01.done"
out=$(CLAUDE_CONFIG_DIR=$bw/cfg sh "$fleet" pause "$bw" 2>&1)
check "and stops counting it once it is done" "0 worker(s) hold claims" "$out"
CLAUDE_CODE_SESSION_ID=sess-reg CLAUDE_CONFIG_DIR=$bw/cfg sh "$fleet" whoami "$bw" 02 m x >/dev/null 2>&1
[ -s "$bw/cfg/makarasty/fleet-sessions/sess-reg" ] && ok "a registered worker is recorded for the context hook" || bad "a registered worker is recorded for the context hook" "$(ls "$bw/cfg/makarasty" 2>&1)"

echo "== file, stranded, and what status names"
fr=${TMPDIR:-/tmp}/fleet-fr-$$
mkdir -p "$fr/tasks/ready" "$fr/tasks/done" "$fr/offered" "$fr/chips"
out=$(printf -- '---\ntask-id: a1\nneeds: repo\noperator: grant the role\n---\nx\n' | sh "$fleet" file "$fr" a1 2>&1); rc=$?
code "file exits 0 on a good task" 0 "$rc"
check "and says FILED with its lane" "FILED a1 lane repo" "$out"
check "and says a task waiting on the operator is asked now" "waits on the operator" "$out"
printf -- '---\nneeds: repo\nafter: a1\n---\n' | sh "$fleet" file "$fr" b1 >/dev/null 2>&1
printf -- '---\nneeds: repo\nafter: b1\n---\n' | sh "$fleet" file "$fr" c1 >/dev/null 2>&1
out=$(printf -- '---\nneeds: repo\nafter: a1, zz\n---\n' | sh "$fleet" file "$fr" d1 2>&1)
check "an after: naming nothing filed is noted" "names a task not filed yet: zz" "$out"
out=$(printf -- '---\nneeds: opus\n---\n' | sh "$fleet" file "$fr" e1 2>&1); rc=$?
code "a lane that is a model is refused" 2 "$rc"
[ ! -e "$fr/tasks/ready/e1.md" ] && ok "and nothing is filed" || bad "and nothing is filed"
out=$(printf -- '---\nneeds: repo\n---\n' | sh "$fleet" file "$fr" a1 2>&1); rc=$?
code "a used id is refused" 2 "$rc"
out=$(printf -- '---\nneeds: repo\n---\ncaf\351\n' | sh "$fleet" file "$fr" u1 2>&1); rc=$?
code "a cp1252 file is refused" 2 "$rc"
check "as not UTF-8" "not valid UTF-8" "$out"
out=$(printf -- '---\ntask-id: q\nneeds: repo\n---\n' | sh "$fleet" file "$fr" q2 2>&1)
check "a task-id: that disagrees is refused" "says 'q', not 'q2'" "$out"
out=$(printf 'needs: repo\n' | sh "$fleet" file "$fr" n1 2>&1)
check "a file with no frontmatter is refused" "does not start with a --- frontmatter" "$out"
ls "$fr"/tasks/.filing-* >/dev/null 2>&1 && bad "a refused filing leaves no temp file" || ok "a refused filing leaves no temp file"
printf 'repo\n' > "$fr/offered/05"; printf 'repo\n' > "$fr/offered/06"
printf 'opus high plugin 0.0.1\n' > "$fr/chips/05.model"; printf '06' > "$fr/chips/sess-06"
out=$(sh "$fleet" status "$fr" 2>&1)
check "status starts with the machine's clock" "== now $(date '+%Y-%m-%d')" "$out"
check "names a task three open tasks wait behind" "a1: 3 open task(s) wait behind it, ready, unclaimed, WAITS ON THE OPERATOR" "$out"
check "and lists what the operator must do" "a1: grant the role (3 behind it" "$out"
check "names a worker on another plugin version" "OTHER PLUGIN: worker 05 runs makarasty 0.0.1" "$out"
check "and one that started and never ran whoami" "never ran whoami" "$out"
check "an after: naming nothing is a wait for ever" "d1: after: zz, which is neither filed nor done" "$out"
printf -- '---\nneeds: repo\n---\nbody\noperator: not in the frontmatter\n' > "$fr/tasks/ready/h1.md"
printf -- '---\nneeds: opus\n---\n' > "$fr/tasks/ready/h2.md"
out=$(sh "$fleet" status "$fr" 2>&1)
case "$out" in *"h1: not in"*) bad "an operator: line in the body is prose" "$out";; *) ok "an operator: line in the body is prose";; esac
check "a hand-written task with a model for a lane is named" "h2: needs: \"opus\" is not pane, repo or verify" "$out"
rm -f "$fr/tasks/ready/h1.md" "$fr/tasks/ready/h2.md"
out=$(sh "$fleet" next "$fr" 09 repo 2>&1); rc=$?
code "next holds a task the operator owes and the tasks after it" 7 "$rc"
out=$(sh "$fleet" cleared "$fr" a1 2>&1)
check "cleared says so" "CLEARED a1" "$out"
[ -z "$(grep '^operator:' "$fr/tasks/ready/a1.md")" ] && ok "and removes the line" || bad "and removes the line" "$(cat "$fr/tasks/ready/a1.md")"
out=$(sh "$fleet" next "$fr" 09 repo 2>&1)
check "then next hands it out" "a1" "$out"
printf 'repo\n' > "$fr/offered/08"; printf '08' > "$fr/chips/sess-08"; printf 'opus high plugin 0.0.1\n' > "$fr/chips/08.model"
out=$(sh "$fleet" ctx "$fr" 2>&1)
check "the watch names a worker on an older plugin, for the one relaunch ask" "WORKER PLUGIN 08 runs makarasty 0.0.1" "$out"
out=$(sh "$fleet" ctx "$fr" 2>&1)
case "$out" in *"WORKER PLUGIN 08"*) bad "once" "$out";; *) ok "once";; esac
printf 'opus high\n' > "$fr/chips/06.model"
out=$(sh "$fleet" status "$fr" 2>&1)
check "a 1.5.8 or 1.5.9 record, with no version, is named older" "OTHER PLUGIN: worker 06 runs makarasty 1.5.8 or 1.5.9" "$out"
CLAUDE_CODE_SESSION_ID=sess-v sh "$fleet" whoami "$fr" 07 m x >/dev/null 2>&1
check "whoami records the plugin version" "plugin $(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$here/../.claude-plugin/plugin.json")" "$(cat "$fr/chips/07.model")"
g=$fr/repo; git init -q -b int "$g" && git -C "$g" -c user.name=t -c user.email=t@t commit -q --allow-empty -m root
git -C "$g" switch -q -c b1 && git -C "$g" -c user.name=t -c user.email=t@t commit -q --allow-empty -m w1
git -C "$g" switch -q int && git -C "$g" -c user.name=t -c user.email=t@t merge -q --no-ff --no-edit b1
git -C "$g" switch -q b1 && git -C "$g" -c user.name=t -c user.email=t@t commit -q --allow-empty -m late
git -C "$g" switch -q -c b2 int && git -C "$g" -c user.name=t -c user.email=t@t commit -q --allow-empty -m w2
git -C "$g" switch -q -c b3 int && git -C "$g" switch -q int && git -C "$g" -c user.name=t -c user.email=t@t merge -q --no-ff b2 -m m2
mkdir -p "$fr/worktrees"; printf 'path %s\n' "$g" > "$fr/worktrees/integration"
printf 'branch b1\n' > "$fr/tasks/done/t1"; printf 'branch b2\n' > "$fr/tasks/done/t2"
git -C "$g" switch -q -c b4 int && git -C "$g" -c user.name=t -c user.email=t@t commit -q --allow-empty -m w4 && git -C "$g" switch -q int
printf 'branch b4\n' > "$fr/tasks/done/t4"
git -C "$g" switch -q -c b5 int && git -C "$g" -c user.name=t -c user.email=t@t commit -q --allow-empty -m w5
printf 'branch b5
tip %s
' "$(git -C "$g" rev-parse b5)" > "$fr/tasks/done/t5"
git -C "$g" switch -q int && git -C "$g" -c user.name=t -c user.email=t@t merge -q --no-ff b5 -m "squashed-looking message"
git -C "$g" switch -q b5 && git -C "$g" -c user.name=t -c user.email=t@t commit -q --allow-empty -m late5 && git -C "$g" switch -q int
git -C "$g" branch -q gone6 int && printf 'branch gone6
' > "$fr/tasks/done/t6" && git -C "$g" branch -q -D gone6
git -C "$g" branch -q rm/t7 b4 && : > "$fr/tasks/done/t7"
out=$(sh "$fleet" stranded "$fr" 2>&1)
check "stranded names a commit made after the merge" "STRANDED t1: branch b1 was merged, then got 1 more" "$out"
check "and a branch never merged as not merged" "not merged t4: branch b4, 1 commit(s)" "$out"
case "$out" in *t2*) bad "and stays quiet about a branch fully merged" "$out";; *) ok "and stays quiet about a branch fully merged";; esac
check "the tip finish recorded proves a merge whatever the merge message says" "STRANDED t5: branch b5 was merged, then got 1 more" "$out"
check "a deleted branch is counted, not listed" "1 done task branch(es) no longer exist" "$out"
check "a marker with no branch line is matched by its task id" "not merged t7: branch rm/t7" "$out"
lr=${TMPDIR:-/tmp}/fleet-lr-$$; mkdir -p "$lr/run/tasks/ready" "$lr/cfg/makarasty/fleet-sessions"; : > "$lr/run/backlog.jsonl"
printf '%s\n' "$(cd "$lr/run" && { pwd -W 2>/dev/null || pwd; })" > "$lr/cfg/makarasty/fleet-sessions/sx"
printf '%s\n' "/some/other/run" > "$lr/cfg/makarasty/fleet-sessions/sy"
out=$(CLAUDE_CONFIG_DIR=$lr/cfg sh "$fleet" landed "$lr/run" 0 2>&1)
[ ! -e "$lr/cfg/makarasty/fleet-sessions/sx" ] && [ -e "$lr/cfg/makarasty/fleet-sessions/sy" ] && ok "landed removes this run's session records and no other run's" || bad "landed removes this run's session records and no other run's" "$out"
CLAUDE_CODE_SESSION_ID=sess-c CLAUDE_CONFIG_DIR=$lr/cfg sh "$fleet" chips "$lr/run" 01 repo >/dev/null 2>&1
[ -s "$lr/cfg/makarasty/fleet-sessions/sess-c" ] && ok "chips records the coordinator for the context hook" || bad "chips records the coordinator for the context hook" "$(ls "$lr/cfg/makarasty/fleet-sessions")"
rm -rf "$lr"
rm -rf "$fr"
CLAUDE_CODE_SESSION_ID=sess-coord sh "$fleet" find "$bw" integration </dev/null >/dev/null 2>&1 || true
[ ! -e "$bw/chips/sess-coord" ] && ok "the coordinator's integration tree is never registered as a worker" || bad "the coordinator's integration tree is never registered as a worker" "$(cat "$bw/chips/sess-coord")"
rm -rf "$bw"
rm -rf "$tmp"
rm -f "$loadstub"
echo "$pass passed, $fail failed"
rm -rf "${TMPDIR:-/tmp}/fleet-cfg-$$"
if [ "${1:-}" = "--keep" ]; then echo "run directory kept: $run"; else rm -rf "$run"; fi
[ "$fail" = 0 ] || exit 1
