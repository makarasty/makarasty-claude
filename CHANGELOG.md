# Changelog

## 1.4.0 — 2026-09-08

Worktrees get a lifecycle. A run that writes code left one worktree and one branch per worker on the disk
with nothing in the plugin saying who removes them, so every agent improvised the removal - and on Windows
improvisation looks like `rmdir /S` on screen, which is the moment an operator stops trusting the run.

- **Measured first, and the obvious command turned out to be the unsafe one [M32].** A worktree carrying a
  `node_modules` junction into the main checkout, then `git worktree remove`: **the main checkout's
  `node_modules` was emptied, eight runs out of eight**, exit code 0 every time, with a remote and
  without. `--force` behaves the same, and a junction one level down is followed exactly as one at the
  top. Unlinking first left the main checkout intact. The recursive delete walks into the reparse point; it
  does not know a link from a directory. The rule is therefore not "avoid `rmdir /S`" but **unlink every
  reparse point before anything recursive touches the tree** - `git worktree remove`, `ExitWorktree`,
  `rm -rf` and `rmdir /S` alike.
- **`fleet.sh clean <run-dir>`** is the only path in the plugin that removes a worktree, and it is a dry
  run unless given `--remove`. It acts only on worktrees the run registered, only under
  `.claude/worktrees/`, never on the main checkout and never on a locked tree. It **keeps** any tree with
  uncommitted changes, with commits neither in the main checkout's branch nor on the branch's upstream, or
  on a detached HEAD; it unlinks reparse points at any depth first; it removes without `--force`; and it
  deletes a branch only with `git branch -d`. Everything skipped is printed with its reason, and the
  ignored files that would go with a tree are listed before it goes. There is deliberately no flag that
  deletes a tree holding work.
- **`fleet.sh worktree <run-dir> <chip>`** registers a code worker's tree at its first claim. Registration
  scopes cleanup to this run: the machine runs several runs at once, and a blanket sweep of
  `.claude/worktrees/` would take a live run's tree. A run that registered nothing is reported and left
  alone. **`fleet.sh unlink <worktree-path>`** gives a worker the unlink as a command rather than as a
  sentence in a document, gated by the same path rule.
- **A path gate, because a path goes wrong at its end.** An empty variable, a `dirname` too many, a prefix
  stripped twice: each turns a path into its own parent. `unsafe_path()` refuses anything relative, a
  network path, one holding `..` or a `.` segment, one shallower than `min_path_segments`
  (calibration, 4), one not inside `.claude/worktrees/` **with something after it**, and one that contains
  the shell's own working directory. It runs at registration as well as at cleanup, so a tree that could
  never be cleaned is caught while somebody can still move it, and `clean` prints the `git worktree move`
  line. A worktree the gate refuses is reported as a `STRAY` and never touched. Run against a real project
  it found eleven worktrees at the root of drive C.
- **A review round at the top tier found a blocker and three majors in the above, all fixed and all now
  under test.** A worktree on a detached HEAD was removed and its commits left unreachable. A detached main
  checkout made `merge-base` compare a branch against itself, so every tree read as merged. The branch was
  taken from the registration rather than from the worktree, so a worker that switched branches had the
  wrong one checked. And the unlink ran before git could refuse, so a locked tree lost its links and was
  reported as untouched. The same round found the cwd guard was **inert on Windows** - `pwd` prints
  `/c/...` where git prints `C:/...`, so the comparison never matched - which is the plugin's own
  failure mode, a guard that looks like protection and is not.
- **`docs/SAFETY.md`**: the closed list of what an unattended fleet may delete, which slip each guard
  catches, and - the part worth reading - **where the guards stop**: a worker's own exit is not gated, an
  agent's own shell is not gated, and the measurement is one machine. It also states what the evidence for
  writing the reason above the rule does and does not support. The ordering has a controlled ablation
  behind it for text a model **generates** (Wei et al.; Turpin et al. on rationalising a pre-committed
  answer) and is not established at all for a document a model reads, where the one measured effect on
  constraint-following is that reasoning first makes it **worse**. The convention is kept and is not asked
  to carry the safety.
