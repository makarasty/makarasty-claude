---
description: Interview the operator into a good plan, split the mission into a queue or briefs, and offer one worker chip per worker
argument-hint: <mission in plain words> [fast]
disable-model-invocation: true
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

Read `docs/PROTOCOL.md`'s "Directory layout", "Brief format" and "Finding schema" before you write one -
those three are the run's shape and the contract you restate in every brief - and the section of
`docs/MISSIONS.md` for the kind you are planning. Neither file is short, and the rest of both is worker
material or covers a kind you are not running.

## 1. Ground yourself in the project

Read the project's `FLEET.md` if it has one. It carries the app origin, which services must already be
running, the login runbook, the naming rules, and the actions reserved for the operator.

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
shared primitives, then the screens. File wave three only once wave two has landed - a screen task that
starts before the primitives are settled either restyles a primitive under another worker's feet or
inherits a defect it is not allowed to fix.

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

Budgets and worker counts. You have the measurements: the median task runs 23 minutes, budgets written at
40 and 45 were met by three tasks out of 36, and the pane lane holds as many workers as the display holds
panes. State those and move on.

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
- **A model choice per stage.** `model:` walks the work and `verdict-model:` rules on it. Take the tiers
  from `docs/MODELS.md`; do not default.
- **Whole brief demand.** The worker completes its entire brief before writing findings and does not
  stop at the first interesting thing.

Briefs that write code carry `isolation: worktree`.

## 3b. Fixed briefs, or a queue

Eight briefs freeze one guess about where the defects are for the whole run. Over a surface larger than
the plan, write a **queue** instead: read `docs/PULL.md` and put tasks in `tasks/ready/` rather than briefs
in the run root.

Pull mode changes four things for you. Order the queue **longest task first**: workers taking long
work first and short work last land within minutes of each other, while the reverse leaves one worker alone
with a forty minute task. Give every task a `budget` in minutes, since a worker past twice its budget stops
and hands the remainder back. And expect to stay awake: you answer `ask/`, re-file unreached remainders,
add tasks when a finding points somewhere new, and reclaim claims whose heartbeat went stale.

Fourth: **`touch .fleet/<run-id>/tasks/queue-open` before you offer a single chip**, holding one line
saying what you still intend to file. While it exists a worker whose lane runs dry polls instead of
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

One `mcp__ccd_session__spawn_task` per brief, titled exactly `fleet <run-id> NN`. That title is the only
reliable address later: session handles from `mcp__ccd_session_mgmt__list_sessions` are opaque, change between calls, and reach other accounts on the
same machine.

Each chip's prompt is one line:

    Run the brief at .fleet/<run-id>/brief-NN.md by following the makarasty fleet-run command. Invoke it as /makarasty:fleet-run .fleet/<run-id>/brief-NN.md, and if that name does not resolve in this session, read the command file directly, at ${CLAUDE_PLUGIN_ROOT}/commands/fleet-run.md

In pull mode there are no briefs, so the chip prompt carries the worker's identity **and its lane**.
Without the identity a worker invents one, two workers pick the same number, and their findings interleave
into one file that collection reads as a single worker, corrupting the count of independent sightings.
Without the lane a paneless worker claims a browser task, discovers it cannot do it, and pays a reclaim:

    You are worker NN of run <run-id>, lane repo. Work the queue by following the makarasty fleet-run command. Invoke it as /makarasty:fleet-run .fleet/<run-id>/, and if that name does not resolve in this session, read the command file directly, at ${CLAUDE_PLUGIN_ROOT}/commands/fleet-run.md

Say `lane pane` for the workers whose panes the operator will open, and `lane repo` for the rest. The lane
is the third argument to every claim: `sh "$f" next .fleet/<run-id> NN repo`. Do not write the lane rule
into the chip prompt as prose instead - that is what 2026-08-31 did, in nine of fourteen prompts, and a
rule that gets retyped per run is one somebody eventually types differently.

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

Then tell the operator, in this order: the run id, how many chips are waiting **split by lane**, the wave
order you recommend and why, and that each pane worker wants its pane opened and kept on screen.

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

Every brief exists on disk, every slice of the axis has exactly one owner, every chip is offered, **the
watch is armed**, and the operator has the wave order. Then stop, without opening a browser and without
starting the mission.
