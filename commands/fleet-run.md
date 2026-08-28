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

## Missing prerequisites are work, not a refusal

A fleet command run against a project that was never set up finds no `FLEET.md`, no login runbook and no
`.fleet/`. Refusing at that point is the wrong answer: the missing pieces are exactly what an agent is
good at producing.

So: say what is missing in one line, run `/makarasty:fleet-init` to produce it, and continue into the
work the operator actually asked for. No blocker, no second command for them to remember.

The same rule holds for everything else that can be absent. A missing directory gets created. An
accelerator that is not installed gets noted once and worked around. A brief that names a screen the
project does not have becomes a question in `ask/`, not a stop.

Stop for exactly two things, because neither can be produced by working harder: a **credential or account
only the operator can provide**, and a **reserved control** that would cost money or reach a real person.
Everything else is repairable, and repairing it quietly is the difference between a tool and a form.

You are one worker in a fleet. Your whole job is the brief at `$ARGUMENTS`. Read it first, frontmatter
included. An empty or missing path ends this here: say which path you tried.

You report by writing files. No session messages you and you message none, so everything you learn has to
reach the disk.

## Assigned or pull

`$ARGUMENTS` naming a brief file is the assigned shape: work that one brief, then stop.

`$ARGUMENTS` naming a run directory that contains `tasks/ready/` is **pull mode**. Read
`docs/PULL.md` and then loop:

0. Locate the plugin's helper once and use it for every boundary below, because doing this by hand cost
   one measured run 235 shell calls that produced no observation:

   ```bash
   f=$(ls -t ~/.claude/plugins/cache/*/makarasty/*/scripts/fleet.sh | head -1)
   ```

1. `sh "$f" next .fleet/<run-id> <chip>` claims the first free task, writes `owner` and the first
   heartbeat atomically, and prints the task with its budget and abort deadline. **Exit 3 means the queue
   is drained.** By hand: walk `tasks/ready/` in order, `mkdir tasks/claimed/<task-id>` on each, and write
   `owner` in the same command, never as a second step.
2. Read the task file and take the first real action on it **in the same turn as the claim**.
3. Work the task exactly as the sections below describe a brief, rewriting
   `claimed/<task-id>/heartbeat` at every natural boundary.
4. Past twice the task's `budget`, stop that task: write what you have, record the rest as unreached with
   the reason, and take the next one. An unbounded task starves the queue.

   **Arm that limit rather than intending it.** At the moment you claim, background
   `sleep <2 x budget in seconds>; echo budget-elapsed`. Nothing else in this system measures elapsed time,
   and a worker deep in a scenario has no idea whether eight minutes have passed or eighty. The wake is
   the clock, and it is the same wake that keeps the session alive.
5. `sh "$f" finish .fleet/<run-id> <chip> <task-id>`, then loop. It refuses to write the marker if the
   claim is no longer yours.

Queue drained: `sh "$f" drained .fleet/<run-id> <chip>` and stop. That marker means the queue is empty,
not that one task ended.

Findings go in through `sh "$f" find .fleet/<run-id> <chip>` with the JSON on stdin. It **refuses** a
finding with no `evidence`, a severity outside the four, or the retired `what` field, which is the only
way the schema has ever actually held.

Findings accumulate in one `<chip>.jsonl` across every task you take.

**Never end a turn holding a claim you have not begun, and never end one with nothing pending at all.**
A session runs only while something invokes it, and nothing in a fleet types into your chat. Measured
2026-08-27: three of six workers claimed their next task as the closing act of a turn, each wrote a
confident summary saying which task it had just taken, and each then sat dead for **169, 171 and 176
minutes** holding that claim until the planner sent a status check. None had started the work.

When you cannot avoid stopping mid-run, arm your own wake first and run it with `run_in_background`:

```bash
sleep 120; echo wake
```

The notification when it exits re-invokes you. That is also the only timeout this system has: a subagent
that never returns, an answer that never comes, a pane nobody displays. Full rule and the measurements in
`docs/PROTOCOL.md`, "A session with nothing pending is dead".

Ask the operator exactly one thing, ever: to display your Browser pane. Their eyes are on the planner's
chat, not yours, so a second interactive question waits unanswered while you hold a claimed task. Every
other question goes in `ask/<chip>-<n>.md`, and then you keep working and read
`answers/<chip>-<n>.md` at your next task boundary. Blocking on an answer turns a question into a stall.
A pane that is not displayed is the exception, and that goes to the operator through `.waiting` and
`AskUserQuestion`, because the planner cannot open a pane.

**A question about a reserved action is not asked at all**, in either channel. A production write, a
vendor call that costs money, a message to a real person: no answer makes those yours to do, so record the
step as unreached with the reason and take the next one. Measured 2026-08-27: a worker asked the operator
whether a writing band was sanctioned and blocked four minutes twenty six seconds holding a claim, for an
answer that could not have changed what it was allowed to do.

Your own narration during the run is read by nobody, so compress it from the first message. When the
`caveman` plugin is installed, `/caveman full` does this for you; without it, drop articles, filler and
pleasantries by hand and keep every number, unit, negation and identifier exact. Findings prose is read by
whoever fixes
the defect, so that stays full length.

Read `docs/PROTOCOL.md` for the finding schema and the
completion markers.

## 1. Set up for your kind and your lane

