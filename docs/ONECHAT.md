# One chat

The default fleet. One coordinator chat runs the queue and spawns one fresh background subagent per task,
in the main checkout, on its current branch. No worker chats, no worktrees: both are opt-in (last section).
You re-read this file whenever you coordinate; it carries no history, only the rule and one clause of
evidence. `${CLAUDE_PLUGIN_ROOT}` is the makarasty plugin's directory.

```bash
f="${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh"
r=<absolute run dir>
```

## Before the loop

1. The `pace:` line is in `STATE.md` (`fleet-plan` Round 0). It sets every model, effort and round below,
   and its scale sets the queue's size and whether you warn the operator of a night's run and a coordinator
   relaunch (`docs/MODELS.md`, "Pace").
2. Record what was dirty before the run: `git status --porcelain -uall > "$r/dirty-at-start"`. Those are the
   operator's own uncommitted edits. Nobody stages, reviews as task work, or discards them.
   Every line here runs from the folder that holds `.fleet`, and `owns:` is relative to it. Porcelain prints
   paths relative to the git top instead, so `dirty-at-start` and every `files` list below hold top-relative
   paths. In a project below the git top the two differ by `$(git rev-parse --show-prefix)` (`app/`, say).
3. Write `$r/RULES.md`, the one file every spawn prompt names. At least: the project rules the work must
   keep (from `CLAUDE.md` and `FLEET.md`, quoted, not summarised), the evidence contract in one line (a
   `file:line`, a reproducing expression, or three readings with spread and machine load), the finding
   shape (`docs/PROTOCOL.md`, "Finding schema"), and the shared-checkout rules from "One checkout" below.
4. Register the slots, one call per lane, disjoint ranges, all in one turn:

   ```bash
   sh "$f" width "$r"                          # the repo lane's width: queue and free memory, never a question
   sh "$f" chips "$r" 01-03 repo --agents
   sh "$f" chips "$r" 04-04 pane --agents      # the pane lane is 1 in one chat [M42]
   sh "$f" chips "$r" 05-05 verify --agents    # only when the queue holds a needs: verify task
   ```

   It prints `SLOT NN lane <lane>` per slot and one instruction line, offers no chip and takes no `--model`.
   A slot is a chip number you hold for your subagents: `NN.jsonl`, `NN.done` and a claim's owner all say
   `NN`. The hooks treat each subagent of this coordinator as chip `agent-<agent_id>` for the pause gate,
   the memory guard and the contract hook. A `needs: verify` task goes to the first `next` from any slot
   but a pane one: a repo slot takes it too (`LANE repo`, then `VERIFY LANE`), and one runs at a time
   across the run. A verify slot claims verify tasks only, and gets `7` while another slot holds one.
5. Arm the watch: `/makarasty:fleet-wait <run-id> <slot count>`. A coordinator that cannot run slash
   commands (headless, or itself a subagent) runs the loop from `commands/fleet-wait.md`, "The loop",
   through the `Monitor` tool where you have it, so each watch line reaches you as it is printed. Bash with
   `run_in_background` is the fallback only: it surfaces nothing until the loop exits, up to 30 minutes.

## The loop

For each free slot `NN` in lane `<lane>`:

