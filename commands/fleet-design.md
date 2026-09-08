---
description: Plan a canvas run - capture the application's screens as artboards on disk and assemble them into a Claude Design canvas the operator can open and edit. One worker per screen; offers a chip per worker and publishes the canvas when they land.
argument-hint: <screens or area in plain words> [fast]
disable-model-invocation: true
---

The reference files named below (`docs/DESIGN.md` and its siblings) live in this plugin's own directory,
not in the project you are working on. Resolve that directory once, before following any pointer:

```bash
ls -dt ~/.claude/plugins/cache/*/makarasty/*/docs 2>/dev/null | head -1
```

Empty output means the plugin is running from a checkout instead of an install: look for `docs/` beside
the `commands/` directory holding this file.

## Missing prerequisites are work, not a refusal

No `FLEET.md`, no login runbook, no `.fleet/`: say what is missing in one line, run
`/makarasty:fleet-init` to produce it, and continue. A missing canvas directory gets created. Stop for
exactly two things: a credential only the operator can provide, and a reserved control.

## What this is

`fleet-plan` with the kind, the axis and the stages fixed. The mission is `kind: canvas`: recreate the
screens in `$ARGUMENTS` as `<Screen>.dc.html` artboards under the project's canvas directory, from source
and from measurement, then assemble and publish one canvas. Read `docs/DESIGN.md`, section "Canvas", for
what each stage produces; read `docs/PULL.md` for the queue. Everything not said here - the interview
discipline, the chip prompts, the watch - is `fleet-plan`'s, sections 2b, 7 and 8, and you follow it.

You write the queue and publish the result. You do not write an artboard.

## 1. Ground yourself

Read `FLEET.md`: origin, login runbook, the `Canvas:` directory (default `design/canvas`), the `Canvas
viewport:` line (default 1440x900), the `Design tokens:` file if any. Then the screen list, from the
router and the navigation labels, never from memory: a task that names a screen the project does not
call that produces an artboard nobody can match to a route. Take the user-facing names `FLEET.md` says
to use.

Note whether the application has a shared component directory. If it does, the run gets a `system`
stage; if every screen styles itself, it does not.

## 2. Draft the plan, then one round

Hold a complete draft from the first exchange: run id `<date>-canvas[-<slug>]`, the enumerated screen
list with each screen's route and the source files behind it, the viewport, the canvas title (what the
operator would call it - the application's name - never the tool or the format), whether the `compare`
stage runs, and whether `propose` is in scope now. Then ask one round, numbered, each with your
recommended answer, so "all yours" loses nothing:

```
Q1 - Screens: eleven, listed above, from mainNav and router meta.title. Correct the list rather than
     answering a question about it.
     -> Recommend all eleven; the primitives sheet is one more task and worth it at this size.
Q2 - Viewport: 1440x900, the desktop frame the design skill uses. The app has no phone layout.
     -> Recommend 1440x900.
Q3 - Compare: a pane task per screen that measures the artboard against the screen and files where it
     lies. Roughly doubles the pane minutes.
     -> Recommend yes: a canvas the next redesign will be measured against should be one that was measured.
Q4 - Title: "Acme".
Q5 - Proposals: not in this run. `/makarasty:fleet-redesign` runs over this canvas once you have seen it.
```

`fast` in the arguments means take the draft as answered. A round that changes nothing ends the
interview, as in `fleet-plan`.

## 3. Write the queue

Pull mode, under `.fleet/<run-id>/tasks/ready/`, stages gated with `after:` exactly as `docs/DESIGN.md`
lays them out. Every task carries `kind: canvas`, its lane, a budget from the table there, and the model
from `docs/MODELS.md`:

- **recon**, one per screen, `needs: pane`, `budget: 10`, `model: sonnet`. Route in, the viewport, the
  token file, and the path to write: `.fleet/<run-id>/recon/<Screen>.json`. Steps name the probe,
  `scripts/design-probe.js`, and the gate reading that has to be recorded beside it.
- **system**, one, only when the app has a shared component directory: `needs: repo`, `after:` every
  recon task, `budget: 40`, the design model. Writes `System.dc.html`: the primitives as they exist -
  button variants, inputs, the table header and row, the nav item, the card - from source at the recon
  numbers.
- **screen**, one per screen, `needs: repo`, `after:` the system task or, without one, the screen's own
  recon, `budget: 35`, the strong general model. The source files by path, the recon file, the artboard
  path, the provenance block to write, and `fleet-canvas.mjs check` before `finish`. Say in the task that
  it writes exactly one file and edits nothing.
- **compare**, one per screen when Q3 said yes: `needs: pane`, `after:` its screen task, `budget: 12`,
  `model: sonnet`. The plain render, how to serve it, the tolerance, the finding shape.
- **assemble**, one, `needs: repo`, `after:` every screen task, `budget: 15`, `model: sonnet`. The
  three `fleet-canvas.mjs` calls with the title and the output path, and the instruction to file an
  `ask/` if `seed` cannot find the design skill's helper.

Order the files longest budget first within a stage. Touch `tasks/queue-open` before offering a chip and
delete it once every task is filed - here that is immediately, because a canvas run's queue is known in
full from the screen list. Use the `after:` gates, not the order, for the stages: `fleet.sh next` holds a
gated task and tells the worker `QUEUE WAITING`, so a repo worker that starts before recon lands polls
instead of finishing.

## 4. Offer the chips

Two pane chips, `lane pane` - the recon stage is ten minutes a screen and the compare stage is twelve,
so two panes drain either in a wave. Repo chips from `sh "$f" width .fleet/<run-id>`, `lane repo`. Chip
titles and prompts exactly as `fleet-plan` section 7 gives them, worker identity and lane in the prompt.

Say the stage arithmetic out loud: repo workers will sit on `QUEUE WAITING` until the pane workers have
recon'd their screens, which is a few minutes, and the operator should open the pane chips first.

## 5. Arm the watch, and publish when it lands

Invoke `/makarasty:fleet-wait <run-id> <count>` yourself. When the run lands, `/makarasty:fleet-collect`
as usual: a canvas run's findings are the compare deltas and anything a screen worker noticed while
reading source against the screen.

Then the step no worker can do. Read the seeded page's path from the assemble worker's notes and
**publish it with the Artifact tool by following the `design` skill's publish step**: load that skill
with the `Skill` tool and do what its step 4 says, with the seeded file as `file_path`. The skill carries
the runtime version pin and the capability rule; both move with the harness and neither is written down
here or in any brief. If the assemble worker filed an `ask/` because the helper was not on the machine,
invoke `/design` once in this chat - that extracts it - answer the ask, and re-run
`node scripts/fleet-canvas.mjs seed` yourself.

Report, in this order: the canvas link, the artboards by page, the screens `check` reported as
unmeasured, the compare findings by severity, and the one line about ownership: the canvas directory is
the project's to commit or not, and the seeded page regenerates from it.

## Done when

Every screen in the corrected list has a task, the stages are gated by `after:` and not by prose, the
chips are offered by lane, the watch is armed, and - once the run lands - the canvas is published and the
operator has its link.
