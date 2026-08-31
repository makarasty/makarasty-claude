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
mult=2
if command -v node >/dev/null 2>&1; then
  _cal=$(ls -t "$here/../calibration.json" 2>/dev/null | head -1)
  [ -n "$_cal" ] && mult=$(node -e 'try{const v=require(process.argv[1]).budget_multiplier;if(typeof v==="number")console.log(v)}catch{}' "$_cal" 2>/dev/null)
  [ -n "$mult" ] || mult=2
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

echo
echo "clocks that disarm themselves"

out=$(sh "$fleet" clock "$run" 07 task-02 20 2>&1); rc=$?
code "a clock is printed for the worker to background" 0 "$rc"
check "it watches for its own task closing" "tasks/done/task-02" "$out"
check "and for its worker finishing" "07.done" "$out"
check "and it speaks only if the budget really elapsed" "echo budget-elapsed-task-02" "$out"
rounds=$(printf '%s' "$out" | grep -o -- '-lt [0-9][0-9]*' | head -1 | tr -dc 0-9)
want_rounds=$(( 20 * mult * 60 / 30 ))
[ "$rounds" = "$want_rounds" ] && ok "a 20 minute budget at the configured multiplier, in 30 second rounds" || bad "a 20 minute budget at the configured multiplier, in 30 second rounds" "$rounds rounds, wanted $want_rounds"
# The clock exits on the marker rather than on being stopped, so close the task first and let it run its
# whole budget at zero sleep: a clock that still speaks here is one that would wake a finished worker.
sh "$fleet" finish "$run" 07 task-02 >/dev/null 2>&1
( eval "$(printf '%s' "$out" | sed 's/sleep 30/sleep 0/')" ) > "$run/.clockout" 2>&1
if grep -q "budget-elapsed" "$run/.clockout" 2>/dev/null; then
  bad "a closed task silences its clock" "clock still fired"
else
  ok "a closed task silences its clock"
fi

# And the same clock still fires when the task really is open, or it would be a clock that never rings.
task task-09 repo 1
sh "$fleet" next "$run" 07 repo >/dev/null 2>&1
out9=$(sh "$fleet" clock "$run" 07 task-09 1 2>&1)
( eval "$(printf '%s' "$out9" | sed 's/sleep 30/sleep 0/')" ) > "$run/.clockout9" 2>&1
if grep -q "budget-elapsed-task-09" "$run/.clockout9" 2>/dev/null; then
  ok "an open task's clock still rings at twice its budget"
else
  bad "an open task's clock still rings at twice its budget" "$(cat "$run/.clockout9" 2>/dev/null)"
fi
sh "$fleet" finish "$run" 07 task-09 >/dev/null 2>&1

out=$(sh "$fleet" finish "$run" 99 task-01 2>&1); rc=$?
code "a worker cannot close somebody else's claim" 4 "$rc"
check "and is told why" "CLAIM LOST" "$out"

echo
echo "finishing, and the difference between empty and over"

: > "$run/tasks/queue-open"
out=$(sh "$fleet" drained "$run" 07 2>&1); rc=$?
code "an empty queue the planner has not closed does not finish a worker" 5 "$rc"
check "and it is told to poll instead" "Poll again" "$out"
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

echo
echo "sizing the repo lane"

out=$(sh "$fleet" width "$run" 2>&1); rc=$?
code "the width of the repo lane is computed, not retyped" 0 "$rc"
check "and it answers with a number" "REPO_WORKERS" "$out"
check "showing the queue term it came from" "ready repo tasks" "$out"

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
[ -e "$run/tasks/released/task-77.md" ] && ok "the released task leaves the queue with its claim" || bad "the released task leaves the queue with its claim"
[ -e "$run/tasks/ready/task-77.md" ] && bad "and cannot be handed straight back under the same id" "still in ready/" || ok "and cannot be handed straight back under the same id"
out=$(sh "$fleet" finish "$run" 99 task-77 2>&1); rc=$?
code "the worker whose claim was released cannot close the task" 4 "$rc"
out=$(sh "$fleet" landed "$run" 2 2>&1)
check "and the run cannot land over it until somebody accounts for it" "released and never accounted for" "$out"
rm -f "$run/tasks/released/task-77.md"

echo
echo "the hook that sees what no script can"

guard="$here/../hooks/fleet-guard.mjs"
if [ -f "$guard" ] && command -v node >/dev/null 2>&1; then
  mkdir -p "$run/chips"
  printf '{"session_id":"sess-1","cwd":"%s"}' "$(dirname "$run")" > "$run/.hookin"
  node "$guard" < "$run/.hookin" >/dev/null 2>&1; rc=$?
  code "a session with no chip registered is left alone" 0 "$rc"

  # A worker holding an unfinished claim, ending its turn: the failure that cost 516 minutes.
  hookrun="${TMPDIR:-/tmp}/fleet-hook-$$"; mkdir -p "$hookrun/.fleet/r1/chips" "$hookrun/.fleet/r1/tasks/claimed/task-05" "$hookrun/.fleet/r1/tasks/done"
  # The hook is handed whatever spelling the harness uses; on Git Bash that is not the shell's own.
  hookcwd=$(cd "$hookrun" && pwd -W 2>/dev/null || printf '%s' "$hookrun")
  printf '07' > "$hookrun/.fleet/r1/chips/sess-2"
  printf 'chip 07
claimed now
' > "$hookrun/.fleet/r1/tasks/claimed/task-05/owner"
  printf '{"session_id":"sess-2","cwd":"%s"}' "$hookcwd" > "$hookrun/in.json"
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
  printf '{"session_id":"sess-2","cwd":"%s","stop_hook_active":true}' "$hookcwd" > "$hookrun/in2.json"
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

out=$(sh "$fleet" landed "$run" 2 2>&1); rc=$?
code "a finished run lands" 0 "$rc"
[ -e "$run/FINISHED" ] && ok "and leaves the FINISHED file behind as the durable answer" || bad "and leaves the FINISHED file behind as the durable answer"

out=$(sh "$fleet" summary "$run" 2>&1)
check "the run banner carries a machine readable line" "fleet-summary: {" "$out"

echo
echo "$pass passed, $fail failed"
if [ "${1:-}" = "--keep" ]; then echo "run directory kept: $run"; else rm -rf "$run"; fi
[ "$fail" = 0 ] || exit 1