1. **Claim, header and frontmatter.** `next` prints a header, a `---` line, then the task file, which opens
   with its own `---` frontmatter. The third `---` closes the frontmatter: you see the header and
   frontmatter (`owns:`, `kind`, `model`, `verdict-model`, `test:`, `repro:`, `needs:`) and never
   the body; the subagent reads the file.

   ```bash
   o=$(sh "$f" next "$r" NN <lane>); rc=$?; printf '%s\n' "$o" | awk '/^---$/&&++n==3{exit}1'; echo "rc=$rc"
   ```

   - `0`: `CLAIMED <id>`, `BUDGET_MIN`, `ARM_CLOCK`. Ignore `DELEGATE`: it is for chat workers, and a
     subagent already is the delegation.
   - `3` drained: `sh "$f" drained "$r" NN <lane>` writes `NN.done`; that slot is finished. A pane or
     verify slot that never had work is drained the same way, or `landed` waits for it. Its exit `5`
     means the queue is still open: treat it as `7`. Ignore its `GIVE YOUR BROWSER MEMORY BACK` (close
     the heavy tab) and `RENAME THIS SESSION TO` lines: they are for a worker chat, and this chat is yours.
   - `7` waiting: tasks held by `after:`, the verify lane or an uncleared `operator:`. Spawn nothing on this
     slot; claim again on the next completion or watch line.
   - `6` machine tight: background the wait line it prints, claim again on `memory-back`.
   - `8` paused: spawn nothing (Pause, below). `2 HOLDING`: the slot still holds a claim; finish it first.
   - `9` `RUN FINISHED`: the run has landed. Spawn nothing on any slot and `TaskStop` the clocks you
     backgrounded; the rest of that line is for a worker chat.

   On `0`, before the spawn, save what the task's paths held before it, always (it prints nothing):

   ```bash
   { git status --porcelain -uall -- <owns paths>; git diff -- <owns paths>; } > "$r/tasks/claimed/<id>/before.diff"
   ```

   A code task (fix, root, implement, design) never goes out without `owns:`: add it to the task file first,
   or its edit is missing from the end commit and from review. A task with no code and no `owns:` gets an empty one, `: > "$r/tasks/claimed/<id>/before.diff"`, and later an empty
   `files`: git with an empty pathspec reads the whole tree, so never run these lines without paths.

   A `kind: fix` or `kind: root` task also gets its failing run recorded now, from the main checkout,
   because `finish` refuses it without a before and an after. The command is the frontmatter's `repro:`.
   When that line is empty (`fixqueue` found steps or prose, or a root has a member without a command),
   write one into the task file's `repro:` line first: one shell command that fails while the defect is
   there. For a fix, make it from the body's reproduction; a long body goes to a Haiku `[mech]` agent that
   reads it and returns that one line, so the body stays out of your context. For a root, rule on it from
   its members' `repro:` lines and reproductions (the tasks in `gates:`); when no one command covers them,
   give the claim back by "A fix or root that cannot be proven", below.

   ```bash
   g="${CLAUDE_PLUGIN_ROOT}/scripts/fleet-gate.mjs"
   node "$g" prove "$r" <id> before -- '<the repro: line, word for word>' 2>&1 | tail -1
   ```

   Pass it as one single-quoted argument (a `'` inside written `'\''`): `prove` runs a single argument as
   written, and a root's `(a) || (b)` left bare is parsed by your own shell instead. A `repro:` uses forward
   slashes: `prove` runs it in bash, where `node sub\x.mjs` runs `subx.mjs` (bash on Windows takes `node sub/x.mjs`).

   A last line `the reproduction passes already ...` (after `before: exit 0`) means the finding is refuted.
   Spawn no coder, write
   that in `$r/NN.notes.md`, and run `FLEET_REFUTED=1 sh "$f" finish "$r" NN <id>` (a `kind: fix` only when its `before` passed; a `kind: root`
   whatever `before` did, once `$r/NN.notes.md` holds a line `refuted <id>: <why the shared cause is a coincidence>`).

   A task whose frontmatter has `handback-of: <old id>` (filed by "A fix or root that cannot be proven",
   below) skips both lines: `next` already copied the old claim's `before` into its proof, and a new
   `before` would run over the predecessor's partial edits. Copy the old claim's list instead:
   `cp "$r"/tasks/claimed/<old id>.released-*/before.diff "$r/tasks/claimed/<id>/"`.
