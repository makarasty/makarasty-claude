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
code "a second worker is refused while that lane is held" 3 "$rc"
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
# must not become a constant. Newest wins, hence the future stamp.
calrun="${TMPDIR:-/tmp}/fleet-cal-$$"; mkdir -p "$calrun/scripts" "$calrun/run/tasks/ready"
cp "$fleet" "$calrun/scripts/fleet.sh"
cat > "$calrun/calibration.json" <<'CAL'
{
  "budget_multiplier": 3,
  "clock_poll_seconds": 7,
  "_provenance": { "clock_poll_seconds": "a sentence carrying 99, which is not a constant" }
}
CAL
touch -t 203012312359 "$calrun/calibration.json" 2>/dev/null
out=$(sh "$calrun/scripts/fleet.sh" clock "$calrun/run" 07 task-01 20 2>&1)
check "a calibrated multiplier and poll interval are both read from the file" "-lt $(( 20 * 3 * 60 / 7 ))" "$out"
check "and the poll is the file's, not the built-in default" "sleep 7;" "$out"
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
code "a task waiting on an unfinished dependency is not handed out" 3 "$rc"
check "and the worker is told to poll rather than that the queue is empty" "QUEUE WAITING" "$out"
check "naming how many tasks are held" "1 task(s) held" "$out"
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
rm -f "$run/tasks/released/task-89.md" "$run/chips/sess-alive" "$run/chips/sess-gone" "$run/chips/sess-still-running"
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
  sed -i '$d' "$run/07.jsonl" 2>/dev/null || true
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
  printf '## F02-1 · Northwind refuses a third of the second checks\n- how known: measured\n- evidence: select count(*) over 2026-07-24..08-12\n- when: 2020-01-01\n\n## F02-2 · the retry helps\n- how known: guess\n- evidence: nobody checked\n- when: 2026-08-20\n' > "$ldir/call/facts/02-northwind.md"
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
  check "a clean worktree is removed" "removed" "$out"
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
    if [ -f "$wl/main/victimNested/keep.txt" ]; then ok "a junction nested below the top level is unlinked, not followed"
    else bad "a junction nested below the top level is unlinked, not followed" "the target was deleted through it"; fi
  else
    echo "  skip  could not create a nested junction on this host"
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
  hp="${TMPDIR:-/tmp}/fleet-contract-$"
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
  mrun="${TMPDIR:-/tmp}/fleet-merge-$/2026-09-08-full-audit"; mkdir -p "$mrun"
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
  rm -rf "${TMPDIR:-/tmp}/fleet-merge-$"
else
  echo "  skip  no fleet-merge.mjs or no node"
fi

echo
echo "the retro, and which run a session belongs to"

rt="$here/fleet-retro.mjs"
if [ -f "$rt" ] && command -v node >/dev/null 2>&1; then
  rdir="${TMPDIR:-/tmp}/fleet-retro-$"; mkdir -p "$rdir/tx" "$rdir/.fleet/2026-09-08-full-audit/chips"
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
  sdir="${TMPDIR:-/tmp}/fleet-seed-$"; mkdir -p "$sdir/src" "$sdir/design" "$sdir/skill"
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
  check "and the worker is told how to record one" "prove r t1 before" "$out"
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
  out=$( cd "$mt" && sh scripts/fleet.sh next r 07 repo 2>&1 ); rc=$?
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
  out=$( cd "$mt" && sh scripts/fleet.sh next r 07 repo 2>&1 ); rc=$?
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
  unset FLEET_LOAD

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
  unset FLEET_LOAD
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
bad_glob=$(grep -rn "ls -d?t ~/.claude/plugins/cache" "$here/../commands" "$here/../docs" 2>/dev/null | grep -cv "||" | tr -d " ")
if [ "${bad_glob:-0}" = 0 ]; then
  ok "no document resolves this plugin by modification time"
else
  bad "no document resolves this plugin by modification time" "$bad_glob line(s) still do"
fi

if grep -rq "installed_plugins.json" "$here/../commands" 2>/dev/null; then
  ok "and the commands ask the host's own record instead"
else
  bad "and the commands ask the host's own record instead" "no command reads installed_plugins.json"
fi

# `beside` must return the copy next to the script, whatever any cache holds.
bs=$tmp/beside/scripts
mkdir -p "$bs"
cp "$here/fleet.sh" "$bs/"
printf 'marker\n' > "$bs/fleet-load.mjs"
out=$(cd "$tmp/beside" && sh scripts/fleet.sh 2>&1 | head -1)
check "fleet.sh still runs from a copy anywhere" "usage: fleet.sh" "$out"
rm -rf "$tmp/beside"

rm -rf "$tmp"
echo "$pass passed, $fail failed"
if [ "${1:-}" = "--keep" ]; then echo "run directory kept: $run"; else rm -rf "$run"; fi
[ "$fail" = 0 ] || exit 1
