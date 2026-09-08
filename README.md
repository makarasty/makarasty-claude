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

The side commands are a second, optional plugin from the same marketplace:

```
/plugin install makarasty-tools@makarasty
```

Once the repository is published, the same two commands take its GitHub coordinates
(`/plugin marketplace add makarasty/makarasty-claude`) instead of a path. That path has not been exercised
yet - see "Known limits" below.

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
| `/makarasty:fleet-resume <run-id>` | you or Claude | Cold start after a crash: reopens the workers whose context survived, respawns the rest |
| `/makarasty:fleet-design <screens> [fast]` | you | Plans a canvas run: the application's screens as artboards on disk, assembled into a Claude Design canvas and published |
| `/makarasty:fleet-redesign <screens and direction> [fast]` | you | Plans a redesign over that canvas: proposals beside the captured screens, states included, directions sketched first when none was given |
| `/makarasty:fleet-call <who and what about> [fast]` | you | Plans a call run: the facts dug out of the project with their evidence, then the bilingual page a non-native speaker reads aloud; `live <run-id>` in a fresh chat answers beside them during the call |

Five more commands ship as a **separate plugin**, `makarasty-tools`, from the same marketplace: they are
useful beside a fleet and have nothing to do with its contract, so they version apart from it.

| Command | Who reaches it | What it does |
|---|---|---|
| `/makarasty-tools:commit` | you or Claude | Commits under your own name, short message, no tool signature |
| `/makarasty-tools:review` | you or Claude | One line per finding, and only findings that name a failing input |
| `/makarasty-tools:unslop [on\|off\|text]` | you or Claude | Toggles humanised replies, or rewrites a given text |
| `/makarasty-tools:say <what to say>` | you or Claude | Turns what you mean into simple English to say on a call or send to a vendor, source-language gist beside each line |
| `/makarasty-tools:notify [what you are waiting for]` | you or Claude | One message to your phone when this chat, another chat, or a fleet run finishes: Telegram, Discord, ntfy or a webhook |

`fleet`, `fleet-plan`, `fleet-run`, `fleet-design`, `fleet-redesign` and `fleet-call` answer only to you: they spawn
paid work and depend on your clicks, so no agent starts them on its own initiative.

`/makarasty-tools:commit` fires on plain phrasing rather than a slash, so "commit as me" or "commit from my
name" reaches it, in whatever language you asked in.

`/makarasty-tools:notify` is the answer to "did it finish" for a chat you are not sitting in. Say "ping me
when the tests are done" in the chat doing the work and it arms a marker for that session; a hook sends
one message when the turn ends, the first lines of the last reply under the verdict, then disarms. A chat
that asks a question instead is reported as waiting for your answer; one that dies on a rate limit says
so; one reopened after a crash checks whether the work was already done and, if it was, tells you it was
done before the restart. `fleet.sh landed` posts a run's headline the same way. Setting up is one command
in the terminal (the first "ping me" hands it to you with a Run button): a wizard asks which channel,
prints the steps for Telegram (a BotFather token), Discord (a channel webhook URL) or ntfy (an app and a
topic, no account), takes the one value, and saves only once a test message has arrived on the phone.
The secret goes from your keyboard to `~/.claude/makarasty/notify.json` and never through a chat, and no
browser tab is opened. A finish that happens before the wizard is done is delivered the moment a channel
is saved. The hooks start nothing while no chat is armed: one `ls` per event, no node. The host's own
`PushNotification` reaches the phone only while Remote Control is connected; this one needs nothing
connected.

## Agents

- **`fleet-scenario`** walks a multi step browser scenario and returns bounded JSON. The screenshots and
  DOM reads stay in its context; roughly eighty tokens come back to the parent.
- **`fleet-profiler`** measures load, interaction and stability, returning readings with their spread and
  the machine load beside them.
- **`fleet-triage`** merges and ranks a run's findings, on Haiku.
- **`fleet-design-eye`** reviews one screen for design defects: two geometry probes first, a zoomed
  screenshot of each candidate second, and findings that carry the rectangles behind them. The pictures
  stay in its context.

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

A fleet is not only for testing. Each task declares its `kind`, which decides the working style and
the axis the mission splits along.

| Kind | Splits by | Isolation |
|---|---|---|
| `verify` | screen ownership | none |
| `fix` | file cluster, re-verifying each entry before repairing | worktree |
| `investigate` | hypothesis | worktree when instrumenting |
| `implement` | seam | worktree |
| `research` | source | none |
| `design` | one screen, in three waves: recon, then the primitives, then the screens | worktree |
| `critique` | one screen; a rectangle or a ratio is the evidence, never a screenshot alone | none |
| `canvas` | one screen per artboard, in stages: recon, the primitives sheet, the screens, compare, assemble | none |
| `redesign` | one screen; proposals beside the captured ones, directions sketched first | none |
| `call` | source, in two stages: the facts with their evidence, then the page a non-native speaker reads aloud; a fresh chat answers live from the same facts | none |