- **`docs/WORKTREES.md`** carries the procedure and the measurement; the README states the closed list. No
  `git reset --hard`, no `git clean`, no `git checkout --` anywhere in the plugin.
- Twenty-three self-test checks over the path gate, registration, the dry run, the work-holding guard, the
  detached-HEAD case, stray reporting, the `unlink` command, and two real junctions - one at the top level
  and one nested - each asserting the target survives.
- **Not done, written down:** the junction measurement is one machine and one git version; the unlink-first
  arm is one run per method, re-asserted by the self-test rather than by repetition; `clean` has not yet
  run against a real multi-worker code run.

## 1.3.0 — 2026-09-08

A tenth kind, for the conversation rather than the code: a person who knows the system and not the
language, on a call with a vendor, a partner or an interviewer, reading from a page the fleet wrote and
asking a fresh chat mid-call. Same premise as the rest - a number said aloud that nobody measured is a
blind pane - so the gate is on the facts.

- **`kind: call`.** Two stages gated by `after:`: facts (repo, one task per source, Opus) and the
  script (repo, one task, the design model). A fact is a heading with `evidence`, `when` and one of
  four words for how it is known - measured, read, told, guess - and a guess is never spoken: it goes to
  the traps. The findings of a call run are the claims the facts refuted, which is what the previous
  letter or the previous call got wrong. `docs/CALL.md` holds the fact shape, the page, the register
  and the live contract.
- **`scripts/fleet-call.mjs check`** refuses a page citing a fact no file defines, a fact with nothing
  behind it, a page that cites nothing, a missing `CALL.md`, and a digit inside a line meant to be read
  aloud; `--stale <days>` lists the measured facts older than the window, for the footer's "re-measure
  before the call". Twelve self-test checks.
- **`templates/call-script.html`**: the Contoso page's styles and fixed sections, so the script task
  fills a page rather than designing one. What the interpreting research added to the page: a numbers
  table, because numbers are the words dropped first under load (Desmet et al., 56.5 to 86.5 percent
  with numbers on screen), and the five repair lines air traffic control keeps - say again, confirm,
  correction, standby, unable - so a lost speaker has something to say.
- **`/makarasty:fleet-call <who and what about>`**: `fleet-plan` with the kind and the stages fixed,
  one interview round (counterpart, the two languages, the source list, the answers to bring home, the
  reserved topics, where the page goes), repo chips only, and the page in the operator's chat when the
  run lands. **`/makarasty:fleet-call live <run-id>`** in a fresh chat is the call itself: every reply
  is two blocks - the read language with a source tag, the speak language below, one sentence per line,
  numbers as words - and a question the facts do not answer gets the dig notice in both languages
  first, then the dig in the same turn, then the answer with its tag. `unslop` on throughout; no
  subagent, because the speaker is on a call.
- **`fleet.sh landed` gates on `backlog.jsonl` existing, not on it being non-empty**, which is what
  `fleet-merge.mjs` documented all along: a merge that found nothing writes an empty file, and a call
  run whose facts refuted nothing, or a canvas run without a compare stage, could not land before.
- A sixth eval case, `script-speaks-only-facts`, scores a script worker that speaks a number no fact
  carries or leaves a guess out of the traps. Unrun, like the other five.
