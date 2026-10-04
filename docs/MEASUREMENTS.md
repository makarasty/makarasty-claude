# The measurement ledger

Every rule in this plugin came from a run that went wrong in a specific, counted way. The rules carry the
**number**; this file carries the **story** — what was run, what was counted, how, and which rule it
produced.

Read it when you disagree with a rule, when you are about to remove one, or when you want to know whether
a number still describes the world. Do not read it to work a task; the rules can be followed without it.

**Format.** Each entry has an id (`M01`), the date and run, the numbers, the method, the rule it produced,
and a status. `current` means the last measurement still supports it. `superseded by Mnn` means a later
run measured the same thing differently, and both are kept, because a number that was replaced is the only
way to tell a fact from a habit.

Rules cite entries as `[M07]`. `scripts/fleet-selftest.sh` fails when a citation names an entry that does
not exist here, and when an entry is cited nowhere and is not marked `uncited: deliberate`.

---

## M01 — A pane that is not displayed reports fiction
**2026-08-24 to 2026-08-26**, three sessions and one worker, Claude Code's in-app Browser pane on Windows.
A pane that is not displayed on screen stops compositing while still navigating, still loading, and still
returning plausible DOM. Screenshots time out at 5 s, `requestAnimationFrame` never fires, transitions
freeze at their start value, virtualised rows read as empty, and one in-page axios POST sat to its 180 s
timeout while `curl` answered the same endpoint in 4 s. Page text length was identical (157 characters)
live and blind; `preview_start` returned `navOk: true` with the correct title on a pane compositing zero
frames.
**Rule:** the frame gate, and only the frame count separates live from blind.
**Status:** current.

## M02 — Eight of eight panes opened blind, and the gate caught every one
**2026-08-26**, first eight-worker run. All eight panes opened blind: `preview_start` returned `navOk: true`
with the right title and the frame gate read 0 frames per second in every session. Every worker stopped,
asked for its pane to be displayed (754 s of waiting in total), read 263 to 1,077 frames per second, and
only then measured. Without the gate all eight would have filed findings from a pane that was not drawing.
*Corrected 2026-10-04: this entry used to say the run produced 94 findings nobody could have observed. The
run's own analysis shows the 94 were taken after a live reading.*
**Rule:** gate before the first visual step and again before each later batch; a worker that stays blind
writes `.blocked` and no findings.
**Status:** current. Two later runs, 22 workers, zero blind after the gate landed.

## M03 — A session with nothing pending never runs again
**2026-08-27**, run `2026-08-27-create`, six workers. Three ended a turn immediately after claiming their
next task and sat dead for **169, 171 and 176 minutes**, each holding a claim, each having written a
confident summary of what it was about to do. A cross-session status check revived all three within
seconds.
**Rule:** claim and begin in the same turn; never end a turn with nothing pending; the planner's watch
reports silence as well as progress.
**Status:** current.

## M04 — The abort clock nobody stopped
**2026-08-31**, two runs, 22 workers. **87 clocks armed, 0 stopped.** Sessions stayed alive **1,090
minutes** past their own completion markers and burned **282 model turns** answering wakes with nothing to
do; one worker was still being woken 74 minutes after it finished. Counted from the workers' transcripts
against their `.done` marker times.
**Rule:** a clock watches the disk that closes its obligation and exits by itself. Asking the worker to
stop it was tried first and obeyed zero times out of 87.
**Status:** current.

## M05 — Protocol paperwork was 38 percent of the shell calls
**2026-08-27**, six-worker run: **235 of 612 worker shell calls** were bookkeeping — 49 claims, 52 owner
writes, 44 reads of `ready/`, 56 finding appends, 16 heartbeats, 13 done markers. Every one was a model
round trip that produced no observation.
**Rule:** one call per boundary, in `fleet.sh`.
**Status:** current.

## M06 — A missing argument took the helper down with it
**2026-08-31**, 14-worker run. `fleet.sh next` could not filter by lane, so three workers claimed browser
tasks they could not do. The planner's workaround was a paragraph pasted into 9 of 14 chip prompts telling
workers to walk `tasks/ready/` by hand, which produced **73 hand-rolled claims beside 113 helper ones**.
**Rule:** `next` takes the lane. A gate is a package deal: when the helper lacks something workers need,
they abandon the helper and every gate inside it.
**Status:** current.

## M07 — The claim and its owner file must be one command
**2026-08-27**: a worker won `task-12`'s `mkdir` as the last action of a turn with the `owner` write queued
next. The turn boundary landed between them and the claim sat ownerless for **twelve minutes**, which from
outside is indistinguishable from a worker that claimed and walked away — so the planner reclaimed a live
worker's task.
**Rule:** claim and `owner` in one command; an ownerless claim has a floor of one budget before reclaim.
**Status:** current.