2. **Background the `ARM_CLOCK` line**: run the `clock` command it names and background exactly what that
   prints (`run_in_background`). It prints `budget-elapsed-<id>` at twice the budget, and it is the only
   thing that catches a hung subagent: the watch's `STALL` counts no heartbeats, fires on any long task,
   and is information only. On it: `TaskStop` that agent and re-spawn once on the same claim,
   told the edits in its `owns:` are its predecessor's to continue, with a fresh clock. On a second firing,
   `TaskStop` the agent. A task with no proof to give (no `kind: fix` or `kind: root`) then finishes with
   the remainder written as unreached in `NN.notes.md` (with a `test:` line and no recorded pass, also
   `untested <id>: <why>` there and `FLEET_UNTESTED=1` on `finish`). A fix or root task never does: `finish` refuses it
   unproven, the claim stays held, and everything `after:` it (a root's `gates:` members) and `landed`
   wait for ever. It goes the way of "A fix or root that cannot be proven", below.
3. **Spawn the subagent**: `Agent`, `run_in_background: true`, `model` and `effort` from the pace line
   (always pass `model`: an unnamed one inherits your tier). Type by task kind:

   | Task | `subagent_type` |
   |---|---|
   | implement, fix, root, a repo verify, investigate, research | `makarasty:fleet-coder` |
   | review | `makarasty:fleet-reviewer` |
   | `needs: pane` walk | `makarasty:fleet-scenario` |
   | critique, and the look of a `design` task after its coder | `makarasty:fleet-design-eye` |
   | `kind: canvas`: recon, compare (`needs: pane`) | `makarasty:fleet-scenario`, at the task's `model:` (sonnet) |
   | `kind: canvas`: system, screen, assemble (`needs: repo`) | `makarasty:fleet-coder`, at the task's `model:` (system and screen: the design tier) |
   | `kind: redesign`: directions, propose | `makarasty:fleet-coder` at the design tier, the top one; assemble at sonnet |
   | speed, stability, `kind: perf` | `makarasty:fleet-profiler` |

   The prompt is paths, never content:

   ```
   Task <r>/tasks/ready/<id>.md. Run <r>. Rules <r>/RULES.md. Chip NN.
   owns: <the task's owns: line>
   Test: timeout 590 <the task's test: line, the scoped test command>   (a hit limit is reported, never retried)
   Tab: <tabId>                      (browser agents only)
   Proof, after your change: node "<g>" prove "<r>" <id> after -- '<the repro: line, word for word>'   (fix, root)
   Test proof, after your change: node "<g>" prove "<r>" <id> after -- 'timeout 590 <the test: line, a `'` in it written `'''`>'   (instead of running Test bare; no before)
   Include the Test proof line only for `kind: implement` or `design` with a `test:` line when `<r>/RUN_FORMAT`
   holds 2 or more (the run's format stamp, written at its first `next`); a run stamped 1 has no such gate.
   Findings: sh "<f>" find "<r>" NN, one JSON finding on stdin; it files, it is no probe. Heartbeat: sh "<f>" beat "<r>" NN <id>.
   Never next, finish, drained, commit, git add -A, stash, checkout --, switch.
   Report in at most 15 lines: files changed, test result, what is left.
   Last line (fleet-coder only): DONE, DONE_WITH_CONCERNS: <one line> or BLOCKED: <one line>.
   ```

   `timeout 590` is the Bash form (exit 124 = limit hit), kept under the 600000 ms both shell tools stop
   at; the Bash tool's own `timeout` parameter is set to 600000, since its default of 120000 ms cuts first.
   In PowerShell `timeout` is timeout.exe, a sleep: use the PowerShell tool's own `timeout` parameter (ms,
   at most 600000). Longer, in either shell: a background run plus `TaskStop` at the limit. macOS without coreutils: `gtimeout`, or background plus `TaskStop`.

