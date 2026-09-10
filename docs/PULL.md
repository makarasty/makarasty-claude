# Pull mode

The default shape gives each worker one brief and stops when the briefs run out. Pull mode gives the run
a queue instead: workers claim work when they are free, and the planner can add work while they run.

Use it when the surface is larger than the plan. A first plan over a big application is a guess about
where the defects are, and a fixed set of briefs freezes that guess for the whole run. A queue lets the
guess be wrong.

The fleet size stops being a number the planner chooses. It becomes however many panes the operator has
open, and any worker with a live pane can take the next task.

## Layout

```
.fleet/<run-id>/
  tasks/
    ready/     task-07-queue-truncation.md    the work, written by the planner
    claimed/   task-07/                       a DIRECTORY, the claim itself
                 owner            chip id and the time it was taken
                 heartbeat        rewritten at every natural boundary
    done/      task-07                        empty marker, written by the worker
  ask/         03-1.md                        a worker's question for the planner
  answers/     03-1.md                        the planner's reply
  03.jsonl     findings, per worker across every task it took
  03.notes.md  assertions passed, claims refuted, tooling
  03.done      written when the queue is drained, not when one task ends
```

Findings are per worker rather than per task, because a worker's context is what produced them and that is
the unit whose blindness matters.

## Claiming

```bash
mkdir .fleet/<run-id>/tasks/claimed/task-07 2>/dev/null &&
  printf 'chip %s\nclaimed %s\n' "$CHIP" "$(date -Iseconds)" > .fleet/<run-id>/tasks/claimed/task-07/owner
```

`mkdir` fails when the directory exists, and it fails atomically. Verified on NTFS 2026-08-26: eight
concurrent claimers on one task, exactly one succeeded, and every later attempt was refused.

**The claim attempt is also the check.** Walk `tasks/ready/` in order, skipping anything whose `needs:`
line names a lane you are not in, and try to claim each one that remains. The first success is your task.

Failing every one of them means your lane is drained, which is **not** the same as the run being over.
While `tasks/queue-open` exists the planner still intends to file work, so poll (`sleep 300; echo recheck`)
rather than finishing.

A task can also be **gated**: `after: <task-id>` in its frontmatter holds it until that task's done marker
exists, which is how a mission with waves keeps wave three out of wave two's files without asking anybody
to remember the order. `next` says `QUEUE WAITING` rather than `QUEUE DRAINED` when that is why it handed
you nothing, and the two mean opposite things - a gated queue opens again on its own, so poll it. Write `<chip>.done` only once that marker is gone: a session that ends cannot be
reopened, and a queue that grows after its workers have closed has nobody left to work it.

**Never delete or move the ready file.** The claim directory is the only truth. A worker that dies between
moving a file and finishing its work would take the task with it.

**The claim and the `owner` write are one command, not two adjacent steps.** An earlier draft said to
write `owner` "immediately after winning", which reads as satisfiable by making it the next action, and it
is not: a turn boundary, a compaction or a slow parent can put arbitrary minutes between two calls.
Measured 2026-08-27: a worker won `task-12`'s `mkdir` as the last action of a turn with the `owner` write
queued next, the turn boundary landed between them, and the claim sat ownerless for twelve minutes. From
outside that is indistinguishable from a worker that claimed and walked away, so the planner reclaimed a
live worker's task.

## Do the bookkeeping in one call

`scripts/fleet.sh` in this plugin does every step above as a single command, and a worker should use it
rather than hand rolling the shell each time:

```bash
f=$(node -p 'JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.claude/plugins/installed_plugins.json","utf8")).plugins["makarasty@makarasty"][0].installPath.split(String.fromCharCode(92)).join("/")' 2>/dev/null || ls -dt ~/.claude/plugins/cache/*/makarasty/*/ | head -1)/scripts/fleet.sh
sh "$f" next    .fleet/<run-id> 03 repo # claim IN YOUR LANE + owner + heartbeat + the task and its budget
sh "$f" clock   .fleet/<run-id> 03 task-07 25    # prints the self-disarming clock; background it
sh "$f" beat    .fleet/<run-id> 03 task-07
printf '%s' '<one JSON finding>' | sh "$f" find .fleet/<run-id> 03   # a pipe, not a herestring: `<<<` is a bashism
sh "$f" finish  .fleet/<run-id> 03 task-07   # the clock guarding it exits on this marker
sh "$f" drained .fleet/<run-id> 03           # exit 5 = queue empty but still open, poll instead
sh "$f" status  .fleet/<run-id>         # the planner's view: claims, ages, never-beat flags, open asks
sh "$f" answer  .fleet/<run-id> 05-1 06-1    # planner: ONE answer, filed under every question it settles
sh "$f" broadcast .fleet/<run-id>            # planner: something every worker reads at its next boundary
sh "$f" summary .fleet/<run-id> 03      # the end banner, generated from disk
```

**The lane argument is not optional.** Without it `next` hands a paneless worker a browser task, and the
rule ends up retyped into chip prompts instead — 73 hand-rolled claims beside 113 helper ones [M06]. A rule
that has to be retyped every run is not a rule; the next planner writes it slightly differently.

**235 of 612 worker shell calls in one run — 38 percent — were protocol paperwork** that produced no
observation [M05]. One call per boundary removes about four fifths of it.

Two of its behaviours matter beyond the round trips. `next` exits **3** when the queue is drained, so
"drained" stops being a judgement about a loop that failed every claim. And `find` **refuses** a finding
that is missing `evidence`, carries a severity outside the four, or still uses the retired `what` field:
the schema stops being a request and starts being a gate, which is the only kind of rule this repository
has ever seen hold.

## Never claim a task you are not going to begin in the same turn

This supersedes the atomic-`owner` rule above, and it exists because that rule made the next failure
harder to see rather than easier.

The claim, the `owner` write, the task-file read and the first real action all belong in **one turn**, or
the claim should not be made. A worker cannot guarantee it will ever be asked to continue, so a claim made
at a point where work cannot begin is a promise it has no way to keep. See `PROTOCOL.md`, "A session with
nothing pending is dead", for what three workers that claimed as the closing act of a turn cost that run
[M03].

The second-order effect is the part worth remembering. Writing `owner` atomically was the right fix for
the first failure, and it **removed the only signal that would have caught the second**. A claim with a
fresh `owner` and a stale `heartbeat` looks exactly like a healthy worker doing slow work.

## Heartbeat, and losing a claim

Rewrite `claimed/task-NN/heartbeat` with the current time at every natural boundary: after the gate, after
each screen, before each batch of measurements.

**The heartbeat write is also your ownership check.** Before writing it, confirm `claimed/task-NN/owner`
still names you. If the claim directory is gone, or `owner` names someone else, you no longer hold this
task: abandon it silently, write nothing to `done/`, and claim another.

That is a normal outcome, not an error and not something you did wrong. It means the planner judged your
claim stale and returned the task to the queue. A worker that treats a vanished claim as a failed write
will try to repair it, and two workers repairing one task is worse than either of them dropping it.

**A reclaimed task returns under a new id.** The planner does not put `task-07` back; it files
`task-07b` with the same content. A worker that was slow rather than dead may still write
`tasks/done/task-07` or refresh a heartbeat, and under the old id those writes would land in the
successor's directory, refreshing the wrong liveness and marking work done that nobody did. Under a new
id they land in a graveyard and change nothing.

`sh "$f" sweep .fleet/<run-id>` lists the claims that look abandoned and changes nothing; `--release`
moves the claim **and its task file** aside, into `tasks/claimed/<id>.released-<time>` and
`tasks/released/<id>.md`, so the same id cannot be handed straight back to the next claimer.

**Releasing cascades.** A task whose `after:` names the released one would otherwise wait on a done
marker nobody will ever write: `next` answers `QUEUE WAITING` for the rest of the run and `landed`
refuses. `--release` therefore moves the dependents aside with it, transitively, printing one
`also released <id>` line each, and leaves alone any a worker is already holding. Re-file the whole wave
with consistent ids rather than the one task you meant to release.