Splitting along the wrong axis is what makes a fleet run worthless. Two workers on one slice cost twice
and then agree with each other, which reads as corroboration and is not.

The last three are the design half, and they form a loop: critique what runs, capture it as a canvas,
propose beside it, then implement the approved artboards with the `design` kind. The canvas is a
file-based one - `<Screen>.dc.html` artboards and a `canvas.json` in the project - seeded into the editor
the harness's `design` skill carries and published as a page where the operator clicks, drags and saves.
[`docs/DESIGN.md`](docs/DESIGN.md) has the loop and the gates.

## What it is allowed to delete

A fleet runs unattended across a dozen sessions, so what it may remove from the disk is a short, closed
list rather than a matter of each worker's judgement:

1. **Its own scratch**, under `.fleet/<run-id>/`, which is declared scratch and belongs in the ignore file.
2. **The worktrees its own workers created**, under `.claude/worktrees/`, and only through
   `fleet.sh clean`.

Nothing else. There is no `git reset --hard`, no `git clean`, no `git checkout --` anywhere in the plugin,
and no recursive force-delete of a path it did not create.

`fleet.sh clean` is a dry run unless it is given `--remove`. It touches only worktrees this run registered
for itself, it **keeps** any tree carrying uncommitted changes or commits neither merged nor pushed, and it
deletes a branch only with `git branch -d`, the form that refuses unmerged work. Everything it skips is
printed with the reason.

Every deletion passes a path gate: absolute, free of `..` and of `.` segments, at least four levels below
the root, inside `.claude/worktrees/` with something after it, and never a directory containing the
shell's own working directory. Containment does most of the work; the depth floor is a second, independent
guard for the case containment cannot see, such as a worktree somebody created at `C:/wtmerge`, one slip
from the drive root. A path the gate refuses is reported as a stray, never deleted and never ignored.

The step that makes it safe is not obvious, and it is measured [M32]. A worktree usually has a
`node_modules` **junction** into the main checkout, and `git worktree remove` **follows that junction and
deletes what it points at** - eight runs out of eight on this machine, at the top level and nested,
`--force` included, exit code 0 every time. So `clean` unlinks every junction and symlink inside a worktree before anything recursive
touches it, which kept the main checkout intact in every paired run. The same applies to the harness's own
`ExitWorktree` and to any hand-rolled `rm -rf` or `rmdir /S`: unlink first, or the delete reaches past the
tree you meant. [`docs/WORKTREES.md`](docs/WORKTREES.md) has the full procedure. [`docs/SAFETY.md`](docs/SAFETY.md) is the whole
safety story: the closed list, the gate, the dry run, and why a gate beats a rule written in prose.

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

**1.1.0 answers three runs on 2026-09-01 - 12, 13 and 6 workers, 1,500 / 256 / 43 backlog rows - and the
restart that killed them.** After it, the 26 worker sessions were listed nowhere the host could still
address: a message needs a live receiver, so the only recovery this plugin had could not reach anything.
`fleet.sh recover` reads the chip register, the claims and the host's transcripts instead, and says which
workers can be reopened with their context (`claude -r`) rather than replaced. The same runs paid for the
cost accounting now in `docs/PULL.md`: the bill is turns multiplied by context - 19,535 turns against
6,421 M cached reads - and output is 0.3% of the tokens that move. And the sixth mission kind, `design`,
exists because every visual defect that sweep found lived in a state nobody designed: the loaded screen
had a designer, the loading state and the transition did not.

**1.2.0 adds the design half.** A `critique` kind whose evidence is a rectangle and a ratio: two probes
run before any screenshot, and the design probe was verified on a fixture - nine planted defects found,
zero of ten look-alikes reported (M29). A `canvas` kind that recreates the application's screens as
artboards on disk, each carrying the source files and the frame count it came from, and assembles them
into a Claude Design canvas; the pipeline ran end to end on a fixture project through the design skill's
own helper and check. A `redesign` kind that proposes beside the captured screens, states included. No
fleet has yet captured a real application this way; see "Known limits".

## Reference

