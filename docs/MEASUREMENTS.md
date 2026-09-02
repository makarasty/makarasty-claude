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
**Status:** current.

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
