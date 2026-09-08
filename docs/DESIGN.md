# Design: critique, canvas, redesign

The design half of this plugin. Three mission kinds and one loop, each with the same property the rest
of the plugin has: it measures before it trusts.

| step | kind | what comes out | gate |
|---|---|---|---|
| 1 | `critique` | findings about the running screens, ranked like any other run | a rectangle and a ratio, never a screenshot alone |
| 2 | `canvas` | the application's screens as artboards on disk, assembled into a Claude Design canvas | every artboard names the source files it came from and the frames it was measured under |
| 3 | `redesign` | proposed artboards beside the captured ones, on the same canvas | a proposal sits on a page next to the screen it replaces, states included |
| 4 | `design` | the approved artboards implemented in code, by the design model, end to end | numbers before and after from the same instrument; see `MISSIONS.md` |

Run them in that order or pick one. A critique is the cheapest first step on any application; a canvas is
what makes a redesign discussable; a redesign is what makes the fourth step a specification rather than a
mood.

The canvas is a file-based one: `<Screen>.dc.html` artboards plus a `canvas.json` in the project, seeded
into the editor that the harness's `design` skill carries, and published as an artifact page where the
operator clicks, drags, retypes and saves. The fleet produces the files; the editor is where a person
argues with them.

## The gate, in design terms

A screenshot is the most expensive read in this plugin and the least trustworthy one: measured across an
eight worker run, four workers took 120 screenshots for 207,000 image tokens, and a model shown any of
them and asked what is wrong will answer [M22]. So each design kind names what its evidence is instead:

- **Critique:** a probe result with a selector and a rectangle, or a computed value with a threshold. The
  screenshot confirms a candidate the probe returned; it never finds one.
- **Canvas:** a provenance block naming the source files, the route, and the viewport plus the frame
  count the screen was measured under. An artboard recreated from memory of an application is the design
  equivalent of a blind pane, and `fleet-canvas.mjs check` refuses it.
- **Redesign:** the current screen on the page beside the proposal, so what changed is visible without
  anyone's memory of the old one.

## Critique

Split by **screen**, one per task, pane lane. One `fleet-design-eye` spawn per task, the way a verify
task spawns one `fleet-scenario`. The agent carries the procedure; this section carries what the planner
puts in the task and what the worker does with what comes back.

### The instruments

Two probes, both in this plugin's `scripts/`, both pasted whole into `javascript_tool`, both returning
bounded JSON with a selector and a rectangle on every entry:

- `visual-probe.js` - text painted over text, clipped without an ellipsis, escaping its parent, off the
  right edge, or with no height. Described in `SWEEPS.md`, collision sweep.
- `design-probe.js` - the design defects: siblings off their row's edge (`misaligned`), gaps that do not
  repeat (`unevenGaps`), controls of two heights on one line (`unevenHeights`), values outside the page's
  own scale (`offScale`), text under the contrast floor (`lowContrast`), targets under 24 px
  (`smallTargets`), images at the wrong ratio (`stretchedImages`), boxes drawn around nothing
  (`ghostBoxes`), lines over 90 characters (`longLines`). It also returns `scale` - the spacing, sizes,
  families, weights, radii and colours the page actually uses, with counts - and `landmarks`, which the
  canvas kind reads.

Verified on a fixture carrying nine planted defects beside ten controls built to look like defects and
not be: nine found, zero of the ten reported, one candidate beyond the nine (a heading that is the page's
only 20 px text, which `offScale` is right to list and a reader is right to drop) [M29]. The fixture is
`scripts/fixtures/design-probe.html`; serve the repository over http and paste the probe to re-verify it
on a different browser.

**When the project publishes tokens, the probe compares against them.** The task names the token file
(`FLEET.md` carries it as `Design tokens: src/styles/tokens.css`), the worker reads the values into
`window.__fleetScale` before running, and off-scale becomes off-token. Without tokens the probe infers
the scale from the page and says so in `scale.source`; treat `offScale` as candidates then.

