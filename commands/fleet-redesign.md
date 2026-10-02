---
description: Plan a redesign run over an existing canvas - the design model proposes new artboards beside the captured screens, states included, on the same canvas. Sketches directions first when the operator has not chosen one.
argument-hint: <screens and the direction in plain words> [fast]
disable-model-invocation: true
---

The `docs/*` and `scripts/*` files named below live in this plugin's own directory,
`${CLAUDE_PLUGIN_ROOT}`, not in the project you are working on.

## Missing prerequisites are work, not a refusal

A redesign runs over a canvas that already holds the captured screens: a proposal is measured against
the screen it replaces, and the operator sees both on one page. No `design/canvas/*.dc.html` for the
screens in `$ARGUMENTS` means the capture has to happen first, and **you cannot start it yourself**:
`fleet-design` carries `disable-model-invocation: true`, so the harness blocks a model that tries. Say in
one line which screens have no artboard, print the exact line for the operator to run -
`/makarasty:fleet-design <those screens>` - and stop there; do not refuse and do not improvise a capture.

## What this is

`fleet-design` with the `propose` stage. Read `docs/DESIGN.md`, section "Redesign", for what a proposal
is and what it must keep; the queue, the chips and the watch come from `fleet-design` and
`fleet-plan`. The design model owns every proposal end to end, per `docs/MISSIONS.md`, and that model is
the top tier `docs/MODELS.md` names for design.

## 1. Ground yourself

The canvas directory and its artboards, the screens in `$ARGUMENTS` matched to them, the source files
each captured artboard names in its provenance, and `FLEET.md`'s token file. Read the captured artboards
for the screens in scope: they are the anti-reference and the measure.

## 2. Settle the direction, or arrange for it to be settled

The draft plan carries: run id `<date>-redesign[-<slug>]`, the screens, and the direction. The direction
is the one thing worth a round:

- The operator gave an aesthetic, references, a design system, or constraints: record them in every
  proposal task verbatim, and skip the sketches. Say that you skipped them.
- They did not: the first task is `directions`, and the queue stays open across the pick. Ask which
  screen anchors the sketches (recommend the one a user sees most), and how many directions (recommend
  three).

Then one round on scope: which states each proposal must carry (loading and empty always; error and the
first-run state when the screen has one), and what must not change - the things `FLEET.md` reserves and
whatever the operator names.

## 3. Write the queue

Pull mode, `kind: redesign`, `isolation: none` (each task writes new artboard files and edits no source),
`needs: repo` throughout - a proposal is drawn from the captured artboard and the source, never from a
pane.

- **directions**, one, when the direction is open: `budget: 40`, the design model. Two to four
  `Direction<Name>.dc.html` on the `Directions` page at the anchor screen, low fidelity, each with the
  axis it explores, its motivation and its trade-off in a sticky note in `canvas.json` (`layout` keeps
  annotations; the task writes them). Then `layout` and `seed`, and an `ask/` telling you the seeded page
  is ready to publish.
- **propose**, one per screen: `budget: 45`, the design model, `after: task-01-directions` when there
  was one. The chosen direction by name, the captured artboard's path, the source files, the token file,
  the states to include as sibling artboards, the provenance block (source names the captured artboard
  and the files read; no viewport), and `fleet-canvas.mjs check` before `finish`. File these only after
  the pick when there was a directions task; the pick reaches the workers as a `fleet.sh broadcast` and
  the tasks name it.
- **assemble**, one, `after:` every propose task, `budget: 15`, Sonnet: `layout --launch proposed`,
  `check`, `seed`, and the `ask/` for the publish.

`queue-open` stays until the last propose task is filed. Delete it then.

## 4. Chips, watch, publish

Repo chips only, from `sh "$f" width`; no pane is opened for a redesign. The watch as `fleet-plan`
section 8. Publish exactly as `fleet-design` section 5 does, twice when there was a directions task: once
for the sketches, once for the proposals. Between the two, the operator picks; carry the pick into the
propose tasks and the broadcast, and never rename a direction.

Report: the canvas link, the proposals by screen with the states each carries, anything a proposal task
recorded as unreached, and the next step in one sentence - edit and save in the canvas, then
`/makarasty:fleet-plan "implement the Proposed artboards for <screens>"` plans the `kind: design` run
that turns the approved artboards into code, per `docs/DESIGN.md`, "Closing the loop".

## Done when

Every screen in scope has a proposal task with its direction and its states, the sketches were shown and
picked or deliberately skipped, the canvas is published, and the operator has the link and the sentence
about what comes after.
