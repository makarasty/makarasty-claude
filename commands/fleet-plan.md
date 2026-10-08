---
description: Plan a fleet run and launch it - interview the operator, split the mission into a queue or briefs, offer one worker chip per worker, arm the watch. Use when the person asks to run, launch or start a fleet ("запусти флит", "запускай флот на это"), or a handoff or a relaunch makes this chat a fleet's coordinator. Never start one unasked.
argument-hint: <mission in plain words> [fast]
---

The `docs/*` and `scripts/*` files named below live in this plugin's own directory,
`${CLAUDE_PLUGIN_ROOT}`, not in the project you are working on.

## Missing prerequisites are work, not a refusal

No `FLEET.md`, no login runbook, no `.fleet/`: say what is missing in one line, run
`/makarasty:fleet-init` to produce it, and continue into the work the operator actually asked for. A
missing directory gets created, an accelerator that is not installed gets noted once and worked around,
and a brief naming a screen the project does not have becomes a question in `ask/` rather than a stop.
Stop for exactly two things, because neither can be produced by working harder: a **credential or account
only the operator can provide**, and a **reserved control** that would cost money or reach a real person.

A person reads this chat and only this chat, so write for them, not for a parser. If the
`makarasty-tools` plugin is installed, `/makarasty-tools:unslop on` does it for you.

Split the mission in `$ARGUMENTS` into briefs, one per worker session, then offer a chip for each and
stop. You write briefs. You do not do the mission.

**The project's rules and this command.** The project's `CLAUDE.md` and memory bind what the workers build
and touch. They do not decide how a fleet launches and reports: chips, their titles, the queue, `ask/` and
the watch are this command's. A chip is an offer the operator can decline with one click, so offer every
one of them. A rule written for ordinary chats - "chips only for one real defect", "one task per
session" - does not stop you, and neither does a rule that names fleets ("never a fleet worker"): if one
seems to forbid chips for fleet workers, quote that rule to the operator in this same turn
(`AskUserQuestion`), with the chips already offered in the same message; never replace chips with paste
lines. Measured 2026-10-05: a coordinator followed exactly such a rule, gave the operator paste lines
instead, and the operator had to ask why.

**A plan that already exists is the draft, already stopped moving.** A handoff or a plan document with its
own task list means section 2b has been done: carry its decisions into the queue and skip the interview.

Read `docs/PROTOCOL.md`'s "Directory layout", "Brief format" and "Finding schema" before you write one -
those three are the run's shape and the contract you restate in every brief - and the section of
`docs/MISSIONS.md` for the kind you are planning. Neither file is short, and the rest of both is worker
material or covers a kind you are not running.

## 1. Ground yourself in the project

Read the project's `FLEET.md` if it has one. It carries the app origin, which services must already be
running, the login runbook, the naming rules, and the actions reserved for the operator. If it names its
services in any shape other than the one `- Services:` line (`fleet-init` section 3), rewrite that line now
and ask the operator which services are theirs to start: the watch reads only that line, and an old-format
one leaves a run with nothing watching its backend.

Then read the project's own documentation for the area the mission touches. Start at its index and follow
it to the specific page. Briefs written from memory of a feature invent names, and a brief that names a
screen the project does not call that produces findings nobody can match to anything.

Search with `rg` for text and with `sg` for TypeScript structure when both are available. Send independent
searches in one message, since each round trip costs a full model turn.

## 2. Choose the kind, then the axis

The mission's kind decides how it splits, and the wrong axis makes a fleet run worthless. Take the
axis from `MISSIONS.md`: screen ownership for verify, hypothesis for investigate, seam for implement, file
cluster for fix, source for research, one screen for design, critique, canvas and redesign.

