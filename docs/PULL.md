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
    done/      task-07                        marker written by the worker; a code task's holds a `branch <name>` line
  ask/         03-1.md                        a worker's question for the planner
  answers/     03-1.md                        the planner's reply
  03.jsonl     findings, per worker across every task it took
  03.notes.md  assertions passed, claims refuted, tooling
  03.done      written when the queue is drained, not when one task ends
```

Findings are per worker rather than per task, because a worker's context is what produced them and that is
the unit whose blindness matters.

## Claiming

In every command below, `$r` is the run's absolute directory (the chip prompt gives it): a relative
`.fleet/<run-id>` does not exist from a worktree, where a worker that writes code stands.

```bash
mkdir "$r"/tasks/claimed/task-07 2>/dev/null &&
  printf 'chip %s\nclaimed %s\n' "$CHIP" "$(date -Iseconds)" > "$r"/tasks/claimed/task-07/owner
```

`mkdir` fails when the directory exists, and it fails atomically. Verified on NTFS 2026-08-26: eight
concurrent claimers on one task, exactly one succeeded, and every later attempt was refused.

**The claim attempt is also the check.** Walk `tasks/ready/` in order, skipping anything whose `needs:`
line names a lane you are not in (no `needs:` line means `repo`), and try to claim each one that remains. The first success is your task.

Failing every one of them means your lane is drained, which is **not** the same as the run being over.
While `tasks/queue-open` exists the planner still intends to file work, so `drained` exits 5 and you poll
with the wake in `commands/fleet-run.md` rather than finishing.

A task can also be **gated**: `after: <task-id>` in its frontmatter holds it until that task's done marker
exists, which is how a mission with waves keeps wave three out of wave two's files without asking anybody
to remember the order. The marker is the worker's, not the coordinator's merge, so a task that builds on a
predecessor's code merges the predecessor's `branch <name>` (read from its done marker) into its own branch
first; the task's `base:` is where that branch is cut from (`commands/fleet-run.md`, section 1). `next` says `QUEUE WAITING` and exits 7, rather than `QUEUE DRAINED` and exit 3, when that
is why it handed you nothing, and the two mean opposite things - a gated queue opens again on its own, so
poll it and do not call `drained`. Write `<chip>.done` only once that marker is gone: a session that ends cannot be
reopened, and a queue that grows after its workers have closed has nobody left to work it.

**Never delete or move the ready file.** The claim directory is the only truth. A worker that dies between
moving a file and finishing its work would take the task with it.

**The claim and the `owner` write are one command, not two adjacent steps**: a turn boundary, a
compaction or a slow parent can put arbitrary minutes between two calls. Measured 2026-08-27, a claim sat
ownerless for twelve minutes that way, and the planner reclaimed a live worker's task.

## Do the bookkeeping in one call

`scripts/fleet.sh` in this plugin does every step above as a single command, and a worker should use it
rather than hand rolling the shell each time:

```bash
f="<plugin>/scripts/fleet.sh"   # <plugin>: the root fleet-run named; $f and $r are already set there
r="<the run's absolute directory>"
sh "$f" whoami  "$r" 03 <model> <effort>   # before the first claim; exit 10 = wrong model: end the turn
sh "$f" next    "$r" 03 repo # claim IN YOUR LANE; exit 3 drained, exit 7 waiting (poll), exit 8 paused, exit 9 retired or landed, exit 10 switch pending
sh "$f" clock   "$r" 03 task-07 25    # prints the self-disarming clock; background it
sh "$f" beat    "$r" 03 task-07
printf '%s' '<one JSON finding>' | sh "$f" find "$r" 03   # a pipe, not a herestring: `<<<` is a bashism
sh "$f" finish  "$r" 03 task-07   # the clock guarding it exits on this marker
sh "$f" drained "$r" 03 repo      # exit 5 = not finished (queue-open, or a ready task unheld): poll
sh "$f" status  "$r"         # the planner's view: claims, ages, never-beat flags, open asks
sh "$f" answer  "$r" 05-1 06-1    # planner: ONE answer, filed under every question it settles
sh "$f" broadcast "$r"            # planner: something every worker reads at its next boundary
sh "$f" file    "$r" task-07 < task-07.md   # planner: file one task, checked; FILED or REFUSED
sh "$f" stranded "$r"             # planner: done branches with commits integration lacks
sh "$f" cleared "$r" task-07          # planner: the operator did its part; next hands the task out
sh "$f" procs   "$r" [--kill]         # planner: orphaned test runs and typechecks, and shells of closed chats; --kill ends only those
sh "$f" summary "$r" 03      # the end banner, generated from disk
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

