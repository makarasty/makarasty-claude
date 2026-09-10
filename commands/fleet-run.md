---
description: Work one fleet brief, or a run's task queue, in this session and report by writing files. Use when this session was started on a brief under .fleet/.
argument-hint: <path to brief file>
---

The files named below (`docs/PROTOCOL.md`, `scripts/fleet.sh` and their siblings) live in this plugin's own
directory, not in the project you are working on. Resolve it once, before following any pointer, and use
`$f` for every protocol boundary below: that bookkeeping done by hand cost one measured run 235 shell calls
that produced no observation [M05].

```bash
d=$(node -p 'JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.claude/plugins/installed_plugins.json","utf8")).plugins["makarasty@makarasty"][0].installPath.split(String.fromCharCode(92)).join("/")' 2>/dev/null || ls -dt ~/.claude/plugins/cache/*/makarasty/*/ | head -1)/docs
f=$(node -p 'JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.claude/plugins/installed_plugins.json","utf8")).plugins["makarasty@makarasty"][0].installPath.split(String.fromCharCode(92)).join("/")' 2>/dev/null || ls -dt ~/.claude/plugins/cache/*/makarasty/*/ | head -1)/scripts/fleet.sh
```

Empty output means the plugin is running from a checkout instead of an install: `docs/` and `scripts/` sit
beside the `commands/` directory holding this file.

## Missing prerequisites are work, not a refusal

No `FLEET.md`, no login runbook, no `.fleet/`: say what is missing in one line, run
`/makarasty:fleet-init` to produce it, and continue into the work the operator actually asked for. A
missing directory gets created, an accelerator that is not installed gets noted once and worked around,
and a brief naming a screen the project does not have becomes a question in `ask/` rather than a stop.
Stop for exactly two things, because neither can be produced by working harder: a **credential or account
only the operator can provide**, and a **reserved control** that would cost money or reach a real person.

You are one worker in a fleet. Your whole job is the brief at `$ARGUMENTS`. Read it first, frontmatter
included. An empty or missing path ends this here: say which path you tried.

You report by writing files. No session messages you and you message none, so everything you learn has to
reach the disk.

## The pane comes first, before anything else here

Your brief's frontmatter, or your chip's prompt, names your lane, and that is all you need to start. If it
is `pane`, everything below this section waits: reading `FLEET.md`, the project's documentation and the
brief's steps each take a turn during which the operator is still standing in front of your chat, and every
one of those turns is a minute added to how long they wait to be asked. Over six pane workers the question
landed between **1 and 34 minutes** after the chip, so the operator answered them one at a time across half
an hour instead of in one pass [M20].

1. `preview_start` at the origin on `FLEET.md`'s first lines, honouring its literal host. One `sed -n` for
   the origin is enough; the rest of that file can wait. Keep the `tabId`.
2. Gate the pane in the next turn, with the canonical expression:

   ```js
   new Promise(res => { let f = 0; requestAnimationFrame(function t(){ f++; requestAnimationFrame(t); }); setTimeout(() => res(f), 1000); })
   ```

   Sixty frames or more is live. Zero is blind, and so is **anything between one and fifty-nine**: report
   the number, since intermittent compositing usually means a paging machine or a pane closing under you.
3. Blind: ask **in that same turn**, by the procedure in "Gate the pane before trusting it" below. Target:
   the question is on screen inside a minute of the chip being clicked.

Then read `FLEET.md` properly and confirm the services it names are listening, while you wait for the pane
rather than before asking for it. Those processes belong to the operator, so a missing one is a report
rather than something to start. Once the gate reads live, run `/makarasty:fleet-login`, or the project's
runbook directly.

`docs/BROWSER.md` carries the symptom list, what a blind pane still returns convincingly, and the pane
ergonomics. None of it is worth a turn before the question is on screen.

**Kinds that only read or write files** (investigate without instrumentation, research, and the file half
of implement and fix) skip this section entirely.

## Assigned or pull

`$ARGUMENTS` naming a brief file is the assigned shape: work that one brief, then stop.

`$ARGUMENTS` naming a run directory that contains `tasks/ready/` is **pull mode**. Read
`docs/PULL.md` and then loop:

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

**Every finding goes in through `sh "$f" find .fleet/<run-id> <chip>`**, one JSON object on stdin, and
never by appending to the JSONL yourself: the gate is the only place the schema is enforced, and a hand
written line skips all of it. It refuses input that is not one JSON object; a finding missing any of
`area`, `severity`, `observed`, `evidence` or `mechanism_status`; a `severity` outside
`blocker|major|minor|polish`; a `mechanism_status` outside `established|hypothesis|unknown`; an `evidence`
string under twelve characters; the retired `what` field; an `unreached` line with no `reason`; and a
finding carrying `rects` whose two rectangles do not intersect or whose `conditions` states no number. It
stamps `when` and `chip` for you. Where `node` is absent it warns and appends unvalidated, and there the
schema is yours to hold.

Findings accumulate in one `<chip>.jsonl` across every task you take.

