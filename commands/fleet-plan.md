---
description: Split an area of the product into independent briefs and offer one chip per brief
argument-hint: <area> [chip count]
disable-model-invocation: true
---

Split `$ARGUMENTS` into independent briefs, one per tester session. Default to 3 unless a count is given.

This command spawns work that costs money and needs the operator to click. It is deliberately
user-invocable only.

## Before splitting, read the project

Find the domain documentation for the area — start at `docs/README.md` if it exists, otherwise the
project's own index — and read the domain page. Do not write briefs from memory of the feature. A brief
that invents a synonym for a feature produces findings nobody can match back to a screen.

Search with the fastest tool available: `rg` for text, `sg` (ast-grep) for structure in TypeScript or
JavaScript. Issue independent searches in one message rather than one per turn — round-trips dominate.

## How to cut

**Cut by screen ownership, not by concern.** Testers share one account against one running app. Two
testers on one screen invalidate each other's observations the moment either changes state. Two testers on
two screens do not.

## Brief format

One file per chip at `.fleet/<run-id>/brief-<chip-id>.md`:

```markdown
---
run-id: 2026-08-24-billing
chip-id: 01
model: sonnet          # walks the scenario — see docs/MODELS.md
verdict-model: opus    # decides which observations are defects
owns: [/bills/list, /bills/:id]
must-not-touch: [/cases/*, anything owned by chips 02-03]
---

## Route in
How to reach the first screen from the landing page.

## Steps
Numbered. Each step: the action, and the assertion that makes it pass or fail.

## Correct looks like
Concrete. "Totals row sums the visible rows" — not "check the totals work".

## Out of scope
Named explicitly, so the tester stops instead of wandering.
```

Choose `model:` per brief rather than defaulting. Dense state, unfamiliar domain, or a subtle correctness
question earn Opus — weak models do not fail loudly there, they fail by not noticing. Clear spec and
obvious pass/fail earn Sonnet. Mechanical extraction with an exact contract earns Haiku. When unsure, go
one tier up: a missed defect costs a release, a tier costs cents.

Every brief carries the read-only posture in writing: no archiving, deleting, or bulk edits. Shared
account, concurrent testers.

## Then offer the chips

One `spawn_task` per brief. Title each chip exactly `fleet <run-id> <chip-id>` — that title is the only
reliable address later. Session handles from `ListAgents` are opaque, unstable between calls, and span
other accounts on the same machine; they are not addresses.

Each chip's prompt is one line: run `/makarasty:fleet-run .fleet/<run-id>/brief-<chip-id>.md`.

## Tell the operator what only they can do

1. Click each chip.
2. Open the Browser pane in each chip's chat and keep it on screen. A pane that is not displayed does not
   composite; that tester will stop and ask rather than guess.
3. Two concurrent live panes are measured working. Beyond about three, run the chips in waves.

Finish by naming the run-id and that `/makarasty:fleet-wait <run-id>` will report each tester finishing.
