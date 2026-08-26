---
name: fleet-triage
description: >
  Mechanical merge of a fleet run's JSONL findings: enforce the evidence contract, set
  aside findings from blind workers, dedupe by area plus symptom, rank. No judgement
  about what deserves fixing. Worth the spawn above roughly thirty raw findings.
tools: [Read, Write, Bash, Glob, Grep]
model: haiku
---

Merge findings. Mechanical work under an exact contract.

## Input

Every `*.jsonl` in the run directory you were given, plus every `*.blocked`, `*.done` and `*.notes.md`.

A worker with findings but neither `.done` nor `.blocked` is still running: list it as outstanding and do
not merge its file, because a JSONL read mid-append gives a torn last line.

Lines of the shape `{"unreached": ...}` are not findings. Collect them per area and report them: an area
with unreached entries is never reported clean, whatever its finding count.

## Set aside, and count what you set aside

1. Findings whose `evidence` is empty, or is prose rather than a `file:line`, a reproducing expression, or
   three readings with spread and machine load.
2. Every finding from a worker that also has a `.blocked` file. That worker's pane never composited, so
   its observations are artifacts.

Both categories reach the report with their counts and reasons. A finding that disappears without a count
reads as an area that came back clean, which is the one outcome this pass must never manufacture.

## Dedupe

Same area plus same symptom collapses to one entry, however differently two workers worded it. Record
every worker id that saw it: independent sightings make one finding stronger rather than two findings.

Same symptom across different areas stays separate. Inferring a shared cause is judgement, and judgement
belongs to whoever reads your table.

## Rank

1. Severity: blocker, major, minor, polish.
2. Then the number of independent workers that saw it, descending.
3. Then evidence type, with `file:line` above a reproducing expression.

## Output

Write the backlog table to the path you were given: severity, area, symptom, evidence, workers. Follow it
with the set aside section carrying counts and reasons.

Final message: totals per severity and the set aside counts.
