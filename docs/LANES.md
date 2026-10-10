# Lanes: what a fleet is actually queueing for

A fleet looks like it is queueing for workers. It is queueing for whatever the machine has exactly one of,
and a worker is the thing holding that one instrument while it works.

Name that instrument's queue a **lane**. The lanes decide whether a run takes three hours or five, and they
are the one part of this plugin that generalises past browser testing.

## The three lanes

| Lane | The scarce thing | How many at once | Task declares |
|---|---|---|---|
| **pane** | one Browser pane per session | one per worker, strictly serial, and at most as many workers as the display holds | `needs: pane` |
| **verify** | the machine's RAM and cores | one across the whole fleet | `needs: verify` |
| **repo** | nothing scarce, files are read only | as many as the machine holds, sized from the queue | `needs: repo` |

**The pane lane has a second shape**, new in 1.0.0 and described in [`BROKER.md`](BROKER.md): one or two
sessions own the panes and everyone else files a browser walk as a file. Seven open panes carried 104
minutes of driving, under one pane's worth, and one of them was driven for zero minutes over 61 [M15] - the
pane is bound to a session when the scarce thing is the walk. Size the pane lane at **two** by default
whatever shape you use.

**The lane is also what a worker claims by**, not only what a task declares:
`sh fleet.sh next <run-dir> <chip> repo` refuses to hand a paneless worker a browser task. Before it did,
the rule lived in prose pasted across nine chip prompts and produced **73 hand-rolled claims beside
113 helper ones** [M06]. A gate is a package deal: when the helper lacks something workers need, they
abandon the helper and every gate inside it.

Measured 2026-08-27: the median task took 23 minutes and roughly 20 of those were one delegated browser
scenario. Browser subagents drive the **parent session's** pane, so two of them in one worker run strictly
one after the other while the worker sits idle. That puts a pane-lane worker's ceiling at about 2.6 tasks
an hour no matter how the queue is written.

**That number describes a pane worker in a browser-heavy run, and nothing else.** Two later repo-heavy runs
came in above it, at **2.87** and **4.25** tasks an hour per worker [M16]. A planner sizing a file-only run
from the 2.6 figure is applying a browser constant to work that never opens a browser.

The repo lane has no such ceiling, and in that run it went unused: 33 of 34 tasks were written to be walked
in a browser, including a vendor egress audit whose entire answer was in the source tree. It took 8
minutes, held a pane it never touched, and consumed a worker slot that a browser task needed.

The verify lane exists because a project's test suite and typechecker are as singular as a pane. Two
workers running a full suite together do not run twice as fast; on the machine this plugin was built on
they run out of memory. A run that writes code has a verify lane whether it names one or not.

## Every task declares its lane

`needs: pane | verify | repo` in the task's frontmatter, whose full shape is in
[`PROTOCOL.md`](PROTOCOL.md), "Task format". Absent `needs`, read the steps: a step that names a screen, a click, a viewport or a screenshot is `pane`.
A step that names a test command, a typecheck or a build is `verify`. Everything else is `repo`.

**Write the lane before the steps, not after.** A task drafted as a browser walk stays a browser walk even
when its evidence is a file reference, because the first sentence set the posture. The planner asks which
lane answers the question, and only then writes the steps.

## The pane worker's idle window is the biggest free win in the system

A pane worker spends about 20 of its 23 minutes waiting for one delegated scenario to come back. During
that wait it holds a pane it is not using and a session that is doing nothing.

**After dispatching the browser subagent, claim exactly one `repo` task and work it while you wait.** It
costs no pane, it lands in the same session, and it roughly doubles what that worker produces without a
single new chat. The claim is legitimate under the claim-and-begin rule because you begin it in the same
turn you take it.

One, not several. Beyond one, the subagent returns start queueing behind your own turns and the worker
becomes the bottleneck it was trying to route around. So a worker may hold one pane task, plus at most one
repo task, plus the repo task's own fan-out. `next <chip> repo` enforces it, in either order (a pane task
that closes first may be followed by the next one beside the repo task), and a `needs: verify` task counts
as the repo task.

**A pending subagent is not a substitute for the armed wake.** Fanning out leaves something pending, which
keeps the session alive, and a worker that leans on that will eventually have three subagents all waiting
on each other and no clock anywhere. Arm the wake exactly as `PROTOCOL.md` says, subagents in flight or
not.

## Sizing the repo lane: from supply, and early

