---
description: Work one fleet brief, or a run's task queue, in this session and report by writing files. Use when this session was started on a brief under .fleet/.
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

1. `sh "$f" next .fleet/<run-id> <chip> <lane>` claims the first free task **in your lane**, writes
   `owner` and the first heartbeat atomically, and prints the task with its budget and abort deadline.
   **Pass the lane** - `repo` if this session has no Browser pane, `pane` if it does - or you will claim
   work you cannot do. **Exit 3 means the queue is drained** for that lane. By hand: walk `tasks/ready/`
   in order, read each file's `needs:` line, `mkdir tasks/claimed/<task-id>` on the first one that matches
   your lane, and write `owner` in the same command, never as a second step.
2. Read the task file and take the first real action on it **in the same turn as the claim**.
3. Work the task exactly as the sections below describe a brief, rewriting
   `claimed/<task-id>/heartbeat` at every natural boundary.
4. Past twice the task's `budget`, stop that task: write what you have, record the rest as unreached with
   the reason, and take the next one. An unbounded task starves the queue.

   **Arm that limit rather than intending it.** `sh "$f" clock .fleet/<run-id> <chip> <task-id> <budget>`
   prints a loop; background exactly what it prints. Nothing else in this system measures elapsed time, and
   a worker deep in a scenario has no idea whether eight minutes have passed or eighty. That loop watches
   for its own task closing, so it rings only if the budget really elapsed.

5. `sh "$f" finish .fleet/<run-id> <chip> <task-id>`, then loop. It refuses to write the marker if the
   claim is no longer yours. The clock sees that marker within thirty seconds and exits on its own, so
   there is nothing to remember and nothing to stop.

Queue drained: `sh "$f" drained .fleet/<run-id> <chip>` and stop. That marker means the queue is empty,
not that one task ended.

**Exit 5 from `drained` means the queue is empty but still open**: the planner has not finished filing
work, so you are not finished either. Arm `sleep 300; echo recheck`, end the turn, and try again when it
wakes you. Do not write `.done` and do not close the chat: a session that ends cannot be reopened, and the
planner adding a task an hour from now has no way to reach a worker that stopped.

Findings go in through `sh "$f" find .fleet/<run-id> <chip>` with the JSON on stdin. It **refuses** a
finding with no `evidence`, a severity outside the four, or the retired `what` field, which is the only
way the schema has ever actually held.

Findings accumulate in one `<chip>.jsonl` across every task you take.

**Never end a turn holding a claim you have not begun, and never end one with nothing pending at all.**
A session runs only while something invokes it, and nothing in a fleet types into your chat. Three workers
that claimed as the closing act of a turn sat dead for **169, 171 and 176 minutes** holding those claims
[M03].

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

Your own narration during the run is read by nobody, so compress it from the first message: drop
articles, filler and pleasantries, keep every number, unit, negation and identifier exact. The `caveman`
plugin does this when installed, and it is fine to leave on, but do not reach for it as a saving: M24
measured chat prose at 5% of what a worker emits and output at 0.3% of the tokens that move, so the
narration is worth roughly nothing either way. What does move the bill in a writing kind (implement, fix,
design, redesign) is the volume of code and the turns spent producing it, which is the layer the
`ponytail` plugin works on; where it is installed its ladder applies to the code, never to the project's
own rules on tests and docs. Findings prose is read by whoever fixes the defect, so that stays full length.

Read `docs/PROTOCOL.md` for the finding schema and the
completion markers.

**Edit with what you read with.** In the auto permission mode the harness asks you to read with `cat` and
`sed -n`; `Edit` then refuses that file with "File has not been read yet", three round trips instead of
one, on every run so far [M31]. A file the shell read is changed with `sed -i`, a heredoc or a short
script. `Edit` is for a file this session `Read`. Never both on one file.

## 1. Set up for your kind and your lane

The brief's `kind` decides what happens next. Working styles per kind are in
`docs/MISSIONS.md`. Its `needs` field decides what you may do at the same time, and the rules are in
`docs/LANES.md`:

- `needs: pane` - one browser subagent at a time, because they all drive this session's single pane.
  **While that subagent runs, claim one `repo` task and work it.** That wait is about 20 of the task's 23
  minutes, and filling it roughly doubles what this session produces without a second pane.
- `needs: repo` - fan out. Three subagents in one message is the default width, `fanout:` overrides it,
  and the parts must not read each other's output. **On a long queue, delegate whole tasks, not parts:**
  each task you work inline leaves 20-30 k of context behind, and four workers who never spawned anything
  were all compacted around their thirtieth task [M30]. When `next` prints `DELEGATE`, hand the task to
  one subagent - task file, `RULES.md`, your notes - and keep your own context flat.
- `needs: verify` - the full suite or the full typecheck is the whole machine. One worker holds it at a
  time and the others verify scoped.

A pending subagent is not a wake. Arm the sleep anyway.

**Kinds that review or capture design** (`critique`, `canvas`, `redesign`): read the kind's section of
`docs/DESIGN.md` before the first step, and nothing else from it. A `critique` task is a pane task that
spawns `fleet-design-eye` instead of `fleet-scenario`, with the plugin's `scripts/` directory, the
`tabId`, the route, the token file and the task's "correct looks like" lines in its prompt; what comes
back goes through `fleet.sh find`, `rects` included. A `canvas` recon task is a pane task with no spawn
at all: one probe at the task's viewport, written to the recon path the task names, then the tab reset to
`desktop`. A `canvas` screen task or a `redesign` task is a repo task that writes exactly one new artboard
under the canvas directory and edits nothing else - no worktree, because nothing is shared - and runs
`node <plugin>/scripts/fleet-canvas.mjs check <file>` before `finish`; a refused artboard is a task not
finished. An assemble task runs the `fleet-canvas.mjs` calls its task names and files an `ask/` when
`seed` cannot find the design skill's helper. Publishing the canvas is the planner's step, never yours.