A `design` mission also has a wave order the others do not: recon, then the single task that owns the
shared primitives, then the screens. File all three waves at once and gate wave three on wave two with
`after:` (section 3b) - a screen task that starts before the primitives are settled either restyles a
primitive under another worker's feet or inherits a defect it is not allowed to fix, and `after:` is what
stops it from starting. A `kind: design` task is `needs: pane`, since its gate is a screenshot of what it just
built: the worker serves its own worktree from a dev server it starts itself (`docs/MISSIONS.md`, "design"),
so file it in the pane lane even though it also writes code.

A `canvas` or `redesign` mission has its stages fixed and its own planner: `/makarasty:fleet-design` and
`/makarasty:fleet-redesign` write those queues, gates included, and hand back to the sections below for
the chips and the watch. Both carry `disable-model-invocation`, so you cannot invoke them from here: say
which one this mission wants and let the operator run it. A `critique` mission is planned here like a
verify one, with the "Critique" section of `docs/DESIGN.md` - and nothing else from that file - supplying
what the task carries: the screens and their states, the token file, and the assertion lines.

Count the independent slices the axis produces. That is your worker count, and **it is capped per lane,
never once for the whole fleet.** The repo lane is capped by the machine and sized from the queue, by the
rule in `docs/LANES.md`; the verify lane is one; and the pane lane has three numbers that are not
interchangeable. **The default is two**, and you start there: `pane_workers_default` in the plugin's
`calibration.json`. `pane_workers_display_ceiling` in the same file is the **usable** ceiling, what tiles
side by side at a readable width with nothing stacked below; plan against it, do not start from it. **Ten
is the physical ceiling**, where panes stop being panes; between the usable ceiling and ten they stack in a
second row at half height, which is a decision for the operator, not a gradual slope. Read both values from
`calibration.json` and do not retype them, and read the project's `FLEET.md` concurrency line for the
widths this machine and this display were actually measured at.

A single cap across both lanes is how a run ends up eight browser workers wide and two files wide.
Measured 2026-08-31: fourteen workers ran on a box sized for it, six on panes and eight on files, and the
plan that produced them had to argue its way past this paragraph to do it.

**Then size the pane lane down, hard.** Seven open panes once carried under one pane's worth of actual
browser driving, one of them driven for zero minutes over sixty-one [M15]. Each pane you open past what the
work needs costs the operator a question, a piece of their screen, and the standing obligation to keep it
displayed, and buys nothing while nobody is driving it. If the mission is large enough that two panes will
queue, read `docs/BROKER.md` and file browser walks against one or two hosts instead of opening more.

Two workers on one slice cost twice and then agree with each other, which reads as corroboration but is
not.

**Then give every slice a lane**, from `docs/LANES.md`: `pane` for work that needs the running interface,
`verify` for work that runs the suite or the typechecker, `repo` for everything answerable from files. Do
this before writing a single step, because a slice drafted as a browser walk stays one even when its
evidence is a file reference. Measured 2026-08-27: 33 of 34 tasks were written as browser tasks and
several never needed a pane, including an audit that read source files for eight minutes while holding a
pane slot a browser task was waiting for.

The pane lane's width is how many panes fit a display. The repo lane's is the machine. A mission with no
pane slices at all is a normal mission, not a special case.

**The opposite error is the one that hides.** A build whose done-when includes how a screen looks needs
pane work, filed as `needs: pane` tasks behind the tasks that build those screens. Do not keep the visual
checks for yourself: a pane worker asks for its pane within a minute of starting, while a coordinator
checks screens between reviews, finds its pane blind, and the checks pile up. Measured 2026-10-05: a build
run filed every task `repo`, the coordinator did the screen checks, and its pane read 0 fps an hour in.

## 2b. Interview the operator until the plan stops changing

The operator writes a mission in plain words from a fresh chat that knows nothing. Turn that into a plan
good enough to run unattended; the only way is to ask. Default to depth: an argument of `fast` means stop
after the first round with whatever the draft says, and without it you keep going until the plan stops
moving.

