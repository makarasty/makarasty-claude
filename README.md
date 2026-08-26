# makarasty

A Claude Code plugin for running one mission across several sessions at once.

Each worker session holds its own context, drives its own browser, works one brief, and reports by writing
a file. Nothing messages anything, so a worker that dies leaves its findings behind and a worker that
finishes needs nobody's attention.

The problem it exists for is narrow. An agent driving a browser it cannot actually see reports findings
with complete confidence, and those findings are indistinguishable from real ones. Every path through this
plugin measures before it trusts.

## Install

```
/plugin marketplace add makarasty/makarasty-claude
/plugin install makarasty@makarasty
```

Restart Claude Code afterwards. Plugins load at session start.

## Commands

| Command | Who reaches it | What it does |
|---|---|---|
| `/makarasty:fleet` | you | Names the other commands and when to use each |
| `/makarasty:fleet-plan <mission> [n]` | you | Splits a mission into briefs and offers one worker chip per brief |
| `/makarasty:fleet-run <brief>` | you | Runs one brief inside a worker session |
| `/makarasty:fleet-login` | you or Claude | Opens and authenticates the project's local app |
| `/makarasty:fleet-wait <run-id> [n]` | you or Claude | Waits on a run without spending model turns |
| `/makarasty:fleet-collect <run-id>` | you or Claude | Merges, enforces the evidence contract, dedupes, ranks |

`fleet`, `fleet-plan` and `fleet-run` carry `disable-model-invocation`. They spawn paid work and depend on
your clicks, so no agent starts them on its own initiative, and they cost nothing in context until you
type them. The other three keep descriptions so an agent mid task can reach them.

## Agents

- **`fleet-scenario`** walks a multi step browser scenario and returns bounded JSON. The screenshots and
  DOM reads stay in its context; roughly eighty tokens come back to the parent.
- **`fleet-profiler`** measures load, interaction and stability, and returns readings with their spread and
  the machine load beside them.
- **`fleet-triage`** merges and ranks a run's findings, on Haiku.

## Mission kinds

A fleet is not only for testing. The brief declares its `kind`, which decides the working style and, more
importantly, the axis the mission splits along.

| Kind | Splits by | Isolation |
|---|---|---|
| `verify` | screen ownership | none |
| `investigate` | hypothesis | worktree when instrumenting |
| `implement` | seam | worktree |
| `fix` | file cluster | worktree |
| `research` | source | none |

Splitting along the wrong axis is what makes a fleet run worthless. Two workers on one slice cost twice
and then agree with each other, which reads as corroboration and is not. Details in
[`docs/MISSIONS.md`](docs/MISSIONS.md).

## The gate

A browser pane that is not displayed on screen stops compositing. It still navigates, still loads pages,
still returns plausible DOM, and every visual observation made through it is false:

| Symptom | Cause |
|---|---|
| screenshot times out after 5s | pane not displayed |
| `requestAnimationFrame` never fires | nothing is scheduled without compositing |
| transitions frozen at their start value | `transitionend` never fires |
| virtualized rows read as empty text | they need layout that never runs |
| in-page requests hang to their timeout | measured: an axios POST sat 180s while `curl` answered in 4s |

So every path measures first:

```js
new Promise(res => { let f = 0; requestAnimationFrame(function t(){ f++; requestAnimationFrame(t); }); setTimeout(() => res(f), 1000); })
```

Zero means blind. That worker asks you to open its pane, then measures again, because the reading is the
proof and not the reply. A worker that stays blind writes `.blocked` and no findings at all, and
collection reports blocked workers by name. A run that says clean while a third of it saw nothing is worse
than no run.

Two concurrent live panes are measured working, in separate sessions, with the second chat greyed out and
unfocused. The gate is the pane being displayed, not chat focus. Three or more is untested.

Full symptom list and wave sizing: [`docs/BROWSER.md`](docs/BROWSER.md). Measuring speed from inside a
fleet that is itself load: [`docs/PERF.md`](docs/PERF.md).

## Models

Set per brief rather than globally:

```yaml
model: sonnet          # walks the work
verdict-model: opus    # rules on what the walk produced
```

Measured on 2026-08-24: a Haiku subagent driving a live pane cost 45,775 tokens across 3 tool calls and
returned 4 lines. Nearly all of that is fixed startup, which gives two conclusions pointing in different
directions. Delegation always wins on parent context. On cost it wins only across a long burst, so one
subagent per scenario rather than one per step.

That measurement shows Haiku handling mechanics. It shows nothing about judging an interface. Selection
guidance in [`docs/MODELS.md`](docs/MODELS.md).

## Project configuration

The plugin carries no project details. A project that runs fleets keeps a `FLEET.md` at its root naming
the app origin, the services that must already be running, the login runbook, the naming rules, and the
actions reserved for the operator. Every command reads it when present, and says plainly what it could not
find when absent.

Guessing at an origin or improvising against a login form costs an hour and produces nothing, so the
commands stop instead.

## What it deliberately leaves out

- **Session to session messaging in the happy path.** Session handles are opaque, change between calls,
  and reach other accounts on the same machine. A message aimed by handle once landed in an unrelated
  account's release preparation chat. Files have addresses; sessions do not.
- **A review command.** [`caveman`](https://github.com/JuliusBrussee) ships `cavecrew-reviewer`, which
  already does terse diff review well. This plugin has a soft dependency on caveman: it uses it when
  installed and works without it.
- **Project specifics.** They live in the project, in `FLEET.md`.

## Licence

MIT.
