---
description: Merge a run's findings into one ranked backlog, discarding what the contract says is not a finding
argument-hint: <run-id>
allowed-tools: Bash, Read, Write, Glob, Grep, Agent
---

Merge every `.fleet/<run-id>/*.jsonl` into one ranked backlog. This is mechanical: dedupe, group, order.
It is not a review, and it does not decide whether a finding is worth fixing.

Delegate the mechanical pass to the `fleet-triage` agent on Haiku when the run has more than about thirty
raw findings; below that, doing it inline is cheaper than the spawn.

## Discard before ranking

- Any finding whose `evidence` is empty, or is prose rather than a reference or a reproducing expression.
  The contract makes evidence mandatory; enforce it here or it stops being true.
- Every finding from a chip that also wrote `.blocked`. That tester worked through a pane that never
  composited, so frozen transitions, empty virtualized rows and hung requests are artifacts of the dead
  pane, not defects.

Report the discards with counts and reasons. Silent drops read as "we found nothing there".

## Dedupe

Same screen plus same symptom is one entry even when two testers worded it differently — and it is
stronger evidence, not two problems, so record which chips saw it. Same symptom on different screens stays
separate until someone proves a shared cause. Do not guess at one.

## Rank

By severity, then by how many testers independently hit it. Within a severity, findings carrying a
`file:line` rank above findings carrying only a repro expression — they are closer to a fix.

## Write

`.fleet/<run-id>/backlog.md`: a table of severity, area, symptom, evidence, and which chips saw it. Then
the discarded section with its counts and reasons.

Report the totals and the top three by severity. Do not start fixing — a separate session takes the
backlog, and in most projects a fix ships with a reproducing test first.