## M08 — Heartbeats are optional in practice
**2026-08-27**: the one-term dead-claim test (heartbeat equals claim time) produced **five false positives
against one chip** — `task-18`, `-24`, `-27`, `-31`, `-33`, every one with a done marker, 95 KB of findings
and a clean `.done`. That worker completed all five and never rewrote a heartbeat.
**Rule:** the three-term test — stale heartbeat **and** no done marker **and** more than one budget passed.
Treat a missing heartbeat as no evidence rather than evidence of death.
**Status:** current.

## M09 — Fifteen findings in a hundred are refuted when somebody tries to fix them
**2026-08-26**, a fix mission working 100 findings refuted roughly 15. The refuted ones carried evidence
that looked exactly like the evidence on the true ones: a real symptom with an invented mechanism.
**Rule:** `observed` and `mechanism` are separate claims, and `mechanism_status` says how far you got.
**Status:** current.

## M10 — A shared account makes a setting a fleet-wide write
**2026-08-27**: the visible-column selection, the analytics dashboard card set and the general settings
group are stored per account, so one worker's save changed what five others were looking at. An active
role changed mid-run and the rest of that run's lists returned 403 with badges reading 0 — indistinguishable
from a defect until somebody named the window.
**Rule:** `state_changed` lines, written the moment you notice, with an `ask/` beside them.
**Status:** current.

## M11 — One chip, one run
**2026-08-27**: six sessions titled for a visual run worked a second unrelated queue for five hours under
those titles. The planner had to identify them by what they had recently written, and every turn of the
second run paid for the first run's context again.
**Rule:** a worker session works one run and then stops.
**Status:** current.

## M12 — Two shell shapes hit almost every worker
**2026-08-26**, eight-worker run, 47 errors. A heredoc piped into an interpreter that waits on stdin hung
seven workers of eight; a `cd` in one call not persisting to the next hit six of eight.
**Rule:** write files with the harness's write tool, keep `cd` and the work in one call, use absolute paths.
**Status:** current.

## M13 — Delegation economics
**2026-08-24**: a Haiku subagent driving three tool calls spent **45,775 tokens**, nearly all of it startup
— system prompt and tool schemas before it does anything.
**2026-08-26**: executor return ratio 0.96–2.04 percent across a run, stable, while the denominator varied
tenfold (30 calls / 4.0 M cached against 194 calls / 55.6 M).
**Rule:** three subagents is the default fan-out width and a fanned-out part must be worth a slice of work,
not one lookup. What a run costs is decided by how much the executor looked at, never by how much it said.
**Status:** current.

## M14 — A worker waiting on its own subagents
**2026-08-26**: the worker holding a task that needed three sequential browser spawns spent **74 percent**
of its life queued behind them, because browser subagents drive the parent session's single pane.
**Rule:** one browser spawn per brief; claim one repo task during the wait.
**Status:** current.

## M15 — The pane lane is mostly idle
**2026-08-31**, two runs. Seven panes carried **104 minutes** of actual browser driving across a 153-minute
run — no pane busy for 38 percent of it, peak three at once, one pane held 61 minutes and driven zero. The
fix run after it opened two panes and drove them for three minutes. Reconstructed from the workers'
transcripts: every browser tool call and every delegated scenario, overlapping intervals merged.
**Rule:** the pane lane starts at two; the display's five is a ceiling, not a target.
**Status:** current.

## M16 — Task throughput is not one number
**2026-08-27**: the median task took 23 minutes, roughly 20 of them one delegated browser scenario, which
put a pane worker at about **2.6 tasks an hour**.
**2026-08-31**: two repo-heavy runs measured **2.87** and **4.25** tasks an hour per worker, from
done-marker timestamps across the span between the first and the last.
**Rule:** size the repo lane from the ready queue, not from a browser constant.
**Status:** current. The 2.6 figure describes a browser-heavy pane worker and nothing else; for repo work
the two 2026-08-31 numbers in this entry are the current ones.

## M17 — A watch that reports only good news
**2026-08-27**: three of six workers stalled at the same minute, no file changed for nearly three hours,
the watch stayed silent because silence was all it had to say, and the planner slept **65 minutes** until
the operator typed "I think the chat has hung". In the same run a watch left armed after its run finished
ran for **five hours and forty two minutes**.
**Rule:** the quiet timer, the stall report naming every outstanding claim, and `fleet-collect` stopping
the watch as its last act.
**Status:** current.

## M18 — Notifications that cost a turn each
**2026-08-27**: of 62 notifications one planner received, **13 were claims it took no action on**, each
costing a full model turn to read and dismiss.
**Rule:** a claim is tracked in `seen` and named in the stall report, but does not wake the planner.
**Status:** current.

## M19 — An answer filed under a name nobody looks up
**2026-08-31**: a planner answered four questions in one file named after none of them
(`answers/05-1-2-3.md`) plus a broadcast. An hour later `status` still listed all four as unanswered,
because a worker looks for `answers/<its own id>.md`. In the same nine minutes four workers filed the same
broken tool, two of them after it had already been fixed.
**Rule:** `fleet.sh answer` writes one text under every id it settles; `fleet.sh broadcast` carries what
everyone needs.
**Status:** current.