**Hold a complete draft plan from the first exchange.** Not a list of open questions, a plan: run id, kind,
axis, the slices with their lanes, what correct looks like for each, the reserved actions. It may be
wrong. It may not be absent, because the draft is what makes the interview terminate.

**Ask only questions whose answer would change a named line of that draft.** Then the stop condition is
mechanical: **a round that changes nothing ends the interview.** Stopping when the questions run out is a
formality; stopping when the plan stops moving is a decision procedure, and in practice it takes three to
five rounds.

Ask a whole round at once, numbered, each with your recommended answer, so the operator can reply "all
yours" and lose nothing:

```
Q1 - Axis: I am splitting by screen ownership, six slices. The alternative is by user role, which
     would cross every screen and make two workers report the same defect.
     -> Recommend screen ownership.
```

Order the rounds by **invalidation radius**, largest first, since a wrong answer high up throws away
everything below it:

1. **Kind and axis.** One wrong choice here makes the whole run worthless.
2. **The slice list**, presented enumerated and concrete, to be corrected rather than answered. Correcting
   a wrong list is fast and produces ideas; "which areas matter to you" is slow and produces mush.
3. **What correct looks like, per slice.** This is where the depth belongs and where most rounds go. The
   operator says something vague, you convert it into an assertion and offer it back: "the Completed tab's
   count equals the rows it lists" is checkable, "the tabs work" is not.
4. **Reserved actions and the writing band**: what may be created, changed or sent, and what is the
   operator's alone.

**Three classes of question are refused outright.**

Anything discoverable. The origin, the login path, which screens exist, what a component is called, how
long the suite takes: you have a repository, a `FLEET.md` and search tools, and asking shows that step 1
was skipped. Dispatch a subagent to find it and ask the rest of the round meanwhile.

Anything policy already answers. A question whose answer cannot change what is permitted is not a
question: production writes, vendor calls that cost money, messages to real people are reserved whatever
anyone says.

Budgets and worker counts. You have the measurements: budgets written at 40 and 45 minutes were met by
three tasks out of 36, and the pane lane holds as many workers as the display holds panes. For the first
wave state a default budget and say it is replaced by the run's own measured median (`fleet.sh status`,
section 3b) once three tasks are done. State those and move on.

**The failure mode is interview theatre**: good questions, answers collected, and then the plan you would
have written anyway. The guard: every answer visibly edits a named line of the draft, and you show the
edit. If an answer changes nothing, that question should not have been asked, and the round it was in
was the last one.

## 3. Write the briefs

One file per worker at `.fleet/<run-id>/brief-NN.md`, in the format `PROTOCOL.md` gives.

Every brief carries:

- **Exclusive ownership.** `owns` lists what this worker may touch, and the out of scope section names the
  areas the other workers hold, by number.
- **Assertions, not intentions.** "The Completed tab's count equals the number of rows it lists"
  gives a worker something to be right or wrong about. "Check the tabs work" does not.
- **The evidence contract**, restated in one line: a finding carries a `file:line`, a reproducing
  expression, or three readings with spread and machine load.
- **A model per queue worker, a model per task.** `model:` names the tier a task wants and `verdict-model:` the
  tier that rules on it, from `docs/MODELS.md`. Lanes stay `pane`, `repo` and `verify`: an `opus` lane
  (2026-10-05) left four idle Opus workers unable to take a waiting task. The worker's own model is yours
  to choose per lane, passed to `fleet.sh chips` as `--model <id> --effort <level>` (a brief worker's is
  picked by the operator before the click) and switched by you when
  a chip starts on something else (`docs/MODELS.md`, "Switching a worker"). A task above its worker's tier
  is delegated by that worker to one `Agent` at the tier (`fleet-run`).
- **Whole brief demand.** The worker completes its entire brief before writing findings and does not
  stop at the first interesting thing.

