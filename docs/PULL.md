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
mkdir .fleet/<run-id>/tasks/claimed/task-07 2>/dev/null && echo won
```

`mkdir` fails when the directory exists, and it fails atomically. Verified on NTFS 2026-08-26: eight
concurrent claimers on one task, exactly one succeeded, and every later attempt was refused.

**The claim attempt is also the check.** Walk `tasks/ready/` in order and try to claim each one. The first
success is your task. Failing every one of them means the queue is drained, so write `<chip>.done` and
stop.

**Never delete or move the ready file.** The claim directory is the only truth. A worker that dies between
moving a file and finishing its work would take the task with it.

Write `owner` inside the claim directory immediately after winning: your chip id and the time. It costs
one line and it is what makes a stuck claim diagnosable.

## Heartbeat and reclaiming

Rewrite `claimed/task-NN/heartbeat` with the current time at every natural boundary: after the gate, after
each screen, before each batch of measurements.

**Only the planner reclaims.** When a heartbeat is older than three times the task's budget, the planner
removes the claim directory and the task becomes available again. Workers never reclaim from each other,
because two workers deciding a third is dead is how one live worker gets its task stolen mid-run.

## Budgets and finishing together

Every task carries `budget: <minutes>`, the planner's estimate.

**The planner writes the queue longest task first.** Workers that take the longest work first and the
short work last finish within a few minutes of each other; the reverse order leaves one worker holding a
forty minute task while the rest idle. This is the whole answer to making a fleet land together, and it
costs nothing but the order of the files.

**A worker past twice its budget stops that task.** It writes what it has, records the rest as unreached
with the reason, marks the task done, and takes the next one. An unbounded task starves the queue, and a
worker that quietly runs four times its estimate is indistinguishable from one that hung.

The planner then re-files the unreached remainder as a new task. That is the loop that lets a weak first
plan repair itself instead of being wrong for the entire run.

## Asking the planner

A worker writes `ask/<chip>-<n>.md`, one question with enough context to answer without the transcript,
then **keeps working**. It reads `answers/<chip>-<n>.md` at its next task boundary.

Blocking on an answer turns a question into a stall, and in a fleet the operator is reading one chat out
of five. So a worker may ask the operator exactly one thing, which is to display its pane, and that one is
the exception only because the planner cannot open a pane and a blind worker produces fiction. It goes
through `.waiting` and `AskUserQuestion`, which puts it on disk where it is visible without anyone reading
that chat.

Every other question is a file, and the worker keeps moving while it waits for the answer.

The planner watches `ask/` and `tasks/done/` with one `Monitor`, so both a question and a finished task
wake it without polling.

## What the planner does while the run is live

It is not idle, and this is the part fixed briefs never allowed:

- Answers questions from `ask/`.
- Adds tasks to `ready/` when a finding suggests somewhere else worth looking. A worker reporting a shared
  component defect earns a task for every other screen mounting that component.
- Re-files unreached remainders.
- Reclaims dead claims by heartbeat age.
- Reorders `ready/` when the estimates turn out wrong.

## Worker economy

The text a worker emits during a run is read by nobody. Findings prose is written for the human who will
fix the defect and stays full length; everything else, its own narration, its notes to itself, its prompts
to subagents, is compressed. Drop articles and filler, keep every number, unit, negation and identifier
exact. The `caveman` plugin does this well when installed.

Never compress an assertion or a brief's statement of what correct looks like. A dropped negation turns a
passing screen into a defect report, and no token saving covers the hour spent chasing it.

## Measured cost

One eight worker run over a large application, 2026-08-26: **94 findings, three of them blockers, in
roughly one to two hours of wall clock, for about six percent of a weekly maximum subscription allowance.**

The comparison that matters is not against a cheaper fleet. It is against reading the codebase to find the
same defects, which costs orders of magnitude more tokens and cannot find the ones that only exist at
runtime: a request sent with an empty parameter, a catch that turns a thrown query into an empty result
labelled as no data, a count branch and a select branch disagreeing under one filter.
