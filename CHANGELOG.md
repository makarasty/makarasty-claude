# Changelog

## makarasty 1.5.11 — 2026-10-06

Worker 20 of the 2026-10-05 build stopped at 420 K of a million-token window, calling it "the coordinator's
400K retire threshold". There was no such threshold: eighteen hours earlier a coordinator had broadcast
"workers 01-05 and 11-13 retire, your context is past 400K", and every worker reads the whole broadcast.

- **A worker never stops for context on its own** below 850 K; a reminder's number or a broadcast order
  naming other chips is not its own. The coordinator's watch asks the operator at 700 K, and a relaunch
  reaches the worker as "retired".
- **`fleet.sh broadcast` stamps each entry with its time** and warns when one carries a retire order;
  `fleet-plan` keeps orders for named chips out of the broadcast and has the coordinator tell a worker that
  stopped early to carry on.

## makarasty 1.5.10, makarasty-tools 1.5.5 — 2026-10-06

What the rest of the 2026-10-05 build showed, read from its run directory and its 24 chats: 200 of 234
tasks done in 20.9 hours, seven coordinators in a row, and a third of the tasks fix tasks.

- **No handoff reminder in a fleet chat, and 600 K elsewhere.** Three of the six coordinator handoffs came
  from the old 300 K mark (700 K since 1.5.9); the general 400 K reminder made one coordinator offer a
  handoff twelve times, workers offered too, and one coordinator handed off at 448 K unasked. `fleet.sh`
  now records every coordinator and worker session in `makarasty/fleet-sessions/`, and the reminder says
  nothing there. A record whose run has `FINISHED`, is gone, or was not rewritten for two days (the watch
  rewrites the coordinator's every minute) is dropped and the reminder comes back; `landed` removes the
  run's records. Everywhere else it first fires at 600 K, not 400 K (`MAKARASTY_HANDOFF_AT` still moves
  it): on 1M-context models it came too often.
- **Waiting on the operator is a state, and `status` names what the queue waits on.** A task with
  `operator: <what>` is asked at launch, held by `next` until `fleet.sh cleared <run> <id>`, and listed
  under `== waiting on the operator`; `== bottlenecks` lists a task free to start that holds three or more
  open tasks behind it, and `== waits for ever` an `after:` naming nothing filed or done. Every remaining
  plan task had sat about two hours behind one permissions task, closing 8 and then 4 tasks an hour.
- **`fleet.sh file <run> <id>`** files one task from stdin: refused, with the reason, when it is not UTF-8,
  has no frontmatter, names a lane other than pane, repo or verify, disagrees with its `task-id:`, or reuses
  an id; a byte order mark is dropped, and an `after:` naming nothing filed yet is noted. `status` runs the
  same checks over task files written by hand. A hand-made filing script had lost two tasks behind a failed
  `&&` and broken a third with cp1252.
- **`fleet.sh stranded <run>`** lists done tasks whose branch holds commits the integration branch lacks,
  `STRANDED` when they came after the branch was merged: certain from the tip `finish` now records, read
  from the merge commit's message for older markers, and a marker with no branch line is matched by task
  id. `landed` repeats those, or says the check could not run. Three such commits had needed a recovery
  task; on the live run it found three more.
- **Old workers are found and replaced without being asked.** `whoami` records the plugin version; `status`
  says `OTHER PLUGIN` (older or newer) or `never ran whoami`, the watch prints `WORKER PLUGIN NN` for a worker
  on an older makarasty than the installed one, and the coordinator puts it in the one relaunch ask and
  offers the fresh chips. `pause` names holders whose hooks cannot hold them. 137 of 200 done markers had
  come from 1.5.2 workers, and the operator had to ask the coordinator to look.
- **`fleet.sh procs <run> [--kill]`** (`fleet-load.mjs --leftovers`) lists test runs and typechecks whose
  chat or shell is gone, and kills only those; an orphaned dev server, watcher or emulator is listed and
  left to the operator. A worker stops every run, server and background shell it started before `finish`.
  The build's machine ran out of memory with leftovers nobody owned.
- **`status` starts with `== now`**, the machine's clock, and `STATE.md` entries are stamped from it: one
  coordinator wrote "~13:00" on a snapshot taken at 11:10.
- A worker's own review before `finish` checks `answers/00-broadcast.md`'s recurring misses one by one.
- `fleet-plan`'s relaunch procedure moved to `docs/RELAUNCH.md`, keeping the command under 500 lines.

## makarasty 1.5.9, makarasty-tools 1.5.4 — 2026-10-06

A pause that stops a fleet, and a relaunch in place of a chain of handoff chips. On the 2026-10-05 build the
operator said "pause" and the workers kept "wrapping up" for a long time; the coordinator then handed off by
chip at 300 K, and the next one again, each hop losing what lived only in its context.

- **`/makarasty:fleet-pause <run> [off] [reason]`** and `fleet.sh pause|resume|paused`. A worker gets 30 s
  (`pause_grace_seconds`) from its first call after the pause to finish the step in hand, commit work in
  progress and stop its subagents and background shells; then the hooks refuse everything but git,
  `fleet.sh` and the wake loop. New subagents are refused from the first second, a subagent's own calls
  after the grace. `next`/`drained` exit 8 while paused; the abort clock stands still; `status` and the watch
  name workers with no ack yet and, past 150 s, the ones still working.
- **`fleet.sh contexts`** lists the context of the coordinator and of every worker; the watch prints
  `WORKER CONTEXT` lines as well as `COORDINATOR CONTEXT`.
