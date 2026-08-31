# makarasty

A Claude Code plugin for running one mission across several sessions at once, plus a few commands for the
work around it.

Each worker session holds its own context, claims one task at a time, and reports by writing a file.
Nothing messages anything, so a worker that dies leaves its findings behind and a worker that finishes
needs nobody's attention.

The problem it exists for is narrow. An agent that cannot actually see what it is inspecting reports
findings with complete confidence, and those findings are indistinguishable from real ones. A browser pane
that stopped compositing is the sharpest case, but a green suite that skipped your file and a documentation
page that never loaded produce the same confident nothing. Every path through this plugin measures before
it trusts.

## Install

From a local checkout, which is the path this release was developed and tested on:

```
/plugin marketplace add /path/to/makarasty-claude
```

```
/plugin install makarasty@makarasty
```

Once the repository is published, the same two commands take its GitHub coordinates
(`/plugin marketplace add makarasty/makarasty-claude`) instead of a path. That path has not been exercised
yet - see "Known limits of 1.0.0" below.

Restart Claude Code afterwards. Plugins load at session start.

Then, in the project you want to test: `/makarasty:fleet-init`. It discovers the app origin and services,
sets up a login path an agent can use on its own, writes `FLEET.md`, and tells you how many workers this
machine will carry. The other commands run it themselves when they find a project uninitialised.

## Commands

| Command | Who reaches it | What it does |
|---|---|---|
| `/makarasty:fleet` | you | Names the other commands and when to use each |
| `/makarasty:fleet-init` | you or Claude | Prepares a project: origin, services, agent login, `FLEET.md`, machine sizing |
| `/makarasty:fleet-plan <mission> [fast]` | you | Interviews you into a plan, splits it into a queue or briefs, offers one chip per worker |
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

## The other way a run dies

A pane going blind is loud once you know the symptom. This one is silent.

A session runs only while something invokes it. When a turn ends with no subagent running and no
backgrounded command pending, that session has stopped, and nothing in a fleet types into a worker's chat
to restart it. It does not crash, it does not report anything, and its last message usually says what it
was about to do next.

Measured 2026-08-27: three of six workers ended a turn immediately after claiming their next task and sat
dead for 169, 171 and 176 minutes, each holding a claim nobody else could take. The planner slept through
it, because its watch reported new files and there were none. A single cross-session status check brought
all three back within seconds.

So a worker claims and begins in the same turn, arms `sleep 120; echo wake` in the background when it must
stop anywhere else, and the planner's watch reports silence as well as progress. Full rules in
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

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

## Lanes, and why this is not only a browser tool

A fleet queues for whatever the machine has exactly one of, and a worker is the thing holding it. Name that
a **lane**: `pane` for the browser, `verify` for the test suite and the typechecker, `repo` for work that
only reads files and is therefore not scarce at all.

Every task declares its lane, and every worker claims in one. A pane task is strictly serial per worker,
because browser subagents drive the parent session's pane. A repo task fans out. A verify task takes the
machine.

**The lanes are capped separately, which is the point of naming them.** The pane lane is capped by the
operator's display, ten at the outside. The repo lane is capped by the machine and sized from the queue,
and there is no reason for the two numbers to match: capping file work at the width of a monitor is how a
run ends up eight browsers wide and two files wide.

That one field is what makes the tool general. A run with no pane tasks is an ordinary run whose pane lane
happens to be empty: a refactor across a hundred files, a migration, a research sweep, a codebase somebody
is learning. The gate travels with it, changing only its referent - a reproduction that fails before a fix
and passes after, a verbatim quote with its locator from each source, a test count rather than a colour.

The largest measured lever lives here too. A pane worker spends about 20 of its 23 minutes waiting on one
scenario subagent, so it claims one repo task and works it during the wait. Full rules in
[`docs/LANES.md`](docs/LANES.md).

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

A six worker pull mode run over the same application, 2026-08-27, is the counterweight:

| | |
|---|---|
| Findings | 254, of which 6 blockers, plus 58 unreached entries |
| Tasks worked | 34, claimed from a queue the planner kept extending |
| Wall clock | 4 hours 57 minutes, first claim to last `.done` |
| Worker time lost to dead sessions | 516 minutes of 1,782, 29 percent, in three simultaneous stalls |
| Planner time lost to the same cause | 65 minutes, ended by the operator typing "I think the chat has hung" |
| Operator interruptions | 8 interactive prompts across six chats, 7 of them the same pane question |
| Planner wake-ups | 62, of which 13 were claims it took no action on |
| Watch left running after the run finished | 5 hours 42 minutes |

Every row below the findings is a defect in this plugin rather than in the application, and every one of
them was fixed before this release, and the lanes landed on 2026-08-28. The queue itself worked: 34 tasks
off a queue that did not exist when the run started is the shape a fixed set of briefs cannot produce.

A fourteen worker pull mode run over the same application, 2026-08-31, is what 1.0.0 is answering:

| | |
|---|---|
| Findings | 246, of which 32 blockers and 120 major, over 54 tasks |
| Workers | 14, six on panes and eight on files, all landed, none blind |
| Turns | 4,580 assistant turns, 3.8 M output tokens, 1.2 B cached reads |
| Session life after the worker's own `.done` | 703 minutes and 108 turns, across 13 of the 14 workers |
| Abort clocks armed | 52, of which zero were ever stopped |
| Longest tail | one worker still being woken 74 minutes after it finished |
| Pane question, chip clicked to question on screen | 1 to 34 minutes, answered one chat at a time |
| Claims made by hand around a missing `next` lane filter | 73, beside 113 through the helper |

The last row is the instructive one. `fleet.sh next` had no lane argument, so a paneless worker could
claim a browser task; the planner worked around that by telling nine workers to walk the queue by hand,
and the hand rolled path skips the one place the finding schema is enforced. A missing argument took the
contract down with it, and nothing went red.

The same day's second run - eight workers repairing what the first one found, 32 tasks, 132 findings,
741 files changed - reproduced both defects independently, which is what makes them design faults rather
than one bad afternoon: **387 minutes and 174 turns of session life after the workers' own `.done`
markers**, 35 clocks armed and none stopped, and **two panes opened for three minutes of browser driving**.
It also finished without being collected: 132 findings sat in eight JSONL files with no backlog until
somebody ran `merge` by hand two hours later.

1.0.0 gives `next` its lane, makes every clock name the obligation it guards so `finish` can stop it,
ends a run with a generated banner plus one notification plus a `FINISHED` file, has each chat rename
itself in the sidebar when it lands, and asks for a pane in the first minute after the chip rather than
the thirty-fourth.

## Reference

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) run layout, brief format, finding schema, portability, shell traps
- [`docs/PULL.md`](docs/PULL.md) the task queue, claiming, heartbeats, budgets, asking the planner
- [`docs/MISSIONS.md`](docs/MISSIONS.md) the five kinds and the axis each splits along
- [`docs/BROWSER.md`](docs/BROWSER.md) blindness, the gate, panes, viewports, round trips
- [`docs/SWEEPS.md`](docs/SWEEPS.md) checks that catch a class of defect rather than one bug
- [`docs/MOCKING.md`](docs/MOCKING.md) reaching states the sandbox data will not produce, and the line
  between a scene and a shared write
- [`docs/LANES.md`](docs/LANES.md) what a fleet is really queueing for, fan-out, and a run with no browser
- [`docs/BROKER.md`](docs/BROKER.md) the pane as a shared instrument work is filed against, and the
  measurement that says seven open panes carried less than one pane's worth of demand
- [`scripts/fleet.sh`](scripts/fleet.sh) the queue's bookkeeping in one call per boundary, and the only
  place the finding schema is enforced rather than requested
- [`scripts/fleet-merge.mjs`](scripts/fleet-merge.mjs) findings to a reconciled backlog, and a backlog to a
  queue a fix fleet can claim