**A released task is then yours to close.** `fleet.sh landed` refuses a run while anything sits in
`tasks/released/`, and there are two honest ways out: re-file the work under a new id and delete the
released file, or delete the released file alone, which says the task was written off on purpose. A run
that lands over abandoned work is the failure this whole plugin is built against. Atomic claiming stops two workers taking one task and does nothing about a worker that
died holding one, which is the same gap a maildir has in `tmp/`: without a sweeper, a dead claim is a task
the run never finishes and nobody notices.

**Only the planner reclaims**, and the test for a dead claim needs all three of these terms:

> `heartbeat` still equals the `claimed` timestamp, **and** no `tasks/done/<task-id>` exists, **and** more
> than one budget has passed.

The first draft of that rule had only the heartbeat term, and against a real run's state it produced
**five false positives on one chip**, every one of them a task that had finished [M08]. Under the one-term rule the planner would have reclaimed
and re-run five finished tasks.

The heartbeat signature alone cannot separate "died at the claim" from "finished without heartbeating",
and those two need opposite responses. The `done` marker is the term doing the real work.

**Note what that measurement says about heartbeats: they are optional in practice.** A worker completed
five tasks without writing one. Either heartbeating becomes load bearing and something enforces it, or
reclaim logic must not lean on it. Until then, treat a missing heartbeat as no evidence rather than as
evidence of death.

**An ownerless claim has a floor of one budget**, for the twelve minute reason above. A genuinely dead
claim stays dead and comes back one budget later, so the floor costs nothing.

When a claim does fail the three-term test, the planner renames it to `claimed/task-NN.dead-<timestamp>`
rather than deleting it. Renaming leaves the evidence, and it means the original worker discovers the loss
at its next heartbeat instead of finishing work nobody will read.

Workers never reclaim from each other. Two workers deciding a third is dead is how a live worker gets its
task stolen mid run.

**Nothing is ever removed from `ready/`.** Not by a worker, not by the planner, not on completion. The
claim directory and the done marker carry all the state. Deleting the task a worker just took would make
that worker see its own work vanish with no way to tell a legitimate claim from a lost write, and there is
no gain to trade against that: an extra file on disk costs nothing, and the claim attempt is what filters
`ready/` anyway.

## Budgets and finishing together

Every task carries `budget: <minutes>`, the planner's estimate.

**Size it from the measured distribution, not from caution.** Across 36 completed tasks on 2026-08-27 the
median task took **23 minutes** and the mean 23, against budgets the planner wrote as 40 and 45. Only
three tasks of 36 came within five minutes of their budget. An inflated budget is not free: the abort rail
is twice the budget, so a 45 minute estimate means a worker may run 90 minutes before it is required to
hand anything back, which is longer than the entire tail of a healthy run. Write 25, and let the two
tasks that genuinely need 50 carry 50.

**The planner writes the queue longest task first.** Workers that take the longest work first and the
short work last finish within a few minutes of each other; the reverse order leaves one worker holding a
forty minute task while the rest idle. This is the whole answer to making a fleet land together, and it
costs nothing but the order of the files.

That rule was written before the run that measured it and then not followed: the 2026-08-27 queue went
45, 40, 35, 30, 45, 40, 35, 45 in file order, grouped by subject rather than by cost. Order the files by
budget descending when you publish them, because the numeric prefix is fixed once a worker can see it.

## One browser spawn per task

A task is sized so it takes **one** scenario or profiler spawn. Browser subagents share the parent's single
pane, so two spawns in one task run strictly one after the other, and the worker sits idle for the first
one's entire duration.

Measured 2026-08-26: the worker holding a task that needed three sequential spawns spent **4,306 of its
5,784 seconds queued**, seventy four percent, and finished sixty four minutes after the first worker rather
than the fourteen the plan assumed. Splitting that one task into three would have collapsed the run's
spread to roughly twenty seven minutes on its own, which was the largest single saving available anywhere
in that run.

So: a task needing a second browser spawn was split wrong. File the remainder as its own task and let a
free worker take it in parallel, because parallelism between workers is real while parallelism inside one
is not.

**A worker past twice its budget stops that task.** It writes what it has, records the rest as unreached
with the reason, marks the task done, and takes the next one. An unbounded task starves the queue, and a
worker that quietly runs four times its estimate is indistinguishable from one that hung.