- **Context marks moved up** at the operator's word: the coordinator asks at 700 K and again at 800 K,
  workers at 700 K (`coordinator_handoff_k`, `worker_relaunch_k`); auto-compaction starts a little past 900 K.
  The coordinator hands reviews, merges, conflict resolution, `STATE.md` updates and every large read to
  subagents and keeps verdicts and decisions.
- **`fleet.sh relaunch`**, after one ask to the operator: pause, wait for acks, hand back the replaced
  workers' tasks (`<id>-r<n>` with `continue-from:`, `continued-from-chip:`, `handback-of:`; a dirty tree is
  committed as `wip: handed back`, a fix task's proof is carried over), retire them (exit 9; held by the hooks
  even after resume), then, once `STATE.md` is current, print the fresh worker chips and one coordinator chip
  (`resume --take-over`). `--keep-coordinator` replaces only workers and resumes at once.
- `/makarasty-tools:handoff` and the context reminder send a fleet coordinator to the relaunch instead.
- Every worker-side call that names its chip registers the session, so a worker on an assigned brief is
  held by the pause too and counted by `pause`, `status` and `relaunch` until its `.done`; a line refused for
  its shell syntax (a backtick or `$(` in a note) says so, and a line refused for its commands does not.
- Checked by three rounds of a Sonnet red team, the last an end-to-end run of pause, relaunch, take-over,
  a handed-back fix task and landing; self-test 702 checks.

## makarasty 1.5.8, makarasty-tools 1.5.3 — 2026-10-05

Everything else the 2026-10-05 build run got wrong, measured on that run while it was live.

- **The whole queue at launch, every lane's chips at launch.** `fleet-plan` files every wave up front and
  holds the order with `after:`; filing one wave at a time idled about a third of worker time and left
  Opus-only tasks unclaimed for nineteen minutes. `fleet.sh chips` records what it offered in `offered/`
  and ends with `STILL WITHOUT A WORKER` for any lane that has ready work and no chip; `status` repeats it.
- **Lanes are pane, repo and verify, never a model.** `chips` refuses any other lane, and `status` names a
  `needs:` that no worker can ever claim. An `opus` lane had left four idle Opus workers unable to take a
  waiting task. `model:` in a task is now documented as a wish: the operator's chip decides what runs.
- **What each worker really runs.** `fleet.sh whoami` records model and effort at the first claim and
  `status` lists every offered worker with it. The plan said Sonnet for 81 of 125 tasks; all seven
  workers were Opus.
- **The coordinator stops being the bottleneck.** `fleet-plan` 8b: review finished tasks through a
  subagent and read only its verdict, keep `STATE.md` current, hand off at a mark. The watch records
  whoever arms it as the coordinator and `fleet.sh ctx` prints `COORDINATOR CONTEXT <n>K` once per mark
  from that session's own transcript (`coordinator_handoff_k`, 300 K). That coordinator had reached 510 K
  at thirty percent of its plan.
- **Budgets from measurement.** `status` prints the median work time against the median budget once
  three tasks are done, and says `BUDGETS TOO LOOSE` when no abort clock could ever fire (four minutes of
  work against budgets of 45 to 150).
- **One commit, one review, before a code task is finished.** `fleet-run` step 5: the worker commits on
  `fleet/<chip>/<task-id>`, a subagent at the task's `verdict-model` (its own tier when the task has none)
  reviews that branch against its base, the worker fixes what shows an input, lists the rest as unreached,
  and finishes. `fleet.sh finish <run> <chip> <task-id> [branch]` writes `branch <name>` into the done
  marker so the coordinator knows what to merge (a second `finish` without a branch keeps that line, and a
  branch that does not resolve is warned about). Twelve of the first 33 tasks came back as fix tasks.
  `fleet-plan` 8b: a worker-reviewed task gets a short verdict review, not a second full one.
- **`fleet.sh worktree <run> <chip> --create [base]`** (the worker passes the `base:` of its first task) makes the worker's tree under
  `.claude/worktrees/`, excludes that directory locally, links every `node_modules` up to three levels
  deep (monorepo `apps/web/node_modules` included; it warns when a link fails), and registers it. The base
  defaults to the main checkout's current branch; a tree whose directory was deleted is pruned and made
  again, not "reused". Chips had opened in the main checkout and a coordinator hand-wrote trees at
  `C:/wtRM01..05`, which nothing could register or clean. `clean` now removes a detached tree whose commit
  a branch already holds, and no longer prints `branch -d HEAD`.
- **Screens are checked where they can be seen.** A build worker's pane shows the main checkout, not its
  worktree; `fleet-run` says so, and `fleet-plan` files screen checks as `needs: pane` tasks against the
  integration checkout, now defined (the worktree where the coordinator merges, with its own dev server),
  each carrying `origin: <url>`. A worker that must see its own screens, a design task, serves its own
  tree on a free port. A look a build worker cannot take is filed as `ask/<chip>-<n>.md`, which the watch
  surfaces; a line in its notes was read by nobody.
- **A chip is an offer, and a rule that names fleets does not cancel it.** The 1.5.7 fix for the coordinator that offered
  paste lines was itself beaten by the project rule it was written against: "unless a project rule
  names fleets" let a "never a fleet worker" rule win. `fleet-plan` and the `fleet.sh chips` trailer now
  say a chip is declined with one click, so every one is offered, and a rule that seems to forbid them is
  quoted to the operator in the same turn. `fleet-run`: a project rule about the tree wins over the protocol
  and one about channels loses to it; a rule that forbids a tree-side protocol step is obeyed, filed in
  `ask/` naming both rules, and the worker takes the next task. "No commit without asking" is overridden for
  the worker's own task branch only. Near its context limit a worker finishes or hands the task back,
  never a chip.