## M20 — The pane question arrived after the operator had moved on
**2026-08-31**, six pane workers: the first gate ran between **1 and 7 minutes** after the chip, and the
pane question landed between **1 and 34 minutes** after it, so the operator answered them one at a time
across half an hour instead of in one pass down the row of chats.
**Rule:** gate first, ask in the same turn as the first blind reading, and keep `.waiting` as the second
channel.
**Status:** current.

## M21 — What a session and a pane cost in memory
**2026-08-31**, one desktop, 31.2 GB, 16 cores, measured by opening a pane and closing it again with the
process table sampled either side. An agent session with no pane: **~330 MB** resident, largest of fourteen
389 MB. One displayed pane on a local single-page app: **+344 MB**, one renderer process, returned in full
within seconds of closing the tab. Fourteen sessions and six panes together: 4.4 GB plus 1.9 GB, no page
file growth.
**Rule:** the repo lane is not memory bound on a modern machine; size it from the queue.
**Status:** superseded by [M34]. The numbers here are still right and the conclusion drawn from them was
not: the application under test that day was a local single-page app, and +344 MB is what a light page
costs. A page with 150,000 nodes measured 2,061 MB in the same kind of process, on the same box, which is
six times this entry's whole pane budget in one tab. What a pane costs is a property of the project, not of
the plugin, so it is measured per project rather than quoted from here.

## M22 — Tool calls that bought nothing
**2026-08-26**, eight-worker run: **259 of 1,350 tool calls were avoidable** on a conservative count, 473
at the upper bound. Two workers spent 33 tool calls each on the same page, 219 s and 322 s.
**Rule:** read state through expressions that return small JSON; reserve screenshots for questions about
pixels; batch independent reads.
**Status:** current.

## M23 — A fix recorded as landed while it sat on an unmerged branch
**2026-08-31**: the audit run ended with a blocker whose whole content was that four fixes lived on a
branch nobody had merged while their `conditions` field read FIXED. The fix run that followed checked every
cited commit with `git branch --contains`: **35 of 35 were on the branch**, and the check took minutes.
**Rule:** a run that claims a fix names the commit, and collection verifies it is reachable.
**Status:** current.

## M24 — The bill is turns multiplied by context
**2026-08-26 to 2026-09-01**, seven runs, 57 worker sessions, read from the session transcripts:
**19,535 turns**, 11,450 tool calls, output **20.4 M** tokens (thinking 5.7 M, 28%), cache write 93.4 M,
cache read **6,421 M**. The average turn carried ~330 k cache-read tokens; per-worker context averaged
240-530 k with a peak of 882 k. Output is 0.3% of the tokens that moved. Of everything the models emitted,
chat prose was **5% by characters** and tool input 95% — so compressing narration cannot be the lever, and
the emitted bulk was the work itself: 2,647 KB of `Write` into repository source, 2,045 KB of `Bash`
heredocs over 2 KB, 1,022 KB of `Write` into docs, 709 KB of `Edit` into source.
**Rule:** cut turns and keep context flat; move bulk with the shell into files and read it back as a count
or a slice. Do not spend effort compressing what a worker says.
**Status:** current. *Recounted 2026-10-04:* the host writes one transcript line per content block and
repeats the message's usage on each, and these totals were most likely summed per line, as
`fleet-retro.mjs` did until 1.5.5. Counted once per API message, the worker sessions of ten runs from the
same dates read 5,407 M cached over 16,711 turns, against 8,992 M over 28,927 turns per line: about 1.7x
fewer. Shares and per-turn figures hold, because the double count is uniform (324 k per turn against
311 k). Dollars for every run since are in [`RUNS.md`](RUNS.md).

## M25 — Reading a file through the shell, and the ratio that is not what one day said
**2026-09-01**, 26 workers, 9,924 tool calls: latency p50 `Read` 9 ms, `Grep` 60 ms, `Bash` **1,892 ms**
(p90 6,836 ms); 209 `cd && cat` calls cost **3,284 s**; **78 `Edit` calls failed with "File has not been
read yet"** because the file had been read through the shell, each costing three round trips instead of
one. Tool execution was 7.32 h against 22.39 h of model-turn time, so tools were **24.7%** of active time.

**Re-measured on a second machine over the whole corpus** — 899 sessions, 261,308 paired calls,
2026-06-10 to 2026-09-02 — and the one-day ratio does not survive. `Bash` p50 is **173 ms** there, not
1,892; that day's figure was inflated by the classifier stall in [M28], which is a session mode rather
than a property of the tool. Tool against shell equivalent, by p50: `Read` 6 ms against `cat`/`head`/`sed`
80 ms (**13x**), `Grep` 57 ms against shell grep 113 ms (**2x**), `Edit` 74 ms against in-place `sed` 86 ms
(**1.2x**), and `Glob` 358 ms against `find`/`ls` 116 ms — **the shell is three times faster**, the one
inversion. The same corpus confirms the refusals: 187 "File has not been read yet" of 371 `Edit` errors,
78 of them on that single day.