That limit is armed, not intended: at claim time the worker backgrounds what
`sh "$f" clock .fleet/<run-id> <chip> <task-id> <budget>` prints, and the notification when it fires is
both the clock and the thing keeping the session alive. Nothing else in a fleet measures elapsed time, and a worker three
subagent rounds into a scenario cannot tell twenty minutes from eighty.

**And it disarms itself.** `fleet.sh clock` prints a loop that watches for its own task's done marker and
exits when it appears, so the boundary that closes the task also silences the clock. It watches for three
things, not one: the task closing, the worker writing `.done` **or** `.blocked`, and the run being landed
at all - so one `fleet.sh landed` ends every clock still armed anywhere on the machine.

**Every path in that loop is absolute**, and it has to be. A worker that writes code runs inside a git
worktree, `.fleet/` is gitignored in every project that has run a fleet, and a fresh checkout therefore
has no `.fleet/` under it at all. With relative paths the exit condition could never be met for exactly
the population the clock is guarding: every one of those clocks ran its full term, up to twice the
budget, and then woke a session that had finished hours earlier. The earlier shape, a
bare `sleep` the worker was asked to stop, was armed 87 times across two runs and stopped zero times,
costing 1,090 minutes of session life after the work was over. See `PROTOCOL.md`, "Pending work mirrors
unwritten obligations".

The planner then re-files the unreached remainder as a new task. That is the loop that lets a weak first
plan repair itself instead of being wrong for the entire run.

## Asking the planner

A worker files a question with `sh "$f" ask .fleet/<run-id> <chip>`, reading it from stdin — one question
with enough context to answer without the transcript — and then **keeps working**. The helper numbers the
file and prints where the answer will appear; by hand it is `ask/<chip>-<n>.md`. It reads `answers/<chip>-<n>.md` at its next task boundary, and
`answers/00-broadcast.md` at every boundary.

**The planner answers with `fleet.sh answer`, naming every question the answer settles.** One reply often
closes several, and writing it to a filename of its own invention is how it reaches nobody: measured
2026-08-31, a planner answered four questions in a combined `answers/05-1-2-3.md` plus a broadcast, and
an hour later all four were still listed as unanswered by `status`, because a worker looks for
`answers/05-1.md` and finds nothing. `answer` writes one text under every id it was addressed to.

Something every worker needs goes in `fleet.sh broadcast`, not into one worker's answer. Four workers of
that run filed the same broken tool between 16:55 and 17:04, two of them after it had already been fixed,
because the fix was recorded where only one of them would look.

Blocking on an answer turns a question into a stall, and in a fleet the operator is reading one chat out
of five. So a worker may ask the operator exactly one thing, which is to display its pane, and that one is
the exception only because the planner cannot open a pane and a blind worker produces fiction. It goes
through `.waiting` and `AskUserQuestion`, which puts it on disk where it is visible without anyone reading
that chat.

Every other question is a file, and the worker keeps moving while it waits for the answer.

The planner watches `ask/` and `tasks/done/` with one `Monitor`, so both a question and a finished task
wake it without polling. That watch must also emit on **silence**, because a queue where nothing is
happening produces no files and therefore no events: see `commands/fleet-wait.md` for the loop that emits
a stall line on a quiet interval and names the outstanding claims. A watch that reports only good news
turns a stalled fleet into a planner asleep, measured at 65 minutes in one run before the operator
intervened.

## What the planner does while the run is live

It is not idle, and this is the part fixed briefs never allowed:

- Answers questions from `ask/`.
- Adds tasks to `ready/` when a finding suggests somewhere else worth looking. A worker reporting a shared
  component defect earns a task for every other screen mounting that component.
- Re-files unreached remainders.
- Reclaims dead claims by heartbeat age, renaming rather than deleting so the original worker learns it
  lost the task.
- Checks for orphaned work at the end. A worker that fails every claim writes its `.done` and exits, so a
  task filed after the last worker left has nobody to take it and will sit in `ready/` looking queued.
  Before calling a run finished, compare `ready/` against `done/` and offer a chip for whatever is left.
