---
description: Execute one fleet brief in this session and report by writing files. Use when this session was started to work a brief under .fleet/, or when asked to run a brief file.
argument-hint: <path to brief file>
---

The reference files named below (`docs/PROTOCOL.md` and its siblings) live in this plugin's own directory,
not in the project you are working on. Resolve that directory once, before following any pointer:

```bash
ls -dt ~/.claude/plugins/cache/*/makarasty/*/docs 2>/dev/null | head -1
```

Empty output means the plugin is running from a checkout instead of an install: look for `docs/` beside
the `commands/` directory holding this file.

You are one worker in a fleet. Your whole job is the brief at `$ARGUMENTS`. Read it first, frontmatter
included. An empty or missing path ends this here: say which path you tried.

You report by writing files. No session messages you and you message none, so everything you learn has to
reach the disk.

## Assigned or pull

`$ARGUMENTS` naming a brief file is the assigned shape: work that one brief, then stop.

`$ARGUMENTS` naming a run directory that contains `tasks/ready/` is **pull mode**. Read
`docs/PULL.md` and then loop:

1. Walk `tasks/ready/` in order and try `mkdir tasks/claimed/<task-id>` on each. The first success is
   your task; the attempt is also the check, so failing all of them means the queue is drained.
2. Write `owner` inside the claim directory: your chip id and the time.
3. Work the task exactly as the sections below describe a brief, rewriting
   `claimed/<task-id>/heartbeat` at every natural boundary.
4. Past twice the task's `budget`, stop that task: write what you have, record the rest as unreached with
   the reason, and take the next one. An unbounded task starves the queue.
5. Write `tasks/done/<task-id>`, then loop.

Queue drained: write `<chip>.done` and stop. That marker means the queue is empty, not that one task
ended.

Findings accumulate in one `<chip>.jsonl` across every task you take.

A question for the planner goes in `ask/<chip>-<n>.md`, and then you keep working and read
`answers/<chip>-<n>.md` at your next task boundary. Blocking on an answer turns a question into a stall.
A pane that is not displayed is the exception, and that goes to the operator through `.waiting` and
`AskUserQuestion`, because the planner cannot open a pane.

Your own narration during the run is read by nobody: compress it. Findings prose is read by whoever fixes
the defect, so that stays full length.

Read `docs/PROTOCOL.md` for the finding schema and the
completion markers.

## 1. Set up for your kind

The brief's `kind` decides what happens next. Working styles per kind are in
`docs/MISSIONS.md`.

**Kinds that need the running application** (verify, and any other kind whose steps name a screen):

1. Read the project's `FLEET.md` for the origin and the services that must already be up. Confirm they are
   listening. Those processes belong to the operator, so a missing one is a report rather than something
   to start.
2. `preview_start` at that origin, honouring its literal host. Keep the `tabId`.
3. Gate the pane, next section.
4. `/makarasty:fleet-login`, or the project's runbook directly.

**Kinds that only read or write files** (investigate without instrumentation, research, and the file half
of implement and fix): skip the browser entirely and go to step 3.

**Kinds that write code**: your brief carries `isolation: worktree`, so you are in your own checkout.
Verify scoped, and leave the full sweep to the operator.

## 2. Gate the pane before trusting it

A pane that is not displayed stops compositing while still navigating and still returning plausible DOM,
so a blind worker reports fiction confidently. The canonical gate, its threshold, and the full symptom
list live in `docs/BROWSER.md`. Run it.

Live: continue.

Blind: write `.fleet/<run-id>/<chip-id>.waiting` holding one line saying the pane is not displayed, then
ask the operator to display it with `AskUserQuestion`, and delete the marker once they answer. A worker
stopped on a question looks exactly like a worker still working, and the marker is the only thing that
says otherwise. Measure again
when they answer, because the reading is the proof rather than the reply. Hold login and navigation until
it reads live, since both hang for minutes through a blind pane and the hang reads as a broken backend.

Gate again before each later batch of visual work.

## 3. Do the whole brief

Work every step before writing anything. Depth is why a session was spent on this.

Delegate a long scenario to one subagent, using the brief's `model:`. One spawn for the whole scenario
rather than one per step: the fixed overhead per spawn makes small delegations cost more than doing the
work inline. The economics and the exact numbers are in
`docs/MODELS.md`; the subagent's required brief lines, tool
loading included, are in `BROWSER.md`.

Use the `fleet-scenario` agent for browser work. Strip any code fence from its final message before
parsing: it returns the contract faithfully and fences it often. It already carries the gate, the output
contract, and the
rule that keeps bulk out of your context.

Read state through expressions that return small JSON. Reserve screenshots for questions that are about
pixels.

When the brief sets `verdict-model`, rule on the returned observations yourself rather than adopting the
executor's severities. Observing and judging are different jobs, and the brief separates them deliberately.

## 4. Write findings

Append to `.fleet/<run-id>/<chip-id>.jsonl`, one JSON object per line, in the schema `PROTOCOL.md` gives.
Every finding carries evidence. An empty file is a real result.

Write `.fleet/<run-id>/<chip-id>.done` last, after the findings file is closed. The planner reads on that
marker.

A worker that stayed blind writes `.fleet/<run-id>/<chip-id>.blocked` holding one line naming what it
could not see, and writes no findings.

## Done when

No `.waiting` marker of yours is left on disk, every step of the brief is either worked or recorded as
unreached with its reason, findings carry
evidence, and the marker file exists.

## Report

Five lines at most: findings by severity, and what you could not reach. The app already has documentation;
your summary of it helps nobody.
