# Lanes: what a fleet is actually queueing for

A fleet looks like it is queueing for workers. It is not. It is queueing for whatever the machine has
exactly one of, and a worker is just the thing holding that one instrument while it works.

Name that instrument's queue a **lane**. Getting the lanes right is what decides whether a run takes three
hours or five, and it is the only thing in this plugin that generalises past browser testing.

## The three lanes

| Lane | The scarce thing | How many at once | Task declares |
|---|---|---|---|
| **pane** | one Browser pane per session | one per worker, strictly serial | `needs: pane` |
| **verify** | the machine's RAM and cores | one across the whole fleet | `needs: verify` |
| **repo** | nothing scarce, files are read only | as many as the work splits into | `needs: repo` |

Measured 2026-08-27: the median task took 23 minutes and roughly 20 of those were one delegated browser
scenario. Browser subagents drive the **parent session's** pane, so two of them in one worker run strictly
one after the other while the worker sits idle. That puts a pane-lane worker's ceiling at about 2.6 tasks
an hour no matter how the queue is written.

The repo lane has no such ceiling, and in that run it went unused: 33 of 34 tasks were written to be walked
in a browser, including a vendor egress audit whose entire answer was in the source tree. It took 8
minutes, it held a pane it never touched, and it consumed a worker slot that a browser task needed.

The verify lane exists because a project's test suite and typechecker are as singular as a pane. Two
workers running a full suite together do not run twice as fast; on the machine this plugin was built on
they run out of memory. A run that writes code has a verify lane whether it names one or not.

## Every task declares its lane

```markdown
---
task-id: task-07-vendor-egress
needs: repo          # pane | verify | repo
budget: 25
fanout: 3            # repo lane only, see below
---
```

Absent `needs`, read the steps: a step that names a screen, a click, a viewport or a screenshot is `pane`.
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
becomes the bottleneck it was trying to route around. So the concurrency a worker may hold is: one pane
task, plus at most one repo task, plus the repo task's own fan-out.

**A pending subagent is not a substitute for the armed wake.** Fanning out happens to leave something
pending, which happens to keep the session alive, and a worker that learns to lean on that will eventually
have three subagents all waiting on each other and no clock anywhere. Arm the wake exactly as
`PROTOCOL.md` says, subagents in flight or not.

## Fan out in the repo lane, never in the pane lane

A worker on a `repo` task may run several subagents at once, in one message, and read their bounded
returns together. A worker on a `pane` task may not: they would fight over the pane and interleave clicks
into each other's scenario.

The gate for fanning out, all three terms:

1. The task declares `needs: repo`.
2. No browser subagent of yours is running.
3. The work splits into parts that do not read each other's output.

**Three is the default width, and the reason is the fixed cost of a spawn rather than the machine.** A
subagent pays its system prompt and tool schemas before it does anything: measured 2026-08-24, a Haiku
subagent driving three tool calls spent 45,775 tokens, nearly all of it startup. So a fanned-out part has
to be worth a whole slice of work, not one lookup. Two greps belong in one message to your own shell; four
independent file clusters belong to four agents.

`fanout: N` on the task raises or lowers that. Above five, split the task instead: five returns are already
more than one worker can rule on without losing the thread.

**The repo lane's width comes from free memory, the same way the project's own test runner picks its
workers.** Read free physical memory before a wide fan-out and take the smaller of `fanout` and what the
machine has room for. The precedent is in this plugin's own host project, whose vitest config chooses 14
workers above 20 GB free and 4 below 9, and whose comment records the merge that OOM-killed five chunks of
sixteen.

**The verify lane is exclusive, and it beats every other rule here.** A full typecheck or a full test suite
is the whole machine: measured on the host this plugin was built on, a cold typecheck peaks at 4.9 GB and
the full suite at 4.4 GB, and two of them together put the box into its pagefile. One worker at a time
holds the verify lane, the rest verify scoped, and the full sweep runs once at the end.

## Merging a poke with a measurement

The obvious way to make a performance pass fast is to have one agent click while another measures. It does
not work, and the reason is worth stating because the idea keeps coming back: both agents want the same
pane, so they serialise, and if they did overlap they would corrupt each other's timing.

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

The last one is worth stating as its own sentence, because it is the one people read past: **a green run
with a silently skipped suite is the paneless equivalent of a frozen pane.** `1105 passed (1106)` is a
failure line.

**Changes vocabulary: `conditions`.** A pane finding names viewport and zoom. A repo finding names the
commit and the state of the tree, because six workers are changing it while the finding is being written,
and a finding without that is unreproducible an hour later.

**Changes:** the fleet's width. Pane-bound runs are capped by how many panes fit on a display, five before
they stop being usable and ten before they stop being panes. A repo-only run is capped by the machine and
by how many claims the queue can keep fed, which is a much larger number.

**Appears:** the verify lane. A run that writes code needs a rule for who may run the suite, and the
project's `FLEET.md` states the cost. Give it to one worker at a time, at the end, and let the rest verify
scoped.

This is the shape for a refactor across a hundred files, a migration, a research sweep over many sources,
or a codebase somebody is trying to learn. The mission kinds in `MISSIONS.md` already name those; the lane
is what makes them run wide instead of pretending to be a browser test.
