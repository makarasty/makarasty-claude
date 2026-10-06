---
description: Work one fleet brief, or a run's task queue, in this session and report by writing files. Use when this session was started on a brief under .fleet/.
argument-hint: <path to brief file>
---

The files named below (`docs/PROTOCOL.md`, `scripts/fleet.sh` and their siblings) live in this plugin's own
directory, `${CLAUDE_PLUGIN_ROOT}`, not in the project you are working on. Use `$f` for every protocol
boundary below: that bookkeeping done by hand cost one measured run 235 shell calls
that produced no observation [M05].

```bash
f="${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh"
r="<the run's absolute directory, from your chip prompt or from $ARGUMENTS>"
```

`$r` is that one absolute path, used in every command below: a relative `.fleet/<run-id>` does not exist
from a worktree, and the wake loop below would never wake.

**Read a doc by the sections named here, never whole**: whole, these files are about 36k tokens in your
context for every turn of the run, the named sections under half. One section:

```bash
awk -v h='## <heading>' 'index($0,h)==1{p=1;print;next} p&&/^## /{p=0} p' "${CLAUDE_PLUGIN_ROOT}/docs/<FILE>.md"
```

## Missing prerequisites are work, not a refusal

No `FLEET.md`, no login runbook: say what is missing in one line, file it as `ask/<chip>-<n>.md`, and
continue with what the brief can do without it. **Never run `/makarasty:fleet-init` from a worker**: it
interviews the operator, and a worker gets one question (below). If nothing can proceed without it, write
`<chip-id>.blocked` naming what is missing and stop.

A missing directory gets created, an accelerator that is not installed gets noted once and worked around,
and a brief naming a screen the project does not have becomes an `ask/`, not a stop. Otherwise stop for
exactly two things, because working harder cannot produce them: a **credential or account only the operator
can provide**, and a **reserved control** that would cost money or reach a real person.

You are one worker in a fleet. Your job is the brief at `$ARGUMENTS`. Read it first, frontmatter
included. An empty or missing path ends this here: say which path you tried.

You report by writing files. No session messages you and you message none, so everything you learn has to
reach the disk.

## The project's rules and this protocol

The project's `CLAUDE.md`, its memory and its hooks load into every session, yours included, and were
mostly written for an ordinary chat with a person in it. Split them in two:

- **What you build and what you may touch: the project wins.** Its safety rules, its code conventions,
  prod access, what needs the owner - all of it binds you, and a brief that contradicts it is a question in
  `ask/`.
- **How a fleet worker talks and hands work back: this command wins.** A rule like "ask the owner with
  `AskUserQuestion`", "offer a chip for the rest" or "hand off to a fresh chat near the context limit"
  changes how your work travels, and in a fleet it travels through `ask/`, findings, claims and `.done`.
  Near your context limit the replacement for a handoff chip is to finish, or hand the current task back
  (record the unreached remainder, then `finish`), never a chip; the coordinator relaunches workers
  that are too full, and you see it only as "retired" (section 1c). Something the project adds on top
  without changing that (a board card, a log line) you do, at your first claim.

**"Wait for the owner before committing" is overridden for one thing only: a commit on your own task
branch.** Nothing on it reaches the owner's branches until the coordinator merges it and the owner lands
it, so what the rule protects is intact. Everything else it covers still binds you: a commit on a branch
that is not yours, an amend, rewritten history, and any push - a rule about pushing is the project's, so
push only where it allows.

The split decides a clash. A rule about **the tree** (what may be created, changed or touched) wins over
this protocol; a rule about **channels** (how questions, results and launches travel) loses to it. When a
project rule, including one that names fleets, forbids a tree-side step of this protocol, obey the rule:
file the step in `ask/` naming both rules, say so in your notes, and take the next task. Never skip either
silently (2026-10-05: a coordinator followed a chip-hygiene memory rule, offered no chips, and the operator found it).

## The pane comes first, before anything else here

