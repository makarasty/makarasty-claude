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

Messaging has exactly one job, in the other direction. The planner may send a worker a status check to
**revive** it, and that is the only thing that brings back a session which ended a turn with nothing
pending. Measured 2026-08-27: three workers dead for nearly three hours came back within seconds of a
cross-session message and finished their tasks. Nothing else in the system can do that, so keep the
handles usable, and never let a finding or an answer ride that channel.

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
the run nothing. Measured 2026-08-27: one worker put a "is this writing band sanctioned" question to the
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

Measured 2026-08-27, run `2026-08-27-create`: three of six workers ended a turn immediately after claiming
their next task and sat dead for **169, 171 and 176 minutes**, each holding a claim, until the planner
noticed and sent a cross-session message. All three had written a confident summary saying which task they
had just taken. None of them had begun it. From the outside they were indistinguishable from workers doing
slow work, which is why nobody looked for three hours.

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
  backlog.md           written by collection
```

`<run-id>` is the date plus a short slug: `2026-08-26-checkout-flow`.

Add `.fleet/` to the project's ignore file. Runs are scratch, not history.

## Brief format

```markdown
---
run-id: 2026-08-26-checkout-flow
chip-id: "01"
kind: verify           # verify | investigate | implement | fix | research
model: sonnet          # the model that does the work
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

`isolation: worktree` gives the worker its own checkout. Any brief that writes code uses it. Two sessions
editing one tree produce a merge nobody asked for.

## Finding schema

One JSON object per line in `<chip-id>.jsonl`:

```json
{"area":"", "severity":"blocker|major|minor|polish", "observed":"", "repro":"", "evidence":"", "mechanism":"", "mechanism_status":"established|hypothesis|unknown", "conditions":"", "when":"", "rects":null, "skip_reason":null}
```

`fleet.sh find` stamps `when` and `chip` for you and refuses the line if the rest is not there, so the
schema is a gate rather than a request. `when` matters because a run changes shared state under itself:
without an observed-at time, quarantining the findings taken after a role flip or a saved setting is
guesswork, and with it the quarantine is a script.

`rects` carries the two rectangles of a visual claim, `{"a":{"x","y","w","h"},"b":{...}}`. The gate
refuses a visual finding whose rectangles do not intersect, whatever the model believes it saw, and
refuses one whose `conditions` names no viewport.

`skip_reason` moves a finding out of the backlog without deleting it: an artefact of the environment
rather than the application, a reproduction that no longer reproduces. Collection files those in
`skipped.jsonl` with the full schema intact, so promoting one back later needs no re-observation.

`observed`, `mechanism` and `mechanism_status` are the load bearing split, and the section "Observation
and mechanism are separate claims" below is where the rule for them lives. This block used to name a
single `what` field, which contradicted that section two screens further down; workers reading both wrote
the union of them. Corrected 2026-08-28.

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

Measured 2026-08-26: a fix mission working 100 findings refuted roughly 15 of them, and the refuted ones
all carried evidence that looked exactly like the evidence on the true ones.

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

## The account is shared, so a setting is a fleet-wide write

Every worker signs into the same sandbox account. Anything that account persists on the server is
therefore shared by all of them, and changing it reshapes what the others are measuring.

Measured 2026-08-27 in one application: the visible-column selection, the analytics dashboard's card set
and the general settings group are all stored per account. One worker saving a column selection changed
which columns five other workers were looking at, and their measurements of that table were taken under a
layout nobody chose. The browser profile is shared too, so `localStorage` is common ground: filters one
worker saved were read by the next.

Three rules follow. Prefer a setting you can change in your own pane over one the server keeps. When you
must change a persisted one, write the `state_changed` line and an `ask/` note as you do it, never
afterwards. And read a surprising reading twice before filing it: under a shared account, "this list is
empty" and "this badge is 0" are as likely to be another worker's write as a defect.

## One chip, one run

A worker session works one run and then stops. Reusing it for the next mission looks free and is not.

The chip title is the run's addressing scheme, so a session titled for run A that is working run B cannot
be found by anyone reading the titles. Measured 2026-08-27: six sessions titled for a visual run worked a
second, unrelated queue for another five hours under those titles, and the planner had to identify them by
what they had recently written instead. Their contexts also carried the whole first run, which is paid for
again on every turn of the second.

## Project configuration

The plugin carries no project details. A project that runs fleets keeps a `FLEET.md` at its root, and
every command reads it when present:

```markdown
# Fleet configuration

- App origin: http://[::1]:5173
- Services that must already be running: vite on 5173, functions emulator on 5001
- Login runbook: docs/HOW_TO_LOGIN_AS_AI.md
- Naming: user facing names come from mainNav labels and router meta.title
- Actions reserved for the operator: anything that dials, charges, ships, or messages a real person
- Verification cost: full test suite 63s, full typecheck 30s, both memory heavy
- Accelerators present: rg, sg, bun. Absent: fd, jq. Project query tool: graphify query "..."
```

Absent that file, each command discovers what it can and says plainly what it could not find. Guessing at
an origin or a login form wastes an hour and produces nothing.

## Portability

Two things a fleet needs differ per operating system. Everything else here is plain files.

**Is a port listening.**

```bash
# macOS, Linux
lsof -nP -iTCP:5173 -sTCP:LISTEN || ss -ltn 'sport = :5173'
```
```powershell
# Windows
Get-NetTCPConnection -State Listen -LocalPort 5173
```

**Machine load, for a measurement to be interpretable.**

```bash
# Linux
free -m; nproc; uptime
# macOS
vm_stat; sysctl -n hw.ncpu; uptime
```
```powershell
# Windows
$os = Get-CimInstance Win32_OperatingSystem
"free {0:N1}GB of {1:N1}GB" -f ($os.FreePhysicalMemory/1MB), ($os.TotalVisibleMemorySize/1MB)
```

A project's `FLEET.md` may pin the exact command for its own machine, which removes the guess entirely.

Atomic claiming works everywhere: `mkdir` failing on an existing directory is POSIX behaviour and NTFS
behaviour alike, and it is the reason the claim is a directory rather than a file.

## Shell traps that cost this design real time

Measured across one eight worker run: 47 errors, of which the same two shapes hit almost everybody.

**A heredoc that never returns.** Writing a file by piping a heredoc into an interpreter hangs when that
interpreter waits on standard input, and the call sits until it times out. Hit seven workers of eight.
Write files with the harness's own write tool, and keep heredocs for text that goes straight to a file
through `cat > file <<'EOF'`, never into a program that might read stdin.

**The working directory does not persist between calls.** A `cd` in one call is gone by the next, so a
relative path written after it resolves somewhere else. Hit six workers of eight. Use absolute paths, or
put the `cd` and the work in the same call.

**Validating your own JSONL by hand.** Three workers wrote inline scripts to check the file they had just
written. With `jq` present, `jq -e . file.jsonl` does it in one call; without it, append one object per
line and trust the schema rather than writing a validator. Either way it is not worth a script.

The one genuinely platform bound trick is growing a window past the edges of the display, which is
described for Windows in [`BROWSER.md`](BROWSER.md). macOS has no equivalent through the window manager,
though a virtual display via `displayplacer` or a second Space serves the same purpose. On Linux it depends
entirely on the compositor.
