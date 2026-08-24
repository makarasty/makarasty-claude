# Which model runs which stage

This page travels with the plugin because the commands depend on it. Anything here that is a measurement
says so and gives the number; anything that is a judgement call says that too.

## The roster

| Model | Where it fits |
|---|---|
| Opus | Judgement. Deciding whether an observation is a defect, ranking severity, writing a brief that another model will execute blind. |
| Sonnet | Execution with judgement in it. Walking a scenario, noticing that something is wrong rather than merely different, following a spec with gaps in it. |
| Haiku | Mechanical work with an exact contract. Fetching a value, running a fixed probe, reformatting, counting. Measured working for browser tool calls; unmeasured for anything requiring taste. |

## The measurement behind the delegation rule

A Haiku subagent driving a live Browser pane, 2026-08-24: **45,775 tokens for 3 tool calls**, 16 seconds,
4 lines returned to the parent. Almost all of that is fixed startup — system prompt plus the tool schemas
it had to fetch. It handled the mechanics correctly.

Two conclusions, and they point in different directions:

- **On context, delegation always wins.** A screenshot plus an accessibility tree can be tens of thousands
  of tokens that sit in the parent's context for the rest of the session. Delegated, roughly 80 come back.
  Parent context is the scarce resource and it does not refill.
- **On cost, delegation only wins on a long burst,** because of the ~40k fixed overhead per spawn. One
  probe is cheaper done inline. Hand a subagent a WHOLE scenario — "walk these 15 steps, return 10 lines"
  — never one step at a time.

What that measurement does NOT show: that Haiku can judge a UI. It ran a fixed probe and described a login
screen. Do not read it as evidence for putting Haiku on anything that requires deciding what is wrong.

## How a stage picks its model

The brief carries the choice. Every brief has a `model:` field, and the command that spawns work reads it
rather than defaulting. Split within a single brief is normal and encouraged:

```yaml
model: sonnet        # walks the scenario
verdict-model: opus  # decides which observations are defects
```

Guidance, not law:

- **Screen with dense state, unfamiliar domain, or a subtle correctness question** — Opus walks it. Weak
  models do not fail loudly here; they fail by not noticing.
- **Screen with a clear spec and obvious pass/fail** — Sonnet walks it, Opus rules on the findings.
- **Fixed probe, extraction, counting, reformatting** — Haiku, with an exact output contract.
- **When unsure, go one tier up.** A missed defect costs a release; a tier of model costs cents.

## Reasoning effort

Per-call reasoning effort is **not** settable through the `Agent` tool — its parameters are `model`,
`subagent_type`, `isolation`, `run_in_background`, and the prompt. Effort is settable per agent inside a
`Workflow` script (`agent(prompt, {effort: 'low'|'medium'|'high'|'xhigh'|'max'})`), and session-wide by
the operator.

So the honest position: **treat effort as a session-level dial, not a per-stage one**, unless the stage is
worth building a Workflow around. Claiming per-subagent effort control in a brief would be writing a knob
that does not exist.

## Cost discipline that is not about models

Most waste is not the model tier. In order of size:

1. **Raw page data in the parent's context.** One `read_page` on a dense list is a large, permanent cost.
   Use `javascript_tool` returning a small JSON string, and let subagents hold the bulky reads.
2. **Many small spawns instead of one big one.** ~40k each, measured.
3. **Round-trips.** Independent tool calls issued one per message cost a full model turn each. Batch them
   into one message.
4. **Unscoped verification.** In a large repo a full test suite and a full typecheck dwarf every token
   decision on this page. Scope them; run the full sweep once, at the end.

## Compression of agent-facing text

Prompts sent to subagents are read by a model, not a person. Write them compressed: drop articles, filler
and pleasantries, keep every technical term, number and negation exact. `caveman` does this well if it is
installed; if not, apply the same discipline by hand.

Never compress the part of a brief that states what "correct" looks like. A dropped "not" in an assertion
turns a passing screen into a defect report, and the tokens saved are not worth the hour spent chasing it.