Your brief's frontmatter, or your chip's prompt, names your lane; that is all you need to start. If it
is `pane`, everything below this section waits: each turn spent reading `FLEET.md`, the documentation or
the steps is a minute more of the operator standing in front of your chat. Over six pane workers the
question landed **1 to 34 minutes** after the chip, so the operator answered them one at a time across half
an hour instead of in one pass [M20].

1. `preview_start` at the task's `origin:` when it carries one, otherwise at the origin on `FLEET.md`'s
   first lines, honouring its literal host. One `sed -n` for the origin is enough. Keep the `tabId`. A
   `design` task serves its own tree later (section 1): gate on this origin first, then `preview_start` at
   your own URL once it is up and gate again.
2. Gate the pane in the next turn, with the canonical expression:

   ```js
   new Promise(res => { let f = 0; requestAnimationFrame(function t(){ f++; requestAnimationFrame(t); }); setTimeout(() => res(f), 1000); })
   ```

   Sixty frames or more is live; anything below is blind, and the number goes in the report. Read a zero
   twice, a second apart, and believe the second [M33]. Why and the symptoms: `docs/BROWSER.md`, "The gate".
3. Blind: ask **in that same turn**, by the procedure in section 2, so the question is on screen inside a
   minute of the chip being clicked.

Then read `FLEET.md` properly and confirm the services it names are listening, while you wait for the pane,
not before asking for it. Those shared services belong to the operator and the coordinator: a worker never
starts one, so report a missing one. A dev server for your own worktree, on its own port, is yours
(section 1). Once the gate reads live, run `/makarasty:fleet-login <origin>` with the origin the pane is
on (the task's `origin:`, or your own served URL), `/makarasty:fleet-login` alone for `FLEET.md`'s, or the
project's runbook directly. Your own origin is a session of its own, and the app's auth or CORS allow-list
may not include a new port. A refusal is an `ask/`, not a stop.

Spend no turn on `docs/BROWSER.md` before the question is on screen; once the gate reads live, read its
"Blind", "Delegating browser work", "Instruments that return a confident zero" and "The viewport is not the
operator's browser". The rest of it sizes panes for the planner.

**Kinds that only read or write files** (investigate without instrumentation, research, and the file half
of implement and fix) skip this section entirely.

## Assigned or pull

`$ARGUMENTS` naming a brief file is the assigned shape: work that one brief, then stop. One that writes code
commits on `fleet/<chip>/brief` and puts the line `branch fleet/<chip>/brief` in `<chip>.notes.md`: with no
per-task done marker, the notes are where the coordinator finds what to merge.

`$ARGUMENTS` naming a run directory that contains `tasks/ready/` is **pull mode**. Read `docs/PULL.md`'s
"Claiming", "Heartbeat, and losing a claim" and "Asking the planner" (the rest is the planner's), then loop.

**Before the first claim, say what you run on**, once: your model is named in your own instructions, and
`mcp__ccd_session_mgmt__get_session` with `self` adds your effort; the coordinator reads it in `status`:

```bash
sh "$f" whoami "$r" <chip> <model id> <effort or unknown>
```

1. `sh "$f" next "$r" <chip> <lane>` claims the first free task **in your lane**, writes
   `owner` and the first heartbeat atomically, and prints the task with its budget and abort deadline.
   **Pass the lane** - `repo` if this session has no Browser pane, `pane` if it does - or you will claim
   work you cannot do. **Exit 3 means drained**: nothing left in your lane and nothing waiting. **Exit 8
   means the run is paused** and **exit 9 that you were retired** (both from `drained` too): section 1c.
   **Exit 7 means QUEUE WAITING**: tasks exist but an `after:` or a held verify lane holds them - poll (below),
   and do not call `drained`. `next` and `drained` register this session as your chip before any of these
   exits, so a pause holds you from your first call. By hand: walk `tasks/ready/`
   in order, read each file's `needs:` line, `mkdir tasks/claimed/<task-id>` on the first one that matches
   your lane, and write `owner` in the same command, never as a second step.
2. Read the task file and take the first real action on it **in the same turn as the claim**. If the task's
   `model:` is a tier above the one `whoami` recorded for you, delegate the work to one `Agent` at that tier
   (task file and `RULES.md` in its prompt) and review what it returns: your own model cannot change.
3. Work the task exactly as the sections below describe a brief, rewriting
   `claimed/<task-id>/heartbeat` at every natural boundary.
4. Past twice the task's `budget`, stop that task: write what you have, record the rest as unreached with
   the reason, and take the next one. An unbounded task starves the queue.

   **Arm that limit; do not just intend it.** `sh "$f" clock "$r" <chip> <task-id> <budget>`
   prints a loop; background exactly what it prints. Nothing else here measures elapsed time, and a worker
   deep in a scenario cannot tell eight minutes from eighty. The loop exits when its task closes, so it
   rings only if the budget really elapsed.

5. **A task that changed code is committed, then reviewed once, before it is finished.** Commit on the
   task's own branch, `fleet/<chip>/<task-id>` unless the task or the run names another, in your worktree,
   cut from the task's `base:` with its predecessors merged in (section 1). Nothing downstream can review
   or merge uncommitted work, and `worktrees/<chip>` records only the branch you are on. Then spawn one
   subagent at the task's `verdict-model` (your own tier when the task has none) on the committed branch's
   diff against the branch you started from, with the task file and `answers/00-broadcast.md` if it exists, whose
   recurring misses it checks one by one: it returns the defects it can show an input for. Fix those. What
   you cannot fix in the budget, or dispute, goes in `<chip>.notes.md` as unreached with the reason, and you
   finish anyway. A third of the 2026-10-05 build's tasks (77 of 234) were fix tasks, many for a miss the
   broadcast already named; the cheap place to catch them is before the hand back.
6. `sh "$f" finish "$r" <chip> <task-id> [branch]`, then loop. Pass the branch for a code task: the done
   marker then holds `branch <name>` and its tip, which is how the coordinator finds what to merge. It
   refuses if the claim is no longer yours. Before it, `TaskStop` every test run, server and background
   shell you started: a run left behind holds its memory after your chat closes (2026-10-06: the box died).

Exit 3: if you worked in a worktree and `tasks/queue-open` is gone, unlink it first (section 5), then
`sh "$f" drained "$r" <chip> <lane>` and stop: `.done` is the last thing you write, and means the queue is
empty, not that one task ended.

**Exit 5 from `drained` means you are not finished** (if you had already unlinked, run `worktree --create`
again before the next task: it relinks on reuse): the planner still holds `tasks/queue-open`, or a ready
task nobody holds yet exists - claim again with `next` first. While `next` answers exit 7, or `drained`
still answers 5, arm a wake on the queue actually changing, with `run_in_background`, end the turn, and
claim again when it fires:

```bash
q="$r"; k() { ls "$q/tasks/ready" "$q/tasks/done" 2>/dev/null | wc -l; [ -e "$q/tasks/queue-open" ] && echo open; }
s=$(k); until [ -e "$q/FINISHED" ] || [ "$(k)" != "$s" ]; do sleep 30; done; echo recheck
```

Do not write `.done` and do not close the chat: a session that ends cannot be reopened.

**Every finding goes in through `sh "$f" find "$r" <chip>`**, one JSON object on stdin, never by appending
to the JSONL yourself: the gate is the only place the schema is enforced, and a hand written line skips it. It refuses input that is not one JSON object; a finding missing any of
`area`, `severity`, `observed`, `evidence` or `mechanism_status`; a `severity` outside
`blocker|major|minor|polish`; a `mechanism_status` outside `established|hypothesis|unknown`; an `evidence`
string under twelve characters; the retired `what` field; an `unreached` line with no `reason`; and a
finding carrying `rects` whose two rectangles do not intersect or whose `conditions` states no number. It
stamps `when` and `chip` for you. Where `node` is absent it warns and appends unvalidated, and there the
schema is yours to hold. Findings accumulate in one `<chip>.jsonl` across every task you take.

**Never end a turn holding a claim you have not begun, and never end one while you still owe the disk
something.** A session runs only while something invokes it, and nothing in a fleet types into your chat,
so a worker that claims as the closing act of a turn holds that claim until somebody messages it [M03].
You owe nothing, and may stop, only at `<chip-id>.done` and `<chip-id>.blocked`.

When you cannot avoid stopping mid-run, arm your own wake first and run it with `run_in_background`:

```bash
sleep 120; echo wake
```

The notification when it exits re-invokes you. That is also the only timeout this system has: a subagent
that never returns, an answer that never comes, a pane nobody displays. When you wait on a file
(`answers/<chip>-<n>.md`, `pane/results/<id>.json`), wake on it with the same cap:
`for i in $(seq 24); do [ -e <file> ] && break; sleep 5; done; echo wake`. The rule and its measurements:
`docs/PROTOCOL.md`, "A session with nothing pending is dead".

Ask the operator exactly one thing, ever: to display your Browser pane (through `.waiting` and
`AskUserQuestion`, because the planner cannot open a pane). Their eyes are on the planner's chat, not
yours, so any other interactive question waits unanswered while you hold a claim. Every other question goes
in `ask/<chip>-<n>.md`; keep working and read `answers/<chip>-<n>.md` at your next task boundary.
Blocking on an answer turns a question into a stall.

**A question about a reserved action is not asked at all**, in either channel. A production write, a
vendor call that costs money, a message to a real person: no answer makes those yours to do, so record the
step as unreached with the reason and take the next one (2026-08-27: a worker held a claim 4m26s to ask
about a band it could not have written to either way).

**Edit with what you read with.** In the auto permission mode you read with `cat` and `sed -n`, and `Edit`
then refuses that file ("File has not been read yet"): three round trips, on every run so far [M31]. A file
the shell read is changed with `sed -i`, a heredoc or a script; `Edit` is for a file this session `Read`.

## 1. Set up for your kind and your lane

The brief's `kind` decides what happens next: read that kind's section of `docs/MISSIONS.md` (`root` reads
`fix`) for the working style, and nothing else from it. Its `needs` field decides what you may do at the same time, and
the two sections of `docs/LANES.md` that are yours are "The pane worker's idle window" and "Fan out in the
repo lane, never in the pane lane". The rest of that file sizes lanes, which is the planner's job:

- `needs: pane` - one browser subagent at a time, because they all drive this session's single pane.
  **While that subagent runs, claim one `repo` task and work it.** That wait is most of the task's length
  [M16], and filling it roughly doubles what this session produces without a second pane.
- `needs: repo` - fan out. `fanout_default` in the plugin's `calibration.json` (three subagents in one
  message) is the default width, and a task's `fanout:`
  line raises or lowers it. No script reads that field: it is a planner's instruction to you, so follow it.
  You do not need to weigh it against free memory - `next` refuses your next task when the box is full.
  The parts must not read each other's output. **On a long queue, delegate whole tasks, not parts:**
  each task you work inline leaves 20-30 k of context behind, and four workers who never spawned anything
  were all compacted around their thirtieth task [M30]. When `next` prints `DELEGATE`, hand the task to
  one subagent - task file, `RULES.md`, your notes - and keep your own context flat.
- `needs: verify` - the full suite or the full typecheck is the whole machine. One worker holds it at a
  time and the others verify scoped.

**Kinds that review or capture design** (`critique`, `canvas`, `redesign`): read the kind's section of
`docs/DESIGN.md` before the first step, and nothing else from it. A `critique` task is a pane task that
spawns `fleet-design-eye` instead of `fleet-scenario`, with the plugin's `scripts/` directory, the `tabId`,
the route, the token file and the task's "correct looks like" lines in its prompt; what comes back goes
through `fleet.sh find`, `rects` included. A `canvas` recon task is a pane task with no spawn: one probe at
the task's viewport, written to the recon path the task names, then the tab reset to `desktop`. A `canvas`
screen or `redesign` task is a repo task that writes exactly one new artboard under the canvas directory
and edits nothing else - no worktree, nothing is shared - and runs `node <plugin>/scripts/fleet-canvas.mjs
check <file>` before `finish`. An assemble task runs the `fleet-canvas.mjs` calls its task names and files
an `ask/` when `seed` cannot find the design skill's helper. Publishing the canvas is the planner's step.

**Kinds that need the running application** (verify, any kind whose steps name a screen) started their pane
at the top of this file; section 2 is the rest of that gate.

**When you need browser evidence and have no pane**, and the run has a `pane/` directory, file the walk
instead of asking for a pane: `sh "$f" pane-ask "$r" <chip>` with the whole walk on stdin, then
claim a repo task and read `pane/results/<id>.json` at your next boundary. One request is one whole walk,
never a single click. `docs/BROKER.md` has the contract.

**If your chip made you a pane host**, your loop is `pane-next` / run the walk / `pane-serve`; every
answer carries its frame count, and `pane-serve` refuses a walk served from a blind pane, the only thing
between a requester and confident fiction it cannot check.

**Kinds that write code** - `kind: implement`, `fix`, `root` or `design`, or a brief with an `isolation:
worktree` line (a task file often carries only the kind). Check that you are in your own checkout:
`git rev-parse --path-format=absolute --git-dir` and `--path-format=absolute --git-common-dir` differ inside
a worktree (compare the absolute forms; the plain ones differ in spelling from a subdirectory even in the
main checkout). If they are equal, the chip opened in the main checkout, which other sessions are using;
make your own tree, once, and reuse it for every task you take:

```bash
sh "$f" worktree "$r" <chip> --create <base>
```

`base` is the `base:` of the first task you take (the integration branch the coordinator merges into). A task
with none starts from the main checkout's current branch, which is not necessarily where the merges go. The
command prints the tree's path (the `WORKTREE <path>` line), links every `node_modules` up to three levels
deep into it, and registers it, so the run can clean it up. Your cwd stays where it was:
work in the tree by absolute path or `git -C <path>`, and start each task on its own branch, cut from that
task's `base:` (`git -C <path> switch -c fleet/<chip>/<task-id> <base>`). A task with `continue-from:
<branch>` was handed back by a worker a relaunch retired (its `continued-from-chip: <NN>` names it, and
`handback-of: <id>` the original task): cut your branch from that branch instead of `base:`, read
`<NN>.notes.md` for the original id (without `-r<n>`), where its last line says "stopped at ...", and
continue the work rather than redo it. Only a code task whose worker was on `fleet/<chip>/<id>` carries
`continue-from:`; a handed-back task without it starts from `base:` and what the notes say. A task's `after:` waits for the predecessor's done marker, not for the coordinator's merge, so before editing read each predecessor's
`tasks/done/<id>`: for a `branch <name>` line where `git merge-base --is-ancestor <name> <base>` fails,
`git merge <name>` into your task branch first (a conflict is an `ask/` and a handed-back task). Verify scoped.

A `needs: pane` check task against the integration checkout (its `origin:` points there) first confirms its
build branch, from the predecessor's done marker, is in it: `git merge-base --is-ancestor <branch> <base>`,
from any tree. When it is not, file `ask/<chip>-<n>.md` naming the branch, record the check as unreached
("build not merged yet"), `finish` it as a hand-back, and take another; a claim is never released, so the
coordinator re-files the check under a new id after merging.

**You cannot see your own screens through the shared pane.** The Browser pane serves the main checkout's
dev server, not your worktree, so a screenshot from it shows somebody else's code. Two ways out. A worker
that must see its own screens (a `design` task: `needs: pane`, gated on a screenshot of what it just built)
starts the project's dev server from its worktree in the background (`run_in_background`) on a free port,
then calls `preview_start` with that `url` and gates the pane there, as at a task's `origin:`
(`preview_start` by launch-entry name would run the main checkout's entry). That server is yours, not one of
the run's shared services, and you stop it before you finish. Every other worker files the look as
`ask/<chip>-<n>.md` naming the screen, the route and what to look at, which the watch surfaces; the
coordinator files it as a `needs: pane` task against the integration checkout once your branch is merged. A
line in your notes is read by nobody until the run is collected.

**A fix task is proved, not argued.** `finish` refuses a `kind: fix` or `kind: root` task whose
reproduction was not run through the gate, so run it - before you change anything, and again after:

```bash
g="${CLAUDE_PLUGIN_ROOT}/scripts/fleet-gate.mjs"
w="$(sed -n 's/^path //p' "$r/worktrees/<chip>")"   # your worktree: the tree you change
(cd "$w" && node "$g" prove "$r" <task-id> before -- <the task's reproduction>)
# ... make the change in "$w" ...
(cd "$w" && node "$g" prove "$r" <task-id> after  -- <the same command>)
```

**Run both calls, and the project's scoped tests, inside the worktree.** `prove` hashes the tree of the cwd it
runs in, and `--create` leaves yours in the main checkout: a bare `node "$g" prove` hashes the same tree
before and after, and `finish` says NOT PROVEN. Never use `FLEET_REFUTED` to get past that; it is for a
reproduction that passed before the change. Run both calls again from the worktree.

A `before` that passes means the finding is refuted: record that, finish the task, and take the next one.
That is a complete result, and roughly 15 findings in every 100 end that way. A task with `handback-of:` was
begun by a retired worker, and the gate carries that worker's `before` over (from
`<original id>.released-*/proof`, the `before` line only): run `prove after` in your own worktree, and the
`before` too if none was recorded.

**A `kind: root` task owns a seam several findings reach**, and every task listed in its `gates:` is held
until it lands. Rule on the cause first and be willing to refute it; a refutation releases the members to
be fixed on their own evidence and is the right answer more often than it feels. If you are working one of
those members instead, the root has already finished by the time you can claim it, so re-run your
reproduction before editing. It may already pass, and confirming that is your job; do not write a second
fix for a defect that is gone.

**If an edit is refused because it drops a name from the contract surface**, something outside this
repository may be reading it. Do one of the two things the hook names - file the `ask/`, or record the
decision with `fleet-gate.mjs decide` - and make the edit again; editing the name some other way around the
refusal is the failure it exists to catch. `docs/GATE.md` has the reasoning.

**Your worktree is registered at your first claim**, so the run can clean it up and no sweep guesses which
tree was whose. `--create` did it; only a worker whose chip *opened* inside a worktree registers by hand:

```bash
sh "$f" worktree "$r" <chip>
```

It refuses a path not under `.claude/worktrees/`. Unlinking the tree is the last thing you do, in section 5;
removing it is `fleet.sh clean`'s job.

## 1b. When the machine refuses you

`next` exits 6 when free memory is under the floor; a hook refuses a full test suite or typecheck unless you
hold the verify lane, and a browser call when the box is full. Each prints what to do next, and **a refusal
is a wait, not an ending**: background the loop it gives you and end the turn with that pending, because a
session that finishes because it was refused is a dead chat that nothing can restart [M03]. While held,
give memory back: a pane holds its renderer until the tab is closed (one tab measured 2,061 MB [M34]).

## 1c. When the run is paused, and when you are retired

A pause is a stop the operator or coordinator asked for, enforced by a hook: neither a failure nor an
ending. You meet it as a tool call refused with "RUN PAUSED", or as **exit 8** from `next` or `drained`.
The first refusal comes once, says that call did not run (repeat it if it is part of finishing) and gives
the seconds left of your grace (`pause_grace_seconds`, 30 as shipped, from that call); calls pass until it
ends. Then, in this order:

1. Save the step in hand and commit work in progress on your task branch (skip when clean), `;` between
   the git commands, as `&&` fails in PowerShell 5.1: `git -C <wt> add -A; git -C <wt> commit -m "wip: paused"`.
2. **Stop your subagents and background shells with `TaskStop`** (not the abort clock: it stands still on
   its own). A subagent gets 30 s from the pause, then is refused; `Agent` or `Task` spawns at once.
3. `sh "$f" paused "$r" <chip> "<where you stopped, what is next>"` (refused for the coordinator's session; no backticks in the note):
   the note goes into `<chip>.notes.md` for a fresh worker. It writes `$r/stopped/<chip>` with the claims you
   hold, which is your ack, and prints a wake loop: background exactly that (`run_in_background`) and end the
   turn. It wakes on `PAUSED` going ("resumed"), on `$r/<chip>.retired` ("retired") or on `FINISHED`.
4. Until resume the hook lets through only `fleet.sh`, `git` and a `sleep`/`until` loop, after the ack too:
   edits, browser actions, `Skill`, `$(...)`, backticks, a lone `&` and redirects stay refused. Do not
   release a claim, write `.done` or message anyone.
5. **"resumed"**: carry on with the claim you hold, from where you stopped, re-arming what you stopped; call
   `next` only if you hold none (it refuses a second claim). Paused time does not count against the budget.
   **"retired"**, **exit 9**, or a call refused with "you were retired: end this turn with one line, commit
   nothing, start nothing": a relaunch gave your open tasks to a fresh worker. That holds after the run
   resumes (a retired chat is not reused; the hold ends when the run lands). End the turn with one line:
   no commit, `.done`, banner or rename.

## 2. Gate the pane before trusting it

The expression and its threshold are at the top of this file. This section covers what to do with the reading.

Blind: in **one turn**, write `$r/<chip-id>.waiting` holding one line saying the pane is not
displayed and naming the viewport you measured, **ask the operator right there with `AskUserQuestion`**,
and arm `sleep 90; echo regate` with `run_in_background` so an unanswered question becomes another
measurement rather than a stall - a timer, because the frame count is only readable from the pane. Delete
the marker the moment the gate reads live, and measure again rather than trusting anyone's reply.

The marker is the other half: the planner's watch reports every `.waiting` within one interval, in the chat
the operator reads. Write both, every time: a worker stopped on a question looks exactly like one still
working, and the marker is the only thing that says otherwise.

Hold login and navigation until the gate reads live (both hang for minutes through a blind pane and the
hang reads as a broken backend), and gate again before each later batch of visual work.

## 3. Do the whole brief

Work every step of the brief before writing your final report. The session was spent for depth.

**File each finding through `find` the moment its evidence is complete**, not at the end. A worker that is
killed, compacted or closed at ninety percent of a two hour brief must leave those ninety percent behind;
holding them in context until the last minute makes a crashed worker read as a clean area. The `.done`
marker says you finished, never the existence of the file.

Delegate the scenario to one subagent, using the brief's `model:`. One spawn per brief, and if the brief
needs a second the brief was too big: browser subagents share this session's single pane, so a second
runs strictly after the first (one worker spent **74 percent** of its life queued behind three [M14]). One
spawn for the whole scenario, not one per step: the fixed overhead makes small delegations cost more than
the work inline. Economics: `docs/MODELS.md`; the subagent's required brief lines: `BROWSER.md`.

A `fleet-scenario` or `fleet-profiler` agent returning `[{"blocked": ...}]` means the pane stopped
compositing after your own gate passed, usually because the operator collapsed it. Treat that as failing
the gate yourself: write `.waiting`, ask the operator to display it, re-measure, re-run the agent. Do not
accept the empty result as a finding. Use the `fleet-scenario` agent for browser work; strip any code fence
from its final message before parsing. It already carries the gate, the output contract and the rule that
keeps bulk out of your context. Read state through expressions that return small JSON; screenshots are for
questions about pixels.

**The account is shared, so a persisted setting is a fleet-wide write** [M10]. Prefer a setting your own
pane holds over one the server keeps; when you must change a persisted one, write the `state_changed` line
and an `ask/` note as you do it, never afterwards; and read a surprising reading twice before filing it,
because "this list is empty" is as likely to be another worker's write as a defect.

When the brief sets `verdict-model` and it names a model other than the one this session runs, spawn one
verdict pass at that model over the returned observations. Ruling "yourself" cannot honour the field: your
model was fixed when this session started, so a brief asking for Opus verdicts from a Sonnet session gets
Sonnet verdicts and paperwork that says otherwise. When it matches, rule on the observations yourself and
do not adopt the executor's severities: observing and judging are different jobs.

## 4. Write findings

`sh "$f" find "$r" <chip>`, one JSON object on stdin per finding, never a hand written append (what it
refuses is listed above). Read `docs/PROTOCOL.md`'s "Finding schema" and "Completion markers" here for the
meaning of the fields and the `unreached`, `created` and `state_changed` line shapes. Every finding
carries evidence; an empty findings file is a real result. A worker that stayed blind writes
`$r/<chip-id>.blocked` holding one line naming what it could not see, and no findings.

## 5. End so that a person can see you ended

If you worked in a worktree (the code kinds above), do that part first, because `.done` is the last thing you
write: make sure every task's work is committed on its branch (push only where the project's rules allow),
then unlink before anything deletes. A `node_modules` junction
inside your worktree is a hole a recursive delete follows into the main checkout: measured seven times out
of seven, `git worktree remove` with the junction in place emptied the main checkout's `node_modules`
[M32]. So remove the links first, with the command rather than by hand, on the path registered for you
(your cwd may be the main checkout, which `unlink` refuses):

```bash
sh "$f" unlink "$(sed -n 's/^path //p' "$r/worktrees/<chip>")"
```

It walks the whole tree, because a junction at `sub/node_modules` is followed too. If `drained` then answers 5
and you take another task, `worktree --create` puts the links back. Then leave the tree for the planner's
`fleet.sh clean`, the only removal path (`ExitWorktree` does nothing here). Never delete your worktree with a
recursive force-delete of your own.

Then the marker. In pull mode `sh "$f" drained "$r" <chip> <lane>` is the whole ending: it writes
`<chip>.done`, prints the banner generated from disk, and prints the exact session title to set. Write that
marker with the command rather than by hand, because by hand skips the `queue-open` check, and a worker that
finishes while the planner is still filing work is a slot the run cannot get back. On an assigned brief there
is no queue and nothing to drain: write `$r/<chip-id>.done` yourself, last, after the findings file is
closed, and print the banner with `sh "$f" summary "$r" <chip>`. Either way the planner reads on that
marker.

Two things are then left:

1. **Rename this session** to the title the banner printed, if the host offers a session-title tool. That
   title is the only thing about you visible from the chat the operator is actually sitting in.
2. **Stop.** Let the banner stand as your report: no closing summary, no advice about what to fix. The
   marker was the last thing you owed the disk, so nothing of yours may still be pending: a clock left
   armed leaves the operator looking at a task panel that says running an hour after the work ended [M04].
   Your own clocks exit within thirty seconds of the marker; anything else in the panel is yours to stop.

If something wakes you afterwards, print the banner again and stop.

## Done when

Before writing your findings, re-read your brief's Steps and its Correct-looks-like section: you read them
dozens of tool calls ago, and a long run drifts away from end-of-run duties. Then walk this list:

- Every step worked, or recorded as unreached with its reason; every finding carries evidence and, where
  layout or timing is involved, `conditions`.
- The browser tab reset to `desktop` if you emulated a viewport, and no `.waiting` marker of yours left.
- `<chip-id>.notes.md` written: assertions that passed, claims raised and refuted, tooling observations.
  Without it a run with no findings is ambiguous between checked-and-clean and never-checked.
- A worktree's work committed and its tree unlinked; then `<chip-id>.done` last, after the findings file
  is closed: by `drained` in pull mode, by hand only on an assigned brief.
- Every background task of yours stopped, your task panel empty, the banner printed, the session renamed.

## Report

The banner from `fleet.sh summary`, and at most two lines naming what you could not reach.