### What the probes cannot see

Wrong colours in harmony terms, optical misalignment inside a correctly sized box, paint order, and
whether a screen reads as one product or as parts stitched together. Those get a zoomed screenshot with
one named question each, in the agent's own context. "Look at this page and report visual defects" is
not a task shape; it is where invention lives.

A judgement finding - hierarchy, rhythm, consistency, copy - is admissible when it cites the number that
made the agent look: `distinctTypeCombos: 23`, `distinctTextColors: 14`, three buttons styled as primary
in one toolbar named by selector. The number is what lets the fix worker find the same thing.

### The task

```markdown
---
task-id: task-04-critique-cases
kind: critique
needs: pane
budget: 20
model: sonnet
verdict-model: opus
---
## Route in
/cases, signed in through the runbook.

## Screens
The Cases list, its filter bar open, and the row detail drawer.

## Tokens
src/styles/tokens.css - spacing, font sizes and radii go into window.__fleetScale.

## Correct looks like
Every control on the toolbar shares one height and one baseline. Body text meets 4.5:1. Every focusable
control paints a focus state. No value on a visible element sits outside the token scale.
```

The worker spawns `fleet-design-eye` with the plugin's `scripts/` directory, the `tabId`, the route, the
token file and the "correct looks like" lines, rules on what comes back, and files each finding through
`fleet.sh find`. Geometric findings carry `rects`; the gate refuses a pair that does not intersect, so the
convention is `a` = the subject and `b` = the box it is measured against: the item and its row, the text
and the panel behind it, the target and its parent.

Severity is the agent's, with the screen in front of it, on the table in its brief. Collection copies it.

**States are screens.** The 2026-09-01 design sweep found that every visual defect lived in a state nobody
designed - the skeleton, the transition, the empty list. So a critique task names the states it wants
looked at, and the worker files an `unreached` line for any it could not reach rather than reporting the
loaded screen and calling the screen clean.

When the `impeccable` skill is installed its detector is a third instrument, for the anti-patterns it
knows - overused fonts, gradient text, accent stripes, nested cards. Run it when present, file what it
finds through the same gate with the rule id as evidence, and never stop because it is absent.

### From a critique to a fix

`fleet.sh fixqueue` turns the backlog into tasks. A critique finding with `rects` or a `probe` field
becomes a `kind: design` task rather than `kind: fix`, because the rule in `MISSIONS.md` holds: the
design model owns the screen it repairs, and a cheaper model hand-patching a spacing token is how the
next critique finds the same screen wrong in a new place.

## Canvas

Recreate the application's screens as artboards on disk, then assemble them into one canvas the operator
can open, pan, and edit.

Split by **screen**, one artboard per task, and the tasks run in stages the queue enforces with `after:`,
never by anyone remembering the order:

| stage | task | lane | after | writes |
|---|---|---|---|---|
| recon | one per screen | pane | - | `.fleet/<run>/recon/<Screen>.json` |
| system | one, when the app has a shared component directory | repo | every recon | `System.dc.html` |
| screen | one per screen | repo | system, or its own recon | `<Screen>.dc.html` |
| compare | one per screen, optional | pane | its screen | findings |
| assemble | one | repo | every screen | `canvas.json`, `Main.dc.html`, the seeded page |

The planner publishes the seeded page. Workers never do; publishing is an artifact action in the
planner's session, and it follows the `design` skill's own publish step, which carries the runtime
version and the capability rule that move with the harness.

### Where the files live

`design/canvas/` at the project root, or the directory `FLEET.md` names on a `Canvas:` line. It is the
project's design file base: the artboards are the durable thing, the seeded `.html` is generated from them
and can be regenerated. Whether to commit either is the operator's decision; the plugin writes there and
never commits.

Isolation is `none`. A capture task reads source and writes exactly one new file no other task names, so
there is nothing to merge. It is the one kind that writes into the tree without a worktree, and the
reason is the one-file rule; a task that finds itself editing anything else has left its brief.

