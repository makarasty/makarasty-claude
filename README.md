# makarasty

Two Claude Code plugins from one marketplace.

- **`makarasty`** runs one job across several Claude Code sessions at once: a test sweep of a live app, a
  fix run over its backlog, a refactor across a hundred files, a research sweep, a design pass. You plan
  once, click a chip per worker, and each worker claims tasks from a shared queue and reports by writing
  files. Between what a run finds and what it changes there is a gate: no fix without a reproduction that
  failed first.
- **`makarasty-tools`** is nine everyday commands that have nothing to do with fleets: commit under your
  own name, ship a branch, review a diff with evidence, hand a chat off before its context runs out, get a
  phone message when a chat finishes, and a few more.

Install one or both. They are versioned separately.

## Why it exists

An agent that cannot see what it is inspecting still reports findings, with full confidence, and they
look exactly like real ones. A browser pane that stopped compositing is the sharpest case: it still
navigates, still returns DOM, and every visual observation through it is false. A green suite that
skipped your file and a docs page that never loaded produce the same confident nothing.

So every path through this plugin measures before it trusts. A worker counts frames before it looks at a
page, a finding without evidence is refused by a script rather than by a request in prose, and a run that
had a blind worker says so by name instead of reporting its area as clean.

The second reason is the one most multi-agent setups learn late: a session runs only while something
invokes it. In one measured run, three of six workers ended a turn right after claiming their next task
and sat dead for about three hours each, holding claims nobody else could take. The protocol here is built
so that this can't happen silently. See [The other way a run dies](#the-other-way-a-run-dies).

## Install

```
/plugin marketplace add makarasty/makarasty-claude
```

```
/plugin install makarasty@makarasty
```

```
/plugin install makarasty-tools@makarasty
```

Restart Claude Code afterwards; plugins load at session start. To install from a local checkout instead,
pass its path to `marketplace add`.

### Requirements

- Claude Code. The fleet's browser checks and worker chips use the desktop app's Code tab (the built-in
  browser pane and the task chips); a fleet with no browser tasks runs anywhere Claude Code does.
- A POSIX shell. On Windows that is Git Bash, which Claude Code already needs. The self-test passes under
  `bash` and `dash`.
- Node.js for the hooks and four `fleet.sh` subcommands (`sweep`, `recover`, `pane-status`, and the proof
  check in `finish`). Everything else degrades to a warning without it.
- Nothing else. `rg`, `sg`, `jq` and similar tools are offered by `fleet-init` and never required.

### Check that it works on your machine

```bash
sh scripts/fleet-selftest.sh
```

From an install rather than a checkout, the plugin's path is `installPath` for `makarasty` in
`~/.claude/plugins/installed_plugins.json`. The self-test runs the whole protocol (claims, lanes, the
schema gate, the clocks, the markers, the landing check) against a temporary directory in about a second,
with no sessions, no browser and no tokens. It should end with `N passed, 0 failed`.

## Quick start

In the project you want to work on:

```
/makarasty:fleet-init
```

It finds the app's origin and services, sets up a login path an agent can use on its own, writes
`FLEET.md`, and tells you how many workers this machine will carry. Then:

```
/makarasty:fleet-plan <what you want done>
```

The planner interviews you, splits the job into a queue, and offers one chip per worker. Click them. When
the workers land, `/makarasty:fleet-collect <run-id>` merges their findings into one ranked backlog.

