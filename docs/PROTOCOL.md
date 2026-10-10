# Fleet protocol

The single source of truth for how a fleet run is laid out on disk. Commands and agents point here rather
than restating it, so changing the shape is a one file edit.

## Vocabulary

**Mission** is the whole job the operator wants done. **Brief** is one worker's slice of it, written as a
file. **Worker** is a session that runs one brief. **Wave** is a batch of workers started together.
**Blind** describes a worker whose browser pane is not compositing, so everything it observes is false.

Workers are fire and forget. They read a brief, write findings, and exit. **Nothing a run produces travels
by message**, because a file has an address and a session handle does not: a worker that dies leaves its
findings behind, and one that finishes needs nobody's attention.

Messaging has exactly one job, in the other direction. The planner may send a worker a status check
(`mcp__ccd_session_mgmt__send_message`) to **revive** it. Nothing else brings back a session which ended a turn with nothing
pending. Measured 2026-08-27: three workers dead for nearly three hours came back within seconds of a
cross-session message and finished their tasks. Keep the
handles usable, and never let a finding or an answer ride that channel.

**That channel can die with the machine, and the disk does not** [M27]. Look first: a worker still in
`list_sessions` is woken by message (`/makarasty:fleet-resume`, step 0) [M35]. Measured 2026-09-01: after a
restart the 26 worker sessions of two runs were gone from the session list (`mcp__ccd_session_mgmt__list_sessions`), which listed five unrelated
chats started minutes earlier, and absent from the app's own session list whether or not archived rows
were included. A planner
asked to revive them was right to say it could not: there was nothing left to message. What survived was
`chips/<session-id>`, the standing claims, and every session's transcript under
`~/.claude/projects/<slug>/<session-id>.jsonl` — which is enough to reopen a worker with its context
intact (`claude -r <session-id>`), and a reopened worker is worth several fresh ones. `fleet.sh recover`
turns that into three lists and `/makarasty:fleet-resume` walks them. **Revive is for a session that
stopped; recover is for one that no longer exists.**

## A worker gets exactly one interactive question

**The only thing a worker may ask the operator directly is to display its Browser pane.** Nothing else.

In a fleet the operator is looking at one chat out of five or ten, usually the planner's. A worker that
opens a second interactive question sits there unanswered, holding a claimed task, while its chat is not
the one being read. One worker doing that costs its own run; several doing it stall the queue.

The pane question is the exception because it is the only one the planner cannot answer: the planner
cannot open a pane, and a blind worker that guesses instead produces fiction. That question also announces
itself on disk through `.waiting`, so it is visible without anyone reading that chat.

Everything else goes to the planner as a file in `ask/`, and the worker keeps working. Missing context, an
ambiguous assertion, a screen that turns out to belong to someone else, a task that looks wrong: all of it
is a question for the planner, answered at the worker's next task boundary.

**Only the planner may ask the operator**, because the operator is watching the planner.

**A question about a reserved action is not asked at all.** Sending a message to a real person, a vendor
call that costs money, a production write, deleting stored data: none of those become permitted by an
answer, so there is nothing to wait for. Record the step as unreached with the reason and take the next
one. If the operator wants it done they do it themselves, which keeps the judgement with them and costs
the run nothing. Measured 2026-08-27: one worker put an "is this class of write sanctioned" question to the
operator through `AskUserQuestion` and blocked for four minutes twenty six seconds holding a claimed task,
for an answer that could not have changed what it was allowed to do.

**If you ever open an interactive prompt at all, write `.waiting` first.** The marker is defined below for
the pane question, but the property that makes it worth writing is not about panes: a blocked worker
holding a claim looks exactly like a working one from every other angle.

## A session with nothing pending is dead

This is the failure that costs a run the most wall clock, and it is invisible from outside.

An agent session runs only while something invokes it. A turn ends, and unless a message arrives or a
background task finishes, that session never runs again. Nothing in a fleet types into a worker's chat.
So a worker that ends a turn with no background work armed has stopped, permanently, whatever it said it
was about to do next.

Three of six workers did exactly this and sat dead for **169, 171 and 176 minutes**, each holding a claim,
each having written a confident summary of the task it was about to start [M03]. From outside they looked
like workers doing slow work, which is why nobody looked for three hours.

**So: while a run is live, never end a turn without something pending.** Either a subagent is running, or
you arm a wake yourself before you stop:

```bash
sleep 120; echo wake
```

