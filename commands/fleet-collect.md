---
description: Merge a fleet run's findings into one ranked backlog. Use after a run's workers have finished, or when asked what a run found.
argument-hint: <run-id>
allowed-tools: Bash, Read, Write, Glob, Grep, Agent
---

Merge every `.fleet/<run-id>/*.jsonl` into one ranked backlog. Mechanical work: dedupe, group, order. It
does not decide whether a finding is worth fixing, and it does not fix anything.

The finding schema is in [`${CLAUDE_PLUGIN_ROOT}/docs/PROTOCOL.md`](../docs/PROTOCOL.md).

Above roughly thirty raw findings, hand the mechanical pass to the `fleet-triage` agent. Below that, the
spawn costs more than the work.

## Enforce the evidence contract

Keep findings whose `evidence` is a `file:line`, a reproducing expression, or three readings with spread
and machine load. Set aside the rest.

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
3. Then evidence type, with `file:line` above a reproducing expression, since it is closer to a fix.

## Write

`.fleet/<run-id>/backlog.md`, holding a table of severity, area, symptom, evidence and workers, then the
set aside section with its counts and reasons.

## Done when

Every findings file in the run directory has been read, every finding is either ranked or counted in the
set aside section, and `backlog.md` exists.

## Report

Totals per severity, the set aside counts, and the top three by severity. Fixing is a separate session's
job, and in most projects a fix ships with a reproduction that failed before it.
