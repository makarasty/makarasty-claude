---
description: Merge a fleet run's findings into one ranked backlog. Use after a run's workers have finished, or when asked what a run found.
argument-hint: <run-id>
allowed-tools: Bash, Read, Write, Glob, Grep, Agent, PushNotification
---

The reference files named below (`docs/PROTOCOL.md` and its siblings) live in this plugin's own directory,
not in the project you are working on. Resolve that directory once, before following any pointer:

```bash
ls -dt ~/.claude/plugins/cache/*/makarasty/*/docs 2>/dev/null | head -1
```

Empty output means the plugin is running from a checkout instead of an install: look for `docs/` beside
the `commands/` directory holding this file.

Merge every `.fleet/<run-id>/*.jsonl` into one ranked backlog. Mechanical work: dedupe, group, order. It
does not decide whether a finding is worth fixing, and it does not fix anything.

The finding schema is in `docs/PROTOCOL.md`.

## The merge is a script, and it is the first thing you run

```bash
f=$(ls -t ~/.claude/plugins/cache/*/makarasty/*/scripts/fleet.sh | head -1)
sh "$f" merge  .fleet/<run-id>     # -> backlog.jsonl, skipped.jsonl, unreached.jsonl, and a reconciliation
sh "$f" render .fleet/<run-id>     # -> backlog.md and skipped.md, generated from the JSONL
```

`merge` assigns every finding a stable id, groups by area plus symptom, carries the sighting lineage,
flags anything observed after a `state_changed` line, and then **refuses to finish** if the sightings do
not add up to the input or if a blocker present in the input is absent from the output. Verified against a
254 finding run: 254 in, 254 accounted for, six blockers in and six out.

**Your judgement goes on top of that file, never instead of it.** Rank, annotate, name the twins, say what
you would fix first. Do not retype rows into a markdown table: measured 2026-08-28, a merge written by hand
rendered 68 of 254 findings while claiming 255, reported one blocker where the workers filed six, and lost
the run's worst finding entirely. Nothing about the output looked wrong.

Above roughly thirty raw findings, hand the annotation pass to the `fleet-triage` agent. Below that, the
spawn costs more than the work. Either way the JSONL comes from the script.

## Confirm observations, not mechanisms

Roughly 15 of every 100 findings are refuted when somebody tries to fix them, and the refutations are
almost always of the mechanism rather than the symptom. Confirming mechanisms here would pay twice for
what the fix kind does anyway, so confirm the part that is executable:

- Re-run the `repro` expression. Re-read the `file:line`. Re-intersect the `rects`.
- **Every blocker and every major.** Sample the minors. Skip the polish.
- A finding that confirms gets `"confirmation":"confirmed"`. One that does not gets `skip_reason` naming
  what failed, and lands in `skipped.jsonl` rather than being deleted.

An environmental artefact goes the same way: a window resized mid-run, a pane that was collapsed, a state
another worker wrote. Say which, keep the row. The whole schema stays, so promoting it back later needs no
re-observation.

## Hand the fix work over as a queue

```bash
sh "$f" fixqueue .fleet/<run-id>   # -> .fleet/fix-<run-id>/tasks/ready/*.md
```

One task per blocker and major, each carrying the finding id, the reproduction, the evidence, the
mechanism marked as a lead rather than a diagnosis, the lane it needs, and the twins that share its files.
A second fleet claims that queue with `/makarasty:fleet-run .fleet/fix-<run-id>/`, or one chat works it
alone. Either way the input is a queue, not a document somebody has to re-read.

## Read only what is finished

A worker with findings but no `.done` and no `.blocked` is still running. List it as outstanding and do
not merge its file: reading a JSONL mid-append gives you a torn last line, which is either a parse error
or a finding silently dropped.

## An unreached area is never clean

Collect the `{"unreached": ...}` lines alongside the findings, and report them per area. An area carrying
unreached entries appears in the backlog as incomplete, whatever its finding count. A worker that stopped
at twice its budget covered part of its area, and a backlog that says otherwise is the failure this whole
plugin is built against.

Read each worker's `<chip>.notes.md` for claims it raised and then refuted. Do not re-file a refuted
claim, and carry the refutation into the backlog: the next run meets the same misleading evidence.

**Severity is copied, never decided.** A worker chose it with the screen in front of it; you have a JSON
line. The script preserves it, and the reconciliation refuses a run where a blocker went missing, which is
the failure it was written for.