Run that with `run_in_background`. A backgrounded command that exits delivers a notification, and the
notification re-invokes the session. Both halves are measured: the notification on exit was verified
directly 2026-08-28, and in the same run the workers that stayed alive were the ones woken this way, turn
after turn, by their own backgrounded subagents finishing.

That wake is also the only timeout a fleet has. A subagent that never returns, an answer that never
arrives, a pane nobody displays: in every one of those the session is waiting on an event that may not
come, and the armed wake is what turns a permanent stall into a decision made two minutes later.

Exactly two boundaries are safe to end a turn on, because after each of them the session has no further
job: after writing `<chip-id>.done`, and after writing `<chip-id>.blocked`. Everywhere else, arm the wake
first.

## Pending work mirrors unwritten obligations, in both directions

The rule above has a second half, and leaving it unwritten cost the 2026-08-31 run more session life than
every stall in this document put together.

> **A session's pending background tasks correspond one to one with its unwritten obligations on disk.**

Forward: you owe the disk a write - a claimed task unfinished, a finding not yet appended, a `.waiting`
you must re-gate, a marker not yet written - so something must be pending, and that is the rule above.

Backward: **you owe the disk nothing, so nothing may be pending.** A clock still armed after its
obligation closed is not harmless idling: it fires, the notification re-invokes a session with nothing to
do, and the operator sees a chat whose task panel says *running* an hour after the work ended. Two runs
spent **1,090 minutes and 282 model turns** that way, on 87 clocks of which none were stopped [M04].

So a clock **reads the disk that closes its obligation, and exits when it sees it**. Never a bare
`sleep`; `fleet.sh clock` prints the loop to background, and it stops itself:

| Clock | Guards | Exits when |
|---|---|---|
| `fleet.sh clock <run> <chip> <task> <budget>` | one claimed task | `tasks/done/<task>` or `<chip>.done` appears, checked every 30 seconds |
| `sleep 90; echo regate` | a pane that is not displayed | the gate reads live and the `.waiting` marker goes |
| the `until` wake in `fleet-run` | a queue that is not finished: `drained` exit 5, `next` exit 7 | the ready, done or cleared set changes, `queue-open` goes, or `FINISHED` appears |

One clock per obligation, and never a second for an obligation that already has one.

## The end banner, and the title

A chat is finished when two things are true at once, and both are readable without scrolling: **its task
panel is empty, and its last message is the banner.** Generate the banner rather than writing it, so it
cannot drift from what is on disk:

```bash
sh "$f" summary .fleet/<run-id> <chip>     # one worker
sh "$f" summary .fleet/<run-id>            # the whole run, for the planner
```

The last line it prints is `fleet-summary: {...}`, one JSON object, so a later script reads the run's
outcome without parsing the table above it.

**Then rename the session.** The sidebar of chat titles is the only surface visible from a chat the
operator is not in, and in a fleet the operator is in one chat out of fourteen. Keep the addressing prefix
and append the state, through the host's session-title tool if the session has one:

```
fleet 2026-08-31-api-security-calls 11  ->  fleet 2026-08-31-api-security-calls 11 - done 23f
                                            fleet 2026-08-31-api-security-calls 11 - BLIND
planner                                 ->  fleet 2026-08-31-api-security-calls - FINISHED 246f/32b
```

Address workers by title **prefix** from then on, never by exact match. The title is best effort and the
disk stays the authority: a session that dies between its marker and its rename leaves a lying title, and
the stall report is what catches that.

**The planner is a session too.** Its wake is usually a file watcher over the run directory, which emits
only when a file appears. When every live worker is stalled, no file appears, so the watcher stays silent
and the planner sleeps with it. In the same run the planner sat idle for 65 minutes and was restarted by
the operator typing "I think the chat has hung". A watch that reports only good news is why silence read
as health: `fleet-wait` now emits a stall line on a quiet interval for exactly this reason.

## Directory layout