**Kinds that need the running application** (verify, and any other kind whose steps name a screen):

**The pane comes first, before anything else you would read.** Your brief's frontmatter tells you which
lane you are in, and that is all you need to know to start the gate. Reading `FLEET.md`, the project's
documentation and the brief's steps all take turns during which the operator is still standing in front of
your chat, and every one of those turns is a minute added to how long they wait to be asked. So:

1. `preview_start` at the origin from `FLEET.md`'s first lines, honouring its literal host. Keep the
   `tabId`. One `sed -n` for the origin is enough here; the rest of that file can wait.
2. Gate the pane, next section, and if it reads blind ask **in that same turn**. Target: the question is
   on screen inside a minute of the chip being clicked.
3. Read `FLEET.md` properly and confirm the services it names are listening. Those processes belong to the
   operator, so a missing one is a report rather than something to start. Do this while you wait for the
   pane, not before asking for it.
4. `/makarasty:fleet-login`, or the project's runbook directly, once the gate reads live.

**Kinds that only read or write files** (investigate without instrumentation, research, and the file half
of implement and fix): skip the browser entirely and go to step 3.

**When you need browser evidence and have no pane**, and the run has a `pane/` directory, file the walk
instead of asking for a pane: `sh "$f" pane-ask .fleet/<run-id> <chip>` with the whole walk on stdin, then
claim a repo task and read `pane/results/<id>.json` at your next boundary. One request is one whole walk,
never a single click. `docs/BROKER.md` has the contract.

**If your chip made you a pane host**, your loop is `pane-next` / run the walk / `pane-serve`, and every
answer carries the frame count it was measured under: `pane-serve` refuses a walk served from a blind pane,
which is the only thing standing between a requester and confident fiction it cannot check.

**Kinds that write code**: your brief carries `isolation: worktree`, so you are in your own checkout.
Verify scoped, and leave the full sweep to the operator.

**Register your worktree at your first claim**, so the run can clean it up afterwards and no sweep ever
guesses which tree belonged to whom:

```bash
sh "$f" worktree .fleet/<run-id> <chip>
```

It records this session's checkout and its branch, and refuses a path that is not under
`.claude/worktrees/`, which is how a worker that is not actually in a worktree registers nothing.

**When your brief is done, commit and push your slice, then unlink before anything deletes.** A
`node_modules` junction inside your worktree is a hole a recursive delete follows into the main checkout:
measured seven times out of seven, `git worktree remove` with the junction in place emptied the main
checkout's `node_modules` [M32]. So remove the links first, with the command rather than by hand:

```bash
sh "$f" unlink "$(pwd -W 2>/dev/null || pwd)"
```

It walks the whole tree, not just the top level, because a junction at `sub/node_modules` is followed too.
Only then call `ExitWorktree` with `remove`, or leave the tree for the planner's `fleet.sh clean`. Full procedure in
`docs/WORKTREES.md`. Never delete your worktree with a recursive force-delete of your own.

## 2. Gate the pane before trusting it

A pane that is not displayed stops compositing while still navigating and still returning plausible DOM,
so a blind worker reports fiction confidently. The canonical gate, its threshold, and the full symptom
list live in `docs/BROWSER.md`. Run it.

Live: continue. A reading between one and fifty-nine is blind as well, not a weak pass: report the number,
since intermittent compositing usually means a paging machine or a pane closing under you.

Blind: in **one turn**, write `.fleet/<run-id>/<chip-id>.waiting` holding one line saying the pane is not
displayed and naming the viewport you measured, **ask the operator right there with `AskUserQuestion`**,
and arm `sleep 90; echo regate` with `run_in_background` so an unanswered question becomes another
measurement rather than a stall. Delete the marker the moment the gate reads live, and measure again
rather than trusting anyone's reply, because the reading is the proof.

**Ask immediately, not after three polite poll rounds.** The operator clicks chips in a wave and then
walks chat to chat opening panes; a prompt that arrives four minutes after the chip is a second visit to a
chat they have already left. Over six pane workers the question landed between **1 and 34 minutes** after
the chip, so the operator answered them one at a time across half an hour instead of in one pass [M20]. The earlier rule optimised for the
wrong thing: the question is cheap **because** the operator is already standing in front of that chat, and
it is only expensive when it arrives after they have moved on.

The marker is the other half, not the fallback: the planner's watch reports every `.waiting` within one
interval, in the chat the operator is actually reading, so a question asked in a chat nobody opens is still
visible where they are. Write both, every time. A worker stopped on a question looks exactly like a worker
still working, and the marker is the only thing that says otherwise.

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
spawn runs strictly after the first while you sit idle: one worker spent **74 percent** of its life queued
behind three of them [M14]. One spawn for the whole scenario
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

## 5. End so that a person can see you ended

`sh "$f" drained .fleet/<run-id> <chip>` is the whole ending. It writes the marker, prints the banner
generated from disk, and prints the exact session title to set. Two things are left for you:

1. **Rename this session** to the title it printed, if the host offers a session-title tool. That title is
   the only thing about you visible from the chat the operator is actually sitting in.
2. **Stop.** Let the banner stand as your report: no closing summary of the application, no advice about
   what to fix. Your clocks are already watching for the markers you just wrote, so nothing of yours is
   still pending.

If something wakes you afterwards, print the banner again and stop. Nothing else.

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
- Every background task of yours stopped, and your task panel empty. This is checkable, so check it.
- The banner printed and the session renamed.

## Report

The banner from `fleet.sh summary`, and at most two lines under it naming what you could not reach. The
app already has documentation; your summary of it helps nobody.