The pane lane is the bottleneck by construction. At 2.6 tasks an hour per worker it decides the run's wall
clock whatever the repo lane does, so **repo width can never make a run slower, only wider.** The two
errors are not symmetric. Too many repo workers wastes something cheap, a few quiet chats. Too few wastes
something expensive: pane hours spent walking a plan that a repo finding would have rewritten.

Take the cheap error deliberately, and **size from supply rather than from demand**. One call answers it,
because a formula retyped is a formula that drifts:

```bash
sh "$f" width .fleet/<run-id>     # REPO_WORKERS n, with the queue and machine terms it came from
```

It counts the unclaimed `needs: repo` tasks, takes one worker per three, and clamps that to what free
memory allows. Every term is on disk or one command away. The alternative - estimate the repo minutes,
estimate the pane lane's wall clock, divide so they land together - needs two numbers the planner is
provably bad at guessing, before the run, which is the failure `PULL.md` exists to route around. Landing
together is not the objective. Finishing the repo lane **early** is, because its findings are the cheapest
instrument for retargeting the pane lane's remaining queue.

The machine cap is the same shape as the fan-out rule below: free physical memory at chip time, ceiling
`cores - 2`, and never above what the project's `FLEET.md` records on its concurrency line. Measure it
rather than reasoning about it - `node scripts/fleet-load.mjs` prints the census by class:

| what | measured on one desktop, 31.2 GB [M21] | how it was measured |
|---|---|---|
| an agent session, no pane | **~330 MB** resident, largest 389 MB | 14 live sessions, grouped by process type |
| one displayed pane on a local single page app | **+344 MB**, one renderer process | opened one, sampled, closed it |
| closing the tab | returns all of it within seconds, process gone | same A/B |
| fourteen sessions and six panes | 4.4 GB plus 1.9 GB, no page file growth | during the run |

So a repo worker is roughly a third of a gigabyte, and a pane worker is that plus whatever page it is
holding - another 344 MB on a light application, **2,061 MB in a single tab** on a heavy one [M34]. The
repo lane is bound by how many claims the queue can keep fed, which is why the width above is computed
from the ready queue. The pane lane is bound by memory, and the figure that decides it belongs to the
project rather than to this page.

Nobody has to remember any of it. `fleet.sh next` reads free memory before every claim and hands out
nothing below the floor in `calibration.json`, and a hook refuses a full suite or a full typecheck from a
worker that does not hold the verify lane. This paragraph explains those two refusals and asks for
nothing.

**Start the repo lane at full width in the first wave**, not after the browser workers have settled. The
one exception is a wave that measures speed: a performance task and a wide repo fan-out on the same box
measure each other, so those schedule after the repo lane drains, and the planner says so out loud because
it can see the perf tasks sitting in `ready/`.

## A drained queue is not a finished worker

`tasks/queue-open` is a marker the **planner** owns. While it exists, the planner still intends to file
work, and a repo worker that finds its lane empty gets exit 5 from `drained`, arms the wake in `fleet-run` on the
queue changing, and polls instead of writing `.done`. The planner deletes it when it will file nothing more, and the next poll turns every
lingering worker quiet.

This is what makes early width safe. A chat that has ended cannot be reopened, so a worker that finishes
the moment the queue runs dry is a slot the run has permanently lost - and in pull mode the queue grows,
by design, every time a finding points somewhere new. The marker is the outstanding obligation that keeps
those sessions alive under the protocol's pending-work rule, and deleting it closes them.

It costs a handful of poll turns per worker per hour, which is the price of keeping the lane.

**A pane worker whose lane drains demotes itself rather than stopping.** It already claims repo tasks in
its idle window, so at end of lane it simply keeps doing that, with `next <run> <chip> repo`. The reverse
is impossible - a repo session has no pane and cannot grow one - which is why pane width stays the
operator's display decision and repo width stays the machine's.

## Fan out in the repo lane, never in the pane lane

A worker on a `repo` task may run several subagents at once, in one message, and read their bounded
returns together. A worker on a `pane` task may not: they would fight over the pane and interleave clicks
into each other's scenario.

The gate for fanning out, all three terms:

1. The task declares `needs: repo`.
2. No browser subagent of yours is running.
3. The work splits into parts that do not read each other's output.

**Three is the default width (`fanout_default` in `calibration.json`), and the reason is the fixed cost of
a spawn rather than the machine.** A
subagent pays its system prompt and tool schemas before it does anything: measured 2026-08-24, a Haiku
subagent driving three tool calls spent 45,775 tokens, nearly all of it startup [M13]. So a fanned-out part has
to be worth a whole slice of work, not one lookup. Two greps belong in one message to your own shell; four
independent file clusters belong to four agents.