```
.fleet/<run-id>/
  brief-01.md          one per worker, written by the planner
  01.jsonl             findings, append only, one JSON object per line
  01.notes.md          everything that is not a finding: assertions passed, claims refuted, tooling
  01.done              empty, written last, means this worker finished
  01.waiting           present while the worker is blocked on an answer from the operator
  01.blocked           written instead of .done when the worker could not see
  01.retired           written by `fleet.sh relaunch`, `retire` or `next` (through `handback`) for a worker
                       replaced: counts as finished and ends its wake loop with "retired"; one written by
                       `retire` or `next` also names the replacement and any unanswered asks
  PAUSED               present while the run is paused: first line the time, then the optional reason.
                       Written by `fleet.sh pause`, removed by `fleet.sh resume`; the hooks refuse a worker's
                       tool calls while it exists
  stopped/<NN>         worker NN's ack of a pause: the time and the claim ids it holds, written by
                       `fleet.sh paused`
  backlog.md           written by collection
  FINISHED             written by `fleet.sh landed`: the run ended, by declaration
  tasks/queue-open     present while the planner still intends to file work
  chips/<session-id>   which chip a session is, written by every worker-side call naming its chip (`next`, `drained`, `whoami`, `find`, `beat`, `finish`, ...), so a brief worker is held too
  chips/<NN>.model     `<model> <effort> plugin <version>` worker NN actually runs, written by `fleet.sh whoami`;
                       `status` compares the version with its own (OTHER PLUGIN)
  offered/<NN>         the lane chip NN was offered for (or `brief`), written by `fleet.sh chips`
  want/<NN>            `<model> <effort|any>` queue worker NN should run, written by `fleet.sh chips --model`;
                       `whoami` exits 10 on a mismatch (`docs/MODELS.md`, Switching a worker)
  chips/<NN>.switch    `<has> -> <wants>` while worker NN waits for a switch; `.switch-failed` once the same
                       mismatch came after `switched` and the worker went on
  <NN>.retiring        written by `fleet.sh retire`: worker NN leaves at its next `next` with no claim open
                       and no walk unserved (handback commits its tree, `.retired` follows); `pane-next`
                       gives it no new walk meanwhile. Holds the replacement's number
  replaced/<NN>        the chip that replaced NN (`none` when its lane had nothing left), written by `retire`
                       and `relaunch`; a second `retire` reads it and offers nothing again
  coordinator          the session id of whoever arms the watch; `fleet.sh ctx` reads its context size
  STATE.md             the coordinator's ledger, and what a fresh coordinator re-arms from: plan path, run dir,
                       worker count, chips offered by lane, integration checkout path and URL, extra watched
                       URLs, queue-open yes/no, merges in order, reviews in flight, fix tasks and why,
                       operator decisions, pane check tasks filed and their state
  worktrees/<NN>       the worktree chip NN registered, for `fleet.sh clean`
```

A pause also leaves a marker outside the run: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/makarasty/paused/<cksum of
the absolute run path>`, holding that path. The hooks readdir that directory first; empty or missing, they
do nothing more, so a session that is not in a fleet pays one readdir. A retired chip leaves a second kind of
global marker, so the retired check (which comes before the PAUSED one and holds after a resume) costs a
non-fleet session the same single readdir.

A coordinator (`chips`, `resume --take-over`) and every worker-side call also write
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/makarasty/fleet-sessions/<session-id>`, holding the run path. The
tools plugin's context hook gives no handoff reminder in those sessions: the run's own marks watch them.
It ignores, and deletes, a record whose run has `FINISHED`, whose run directory is gone, or that has not
been rewritten for two days; `landed` removes this run's records.

`chips/<session-id>` has a second reader now: `fleet.sh recover`. After a crash it is the only thing that
says which dead chat was which chip, and therefore which transcript to reopen. That makes registration
worth more than it was when the hook was its only client — a claim made without `CLAUDE_CODE_SESSION_ID`
set cannot be recovered by session at all, only swept by heartbeat, and `recover` reports it as UNKNOWN
rather than guessing.

`chips/<session-id>` exists for one reason: a worker ending its turn while it still holds an unfinished
claim is invisible to every script here — the disk looks identical whether that worker is thinking or gone
— and visible to the harness, which knows a turn is ending. The plugin's `Stop` hook reads that file,
finds the claim, and refuses the stop once with a sentence naming the task.

**It refuses only on the signature the failure actually had** [M03]: a claim whose heartbeat still equals
its claim time, taken within the last ten minutes. Holding a claim is not the failure — claiming as the
closing act of a turn and never touching it again is. A worker that has written a heartbeat is working,
and a worker that armed a clock and stopped is doing what this document asks; blocking either would cost a
turn and teach the next worker to route around the hook. It also stands down when the session is not a
worker at all, when the marker is already written, when the harness says it has already fired, and after
it has blocked a given claim once.

`<run-id>` is the date plus a short slug: `2026-08-26-checkout-flow`.

Add `.fleet/` to the project's ignore file. Runs are scratch, not history.

## Pause, retire, relaunch