**Rule:** `Read` a file you are going to `Edit` — that is a precondition of the harness, not a speed
argument, and it is the only one of these differences big enough to change behaviour on its own. `Grep`
over shell grep for a search whose result the model must read. Use the shell for `find`-shaped listing,
for running things, and for moving bulk between files without the model in the middle. Do not repeat "the
shell is two orders of magnitude slower": on one machine over one day it was, and across a corpus it is
not.
**Status:** current, and the corrected half is the one to quote.

## M26 — The permission classifier is a width limit
**2026-09-01**: **39 tool calls hard-failed** with `claude-sonnet-5[1m] is temporarily unavailable
(rate-limited), so auto mode cannot determine…`, plus 16 refused by the same classifier, all inside one
hour while **25 workers** ran. The failures land on shell calls, which are what the classifier judges.
Confirmed on a second machine over 261,308 calls: **5,601 errored (2.1%), of which 1,060 are
infrastructure** — 460 classifier denials, 412 timeouts, 94 model-unavailable, 94 rate-limit — and the
rate-limit messages all name the same cause, the auto-mode classifier being unreachable. On that day they
land in 24 distinct minutes between 19:27Z and 20:28Z.
**Rule:** fewer shell calls per worker raises the width the machine will carry; if a run must be wide, take
it off the auto permission mode rather than retrying into the same limit. See [M28] for the larger, quieter
half of the same mechanism.
**Status:** current.

## M28 — The classifier's slow mode costs more than every other tool habit combined
**Measured on a second machine**, 899 sessions, 261,308 paired calls: some sessions pay a fixed extra
**~1.5-2 s on every call that needs a permission decision**, and the tools that need none are untouched,
which is what rules out the machine simply being loaded. Gated calls in the slow population (108 of 500
sessions): p10 75 ms, **p50 2,081 ms**, p90 6,164 ms. Gated calls in the normal population: p10 58 ms,
**p50 102 ms**, p90 3,542 ms. Ungated `Read`/`Grep`/`Glob` across both: p50 **9 ms**. The p10 barely moves
between the two populations, so the floor never rose — a fixed cost is being added per decision. It
switches on and off inside one day: cheap shell commands ran at a 1,571 ms p10 during 16Z-18Z and at
60 ms during 19Z-20Z, with MORE sessions running in the later hours, so it is not concurrency either.
Arithmetic: 30,110 gated calls in slow-mode sessions at a median excess of 1,979 ms is **16.55 h of a
211 h tool wall**; on 2026-09-01 alone it is **3.47 h of 15.99 h, 22%** — roughly seven times what
eliminating every `Edit` retry in [M25] would buy.
**Rule:** the first thing to fix on a slow fleet is not the tool mix, it is how often the classifier is
consulted at all: allowlist the shapes a run actually runs, or take the run off auto mode. Re-check the
gated/ungated p50 split before blaming latency on the machine.
**Status:** current. Cause is the harness's permission path, not this plugin, so this ledger entry is a
constraint to design around rather than a defect to fix here.

## M27 — After a crash there is nothing left to message
**2026-09-01**: following a restart, the **26 worker sessions** of two runs were absent from `ListAgents`
(which listed five unrelated chats started minutes earlier) and from the app's own session list, archived
rows included. The revive message — the only recovery this plugin had — had no receiver. What survived:
`chips/<session-id>`, the standing claims, and every transcript under `~/.claude/projects/`, which is
enough to reopen a worker with its context intact.
**Rule:** revive is for a session that stopped, `fleet.sh recover` is for one that no longer exists. A
claim whose chip never registered a session id is UNKNOWN, not dead — that is what `sweep` is for.
**Status:** current.

## M29 — The design probe against a fixture of planted defects
**2026-09-03**, one browser (the in-app pane, live at 302 frames), one fixture,
`scripts/fixtures/design-probe.html`: nine planted defects — a button 3 px below its centred row, gaps of
8/8/14, a 32 px input beside a 36 px button, `#999` text on white (2.8:1), a 16 px icon button, a 200x100
image drawn at 200x150, an empty bordered box, a 1,400 px paragraph at 14 px, a 13 px padding on a page
whose scale is 8/16/24 — beside ten controls built to look like defects and not be: a centred row of
mixed heights, a gap-driven row, an auto-margin push, 7:1 secondary text, an inline link, a 40 px icon
button, an image at its natural ratio, a bordered box with content, a self-centred child in a column, a
wrapped row. **Nine of nine found, zero of ten reported**, one candidate beyond the nine (the page's only
20 px heading, listed under `offScale`). The first draft counted the 13 px padding once per side, four
votes from one element, which put it on the scale; the probe counts a value once per element now. It also
listed an empty `<input>` as a ghost box; form controls are exempt now.
**Rule:** the probe proposes and the agent disposes. `offScale` and `ghostBoxes` are candidates for a
zoomed screenshot, never findings on their own; the seven other categories are findings at the numbers the
probe reports.
**Status:** current. One browser, one fixture. Re-verify by serving the repository over http, opening the
fixture in a live pane, and pasting the probe.