`fanout: N` on the task raises or lowers that. **No script reads that field.** It is the planner's
instruction to the worker and holds only because the worker honours it, so it says nothing about the
machine. Above five, split the task instead: five returns are already more than one worker can rule on
without losing the thread.

`sh "$f" width .fleet/<run-id>` sizes the whole lane from free memory, and `next` refuses a claim when the
box is full, so a worker does not weigh its fan-out against memory itself.

**A repo worker is who claims it.** A chip is told `lane pane` or `lane repo` unless the planner offers a dedicated `verify` chip (a valid lane for `fleet.sh chips`), so a repo worker takes a verify task
when no other verify task is held, and `next` prints a `VERIFY LANE` line telling it that it holds the
fleet's only one. That check is a width rather than a lock - the queue's atomicity is per task, so two
workers reaching it in the same instant can both pass it.

**The verify lane is exclusive, and it beats every other rule here.** A full typecheck or a full test suite
is the whole machine: measured on the host this plugin was built on, a cold typecheck peaks at 4.9 GB and
the full suite at 4.4 GB, and two of them together put the box into its pagefile. One worker at a time
holds the verify lane, the rest verify scoped, and the full sweep runs once at the end.

## Merging a poke with a measurement

The obvious way to make a performance pass fast is to have one agent click while another measures. It does
not work, and the idea keeps coming back: both agents want the same pane, so they serialise, and if they
did overlap they would corrupt each other's timing.

**The measurer is an instrument, not a session.** Install a sampler into the page, drive the interface,
read the sampler back. One agent, one pane, both jobs, and the timing is cleaner than two agents could have
produced because nothing else is touching the renderer.

```js
window.__probe = { marks: [] };
window.__probe.t = setInterval(() => window.__probe.marks.push({
  t: performance.now(), rows: document.querySelectorAll('tbody tr').length, path: location.pathname,
}), 100);
```

That is what makes a merge safe: one task, one walk, several instruments reading at once. The last run's
best measurements all had this shape, and its worst had a screenshot burst throttling the renderer it was
trying to time.

So merge tasks that share a walk, and keep tasks separate when they need different screens. The test is
whether the second question can be answered by an instrument installed during the first walk. If it can,
it is one task; if it needs its own navigation, it is two.

## A fleet with no pane at all

Nothing in the protocol depends on a browser. Strip the pane and this is what remains and what goes.

**Stays:** the queue and its atomic claims, the finding schema and its evidence contract, `ask/` and
`answers/`, the completion markers, the self-wake that keeps a session alive, the planner's watch, and
collection.

**Goes:** `.blocked`, the pane question, and the one interactive question a worker is allowed. A run with
no pane has nothing only the operator can supply, so a worker never blocks on a person. That is also what
makes a paneless run the right shape for an overnight one.

**Changes referent: the gate.** The frame gate exists because a blind pane produces confident fiction, and
every kind has its own blindness that looks exactly like a pass:

| Kind | What a blind run looks like | The gate |
|---|---|---|
| `fix`, `implement` | a change that was never exercised | the reproduction fails before the change and passes after |
| `research` | "the documentation does not mention it", from a page that never loaded | a verbatim quote with its locator, from each source, before any synthesis |
| anything running tests | a green suite that skipped the file you changed | the test count, named suites included, not the colour |

People read past the last one, so: **a green run with a silently skipped suite is the paneless equivalent
of a frozen pane.** `1105 passed (1106)` is a failure line.

**Changes vocabulary: `conditions`.** A pane finding names viewport and zoom. A repo finding names the
commit and the state of the tree, because six workers are changing it while the finding is being written,
and a finding without that is unreproducible an hour later.

**Changes:** the fleet's width. Pane-bound runs start at the default of two and are capped by how many
panes fit on a display: the display ceiling in `calibration.json` before they stop being usable, ten before
they stop being panes. A repo-only run is capped by the machine and by how many claims the queue can keep
fed, which is a much larger number.

**Appears:** the verify lane. A run that writes code needs a rule for who may run the suite, and the
project's `FLEET.md` states the cost. Give it to one worker at a time, at the end, and let the rest verify
scoped.

This is the shape for a refactor across a hundred files, a migration, a research sweep over many sources,
or a codebase somebody is trying to learn. The mission kinds in `MISSIONS.md` already name those; the lane
makes them run wide instead of posing as a browser test.