`fleet.sh pause <run> [reason|-]` writes `PAUSED` and the global marker (the reason is read from stdin only
when the argument is a lone `-`); `fleet.sh resume <run>` removes both. While `PAUSED` exists, `next` hands
out nothing and **exits 8** (printing `RUN PAUSED` and a wake loop), `drained` does not write `.done` and
exits 8 (before it prints the tab-swap line), the abort clock does not count paused time, and `sweep`
reclaims nothing and reports no claim as dead, because heartbeats stop on purpose. Exit 8 means paused, not
empty and not waiting; the worker acknowledges and waits (`fleet-run` section 1c). `resume` takes the
coordinator seat only with `--take-over`, which is the last call of the new coordinator's chip prompt; a
plain `resume` never does.

Enforcement is the hooks' (`fleet-memory.mjs`, `fleet-contract.mjs`, through one check in `run-dir.mjs`),
and it is a short grace, not an instant wall. The grace, `pause_grace_seconds` (30 in `calibration.json`),
starts at a registered worker's first tool call after `PAUSED`, which is refused once with a notice that
gives the seconds left, says the call did not run (repeat it if it is part of finishing) and carries the
`TaskStop` line (subagents and background shells; the abort clock stands still on its own). A worker that
never calls is held anyway from `PAUSED` plus four times the grace (the ceiling is for that worker only: a
subagent whose parent has not called yet, the normal case, gets the grace from `PAUSED`). Calls pass for the rest of the grace so
the step in hand can finish; after it, every call except `fleet.sh` (as `sh "$f"`, `sh
"${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh"` or the plugin's exact path), `git` and a `sleep`/`until` wake loop
is refused, whether or not the worker has acknowledged: edits and browser actions always, `Skill` after the
grace, `Monitor` like `Bash` and `NotebookEdit` like `Edit`. The shell check is an allow-list that works as a
drift guard for a cooperative worker, not a sandbox. It refuses `$(...)`, backticks, a lone `&`, an unquoted
`>` other than `2>&1`, `>/dev/null`, `2>/dev/null` and `2>$null`, backslash-escaped quotes, a `(` or `@(`
that does not start a segment (PowerShell `(npm t)`), a quote or backslash inside the first three words of a
`git` command (`git "-c" ...`), and for `git` the options and subcommands that run other programs (`-c`,
`--exec-path`, `--ext-diff`, `rebase -x`, `bisect run`, `submodule foreach`, `filter-branch`, `config`,
`difftool`, `--upload-pack`, `grep -O`) and the variables `PAGER`, `EDITOR`, `VISUAL`, `GIT_EDITOR`, `HOME`
and `XDG_*` set in front of a command; it allows other plain `VAR=value` words and a trailing
`| head|tail|cat|wc|grep`. The browser tools gated are the Claude Browser pane and Claude in Chrome only;
Playwright, chrome-devtools, puppeteer, computer-use and every other MCP tool are not gated. A subagent's tool calls carry its parent's session, so they stop the same way (the
subagent field read is `agent_id`, unverified against a live payload), and `Agent`/`Task` are refused from
the start. The worker stops its subagents and background shells with `TaskStop`, commits work in progress,
appends a "stopped at ..." line to its `<chip>.notes.md`, and runs `fleet.sh paused <run> <chip>` (refused
for the coordinator's session), which writes `stopped/<chip>` (not `paused/`: on a case-insensitive disk it
would collide with `PAUSED`) and prints the wake loop. `status` shows `== PAUSED since <time>: <k> of <n>
workers holding claims have stopped`; a holder reads "no ack yet" until `pause_still_working_seconds` (150)
after `PAUSED` and "still working" after. The coordinator, and any session that is not a registered worker, is
never blocked. `next` and `drained` register the calling session in `chips/` before any exit, so a worker
that has only been told QUEUE WAITING is held too. The Stop hook does not block a worker's turn end while
`PAUSED` exists or its chip is retired.

`fleet.sh relaunch <run> [--wait N] [--keep-coordinator] [NN ...]` is a pause plus a replacement, run with
`run_in_background` because it waits (N minutes, default 5) for every worker holding a claim to acknowledge.
`NN` are two-digit chips that were offered; anything else is exit 2. It runs in two calls. **Call 1** pauses,
waits, and for each named chip hands its open claims back: a dirty worktree is committed on its own branch
as `wip: handed back` (on `fleet/<NN>/<id>-handback` when HEAD is detached) and the files are printed; the
claim directory becomes `<id>.released-<time>`; the task is re-filed as a new ready task `<id>-r<n>.md` with
the same frontmatter plus `continue-from:`, `continued-from-chip:` and `handback-of:` (below; only the old
`before` proof line is carried over, a fresh worker always runs `prove after` in its own worktree); the old task
file moves to `tasks/handed-back/`; `<chip>.retired` is written. When `STATE.md` is not newer than `PAUSED`
it then prints "STATE.md NOT CURRENT: <run>/STATE.md is older than the pause and the handbacks. No chips are
printed yet." with what to put in it, and exits 1 on purpose: that is the expected stop, not a failure. Update
`STATE.md` and run the same command again. **Call 2**, the same command, is idempotent, does not wait for acks again (it prints `acks: <k> of <n> (not
waited again)`) and prints the chips for fresh workers, numbered after
the highest offered, and one coordinator chip whose prompt ends in `fleet.sh resume <abs run> --take-over`
and names the `n` for the watch (every chip ever offered, retired ones included). With `--keep-coordinator`
no coordinator chip is printed and no `coordinator-pending` written, and the command resumes the run itself:
the same coordinator carries on. `landed`, `drained`, `next`, the watch and the Stop hook treat a retired
chip as finished, and a retired chip is held by the hooks before any PAUSED check, resume or not, with "you
were retired: end this turn with one line, commit nothing, start nothing" (`next`, `drained` and `paused`
exit 9 or say the same); only closing what it started passes (`tabs_close`, `tabs_context`, `preview_stop`,
`preview_list`; `TaskStop` is never held). A retired chat is not reused: its hold ends only when the run lands (`FINISHED`, or
the run directory is gone). A resumed worker carries on with the claim it holds and calls `next` only if it
holds none; `next` refuses a second claim (exit 2, naming the held one), except one repo task beside a pane worker's pane task. Without `--take-over` the run stays
paused until someone resumes it.
`fleet.sh contexts <run>` lists every session's context size and marks the ones over `coordinator_handoff_k`
(the coordinator) or `worker_relaunch_k` (a worker) with `OVER`; both are 700 (K) as shipped, the operator's
choice: auto-compaction starts a little past 900K, and the ask at 700K, repeated every
`coordinator_handoff_step_k` (100), leaves room to write state and stop workers. `fleet.sh ctx` prints a
line when one crosses a mark, once per mark per session.

