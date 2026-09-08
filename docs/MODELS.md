# Which model runs which stage

Every claim here that is a measurement says so and gives the number. Everything else is a judgement call,
and says that too.

## The roster

| Model | Fits |
|---|---|
| Opus | Judgement. Deciding whether an observation is a defect, ranking severity, writing a brief another model will execute without supervision. |
| Sonnet | Execution carrying judgement. Walking a scenario, noticing that something is wrong rather than merely different, following a spec that has gaps in it. |
| Haiku | Mechanical work under an exact contract. Fetching a value, running a fixed probe, reformatting, counting. |
| The design model | Proposing how a screen should look, writing markup and copy meant to be seen, ruling on taste. The top tier the account offers - `fable` where it exists, otherwise Opus - and nothing cheaper touches the result afterwards: `MISSIONS.md`, design. |

## The delegation measurement

A Haiku subagent driving a live Browser pane, 2026-08-24: **45,775 tokens for 3 tool calls**, 16 seconds,
4 lines returned to the parent. Nearly all of that is fixed startup, being the system prompt plus the tool
schemas it had to fetch. It ran the mechanics correctly.

Two conclusions that point in different directions:

- **On context, delegation always wins.** A screenshot plus an accessibility tree can be tens of thousands
  of tokens that sit in the parent's context for the rest of the session. Delegated, roughly 80 come back.
  Parent context is the scarce resource, and it does not refill.
- **On cost, delegation wins only across a long burst,** because of the fixed overhead per spawn. A single
  probe is cheaper inline. Give a subagent a whole scenario, fifteen steps returning ten lines, rather than
  one step at a time.

What that measurement does not show: that Haiku can judge an interface. It ran a fixed probe and described
a login screen. Read it as evidence about mechanics alone.

Measured again on a real scenario rather than a probe, 2026-08-26: a Sonnet `fleet-scenario` executor
walking two screens spent **57,103 tokens over 33 tool calls in 219 seconds**, and returned roughly **750
tokens** to the parent. That is **1.3 percent**, and it is the case the fixed overhead was always waiting
for. The screenshots, DOM reads and settle polling stayed in the subagent.

Confirmed at scale, 2026-08-26: executor return ratios across eight workers ran 0.96 to 2.04 percent,
bracketing that reference. The ratio is stable and it is not the lever. **The denominator varies by an
order of magnitude**: the cheapest executor made 30 tool calls, took no screenshots and read 4.0 M cached
tokens; the most expensive made 194, took 51 screenshots and read 55.6 M. Both returned about the same
number of lines. What a run costs is decided by how much the executor looked at, never by how much it
said.

The same run read 311 M cached tokens against 8.31 M non-cached, a ratio of 37 to 1, so most of what a
fleet moves is cache rather than new context.

The parent then spent six inline probes ruling on what came back, which was cheaper than a second spawn.
That is the rule stated from the other side: one probe inline beats a spawn, one scenario delegated beats
running it inline.

## How a stage picks its model

The brief carries the choice, in `model:` and `verdict-model:`. A single brief splitting the two is normal:
one model walks the scenario, another rules on what the walk produced.

Guidance:

- **Dense state, unfamiliar domain, or a subtle correctness question**: Opus walks it. Weaker models do not
  fail loudly here. They fail by not noticing, and silence looks like a pass.
- **Clear spec, obvious pass or fail**: Sonnet walks it, Opus rules on the findings.
- **Fixed probe, extraction, counting, reformatting**: Haiku under an exact output contract.
- **A screen that has to look right, or a proposal for how it should**: the design model, end to end, and
  it is the one place where the top tier is the cheap choice - a proposal from a weaker model is a redesign
  the operator has to redesign. Capturing a screen from source is not that job; the strong general model
  copies exact values well. Reviewing a screen for design defects is a Sonnet walk with an Opus verdict,
  because the probes carry the judgement the walk would otherwise need.
- **A page somebody will read aloud to a vendor**: the design model for the page, for the copy reason above;
  Opus for the facts behind it, because "every number about this topic" is not a clear spec and a weaker
  model finishes it early and quietly. `CALL.md` has the stages.
- **Uncertain**: go one tier up. A missed defect costs a release and a tier costs cents.

## Reasoning effort

Per call effort is not settable through the `Agent` tool. Its parameters are `model`, `subagent_type`,
`isolation`, `run_in_background`, and the prompt. Effort is settable per agent inside a `Workflow` script,
and session wide by the operator.

So treat effort as a session level dial rather than a per stage one, unless a stage is worth building a
Workflow around. A brief that claims per subagent effort control is describing a knob that does not exist.

## Cost discipline that is not about models

Most waste is not the tier. In order of size:

1. **Raw page data in the parent's context.** One full accessibility tree on a dense list is a large,
   permanent cost. Return small JSON from a targeted expression, and let subagents hold the bulky reads.
2. **Many small spawns instead of one large one.** Fixed overhead each, measured above.
3. **Round trips.** Independent tool calls issued one per message cost a full model turn each. Send them
   in one message.
4. **Unscoped verification.** In a large repository a full test suite and a full typecheck dwarf every
   token decision on this page. Scope during the work, sweep once at the end.

## Writing for the models you dispatch

A prompt sent to a subagent is read by a model, not a person. Compress it: drop articles, filler and
pleasantries, keep every technical term, number, unit and negation exact. The `caveman` plugin shapes
what this session says, not what it dispatches, so the discipline is applied by hand in the brief. Expect
little from it in tokens: M24 puts output at 0.3% of what a run moves. The `ponytail` plugin, where
installed, injects its code-volume ladder into every subagent through `SubagentStart`, which is the one
plugin that reaches the workers a fleet spawns.

Keep the part of a brief that states what correct looks like at full length. A dropped negation in an
assertion turns a passing screen into a defect report, and no token saving covers the hour spent chasing
it.
