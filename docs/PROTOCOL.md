# Fleet protocol

The single source of truth for how a fleet run is laid out on disk. Commands and agents point here rather
than restating it, so changing the shape is a one file edit.

## Vocabulary

**Mission** is the whole job the operator wants done. **Brief** is one worker's slice of it, written as a
file. **Worker** is a session that runs one brief. **Wave** is a batch of workers started together.
**Blind** describes a worker whose browser pane is not compositing, so everything it observes is false.

Workers are fire and forget. They read a brief, write findings, and exit. They never message the planner
and the planner never messages them, because a file has an address and a session handle does not.

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
{"area":"", "severity":"blocker|major|minor|polish", "what":"", "repro":"", "evidence":"", "conditions":""}
```

`evidence` carries one of:

- a `file:line` reference,
- an expression that reproduces the observation,
- for a performance claim, three readings with their spread and the machine load beside them.

A finding without evidence stays out of the file. Whoever fixes this needs a starting point, and "looks
off" is not one.

`conditions` carries what the observation depended on, as a short string: the viewport, the zoom and
whether it was simulated, the claimed total where a count is involved, the machine load where a timing is.

It is a field rather than a sentence inside `evidence` because collection ranks and dedupes by it. Measured
2026-08-26 across 94 findings: one worker recorded the viewport in 14 of its 15 findings, two profilers in
none of their twelve, and the worker whose entire task was zoom recorded it in 4 of 20 while carrying the
systematic answer in its notes file. The discipline was real and it landed where no tool could read it.

A layout or timing finding without `conditions` is not reproducible: a column overflowing at 1100 px and
fitting at 1600 is a responsive difference, and the number is the only thing separating that from a defect.

An empty findings file is a real result. Report it as such.

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
```

Absent that file, each command discovers what it can and says plainly what it could not find. Guessing at
an origin or a login form wastes an hour and produces nothing.