## M30 — A worker's context grows about 25 k per task, and every long worker hit the ceiling
**2026-09-04**, run `fix-2026-09-04-code`: four paneless workers, 175 tasks in 3 h 50 min, read from the
five transcripts (worker 04 has two; the app restarted under it). Context at the first claim: **105-108 k**.
Context at each later claim climbed **20-30 k per task**, near linearly: worker 01 stood at 982 k at its
30th claim, 02 at 970 k at its 28th, 03 at 992 k at its 43rd, 04 at 991 k at its 35th. **All four then
compacted** - the harness summarised the conversation and restarted it at 106-141 k - and the climb
resumed at the same slope (01: 141 k to 467 k over the next 12 tasks). Cache read for the run: **2,414 M**
tokens over 5,157 turns, **471 k per turn**, the highest of any run in this ledger; the 200 turns before
each compaction ran at 830-990 k each. **Agent spawns across the four workers: zero**, over 184 claims,
with `fanout: 3` written into every task's reach. Turns per task: 26-38.
**Arithmetic, not a measurement:** a task worked inline by a worker already holding n tasks' worth of
context costs about 30 x (105 k + 25 k x n) of reads; the same task in a fresh subagent costs about
30 x 60 k plus a few parent turns, near 2.5 M whatever n is. At n = 3 the inline task is already dearer;
at n = 25 it is eight times dearer. What the first tasks buy inline is the worktree, the junctions and the
traps, which is why the notes file exists.
**Rule:** a repo worker works its first `delegate_past_tasks` tasks inline (calibration.json, 3), writes
the traps into its notes, then hands each further task to ONE subagent and keeps its own context flat.
`fleet.sh next` prints `DELEGATE` at that point, because the rule sits on a path the worker already walks
and a prose rule about fan-out was obeyed zero times in 184.
**Status:** current. The saving is derived and not yet measured on a run; `fleet-retro.mjs` now prints
context per turn, peak context and compactions per worker, so the next run measures it. *Recounted
2026-10-04* once per API message, with the resumed transcript counted once: 3,995 turns, 1,937 M cache
read, 485 k per turn, $1,110.63 at list price, 87% of it cache reads.

## M31 — The shell reads came from the harness's own instruction, not from the workers
**2026-09-04**, the same run: worker 01 made **1,095 `Bash` calls against 6 `Read`, 10 `Edit` and 62
`Write`**; across the four workers 704 of 3,365 shell calls read a file, and **12 `Edit` calls were refused**
with "File has not been read yet" - the [M25] shape, on its third run in a row (9 on 2026-09-03, 78 on
2026-09-01). The cause is in the session prompt: in the auto permission mode the harness tells the model
to read with `cat`, `head` and `sed -n` and to change files with `sed` and heredocs rather than with the
`Read`, `Edit` and `Write` tools, and every fleet worker on this machine runs in that mode. A prose rule
in `PULL.md` saying "Read before Edit" was arguing with the system prompt, and lost every time.
**Rule:** edit with what you read with. A file the shell read is changed with `sed -i`, a heredoc or a
short script; `Edit` is for a file this session `Read`. Mixing the two on one file is what pays three
round trips.
**Status:** current.

## M32 — `git worktree remove` follows a junction and deletes what it points at
**2026-09-08**, Git 2.53.0.windows.2 under Git Bash on Windows 11, in a scratch repository built for the question. A
worktree under `.claude/worktrees/` with a `node_modules` **junction** into the main checkout's
`node_modules`, which held a marker file. Then, per case, one removal method, with the marker checked
afterwards:

| method | runs | main checkout's `node_modules` |
|---|---|---|
| `git worktree remove <wt>` with the junction in place | 8 | **contents deleted**, every run |
| `git worktree remove --force <wt>` with the junction in place | 1 | **contents deleted** |
| `rm "<wt>/node_modules"` first, then `git worktree remove` | 1 | intact |
| `cmd rmdir "<wt>\node_modules"` (no `/S`) first, then `git worktree remove` | 1 | intact |

The eight are one repeated trial of seven - five without a remote configured, two with - plus the single
run in the method comparison. Exit code 0 every time, so nothing about the failure is visible to a caller.
The remote is not the variable. The recursive delete inside `git worktree remove` walks into the reparse
point and removes the target's contents; `--force` does the same. Unlinking first removes the link and
never what it points at.

The unlink-first rows are one run each, which is thin. `fleet-selftest.sh` re-asserts them on every run:
it builds a real junction, runs `clean`, and fails if the main checkout's marker file is gone.