- **`makarasty-tools` 1.2.0: `/makarasty-tools:notify`**, one message to the phone when a chat you walked
  away from ends its turn. Arming is a marker per session id, so a chat nobody armed never sends; the
  Stop hook sends once, the tail of the last reply under the verdict, and disarms. A last reply ending in
  a question reads "waiting for your answer"; `StopFailure` reads "stopped on an error" and keeps the
  marker; a permission prompt reads "needs you", once per five minutes. A chat reopened after a crash
  gets one line in context from the `SessionStart` hook - check whether the work is already done before
  doing anything - and a finish written to disk but never delivered is resent on reopening with no model
  turn spent, or the moment the wizard saves a channel. Telegram, Discord, ntfy and a plain webhook, read from
  `~/.claude/makarasty/notify.json`; Discord is POST only, so a GET webhook does not exist, and it is
  sent with `@everyone` by default because a webhook message without a mention does not buzz a phone.
  **`notify.mjs setup`** is a wizard in the terminal, not a browser tab: which channel, the steps for
  that one, the single value it needs, a test message that must arrive before anything is saved, the
  bot's name looked up from the token so the person knows what to open and press Start in, a topic
  generated for ntfy. The token goes keyboard to file and never through a chat. **The hook commands in
  `plugin.json` start node only when a marker file exists at all** - one `ls` per event otherwise, in
  every session - and a marker older than seven days is pruned at the next arm, so a chat that died
  unreopened cannot hold that guard open. Sends retry twice on a network failure and not on a 4xx.
  `fleet.sh landed` posts a run's headline through the same script, once, the first time it writes
  `FINISHED`; the `FLEET.md` webhook line is retired in favour of that file.
  `tools/hooks/notify-selftest.sh`: 52 checks over the hook, the guard and the wizard, with a dry-run
  sink and no network. Measured on the development machine: a node start is 32 MB and about 50 ms, the
  hook with a marker peaks at 39 MB for that long, and the guard alone is about a millisecond. Not measured yet: whether the desktop app's queued-message path makes `--next`
  unnecessary, and the wizard against a real Telegram bot.
- **Not done, written down:** no fleet has prepared a real call yet; the Contoso page this is modelled
  on was written by hand in one chat.

## 1.2.0 — 2026-09-03

The design half: three mission kinds, one agent, two scripts, one document and two planner commands, all
built on the same premise as the rest - a screenshot is not evidence, and an artboard drawn from memory is
a blind pane.

- **`kind: critique`.** One screen per task, pane lane, one `fleet-design-eye` spawn. Two probes run
  before any picture: `visual-probe.js` for collisions and clipping, and the new `design-probe.js` for
  siblings off their row, gaps that do not repeat, controls of two heights on one line, values outside the
  page's own scale, text under 4.5:1, targets under 24 px, images at the wrong ratio, boxes drawn around
  nothing, lines over 90 characters - plus the page's scale and its landmarks. The screenshot is zoomed to
  a candidate and confirms or refutes it. Verified on `scripts/fixtures/design-probe.html`: nine planted
  defects found, zero of ten look-alikes reported, one extra candidate [M29]. Geometric findings carry
  `rects` (`a` the subject, `b` the box it is measured against), and `fixqueue` routes a finding with
  `rects` or a `probe` field to a `kind: design` task, because the design model owns the screen it repairs.