## Land the run: notify, then stop the watch

These are one act, done once, when the run is **genuinely** finished. That is a checkable state rather than
a feeling, and the script checks it:

```bash
sh "$f" landed .fleet/<run-id> <expected-chips>
```

It passes when every chip has a `.done` or `.blocked`, every claim has a done marker, every task in
`ready/` was claimed by somebody, `backlog.jsonl` exists and is not empty, and no `.waiting` marker is on
disk. "The workers went quiet" is not the same state, and the whole reason this plugin has a stall rule is
that silence is ambiguous between finished and dead.

Then, in this order:

1. **`PushNotification`** with the headline: run id, findings by severity, blockers, and where the backlog
   is. It reaches the operator's phone when Remote Control is connected, and it is skipped automatically if
   they are sitting at the terminal, which is the behaviour you want. One notification per run.
2. **`TaskStop`** the run's `fleet-wait` monitor. Measured 2026-08-27: a watch left armed after its run
   finished kept polling for five hours and forty two minutes, and was noticed only when the operator asked
   what the six hour task in their task list was.

Exactly two other things are worth waking someone for, and both belong to the planner rather than here: a
fleet still stalled after a revive attempt failed, and nothing else. A worker asking for its pane must
never page at night, because a sleeping operator cannot open a pane; that is what the paneless lane and the
panes-open-before-bed rule in `fleet-plan` are for.

**If the project's `FLEET.md` names a webhook**, post the same headline there as well: run id and counts.
Never findings text. A webhook is egress, the findings can carry data from the application under test, and
the URL belongs outside the repository.

## Enforce the evidence contract

Keep findings whose `evidence` is a `file:line`, a reproducing expression, or three readings with spread
and machine load. Set aside the rest.

Flag, without setting aside, any layout or timing finding whose `conditions` is empty. It is unreproducible
until someone supplies the viewport and zoom it was seen at, and it belongs in the backlog marked as such
rather than ranked beside findings that carry theirs.

Set aside every finding from a worker that also wrote `.blocked`. That worker observed through a pane that
never composited, so frozen transitions, empty rows and hung requests are artifacts of the blind pane.

Both categories go in the report with their counts and reasons. A finding that vanishes without a count
reads as an area that came back clean.

## Dedupe

Same area plus same symptom collapses to one entry even when two workers worded it differently, and it
carries the list of workers that saw it. Independent sightings make one finding stronger rather than
making two findings.

Same symptom across different areas stays separate. Proving a shared cause is judgement, and this pass is
mechanical.

## Rank

1. Severity: blocker, major, minor, polish.
2. Then the number of independent workers that saw it, descending.
3. Then `mechanism_status`, with `established` above `hypothesis` above `unknown`, since a finding whose
   cause is proven is closer to a fix than one whose cause is guessed.
4. Then evidence type, with `file:line` above a reproducing expression.

Carry `mechanism_status` into the backlog table. A hypothesis presented as a diagnosis is how a fix
mission spends its time disproving the report instead of repairing the product: measured 2026-08-26,
three of eight blockers and majors changed diagnosis the moment somebody tried to fix them.

## Write

`.fleet/<run-id>/backlog.md`, holding a table of severity, area, symptom, evidence and workers, then the
set aside section with its counts and reasons.

## Done when

Every findings file in the run directory has been read, every finding is either ranked or counted in the
set aside section, and `backlog.md` exists.

## Report

Totals per severity, the set aside counts, and the top three by severity. Fixing is a separate session's
job, and in most projects a fix ships with a reproduction that failed before it.

## A thin review is a signal

Compare the effort a review spent against its siblings on the same run. Measured 2026-08-26: reviews on
one mission ran 9, 18, and 32 to 39 tool calls. The two thin ones came back clean and left the load
bearing questions unanswered, and both were about the parts that most needed answering: date arithmetic
across a daylight saving transition, and the acknowledgement semantics of an endpoint deciding what every
user sees as new.

A clean review that cost a fraction of what its siblings cost has not cleared the work, it has skimmed it.
Re-ask the specific question yourself, on the specific lines, rather than accepting the verdict.

The planner in that mission did exactly this and it held: the modules turned out sound, and the check took
minutes. The value is not in catching the reviewer out, it is in knowing which verdicts were bought.
