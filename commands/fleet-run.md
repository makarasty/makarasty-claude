---
description: Execute one fleet brief in this session — gate the pane, log in, run the scenario, write findings
argument-hint: <path to brief file>
disable-model-invocation: true
---

You are one tester in a fan-out of independent sessions. Your whole job is the brief at `$ARGUMENTS`.
Read it first, including its frontmatter. If the path is missing or empty, stop and say so — do not invent
a scenario.

You report by writing files. You never message another session, and none will message you.

## 1. Open the pane

`preview_start` at the origin the project's login runbook gives. Keep the `tabId`.

Do not start a dev server; confirm what is already listening and stop if something required is absent.
Those processes belong to the operator.

## 2. Gate — before anything else

A pane that is not displayed does not composite. It still loads pages and still returns plausible DOM, so
a blind session cannot tell it is blind; it reports fiction confidently. Measure:

```js
new Promise(res => { let f = 0; requestAnimationFrame(function t(){ f++; requestAnimationFrame(t); }); setTimeout(() => res(f), 1000); })
```

- 60 or more: live, continue.
- `0`: **do not log in, do not navigate, do not assert anything.** `AskUserQuestion` asking the operator to
  display this session's Browser pane, then re-measure when they answer. The reading is the proof, not
  their reply.

Re-run the gate before each batch of visual work. If the pane is collapsed mid-run you go blind silently
and everything after that point is worthless. Full symptom list:
`${CLAUDE_PLUGIN_ROOT}/docs/BROWSER.md`.

## 3. Log in

Run `/makarasty:fleet-login`, or follow the project's runbook directly. Probe first — the pane usually
keeps a persistent profile and you may already be authenticated.

## 4. Run the scenario through a subagent

Spawn ONE subagent for the whole scenario, using the `model:` from the brief's frontmatter. Not one per
step: a spawn costs roughly 40k tokens in fixed startup regardless of the work it does, so many small
delegations are strictly worse than doing it inline.

Use the `fleet-scenario` agent, or write an equivalent brief containing all of:

1. The full step list with per-step assertions, quoted from the brief. **Do not compress the assertions.**
   Prompts to models may drop articles and filler; they may never drop a negation, a number, or a unit.
2. That `mcp__Claude_Browser__*` tools are deferred for it and must be loaded first with `ToolSearch`,
   query `select:mcp__Claude_Browser__javascript_tool,mcp__Claude_Browser__computer`. Without this line it
   reports having no browser tools and stops.
3. The `tabId`, and not to open a second pane.
4. A bounded output contract: a small JSON array of findings and nothing else. Explicitly forbid pasting
   DOM dumps, accessibility trees or page text into its final message — that is the entire point of
   delegating.
5. `read_page` is banned. State reads go through `javascript_tool` returning a small JSON string.
   Screenshots are for judging pixels and stay in the subagent's context.
6. Read-only posture. Other sessions test the same account concurrently; archiving, deleting or bulk
   editing shared records corrupts their runs as well as yours.

If the brief sets `verdict-model`, you rule on the returned observations yourself rather than trusting the
executor's severities. Observation and verdict are different jobs; the brief separates them on purpose.

## 5. Write the findings

Append-only JSONL, one finding per line, at `.fleet/<run-id>/<chip-id>.jsonl`:

```json
{"area":"", "severity":"blocker|major|minor|polish", "what":"", "repro":"", "evidence":""}
```

`evidence` is mandatory: a `file:line` reference, or an expression that reproduces the observation. A
finding without evidence is not a finding — drop it rather than writing it. "Looks off" wastes the time of
whoever fixes this.

Finish by writing an empty `.fleet/<run-id>/<chip-id>.done`. Separate file on purpose: the presence of the
JSONL says nothing about whether you were still writing it. The parent treats your run as complete the
moment `.done` appears, so write it last.

If the gate never came up live, write `.fleet/<run-id>/<chip-id>.blocked` containing one line saying the
pane was never displayed — **and no findings at all**.

## Report

At most five lines: findings by severity, and anything in the brief you could not reach. No summary of the
app, no suggestions outside the brief.