### Recon

A pane task per screen: sign in, navigate, `resize_window` to the canvas viewport (1440x900 unless
`FLEET.md` says otherwise on a `Canvas viewport:` line; a phone-first application says 390x844), reload,
gate, then run `design-probe.js` with the project's tokens applied and write its whole output plus the
gate reading to `.fleet/<run>/recon/<Screen>.json`. Reset the tab to `desktop`. Ten minutes, Sonnet, no
verdict pass.

The recon is the truth the screen task copies from: `root` and `scale` for the tokens as the browser
resolved them, `landmarks` for the header height, the sidebar width, the control heights, the table
row height, the fonts and colours at each. Source tells the worker what a screen is made of; recon tells
it what the pieces measure. A screen built from source alone is allowed, and `check` reports it as
unmeasured.

### The artboard

One file, `<Screen>.dc.html`, static - no `data-dc-script`, no `{{ holes }}`, no loops - because a
captured screen is a picture of one state, and a viewer retypes its text in place. Follow the `design`
skill's format rules; the ones that bite are these:

- The head line `<script src="./support.js"></script>` exactly once; the editor swaps it for its runtime.
- The design inside `<x-dc> ... </x-dc>`, styles in a `<helmet><style>` block inside it, with an `a` and
  `a:hover` colour defined.
- Inline `style="..."` on elements, because that is what the properties panel edits. Flex and grid with
  `gap`, never whitespace or per-element margins, because gap survives a drag-reorder and whitespace does
  not.
- The root element sized to the frame (`width: 1440px; height: 900px`) with its own background, and the
  same size in the provenance `frame:` line.
- Exact values from the source and the recon, never rounded to a grid: the app's 13 px is 13 px.
- Real copy from the screen. Never lorem ipsum; a value that varies per account is a realistic sample.
- Icons as inline SVG copied from the app's icon set, never emoji.
- The `System.dc.html` sheet, when there is one, is read and copied from, not imported: artboards share
  nothing at runtime, and a `<dc-import>` makes a worker's file depend on another worker's.

Every artboard carries the provenance block near the top of the file:

```html
<!-- fleet-canvas
source: src/pages/Cases.vue, src/components/CaseTable.vue
route: /cases
viewport: 1440x900 zoom 1
frames: 301
frame: 1440x900
recon: .fleet/2026-09-03-canvas/recon/Cases.json
-->
```

Write it by hand, or with `node scripts/fleet-canvas.mjs stamp <file> --source ... --route ...`. On
Windows Git Bash rewrites a `/cases` argument into a path under its own install; run `stamp` with
`MSYS_NO_PATHCONV=1` or write the block yourself.

Then, before `finish`: `node scripts/fleet-canvas.mjs check <file>`. It refuses a missing support line,
a missing `<x-dc>`, holes with no logic, a source file that does not exist, a viewport with no frame
count, and a frame count under the gate. A refused artboard is a task not finished.

### Compare

Optional, and what turns a sketch into a specification. A pane task per screen, after its screen task:
`node scripts/fleet-canvas.mjs plain <artboard> --out <artboard>.plain.html` writes a standalone page
from a static artboard; serve it from the project over http (most dev servers serve any file under the
project root; Vite does), open it in the pane at the canvas viewport, gate, run `design-probe.js`, and
compare its `landmarks` with the recon's by role. A landmark whose rectangle differs by more than 2 px in
any dimension is a `minor` finding against the artboard; more than 8 px, or a landmark missing, is
`major`. Evidence is the two rectangles and the two selectors. The artboard is still assembled - the
findings say where it lies.

Skip it when the canvas is wanted as a sketch to argue over rather than a record. Say which in the plan.

### Assemble

One repo task, after every screen task:

```bash
node scripts/fleet-canvas.mjs layout design/canvas --title "Acme"     # canvas.json, and a cover Main.dc.html when there is none
node scripts/fleet-canvas.mjs check  design/canvas                          # the gate, over every artboard
node scripts/fleet-canvas.mjs seed   design/canvas --title "Acme screens" --out design/acme-screens.html
```