**Never end a turn holding a claim you have not begun, and never end one while you still owe the disk
something.** A session runs only while something invokes it, and nothing in a fleet types into your chat,
so a worker that claims as the closing act of a turn holds that claim until somebody messages it [M03].
The two boundaries where you owe nothing, and may therefore stop, are `<chip-id>.done` and
`<chip-id>.blocked`.

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

Your own narration during the run is read by nobody, so compress it from the first message: drop articles,
filler and pleasantries, keep every number, unit, negation and identifier exact. The `caveman` plugin does
this when installed and is fine to leave on, but do not reach for it as a saving: chat prose is a rounding
error against what a worker actually spends [M24]. What does move the bill in a writing kind (implement,
fix, design, redesign) is the volume of code and the turns spent producing it, which is the layer the
`ponytail` plugin works on; where it is installed its ladder applies to the code, never to the project's
own rules on tests and docs. Findings prose is read by whoever fixes the defect, so that stays full length.

**Edit with what you read with.** In the auto permission mode the harness asks you to read with `cat` and
`sed -n`; `Edit` then refuses that file with "File has not been read yet", three round trips instead of
one, on every run so far [M31]. A file the shell read is changed with `sed -i`, a heredoc or a short
script. `Edit` is for a file this session `Read`. Never both on one file.

## 1. Set up for your kind and your lane

The brief's `kind` decides what happens next: read that kind's section of `docs/MISSIONS.md` for the
working style, and nothing else from it. Its `needs` field decides what you may do at the same time, and
the two sections of `docs/LANES.md` that are yours are "The pane worker's idle window" and "Fan out in the
repo lane, never in the pane lane". The rest of that file sizes lanes, which is the planner's job:

- `needs: pane` - one browser subagent at a time, because they all drive this session's single pane.
  **While that subagent runs, claim one `repo` task and work it.** That wait is most of the task's length
  [M16], and filling it roughly doubles what this session produces without a second pane.
- `needs: repo` - fan out. Three subagents in one message is the default width, and a task's `fanout:`
  line raises or lowers it. No script reads that field: it is a planner's instruction to you, so honour it.
  You do not need to weigh it against free memory - `next` refuses your next task when the box is full.
  The parts must not read each other's output. **On a long queue, delegate whole tasks, not parts:**
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

**Kinds that need the running application** (verify, and any other kind whose steps name a screen) started
their pane at the top of this file, before reading any of this. Section 2 is the rest of that gate.

**When you need browser evidence and have no pane**, and the run has a `pane/` directory, file the walk
instead of asking for a pane: `sh "$f" pane-ask .fleet/<run-id> <chip>` with the whole walk on stdin, then
claim a repo task and read `pane/results/<id>.json` at your next boundary. One request is one whole walk,
never a single click. `docs/BROKER.md` has the contract.

**If your chip made you a pane host**, your loop is `pane-next` / run the walk / `pane-serve`, and every
answer carries the frame count it was measured under: `pane-serve` refuses a walk served from a blind pane,
which is the only thing standing between a requester and confident fiction it cannot check.

**Kinds that write code**: your brief carries `isolation: worktree`, so you are in your own checkout.
Verify scoped, and leave the full sweep to the operator.

**A fix task is proved, not argued.** `finish` refuses a `kind: fix` or `kind: root` task whose
reproduction was not run through the gate, so run it - before you change anything, and again after:

```bash
g=$(node -p 'JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.claude/plugins/installed_plugins.json","utf8")).plugins["makarasty@makarasty"][0].installPath.split(String.fromCharCode(92)).join("/")' 2>/dev/null || ls -dt ~/.claude/plugins/cache/*/makarasty/*/ | head -1)/scripts/fleet-gate.mjs
node "$g" prove .fleet/<run-id> <task-id> before -- <the task's reproduction>
# ... make the change ...
node "$g" prove .fleet/<run-id> <task-id> after  -- <the same command>
```

A `before` that passes means the finding is refuted: record that, finish the task, and take the next one.
That is a complete result and roughly 15 findings in every 100 end that way.

**A `kind: root` task owns a seam several findings reach**, and every task listed in its `gates:` is held
until it lands. Rule on the cause first and be willing to refute it; a refutation releases the members to
be fixed on their own evidence and is the right answer more often than it feels. If you are working one of
those members instead, the root has already finished by the time you can claim it, so re-run your
reproduction before editing - it may already pass, and confirming that is your job rather than writing a
second fix for a defect that is gone.

**If an edit is refused because it drops a name from the contract surface**, the hook has found something
outside this repository that may be reading it. Do one of the two things it names - file the `ask/`, or
record the decision with `fleet-gate.mjs decide` - and make the edit again. Both take one line and both
put the change in front of the operator before the run lands. Working around the refusal by editing the
name some other way is the failure it exists to catch. `docs/GATE.md` if you want the reasoning.

**Register your worktree at your first claim**, so the run can clean it up afterwards and no sweep ever
guesses which tree belonged to whom:

```bash
sh "$f" worktree .fleet/<run-id> <chip>
```

It records this session's checkout and its branch, and refuses a path that is not under
`.claude/worktrees/`, which is how a worker that is not actually in a worktree registers nothing. Removing
that tree is the last thing you do, in section 5.

## 1b. When the machine refuses you