Briefs that write code carry `isolation: worktree`, and queue tasks of `kind: implement`, `fix`, `root` or
`design` are worktree work whether or not they say so. The worker makes its own with `fleet.sh worktree
<run> <chip> --create <base>` when its chip opened in the main checkout, with the `base:` of its first task;
every code task carries `base: <the integration branch>`, the branch you merge finished work into (section
8b), because a worker's own default is the main checkout's current branch, which is not necessarily it.
Never write worktree setup into the run's rules by hand. A coordinator that did put its trees at `C:/wtRM01`, outside `.claude/worktrees/`,
where nothing in the plugin can register or clean them.

## 3b. Fixed briefs, or a queue

Eight briefs freeze one guess about where the defects are for the whole run. Over a surface larger than
the plan, write a **queue** instead: read `docs/PULL.md` and put tasks in `tasks/ready/` rather than briefs
in the run root.

Pull mode changes five things for you. **File the whole queue before the first chip**, every wave of it,
and hold the order with `after:`: a task waits in the queue until the tasks it names are done, and costs
nothing while it waits. Mind what `after:` waits for: the predecessor's **done marker**, not your merge of its
branch. A task that builds on another's code finds it in neither its base nor its tree unless the worker
merges the predecessor's `branch <name>` (from the done marker) into its own branch first, which
`fleet-run` tells it to do; write `base:` and `after:` on such a task so it can. A `needs: pane` check task
`after:` its build task is held until the build is done, and its worker first confirms the branch is in
the integration checkout (`fleet-run`): merge each finished branch there promptly, or the check is filed
back to you as an `ask/`. Filing one wave at a time is what made the 2026-10-05 build idle a third of its
worker time while the coordinator reviewed, and what left its Opus tasks unclaimed for nineteen minutes
waiting for chips promised "for wave 3". A queue filed whole shows every lane the run needs at launch, so
every chip goes out at launch.

Order the queue **longest task first**: workers taking long
work first and short work last land within minutes of each other, while the reverse leaves one worker alone
with a forty minute task. Give every task a `budget` in minutes, since a worker past twice its budget stops
and hands the remainder back. Budget from measurement, not from how big the task sounds: the 2026-10-05
build ran a median of four minutes of work against budgets of 45 to 150, so no abort clock could fire.
`fleet.sh status` prints the measured median once three tasks are done; re-budget what is still ready
from it. And expect to stay awake: you answer `ask/`, re-file unreached remainders,
add tasks when a finding points somewhere new, and reclaim claims whose heartbeat went stale.