## Brief format

```markdown
---
run-id: 2026-08-26-checkout-flow
chip-id: "01"
kind: verify           # verify | investigate | implement | fix | research | design | critique | canvas | redesign | call
needs: pane            # pane | verify | repo, the lane this brief's work belongs to
model: sonnet          # the model the work wants; a wish: the chip decides what runs, and a worker below it
                       # delegates the task to one Agent at that tier (see MODELS.md)
verdict-model: opus    # the model that decides what counts as a finding
owns: [routes, files, or areas this worker may touch]
isolation: none        # none | worktree, see below
---

## Route in
How to reach the starting point from a cold start.

## Steps
Numbered. Each carries the action and the assertion that decides pass from fail.

## Correct looks like
Concrete and checkable. "The totals row sums the visible rows" rather than "totals work".

## Out of scope
Named explicitly, including the areas other workers own, by number.
```

`kind` selects the working style, described in [`MISSIONS.md`](MISSIONS.md).

Nothing in `scripts/` reads a brief: a brief is read by the worker alone, so a field here is a rule to a
model rather than an input to a program.

## Task format

A pull-mode task in `tasks/ready/` is the same document with different frontmatter, and this half **is**
parsed. `fleet.sh next` reads `needs`, `budget` and `after`; the sections below the frontmatter are the
brief's, minus the ones that describe a whole worker's slice.