- [`scripts/fleet-selftest.sh`](scripts/fleet-selftest.sh) the whole protocol against a temporary directory
  in about a second, with no sessions, no browser and no tokens: 38 checks over the lane filter, the atomic
  claim, the schema gate, the clocks, the completion markers and the landing test. Run it before trusting a
  change to the plugin
- [`scripts/fleet-load.mjs`](scripts/fleet-load.mjs) what the machine is carrying right now, by class, and
  `--watch` to record it through a run. The sizing rules are derived from these numbers; this is how they
  get re-measured instead of remembered
- [`scripts/visual-probe.js`](scripts/visual-probe.js) visual defects found by geometry, so a screenshot
  confirms rather than invents
- [`docs/PERF.md`](docs/PERF.md) measuring speed on a machine the fleet is loading
- [`docs/MODELS.md`](docs/MODELS.md) which model per stage, and the delegation economics
- [`docs/PORTING.md`](docs/PORTING.md) every assumption this makes about its host, and its substitute

## What the version number covers

A version is a promise about a surface, and this one is deliberately narrow. Under semver, 1.x will not
break:

- **The run directory layout** - `tasks/ready`, `tasks/claimed/<id>/owner`, `tasks/done`, `ask/`,
  `answers/`, `pane/`, and the `<chip>.jsonl` / `.notes.md` / `.done` / `.blocked` / `.waiting` files.
  Each run stamps `RUN_FORMAT` at its first write, and a `fleet.sh` that reads an older format refuses a
  newer run rather than misreading it.
- **`fleet.sh`'s subcommands and their exit codes**: 0 done, 2 usage or a refused input, 3 the queue is
  drained for that lane, 4 the claim is no longer yours, 5 the queue is empty but still open.
- **The four line shapes** a findings file may hold: a finding, `unreached`, `created`, `state_changed` -
  and the fields the schema gate enforces on each.
- **The marker semantics**: `.done` means finished, `.blocked` means it never saw, `.waiting` means it is
  stopped on a person, `FINISHED` means the run was landed by declaration.

Everything else is **calibration, not contract**: every prose rule, every agent brief, and every number in
this README. Those change whenever a run measures something better, and a minor version may rewrite all of
them.

[`scripts/fleet-selftest.sh`](scripts/fleet-selftest.sh) is that contract's executable form - 67
assertions, about a second, no browser and no tokens. Run it after installing, and on any machine before
trusting a fleet on it: it is also the portability probe this plugin has instead of a test matrix.

## Known limits of 1.0.0

Written down rather than fixed, because a tool that hides its sample size is asking to be trusted further
than it has been tested. Full list in [`CHANGELOG.md`](CHANGELOG.md).

- Every number in this README was measured on **one machine, by one operator, against one application**,
  over four runs in six days. Real measurements, weak sample.
- The **pane broker** in [`docs/BROKER.md`](docs/BROKER.md) has never run live.
- The **published install path is untested** - this release installs from a local directory marketplace.
- **Portability is documented, not exercised**: ten host assumptions in
  [`docs/PORTING.md`](docs/PORTING.md), one host actually run.
- The self-test covers mechanics. Whether a worker disarms its clocks, asks for its pane early, or prints
  its banner is prose, enforced by nothing, and prose rules have been routed around twice in measured runs.

## What it deliberately leaves out

- **Session to session messaging in the happy path.** Session handles are opaque, change between listings,
  and reach other accounts on the same machine: a message aimed by handle once landed in an unrelated
  account's release chat. Files have addresses; sessions do not. Claude Code's own Agent Teams may be a
  better transport for waking a session sooner, but never for carrying the only copy of a result. The one
  place messaging is now required is reviving a stalled worker, where nothing else works: see the section
  above.
- **Project specifics.** They live in the project, in `FLEET.md`.
- **Required dependencies.** `rg`, `sg`, `jq` and friends are offered by `fleet-init` and none are needed.
  A worker that stops because `fd` is absent has invented a dependency.

## Licence

MIT.
