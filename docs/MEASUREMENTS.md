# The measurement ledger

Every rule in this plugin came from a run that went wrong in a specific, counted way. The rules carry the
**number**; this file carries the **story** — what was run, what was counted, how, and which rule it
produced.

Read it when you disagree with a rule, when you are about to remove one, or when you want to know whether
a number still describes the world. Do not read it to work a task: the rules are written to be obeyed
without it.

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

## M02 — Without the gate, eight of eight workers were blind
**2026-08-26**, first eight-worker run. Every worker started blind and the run produced 94 confident
findings that nobody could have observed.
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
**Status:** M16's 2.6 figure describes a browser-heavy run only; superseded for repo-only work by the two
later numbers in the same entry.

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
**Status:** current. Re-measure with `node scripts/fleet-load.mjs` rather than trusting this line on a
different machine.

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
