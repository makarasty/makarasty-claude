# makarasty

Claude Code plugin for running several agent sessions against a **live application** instead of against
their own assumptions.

The problem it solves is narrow and specific: an agent driving a browser it cannot actually see will
report findings with complete confidence, and those findings look exactly like real ones. Every command
here is built around measuring first and trusting second.

## Install

```
/plugin marketplace add makarasty/makarasty-claude
/plugin install makarasty@makarasty
```

## Commands

| Command | Who can call it | What it does |
|---|---|---|
| `/makarasty:fleet-login` | Claude or you | Opens the pane, proves it composites, signs in via the project's own runbook, asserts identity |
| `/makarasty:fleet-plan <area> [n]` | **you only** | Splits an area into independent briefs, one per screen owner, and offers one chip per brief |
| `/makarasty:fleet-run <brief>` | **you only** | Runs one brief: gate, login, whole scenario through one subagent, findings to JSONL |
| `/makarasty:fleet-wait <run-id> [n]` | Claude or you | Waits on the run without spending model turns polling |
| `/makarasty:fleet-collect <run-id>` | Claude or you | Merges, enforces the evidence contract, dedupes, ranks |

`fleet-plan` and `fleet-run` are marked `disable-model-invocation` — they spawn paid work and need a human
to click chips, so Claude cannot decide to start them on its own.

## Agents

- **`fleet-scenario`** — walks a scenario in the parent session's pane and returns bounded JSON. The
  screenshots and DOM reads stay in its context; roughly eighty tokens come back to the parent.
- **`fleet-triage`** — mechanical merge and rank of a run's findings, on Haiku.

## The gate

A Browser pane that is not displayed on screen does not composite frames. It still navigates, still loads
pages, still returns plausible DOM — and every visual observation made through it is false:

| Symptom | Reality |
|---|---|
| screenshot times out after 5s | pane not displayed |
| `requestAnimationFrame` never fires | nothing is scheduled without compositing |
| transitions frozen at their start value | `transitionend` never fires |
| virtualized rows read as empty text | they need layout that never runs |
| in-page requests hang to their timeout | measured: an axios POST sat 180s while `curl` answered in 4s |

So every command measures before trusting:

```js
new Promise(res => { let f = 0; requestAnimationFrame(function t(){ f++; requestAnimationFrame(t); }); setTimeout(() => res(f), 1000); })
```

`0` means blind. The tester stops and asks rather than guessing, and re-measures when you answer — because
the reading is the proof, not your reply. A blind tester writes `.blocked` and **no findings at all**, and
`fleet-collect` reports blocked chips separately. A run that says "clean" while a third of it was blind is
worse than no run.

Two concurrent live panes are measured working, in different sessions, with the second chat unfocused and
greyed out — the gate is the pane being displayed, not chat focus. Three or more is untested.

Details: [`docs/BROWSER.md`](docs/BROWSER.md). Measuring performance from inside a fleet: [`docs/PERF.md`](docs/PERF.md).

## Models

Set per brief, not by default:

```yaml
model: sonnet          # walks the scenario
verdict-model: opus    # decides which observations are defects
```

Measured, 2026-08-24: a Haiku subagent driving a live pane cost **45,775 tokens for 3 tool calls** and
returned 4 lines. Nearly all of that is fixed startup. Two conclusions that point in different directions:
delegation always wins on parent context, and only wins on cost across a long burst. So one subagent per
scenario — never one per step.

That measurement shows Haiku can run mechanics correctly. It shows nothing about judging a UI. Details and
the full selection guidance: [`docs/MODELS.md`](docs/MODELS.md).

## What it deliberately does not do

- **No hardcoded project details.** Origins, ports and the login recipe live in the repo being tested,
  conventionally `docs/HOW_TO_LOGIN_AS_AI.md`. Missing that file, `fleet-login` stops and says so instead
  of improvising against a login form.
- **No session-to-session messaging in the happy path.** Session handles are opaque, unstable between
  calls, and reach other accounts on the same machine — a message aimed by handle once landed in an
  unrelated account's release-prep chat. Files have addresses; sessions do not. Chips are fire-and-forget.
- **No review command.** [`caveman`](https://github.com/JuliusBrussee/caveman)'s `cavecrew-reviewer`
  already does terse diff review well. This plugin has a soft dependency on caveman: it uses it when
  installed and works without it.

## Licence

MIT.