```markdown
---
task-id: task-07-vendor-egress
kind: fix              # the same set as a brief's
needs: repo            # pane | verify | repo. Absent, `next` treats the task as `repo`
budget: 25             # minutes. `next` prints twice this as the abort deadline, and `sweep` calls a
                       # claim quiet for longer than one budget abandoned. Absent, `sweep` assumes 25
after: task-02-primitives   # optional, one id or several: `next` holds this task until those are done. Done is
                       # the done marker, not the coordinator's merge: see `base` below
base: integration      # optional, code tasks. The branch the task's branch is cut from: the integration branch the
                       # coordinator merges into. The worker's `worktree --create` uses the first task's; before editing
                       # it merges the `branch <name>` line of each `after:` predecessor's done marker that is not
                       # yet in `base` (git merge-base --is-ancestor). No script reads it. A `needs: pane` check
                       # task first confirms the build branch is in the integration checkout, or files ask/
continue-from: fleet/03/task-07   # optional, written by `relaunch` only when the retired worker was on fleet/<NN>/<id> (code
                       # kinds). The branch it left: a worker cuts its task branch from it instead of `base`,
                       # reads that worker's notes (its last line says "stopped at ...") and continues
continued-from-chip: 03   # optional, with the above: the chip whose notes to read, for the original id (without `-r<n>`)
handback-of: task-07   # optional, written by `relaunch`: the original id. For a fix or root task `fleet-gate` reads
                       # `<handback-of>.released-*/proof` as the before, so the proof carries over
fanout: 3              # optional, repo lane only. No script reads it; a worker honours it, see LANES.md
verdict-model: opus    # optional. The tier that reviews a code task before it is finished; absent, the
                       # worker reviews at its own tier. A wish, like `model:`: no script reads it
origin: http://localhost:5199   # optional, pane tasks. Where the worker opens the app instead of FLEET.md's
                       # origin: the integration checkout's dev server, or the worker's own tree's. No script reads it
operator: grant the read-only role   # optional. What the operator must do first. Asked at launch; `next` holds the
                       # task until `fleet.sh cleared`; `status` lists it with how much waits behind it
---
```

`fleet.sh fixqueue` writes a second-generation queue from a merged backlog and adds three fields to that
frontmatter, so a fix worker can see where its task came from without opening the backlog: `finding-id`,
the id `merge` stamped on the finding; `severity`, carried over from it; and `twins`, the ids of the other
findings whose evidence named the same file, which are one seam and belong to one worker.

`fixqueue` also derives the fields above rather than asking: `kind` is `design` when the finding carried
`rects` or a probe and `fix` otherwise, and `needs` is `pane` when the reproduction names a click, a
keystroke, a hover, a scroll, a drag, a screenshot, an overlap or a zoom, and `repo` otherwise.

`fleet-gate.mjs cluster` then writes one more shape into the same queue, `kind: root`, and adds `after:` to
the tasks it gates. A root task carries `shared`, the file or identifier its members all reach, and
`gates`, the task ids held behind it. It is the one task in a fix queue that may edit files another task
names, which is the point of it: everything that reaches its seam is held while it runs.
[`GATE.md`](GATE.md) is the whole stage.

`fleet.sh finish` refuses a `fix` or `root` task whose reproduction has not been run through
`fleet-gate.mjs prove` before the change and after it, over a tree that moved between the two.

`fleet.sh finish <run> <chip> <task-id> [branch]` takes the task's branch for a code task and records it as
a line `branch <name>` in `tasks/done/<task-id>`; the coordinator reads that line to find what to review and
merge. `finish` creates the marker only when it is absent and writes the branch line only when a branch is
given, so a second `finish` without one keeps the line the first recorded; it warns, and still records the
branch, when the name does not resolve in the worker's registered worktree. Every `fleet.sh` subcommand also accepts a relative run directory from a cwd where it does not
exist (a worktree): it resolves it against the main checkout before failing.

`isolation: worktree` gives the worker its own checkout. Any brief that writes code uses it. Two sessions
editing one tree produce a merge nobody asked for. Creating and removing those trees safely is
[`WORKTREES.md`](WORKTREES.md): a junction left inside a worktree is a hole a recursive delete follows into
the main checkout [M32], and `fleet.sh clean` is the only path here that removes one.

## Finding schema

One JSON object per line in `<chip-id>.jsonl`:

```json
{"area":"", "severity":"blocker|major|minor|polish", "observed":"", "repro":"", "evidence":"", "mechanism":"", "mechanism_status":"established|hypothesis|unknown", "conditions":"", "when":"", "rects":null, "skip_reason":null}
```

`fleet.sh find` stamps `when` and `chip` for you and refuses the line if the rest is not there, so the
schema is a gate rather than a request. **It is also the only way a line reaches that file**: an append
written by hand passes none of those checks, and the gate is the only place the contract is enforced rather
than requested. `when` matters because a run changes shared state under itself:
without an observed-at time, quarantining the findings taken after a role flip or a saved setting is
guesswork, and with it the quarantine is a script.

`rects` carries the two rectangles of a visual claim, `{"a":{"x","y","w","h"},"b":{...}}`. The gate
refuses a visual finding whose rectangles do not intersect, whatever the model believes it saw, and
refuses one whose `conditions` names no viewport.

