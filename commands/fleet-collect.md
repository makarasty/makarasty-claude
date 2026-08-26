---
description: Merge a fleet run's findings into one ranked backlog. Use after a run's workers have finished, or when asked what a run found.
argument-hint: <run-id>
allowed-tools: Bash, Read, Write, Glob, Grep, Agent
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

Above roughly thirty raw findings, hand the mechanical pass to the `fleet-triage` agent. Below that, the
spawn costs more than the work.

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