The claim, the `owner` write, the task-file read and the first real action all belong in **one turn**, or
the claim should not be made. A worker cannot guarantee it will ever be asked to continue, so a claim made
at a point where work cannot begin is a promise it has no way to keep. See `PROTOCOL.md`, "A session with
nothing pending is dead", for what three workers that claimed as the closing act of a turn cost that run
[M03].

A claim with a fresh `owner` and a stale `heartbeat` looks exactly like a healthy worker doing slow work.

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

`sh "$f" sweep "$r"` lists the claims that look abandoned and changes nothing; `--release`
moves the claim **and its task file** aside, into `tasks/claimed/<id>.released-<time>` and
`tasks/released/<id>.md`, so the same id cannot be handed straight back to the next claimer.

**Releasing cascades.** A task whose `after:` names the released one would otherwise wait on a done
marker nobody will ever write: `next` answers `QUEUE WAITING` for the rest of the run and `landed`
refuses. `--release` therefore moves the dependents aside with it, transitively, printing one
`also released <id>` line each, and leaves alone any a worker is already holding. Re-file the whole wave
with consistent ids rather than the one task you meant to release.

**A released task is then yours to close.** `fleet.sh landed` refuses a run while anything sits in
`tasks/released/`, and there are two ways out: re-file the work under a new id and delete the
released file, or delete the released file alone, which says the task was written off on purpose. A run
that lands over abandoned work is the failure this whole plugin is built against.

Atomic claiming stops two workers taking one task and does nothing about a worker that
died holding one, which is the same gap a maildir has in `tmp/`: without a sweeper, a dead claim is a task
the run never finishes and nobody notices.

**Only the planner reclaims**, and the test for a dead claim needs all three of these terms:

> `heartbeat` still equals the `claimed` timestamp, **and** no `tasks/done/<task-id>` exists, **and** more
> than one budget has passed.

The heartbeat term alone, against a real run's state, produced **five false positives on one chip**, every
one a task that had finished [M08].

The heartbeat signature alone cannot separate "died at the claim" from "finished without heartbeating",
and those two need opposite responses. The `done` marker is the term doing the real work.

**That measurement says heartbeats are optional in practice.** A worker completed
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
hand anything back, which is longer than the entire tail of a healthy run. For a first wave with nothing
of its own to go on, write 25 and let the two tasks that genuinely need 50 carry 50; that is a stated
default, and the run's own measurement replaces it: `fleet.sh status` prints the median work time against
the median budget once three tasks are done, and a run whose tasks took four minutes against budgets of 45
to 150 (2026-10-05) had no abort clock that could fire. Re-budget what is still ready from it.

**The planner writes the queue longest task first.** Workers that take the longest work first and the
short work last finish within a few minutes of each other; the reverse order leaves one worker holding a
forty minute task while the rest idle. This is how a fleet lands together, and it
costs nothing but the order of the files.

Order the files by budget descending when you publish them, because the numeric prefix is fixed once a
worker can see it.

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
`sh "$f" clock "$r" <chip> <task-id> <budget>` prints, and the notification when it fires is
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
budget, and then woke a session that had finished hours earlier. See `PROTOCOL.md`, "Pending work mirrors
unwritten obligations".

The planner then re-files the unreached remainder as a new task. That is the loop that lets a weak first
plan repair itself instead of being wrong for the entire run.

## Asking the planner

A worker files a question with `sh "$f" ask "$r" <chip>`, reading it from stdin — one question
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