The brief's `kind` decides what happens next. Working styles per kind are in
`docs/MISSIONS.md`. Its `needs` field decides what you may do at the same time, and the rules are in
`docs/LANES.md`:

- `needs: pane` - one browser subagent at a time, because they all drive this session's single pane.
  **While that subagent runs, claim one `repo` task and work it.** That wait is about 20 of the task's 23
  minutes, and filling it roughly doubles what this session produces without a second pane.
- `needs: repo` - fan out. Three subagents in one message is the default width, `fanout:` overrides it,
  and the parts must not read each other's output.
- `needs: verify` - the full suite or the full typecheck is the whole machine. One worker holds it at a
  time and the others verify scoped.

A pending subagent is not a wake. Arm the sleep anyway.

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

Live: continue. A reading between one and fifty-nine is blind as well, not a weak pass: report the number,
since intermittent compositing usually means a paging machine or a pane closing under you.

Blind: write `.fleet/<run-id>/<chip-id>.waiting` holding one line saying the pane is not displayed and
naming the viewport you measured. Then **wait by polling, not by prompting**: arm
`sleep 90; echo regate` with `run_in_background`, and re-run the gate when it wakes you. Delete the marker
the moment the gate reads live, and measure again rather than trusting anyone's reply, because the reading
is the proof.

The marker is what reaches the operator: the planner's watch reports every `.waiting` within one interval,
in the chat the operator is actually reading, and one instruction there opens every pane at once. Six
separate prompts in six worker chats do not. Measured 2026-08-27: all six workers of one run opened the
pane prompt within forty seconds of each other and blocked between 96 and 185 seconds each, asking the
same question in six chats nobody was looking at.

Fall back to `AskUserQuestion` only after roughly three unanswered poll rounds, and keep the marker on
disk while you do. A worker stopped on a question looks exactly like a worker still working, and the
marker is the only thing that says otherwise.

Hold login and navigation until the gate reads live, since both hang for minutes through a blind pane and
the hang reads as a broken backend.

Gate again before each later batch of visual work.

## 3. Do the whole brief

Work every step of the brief before writing your final report. Depth is why a session was spent on this.

**Append each finding to the JSONL the moment its evidence is complete**, not at the end. A worker that is
killed, compacted or closed at ninety percent of a two hour brief must leave those ninety percent behind;
holding them in context until the last minute is how a crashed worker reads as a clean area. The `.done`
marker says you finished, never the existence of the file.

Delegate the scenario to one subagent, using the brief's `model:`. One spawn per brief, and if the brief
needs a second the brief was too big: browser subagents share this session's single pane, so a second
spawn runs strictly after the first while you sit idle. One worker measured 2026-08-26 spent 74 percent of
its life queued behind three of them. One spawn for the whole scenario
rather than one per step: the fixed overhead per spawn makes small delegations cost more than doing the
work inline. The economics and the exact numbers are in
`docs/MODELS.md`; the subagent's required brief lines, tool
loading included, are in `BROWSER.md`.

A `fleet-scenario` or `fleet-profiler` agent returning `[{"blocked": ...}]` means the pane stopped
compositing after your own gate passed, usually because the operator collapsed it. Treat that exactly like
failing the gate yourself: write `.waiting`, ask the operator to display it, re-measure, and re-run the
agent. Do not accept the empty result as a finding.

Use the `fleet-scenario` agent for browser work. Strip any code fence from its final message before
parsing: it returns the contract faithfully and fences it often. It already carries the gate, the output
contract, and the
rule that keeps bulk out of your context.

Read state through expressions that return small JSON. Reserve screenshots for questions that are about
pixels.

When the brief sets `verdict-model` and it names a model other than the one this session runs, spawn one
verdict pass at that model over the returned observations. Ruling "yourself" cannot honour the field: your
own model was fixed when this session started and you cannot change it, so a brief asking for Opus
verdicts from a Sonnet session gets Sonnet verdicts and paperwork that says otherwise.

When it matches, rule on the returned observations yourself rather than adopting the
executor's severities. Observing and judging are different jobs, and the brief separates them deliberately.

## 4. Write findings

Append to `.fleet/<run-id>/<chip-id>.jsonl`, one JSON object per line, in the schema `PROTOCOL.md` gives.
Every finding carries evidence. An empty file is a real result.

Write `.fleet/<run-id>/<chip-id>.done` last, after the findings file is closed. The planner reads on that
marker.

A worker that stayed blind writes `.fleet/<run-id>/<chip-id>.blocked` holding one line naming what it
could not see, and writes no findings.

## Done when

Before writing your findings, re-read your brief's Steps and its Correct-looks-like section. You read them
once, dozens of tool calls ago, and end-of-run duties are the kind of instruction a long run drifts from.
Then walk this list:

- Every step worked, or recorded as unreached with its reason.
- Every finding carries evidence and, where layout or timing is involved, `conditions`.
- The browser tab reset to `desktop` if you emulated a viewport. An emulated size persists across
  reloads and would reshape anything measured after you.
- No `.waiting` marker of yours left on disk.
- `<chip-id>.notes.md` written: assertions that passed, claims you raised and then refuted, tooling
  observations. A run with no findings is otherwise ambiguous between checked-and-clean and never-checked,
  and this file is the only thing that separates them.
- `<chip-id>.done` written last, after the findings file is closed.
## Report

Five lines at most: findings by severity, and what you could not reach. The app already has documentation;
your summary of it helps nobody.