**File each task with `fleet.sh file`**, one call per task, the file on stdin; never a filing script of
your own and never after a `&&` chain:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh" file <absolute run dir> <task-id> < <task file written as UTF-8>
```

It prints `FILED` or `REFUSED` with the reason (not UTF-8, no frontmatter, a lane other than pane, repo or
verify, a `task-id:` that disagrees, an id already used) and notes an `after:` that names nothing filed
yet. When the queue is in, count `tasks/ready/` against the plan. Measured 2026-10-05: a hand-made filing
script ran after a failed `&&`, two tasks were never filed and nothing said so, and a cp1252 character
broke a third.

**A task that waits on the operator says so: `operator: <what they must do>`** - a permission, a
credential, production access, a decision only they can make. File it with that line rather than leaving
it, or the tasks behind it, out of the queue. Ask every such task in the launch turn, in one
`AskUserQuestion`, not when a worker reaches it; `next` holds it until `fleet.sh cleared <run> <id>`. `fleet.sh status` lists them under `== waiting on the
operator`, and under `== bottlenecks` any open task, free to start, that holds three or more tasks behind it (top five). Measured
2026-10-06: every remaining plan task sat behind one permissions task for about two hours, closing 8 and
then 4 tasks an hour, before the operator was asked.

And: **`touch .fleet/<run-id>/tasks/queue-open` before you offer a single chip** when you will file
more than you have planned - fix tasks from your reviews, remainders - holding one line saying what. While it exists a worker whose lane runs dry polls instead of
finishing, which is what lets the repo lane start at full width without losing a chat every time the queue
runs momentarily dry. **Delete it the moment you will file nothing more** - that deletion is what ends the
repo lane, and forgetting it leaves workers polling all night. `fleet.sh landed` refuses a run whose queue
is still open, so this cannot be quietly skipped.

The **pane** fleet size stops being yours to choose: it is however many panes the operator has open. The
repo lane is still yours, sized from the ready queue by `docs/LANES.md`.

## 4. Guard the actions that leave the machine

When an area can reach something outside the machine, telephony, payments, email or SMS, a shipping or
fulfilment vendor, anything that costs money or contacts a real person, the brief gets a section
naming what the worker observes and what stays with the operator.

Write the observable path first, so attention lands there: read the screens, the lists, the history, the
configuration, the state behind them. Then name the reserved controls specifically, by their label. "Dial,
including click to call from a row" survives contact with a curious model where "avoid placing calls"
does not.

Close it with the escape hatch: a screen that reveals its behaviour only by firing a reserved control is a
limit of this run, recorded as unreached. Without that sentence the model reads the boundary as a puzzle to route around.

## 5. Give verify briefs their sweeps

A verify brief that only says "look at these screens" produces a worker that reads the first row of each
and calls it fine. Name the sweeps it must run, from `docs/SWEEPS.md`, and say which screens each applies
to. Open that file at this point and not before; a mission with no verify slices never needs it.

The interaction posture belongs in the brief in one line: exercise every control that neither mutates
shared state nor leaves the machine, open dialogs and cancel them, and record every control that produced
no observable change.

Carry the truncation sweep on every screen that lists rows and claims a total, since a list holding a
fraction of its own count while looking complete is invisible to a worker that is only reading. Carry the
zoom and viewport sweep wherever layout or geometry decides what the operator sees. Name the zoom levels
and the widths, and say that the worker resets the tab to `desktop` before finishing: an emulated size
persists across reloads and quietly reshapes everything measured afterwards.

Findings from a sweep report the conditions they were measured under: the zoom, the viewport, and the
claimed total where a count is involved.

## 6. Add measurement rules when speed is in scope

A brief that measures speed carries a "How to measure" section built from `docs/PERF.md`; open that file
only once a brief measures something. The section holds: three runs with median and spread, machine load
recorded beside every number, a named comparison arm, `setInterval` for sampling.

Schedule those workers in their own wave. They are measuring a machine the other workers are loading.

## 7. Offer the chips

One `mcp__ccd_session__spawn_task` per worker, title and prompt taken verbatim from:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh" chips .fleet/<run-id> 01-02 pane --model <id> --effort <level>   # lane: pane, repo or verify; a brief worker has neither lane nor --model
sh "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh" chips .fleet/<run-id> 03-08 repo --model <id> --effort <level>
```

Do not type them yourself, and run it once per lane the queue holds, in the same turn, **with disjoint
number ranges per lane**, as above: `chips` refuses an empty, reversed or non-numeric range, and refuses a
number already offered under a different lane, because two chips with one number are two workers with one
identity. It ends with `STILL WITHOUT A WORKER` for every lane that has ready work and no chip yet. The title `fleet <run-id> NN` is the only reliable address later: session
handles from `mcp__ccd_session_mgmt__list_sessions` are opaque, change between calls, and reach other
accounts on the same machine. The prompt carries the run's absolute path, because a chip session can start
in its own worktree where the gitignored `.fleet/` does not exist, and the path of the `fleet-run` that is
actually installed. Offer chips for every worker the run needs now, never paste lines in their place.