- **`chips` is strict.** It refuses an empty, reversed or non-numeric range, a worker number below 1, and a number already offered
  under a different lane, records `brief` for a brief worker, and prints the browser-pane sentence only for
  lane `pane`. `lane_gaps` ignores a chip whose worker already wrote `.done` or `.blocked`; `drained`
  refuses to finish (exit 5) while a ready task has a `needs:` no worker can claim, and `next` says so too.
  `status` exits 0 whenever it printed its report.
- **Every worker command takes the run's absolute path.** `fleet-run` defines one `$r` and uses it in every
  command and in the wake loop; a relative `.fleet/<run>` that does not exist under the cwd resolves
  against the main checkout in `fleet.sh`, and the hooks print an absolute run path from a worktree.
  `fleet-run` also tests for a worktree with absolute `git rev-parse` paths, unlinks the registered path
  (not `$(pwd)`), and defers pushing to the project's rules.
- **The watch is fixed where it was wrong.** A service URL is no longer a regex: `http://[::1]:5173` is
  removed from the down list and reports `SERVICE BACK`. The loop builds `svc` from one fixed `FLEET.md`
  line, `- Services: <url> (start: <how>|operator); ...`, which `fleet-init` writes, and `start:` decides
  whether the coordinator restarts a service or tells the operator; only a URL before an item's
  `(start: ...)` is probed, and an empty list prints `WATCH: no '- Services:' line in FLEET.md, services are
  not being checked` (`fleet-init` converts an old-format line). From a worktree it finds the run and
  `FLEET.md` in the main checkout; where neither exists it prints `NO RUN DIR` and exits, and its stall
  report ends with the lanes that have work and no worker.
  Tasks may carry `origin:` and `verdict-model:`, documented in `PROTOCOL.md`.
- **A handoff into a run under way does not re-offer chips.** `handoff`: read `STATE.md`, re-arm
  `fleet-wait`, resume only if the worker chats are gone, and name `opus` for a fleet coordinator. The
  outgoing coordinator refreshes `STATE.md` and stops its own watch (`TaskStop`) before it offers the chip:
  two watches share `.watch-seen`, and the old one swallowed the events. `STATE.md` now holds what a
  re-arm needs (plan path, run dir, worker count, chips by lane, integration checkout and URL, extra
  watched URLs, queue-open, merges, reviews, fix tasks, decisions, pane check tasks); the handoff names
  `fleet-plan`'s command file as the fallback for a chat that started before the plugin update.
- **A task builds on what it waits for.** `after:` waits for the done marker, not for the coordinator's
  merge, so a code task now carries `base: <integration branch>` (`PROTOCOL.md`), its branch is cut from
  that, and the worker merges each predecessor's `branch <name>` (from the done marker) into it when it is
  not in the base yet. A `needs: pane` check task first confirms the build branch is in the integration
  checkout and otherwise files an `ask/` and takes another task.
- **`fleet-login [origin]`** logs in at the origin it is given (a task's `origin:` or the worker's own
  served URL) instead of `FLEET.md`'s; a refusal from the app's auth or CORS allow-list on a new port is an
  `ask/`. A `design` task is `needs: pane` and serves its own worktree from a background dev server on a
  free port, `preview_start` by url.
- **A fix is proved in its own tree.** `prove` hashes the cwd and `--create` leaves it in the main
  checkout, so `fleet-run` runs both calls and the scoped tests with `cd` into the worktree; before and after
  were the same tree and `finish` said NOT PROVEN. `FLEET_REFUTED` is never the way past that.
- **A task's `model:` is met by a spawn.** A worker below a task's tier delegates the task to one `Agent` at
  that tier; `fleet-design` and `fleet-call` name the model for every chip, and the coordinator tells the
  operator in the turn `status` shows a gap. An assigned brief that writes code records `branch
  fleet/<chip>/brief` in its notes, `unlink` now comes before `drained` writes `.done`, and `PULL.md`'s code
  blocks use the absolute `$r`.
- Budgets in `fleet-plan` and `PULL.md` now give a stated default for a first wave and say the run's own
  median replaces it. Every behaviour change above has a self-test check.
- **`clean` in the middle of a run.** A task branch merged into another local branch (the integration
  branch, before the owner lands it) counts as held, so its tree can be removed; the worker's merged
  `fleet/<chip>/*` task branches go with it by the safe `branch -d`. A tree unlinked before `drained` gets
  its links back from `worktree --create`. `chips` reports a `needs:` that is no lane as a task to fix, not
  a chip to offer. A pane check whose build is not merged yet is handed back with `finish` and re-filed by
  the coordinator, since a claim is never released. `fleet-plan` converts an old-format services line in
  `FLEET.md` before arming the watch, and makes the integration checkout with `worktree --create`.
- Checked by three rounds of a three-reviewer red team, each finding fixed and re-tested by the next round.
  Self-test: 423 checks.

## makarasty 1.5.7, makarasty-tools 1.5.2 — 2026-10-05

A coordinator that reached its run by handoff offered its workers as paste lines, not chips. It had never
loaded `fleet-plan` - the harness blocked it - so the chip rules were not in its context, and a project
memory rule written about chip hygiene ("chips only for one real defect, never a fleet worker") decided
instead. When the operator asked, it offered four chips titled `Fleet worker 02: ...`, which no
`fleet <run-id> NN` lookup finds, pointing at a cached `fleet-run` two versions old.

- **`fleet.sh chips <run-dir> <NN>[-<NN>] [lane]`** prints each worker's `spawn_task` title and prompt:
  the `fleet <run-id> NN` title, the run's absolute path, and the path of the `fleet-run` actually
  installed. `fleet-plan`, `fleet-resume`, `fleet-design` and `fleet-call` take chips from it rather than
  retyping a template. Six self-test checks.