4. **On its notification**, read the report. A `fleet-coder` report ends in `DONE`,
   `DONE_WITH_CONCERNS: <line>` or `BLOCKED: <line>` (`agents/fleet-coder.md`); read that line first. Other
   agents' reports have no such line. Concerns go to `NN.notes.md`. On `BLOCKED`:
   - `repro invalid: <why>`: the `repro:` fails for a reason outside the defect. Ask the operator with one
     `AskUserQuestion`; no handback, since the next coder meets the same command.
   - Any other fix or root goes by "A fix or root that cannot be proven", below.
   - Any other kind: write the remainder as unreached in `NN.notes.md` (and `FLEET_UNTESTED=1` as step 2
     says, when its `test:` never passed), then review it as below, telling the reviewer the task is
     BLOCKED and partial: it rules on what is there, not on what is missing. Its edits sit in the tree and
     in the `files` list of step 5 either way, so the end commit would carry them unreviewed otherwise.

   Every ruling you make in this step (a defect filed, a handback, a BLOCKED route, a re-review skipped) is
   one line, `ruling: <what> - <why>`, in your next `STATE.md` update; `fleet-collect` lists them.

   Otherwise, for a code task spawn `makarasty:fleet-reviewer` at the
   task's `verdict-model` (the pace line's when it names none) on `git diff -- <owns paths>` and
   `git status --porcelain -uall -- <owns paths>`, told to read every `??` file whole (a new file is in no
   diff; never `git add -N`, the index is shared), with the task file, the claim's `before.diff` (so it
   rules on this task's change only; an empty one means the whole `owns:` diff is this task's) and
   `$r/answers/00-broadcast.md` if it exists. The verdict is short:
   pass, or defects each with the input that breaks it. Rounds by the pace line:
   - Fastest finish: one review, no re-review; blockers become fix tasks; one scoped verify at the end of the run.
   - Balanced: one review, then one fix round (a fresh `fleet-coder` on the same claim with the defects),
     then one re-review.
   - Best quality: fix and re-review until a round finds nothing, bounded by the task's clock; a review that
     found no defects needs no re-review.

   A fix round is that fresh `fleet-coder`. When a cheaper tier did the task and the reviewer rejected it
   (Economy, below), the same spawn goes one tier up: the bump is the fix round, not a second one.

   **Re-review**, after every fix round: an unreviewed fix is where regressions land. Before the fix coder
   starts, save the paths as step 1 does, into `tasks/claimed/<id>/pre-fix.diff`. Spawn `fleet-reviewer` at
   the model of the first review, with the defect list, the task file, that file as its `before.diff` and the
   same `??` rule. It answers `ADDRESSED` or `NOT ADDRESSED` per defect, then any defect the fix itself
   introduced; nothing else. All `ADDRESSED` and nothing new: go to step 5. Otherwise:
   - A defect with a runnable check becomes a fix task, filed while `tasks/queue-open` is held. Write the
     task file (`task-id: <id>-fix`, `kind: fix`, `owns:`, `repro:` the check, the defect as the body) and
     run `sh "$f" file "$r" <id>-fix < <that file>`. It runs as any fix task, proof and review included.
   - A defect with none (an unrequested hunk, a test that cannot fail) goes to the operator with one
     `AskUserQuestion` naming the task and the defect; the claim stays held. A second reject by the Economy
     rule below goes the same way.
5. Write the task's file list, then finish, no branch (one checkout), then claim again on that slot:

   ```bash
   git status --porcelain -uall -- <owns paths> > "$r/tasks/claimed/<id>/files"
   sh "$f" finish "$r" NN <id>
   ```

   The claim's directory stays where it is after `finish` (the done marker is the file `tasks/done/<id>`),
   so the lists are on disk for the end commit and a crash. Exit `1` with "done marker NOT written" is a fix
   or root task the gate did not prove, and its `NOT PROVEN` line says why. No `after` recorded, or the
   reproduction still failing after, goes back to a fresh `fleet-coder` on the same claim with that line,
   inside the task's clock; once the clock has fired twice, "A fix or root that cannot be proven" applies.
   An implement or design task with a `test:` line gets the same refusal, `NOT TESTED`, in a run stamped format 2:
   it goes back to a fresh `fleet-coder` the same way, told to record the pass (`docs/GATE.md`, "test"). A fix round
   after a review runs the test through `prove` again, since a change to `owns:` after the pass is refused.
   `FLEET_REFUTED` closes a `kind: fix` task only when the last `before` recorded passed (exit 0); with no
   `before`, or one that failed, `finish` refuses it as without the flag and says why. A `kind: root` task
   closes with it plus a non-empty `refuted <id>: <reason>` line in `NN.notes.md` whatever `before` did, since
   a root ruling the shared name a coincidence has no passing run to show; `finish` refuses it without the line.

A pane, research or verify task with no code skips the review; a `verdict-model` above its walker gets one
ruling pass over the findings (`docs/MODELS.md`). When every slot has written `NN.done` and
`tasks/queue-open` is gone, run `/makarasty:fleet-collect`: it runs `merge`, then `landed <run> <slot
count>`, which refuses a run with no `backlog.jsonl`. By hand: `sh "$f" merge "$r"` first.


### A fix or root that cannot be proven

Never `finish` an unproven fix or root task, and never `FLEET_REFUTED` one whose `before` failed. Give the
claim back instead, so the run moves on:

1. Write what was tried and why it failed into `$r/NN.notes.md`, one short paragraph. A coder that stops
   with `BLOCKED` after three failed attempts (`agents/fleet-coder.md`) gives you the attempts in its report.
2. `sh "$f" handback "$r" NN`. It renames the claim to `<id>.released-<ts>` and files the task again as
   `<id>-r<k>`, with `handback-of: <id>` (`next` copies the old claim's recorded `before` into the new claim's proof) and
   `continued-from-chip: NN`. Every task whose `after:` named `<id>`, a root's `gates:` members too, now
   names the new id. On a slot it prints `RELEASED NN` and retires nothing: claim again on the same slot.
   The edits stay in the shared checkout for the next coder to continue.
3. The re-filed task runs as any other (step 1 skips its `before`). Its coder is told to read
   `$r/NN.notes.md` first.
4. If the re-filed task also cannot be proven, ask the operator with one `AskUserQuestion`, naming the task,
   the `before` evidence and both attempts. Its claim stays held until the operator answers.

## Commits

Workers never commit. You never commit in your own context either: a commit goes to one `Agent` with
`model: "haiku"`, description starting `[mech]`, given the exact paths: the union of the `files` lists of
the done tasks it covers (`tasks/claimed/<id>/files`), minus the paths in `dirty-at-start`. Those lists
are porcelain lines (` M a.js`, `?? b.js`): strip the 3-character status before using a path, and a
rename, `R  old -> new`, gives both `old` and `new`. The paths are relative to the git top (Before the
loop, step 2), so it runs both lines there:
`git -C "$(git rev-parse --show-toplevel)" add -- <the new (??) paths>`, then
`git -C "<top>" commit --only -m <msg> -- <paths>` with the same top: `--only` commits those
paths and nothing else the index holds, so the operator's staged work stays out. Never `-A`: the operator's uncommitted work lives in the same tree. A file
that is both in `dirty-at-start` and changed by a task is the operator's call: list it, do not stage it.

Cadence, from the pace line: **one commit at the end of the run** (the default and the cheapest), or one per
wave; with opt-in worktrees each task commits on its own branch. Reviews read the uncommitted diff of `owns:`, so none of them waits on a commit.

## Economy: the top model decides, everything mechanical goes cheaper

| Step | Maximum economy (default) | Balanced | Spend for speed |
|---|---|---|---|
| Coder | Sonnet, effort `high`, never `max` | Sonnet `high` | Opus `high` |
| Reviewer, the verdict | Sonnet, on every code task | Sonnet; Opus on implement, root, design | Opus `xhigh` |
| Commit, `STATE.md` update, reading a log or a large file | Haiku `[mech]` | Haiku `[mech]` | Haiku `[mech]` |
| Merge (worktrees, opt-in only) | Sonnet `[exec]` | Sonnet `[exec]` | Sonnet `[exec]` |
| Design | top tier, always | top tier | top tier |

The full table and the router that honours `[mech]` and `[exec]`: `docs/MODELS.md`, "Pace" and "The
router". You, the coordinator, keep the plan, the verdicts and the decisions, and nothing else.

A task the reviewer rejects after a cheaper tier did it is re-spawned once, one tier up (Haiku, Sonnet,
Opus), on the same claim, and you note it in `STATE.md`; that re-spawn is the fix round of step 4, and its
re-review follows. A second reject, or a re-review that still finds a defect with no runnable check, goes to the operator as one `AskUserQuestion` (fleet-plan 8b: file what does not depend on it first).

Why this is cheaper, and the estimate behind it: `docs/MODELS.md`, "Pace".

## Context hygiene

Your context is the run's ceiling: about 3-4 k per task, so 150-200 tasks per 700 K [M43]. Keep it there.

- Claim with the header and frontmatter only (`awk '/^---$/&&++n==3{exit}1'`). Never print a task body.
- Spawn prompts carry paths, never pasted content.
- Reports at most 15 lines; reviewer verdicts short.
- Never read a diff, a log or a findings file yourself: `fleet.sh status`, the verdicts and `ask/` only.
  Anything larger goes to a Haiku `[mech]` agent that returns a line.

## One checkout

- Every code task carries `owns:`, the files or directories it may touch. Two tasks whose `owns:` overlap
  are ordered with `after:` when you file them; `next` does the rest.
