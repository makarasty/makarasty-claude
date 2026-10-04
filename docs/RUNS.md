# Runs, with receipts

Real fleet runs: what each one was for, how it was set up, what it produced, what it cost, and what went
wrong in it. Where a run changed a rule, the entry names it, and the full story of the rule is in
[`MEASUREMENTS.md`](MEASUREMENTS.md).

## What this page is and is not

**It is a selection, not every run.** The runs below were picked to cover different mission kinds,
shapes and sizes, from a two-worker smoke test to an eighty-task run across three lanes. Others were left
out: the runs that repeat a shape already shown here, queues that were written and never worked, and one
run whose findings would identify the product. Leaving runs out does not make the ones shown look better:
the failures are written up as plainly as the successes, and several of the rules exist because of them.

**The runs come from two different projects, used in different ways:**

- **A large private TypeScript web app**: Vue front end, Node server, hosted Postgres, about 37,000
  tests. Most of its runs were browser sweeps of a live staging app, audits, and fix and refactor runs on
  the repository. It is not named, and nothing below identifies it: no product, customer, route, table or
  vendor names.
- **[Essentials](https://github.com/makarasty/Essentials)**, a public open-source Kotlin plugin for a
  multiplayer game server, about 236 Kotlin files. Its runs were repository-only: an audit, then
  fixing, hardening and test repair over two days.

**How the cost was measured.** Every number comes from the run's own directory (briefs, task files,
`.done` markers, findings, notes) or from the session transcripts the host keeps under
`~/.claude/projects/`. Usage is counted once per API message. The host writes one transcript line per
content block and repeats the message's usage on each line, so counting lines overstates turns and tokens
1.5 to 1.9 times; `fleet-retro.mjs` did that until 1.5.5. A resumed session repeats its parent's messages,
and those are counted once. Subagent transcripts are counted in their parent session.

**Dollars are API list prices**, per million tokens: Opus 5 $5 in, $25 out, $0.50 cache read; Sonnet 5
$2, $10, $0.20; Fable 5 $10, $50, $1.00; cache writes at 1.25x input for five minutes and 2x for an hour.
The runs were made on a subscription, so this is what the same tokens would cost through the API, not
what was paid. "Worker cost" is the worker sessions and their subagents. Planner sessions are named
separately where they could be told apart, because a planner chat often did other work the same day.

**Wall clock** runs from the first claim, or the first brief, to the last `.done` marker. Session
lifetimes are longer, because a session stays open after its work is done.

## At a glance