- [`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md) your first fleet in fifteen minutes, for somebody who has
  never run one
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) run layout, brief format, finding schema, portability, shell traps
- [`docs/PULL.md`](docs/PULL.md) the task queue, claiming, heartbeats, budgets, asking the planner
- [`docs/MISSIONS.md`](docs/MISSIONS.md) the ten kinds and the axis each splits along
- [`docs/DESIGN.md`](docs/DESIGN.md) the design half: critique with geometry probes, the canvas on disk,
  redesign beside it, and the loop back to code
- [`docs/CALL.md`](docs/CALL.md) the call half: the facts with their evidence, the page a non-native speaker
  reads aloud, and the live chat that answers beside them
- [`docs/WORKTREES.md`](docs/WORKTREES.md) worktrees: registration, the junction measurement, and the only
  path in this plugin that deletes one
- [`docs/SAFETY.md`](docs/SAFETY.md) what an unattended fleet may delete, the path-depth gate, and the
  evidence behind writing the reason beside the rule
- [`docs/BROWSER.md`](docs/BROWSER.md) blindness, the gate, panes, viewports, round trips
- [`docs/SWEEPS.md`](docs/SWEEPS.md) checks that catch a class of defect rather than one bug
- [`docs/MOCKING.md`](docs/MOCKING.md) reaching states the sandbox data will not produce, and the line
  between a scene and a shared write
- [`docs/LANES.md`](docs/LANES.md) what a fleet is really queueing for, fan-out, and a run with no browser
- [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md) the ledger every rule cites: what was run, what was
  counted, and which rule it produced
- [`docs/BROKER.md`](docs/BROKER.md) the pane as a shared instrument work is filed against, and the
  measurement that says seven open panes carried less than one pane's worth of demand
- [`scripts/fleet.sh`](scripts/fleet.sh) the queue's bookkeeping in one call per boundary, and the only
  place the finding schema is enforced rather than requested
- [`scripts/fleet-merge.mjs`](scripts/fleet-merge.mjs) findings to a reconciled backlog, and a backlog to a
  queue a fix fleet can claim
- [`scripts/fleet-selftest.sh`](scripts/fleet-selftest.sh) the whole protocol against a temporary directory
  in about a second, with no sessions, no browser and no tokens: checks over the lane filter, the atomic
  claim, the schema gate, the clocks, the completion markers and the landing test. Run it before trusting a
  change to the plugin
- [`scripts/fleet-load.mjs`](scripts/fleet-load.mjs) what the machine is carrying right now, by class, and
  `--watch` to record it through a run. The sizing rules are derived from these numbers; this is how they
  get re-measured instead of remembered
- [`scripts/visual-probe.js`](scripts/visual-probe.js) visual defects found by geometry, so a screenshot
  confirms rather than invents
- [`scripts/design-probe.js`](scripts/design-probe.js) design defects found by geometry and computed
  style: a crooked control, an uneven row, unreadable text, a target too small, plus the page's own scale
  and its landmarks. Verified on [`scripts/fixtures/design-probe.html`](scripts/fixtures/design-probe.html)
- [`scripts/fleet-canvas.mjs`](scripts/fleet-canvas.mjs) the canvas gate and its assembly: provenance
  stamped and checked, artboards laid out, a static one rendered plain for measuring, the design skill's
  helper driven to seed the page
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
- **`fleet.sh`'s subcommands and their exit codes**: 0 done; 1 a line the schema gate refused, a walk
  served from a blind pane, or a run that has not landed; 2 wrong usage or a run this version cannot read;
  3 the queue is drained for that lane; 4 the claim is no longer yours; 5 the queue is empty but the
  planner has not closed it.
- **The four line shapes** a findings file may hold: a finding, `unreached`, `created`, `state_changed` -
  and the fields the schema gate enforces on each.
- **The marker semantics**: `.done` means finished, `.blocked` means it never saw, `.waiting` means it is
  stopped on a person, `FINISHED` means the run was landed by declaration.

Everything else is **calibration, not contract**: every prose rule, every agent brief, and every number in
this README. Those change whenever a run measures something better, and a minor version may rewrite all of
them.

[`scripts/fleet-selftest.sh`](scripts/fleet-selftest.sh) is that contract's executable form: it runs the
whole protocol against a temporary directory in about a second, with no browser and no tokens, and ends by
printing `N passed, 0 failed`. Run it after installing, and on any machine before trusting a fleet on it —
it is also the portability probe this plugin has instead of a test matrix.

## When something looks broken

Four failures that are not in this plugin, in the order they actually happen.

**A change to the plugin did not take effect.** The install is a cache, and `claude plugin update` can
report "already at latest version" while the source has moved — this is a repeatedly reported Claude Code
behaviour, not a fleet one. `claude plugin uninstall makarasty@makarasty` then `install` rebuilds it. If
the version number did not change, that is the only thing that will.

**A run directory inside Dropbox, OneDrive or iCloud.** The atomic claim is `mkdir`, which is honest on a
local filesystem and meaningless once a sync client is rewriting the directory behind you: sync conflict
resolution invents copies and renames on its own schedule. Keep `.fleet/` on local disk. A network share
is the same answer for the same reason.

**"bad interpreter" on Windows.** A `.sh` file checked out with CRLF endings makes the shell look for an
interpreter whose name ends in a carriage return. This repository pins `*.sh text eol=lf` in
`.gitattributes`, so it should not happen here; if it does, your clone predates that file.

**Git Bash not found.** Claude Code's detection of it has broken and been fixed several times, and
`CLAUDE_CODE_GIT_BASH_PATH` is the escape hatch. Nothing in the fleet can work around a shell the harness
cannot find.

## Known limits of 1.4.0

Written down rather than fixed, because a tool that hides its sample size is asking to be trusted further
than it has been tested. Full list in [`CHANGELOG.md`](CHANGELOG.md).

- **No fleet has captured a real application as a canvas yet.** `fleet-canvas.mjs` ran end to end on a
  fixture project in one session - stamp, check, layout, plain, seed, and the design skill's own check on
  the seeded page - and the commands that plan a canvas or a redesign run are written against that, not
  against a run. The compare stage's 2 px tolerance is a starting number, not a measured one.
- **The design probe was verified in one browser on one fixture** (M29): nine planted defects found, zero
  of ten look-alikes reported, one extra candidate. Its contrast reading composites ancestor backgrounds
  and cannot see an overlapping sibling; it says `approx` when it blended a translucent layer and gives up
  on an image. `offScale` and `ghostBoxes` are candidates by design, and a reader who files them unlooked
  at will file noise.
- **Publishing a canvas is the planner's manual step**, through the `design` skill's own publish rule,
  because the runtime version pin and the capability roster move with the harness and are deliberately
  not copied into this plugin. A canvas run ends with a link only if the planner does that step, and the
  skill's helper is on the machine only after `/design` has run there once.

- Every number in this README was measured on **one machine, by one operator, against one application**,
  over four runs in six days. Real measurements, weak sample.
- The **pane broker** in [`docs/BROKER.md`](docs/BROKER.md) has never run live.
- The **published install path is untested** - this release installs from a local directory marketplace.
- **Portability is half exercised**: eleven host assumptions in [`docs/PORTING.md`](docs/PORTING.md), one
  operating system actually run. The shell half is better than that — the self-test passes under both
  `bash` and `dash`, which is what `sh` is on Debian and Ubuntu — but no macOS or Linux fleet has ever
  run.
- The self-test covers mechanics. Whether a worker claims in its lane, files through the gate, or lets the
  generated banner stand is what [`evals/`](evals/) is for — and those cases have never been run, because
  `claude plugin eval` is in early access and was refused on the account this was built on.
- **`recover` cannot confirm a resume happened.** It prints the command, including the instruction that
  makes the reopened worker write its heartbeat first, but the operator runs it in a terminal and nothing
  writes anything on their behalf. That heartbeat moving in `fleet.sh status` is the only proof; until it
  does, a chip reported as reopened may be a command nobody ran.
- **A resumed session is a terminal, not the app.** It has no Browser pane and no chip tooling, and its
  transcript is full of calls that no longer resolve. Repo-lane workers come back; pane-lane workers do
  not, and nothing in `recover` says so yet.
- **The `design` kind is half enforced.** The wave order is: `after:` holds a task until its dependency
  lands, in the queue, where nobody has to remember it. Which paths a screen task may not touch, and which
  model may write markup, are prose - and this repository's own history is unkind to prose rules, see
  "Rules that stopped being rules" in [`CHANGELOG.md`](CHANGELOG.md).
- **The largest cost this release measured is not this plugin's to fix.** A session mode in which every
  permission-gated call carries a fixed extra 1.5-2 s accounts for 16.55 h of a 211 h tool wall, and 22%
  of the heaviest day (M28). It lives in the harness's permission path. Fewer shell calls reduce the
  exposure; only an allowlist or a different permission mode removes it.
- The `Stop` hook catches one shape of one failure: a claim taken within the last ten minutes whose
  heartbeat has never moved. A worker that dies an hour into a task, or after one heartbeat, is the
  planner's stall report and `fleet.sh sweep` to find, not the hook's. It also never fires for a worker in
  its own worktree, whose working directory has no `.fleet/` in it.

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
