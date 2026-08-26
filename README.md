# makarasty

A Claude Code plugin for running one mission across several sessions at once, plus a few commands for the
work around it.

Each worker session holds its own context, drives its own browser, works one task, and reports by writing
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

Then, in the project you want to test: `/makarasty:fleet-init`. It discovers the app origin and services,
sets up a login path an agent can use on its own, writes `FLEET.md`, and tells you how many workers this
machine will carry. The other commands run it themselves when they find a project uninitialised.

## Commands

| Command | Who reaches it | What it does |
|---|---|---|
| `/makarasty:fleet` | you | Names the other commands and when to use each |
| `/makarasty:fleet-init` | you or Claude | Prepares a project: origin, services, agent login, `FLEET.md`, machine sizing |
| `/makarasty:fleet-plan <mission> [n]` | you | Splits a mission into briefs or a task queue, and offers one chip per worker |
| `/makarasty:fleet-run <brief or run dir>` | you | Runs one brief, or works a queue until it is drained |
| `/makarasty:fleet-login` | you or Claude | Opens and authenticates the project's local app |
| `/makarasty:fleet-wait <run-id> [n]` | you or Claude | Waits without spending model turns, then collects |
| `/makarasty:fleet-collect <run-id>` | you or Claude | Merges, enforces the evidence contract, dedupes, ranks |
| `/makarasty:commit` | you or Claude | Commits under your own name, short message, no tool signature |
| `/makarasty:review` | you or Claude | One line per finding, and only findings that name a failing input |
| `/makarasty:unslop [on\|off\|text]` | you or Claude | Toggles humanised replies, or rewrites a given text |

`fleet`, `fleet-plan` and `fleet-run` answer only to you: they spawn paid work and depend on your clicks,
so no agent starts them on its own initiative.

`/makarasty:commit` fires on plain phrasing rather than a slash, so "commit as me" or "commit from my name"
reaches it, in whatever language you asked in.

## Agents

- **`fleet-scenario`** walks a multi step browser scenario and returns bounded JSON. The screenshots and
  DOM reads stay in its context; roughly eighty tokens come back to the parent.
- **`fleet-profiler`** measures load, interaction and stability, returning readings with their spread and
  the machine load beside them.
- **`fleet-triage`** merges and ranks a run's findings, on Haiku.

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
| `preview_start` returns navOk with the right title | navigation and titles survive blindness; only frames do not |

So every path measures first:

```js
new Promise(res => { let f = 0; requestAnimationFrame(function t(){ f++; requestAnimationFrame(t); }); setTimeout(() => res(f), 1000); })
```

Sixty or more is live. Anything below, zero included, is blind. That worker asks you to open its pane,
then measures again, because the reading is the proof and not the reply. A worker that stays blind writes
`.blocked` and no findings at all, and collection reports blocked workers by name. A run that says clean
while a third of it saw nothing is worse than no run.

Two concurrent live panes are measured working in separate sessions, with the second chat greyed out and
unfocused: the gate is the pane being displayed, not chat focus.

## Mission kinds

A fleet is not only for testing. Each task declares its `kind`, which decides the working style and, more
importantly, the axis the mission splits along.

| Kind | Splits by | Isolation |
|---|---|---|
| `verify` | screen ownership | none |
| `fix` | file cluster, re-verifying each entry before repairing | worktree |
| `investigate` | hypothesis | worktree when instrumenting |
| `implement` | seam | worktree |
| `research` | source | none |

Splitting along the wrong axis is what makes a fleet run worthless. Two workers on one slice cost twice
and then agree with each other, which reads as corroboration and is not.

## Two shapes

**Assigned**: the planner writes one brief per worker and the run ends when the briefs do.

**Pull**: the planner writes a queue, workers claim tasks when free, and the planner keeps adding while
they run. The claim is a directory, because `mkdir` fails atomically on an existing one, verified with
eight concurrent claimers where exactly one won. Fleet size stops being a number anyone picks and becomes
however many panes are open. Use it when the surface is larger than the plan, which is most of the time.

## What it costs, measured

One eight worker run over a large application, 2026-08-26:

| | |
|---|---|
| Findings | 94, of which 3 blockers and 33 major |
| Wall clock | 63 minutes, first worker to last |
| Tokens | 8.3 M non-cached, 311 M cached, a 37:1 ratio |
| Subscription | roughly 6 percent of a weekly maximum allowance |
| Blind on first gate | 8 workers of 8 |
| Blocked time | 70 percent of summed elapsed |
| Avoidable tool calls | 259 of 1,350 conservatively, 473 at the upper bound |
| Executor return ratio | 0.96 to 2.04 percent |
| Refuted when someone tried to fix them | roughly 15 of 100 |

The return ratio is stable and is not the lever. The denominator varies by an order of magnitude: one
executor made 30 calls and read 4.0 M cached tokens, another made 194 and read 55.6 M, and both returned
about the same number of lines. What a run costs is decided by how much the executor looked at, never by
how much it said.

## Reference

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) run layout, brief format, finding schema, portability, shell traps
- [`docs/PULL.md`](docs/PULL.md) the task queue, claiming, heartbeats, budgets, asking the planner
- [`docs/MISSIONS.md`](docs/MISSIONS.md) the five kinds and the axis each splits along
- [`docs/BROWSER.md`](docs/BROWSER.md) blindness, the gate, panes, viewports, round trips
- [`docs/SWEEPS.md`](docs/SWEEPS.md) checks that catch a class of defect rather than one bug
- [`docs/PERF.md`](docs/PERF.md) measuring speed on a machine the fleet is loading
- [`docs/MODELS.md`](docs/MODELS.md) which model per stage, and the delegation economics
- [`docs/PORTING.md`](docs/PORTING.md) every assumption this makes about its host, and its substitute

## What it deliberately leaves out

- **Session to session messaging in the happy path.** Session handles are opaque, change between listings,
  and reach other accounts on the same machine: a message aimed by handle once landed in an unrelated
  account's release chat. Files have addresses; sessions do not. Claude Code's own Agent Teams may be a
  better transport for waking a session sooner, but never for carrying the only copy of a result.
- **Project specifics.** They live in the project, in `FLEET.md`.
- **Required dependencies.** `rg`, `sg`, `jq` and friends are offered by `fleet-init` and none are needed.
  A worker that stops because `fd` is absent has invented a dependency.

## Licence

MIT.