In pull mode the prompt carries the worker's identity **and its lane**. Without the identity a worker
invents one, two workers pick the same number, and their findings interleave into one file that collection
reads as a single worker. Without the lane a paneless worker claims a browser task and pays a reclaim. Give
`pane` for the workers whose panes the operator will open and `repo` for the rest; the lane is then the third
argument to every claim the worker makes. Do not write the lane rule into the prompt as prose - 2026-08-31
did, in nine of fourteen prompts, and a rule retyped per run is one somebody eventually types differently.

The chip number is the worker id everywhere after that: `NN.jsonl`, `NN.notes.md`, `NN.done`, the `owner`
line inside a claim, and `ask/NN-1.md`.

## 8. Arm the watch, then hand over

**Invoke `/makarasty:fleet-wait <run-id> <count>` yourself, before you stop.** Do not print it as a command
for the operator to run. Measured 2026-08-26: a planner that printed the line and stopped left seven
finished workers sitting on disk unnoticed, because the operator assumed the planner was watching and the
planner assumed the operator would run it. The watch waits in the shell, so arming it early costs nothing
and it fires whether the chips are clicked in one minute or twenty.

**Arm the loop `fleet-wait` gives you, quiet timer included, and do not write your own.** The supplied loop
is a `while true` as well; what separates it from a hand written one is the two things a hand written one
leaves out. It has an exit condition, so it ends itself when the last worker lands, and it emits on silence
as well as on progress, so a fleet that has stopped writing files still produces a line. Measured
2026-08-27, a planner's own watch had neither: it missed three workers dying at the same minute, left the
planner asleep for 65 minutes until the operator intervened, and then ran on for five hours and forty two
minutes after the run had finished [M17].

**When the stall line names a claim nobody is advancing, message that worker** with
`mcp__ccd_session_mgmt__send_message`, addressed by its title. A cross-session status
check is the only thing that revives a session which ended a turn with nothing pending, and in that run
all three came back within seconds of one. Findings still travel by file, never by message.

**Collect the run you have before planning the next one.** Measured 2026-08-27: a planner went straight
from a finished run into planning its successor, and the first run's six finished workers sat unmerged for
two hours forty nine minutes.

**If the operator is arming a run and going to bed, say the one thing that decides whether it survives the
night.** A pane worker whose pane goes dark stops and asks a person, and at three in the morning there is
no person. So an overnight run is either paneless, which the lane split now makes possible, or every pane
it needs is open and stays open before the operator leaves. Say which one this run is, out loud, while
they can still act on it.

Then tell the operator, in this order: the run id, how many chips are waiting **split by lane**, the model
and effort each lane runs on (you switch any chip that starts on another, and say whether approval cards are
coming: `docs/MODELS.md`, "Switching a worker", step 1), the wave order you recommend and why, and that each
pane worker wants its pane opened and kept on screen.

## 8b. Coordinate without becoming the bottleneck

You are the one session the whole run depends on, and the one nothing restarts. Ten rules keep you light.

- **Review through a subagent, never in your own context.** When a task finishes, spawn one review agent
  at the task's `verdict-model` (your own tier when the task names none) with the branch, the task file
  and the plan section; it returns a verdict and the defects worth a fix task, and you read only that. A
  task whose worker already ran its own review (`fleet-run` step 5) gets a short verdict review here, a
  skim of the diff against the plan, not a second full one. Reading every diff yourself is how the
  2026-10-05 coordinator reached 510 K of context at thirty percent of its plan, and why three questions
  waited eight to sixteen minutes for an answer.
- **Keep `STATE.md` in the run directory current**: the plan path, the run directory, the worker count
  `n`, the chips offered by lane, the integration checkout's path and URL, any extra URLs the watch
  checks, whether `tasks/queue-open` is held, the merged branches in order, the reviews in flight, the fix
  tasks filed and why, the operator's decisions and the questions still open to them, and the pane check tasks filed and their state. Update it on
  every merge. It is what a fresh coordinator reads, and what you read after a compaction; the first six are
  exactly what re-arming the watch and judging the lanes need, and nobody else has them. Stamp each entry
  with the time from the `== now` line of `fleet.sh status`, never an estimate: a coordinator that guessed
  wrote "~13:00" on a snapshot taken at 11:10.