- **`fleet-plan` no longer carries `disable-model-invocation`.** A chat told "launch the fleet", or made a
  coordinator by handoff, can now load it. It writes files and offers chips; nothing is spent until the
  operator clicks one. A plan that already exists skips the interview.
- **Project rules and the protocol, split in writing** (`fleet-plan`, `fleet-run`): the project decides what
  workers build and touch; the fleet decides how they launch, ask and hand work back, unless a project rule
  names fleets. A rule that forbids a protocol step outright goes to `ask/`, not into a silent choice.
- **The watch checks the services.** `fleet-wait`'s loop takes the run's service URLs from `FLEET.md` and
  prints `SERVICE DOWN` once when one refuses connections, `SERVICE BACK` when it returns; the coordinator
  restarts it or tells the operator in that turn. The functions emulator died twice during one run and
  nobody in the fleet noticed.
- **A blind pane is asked about, by anyone.** `BROWSER.md`: the coordinator too asks the operator to open
  its pane in the same turn, with a push notification, rather than recording the check as a debt.
  `fleet-plan`: screen checks in a build go to `needs: pane` tasks, not to the coordinator.
- **`handoff`**: when the next chat is to run a fleet, its first step is `/makarasty:fleet-plan` or
  `fleet.sh chips`, not a launch rebuilt from the docs.

## makarasty 1.5.5 — 2026-10-04

- **`fleet-retro.mjs` counts a turn once.** The host writes one transcript line per content block and
  repeats the message's usage on each line. The script counted lines, so turns, output and cache reads came
  out 1.5 to 1.9 times high. On one nine-worker run: 3,276 turns became 2,099 and
  1,027 M cache reads became 688 M. Tool-call counts, lanes, pane minutes and minutes after done were right
  and have not changed.
- **`docs/RUNS.md`**: a selection of real runs from two projects, a private web app and the public
  Essentials plugin, each with its setup, results, failures and approximate cost at API list prices,
  counted once per message, and checked by a red-team pass against the run directories. The README's
  cost section is now a summary of it.
- **Corrections to the ledger.** M02 said the first eight-worker run filed 94 findings nobody could have
  observed; its own analysis shows the gate caught all eight blind panes and the findings came after a
  live reading. The README's 311 M cached and 8.3 M non-cached for that run were per-line counts; per
  message they are 163.8 M and 4.21 M, also fixed in `MODELS.md`. M24, M30 and the pull-run appendix carry
  a recount note. `SWEEPS.md` and M10 no longer carry details specific to the private project.

## makarasty 1.5.4, makarasty-tools 1.5.1 — 2026-10-02

The first public release. No rule, threshold, command or exit code changed.

- **README rewritten** for a reader who has never seen the plugin: what each plugin does, install,
  requirements, a quick start, the commands, how a fleet works, what it may delete, the known limits.
  The release-by-release history that lived in it is here.
- **A style pass over every document, command, agent brief and skill.** Filler, decorative repetition and
  sentences that took two reads were rewritten; two checking passes compared every hunk with the previous
  text and restored six places where a rewording had changed a claim.
- **Examples from a real project replaced** with neutral ones: a shipping carrier instead of the original
  vendor, `Acme` as the canvas title, a generic home path in `docs/SAFETY.md`. The self-test and the
  `script-speaks-only-facts` eval use the new example and test the same thing.
- **Manifests** have shorter descriptions and carry `homepage`, `repository`, `license` and `keywords`.

## makarasty-tools 1.5.0, makarasty 1.5.3 — 2026-10-02

Read from 6,793 prompts typed by hand across 1,411 chats (2026-06-28 to 2026-10-01). The commands below
replace instructions that were being retyped, and the hook answers the limit that actually binds: over
2026-09, 208 of 533 chats passed 400k tokens of context and 94 passed 600k, the size at which a chat stops
being worked in.

- **`/makarasty-tools:handoff`.** "Hand this to another chat, offer it as a chip" was typed in 64 chats and
  "read the other chat's history" in 97. The command writes a handoff file outside the repository, offers
  the next chat as a chip whose prompt carries this chat's id, so the next chat can read this one with
  `list_events` or ask it with `SendMessage`, and stops. `from <chat>` is the receiving half: read the
  other chat, check its "done" against the repository, continue. A `mattpocock-skills:handoff` was
  invoked 9 times; it saved a document and stopped there.
- **A context hook.** `tools/hooks/context.mjs` reads the last main-chain usage from the transcript tail on
  each prompt and, at 400k and every 150k above, tells the chat to offer a handoff in one line. A
  `/compact` re-arms it. About 50 ms per prompt, the cost of a node start, measured equal to a shell start
  on this machine.
- **`/makarasty-tools:hold`**, the codeword mode: "молчи, пока не скажу абрикос" appeared in about 30
  chats. Items are collected one line each, then fixed grouped by shared component.
- **`/makarasty-tools:explain`**: "простым языком на русском" in 187 chats, and "too long, too formal" as
  the most repeated correction. A fixed answer shape, with each claim checked before it is said.
- **`review --loop`** fixes and re-reviews until a round finds nothing, at most three rounds, and accepts a
  directory. On a split review the finders run on Sonnet and the verify pass judges: "Sonnet agents for review, Opus checks their
  findings" was retyped in dozens of chats.
- **`ship` reads the other chats in the checkout first**: a file a still-running chat is editing stays out
  of every commit, and `mine` commits only this chat's files. It follows the repository's own update-log
  format and reads the last two entries. "Учти параллельную работу" was retyped in about 34 chats.
- **`fleet-login`** triggers on "залогинься", and takes credentials from the runbook, never from the chat:
  a password typed into a prompt stays in that chat's transcript on disk.