- Every command you or a subagent start that can hang (tests, typecheck, build, a dev server, a wait loop)
  carries a kill-after limit of about twice its normal time; a hit limit is reported, never retried. The
  task clock stops a hung subagent, not necessarily the test run it started; `fleet.sh procs <run>` lists
  orphaned runs (unverified for a subagent's child in one chat), so the limit is what you rely on.
  Bash: `timeout 590 <cmd>`; PowerShell: the tool's `timeout` parameter, never `timeout` the command;
  macOS without coreutils: `gtimeout`, or a background run plus `TaskStop`.
- Subagents run the task's scoped test command only. A full suite or typecheck is a `verify` task, one at a
  time, filed `after:` every code task of its wave, so `next` holds it while a coder of that wave runs.
- A `needs: pane` task is filed the same way, `after:` the code tasks of its wave: a coder's half-saved
  file trips the dev server's hot reload, and the walker files a false finding.
- Nobody runs `git add -A`, `stash`, `checkout --`, `switch` or `reset`: one wrong one discards another
  task's or the operator's work in the shared tree.
- A subagent calls only `find` and `beat` with its slot's `NN`; `next`, `finish` and `drained` are yours.

## Browser

One chat has one live tab: the foreground tab drew 272-300 fps while a background tab drew 0-2, measured
2026-10-19 [M42]. So the pane lane is **1**: browser subagents run one at a time, each told its `tabId`.
The gate is read **twice, a second apart, and the second is believed at any value**: the first read on a
fresh background tab said 268 fps and was false [M42]. `docs/BROWSER.md`, "The gate".

## Pause, crash, relaunch

**Pause** (`/makarasty:fleet-pause`): stop spawning. The hooks hold your subagents after
`pause_grace_seconds` (30) from the pause. `TaskStop` every agent not back by then, and the clocks you backgrounded
(`budget-elapsed-<id>` ends only on `FINISHED`, a done marker or `NN.done`/`.blocked`/`.retired`, and a pause
writes none, so on resume a fresh clock would run beside the old one and stop a healthy agent). Ack its
slot with `sh "$f" paused "$r" NN`. The hooks hold every subagent of yours while paused, a `[mech]` one too, so
`STATE.md` is yours to write until the resume. On resume, re-spawn per held claim as after a crash.

**Crash** (the chat died, or Claude Code restarted): your subagents died with it; claims and edits survived.
0. Re-take the coordinator seat before any `next`: `sh "$f" chips "$r" <NN-MM> <lane> --agents` again per
   lane, with the ranges `STATE.md` lists (`commands/fleet-resume.md`, step 0).
1. `git status --porcelain -uall`, and attribute each changed path: one in a done task's
   `tasks/claimed/<id>/files` is that task's, one under `$(git rev-parse --show-prefix)<owns path>` of a held
   claim is that claim's (porcelain paths are top-relative, `owns:` is not), and one in
   `dirty-at-start` is the operator's. Never discard a partial edit.
2. Re-spawn one subagent per held claim (`sh "$f" status "$r"` lists them), told that the edits in its
   `owns:` are its predecessor's to continue, with a fresh clock.
3. Re-arm the watch. No messages to send: there are no worker chats.

**Relaunch at the 700 K mark.** Only you cross it; every subagent starts fresh. On `COORDINATOR CONTEXT`:
ask once, and on yes stop spawning, start `fleet.sh relaunch` **naming no chips** (it pauses), `TaskStop`
your agents and their clocks, ack their slots, update `STATE.md` yourself (the pause holds every subagent), and offer the one coordinator chip
(`docs/RELAUNCH.md`, "One chat"). The new coordinator takes over and re-spawns per held claim, as after a
crash.

## Opt-in: separate chats, worktrees

Choose separate worker chats when more than one live visual check must run at once (each chat has its own
live tab [M42]), or when the operator chose them in Round 0. Then `fleet-plan` section 7, "Opt-in: separate
chats", and `fleet-run` apply. Worktrees are opt-in for code tasks: `docs/WORKTREES.md`, with merges by a
Sonnet `[exec]` agent into an integration checkout (`fleet-plan` 8b). See `docs/LANES.md` for the widths.
