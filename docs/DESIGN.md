# Design: critique and implementation

The design half of this plugin: two mission kinds, each of which measures before it trusts, like the
rest of the plugin.

| step | kind | what comes out | gate |
|---|---|---|---|
| 1 | `critique` | findings about the running screens, ranked like any other run | a rectangle and a ratio, never a screenshot alone |
| 2 | `design` | a design that came from elsewhere implemented in code, by the design model, end to end | numbers before and after from the same instrument; see `MISSIONS.md` |

Run them in that order or pick one. A critique is the cheapest first step on any application.

## The gate, in design terms

A screenshot is the most expensive read in this plugin and the least trustworthy one: across an eight
worker run, four workers took 120 screenshots for 207,000 image tokens, and a model shown any of them and
asked what is wrong will answer [M22]. So each design kind names its own evidence:

- **Critique:** a probe result with a selector and a rectangle, or a computed value with a threshold. The
  screenshot confirms a candidate the probe returned; it never finds one.
- **Design:** numbers before and after from the same instrument.

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
  families, weights, radii and colours the page actually uses, with counts - and `landmarks`, the structural
  elements with their rectangles.

Checked on a fixture carrying nine planted defects beside ten controls built to look like defects and
not be: nine found, none of the ten reported, and one candidate beyond the nine (a heading that is the
page's only 20 px text, which `offScale` is right to list and a reader is right to drop) [M29]. The fixture is
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
not a task shape; it invites invention.

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
model: fable            # passed to fleet-design-eye, whose verdict is final: no verdict-model
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

**States are screens.** In the 2026-09-01 design sweep every visual defect lived in a state nobody
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

## Mockup rounds

A mockup subject is rarely settled in one round: the operator reacts, the next round answers. What
gets lost between rounds is their own words. In session 513940ca the round-2 task paraphrased "одну линию"
away and the worker drew two bars; the operator wrote "я просил объединить в один бар" [M59].

- **One requirements file per subject**, `reports/<subject>.req.md`: the original task items, then every operator
  message on the subject **verbatim** (never summarised, translated or merged), each with its timestamp,
  numbered R1..Rn in the order they came. Only `fleet.sh req-add <run> <subject> [must|nice] [supersedes Rn]` writes
  it (the words on stdin): the coordinator calls it for every operator message on the subject and for every
  `AskUserQuestion` answer about it, before the next round is filed. `supersedes Rn` keeps Rn in the file and marks
  it `DROPPED by Rm`; a message that contradicts an earlier one with no `supersedes` goes to the operator, not into
  the file as a guess.
- **Each round's task embeds the whole file at the top**, above the instructions: the worker reads the operator's
  words, not the planner's account of them. A dropped Rn is not a requirement.
- **The worker returns a table, variant x Rn -> met / not met / why**: one row per variant, one column per
  requirement, before any picture is judged. The worker's own met column is a claim: a separate reviewer
  (`fleet-design-eye`) re-grades the table against the screenshots, and the re-graded table is the one shown.
- **At most three variants per round.** A variant that misses a must-have is not shown: it goes back to the
  worker, or is dropped and said so.
- **The question to the operator shows the table** with the variants, so a miss is seen before one is chosen.

## Implementing a design that came from elsewhere

A design the operator brings (a mockup, an exported page, a screenshot they approved) is a specification.
Plan a `kind: design` mission in which each screen task carries the design's path.

The design worker then has numbers to hit: `design-probe.js` on the implemented screen gives landmark
rectangles to compare with the ones the design states. Done when they agree and the screen's own probe
run is clean, with the caveat `MISSIONS.md` demands stated in the finding: it can meet every number and
still not be the design.

## antislop rules for UI work

`/makarasty-tools:antislop on` adds a pinned copy of its rule set to any chat that builds UI: the filter
part (no invented numbers, no emoji or sparkle decoration, states, focus, contrast) and a short PASS/FAIL gate.
It filters; direction still comes from the project's own design file or the brief. On two briefs it removed
every counted tell at 1.3 times the cost of no rules, once its pointer stopped loading every rule file
[M47].

## What this costs

A critique task is one browser spawn per screen, so it sits where a verify task sits: about 23 minutes
median, roughly twenty of them the spawn.