`skip_reason` moves a finding out of the backlog without deleting it: an artefact of the environment
rather than the application, a reproduction that no longer reproduces. Collection files those in
`skipped.jsonl` with the full schema intact, so promoting one back later needs no re-observation.

`observed`, `mechanism` and `mechanism_status` are the load bearing split, and the section "Observation
and mechanism are separate claims" below is where the rule for them lives.

`evidence` carries one of:

- a `file:line` reference,
- an expression that reproduces the observation,
- for a performance claim, three readings with their spread and the machine load beside them.

A finding without evidence stays out of the file. Whoever fixes this needs a starting point, and "looks
off" is not one.

A second line shape belongs in the same file, because an area nobody finished is not an area that came
back clean:

```json
{"unreached":"steps 7-9 of task-04, the Completed tab", "reason":"budget exceeded"}
```

Without it, unreached work can only land in the notes file, and collection does not read notes. A worker
that stops at twice its budget then produces a backlog reporting that area clean.

Two more line shapes exist for the same reason, and for the same file:

```json
{"created":"user Ada Test, group QA-2, tag rerun", "where":"sandbox company 41"}
{"state_changed":"active role a -> p", "when":"inside task-34", "cause":"", "blast_radius":""}
```

`created` is what the run left behind in the environment. A fleet writes real rows, and the next person to
read that sandbox deserves to know which of them an agent made rather than a person.

Both auxiliary shapes are checked rather than waved through. An auxiliary line **may not carry**
`severity`: the merge routes on that field alone, so one extra key would file a blocker with no area and
no evidence straight into the backlog. `created` needs
`where`, `state_changed` needs `when`, and `what` - the retired field name - is refused on every shape
rather than only on findings.

`state_changed` is any change to state the whole fleet shares: the account's role, a saved column
selection, a dashboard's card set, anything the server persists per account rather than per session. Write
the line the moment you notice, and open an `ask/` alongside it, because every finding measured after that
point was measured under different conditions. Measured 2026-08-27: an account's active role changed
mid-run and the rest of that run's lists returned 403 and its badges read 0, which is indistinguishable
from a defect until somebody names the window.

`conditions` carries what the observation depended on, as a short string: the viewport, the zoom and
whether it was simulated, the claimed total where a count is involved, the machine load where a timing is.

It is a field rather than a sentence inside `evidence` because collection ranks and dedupes by it. Measured
2026-08-26 across 94 findings: one worker recorded the viewport in 14 of its 15 findings, two profilers in
none of their twelve, and the worker whose entire task was zoom recorded it in 4 of 20 while carrying the
systematic answer in its notes file. The discipline was real and it landed where no tool could read it.

A layout or timing finding without `conditions` is not reproducible: a column overflowing at 1100 px and
fitting at 1600 is a responsive difference, and the number is the only thing separating that from a defect.

An empty findings file is a real result. Report it as such.

## Observation and mechanism are separate claims

The evidence contract catches a finding with nothing behind it. It does not catch the failure that
actually happens, which is a finding whose evidence proves the **symptom** and is then used to license a
claim about the **cause**.

A fix mission working 100 findings refuted roughly 15, and the refuted ones all carried evidence that
looked exactly like the evidence on the true ones [M09].

- A blocker reported a count branch and a select branch disagreeing, citing a seed report's hypothesis.
  The symptom was real and reproduced. The mechanism was invented: one predicate was built and both halves
  honoured it, and the rows genuinely matched, because the search parser was stripping letters and turning
  `wilson9` into `9`.
- "Escape does not close the menu" came from a probe firing the key on `document` while the handler sat on
  a descendant. The probe was broken, not the application.
- "A constant 2880 pixel gap" was one loaded page: working pagination read as a defect.
- A channel reinstalling itself was the documented shape of forced long polling, switched on deliberately
  with the reason recorded beside it.

So the schema carries them apart:

```json
{"area":"", "severity":"", "observed":"", "evidence":"", "mechanism":"", "mechanism_status":"established|hypothesis|unknown", "conditions":""}
```

`observed` is what you saw, and `evidence` proves that and only that. `mechanism` is why you think it
happens, and `mechanism_status` says how far you actually got. **`established` requires its own evidence,
naming the line that does it and the check that rules out the alternatives.** Anything short of that is
`hypothesis`, and a hypothesis is a perfectly good finding: it sends the next person to the right screen
without sending them down the wrong path.

Never borrow a mechanism from a report of a similar symptom elsewhere. Two screens can produce the same
wrong number for unrelated reasons, and an inherited diagnosis is the most expensive kind of wrong,
because it reads as corroboration.