Three refusals exist and none of them is about you. `next` exits 6 when free memory is under the floor.
A hook refuses a full test suite or a full typecheck unless you hold the verify lane. A hook refuses a
browser call when the box is full and tells you to close your pane. Each one prints what to do next.

**A refusal is a wait, not an ending.** `next` gives you a loop to background; background it and end the
turn with that pending. A session that finishes because it was refused is a dead chat, and nothing in a
fleet can restart one [M03].

**While you are held, give memory back rather than waiting for someone else to.** A pane holds its
renderer until the tab is closed - a reload returns nothing, and one tab measured 2,061 MB [M34]. Closing
it costs a second and a login when you next need one.

## 2. Gate the pane before trusting it

The expression and its threshold are at the top of this file; `docs/BROWSER.md` carries the symptom list,
each entry of which reads as an application defect and is not. This section is what you do with the
reading.

Blind: in **one turn**, write `.fleet/<run-id>/<chip-id>.waiting` holding one line saying the pane is not
displayed and naming the viewport you measured, **ask the operator right there with `AskUserQuestion`**,
and arm `sleep 90; echo regate` with `run_in_background` so an unanswered question becomes another
measurement rather than a stall. Delete the marker the moment the gate reads live, and measure again
rather than trusting anyone's reply, because the reading is the proof: an operator can open a different
pane, or open one and collapse it, and both answers sound like yes.

**Ask immediately, not after three polite poll rounds.** A prompt that arrives four minutes after the chip
is a second visit to a chat the operator has already left. The question is cheap **because** they are
standing in front of that chat, and expensive only once they have moved on.

The marker is the other half, not the fallback: the planner's watch reports every `.waiting` within one
interval, in the chat the operator is actually reading, so a question asked in a chat nobody opens is still
visible where they are. Write both, every time. A worker stopped on a question looks exactly like a worker
still working, and the marker is the only thing that says otherwise.

Hold login and navigation until the gate reads live, since both hang for minutes through a blind pane and
the hang reads as a broken backend.

Gate again before each later batch of visual work.

## 3. Do the whole brief

Work every step of the brief before writing your final report. Depth is why a session was spent on this.

**File each finding through `find` the moment its evidence is complete**, not at the end. A worker that is
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

`sh "$f" find .fleet/<run-id> <chip>` with one JSON object on stdin, per finding, never a hand written
append: what it refuses is listed above. Read `docs/PROTOCOL.md`'s "Finding schema" and "Completion
markers" here, at the point you write one, for the meaning behind those fields and for the `unreached`,
`created` and `state_changed` line shapes that belong in the same file. Every finding carries evidence. An
empty findings file is a real result.

A worker that stayed blind writes `.fleet/<run-id>/<chip-id>.blocked` holding one line naming what it
could not see, and writes no findings.

## 5. End so that a person can see you ended

In pull mode `sh "$f" drained .fleet/<run-id> <chip>` is the whole ending: it writes `<chip>.done`, prints
the banner generated from disk, and prints the exact session title to set. Write that marker with the
command rather than by hand, because by hand skips the `queue-open` check, and a worker that finishes while
the planner is still filing work is a slot the run cannot get back. On an assigned brief there is no queue
and nothing to drain: write `.fleet/<run-id>/<chip-id>.done` yourself, last, after the findings file is
closed, and print the banner with `sh "$f" summary .fleet/<run-id> <chip>`. Either way the planner reads on
that marker.

If your brief carried `isolation: worktree`, commit and push your slice first, then unlink before anything
deletes. A `node_modules` junction inside your worktree is a hole a recursive delete follows into the main
checkout: measured seven times out of seven, `git worktree remove` with the junction in place emptied the
main checkout's `node_modules` [M32]. So remove the links first, with the command rather than by hand:

```bash
sh "$f" unlink "$(pwd -W 2>/dev/null || pwd)"
```

It walks the whole tree, not just the top level, because a junction at `sub/node_modules` is followed too.
Only then call `ExitWorktree` with `remove`, or leave the tree for the planner's `fleet.sh clean`. Full
procedure in `docs/WORKTREES.md`. Never delete your worktree with a recursive force-delete of your own.

Two things are then left:

1. **Rename this session** to the title the banner printed, if the host offers a session-title tool. That
   title is the only thing about you visible from the chat the operator is actually sitting in.
2. **Stop.** Let the banner stand as your report: no closing summary of the application, no advice about
   what to fix. That marker was the last thing you owed the disk, so nothing of yours may still be
   pending: a clock left armed past its obligation fires anyway, re-invokes a session with nothing to do,
   and leaves the operator looking at a chat whose task panel says running an hour after the work ended
   [M04]. Your own clocks read that marker and exit within thirty seconds; anything else in the panel is
   yours to stop.

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
- `<chip-id>.done` written last, after the findings file is closed: by `drained` in pull mode, by hand
  only on an assigned brief.
- Every background task of yours stopped, and your task panel empty. This is checkable, so check it.
- The banner printed and the session renamed.

## Report

The banner from `fleet.sh summary`, and at most two lines under it naming what you could not reach. The
app already has documentation; your summary of it helps nobody.