- **Back from a restart, wake the workers before reading `status`.** A restart stops every chat and leaves
  the claims on disk looking alive: `fleet-wait`, "After a restart, wake every worker before you re-arm".
  An expiry notice is not a restart.
- **Read `status` for what holds the run, and act in that turn.** A `== bottlenecks` line that waits on the
  operator is a question to ask now; when they have done it, `fleet.sh cleared <run> <id>` lets `next` hand
  the task out. `== waits for ever` is an `after:` naming nothing: re-file or fix it. `OTHER PLUGIN` or
  `never ran whoami` under a worker, or a `WORKER PLUGIN` line from the watch, means it follows an older
  protocol (pause and retirement may not hold it, its markers may carry no branch line): put it in the one
  relaunch ask as "Replace workers NN only" and offer the fresh chips, unasked by the operator (a fresh chip runs the new version only after a Claude Code restart: say so in the ask). After each
  merge, and before `landed`, the merge agent runs `fleet.sh stranded <run>`: `STRANDED` is a commit made
  after its branch was merged, which nothing else would pick up; a `not merged` line is a task turned down or forgotten, and `landed` does not repeat it.
- **Watch the machine's memory, and clean up what nobody waits for.** On `== held on memory`, a slow
  machine, or the operator's word, run `fleet.sh procs <run>`: it lists test runs and typechecks whose chat
  or shell is gone, and `--kill` ends those at least two minutes old that used no CPU over five seconds, and nothing else (it is machine-wide, so run it only on the operator's word). An orphaned dev server, watcher or emulator is
  listed and left alone: it may be the operator's service, so ask. Never kill a process with a live parent.
- **Spend your context on verdicts, not on material: it should grow by lines, not by files.** Delegate to
  a subagent not only the reviews but **the merges, conflict resolution included** (the agent merges the
  branch into the integration branch, resolves what conflicts, runs the scoped checks and returns one
  verdict line and the resulting commit), **the `STATE.md` updates from the run directory** (it reads
  `tasks/`, `ask/` and the markers and edits the file; you state the decisions it cannot read there), and
  **any reading of a large file or a log**. Keep the verdicts, the decisions and the status lines. Read
  `fleet.sh status` and `fleet.sh contexts` output, the reviewer's verdict and the `ask/` files, never a
  diff, a log or a findings file. Every tool result you read stays in your context for the rest of the run,
  and so does every worker's.
- **Relaunch at the mark, by asking once, not at the wall and not on your own.** The marks are the
  operator's, set 2026-10-06: auto-compaction starts a little past 900 K, so you are asked at 700 K, and
  again at 800 K, which leaves room to write the state and stop the workers. The watch prints
  `COORDINATOR CONTEXT <n>K` when your context crosses `coordinator_handoff_k` in `calibration.json` (700 as
  shipped, repeating every `coordinator_handoff_step_k`, 100, so the second line comes at 800), and a
  `WORKER CONTEXT NN` line when a worker crosses `worker_relaunch_k` (700); `fleet.sh contexts <run>` lists
  every session's size and marks the ones `OVER`. The operator may also just ask. Do not hand off by chip and
  do not run `/makarasty-tools:handoff`: a chain of handoff chips re-reads the world at every hop and loses
  what was only in context, and workers with a large context were never moved at all. One controlled
  relaunch replaces the chain, and a `WORKER CONTEXT` line points at this same single ask, never at a
  relaunch of its own. **The procedure is in `docs/RELAUNCH.md`: read it when the mark comes**, before
  you ask: one notification, one `AskUserQuestion`, `fleet.sh relaunch` in two calls, then the chips.
- **The broadcast is for every worker, including one that starts a day later.** Never put an order for
  named chips in it, above all a retire order: it reads as a standing rule (2026-10-06: worker 20 retired at
  420 K on "workers 01-05 retire, your context is past 400K", written eighteen hours before it started).
  Replace workers with `relaunch`. A worker that stops for context below `worker_relaunch_k` (700) did not
  run out: message it by title to carry on.
- **Every question to the operator is an `AskUserQuestion`, never a line in your reply.** A question typed
  into the chat scrolls away under the next event and waits unseen (2026-10-06: "do we load the demo data
  on sandbox and start pane workers?" sat in the text between two merges). Before asking, put everything
  that does not depend on the answer in motion (reviews and merges in background agents, chips offered),
  send `PushNotification` with the question in one line, ask with your recommended option first, and
  write it under open questions in `STATE.md` so a fresh coordinator sees it too.
- **A pause is `/makarasty:fleet-pause <run-id>`, never a sentence to the workers.** Telling them to pause
  stopped nobody (2026-10-05: they kept "wrapping up" for a long time). The command writes the file the
  hooks enforce; the watch prints `PAUSED`, `worker NN stopped` and `RESUMED`. A relaunch pauses by itself.
- **Never hold a check you cannot run.** A screen check belongs to a `needs: pane` task, served from the
  integration checkout, never to the build worker, whose pane shows the main checkout and not its
  worktree. The **integration checkout** is the worktree where you merge finished branches, with its own
  dev server on its own port, started once by you (`FLEET.md`'s services line may name how). Make it with
  `sh "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh" worktree <absolute run dir> integration --create <integration
  branch>`, then `git -C <its path> switch <integration branch>` - a branch the main checkout does not have
  checked out - and record its path, branch, URL and start command in `STATE.md`. A pane check whose build
  is not merged yet comes back to you as an `ask/` and an unreached line; merge, then re-file it under a new
  id. Give every
  such task `origin: <that url>`, which the pane worker opens instead of `FLEET.md`'s origin, and add the
  url to the watch's `svc` as well. When you must look yourself and your pane reads
  blind, ask the operator in that turn (`docs/BROWSER.md`). On `SERVICE DOWN` from the watch, restart the
  service or tell the operator in that turn.

**Say how this run will announce itself, because that is what they will be waiting for.** Three sentences,
once, at hand over:

- Every pane worker asks for its pane within a minute of its chip being clicked, so open the chips in a
  wave and walk the row once rather than answering them one at a time over half an hour.
- A finished chat renames itself in the sidebar (`... - done 23f`) and its background task panel goes
  empty. That is the glance test, and it works from whatever chat they happen to be sitting in.
- The run ends exactly once, here, with one notification and one summary table in this chat. No
  notification means it has not finished.

Say the pane arithmetic out loud, because the operator is about to discover it the hard way. Two numbers,
and do not blur them: **the default of two is what the work has needed** in both measured runs, and the
display ceiling above it is what tiles at a readable width before panes stack below at half height. The
second is a ceiling for a mission that genuinely queues, not a target, and both are in `calibration.json`.
Pass on three ergonomics as well: drag the planning chat out into its own floating window, zoom the
application window out to buy a column, and on Windows a window can be sized past the monitors by pushing
it off one edge and pulling the opposite one. Nobody thinks of any of that with eight chats already open.

You do not have to ration memory between waves any more, and you should not try: `fleet.sh next` reads the
machine before every claim and refuses to hand out a task below the floor, so a wave that is too wide stops
itself at the queue, not in the page file. Say out loud, once, that a speed number taken while the box is
paging describes the page file, not the application - so a wave that measures anything schedules where
nothing else is running.

## Done when

Every brief exists on disk, or the whole queue is filed with its waves held by `after:`, every slice of the
axis has exactly one owner, a chip is offered for every lane with work, **the watch is armed**, and the
operator has the wave order and each lane's model. Then stop, without opening a browser and without
starting the mission.