- Re-prioritises by filing a new task, never by renaming an existing one. Order lives in the numeric
  prefix and is fixed when the task is published, because renaming a file changes the task id under
  whoever currently holds it.
- Stops a run early when the operator says so, deleting nothing: park every unclaimed task under a claim
  directory owned by `chip planner-stop`, so `next` reports the queue drained; tell each worker in
  `answers/<chip>-notice-STOP.md` to finish what it holds and write `.done`; then collect exactly as for a
  drained run - `merge`, `render`, `landed`. Un-parking is removing those directories, the one case where
  deleting a claim is right, because no worker ever held them. A stopped run that is never collected
  leaves its findings in the chips' files: on 2026-09-04, 180 findings, no backlog, and the fourteen open
  decisions typed into a document by hand.

## Worker economy

The text a worker emits during a run is read by nobody. Findings prose is written for the human who will
fix the defect and stays full length; everything else, its own narration, its notes to itself, its prompts
to subagents, is compressed. Drop articles and filler, keep every number, unit, negation and identifier
exact. The `caveman` plugin does this when installed; what it is worth is measured two headings down.

Never compress an assertion or a brief's statement of what correct looks like. A dropped negation turns a
passing screen into a defect report, and no token saving covers the hour spent chasing it.

### What a run actually spends, measured

Seven runs, 57 worker sessions, 2026-08-26 to 2026-09-01, read from the session transcripts:

| line | tokens |
|---|---|
| cache read | 6 421 M |
| cache write | 93.4 M |
| output, of which thinking 5.7 M | 20.4 M |
| turns | 19 535 |
| tool calls | 11 450 |

**The bill is turns multiplied by context, and nothing else is close** [M24]. The average turn carried ~330 k
cache-read tokens; per worker the average context ran 240 k to 530 k with a peak of 882 k. Output is 0.3%
of the tokens that moved.

Three things that follow, and one that does not:

**Compressing what a worker says is not the lever.** Of everything the models emitted, chat prose was
**5% by characters**; the other 95% was tool input. The paragraph above is still right — nobody reads that
narration — but it is worth roughly nothing, so do not trade clarity for it.

**Bulk belongs around the model, not through it.** In the 26 workers of 2026-09-01 the emitted bytes were:
2 647 KB `Write` into repository source, 2 045 KB of `Bash` heredocs over 2 KB each, 1 022 KB `Write` into
docs, 709 KB `Edit` into source, 301 KB of scripts. Most of that is the work itself and cannot be avoided.
What can: anything the model does not need to read should be produced by the shell into a file and read
back as a count or a slice — `cmd > out.txt; wc -l out.txt` — because a payload that passes through the
model is paid once as output and then again in every later turn that carries it.

**A long queue is worked through subagents, so the worker's own context stays flat** [M30]. Every task a
worker finishes inline leaves 20-30 k of context behind it - the reads, the test output, the diff - and
the next task pays for all of it on every turn. Measured on four paneless workers over 175 tasks: context
climbed from 105 k at the first claim to 970-992 k around the thirtieth, every worker was compacted by the
harness, and the run read 2,414 M cached tokens at 471 k per turn. Over the same 184 claims the workers
spawned zero subagents. So: work the first three tasks yourself, write what they taught you into your
notes, and from then on hand each task to ONE subagent at the task's model - the task file, `RULES.md`
and your notes in its prompt, findings filed through `fleet.sh find` from inside it, a ten-line return.
`fleet.sh next` prints `DELEGATE` when you have crossed that line. A subagent's whole life costs less than
one of your turns once you hold a dozen tasks' worth of context.

**Every finding already goes through the gate.** 1 516 of 1 516 findings in one run and 327 of 327 in
another carried the stamp only `fleet.sh find` writes, so batching findings is not what those `Write`
payloads were. Do not "fix" a problem the disk says you do not have.