[`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md) is a first fleet in fifteen minutes, with two workers and no
browser.

## Fleet commands

| Command | Started by | What it does |
|---|---|---|
| `/makarasty:fleet` | you | Lists the other commands and when to use each |
| `/makarasty:fleet-init` | you or Claude | Prepares a project: origin, services, agent login, `FLEET.md`, machine sizing |
| `/makarasty:fleet-plan <mission> [fast]` | you | Interviews you into a plan, splits it into a queue or briefs, offers one chip per worker |
| `/makarasty:fleet-run <brief or run dir>` | the worker, after you click its chip | Runs one brief, or works a queue until it is drained |
| `/makarasty:fleet-login` | you or Claude | Opens and logs in to the project's local app, with credentials from the runbook, never from the chat |
| `/makarasty:fleet-wait <run-id> [n]` | you or Claude | Waits without spending model turns, then collects |
| `/makarasty:fleet-collect <run-id>` | you or Claude | Merges, enforces the evidence contract, dedupes, ranks |
| `/makarasty:fleet-resume <run-id>` | you or Claude | After a crash: reopens the workers whose context survived, respawns the rest |
| `/makarasty:fleet-design <screens> [fast]` | you | Captures the app's screens as artboards on disk and assembles them into a Claude Design canvas |
| `/makarasty:fleet-redesign <screens and direction> [fast]` | you | Proposes redesigns beside the captured screens, loading and error states included |
| `/makarasty:fleet-call <who and what about> [fast]` | you | Digs the facts for a vendor call out of the project, with evidence, and builds a bilingual page to read aloud; `live <run-id>` answers beside you during the call |

`fleet`, `fleet-plan`, `fleet-design`, `fleet-redesign` and `fleet-call` carry
`disable-model-invocation: true`: they start paid work and wait on your clicks, so only you can start
them. `fleet-run` is the exception on purpose. The worker's own model invokes it in the new session, and
the flag would stop every worker the moment it tried to begin.

### Agents

- **`fleet-scenario`** walks a multi-step browser scenario and returns bounded JSON. Screenshots and DOM
  reads stay in its context; about eighty tokens come back to the parent.
- **`fleet-profiler`** measures load, interaction and stability, with the spread of each reading and the
  machine load beside it.
- **`fleet-triage`** merges and ranks a run's findings, on Haiku.
- **`fleet-design-eye`** reviews one screen for design defects: geometry probes first, a zoomed screenshot
  of each candidate second, and every finding carries the rectangles behind it.

## Tools commands

| Command | What it does |
|---|---|
| `/makarasty-tools:commit` | Commits this chat's files under your own name, short message, no AI trailer. Commits by path, so a file another chat staged stays out |
| `/makarasty-tools:ship [branches\|all] [mine] [tag <name>]` | Merges branches in, splits the tree into your own commits, leaves files a parallel chat is still editing, pushes, tags with notes |
| `/makarasty-tools:review [--fix\|--loop]` | Reports only findings that name an input that breaks the code, each one checked by a pass that tries to disprove it. `--loop` fixes and re-reviews until a round finds nothing |
| `/makarasty-tools:handoff [focus] \| from <chat>` | Writes a handoff file and offers the next chat as a chip that can read or ask this one; `from` takes over another chat's work after checking its claims |
| `/makarasty-tools:hold [codeword]` | Collects dictated bugs one line each without acting, then on the codeword fixes them grouped by shared cause |
| `/makarasty-tools:explain [topic]` | What happened, why, what was done, what is left, whether it can ship and what was not checked, in plain words |
| `/makarasty-tools:unslop [on\|off\|text]` | Turns humanised replies on or off, or rewrites a given text without assistant tics |
| `/makarasty-tools:say <what to say>` | Turns what you mean into simple English to say on a call or send to a vendor, with a gist in your language beside each line |
| `/makarasty-tools:notify [what you are waiting for]` | Sends one message to your phone when this chat, another chat or a fleet run finishes: Telegram, Discord, ntfy or a webhook |

All nine can be started by you or by Claude, and most trigger on plain phrasing in any language: "commit
as me", "закоммить от меня", "ping me when the tests are done".

**Context hook.** Once a chat's context passes 400k tokens, and again every 150k above that, the chat is
told to offer a handoff in one line. `MAKARASTY_HANDOFF_AT` and `MAKARASTY_HANDOFF_STEP` move the levels;
`MAKARASTY_HANDOFF_AT=0` turns it off.

**Notifications.** Say "ping me when it's done" in the chat doing the work. It arms a marker for that
session, and a hook sends one message when the turn ends, with the last 500 characters of the reply under
the verdict. A chat that ends on a question is reported as waiting for you; one that leaves a background
job running is not finished and keeps its marker; one that dies on a rate limit says so. Setup is one
command in your terminal: a wizard asks for the channel, takes one value (a bot token, a webhook URL or an
ntfy topic), and saves it to `~/.claude/makarasty/notify.json` only after a test message reaches your
phone. The secret never passes through a chat. While no chat is armed the hooks cost one `ls` per event
and start no Node process.

## How a fleet works

### Two shapes

**Assigned**: the planner writes one brief per worker, and the run ends when the briefs do.

**Pull**: the planner writes a queue, workers claim tasks when free, and the planner keeps adding tasks
while they run. A claim is a directory, because `mkdir` fails atomically on one that exists; with eight
concurrent claimers, exactly one won. Use pull when the job is bigger than the plan, which is most of the
time. Details in [`docs/PULL.md`](docs/PULL.md).

### Lanes

A fleet queues for whatever the machine has exactly one of. Each task declares a **lane**: `pane` for the
browser, `verify` for the test suite and typechecker, `repo` for work that only reads and writes files.
The lanes are capped separately. The pane lane is capped by your display, ten at most; the repo lane by
the machine. Capping file work at the width of a monitor is how a run ends up eight browsers wide and two
files wide.

That one field is what makes the plugin more than a browser tool. A run with no pane tasks is a refactor,
a migration or a research sweep, and the gate changes its evidence instead of disappearing: a reproduction
that fails before a fix and passes after, a verbatim quote with its locator from each source, a test count.

A pane worker spends about 20 of its 23 minutes waiting on one scenario subagent, so it claims one repo
task and works it during the wait. Details in [`docs/LANES.md`](docs/LANES.md).

### Mission kinds

Each task declares its `kind`, which sets the working style and the axis the job splits along.

| Kind | Splits by | Isolation |
|---|---|---|
| `verify` | screen ownership | none |
| `fix` | file cluster, re-verifying each entry before repairing | worktree |
| `investigate` | hypothesis | worktree when instrumenting |
| `implement` | seam | worktree |
| `research` | source | none |
| `design` | one screen, in three waves: recon, primitives, screens | worktree |
| `critique` | one screen; the evidence is a rectangle or a ratio, never a screenshot alone | none |
| `canvas` | one screen per artboard: recon, primitives sheet, screens, compare, assemble | none |
| `redesign` | one screen; proposals beside the captured ones, directions sketched first | none |
| `call` | source: the facts with their evidence first, then the page you read aloud | none |

Splitting along the wrong axis is what makes a fleet run worthless. Two workers on one slice cost twice as
much and then agree with each other, which reads as corroboration and isn't.

The last four kinds form a loop: critique what runs, capture it as a canvas, propose beside it, then
implement the approved artboards with the `design` kind. See [`docs/DESIGN.md`](docs/DESIGN.md) and
[`docs/MISSIONS.md`](docs/MISSIONS.md).

### The pane gate

A browser pane that is not on screen stops compositing, and nothing tells you:

| Symptom | Cause |
|---|---|
| screenshot times out after 5s | pane not displayed |
| `requestAnimationFrame` never fires | nothing is scheduled without compositing |
| transitions frozen at their start value | `transitionend` never fires |
| virtualized rows read as empty text | they need layout that never runs |
| in-page requests hang to their timeout | measured: an axios POST sat 180s while `curl` answered in 4s |
| `preview_start` returns navOk with the right title | navigation and titles survive; only frames don't |

So every pane worker counts frames first:

```js
new Promise(res => { let f = 0; requestAnimationFrame(function t(){ f++; requestAnimationFrame(t); }); setTimeout(() => res(f), 1000); })
```

Sixty or more is live; anything below, zero included, is blind. A blind worker asks you to open its pane
and measures again, because the reading is the proof, not your reply. A worker that stays blind writes
`.blocked` and no findings, and collection lists blocked workers by name. Two panes in separate sessions
were measured live at the same time, with the second chat unfocused: what matters is that the pane is
displayed, not which chat has focus. More in [`docs/BROWSER.md`](docs/BROWSER.md).

### The other way a run dies

A blind pane is loud once you know the symptom. This one is silent. When a turn ends with no subagent
running and no background command pending, the session stops, and nothing in a fleet types into a
worker's chat to restart it. Its last message usually says what it was about to do next.

Measured on 2026-08-27: three of six workers ended a turn right after claiming their next task and sat dead
for 169, 171 and 176 minutes. The planner slept through it, because its watch reported new files and there
were none. One cross-session status check brought all three back within seconds.

So a worker claims and starts work in the same turn, arms `sleep 120; echo wake` in the background when it
has to stop anywhere else, and the planner's watch reports silence as well as progress. A `Stop` hook
catches the case of a fresh claim whose heartbeat never moved. Full rules in
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

### The gate between a finding and a fix

About 15 findings in 100 were refuted once somebody tried to fix them. So a `fix` task is refused by
`finish` unless a reproduction ran through `fleet-gate.mjs prove`, failing before the change and passing
after. A cause several findings share is ruled on once, before any of them is patched. An edit that drops a
name something outside the repository reads (a route, a config key) is blocked by a hook until a question
or a recorded decision names it. See [`docs/GATE.md`](docs/GATE.md).

## What it may delete

A fleet runs unattended across a dozen sessions, so what it may remove is a short closed list, not each
worker's judgement:

1. Its own scratch, under `.fleet/<run-id>/`.
2. The worktrees its own workers created, under `.claude/worktrees/`, and only through `fleet.sh clean`.

Nothing else. There is no `git reset --hard`, no `git clean`, no `git checkout --` anywhere in the plugin,
and no recursive force-delete of a path it did not create.

`fleet.sh clean` is a dry run unless given `--remove`. It touches only worktrees this run registered,
keeps any tree with uncommitted changes or with commits neither merged nor pushed, and deletes a branch
only with `git branch -d`, which refuses unmerged work. Every deletion passes a path gate: absolute, no
`..` or `.` segments, at least four levels below the root, inside `.claude/worktrees/` with something
after it, and never a directory that contains the shell's working directory.

One step here is not obvious, and it was measured [M32]: a worktree usually has a `node_modules` junction
into the main checkout, and `git worktree remove` **follows that junction and deletes what it points at**.
Eight runs out of eight on Windows, at the top level and nested, `--force` included, exit code 0 every
time. So `clean` unlinks every junction and symlink inside a worktree before anything recursive touches
it. The same applies to the harness's own `ExitWorktree` and to any hand-written `rm -rf`. See
[`docs/WORKTREES.md`](docs/WORKTREES.md) and [`docs/SAFETY.md`](docs/SAFETY.md).

## Real runs, and what they cost

A selection of real runs, not all of them. They come from two different projects, a large private
TypeScript web app and the public Kotlin plugin [Essentials](https://github.com/makarasty/Essentials), and
cover different scenarios: browser sweeps of a live app, audits, fix runs, refactors and performance
measurement. Each one is written up in [`docs/RUNS.md`](docs/RUNS.md) with how it was set up, what it
produced, what went wrong, and the cost.

| Run | Workers | Wall clock | Result | Worker cost |
|---|---|---|---|---|
| First eight-worker browser sweep | 8 pane | 104 min | 94 findings, 3 blockers; all 8 panes opened blind and the gate caught every one | $137 |
| Pull run, 34 tasks | 6 pane | 4 h 57 min | 254 findings; three workers sat dead for about 3 h each | not separable |
| Audit, then fix | 14, then 8 | 132 + 80 min | 246 findings, then 38 fixed and merged, 3 refuted | $561 + $434 |
| Eighty tasks across three lanes | 13 | 4 h 6 min | 80 tasks; third verify round green at 37,296 tests | $1,722 |
| Read-only sweep, then a fix run | 12, then 4 | ~90 min active, then 3 h 51 min | 1,500 findings, then 175 tasks fixed | $743 + $1,111 |
| Refactor, then shrink | 9, then 10 | 71 + 107 min | 96 fixed, 32 refuted; then −26,794 lines (−17.6% against a −25% target) | $484 + $735 |
| Essentials, audit to green | 4-10 per run | ~50 h calendar | 436 findings; 251 tests with 20 failing to 383 with 0, ten green runs of ten | $2,233 |

Dollars are API list prices for the same tokens; the runs themselves were made on a subscription, and the
first one above used about 6% of a weekly maximum allowance. Across 21 runs and 186 sessions the total is
about $11,000, and **74% of it is cache reads**. What a run costs is turns multiplied by the context each
turn carries: the most expensive run per task, $6.35, had workers holding 485 k of context per turn, and
the cheapest broad sweep, about $0.50 a finding, fanned its reading out to subagents. What a worker says
costs almost nothing next to what it reads. The full ledger, with every measurement a rule cites, is
[`MEASUREMENTS.md`](docs/MEASUREMENTS.md).

Every defect those runs exposed in the plugin itself is in [`CHANGELOG.md`](CHANGELOG.md), with the fix.

## What the version number covers

Under semver, 1.x will not break:

- **The run directory layout**: `tasks/ready`, `tasks/claimed/<id>/owner`, `tasks/claimed/<id>/proof`,
  `tasks/done`, `ask/`, `answers/`, `pane/`, `decisions.jsonl`, `clusters.jsonl`, and the
  `<chip>.jsonl`, `.notes.md`, `.done`, `.blocked` and `.waiting` files. `.fleet/contract-surface.txt`
  sits beside the runs because it belongs to the project and is committed with it. Each run stamps
  `RUN_FORMAT` at its first write, and a `fleet.sh` that reads an older format refuses a newer run rather
  than misreading it.
- **`fleet.sh` subcommands and exit codes**: 0 done; 1 a line the schema gate refused, a walk served from
  a blind pane, or a run that has not landed; 2 wrong usage or a run this version cannot read; 3 the queue
  is drained for that lane; 4 the claim is no longer yours; 5 from `drained`, not finished (the planner
  has not closed the queue, or a ready task nobody holds is still waiting); 6 free memory is under the
  floor; 7 from `next`, tasks exist but an `after:` or a held verify lane holds them.
- **The four line shapes** a findings file may hold (a finding, `unreached`, `created`, `state_changed`)
  and the fields the schema gate enforces on each.
- **The markers**: `.done` means finished, `.blocked` means it never saw, `.waiting` means it is stopped on
  a person, `FINISHED` means the run was landed by declaration.

Everything else is calibration, not contract: prose rules, agent briefs, and the numbers in
`calibration.json` and in this README. A minor version may change any of them when a run measures
something better. [`scripts/fleet-selftest.sh`](scripts/fleet-selftest.sh) is the contract in
executable form.

## Known limits

The sample is small, and it is written down so you can decide how far to trust it.

- **Every number here comes from one machine, one operator and one application**, over a few weeks. Only
  Windows has run a real fleet. The shell half is better covered: the self-test passes under `bash` and
  `dash`, but no macOS or Linux fleet has run.
- **The pane states in [M33] were driven by hand, once, on Windows.** macOS and Linux may stop a pane for
  reasons this never met.
- **The memory refusals have never fired in a real run.** The throttle in `next` and the hooks that refuse
  a full test suite or a browser call on a full machine are covered by self-test cases against a stub, and
  their two thresholds in `calibration.json` were chosen, not measured. The heavy-page figure (2,061 MB)
  came from a synthetic fixture of 150,000 DOM nodes; measure your own app with
  `node scripts/fleet-load.mjs`, once with it open and once without.
- **No fleet has run with the finding-to-fix gate on.** `fleet-gate.mjs` and `fleet-contract.mjs` are
  covered by 36 self-test cases, and the clustering was built against a real backlog of 436 findings, but
  no worker has yet been stopped by the contract hook in a live run.
- **The contract surface is a regular expression over text.** It misses a route built by concatenation and
  a config key read through a variable. Edit `.fleet/contract-surface.txt` by hand and commit it.
- **No fleet has captured a real application as a canvas yet.** `fleet-canvas.mjs` ran end to end on a
  fixture project; the compare stage's 2 px tolerance is a starting number. Publishing the canvas is a
  manual step through the `design` skill.
- **The design probe was verified in one browser on one fixture** [M29]: nine planted defects found, zero
  of ten look-alikes reported. It can't see an overlapping sibling when it reads contrast, and its
  `offScale` and `ghostBoxes` results are candidates, not findings.
- **The pane broker** in [`docs/BROKER.md`](docs/BROKER.md) has never run live.
- **`recover` can't confirm a resume happened.** It prints the command; you run it in a terminal. A
  resumed session is a terminal with no browser pane, so repo-lane workers come back and pane-lane workers
  don't.
- **The evals in [`evals/`](evals/) have not been run against this release.** They need Linux or macOS,
  because `claude plugin eval` refuses a shell tool it can't sandbox, and on Windows it can't.
- **The largest cost measured is not this plugin's to fix.** A permission mode that adds 1.5 to 2 s to
  every gated call accounted for 16.55 h of a 211 h tool wall [M28]. Only an allowlist or a different
  permission mode removes it.

## When something looks broken

**A change to the plugin did not take effect.** The install is a cache, and `claude plugin update` can say
"already at latest version" while the source has moved. Bump the version, or run
`claude plugin uninstall makarasty@makarasty` and install again.

**The run directory is in Dropbox, OneDrive or iCloud.** The atomic claim is `mkdir`, which means nothing
once a sync client is renaming and copying the directory behind you. Keep `.fleet/` on a local disk; the
same goes for network shares.

**"bad interpreter" on Windows.** A `.sh` file checked out with CRLF endings. `.gitattributes` pins LF; a
clone made before that file needs a fresh checkout.

**Git Bash not found.** Set `CLAUDE_CODE_GIT_BASH_PATH`. Nothing in the fleet can work around a shell the
harness can't find.

## What it leaves out

- **Session-to-session messaging in the normal path.** Session handles change between listings and can
  reach other accounts on the same machine; a message aimed by handle once landed in an unrelated
  account's chat. Files have addresses, sessions don't. The one place messaging is used is reviving a
  stalled worker, where nothing else works.
- **Project specifics.** They live in the project, in `FLEET.md`.
- **Required dependencies**, apart from Node for the subcommands listed above. Without Node, `sweep`,
  `recover` and `pane-status` exit 2 rather than report every age as zero, because a dead fleet that reads
  healthy is worse than a refusal.

## Documentation

| Page | What's in it |
|---|---|
| [`WALKTHROUGH`](docs/WALKTHROUGH.md) | Your first fleet in fifteen minutes |
| [`PROTOCOL`](docs/PROTOCOL.md) | Run layout, brief format, finding schema, project configuration |
| [`PULL`](docs/PULL.md) | The task queue, claims, heartbeats, budgets, asking the planner |
| [`LANES`](docs/LANES.md) | What a fleet queues for, fan-out, a run with no browser |
| [`MISSIONS`](docs/MISSIONS.md) | The ten kinds and the axis each splits along |
| [`GATE`](docs/GATE.md) | The stage between a finding and a change |
| [`BROWSER`](docs/BROWSER.md) | Blindness, the frame gate, panes, viewports |
| [`DESIGN`](docs/DESIGN.md) | Critique with geometry probes, the canvas on disk, redesign, the loop back to code |
| [`CALL`](docs/CALL.md) | Facts with evidence, the page read aloud, the live chat beside the call |
| [`SWEEPS`](docs/SWEEPS.md) | Checks that catch a class of defect rather than one bug |
| [`MOCKING`](docs/MOCKING.md) | Reaching states the sandbox data won't produce |
| [`WORKTREES`](docs/WORKTREES.md) | Registration, the junction measurement, the only path that deletes one |
| [`SAFETY`](docs/SAFETY.md) | What an unattended fleet may delete, and the path gate |
| [`COMMANDS`](docs/COMMANDS.md) | Who may invoke each command, what `allowed-tools` grants |
| [`MODELS`](docs/MODELS.md) | Which model per stage, and the cost of delegating |
| [`PERF`](docs/PERF.md) | Measuring speed on a machine the fleet is loading |
| [`BROKER`](docs/BROKER.md) | The pane as a shared instrument work is filed against |
| [`PORTING`](docs/PORTING.md) | Every assumption about the host, and its substitute |
| [`RUNS`](docs/RUNS.md) | Real runs from two projects: setup, results, failures, cost |
| [`MEASUREMENTS`](docs/MEASUREMENTS.md) | The ledger every rule cites |

Scripts worth knowing: [`fleet.sh`](scripts/fleet.sh) does the queue's bookkeeping and is the only place
the finding schema is enforced; [`fleet-merge.mjs`](scripts/fleet-merge.mjs) turns findings into a backlog
and a backlog into a fix queue; [`fleet-load.mjs`](scripts/fleet-load.mjs) shows what the machine is
carrying, by class; [`visual-probe.js`](scripts/visual-probe.js) and
[`design-probe.js`](scripts/design-probe.js) find visual and design defects by geometry, so a screenshot
confirms rather than invents.

## License

[MIT](LICENSE)