Two earlier answers to this question were both worthless, in the same direction and for different reasons.
A harness bug meant the main `node_modules` was never created, so four cases reported a loss that could not
have happened; an incidental run before it reported the opposite from a junction that had silently failed
to be created. Neither counted. The number above is from a test rebuilt to create fresh state per case and
to repeat.

**Rule:** unlink every reparse point inside a worktree before anything recursively deletes that worktree -
`git worktree remove`, the harness's `ExitWorktree`, `rm -rf` and `rmdir /S` alike. `fleet.sh clean` does
it in that order and is the only path in this plugin that removes a worktree; it is a dry run unless given
`--remove`, it keeps any tree with uncommitted or unmerged-and-unpushed work, and it deletes a branch only
with `git branch -d`. Full procedure in [`WORKTREES.md`](WORKTREES.md).

**The enforcement existed and did not run, 2026-08-08 to 2026-09-10.** `fleet.sh unlink` refused every
call made the way every document here describes it - from inside the worktree - because its guard treated
a path containing the shell's working directory as unsafe and a path contains itself. Worktree
registration refused itself for the same reason, and across every run on this machine the number of
worktrees registered was zero, so `clean` never had one to act on either. The guard is right for a
command that deletes the tree and wrong for two that do not; both now pass a flag that drops that term,
and `clean` keeps it.
**Status:** current.

## M33 — What actually stops a pane compositing is the tab and the taskbar, not the screen
**2026-09-10**, one Claude Code desktop session on Windows 11, the in-app Browser pane holding
`scripts/fixtures/design-probe.html`. A sampler was installed in the page and left running for 463
seconds while the operator moved the pane through six states by hand; it recorded, once a second, the
frames `requestAnimationFrame` delivered in that second, `innerWidth`, and `document.visibilityState`.

| The pane is | frames/s | `innerWidth` | `visibilityState` |
|---|---|---|---|
| not the active tab of its window | **0** | 0, or its last laid-out width | hidden |
| in a window minimised to the taskbar | **0**, with stray seconds of 2 to 4 | last width | hidden |
| fully covered by another window | 300 | real | visible |
| in a window on a second monitor, mostly covered | 300 | real | visible |
| in a window pushed entirely off the screen (`screenX` 5032) | 300 | real | visible |
| the active tab, on screen | 285 to 301 | real | visible |

Three transitions, second by second, as the operator switched away from the chat and back:

```
16s   0f/1239px/visible     the tab is selected; the first second still delivers nothing
17s 285f  18s 242f  19s 165f
21s  57f/hidden             the second the operator left the tab
22s to 164s   0f/1239px/hidden        142 consecutive seconds, width unchanged throughout
164s  0f/1239px/visible     back on the tab; again a first second with nothing
165s 271f, then 300, 300, 299, 301, 299, 300, 301, 300, 299, 301, 300, 300
```

And into and out of a minimised window:

```
391s 300f/visible   393s 239f/hidden   394s 4f   395-398s 0f   399s 2f   400s 0f
```

Four things this contradicts. **Physical visibility is irrelevant**: covered, half off a second monitor,
and wholly off-screen all held 300 frames. The plugin's ceiling of five panes, justified by how many fit a
monitor, was measuring the wrong constraint. **`innerWidth` is not a gate**: it stayed at 1,239 through
142 seconds of zero frames. **`document.visibilityState` is not a gate either**: it reported `visible` on a
pane delivering zero frames immediately after a screenshot was taken of it. **The host's own flag is not a
gate**: `tabs_context` answered `The Browser pane is currently displayed` while the page in it delivered
zero frames at a width of 949 px.

Two behaviours the earlier entries did not name. A tab becoming active delivers **zero frames in its first
second**, at 16s and again at 164s, so a gate run the instant an operator says they have opened the pane
reads blind and sends the worker back to ask for a pane that is already open. And a minimised window emits
**stray single seconds of 2 to 4 frames**, which is the mechanism behind the rule that a reading between 1
and 59 is blind: a `frames > 0` check would have passed that worker.

`setInterval` divides on the same line, and its behaviour is worse than silence. With the pane not laid
out at all the sampler ticked 3 times in a minute — it advances only when a tool call pokes the page. With
the pane laid out but not compositing it ticked **142 times in 142 seconds**, one per second, exactly on
time, while the page drew nothing. A timing series taken there is clean, plausible, correctly spaced and
about nothing.

**Rule:** the frame gate stands, and the frame count remains the only thing that separates live from blind
[M01]. What changes is the operator's obligation and the ceiling. A pane is live when its tab is the
selected tab of a window that is not minimised; it does not need focus, the screen, or an unobstructed
view. So a fleet may hold as many live panes as it has windows, each pushed wherever the operator likes,
including off the screen entirely — and the pane ceiling is memory [M34] rather than monitors. Gate twice
with a second between, because the first second after a tab is selected delivers nothing.
**Status:** current.

## M34 — A pane costs one renderer, and the renderer costs whatever the page costs
**2026-09-10**, the same session and machine: 31.2 GB physical, 16 cores, with the operator's own parallel
work running throughout and a memory trimmer active. Every point was sampled twice, and machine load was
recorded beside every number because the trimmer moved the totals during the run.