A refuted finding is a result worth as much as a confirmed one. Record what refuted it, with the work
shown, so the next run meets the same misleading evidence and does not file it again.

## The notes file

`<chip-id>.notes.md` holds what the findings file must not: assertions that passed, claims the worker
raised and then refuted, and observations about the tooling rather than the application.

Write refutations down. A claim killed on review is the more useful result of the two, because the next
worker meets the same misleading evidence and re-files it otherwise. Record what the claim was, what
refuted it, and the probe that settled it.

Assertions that passed belong here too. A run reporting no findings is ambiguous between "checked and
clean" and "never checked", and the notes file is what separates them.

Keep it out of the findings file so collection stays mechanical: the JSONL is the contract, the notes are
for the human reading afterwards.

## Completion markers

A worker writes `<chip-id>.done` as its final act, after the findings file is closed. The marker is
separate because the existence of a findings file says nothing about whether the worker was still writing
to it, and the planner treats the marker as permission to read.

A worker that stayed blind writes `<chip-id>.blocked` instead, holding one line naming what it could not
see, and writes no findings at all. Collection reports blocked workers separately. A run that reads
"clean" while a third of it saw nothing is worse than no run.

## The waiting marker

A worker that stops to ask the operator something writes `<chip-id>.waiting` first, holding one line
naming what it needs, and deletes it once the answer arrives.

Without it a worker blocked on a question is indistinguishable from a worker doing its job: no new files
either way, and the run simply takes longer for no visible reason. The most common case is a pane that was
never displayed, where the worker is correctly refusing to guess and is waiting for a person who does not
know they are being waited on.

The marker turns a silent stall into a named one, and it is the only thing on disk that can.

## One chip, one run

A worker session works one run and then stops. Reusing it for the next mission looks free and is not.

The chip title is the run's addressing scheme, so a session titled for run A that is working run B cannot
be found by anyone reading the titles — six of them did exactly that for five hours [M11]. Its context also
carries the whole first run, paid for again on every turn of the second.

## Project configuration

The plugin carries no project details. A project that runs fleets keeps a `FLEET.md` at its root, and
every command reads it when present:

```markdown
# Fleet configuration

- App origin: http://[::1]:5173
- Services: http://[::1]:5173 (start: npm run dev); http://127.0.0.1:5001 (start: operator)
- Login runbook: docs/HOW_TO_LOGIN_AS_AI.md
- Naming: user facing names come from mainNav labels and router meta.title
- Actions reserved for the operator: anything that dials, charges, ships, or messages a real person
- Verification cost: full test suite 63s, full typecheck 30s, both memory heavy
- Accelerators present: rg, sg, bun. Absent: fd, jq. Project query tool: graphify query "..."
- Concurrency: pane lane max 10 (display), repo lane max 10 (16 GB / 16 cores), verify lane 1
- Subscription: max tier, rate limits are not the binding constraint on this machine
- Canvas: design/canvas (optional; where a canvas run writes its artboards, this is the default)
- Canvas viewport: 1440x900 (optional; the frame a canvas run captures at, this is the default)
- Design tokens: src/styles/tokens.css (optional; read into the design probe's scale by critique and recon)
```

**The `Services` line has one fixed shape, because a program reads it:** `- Services: <url> (start: <how>|operator); <url> (start: ...)`.
Each service is a URL a connection can be made to, then `start:` holding the command that starts it, or
`operator` when only the operator may. `fleet-init` writes it; the watch in `fleet-wait` builds the list of
URLs it probes from it, and reads `start:` when a service goes down: the coordinator restarts the ones that
name a command and tells the operator about the rest. Only a URL that comes before an item's `(start: ...)`
part is probed, so a start command that mentions one is not. A worker never starts one of these shared
services, whatever `start:` says. A project with no services leaves the line out, and the watch then prints
`WATCH: no '- Services:' line in FLEET.md, services are not being checked`: so does an old-format line, which
is why `fleet-init` converts one.

**The concurrency line is per lane, and the two numbers come from different places.** The pane number is
how many Browser panes the operator's display holds; the repo number is what the machine holds. Writing
one number for both is how a run caps its file work at the width of a monitor. `fleet-init` measures the
machine and asks the operator for the display and the subscription tier once, so no planner has to guess
and no worker has to ask.

Absent that file, each command discovers what it can and says plainly what it could not find. Guessing at
an origin or a login form wastes an hour and produces nothing.