- **`kind: canvas`.** The application's screens as `<Screen>.dc.html` artboards under `design/canvas/`,
  assembled into the Claude Design canvas the harness's `design` skill carries. Stages gated by `after:`:
  recon (a pane measures the screen with the design probe), the primitives sheet, the screens (repo, from
  source and recon), an optional compare (a pane measures the artboard's plain render against the screen),
  assemble. `scripts/fleet-canvas.mjs` is the gate and the assembly: `stamp` writes the provenance block,
  `check` refuses an artboard that names a source file that does not exist or claims a measurement through
  a blind pane, `layout` writes `canvas.json` with the editor's gaps and a cover, keeping every position an
  operator moved, `plain` renders a static artboard standalone, `seed` drives the design skill's helper and
  its check. Ran end to end on a fixture project. Isolation is `none`: one new file per task, no source
  edits.
- **`kind: redesign`.** Proposals as `<Screen>.Proposed.dc.html` on a `Proposed` page beside the captured
  screen, loading and empty states as sibling artboards, the design model end to end, and two to four
  direction sketches on their own page first when the operator has not chosen one. An approved proposal is
  the specification a `design` mission implements; `docs/DESIGN.md` closes that loop.
- **`/makarasty:fleet-design` and `/makarasty:fleet-redesign`**: `fleet-plan` with the kind, the axis and
  the stages fixed. Both end with the planner publishing the seeded page through the `design` skill's own
  publish step, because the runtime pin and the capability rule move with the harness and are not copied
  here.
- **`FLEET.md` gains three optional lines**: `Canvas:`, `Canvas viewport:`, `Design tokens:`. The token
  file feeds `window.__fleetScale`, and off-scale becomes off-token.
- **Measured while building it, and guarded:** Git Bash on Windows rewrites a `/cases` argument into a
  path under its own install, so `stamp` refuses a route that does not start with `/` and names
  `MSYS_NO_PATHCONV=1`. The probe's first draft counted a 13 px padding once per side and voted it onto
  the page's scale; it counts once per element now.
- Self-test: twenty-four checks over the probes, the canvas gate, the layout, the plain render and the
  seed. The seed check drives the real helper when the design skill has been extracted on the machine and
  otherwise asserts the refusal names the reason. A fifth eval case, `artboard-carries-provenance`, scores a worker
  that claims a measurement it never made.
- **Not done, written down:** no fleet has captured a real application yet; the compare tolerance is a
  starting number; the probe was verified in one browser; publishing is the planner's manual step.
- **Docs stop selling `caveman` as a saving.** `fleet-run`, `docs/MODELS.md` and `docs/PULL.md` told a
  worker to switch it on from the first message; M24, measured in the same release, puts chat prose at 5%
  of what a worker emits and output at 0.3% of what moves. The three paragraphs now say what the plugin
  is worth, and name `ponytail` as the plugin that works on the layer a writing kind actually spends on.
- **Two ledger entries from the 2026-09-04 fix run, added 2026-09-05, and the rule each produced.** [M30]
  Every one of four paneless workers grew its context by 20-30 k per task, stood at 970-992 k around its
  thirtieth claim and was compacted by the harness: 2,414 M cached reads, 471 k per turn, the dearest run
  in the ledger, and zero subagent spawns over 184 claims with `fanout: 3` in every task's reach.
  `fleet.sh next` now prints `DELEGATE` once a chip has finished `delegate_past_tasks` tasks (calibration,
  3), and `fleet-retro.mjs` prints context per turn, peak context and compactions per worker, tells a pane
  worker from a repo one by whether it ever called a browser tool rather than by a phrase in its prompt,
  and reads a chip id that is not a number. [M31] The shell reads that keep refusing `Edit` come from the
  harness's own auto-mode instruction to use `cat` and `sed`; the rule is now "edit with what you read
  with", not "Read first".
- **A stopped run is still collected.** The 2026-09-04 run ended on the operator's word, was merged and
  pushed by hand, and never saw `merge` or `landed`: 180 findings in four files and no backlog, for the
  third time in this ledger. `PULL.md` says how to stop a run and that collection still follows.
- **`makarasty-tools` 1.1.0: `/makarasty-tools:say`**, the spoken register: lines a person who is not a
  native speaker reads aloud to a vendor or its support. One sentence per line, numbers as words, "what
  we do, what we get, the question" in place of a proposal, and the exit "maybe we do it wrong".
  Distilled from the Contoso call script of 2026-08-21 and the two corrections that produced it. `unslop`
  gains one cut, the word the reader would have to look up, and points at `say` for the spoken case.


## 1.1.1 — 2026-09-02

An adversarial read of 1.1.0 by a second model, verified against the tree and the two crashed runs.

- **`recover` no longer treats its own blindness as a fact about the workers.** It reads the host's
  `CLAUDE_CONFIG_DIR` (`CLAUDE_PROJECTS_DIR` still overrides), says so when the transcript directory holds
  nothing, and **refuses `--release` in that state** — releasing on no evidence would free the claims of
  workers that are alive. That machine wants `sweep --release`, which asks the heartbeat question instead.
- **A live session is no longer offered for reopening.** A transcript written to inside the hook's claim
  window prints as `LIVE?` with no command: reopening a running session puts a second writer on its file.
  On the real `2026-09-01-recon-all` run the old behaviour printed a `claude -r` line for a chip whose
  transcript was four minutes old.
- **The printed line is now the command the operator needs**: the directory that session was started in,
  read from the transcript (a worktree worker's is not the planner's), and a first instruction telling the
  worker to write its heartbeat before continuing. A session reopened with no prompt sits there until
  somebody types into it, and that is also the cheapest answer to "nothing confirms a resume happened" —
  the heartbeat is the confirmation, and `status` sees it move.
- **LANDED lines carry their session id.** A finished worker is the one whose context a follow-up run wants
  most; "leave it alone" was advice about this run only.
- **`after: <task-id>` in a task's frontmatter, honoured by `next`.** A gated task is not handed out until
  its dependency's done marker exists, and the worker is told `QUEUE WAITING` rather than `QUEUE DRAINED`
  so it polls instead of writing `.done` and ending its session. This is what makes the `design` kind's
  three waves a mechanism rather than a paragraph. Which paths a screen task may not touch is still prose.

## 1.1.0 — 2026-09-02

Three runs on 2026-09-01 (12, 13 and 6 workers; 1,500, 256 and 43 backlog rows) and a restart in the
middle of them are what this release answers.

- **A run survives the machine dying.** `fleet.sh recover` and `/makarasty:fleet-resume` read the chip
  register, the standing claims and the session transcripts under `~/.claude/projects/`, then print which
  chips can be reopened with `claude -r` (context intact), which have to be respawned, and which claims are
  free to release. Measured 2026-09-01: after a restart, the 26 worker sessions of two runs were absent
  from `ListAgents` and from the app's session list, archived rows included, so the revive message — the
  only recovery this plugin had — could not reach anything. `recover` releases nothing on its own, keeps
  the claims of chips that can come back, and reports a claim whose chip never registered a session id as
  UNKNOWN rather than sweeping it: registration needs `CLAUDE_CODE_SESSION_ID`, and its absence is not
  evidence of death.

- **`kind: design`**, the sixth mission kind. One screen per worker, and the design model owns the screen
  end to end - reading the code, the markup, the copy, driving the browser, the verification. No cheaper
  model touches the markup afterwards, and where a design model is not warranted the builder is the strong
  general model rather than a cheap one. Three waves: recon, then ONE task owning the shared primitives,
  then the screens. It exists because of what the split produced: every visual defect a six-worker sweep
  found on 2026-09-01 lived in a state or a moment nobody designed - a skeleton drawing fewer rows than the
  first page returns, a header that loads at a different height, a filter bar opening 60-130 ms into a
  navigation ON THE OUTGOING page and pushing it down 70.9 px, a ghost shorter than the number it stands
  for, size utilities discarded by an icon font. The design model had designed the loaded screen; the
  loading state, the transition and the cascade went to somebody who had never held the design.

- **What a run costs, measured and written down as rules** - `docs/PULL.md` "Worker economy", ledger
  entries M24-M28. Across 7 runs and 57 worker sessions: 19,535 turns, output 20.4 M tokens (thinking
  5.7 M), cache **read 6,421 M**; average context 330 k per turn, peak 882 k. The bill is turns multiplied
  by context and nothing else is close, output being 0.3% of the tokens that moved. Chat prose is 5% of
  what the models emit by characters, so compressing narration is not the lever it was assumed to be.

- **A correction, from a second machine.** The first draft of M25 generalised one day's latency into a
  rule: "the shell is two orders of magnitude slower than the file tools". Re-measured over 899 sessions
  and 261,308 calls, `Bash` p50 is 173 ms rather than that day's 1,892 ms, `Grep` beats shell grep only
  2x, `Edit` beats in-place `sed` 1.2x, and **`Glob` is three times slower than `find`**. What survives is
  a precondition, not a speed argument: the harness refuses an `Edit` to a file that was never `Read`, and
  187 edits across that corpus failed exactly there. M28 records the larger finding the same data turned
  up - a session mode in which every permission-gated call carries a fixed extra 1.5-2 s (gated p50 2,081
  ms against 102 ms, p10 unmoved), worth 16.55 h of a 211 h tool wall and 22% of the heaviest day.

- **A fourth eval case, `reopens-before-releasing`**: a crashed run where two chips look identical from
  the run directory and only one session can be reopened. It scores a planner that replaces a worker whose
  context was recoverable, or releases a claim that can still come back. Unrun, like the other three.

- **`fleet-retro.mjs` reports those costs per run**: average context per turn, shell against file-tool
  calls, reads done through the shell, `Edit` calls refused for an unread file, and calls that failed on a
  rate limit rather than on the command.

## 1.0.0 — 2026-08-31

First release. The version numbers before this one were development markers in an unpublished manifest,
never installed by anyone but the author, and they are not part of any history worth keeping: nothing was
released, so nothing was ever upgraded. This is version one.

What it is: a plugin for running one mission across several Claude Code sessions at once. Each worker
holds its own context, claims one task at a time from a queue on disk, gates whether it can actually see
what it is inspecting, and reports by writing files. Nothing messages anything.

### What this release is built on

Four measured runs over six days against one large Vue and Node application, the last two on 2026-08-31:
an audit run (14 workers, 54 tasks, 246 findings, 32 blockers) and the fix run that followed it (8
workers, 32 tasks, 741 files changed, 83 commits, every cited commit verified present on the branch).

### The rules that came from those runs

- **The frame gate.** A browser pane that is not displayed stops compositing while still navigating and
  still returning plausible DOM, so a blind worker reports fiction with full confidence. Every browser path
  measures a one-second `requestAnimationFrame` count first. Before the gate: 8 of 8 workers blind and 94
  confident fabrications. After: 22 of 22 workers across two runs saw what they claimed to see.
- **The finding schema is a gate, not a request.** `fleet.sh find` refuses a finding with no evidence, a
  severity outside the four, or the retired field name. 246 of 246 findings in the audit run carry the
  stamps only that path writes.
- **Lanes.** A fleet queues for whatever the machine has one of: `pane` for the browser, `verify` for the
  test suite, `repo` for work that only reads files. `next` takes the lane as an argument and refuses to
  hand a paneless worker a browser task. The lanes are capped separately - the pane lane by the operator's
  display, the repo lane by the machine - because capping file work at the width of a monitor is how a run
  ends up eight browsers wide and two files wide.
- **Pending work mirrors unwritten obligations, in both directions.** A session runs only while something
  invokes it, so a worker with an obligation arms a clock; a worker with none must have nothing armed.
  Across the two runs 87 clocks were armed and none stopped, which cost 1,090 minutes and 282 model turns
  of session life after the workers' own completion markers. A clock now watches the disk that closes its
  obligation and exits on its own, so there is nothing left to remember.
- **A run ends visibly.** A generated banner from disk, the session renamed so the sidebar shows it
  finished, one notification for the whole run, and a `FINISHED` file that survives every missed
  notification.
- **Two panes, not ten.** Seven panes carried 104 minutes of browser driving in a 153-minute run; two
  carried three minutes in the run after it. The display fits five; the work has needed two.

### Rules that stopped being rules

Three of them were deleted rather than restated, because the measurement said asking harder would not
work:

- **The abort clock disarms itself.** `fleet.sh clock` prints a loop that watches for its own task's done
  marker and exits when it appears. The previous shape asked the worker to stop it: asked 87 times across
  two runs, obeyed zero times.
- **`drained` ends the worker.** It writes the marker, prints the banner generated from disk, and prints
  the exact session title to set. Four prose rules became one call.
- **`fleet.sh width` sizes the repo lane** from the ready queue and free memory, so the formula has one
  spelling instead of one per doc that quotes it.

The rule behind all three: a requirement belongs in a script when the script sits on a path the worker
already walks, in a hook when only the harness can see it, and in prose only when neither can - and prose
costs are paid on every read by every worker.

### What a stranger has to be able to do

- [`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md) is a fifteen-minute first run for somebody who has never used
  this: prove the machine can run it in one second, set a project up, plan, click two chips, read the
  banner. It names what to do when each of the five common failures appears.
- The README says **what the version number covers** and what is explicitly calibration rather than
  contract, and carries a troubleshooting section for the four failures that are not in this plugin: a
  stale plugin cache, a run directory inside a sync client, CRLF line endings on Windows, and Git Bash
  not being found.
- **The three side commands moved to their own plugin**, `makarasty-tools`, from the same marketplace.
  They travel with a fleet and have nothing to do with its contract, so they version apart from it.

### Measurements live in one place now

`docs/MEASUREMENTS.md` holds 23 entries: what was run, what was counted, how, and which rule it produced.
Rules carry the number and cite the entry (`[M04]`), so a reader deciding whether to remove a rule sees the
cost of removing it without paying for the story on every read. The self-test fails on a citation with no
entry and on an entry nothing cites.

`calibration.json` holds every constant a script or a planner reads — lane widths, the frame-gate
threshold, the budget multiplier, the fan-out width — with the measurement each came from. A number that a
script reads cannot go stale the way a number retyped into prose does.

### Hardened against what other people's runs already hit

Read from the issue trackers of comparable orchestrators and from classic file-queue designs:

- **`fleet.sh sweep`** names claims nobody is advancing and, with `--release`, hands them back. Atomic
  claiming prevents two workers taking one task and does nothing about a worker that died holding one.
- **A `Stop` hook** refuses, once, to let a worker end its turn on a claim it took in the last ten minutes
  and never touched again — the signature of the failure that cost one run 516 minutes, and the one thing
  here that no script can see. A worker that has written a heartbeat, or whose claim is older than that
  window, is left alone: that case belongs to the planner's stall report and `fleet.sh sweep`.
- **Portability**: one locale pinned, temp files with explicit templates, no `date -r` on a file (it means
  two different things on GNU and BSD), `.gitattributes` pinning shell scripts to LF so a Windows clone
  cannot produce a CRLF shebang.
- **A run directory on a sync client is documented as unsupported** rather than left to fail strangely.

### What ships

The fleet plugin: seven commands (`fleet`, `fleet-init`, `fleet-plan`, `fleet-run`, `fleet-login`,
`fleet-wait`, `fleet-collect`), three agents, the reference documents under `docs/`, and the scripts —
the queue bookkeeping and schema gate (`fleet.sh`), the reconciling merge (`fleet-merge.mjs`), the
self-test that runs the whole protocol against a temporary directory in about a second
(`fleet-selftest.sh`), a machine census (`fleet-load.mjs`), a post-run forensics reader
(`fleet-retro.mjs`), and the geometry probe (`visual-probe.js`).

The `makarasty-tools` plugin: `commit`, `review`, `unslop`, and the hook that carries the humanised reply
mode between prompts.

### Known limits, written down rather than fixed

- Every number here was measured on **one machine** (Windows 11, 31.2 GB, 16 cores), by **one operator**,
  against **one application**. They are real measurements and a weak sample.
- The **pane broker** (`docs/BROKER.md`) has never run live. Its mechanics carry self-test assertions and
  nothing else.
- The **published install path is untested**: this release was developed and installed from a local
  directory marketplace.
- **Portability is half exercised.** `docs/PORTING.md` names eleven host assumptions and only Windows has
  run a fleet. The scripts are better tested than that: the self-test passes under `dash` as well as
  `bash`, so the POSIX claim is checked rather than asserted — but a real run on macOS or Linux has not
  happened.
- The self-test covers **mechanics only**. Whether a worker asks for its pane in the first minute, renames
  its session, or splits its own work sensibly is asked for in prose and enforced by nothing — and this
  plugin's own measurements include two cases of a prose rule being routed around. Where that mattered
  most, the rule was moved into a script instead; where it could not be, it is named here.
- `fleet-retro.mjs` reads the host's transcript layout directly and will break if that layout changes.
- The **eval suite in `evals/` has never been run**: `claude plugin eval` is in early access and was
  refused on the account this release was built on. Three cases are written against its documented shape,
  and they are the plugin's only test of whether a worker reading these documents does what they ask.