| Point | claude.exe processes | renderers | renderer total | free | commit |
|---|---|---|---|---|---|
| pane open, one trivial tab | 46 | 8 | 1,844 MB | 14.3 GB | 34.6 GB |
| pane closed | 45 | 7 | 1,730 MB | 14.3 GB | 34.6 GB |
| reopened, one trivial tab | 46 | 8 | 1,844 MB | 14.4 GB | 34.6 GB |
| a second tab added | 46 | 9 | 1,882 MB | 14.9 GB | 33.5 GB |

**A pane is one renderer process per tab and about 113 MB of it**, reproduced to within one megabyte by
closing and reopening. The two tabs' own processes read 132 MB and 125 MB.

Then 150,000 DOM nodes were built into one of those tabs:

```
that renderer   132 MB -> 2,061 MB
free            14.9 GB -> 12.0 GB
commit          33.5 GB -> 36.3 GB     against 31.2 GB physical
```

**The pane is nearly free and the page is not.** One tab holding a large document cost 1.9 GB, and nothing
about the pane bounds that: the cost is the application under test.

Two findings beside it. **A reload does not give the memory back** — after `location.reload()` the same
renderer read 2,141 MB, and only closing the pane returned it. A worker that has walked a heavy application
holds those gigabytes for the rest of its session. And **the process family's total is not a usable
instrument on this machine**: while a tab was being added, the sum over `claude.exe` fell from 5,265 MB to
5,040 MB because the trimmer was working, which reads as a tab that saved memory. The per-process working
set of the renderer is the instrument; the family total is not.

**Rule:** size the pane lane from memory rather than from monitors [M33]. The number a project needs is the
weight of its own page under test, divided into the free memory less the operator's reserve. Nothing takes
that measurement automatically yet: `node scripts/fleet-load.mjs` shows the largest renderer on the box
under **browser pane or window**, so it is one command with a pane open and one without, and the difference
is the number. Until somebody records it, `fleet.sh next` is what stands between a fleet and the page file. A worker that has finished with a heavy page closes its pane rather than reloading it.
**Status:** current.

## Appendix: what a pull run spends

Moved here from `PULL.md`, which workers read in full; none of it changes what a worker does.

### Worker economy

The text a worker emits during a run is read by nobody. Findings prose is written for the human who will
fix the defect and stays full length; everything else, its own narration, its notes to itself, its prompts
to subagents, is compressed. Drop articles and filler, keep every number, unit, negation and identifier
exact.

Never compress an assertion or a brief's statement of what correct looks like. A dropped negation turns a
passing screen into a defect report, and no token saving covers the hour spent chasing it.

#### What a run actually spends, measured

Seven runs, 57 worker sessions, 2026-08-26 to 2026-09-01, read from the session transcripts:

| line | tokens |
|---|---|
| cache read | 6 421 M |
| cache write | 93.4 M |
| output, of which thinking 5.7 M | 20.4 M |
| turns | 19 535 |
| tool calls | 11 450 |

These totals are about 1.7x high: they were counted per transcript line, and a message spans about two
lines. The shares and per-turn figures below hold [M24].

**The bill is turns multiplied by context, and nothing else is close** [M24]. The average turn carried ~330 k
cache-read tokens; per worker the average context ran 240 k to 530 k with a peak of 882 k. Output is 0.3%
of the tokens that moved.

Three things that follow, and one that does not:

**Compressing what a worker says is not the lever.** Of everything the models emitted, chat prose was
**5% by characters**; the other 95% was tool input. The worker economy paragraph is still right, since nobody reads that
narration, but it saves roughly nothing, so do not trade clarity for it.

**Bulk belongs around the model, not through it.** In the 26 workers of 2026-09-01 the emitted bytes were:
2 647 KB `Write` into repository source, 2 045 KB of `Bash` heredocs over 2 KB each, 1 022 KB `Write` into
docs, 709 KB `Edit` into source, 301 KB of scripts. Most of that is the work itself and cannot be avoided.
What can: anything the model does not need to read should be produced by the shell into a file and read
back as a count or a slice — `cmd > out.txt; wc -l out.txt` — because a payload that passes through the
model is paid once as output and then again in every later turn that carries it.

**A long queue is worked through subagents, so the worker's own context stays flat** [M30]. Every task a
worker finishes inline leaves 20-30 k of context behind it - the reads, the test output, the diff - and
the next task pays for all of it on every turn. Measured on four paneless workers over 175 tasks: context
climbed from 105 k at the first claim to 970-992 k around the thirtieth, every worker was compacted by the
harness, and the run read 2,414 M cached tokens at 471 k per turn. Over the same 184 claims the workers
spawned zero subagents. So: work the first three tasks yourself, write what they taught you into your
notes, and from then on hand each task to ONE subagent at the task's model - the task file, `RULES.md`
and your notes in its prompt, findings filed through `fleet.sh find` from inside it, a ten-line return.
`fleet.sh next` prints `DELEGATE` when you have crossed that line. A subagent's whole life costs less than
one of your turns once you hold a dozen tasks' worth of context.