`layout` places artboards in rows with the gaps the editor needs, keeps every position it finds in an
existing `canvas.json` so the operator's hand-moved frames stay where they were, puts captured screens on
a `Current` page, proposals on `Proposed`, direction sketches on `Directions`, the primitives sheet on
`System`, and opens the canvas on the page with the newest work. `seed` re-runs the layout, runs the
gate, then drives the `design` skill's helper and its own check.

The helper lives under the harness's temp directory only after the `design` skill has run once on the
machine. `seed` says so when it cannot find it; the worker files an `ask/` and the planner invokes
`/design` once in its own chat and re-runs `seed` itself.

The title and the file name are content: what the operator would call the design, never the tool. The
helper refuses generic names.

## Redesign

Propose new artboards beside the captured ones. Same file base, same page mechanics, one difference in
who does the work: the design model owns every proposal end to end, per `MISSIONS.md`.

**Settle the direction with the operator, not for them.** When the plan carries no aesthetic, no
references and no constraints, the first task is `directions`: two to four low-fidelity artboards
`DirectionA.dc.html` to `DirectionD.dc.html` on the `Directions` page, each exploring an axis the task
can name - warm editorial against dense data-first, not four shades of one look - each with its
motivation and its main trade-off in a sticky note beside it. The planner publishes, the operator picks,
in the canvas or in the planner's chat, and the planner then files the proposal tasks with the chosen
direction in each. The queue stays open across the pick. Once a direction has a name it keeps it; never
renumber the sketches.

When the operator gave a direction, skip the sketches and say so.

**A proposal is `<Screen>.Proposed.dc.html`** on the `Proposed` page, positioned by `layout` beside the
captured screen's page. It keeps the product truth - content, function, the things the screen has to let
a person do - and treats the current look as evidence and anti-reference. The captured artboard is what
it is measured against, which is why a redesign runs on a canvas that already holds the capture; a
project without one gets `fleet-design` first, quietly.

**States are part of the proposal, not an afterthought.** A screen proposal carries its loading and its
empty state as sibling artboards, `<Screen>.Proposed.Loading.dc.html` and
`<Screen>.Proposed.Empty.dc.html`, on the same page. The 2026-09-01 sweep is the reason: every visual
defect it found lived in a state the design model had never held.

Provenance still applies: `source:` names the captured artboard and the source files read, `route:` the
screen, no `viewport:` because nothing was measured. `check` reports a proposal as unmeasured, which is
correct.

The honest line from `MISSIONS.md` holds here too, reversed: a proposal can satisfy every constraint and
still be wrong for this product, because taste is the design model's judgement and the operator's call.
The canvas is where that argument happens, and the fleet's job ends at putting the pieces on it.

## Closing the loop: from an approved artboard to code

An artboard the operator has edited and saved is a specification. Read it back with the `design`
skill's `--extract` (the canvas that lives on the artifact is the truth once someone has saved in it, not
the working files), and plan a `kind: design` mission in which each screen task carries its artboard's
path.

The design worker then has numbers to hit: `fleet-canvas.mjs plain` renders the approved artboard,
`design-probe.js` on that render gives landmark rectangles, and the same probe on the implemented screen
gives the rectangles to compare. Done when the landmarks agree within the compare tolerance and the
screen's own probe run is clean, with the caveat `MISSIONS.md` demands stated in the finding: it can meet
every number and still not be the design.

## What this costs

A critique task is one browser spawn per screen, so it sits where a verify task sits: about 23 minutes
median, roughly twenty of them the spawn. A recon task is one probe and no spawn, ten minutes. A screen
task is repo lane and pays no pane at all; its cost is the source it reads and the artboard it writes,
which passes through the model once as output. A proposal task is the top tier for the whole task, by
design, and it is the one place in this plugin where that is the cheap choice: a proposal from a weaker
model is a redesign the operator has to redesign.