| Run | Kind | Shape | Workers | Wall clock | Result | Worker cost |
|---|---|---|---|---|---|---|
| [First eight-worker sweep](#first-eight-worker-sweep) | verify | assigned | 8 pane | 104 min | 94 findings, 3 blockers | $137 |
| [The pull run that lost three workers](#the-pull-run-that-lost-three-workers) | verify | pull | 6 pane | 4 h 57 min | 254 findings from 34 tasks | not separable |
| [Audit, then fix](#audit-then-fix) | investigate, fix | pull | 14, then 8 | 132 + 80 min | 246 findings, 38 fixed and merged | $561 + $434 |
| [Eighty tasks, three lanes](#eighty-tasks-three-lanes) | fix, implement, verify | pull | 13 | 4 h 6 min | 80 tasks, 37,296 tests green | $1,722 |
| [A read-only sweep and the fix run it fed](#a-read-only-sweep-and-the-fix-run-it-fed) | investigate, fix | pull | 12, then 4 | ~90 min active, then 3 h 51 min | 1,500 findings, then 175 tasks fixed | $743 + $1,111 |
| [The refactor that grew the code, and the one that shrank it](#the-refactor-that-grew-the-code-and-the-one-that-shrank-it) | fix, refactor | pull | 9, then 10 | 71 + 107 min | −26,794 lines, 44,654 tests green | $484 + $735 |
| [A small fix that found its own gap](#a-small-fix-that-found-its-own-gap) | fix | pull | 5 | 147 min | 14 tasks, 22 findings | $165 |
| [Measuring layout shift without a pane](#measuring-layout-shift-without-a-pane) | verify | assigned, pull | 6; 10 subagents | 92 + 31 min | 43 and 47 findings, measured in px | $69 + $42 |
| [Essentials: audit to green in two days](#essentials-audit-to-green-in-two-days) | investigate, fix, verify | pull, assigned | 4-10 per run | ~50 h calendar | 436 findings, 251 tests with 20 failing to 383 with 0 | $2,233 |

Across 21 runs and 186 sessions in both projects, about **$11,000** at list price, planner sessions
included whole, so that figure is an upper bound. **74% of those dollars were cache reads**, 16% cache
writes, 10% output, and under 0.1% uncached input. What a run costs is the number of turns times the
context each turn carries, and output is a rounding error next to it [M24].

---

## First eight-worker sweep

**2026-08-26, private web app, `verify`, assigned, 8 pane workers.**

Eight briefs on one live staging app: four on one feature area in depth, three on stability and perceived
speed with measured timings, and one hunting lists that silently truncate. The planner seeded the brief
with a real production report, a queue showing 40 rows of 158. Every worker ran the top tier and handed
its browser walks to scenario and profiler subagents.

**What happened.** All eight panes opened blind: `preview_start` returned `navOk: true` with the right
title, and the frame gate read 0 frames per second in every session. The gate caught all eight before any
observation, and the workers waited 754 seconds in total for the panes to be put on screen. Then they read
263 to 1,077 frames per second, and only then started measuring. Nobody wrote `.blocked`.

**Result.** 94 findings: 3 blockers, 33 major, 43 minor, 15 polish. All three blockers were verified;
one had its mechanism corrected later. The seeded production report could not be reproduced, because no
queue in staging had more than one page, and the run said so instead of guessing. A fix pass over the
backlog then closed 56 entries in the six clusters that recorded outcomes and refuted at least 9.

**Cost.** The eight worker sessions and their subagents: **$136.85**, 1,294 turns, 4.21 M non-cached
tokens, 163.8 M cache reads. About 6% of a weekly maximum subscription allowance. Wall clock 104 minutes
from the first brief to the last `.done`; the fastest worker finished in 33 minutes, the slowest in 96.

**What it taught.** Subagents return 1-2% of what they read, stable across all eight workers [M13]. One
worker that ran three browser walks in sequence spent 74% of its life queued behind its own pane [M14].
259 of 1,350 tool calls bought nothing [M22], and the same heredoc failure hit seven of eight workers
[M12].

## The pull run that lost three workers

**2026-08-27, private web app, `verify`, pull, 6 pane workers, 34 tasks.**

The first pull run: a queue of 34 tasks on creation flows, empty and failed states, truncation and tenant
isolation, claimed by six workers as each one came free.

**What happened.** Three of the six workers ended a turn right after claiming their next task, and sat
dead for 169, 171 and 176 minutes, holding claims nobody else could take. The planner's watch reported
new files, and there were none, so it slept through it. One status check brought all three back within
seconds. Of 1,782 worker-minutes, 748 were spent working and 537 inside a dead claim [M03, M17]. A shared
account setting flipped the role mid-run and contaminated 20 minutes of findings [M10], and 235 of 612
shell calls were protocol paperwork [M05].

**Result.** All 34 tasks drained, three re-queued and one dead claim reclaimed, in 4 hours 57 minutes.
254 findings filed, six of them as blockers; triage kept one blocker and graded the rest down, and refuted
five. 58 steps were recorded as unreached, not as clean.

**Cost.** Not separable. The six pull workers were the same six sessions that had just run a visual
sweep, and their transcripts carry both runs: $361.78 for the two together. Reusing chips across runs is
why the rule is now one chip, one run [M11].

**What it taught.** A session with nothing pending never runs again, and nothing in a fleet types into
its chat. That run is why a worker claims and starts work in the same turn, why it arms a wake-up when it
has to stop, and why the planner's watch reports silence as well as progress.

## Audit, then fix

**2026-08-31, private web app. An `investigate` audit (14 workers), then a `fix` run (8 workers).**

**The audit.** 54 tasks across the API layer and access control, outbound calls from a sandbox, one
feature area, performance and route transitions; six pane workers and seven repo workers, all on Opus 5.
132 minutes from the first claim to the last `.done`. 246 findings after dedupe: 32 blocker, 120 major,
80 minor, 14 polish, plus 59 unreached steps. One task did nothing but try to refute the blockers. It
re-read 18 and downgraded one, a blocker that the planner itself had ruled on earlier. Worker cost
**$560.56**.

**The fix run** started 44 minutes later: 32 tasks, eight workers in their own worktrees, the planner
merging. 80 minutes. Reconciled against the audit's 246 rows: **38 fixed** (14 blockers, 23 major, one
minor), 3 partly fixed, 3 refuted when somebody tried to fix them, 10 already closed, and **192 not
touched**. Three guard tests were added that fail on a new handler written the old way. Owner decisions
went into `DECISIONS.md` instead of to the workers. Worker cost **$434.29**.

**What went wrong.** The audit ended on a blocker whose whole content was that four earlier fixes lived on
a branch nobody had merged while their findings read FIXED. The fix run therefore checked every commit it
cited with `git branch --contains`, 35 of 35 reachable, in minutes [M23]. Fix briefs carried no finding ids,
so 59 of 84 ids in the fix receipts matched no backlog row and had to be paired by hand. The guard tasks
sat unclaimed for two hours, so fourteen branches merged before the guards existed.

**What it taught.** "Fixed" means merged into the branch the operator ships, checked by a command, not by
the worker's word. 3 refuted of 44 touched rows, 7%, is below the 15% that a fix run usually finds [M09].

## Eighty tasks, three lanes

**2026-09-01, private web app, `fix`, `implement` and `verify`, pull, 13 workers, 80 tasks.**

The largest run. It started from two production alerts, a monthly job timing out and a stuck mapping, and
the owner asked for one fleet that finds, fixes, tests and goes round again: a retry engine, an API
surface, an operator console, code quality and design cleanup, and three full verify rounds. 70 tasks in
the repo lane, 7 in the pane lane, 3 in the verify lane. Task-declared models: 52 Opus, 19 Sonnet,
9 Fable.

**Result.** 80 of 80 tasks done in 4 hours 6 minutes. 256 findings (24 blocker, 134 major), 61 unreached
steps, 43 of 44 questions answered. The integration branch ended 147 commits ahead. Verify round one
failed three of five stages (a guard, 6 type errors, 2 of 37,294 tests, one build error), round two
failed one, and round three was green on all five stages at 37,296 tests, signed off by a worker that had
written none of the repairs. One live production defect came out of it: a success code of `0` read as
missing, so a valid result rendered as unreadable.

**The gate catching the verifier.** One suite had gone green because two assertions were deleted: the test total fell while the pass count stayed the same. Round three's gate also refused to
start while one claim was still unmerged, which would otherwise have reported a misleading red and burned
about 40 machine-minutes.

**What went wrong.** Every defect the final verify found had been introduced behind a check that could not
run: the repository's hooks do not fire in a worktree, and the fast typecheck skips every `.vue` file. The
retry engine had no production caller for most of the run, and only verification noticed. A heartbeat
that lagged ten minutes behind a long verify stage looked like a dead worker.

**Cost.** Workers **$1,722.43**, 7,579 turns, 2.64 G cache reads. That is $21.53 per task.

## A read-only sweep and the fix run it fed

**2026-09-01 and 2026-09-04, private web app.**

**The sweep.** 48 read-only tasks over the whole app for eight classes of defect: duplication, shared
code, legacy, comments, performance, style, file splits, refactors. Twelve Opus workers fanned the reading
out to Sonnet subagents, which made 7,363 of the run's 9,258 turns. **1,500 findings** (26 blocker,
505 major), 906 established from code and 592 marked as hypotheses. The planner overturned the "strongest
finding", whose mechanism was borrowed from a different signing scheme [M09]. Worker cost **$742.89**,
about $0.50 a finding.

It took about 75 minutes of work, then stopped: the account hit its session limit at 23:41, subagents
died on HTTP 429, and all twelve workers sat until the planner revived them the next morning for the last
15 minutes of work.

**The fix run.** A queue of 274 fix tasks cut from the blockers and majors, four repo workers, Opus 5,
no subagents. **175 tasks in 3 hours 51 minutes**: 93 fixed, 14 refuted, 31 confirmed, 15 decisions
left for the owner, 123 receipts marked mutation-tested. The operator stopped it, and the 100 unclaimed tasks were
parked without losing anything. A later merge picked up 27 commits that the last wave had missed.

**Cost, and why.** Workers **$1,110.63**, about $6.35 a task, and 87% of it cache reads. Each worker's
context grew 20-30 k per task: 105 k at the first claim, 970-992 k around the thirtieth, at which point
the harness compacted all four and the climb started again. The run averaged 485 k of cache read per
turn, and over 184 claims the workers spawned zero subagents although every task said `fanout: 3` [M30].
That is where the rule came from: a worker works its first three tasks inline, then hands each further
task to one subagent and keeps its own context flat.

## The refactor that grew the code, and the one that shrank it

**2026-09-08 and 2026-09-09, private web app, the analytics area.**

**The refactor.** 28 tasks over the whole analytics surface: streaming export, batching, honest numbers,
splitting god files. Nine workers, 71 minutes. 128 findings dispositioned: **96 fixed, 32 refuted**, a
quarter. 73 commits across 232 files, merged and pushed, the full suite green at 44,674 tests with zero
type errors. Source code grew by 2,510 lines net. Worker cost **$483.68**, planner $93.98.

**The shrink.** The next day: cut the same area by 25% with zero behaviour change, comments treated as a
budget, duplicates merged, tests deleted only with mutation proof. Ten workers, 61 subagents, 107 minutes,
15 tasks (5 of them added when guards went red).

| | before | after |
|---|---|---|
| lines | 152,358 | 125,564 (−17.6%) |
| comment share, source | 31.0% | 16.4% |
| comment share, tests | 26.3% | 15.0% |
| files at least 40% comments | 149 | 32 |
| comment blocks of 20+ lines | 112 | 13 |

**The target was missed, and the workers said so.** Four refused their per-task targets with arithmetic;
one showed that deleting every comment in its cluster would still reach only −27.2%. 91% of the cut was
comments; code lines fell 3.0% in source and 1.2% in tests. One comment-only edit deleted real code, and
only a code-only diff script caught it. 44,654 tests pass, merged and pushed. Worker cost **$735.37**,
planner $51.59, about $29 per thousand lines removed.

## A small fix that found its own gap

**2026-09-03, private web app, `fix`, pull, 3 repo and 2 pane workers.**

An id column exported with a type prefix was coerced to a number on import, became `NaN`, and dropped
rows. The run's job was the whole class of that defect: sibling readers, reporting, the export-import
round trip, the docs.

The queue grew from 10 tasks to 14 while it ran. A worker found that the fix just landed never reached
the browser-side payload builder, which coerced the id again. The planner's inventory listed 6 readers of
the column; a worker counted 18, and a new task swapped ten of them. A pane worker saw `navOk: true` at
0 frames per second, then 300 once the pane was displayed [M01]. 22 findings (7 major), 11 set aside, most of
them refuted, merged to the main branch. 147 minutes, workers **$165.45**, planner $75.46.

## Measuring layout shift without a pane

Two runs on the same question: what makes the page jump while it loads.

**2026-09-01, `verify`, assigned, 6 workers.** Instead of the browser pane, the planner wrote a headless
Chromium harness, so the evidence could not be blind. 92 minutes, 43 findings (14 major), each number
with its viewport, zoom and repeat count. One tab click scored a layout shift of 0.3234, identical over
5 runs; a filter bar pushed the outgoing page down 70.9 px; one skeleton reserved two thirds of the height
it needed. Workers **$68.50**. Its findings are why the `design` mission kind exists.

**2026-09-14, `verify`, pull, 10 Sonnet subagents under one Opus planner, 239 routes.** 31 minutes of
work, 47 findings (7 blocker). The header skeleton was 72 px tall against a real header of 79.7 px at
1600 px wide and 137.7 px at 1280: the calibration width was the one width that hid a 65.7 px gap. A
dashboard flickered 14, 2, 14, 2 skeletons while its layout-shift score stayed 0.0005, so the score can
call a flickering page clean. Workers refuted three of their own harness's false positives before filing.
**$41.76** in total, planner included.

## Essentials: audit to green in two days

**2026-09-08 to 2026-09-10, [Essentials](https://github.com/makarasty/Essentials), repo lane only.**
Six runs in a row, each one picking up what the previous one left.

| Run | Shape | Wall clock | What it did | Worker cost |
|---|---|---|---|---|
| Audit | pull, 10 workers, 29 tasks | 41 min | Read every line of the plugin, the engine it runs on and the companion bot. 436 findings: 37 blocker, 182 major. | $179.31 |
| Fix the blockers | assigned, 9 workers | 84 min for six of nine, the rest the next morning | Re-verified each blocker before fixing it, one reviewer subagent per fix, a test that fails first. 56 commits. Roughly one blocker in six was refuted or re-diagnosed. | $582.66 |
| Cut the comments | assigned, 4 workers | 13 min | The fixes had added 396 comment lines to 1,284 added lines. 521 to 458, no code line changed. | $62.44 |
| Harden on real databases | assigned, 8 workers | 3 h 22 min | Booted the schema on real MariaDB 12.3 and MySQL 8.4. Found three deploy-blocking defects, every one of which had passed the whole H2 suite, and reproduced an old server instance reverting bans and mutes. | $216.58 |
| Make the suite green | assigned, 4 workers | 78 min for three of four | 251 tests with 20 failures, none a regression. Fixed 16 failures caused by tests interfering with each other, measured over 8 full runs. 255 tests, 0 failures, twice in a row. | $239.75 |
| Close the backlog | pull and waves, 25 work units over five successive planners | about 30 h calendar | 154 open findings re-verified, reviewed and tested. 383 tests, 0 failures, **10 green runs of 10**. | $951.89, undercounted |

**Total, workers:** $2,232.63, an undercount, since only 6 of the backlog run's 25 completion markers could
be matched to a session; about 50 hours of calendar time, 196 commits on a local main branch that had not
been pushed when these runs ended.

**What it taught.** One green run is not a green suite: the backlog run measured the suite green in only
about two of three runs while earlier planners had each reported a single green, and a run with 36 skips
was thrown out before its passes were counted. A test database that is not the production engine hides
exactly the defects that stop a deploy. `git cherry` caught three branches that looked unmerged and were
not. One recorded option that would have locked all six servers out was caught by reading the source
before applying it.

---

## What the numbers say together

- **The bill is turns times context.** Cache reads were 74% of every dollar. The most expensive run per
  task, $6.35, was the one whose workers held 500 k of context per turn; the cheapest broad sweep, about
  $0.50 a finding, fanned its reading out to subagents [M24, M30].
- **A tenth to a quarter of findings do not survive a fix attempt.** 32 of 128 in one refactor, 14 of 138
  in one fix run, 3 of 44 in another, one blocker in six in Essentials. The gate between finding and fix exists for these
  [M09].
- **"Done" needs a command behind it.** Merged into which branch, green over how many runs, measured with
  which spread.
- **Silent stalls cost more than slow work.** Three dead workers cost 537 of 1,782 worker-minutes in one
  run, and an account limit stopped twelve workers overnight in another.