**Every finding already goes through the gate.** 1 516 of 1 516 findings in one run and 327 of 327 in
another carried the stamp only `fleet.sh find` writes, so batching findings is not what those `Write`
payloads were. Do not "fix" a problem the disk says you do not have.

**Read a file you are going to edit with `Read`, and stop repeating the rest.** One day of one fleet
measured `Bash` p50 at 1,892 ms against `Read`'s 9 ms, and that ratio got written down as a property of
the tools. It is not: across 899 sessions and 261,308 calls on a second machine, `Bash` p50 is **173 ms**,
`Grep` beats shell grep only **2x**, `Edit` beats in-place `sed` **1.2x**, and `Glob` is **three times
SLOWER** than shelling out to `find` [M25]. The one difference that is not a matter of milliseconds is a
precondition: the harness refuses an `Edit` to a file that was never `Read`, `cat` cannot satisfy it, and
**187 `Edit` calls across that corpus failed exactly there** — three round trips instead of one, every
time. So: `Read` before `Edit`, `Grep` for a search whose output the model must read, the shell for
listing, for running things, and for moving bulk between files without the model in the middle. **And
where the session runs in the auto permission mode, the harness itself asks for shell reads** - then edit
with the shell too. Edit with what you read with; the twelve refusals of 2026-09-04 were every one a file
`cat` had read and `Edit` then touched [M31].

**And look at the permission classifier before blaming any of that.** Every shell call needs a permission
decision; `Read`, `Grep` and `Glob` need none. On the same corpus, 108 of 500 sessions were in a mode
where each gated call carried a fixed extra 1.5-2 s: gated p50 **2,081 ms** in that population against
**102 ms** in the normal one, with the p10 unmoved (75 against 58 ms), and it switched on and off within a
single day independently of how many sessions were running. That is **16.55 h of a 211 h tool wall**, and
on the heaviest day **22% of it** — around seven times what removing every `Edit` retry above would buy
[M28]. It is also where the hard failures come from: 39 calls in one hour of one run died with
`claude-sonnet-5[1m] is temporarily unavailable (rate-limited), so auto mode cannot determine…` while 25
workers ran [M26]. Fewer shell calls helps because it means fewer decisions; allowlisting the shapes a run
actually runs, or taking a wide run off auto mode, helps far more.

### Where the wall clock actually goes

Full accounting of one six worker pull run, 2026-08-27, from first claim to last `.done`: **4 hours 57
minutes**, so 1,782 worker-minutes were available.

| | minutes | share |
|---|---|---|
| Inside a task, working | 748 | 42% |
| Inside a task, dead (three claims held by stalled sessions) | 537 | 30% |
| Between tasks | 102 | 6% |
| Startup, pane gating, and workers idle after their own queue drained | 395 | 22% |

Four things follow.

**The stalls are the run.** Without them the queue drains around 20:30 local instead of 22:19: they cost
roughly an hour and fifty minutes of a five hour run, and they also produced the two thinnest workers of
the six, 19 and 18 findings against 65, 56, 50 and 46.

**Between-task cost is already near zero**, 102 minutes total and 78 of those in a single end-of-run wait.
Workers claim the next task the moment they finish. Nothing is to be won there, which is worth knowing
before someone optimises it.

**A task is one browser walk and nothing else.** A worker holds one pane, so the delegated scenario inside
each task sets its ceiling [M16], however the queue is written. More throughput comes from more panes, or
from work that does not need one.

**Which is the lever nobody pulled.** In that run, 33 of 34 tasks declared `kind: verify` and every one of
them was written to be walked in a browser, including the ones whose whole answer was in the repository: a
vendor egress audit that read source files took 8 minutes and never needed a pane. File-bound work is not
pane-bound, so it does not consume a worker slot at all. Separate the queue into the tasks that need a
pane and the tasks that need a repository, and the second lane's width is whatever the machine will run.

**And every task took the same high tier twice.** All 34 carried `model: opus` and `verdict-model: opus`.
`docs/MODELS.md` exists to make that a decision per stage, and its guidance for a clear-spec sweep is
Sonnet walking with Opus ruling. Defaulting both to the same model is not wrong everywhere, but nobody
chose it and it is the largest single line in what a run costs.

### Measured cost

One eight worker run over a large application, 2026-08-26: **94 findings, three of them blockers, in
roughly one to two hours of wall clock, for about six percent of a weekly maximum subscription allowance.**

The fair comparison is not a cheaper fleet but reading the codebase to find the same defects, which costs
orders of magnitude more tokens and cannot find the ones that only exist at runtime: a request sent with an empty parameter, a catch that turns a thrown query into an empty result
labelled as no data, a count branch and a select branch disagreeing under one filter.