Then a red team: six Sonnet agents, two reading Anthropic's skill, hook and plugin docs and open-source
analogs, four running the commands against throwaway repositories, transcripts and a dry-run notifier.
About 90 findings; the ones that held were fixed, each fix re-checked by a second Sonnet pass.

- **`commit` committed another chat's staged file.** A bare `git commit` takes the whole index, which
  parallel chats share. It now commits by path (`git commit -F - -- <paths>`), checks attribution only on
  the commit it just made, amends only that commit while unpushed (`--amend --only`), and stops on a merge,
  rebase or detached HEAD instead of committing into it. `allowed-tools` is `Bash(git:*)`, not all of Bash.
- **`ship` could push straight to a protected main and loop on the rejection.** A push rejection is now
  read: fetch-first pulls, a protected branch or GH006 stops and says to open a PR, no remote finishes
  locally. `all` previews each branch with `git merge-tree` (squash-merged branches are skipped, other
  authors' branches asked about), a merge with more than ten conflicts or a contradiction is aborted
  before asking, so a half-merge never sits in a shared checkout. `tag -f`, `stash`, `reset --hard`,
  `clean` and `worktree remove` are named as off limits, with the reason.
- **A handoff chip opens in a fresh worktree** with none of the uncommitted work. The new chat moves to
  the original checkout with `change_directory`; where it cannot, a binary patch of tracked and untracked
  changes, written through a temporary index so the real one is untouched, is applied on a branch at the
  recorded commit. A compacted source chat is read up to its summary instead of paging forever; the file
  name carries the session id; the file is grepped for secrets before the chip.
- **The context hook** reads back in 2 MB chunks up to 16 MB, so a screenshot in the last turn no longer
  hides the reading, and stays silent without spending its level when the prompt is itself a handoff.
- **`notify`**: a turn that leaves a background job or loop running is not "finished"; `--next` no longer
  goes live on a task notification; the public-ntfy guard parses the host (`www.ntfy.sh`, `:443` leaked the
  excerpt); bad URLs in the config are rejected without echoing them and error text is redacted; markers
  are written by rename; stale markers are pruned on every run and `SessionEnd clear` drops this chat's.
  130 selftest checks; 24 of them fail against the previous `notify.mjs`.
- **`review`** reads a branch or PR target from that ref, not the working tree; with no target, `--fix`
  and `--loop` edit only this chat's files; the loop fixes `bug` and `risk [high]` only; a written list of
  what is not a finding; finders get a brief, not the chat history; read-only `allowed-tools` again.
- **`say`** has a live mode (one to three lines, gist after) and a written mode that keeps digits and ids
  as they are; the sample no longer carries real-looking codes a model could copy.
- **`unslop`** has Russian triggers and a Russian tic list, applies to replies for people only, and gives
  way on length to a terse mode instead of fighting it.
- **The nine commands are skills now**, `tools/skills/<name>/SKILL.md`, the layout Anthropic's plugin
  reference recommends for new work; `commands/` is its older format. Names and invocation are unchanged.
- **`commit` and `ship` start with the repository's state already in the prompt**: `git status`, the
  branches, the remote and the recent log are injected with `!` lines when the skill loads, so the first
  look costs no tool calls. Measured on this machine with a probe skill under `claude -p`: the injected
  status reached the model on Windows.
- **After a `/compact` the chat is told where the full conversation still is.** A `SessionStart` hook with
  source `compact` names the transcript file, so a detail the summary dropped is searched for instead of
  guessed or asked again.
- **A chat that pauses on a background job now says so once** ("paused: 1 background job still running"),
  so a job that never ends, a dev server, no longer means silence. A later turn whose jobs were all there at
  the pause is the finish.
- **`hold`** handles stop, remove and edit by number, and counts the codeword only alone or at the end of
  a message; **`explain`** reports only this chat's work and drops the generic triggers.

## 1.5.0 — 2026-09-10

A run finds well and decides badly. Seventeen runs on one application and six on another say the first
half plainly: 7 findings of 2,851 carried neither a `file:line` nor a number, so the evidence contract
holds where it was put. The second half is three failures that all have one shape — a rule that lives in
prose while nothing on the path enforces it.

- **A fix now arrives with a reproduction that was run.** "A fix arrives with a reproduction that failed
  before it and passes after" has been in `MISSIONS.md` since the fix kind existed, and one fix run landed
  164 changes with nothing checking. `fleet-gate.mjs prove` runs the command rather than recording a claim
  about it, before the change and after, and writes the exit code, the commit and a digest of the working
  tree into the claim. `fleet.sh finish` refuses a `fix` or `root` task unless the first failed, the second
  passed, the command was the same one, and **the tree moved between them** — a dead build daemon on a real
  run returned `BUILD SUCCESSFUL, 0 failures` over a tree whose fix had been reverted, and only a forced
  rebuild found it. A `before` that passes is reported as a refutation, which is the cheapest good news a
  fix run gets: roughly 15 findings in every 100 end that way.
- **A cause several findings share is ruled on once, before any of them is patched.** The fix queue splits
  by file cluster so no two workers open one file, which is also why a shared seam never gets fixed: it
  belongs to somebody else. Measured on one project, a duplicated guard was named for consolidation in
  three separate run documents across three runs and deferred every time as "out of scope per the brief",
  while three modules had the same handle-discarding timer patched three times under a note saying a fourth
  would turn three patches into one helper. `fleet-gate.mjs cluster` writes a `kind: root` task per
  candidate shared cause and gates its members behind it on `after:`, the ordering the queue already
  enforces. The root is the one task in a fix queue allowed to edit files another task names, because
  everything reaching its seam is held while it runs. Refuting a candidate is a complete result and
  releases the members to be fixed on their own evidence.
- **Two ceilings, both from a real backlog, both in `calibration.json`.** Replayed against a 436-finding
  audit, the first shape produced one candidate 51 findings wide because they all touched a 5,000-line
  command file: gating fifty-one tasks behind one worker serialises a run and returns nothing the file
  split does not already give, so a candidate over six members is reported as a hotspot and gates nothing.
  A token more than 15% of a run mentions is the project's vocabulary — without that cut, `forEach` and
  `playerData` came out as candidate causes. Identifiers are read from the mechanism rather than from the
  whole finding for the same reason, and one file cited at two depths (`Timer.java` and
  `.../arc/util/Timer.java`) is one file. After both: 42 roots over 128 of 219 fix tasks, sized two to six.
- **An edit that drops a name something outside the repository reads is refused.** Three changes shipped
  from one project's runs with no question asked: two endpoints moved behind session authentication, so
  unauthenticated monitoring nobody in the run could see began getting 401; a history clear moved onto an
  event that also fires on a console `load`, so a restart plus an autosave load truncated history that had
  survived it; a detector deleted rather than repaired, whose rewritten config comment forced six servers
  to rewrite their configuration on next boot. All three were reasoned through carefully. The same runs asked
  86 questions and got 85 answers, so the operator was there throughout, and the gap was not taste. `hooks/fleet-contract.mjs` runs on `PreToolUse` and blocks an edit that removes a token listed in
  `.fleet/contract-surface.txt`, offering two ways past, both one line: file the `ask/`, or record the
  decision. `decisions.jsonl` is read out at landing. It is timid like `fleet-guard`: no fleet, no chip, or
  no surface file and it exits 0, and it raises a given name once per session, ever.
- **`fleet-gate.mjs surface`** generates that file from the tracked sources — routes, exported names,
  configuration keys, event names — and `fleet-init` now runs it and tells the operator to trim and commit
  it. The ignore rule for `.fleet/` changed shape with it: `.fleet/*` plus a negation, because git does not
  descend into an excluded directory and `.fleet/` on its own leaves the negation silently dead.
- **`fleet-gate.mjs asks`** prints every open question as one round with the recommendation its worker
  filed, and the decisions taken without asking underneath. What costs the operator is not the count but a
  question arriving alone in a chat they are not sitting in.

### Fourteen defects in `fleet.sh`, and what they had in common

Most of them were a guard that had never once fired, or one that fired on the wrong thing. The self-test
went from 167 cases to 282; 32 of the new ones fail against the old script.

- **One extra key turned the finding gate off.** An auxiliary line (`created`, `state_changed`) ran no
  checks at all and the `else` after it held every requirement, so
  `{"created":"note","severity":"blocker","area":"","observed":"","evidence":"","what":"x"}` was filed and
  exited 0 — an evidence-free blocker with the retired field name, straight into the backlog, because the
  merge routes on `severity` alone. Auxiliary lines have their own shape now: no `severity`, `created`
  needs `where`, `state_changed` needs `when`, and `what` is refused on every shape.
- **`unlink` refused itself, and so did worktree registration.** Both are documented as being run from
  inside the worktree, and the path guard treated a path containing the shell's working directory as
  unsafe — a path contains itself. That guard is the [M32] step, the one that stops `git worktree remove`
  from following a `node_modules` junction and emptying the main checkout, measured seven times out of
  seven. It had never succeeded once: across every run on this machine, worktrees registered came to zero.
  The predicate is right for a command that deletes a tree and wrong for two that do not, so those two now
  drop that term and `clean` keeps it. The self-test previously called `unlink` with an explicit path from
  the main checkout, which is why the documented path was the untested one.
- **The abort clock could never exit early**, for exactly the workers it guards. Its exit conditions were
  relative paths under `.fleet/`, and a worker that writes code sits in a git worktree where `.fleet/` is
  gitignored and therefore absent — so every clock ran its full term, up to twice the budget, and then woke
  a session that had finished hours before. Paths are absolute now, `.blocked` counts as an ending, and
  `<run>/FINISHED` is checked first and every round, so **one `landed` call ends every clock still armed
  anywhere on the machine**. The poll `drained` prints carries the same escape, which leaves nothing this
  plugin arms that a landing does not reach.
- **`landed` counted one chip twice.** A chip that wrote both `.blocked` and `.done` closed a two-worker
  run on its own, wrote `FINISHED`, and paged the operator's phone on that count.
- **The `verify` lane was claimable by nobody.** It is defined in `LANES.md`, `next` filtered on an exact
  match, and chips are only ever told `pane` or `repo` — so a verify task sat in the queue and `landed`
  then refused the run over a claim nobody could make. A repo worker takes it when no other verify task is
  held, and `next` says so. Stated in the code as what it is: a width, not a lock.
- **Without node, `sweep` reported health for a dead fleet.** The age helper returned empty, every claim
  read as zero minutes old, and the one instrument for a dead worker printed `no abandoned claims`.
  `recover --release` was worse: an empty quiet time sent every live chip down the resume branch. Those
  three refuse now rather than answer wrongly.
- **A pane walk that failed validation was unclaimable forever.** The claim directory stood, `pane-next`
  skipped it for every host, and the requester polled a result that was never coming; nothing swept
  `pane/running/`. A walk has no heartbeat, so it gets a lease instead — `pane_walk_lease_minutes`, a
  chosen 30, in `calibration.json`.
- **Releasing a task deadlocked its wave.** Every task whose `after:` named the released one waited on a
  done marker nobody would write. `--release` cascades now, transitively, skipping anything a worker holds.
- **`summary`'s rows and its totals read different globs**, so a run with a chip id like `cid-03` printed
  rows full of findings above a total of zero — and paged that zero to the phone.
- **A refused finding still created the chip's file**, so a worker whose first finding was rejected read
  afterwards as a chip that had found nothing rather than one that had never filed.
- Plus: `$run` unquoted in the two command strings printed for an operator to background, so a project path
  with a space armed a clock on the wrong directory; a `|| echo "  none"` that could never fire, because
  the pipeline's status was `sed`'s; and `cal` spawning an `ls` and a fresh `node` per constant lookup on
  the hottest path in the protocol. The calibration file is read once at startup now: `next` went from
  ~438 ms to ~320 ms per call, and `clock`, which is almost nothing but constant lookups, from 238 ms to
  146 ms.

### The two halves of the merge that could not disagree

`fleet-merge.mjs` refused to finish "if the sightings do not add up to the input or if a blocker present in
the input is absent from the output", and `fleet-collect.md` cited a 254-finding run as proof. The
sightings half was summed from the groups that had just been built out of the input, so it was `n === n`;
a merge sabotaged to write one row fewer than it grouped still reported every finding accounted for. It now
reads `backlog.jsonl` and `skipped.jsonl` back off disk, matches them to the chip files by finding id,
re-lists the directory so a `*.jsonl` it never opened fails the run, and removes what it generated when the
check fails, since `landed` gates on that file existing.

Three more, all of them silent:

- One worker's `skip_reason` took another worker's independently reproduced blocker out of the backlog with
  it, because the group's fate was read off whichever same-severity sighting loaded first. A group is
  skipped only when every sighting in it was, the strongest evidence is now the head, and skip reasons
  travel on the merged row.
- A chip id that was not a bare number — the register has held `cid-03` since 2026-09-03 — had every
  finding it filed dropped by the merge, which read only `NN.jsonl` while `fleet.sh find` writes for any
  chip string and prints `FILED`. Every `*.jsonl` is read now, and the files read and the files skipped are
  both named in the output.
- `fleet-retro.mjs` matched a session to a run by plain substring on its first message, so
  `2026-09-08-full-audit` collected every session of `fix-2026-09-08-full-audit`, and chip numbers that
  collide across runs were charged against the wrong completion marker. That is where a "1,935 minutes of
  session life after done" figure came from. The run id must match whole, the run's own register decides
  membership, and a session that cannot be attributed is left out and counted rather than guessed at.

### The reading path, halved

Every line on a mandatory path is paid on every run by every session, and the path had grown until
`fleet-run.md` demanded the pane be opened "before anything else you would read" with 1,381 lines mandated
above that paragraph.

| Path | Before | After |
|---|---|---|
| Worker, before its first task | 1,305 | 458 |
| Worker, pull mode, before its first claim | 1,715 | 868 |
| Worker, pane branch, whole run | 2,776 | 2,011 |
| Planner, before it can write a brief | 1,398 | 834 |
| Planner, pull mode with panes, whole run | 2,850 | 1,783 |

Pointers name a section rather than a file, `PROTOCOL.md`'s finding schema waits until findings are
written, `WORKTREES.md` until the tree is removed, and `BROWSER.md` until past the gate — with the gate
expression itself inlined, since that one line is what is needed first. The nine-line plugin-directory
preamble that stood at the top of nine command files is four lines now. Raw totals are flat; the path is
not.

Eight contradictions went with it, each one rule stated two incompatible ways: findings through
`fleet.sh find` or appended by hand (the gate wins everywhere — a hand-written line passes no check); who
writes `.done` (`drained` in pull mode, by hand only on an assigned brief, where there is no queue to
drain); three mutually exclusive end-of-turn states in one file; the pane ceiling as ten, five and two,
which are three different things and are now named as such; what the finding gate actually refuses,
rewritten from the code; a `while true` watch held up as a cautionary tale two files from the `while true`
watch this plugin supplies; a brief spec carrying a field only tasks use and missing two the queue parses;
and `fanout:`, kept with "no script reads this field" said out loud.

### Models: the knob that turned out to exist

`MODELS.md` said per-stage reasoning effort was "a knob that does not exist" and told planners to treat
effort as a session-wide dial. The first half is still true of the `Agent` tool's parameters; the
conclusion drawn from it was wrong. A subagent definition takes both `model:` and `effort:`, and effort is
the one nothing overrides per call — so `fleet-scenario` (sonnet/high), `fleet-profiler` (sonnet/medium),
`fleet-triage` (haiku/medium) and `fleet-design-eye` (opus/high) now carry their tier and their effort,
each with a sentence saying why. The model resolution order, both environment variables and
`modelSettings.<id>.effortLevel` are written down, along with the one thing that is not settled: the
documentation says a session started from a chip takes the dispatch default rather than the spawning
session's model, and this plugin's operator reports the opposite in practice. That is recorded as an open
question with the experiment that settles it, rather than answered from either side.

### What actually blinds a pane, and what a pane actually costs

Two measurements on 2026-09-10, both of which overturned a rule this plugin had been enforcing.

**[M33] The screen has nothing to do with it.** A sampler left in a page for 463 seconds, recording frames
per second while the operator moved the pane through six states by hand. A pane fully covered by another
window composites at 300 frames a second. So does one on a second monitor with a corner showing, and so
does one pushed entirely past the edge of the desktop at `screenX` 5032. Two things stop it: another tab
being selected in its window, and that window being minimised. The ceiling of five panes, justified by how
many tile readably on a display, was measuring the wrong constraint - panes nobody is watching can be
parked off the desktop and go on working, and the ergonomics section that offered that as a risky trick
now offers it as the answer.

Three signals that look like they could replace the frame gate, and cannot. `innerWidth` held its real
value through 142 consecutive seconds of zero frames. `document.visibilityState` reported `visible` on a
pane delivering nothing, immediately after a screenshot was taken of it. And `tabs_context` answered
`The Browser pane is currently displayed` while the page inside it drew zero frames at a width of 949 px.
The host's flag sees whether the pane has a place in the layout, which is a different question.

Two behaviours nothing had named. **The first second after a tab is selected delivers zero frames**, at
both transitions, so a gate fired the instant an operator says they have opened the pane reads blind and
sends the worker back to ask for a pane that is already open - read zero, wait a second, read again.
And a **minimised window emits stray seconds of 2 to 4 frames**, which is the mechanism behind the
existing rule that a reading between 1 and 59 is blind: a `frames > 0` check would have passed that worker.

The same two pane states also split `setInterval`, and it fails worse than silence. With the pane not laid out it ticked
3 times in a minute. With the pane laid out but not compositing it ticked **142 times in 142 seconds**,
one per second, exactly on time, while the page drew nothing. `PERF.md` told workers to sample with it;
now it tells them to put the frame gate beside every series it produces.

**[M34] A pane is one renderer per tab and about 113 MB, and then whatever the page weighs.** Closing and
reopening reproduced that to within a megabyte. Then 150,000 DOM nodes went into one tab: that renderer
went **132 MB to 2,061 MB**, free memory 14.9 GB to 12.0, commit 33.5 GB to 36.3 against 31.2 physical.
A reload gave none of it back - only closing the tab did. [M21] measured +344 MB per pane in August and
concluded that RAM does not cap a fleet; the number was right and the conclusion was about a light page,
so that entry is now marked superseded rather than corrected.

### Memory discipline, in three refusals

The operator's machine dies of this, and the rules against it were prose - in `LANES.md`, in `MODELS.md`,
and in the operator's own `CLAUDE.md` - which this project measures at approximately zero compliance. They
are refusals now, at the three places the cost is visible.

- **`fleet.sh next` reads the machine before every claim.** Below `memory_floor_gb` it hands out nothing:
  exit 6, `MACHINE TIGHT`, and the loop to background while waiting. It refuses the task and never the
  worker, because a session that stops because it was refused is a dead chat and nothing restarts one
  [M03]. It releases only above `memory_clear_gb`, and the gap between the two is hysteresis: with one
  threshold every held worker claims again on the same reading, together, which is the moment the box dies
  rather than the moment it recovers. `fleet.sh status` names who is held, since a worker waiting on memory
  holds no claim and would otherwise appear nowhere.
- **A `PreToolUse` hook refuses a full test suite or a full typecheck** from a worker that does not hold
  the verify lane, when the machine is tight or one is already running. It names the scoped form and the
  verify lane in the refusal, and it raises itself once per session, ever. The verify lane exists for
  exactly this and, until this release, could not be claimed by anybody at all.
- **The same hook refuses a browser call on a full machine** and tells the worker to close its pane, since
  a reload returns nothing and only closing the tab does [M34].

`fleet-load.mjs` gains `--clear <GB>`, which exits 0 when there is room and is what a held worker waits on,
and its `tight` reading moves into the census where callers can read it rather than being computed inside
the human-readable table.

**And the census was broken.** `JSON.parse` was refusing the whole 200 kB process list because one command
line on this machine carried a bell character - an agent's own arguments, four of them - so the census
threw and every caller fell back to a default. `fleet.sh width` falls back to a flat cap of six, which
means the memory term had been silently absent from lane sizing on any machine running a process with a
control character in its arguments. Control characters are stripped before the parse now, and a parse that
still fails says so instead of returning an empty list. Fixing it was what made the rest of this section
possible: every refusal above reads that census.

### Seams, for cutting rather than porting

`PORTING.md` gains a table of the four optional halves — call, design and canvas, worktrees, browser and
panes — with what dangles when each is removed. Call is clean: four files and one mission section. Design
leaks two conditional lines into core. Worktrees take the path gate with them, which is reason enough to
keep both. The browser half cannot be cut by deleting files, and does not need to be: every pane document
is behind a branch pointer, so a paneless project pays only for prose sitting on a shelf, not for turns in a run.


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
  catches, and **where the guards stop**: a worker's own exit is not gated, an
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
- **The commands were audited against the published frontmatter spec, and two contradictions came out of
  it.** `README.md` and `commands/fleet.md` listed `fleet-run` among the commands only the operator may
  start, while its frontmatter correctly allows model invocation - and it has to, because the operator
  starts a worker by clicking a chip and the model in that new session is what invokes `fleet-run` there.
  Acting on the prose would have broken every worker. Separately, `fleet-redesign` told the model to run
  `/makarasty:fleet-design` when the canvas was missing, which the harness blocks: that command carries
  `disable-model-invocation`. It now prints the line for the operator instead. `docs/COMMANDS.md` records
  the invocation contract, the checklist before adding a command, and the field most easily misread:
  `allowed-tools` is a one-turn permission **pre-approval**, not a restriction, and it cannot separate
  `fleet.sh clean --remove` from the safe helper calls that share its prefix - which is why the protection
  lives in the dry-run default and the path gate instead.

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
- **`templates/call-script.html`**: the styles and fixed sections of the earlier vendor-call page, so the script task
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
- **Not done, written down:** no fleet has prepared a real call yet; the vendor-call page this is
  modelled on was written by hand in one chat.

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
  Distilled from a vendor call script of 2026-08-21 and the two corrections that produced it. `unslop`
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
never installed by anyone but the author. Nothing was released, so nothing was ever upgraded; this is
version one.

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