**Read a file you are going to edit with `Read`, and stop repeating the rest.** One day of one fleet
measured `Bash` p50 at 1,892 ms against `Read`'s 9 ms, and that ratio got written down as a property of
the tools. It is not: across 899 sessions and 261,308 calls on a second machine, `Bash` p50 is **173 ms**,
`Grep` beats shell grep only **2x**, `Edit` beats in-place `sed` **1.2x**, and `Glob` is **three times
SLOWER** than shelling out to `find` [M25]. The one difference that is not a matter of milliseconds is a
precondition: the harness refuses an `Edit` to a file that was never `Read`, `cat` cannot satisfy it, and
**187 `Edit` calls across that corpus failed exactly there** — three round trips instead of one, every
time. So: `Read` before `Edit`, `Grep` for a search whose output the model must read, the shell for
listing, for running things, and for moving bulk between files without the model in the middle. **And
where the session runs in the auto permission mode, the harness itself asks for shell reads** - then edit
with the shell too. Edit with what you read with; the twelve refusals of 2026-09-04 were every one a file
`cat` had read and `Edit` then touched [M31].

**And look at the permission classifier before blaming any of that.** Every shell call needs a permission
decision; `Read`, `Grep` and `Glob` need none. On the same corpus, 108 of 500 sessions were in a mode
where each gated call carried a fixed extra 1.5-2 s: gated p50 **2,081 ms** in that population against
**102 ms** in the normal one, with the p10 unmoved (75 against 58 ms), and it switched on and off within a
single day independently of how many sessions were running. That is **16.55 h of a 211 h tool wall**, and
on the heaviest day **22% of it** — around seven times what removing every `Edit` retry above would buy
[M28]. It is also where the hard failures come from: 39 calls in one hour of one run died with
`claude-sonnet-5[1m] is temporarily unavailable (rate-limited), so auto mode cannot determine…` while 25
workers ran [M26]. Fewer shell calls helps because it means fewer decisions; allowlisting the shapes a run
actually runs, or taking a wide run off auto mode, helps far more.

## Where the wall clock actually goes

Full accounting of one six worker pull run, 2026-08-27, from first claim to last `.done`: **4 hours 57
minutes**, so 1,782 worker-minutes were available.

| | minutes | share |
|---|---|---|
| Inside a task, working | 748 | 42% |
| Inside a task, dead (three claims held by stalled sessions) | 537 | 30% |
| Between tasks | 102 | 6% |
| Startup, pane gating, and workers idle after their own queue drained | 395 | 22% |

Four things follow, and they are the whole speed story.

**The stalls are the run.** Without them the queue drains around 20:30 local instead of 22:19: they cost
roughly an hour and fifty minutes of a five hour run, and they also produced the two thinnest workers of
the six, 19 and 18 findings against 65, 56, 50 and 46.

**Between-task cost is already near zero**, 102 minutes total and 78 of those in a single end-of-run wait.
Workers claim the next task the moment they finish. Nothing is to be won there, which is worth knowing
before someone optimises it.

**A task is one browser walk and nothing else.** A worker holds one pane, so the delegated scenario inside
each task sets its ceiling [M16], however the queue is written. More throughput comes from more panes, or
from work that does not need one.

**Which is the lever nobody pulled.** In that run, 33 of 34 tasks declared `kind: verify` and every one of
them was written to be walked in a browser, including the ones whose whole answer was in the repository: a
vendor egress audit that read source files took 8 minutes and never needed a pane. File-bound work is not
pane-bound, so it does not consume a worker slot at all. Separate the queue into the tasks that need a
pane and the tasks that need a repository, and the second lane's width is whatever the machine will run.

**And every task took the top tier twice.** All 34 carried `model: opus` and `verdict-model: opus`.
`docs/MODELS.md` exists to make that a decision per stage, and its guidance for a clear-spec sweep is
Sonnet walking with Opus ruling. Defaulting both to the same model is not wrong everywhere, but nobody
chose it and it is the largest single line in what a run costs.

## Measured cost

One eight worker run over a large application, 2026-08-26: **94 findings, three of them blockers, in
roughly one to two hours of wall clock, for about six percent of a weekly maximum subscription allowance.**

The comparison that matters is not against a cheaper fleet. It is against reading the codebase to find the
same defects, which costs orders of magnitude more tokens and cannot find the ones that only exist at
runtime: a request sent with an empty parameter, a catch that turns a thrown query into an empty result
labelled as no data, a count branch and a select branch disagreeing under one filter.
