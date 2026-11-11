# One chat

The default fleet. One coordinator chat runs the queue and spawns one fresh background subagent per task,
in the main checkout, on its current branch. No worker chats, no worktrees: both are opt-in (last section).
Read the Card below once at the start; the sections after it are reference, so read the one a line sends
you to, not the whole file again. It carries no history, only the rule and one clause of
evidence. `${CLAUDE_PLUGIN_ROOT}` is the makarasty plugin's directory.

```bash
f="${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh"
r=<absolute run dir>
```

## Card

The loop, for each free slot `NN` in lane `<lane>`. Dispatch every free slot in one turn.

1. `sh "$f" dispatch "$r" NN <lane>`. It claims, saves `before.diff`, records the before proof of a fix or
   root, sets the budget deadline and writes the spawn prompt. Exit `0`: a claim, go to 2. `3`: `drained`.
   `7`: wait for the next notification or watch line. `6`: wait for the line it prints, any `*-back` (`memory-back` or `disk-back`; `*-stuck` after 60 minutes means tell the operator and wait again). `8`: paused, spawn nothing.
   `9`: run landed, spawn nothing. `1` `PROVE FAILED`: read the line, fix the repro or the
   environment, dispatch again (the claim is kept and resumes). `2`: the slot holds a claim already
   dispatched, or its task file cannot be read (the line says which). `12`: fix the task file (`NO OWNS`,
   `NEED REPRO`), dispatch again. `11` `REFUTED <id>`: write it in `$r/NN.notes.md`, then
   `FLEET_REFUTED=1 sh "$f" finish "$r" NN <id>`.
2. `Agent` with `run_in_background: true`: `subagent_type` and `model` from the `AGENT` line (`-` means the
   pace line's), `effort` from the pace line, `prompt` the `PROMPT` line as printed.
3. On the coder's notification, read its reply only: 3 lines ending in `DONE`, `DONE_WITH_CONCERNS` or
   `BLOCKED`. In that same turn run `sh "$f" coded "$r" NN <id>` (it releases tasks waiting by `after:`) and
   spawn the reviewer with the `REVIEW_PROMPT` line. Pace fastest: one review, no re-review. No code, no review.
4. `budget-elapsed-<id>` from the watch: `TaskStop` that agent, `sh "$f" rearm "$r" NN <id>`, re-spawn once
   on the same claim, with a note that the edits in its `owns:` are its predecessor's to continue.
5. On a pass: write `files`, `sh "$f" finish "$r" NN <id>`, dispatch the slot again (loop step 5 has the lines).

Two rules. Never read `reports/` yourself: a Haiku `[mech]` agent reads one and returns a line. Never block
dispatch on a question: dispatch every free slot first, keep a non-urgent question in `STATE.md`, and ask
them together in one `AskUserQuestion` when no slot can be dispatched. An open `AskUserQuestion` blocks your
turn, so agents finish but nothing new starts; one run waited 94 minutes on one question.

## Before the loop

1. The `pace:` line is in `STATE.md` (`fleet-plan` Round 0). It sets every model, effort and round below,
   and its scale sets the queue's size and whether you warn the operator of a night's run and a coordinator
   relaunch (`docs/MODELS.md`, "Pace").
2. Record what was dirty before the run: `git status --porcelain -uall > "$r/dirty-at-start"`. Those are the
   operator's own uncommitted edits. Nobody stages, reviews as task work, or discards them.
   Every line here runs from the folder that holds `.fleet`, and `owns:` is relative to it. Porcelain prints
   paths relative to the git top instead, so `dirty-at-start` and every `files` list below hold top-relative
   paths. In a project below the git top the two differ by `$(git rev-parse --show-prefix)` (`app/`, say).
3. Write `$r/RULES.md`, the one file whose content every spawn prompt carries once. At least: the project rules the work must
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

1. **Dispatch.** `dispatch` claims as `next` does, with the same exit codes, and prints only the header, never
   the task body. On a claim it does, in the main checkout, what a coder needs before it starts: `before.diff`
   (what the task's paths held before it), the before proof of a `kind: fix` or `kind: root`, the budget
   deadline file `tasks/claimed/<id>/deadline` that the watch reads, and the spawn prompt `prompt.md` (for a
   code task also the reviewer's, `review.md`), both in the claim's directory. On a slot that holds a claim
   not yet dispatched it resumes that claim instead of saying `HOLDING`.

   ```bash
   o=$(sh "$f" dispatch "$r" NN <lane>); rc=$?; printf '%s\n' "$o"; echo "rc=$rc"
   ```

   - `0`: `DISPATCHED <id> kind <kind> lane <lane>`, then `AGENT <subagent_type> model <m|-> verdict-model
     <vm|->`, `PROMPT <line>` and, for a code task, `REVIEW_PROMPT <line>`. Each prompt line is one sentence,
     "Read <abs path> and follow it.", and goes to the `Agent` as it is. (`next` prints `ARM_CLOCK` and
     `DELEGATE` for chat workers; in one chat you never call `next`.)
   - `3` drained: `sh "$f" drained "$r" NN <lane>` writes `NN.done`; that slot is finished. A pane or
     verify slot that never had work is drained the same way, or `landed` waits for it. Its exit `5`
     means the queue is still open: treat it as `7`. Ignore its `GIVE YOUR BROWSER MEMORY BACK` (close
     the heavy tab) and `RENAME THIS SESSION TO` lines: they are for a worker chat, and this chat is yours.
   - `7` waiting: tasks held by `after:`, the verify lane or an uncleared `operator:`. Spawn nothing on this
     slot; dispatch again on the next completion or watch line.
   - `6` machine tight or disk low: background the wait line it prints, dispatch again on its `*-back` (`memory-back` or `disk-back`).
   - `8` paused: spawn nothing (Pause, below). `2 HOLDING`: the slot holds a dispatched claim; finish it first.
   - `9` `RUN FINISHED`: the run has landed. Spawn nothing on any slot; the rest of that line is for a worker
     chat.
   - `12` the task file needs a fix first. `NO OWNS`: a code task (fix, root, implement, design) never goes
     out without `owns:`; add it to the task file, or its edit is missing from the end commit and from
     review. A task with no code and no `owns:` gets an empty `before.diff` from `dispatch`, and later an empty
     `files` (`: > "$r/tasks/claimed/<id>/files"`): git with an empty pathspec reads the whole tree, so never
     run the `git status` / `git diff` lines of step 5 or of the re-review without paths. `NEED REPRO`: a
     `kind: fix` or `kind: root` needs its failing run recorded, because `finish` refuses it without a before and
     an after, and the command is the frontmatter's `repro:`. When that line is empty (`fixqueue` found steps or
     prose, or a root has a member without a command), write one into the task file's `repro:` line: one shell
     command that fails while the defect is there. For a fix, make it from the body's reproduction; a long body
     goes to a Haiku `[mech]` agent that reads it and returns that one line, so the body stays out of your
     context. For a root, rule on it from its members' `repro:` lines and reproductions (the tasks in
     `gates:`); when no one command covers them, give the claim back by "A fix or root that cannot be proven",
     below. A `repro:` uses forward slashes: `prove` runs it in bash, where `node sub\x.mjs` runs `subx.mjs`
     (bash on Windows takes `node sub/x.mjs`). Then dispatch again.
   - `11` `REFUTED <id>`: the before proof passed already, so the finding is refuted. Spawn no coder, write
     that in `$r/NN.notes.md`, and run `FLEET_REFUTED=1 sh "$f" finish "$r" NN <id>` (a `kind: fix` only when its
     `before` passed; a `kind: root` whatever `before` did, once `$r/NN.notes.md` holds a line
     `refuted <id>: <why the shared cause is a coincidence>`).

   A task whose frontmatter has `handback-of: <old id>` (filed by "A fix or root that cannot be proven",
   below) gets neither a new before nor a new `before.diff` from `dispatch`: a new `before` would run over the
   predecessor's partial edits, so it keeps the old claim's `before` proof and copies its list,
   `tasks/claimed/<old id>.released-*/before.diff`.
2. **The budget clock is the watch's.** `dispatch` wrote the deadline, twice the budget. The watch prints
   `budget-elapsed-<id>` once when it passes, and not while the run is paused; it is the only thing that
   catches a hung subagent, since the watch's `STALL` counts no heartbeats, fires on any long task, and is
   information only (in one chat the watch does not even print it). On `budget-elapsed-<id>`: `TaskStop` that
   agent, run `sh "$f" rearm "$r" NN <id>` (a fresh deadline, which the watch announces again), and re-spawn
   once on the same claim, with the `PROMPT` line and a note that the edits in its `owns:` are its
   predecessor's to continue. On the second `budget-elapsed-<id>`, `TaskStop` it. A task with no proof
   to give (no `kind: fix` or `kind: root`) then finishes with the remainder written as unreached in
   `NN.notes.md` (with a `test:` line and no recorded pass, also `untested <id>: <why>` there and
   `FLEET_UNTESTED=1` on `finish`). A fix or root task never does: `finish` refuses it unproven, the claim
   stays held, and everything `after:` it (a root's `gates:` members) and `landed` wait for ever. It goes the
   way of "A fix or root that cannot be proven", below. `ARM_CLOCK` and its `clock` command are for chat
   workers; a coordinator here never backgrounds one.
3. **The spawn is the `AGENT` and `PROMPT` lines**: `Agent`, `run_in_background: true`, `model` from the
   `AGENT` line (`-` means the pace line's; always pass one: an unnamed `model` inherits your tier) and `effort`
   from the pace line. `subagent_type` is on the `AGENT` line, by task kind:

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

   `dispatch` builds `prompt.md` from one template: the task file path, the run and the chip; the content of
   `RULES.md` pasted once (it is short, and a worker that is only pointed at it re-reads it: one run read it 59
   times, a review prompt file 101 times [M51]) and the review or red-team brief when the spawn has one; the
   task's `owns:` and its `test:` line as `timeout <S> <test>` (a hit limit is reported, never retried); for a
   fix or root the `prove ... after` line with the `repro:` word for word; for `kind: implement` or `design`
   with a `test:` line in a run whose `RUN_FORMAT` holds 2 or more, the `Test proof` form of it (a run stamped 1
   has no such gate); the `find` and `beat` commands; the never-list (`next`, `finish`, `drained`, commit,
   `git add -A`, stash, `checkout --`, switch); and the report rule: the full report goes to
   `$r/reports/<id>.md`, and the reply is at most 3 lines and 400 characters ending in `DONE`,
   `DONE_WITH_CONCERNS: <line>` or `BLOCKED: <line>` (a hook sends an over-long reply back once). The task
   file, diffs and logs stay paths. A browser agent also needs its tab: add `Tab: <tabId>` after the `PROMPT`
   line.

   `timeout <S>` is the Bash form (exit 124 = limit hit). `<S>` is about twice the test's normal time in
   seconds, never above 590 (`PROTOCOL.md`, "Wait for the event"), under the 600000 ms both shell tools stop
   at; the Bash tool's own `timeout` parameter is set to 600000, since its default of 120000 ms cuts first.
   In PowerShell `timeout` is timeout.exe, a sleep: use the PowerShell tool's own `timeout` parameter (ms,
   at most 600000). Longer, in either shell: a background run plus `TaskStop` at the limit. macOS without coreutils: `gtimeout`, or background plus `TaskStop`.

4. **On its notification**, read the reply, not `reports/<id>.md`. A `fleet-coder` reply is at most 3 lines
   ending in `DONE`, `DONE_WITH_CONCERNS: <line>` or `BLOCKED: <line>` (`agents/fleet-coder.md`); read that
   line. Other agents' replies have no such line. Concerns go to `NN.notes.md`. On `DONE` or
   `DONE_WITH_CONCERNS`, run `sh "$f" coded "$r" NN <id>` before the review, in the same turn that spawns it:
   it releases the code tasks waiting on this one by `after:` (a `needs: verify` or `needs: pane` task still
   waits for `finish`). On `BLOCKED`:
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
   task's `verdict-model` (the pace line's when it names none), `effort` by the Economy table below, and the
   `REVIEW_PROMPT` line as its prompt. `review.md` points it at `git diff -- <owns paths>` and
   `git status --porcelain -uall -- <owns paths>`, tells it to read every `??` file whole (a new file is in no
   diff; never `git add -N`, the index is shared), and gives it the task file, the claim's `before.diff` (so it
   rules on this task's change only; an empty one means the whole `owns:` diff is this task's) and
   `$r/answers/00-broadcast.md` if it exists. The verdict is short:
   pass, or defects each with the input that breaks it. Rounds by the pace line:
   - Fastest finish: one review, no re-review; blockers become fix tasks; one scoped verify at the end of the run.
   - Balanced: one review, then one fix round (a fresh `fleet-coder` on the same claim with the defects),
     then one re-review.
   - Best quality: fix and re-review until a round finds nothing, bounded by the task's clock; a review that
     found no defects needs no re-review.

   A fix round is that fresh `fleet-coder`. When a cheaper tier did the task and the reviewer rejected it
   (Economy, below), the same spawn goes to Opus: the bump is the fix round, not a second one.

   **Re-review**, after every fix round: an unreviewed fix is where regressions land. Before the fix coder
   starts, save the paths into `tasks/claimed/<id>/pre-fix.diff`
   (`{ git status --porcelain -uall -- <owns paths>; git diff -- <owns paths>; } > "$r/tasks/claimed/<id>/pre-fix.diff"`). Spawn `fleet-reviewer` at
   the model of the first review, with the defect list, the task file, that file as its `before.diff` and the
   same `??` rule. It answers `ADDRESSED` or `NOT ADDRESSED` per defect, then any defect the fix itself
   introduced; nothing else. All `ADDRESSED` and nothing new: go to step 5. Otherwise:
   - A defect with a runnable check becomes a fix task, filed while `tasks/queue-open` is held. Write the
     task file (`task-id: <id>-fix`, `kind: fix`, `owns:`, `repro:` the check, the defect as the body) and
     run `sh "$f" file "$r" <id>-fix < <that file>`. It runs as any fix task, proof and review included.
   - A defect with none (an unrequested hunk, a test that cannot fail) goes to the operator with one
     `AskUserQuestion` naming the task and the defect; the claim stays held. A second reject by the Economy
     rule below goes the same way.
5. Write the task's file list, then finish, no branch (one checkout), then dispatch that slot again:

   ```bash
   git status --porcelain -uall -- <owns paths> > "$r/tasks/claimed/<id>/files"
   sh "$f" finish "$r" NN <id>
   ```

   The claim's directory stays where it is after `finish` (the done marker is the file `tasks/done/<id>`),
   so the lists are on disk for the end commit and a crash. Exit `1` with "done marker NOT written" is a fix
   or root task the gate did not prove, and its `NOT PROVEN` line says why. No `after` recorded, or the
   reproduction still failing after, goes back to a fresh `fleet-coder` on the same claim with that line,
   inside the task's budget; once its `budget-elapsed-<id>` has come and the re-spawn failed too, "A fix or root that cannot be proven" applies.
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
   names the new id. On a slot it prints `RELEASED NN` and retires nothing: dispatch the same slot again.
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

**A pre-commit failure that is not the run's [M59].** The commit agent does not fix, wait or retry: it returns
the failed check names and the files they name, and stops. You apply the `foreign=` word of the `pace:` line
(`fleet-plan`, Round 0b; default `leave`) to each file, reading its last author with `git log -1
--format=%an,%cr -- <file>`: `wait` holds the commit and re-runs the agent when the file changes or its author has committed, for at
most 60 minutes, then it is `leave`; `fix` applies ONLY to a blocking file that `git status --porcelain` shows
clean (foreign code already committed, for example pulled from origin): a file shown dirty is another chat's
uncommitted work and is never edited, whatever the word (leave it and list it); `leave` commits the run's own
files without the failing ones (`--only`) and lists the files left and why in the end report. A file the run
itself changed is a defect of the run: fix it, whatever the word. A `pace:` line with no `foreign=` word
(Round 0b skipped) is `foreign=leave`; the coordinator writes it in explicitly.

**End of run.** After collect, always, in this order: the end commit as written above; then, with opt-in
worktrees, merge the branches back; then, when `FLEET.md` names a task board, move the run's cards to
review; then report the commit sha.

## Economy: the top model decides, everything mechanical goes cheaper

| Step | Maximum economy (default) | Balanced | Spend for speed |
|---|---|---|---|
| Coder | Sonnet, effort `high`, never `max` or `medium`; diagnosis, judgement, design: Opus | Sonnet `high`; Opus on root, design | Opus `high` |
| Reviewer, the verdict | Opus `medium` on every code task; `high` when the diff is over about 400 changed lines or touches security, auth or permissions, money or data deletion [M51] | Opus `high` | Opus `xhigh` |
| Commit, `STATE.md` update, reading a log or a large file | Haiku `[mech]` | Haiku `[mech]` | Haiku `[mech]` |
| Merge (worktrees, opt-in only) | Sonnet `[exec]` | Sonnet `[exec]` | Sonnet `[exec]` |
| Design | top tier, always | top tier | top tier |

The full table and the router that honours `[mech]` and `[exec]`: `docs/MODELS.md`, "Pace" and "The
router". You, the coordinator, keep the plan, the verdicts and the decisions, and nothing else.

A task the reviewer rejects after a cheaper tier did it is re-spawned once on Opus, on the same claim, and you note it in `STATE.md`; that re-spawn is the fix round of step 4, and its
re-review follows. A second reject, or a re-review that still finds a defect with no runnable check, goes to the operator as one `AskUserQuestion` (fleet-plan 8b: file what does not depend on it first).

Why this is cheaper, and the estimate behind it: `docs/MODELS.md`, "Pace".

## Context hygiene

Your context is the run's ceiling: measured about 9 k per spawn on three coordinators before `dispatch` [M54]
(the Agent prompt, the report, and the Bash calls around a claim), so the run's size follows from what each
spawn costs you; a coordinator grew 13.5K to 20.3K per task, two thirds of it Bash calls and results, hand-back
bodies and spawn plumbing [M58]. Keep it low.

- `dispatch` prints the header only. Never print a task body.
- The spawn prompt is the one `PROMPT` line; `RULES.md` (and a review or red-team brief file) is pasted once into `prompt.md` by `dispatch` and marked "do not read it again" [M51].
- Reports are 3 lines in the reply, the rest in `reports/<id>.md`; reviewer verdicts short.
- Never read a diff, a log or a findings file yourself: `fleet.sh status`, the verdicts and `ask/` only.
  Anything larger goes to a Haiku `[mech]` agent that returns a line.

## One checkout

- Every code task carries `owns:`, the files or directories it may touch. Two tasks whose `owns:` overlap
  are ordered with `after:` when you file them; `next` does the rest.
- Every command you or a subagent start that can hang (tests, typecheck, build, a dev server, a wait loop)
  carries a kill-after limit of about twice its normal time; a hit limit is reported, never retried. The
  task clock stops a hung subagent, not necessarily the test run it started; `fleet.sh procs <run>` lists
  orphaned runs (unverified for a subagent's child in one chat), so the limit is what you rely on.
  Bash: `timeout <S> <cmd>` (S in seconds, 590 at most); PowerShell: the tool's `timeout` parameter, never `timeout` the command;
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
`pause_grace_seconds` (30) from the pause. `TaskStop` every agent not back by then. There are no clocks of
yours to stop: the budget clock is the watch's deadline files, which it does not check while paused and moves
out by the pause's length on resume, so a stopped agent costs no budget. Ack its
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
   `owns:` are its predecessor's to continue.
3. Re-arm the watch. No messages to send: there are no worker chats.

**Relaunch at the 700 K mark.** Only you cross it; every subagent starts fresh. `COORDINATOR CONTEXT` starts a drain: spawn nothing and let the agents in flight finish.
At `DRAINED` (nothing in flight, work left) do not ask: run `fleet.sh relaunch` **naming no chips** (it pauses) yourself,
update `STATE.md` (the pause holds every subagent), offer the one coordinator card (`own_initiative`) and notify the
operator once; the click is the consent [M56], and a card not started in 30 minutes gets one more notice. Ask once,
with `AskUserQuestion`, at `DRAIN TIMED OUT` (`drain_cap_min`, 60 minutes [M57]) or when the drain ran out at the next step: those stop agents. On "no" run `fleet.sh undrain <run>`. On yes start `fleet.sh relaunch` **naming no chips**, `TaskStop`
only the agents still running then, ack their slots, update `STATE.md` yourself, and start the one coordinator chip (`mcp__ccd_session__start_session`)
(`docs/RELAUNCH.md`, "One chat"). The new coordinator takes over and re-spawns per held claim, as after a
crash.

## Opt-in: separate chats, worktrees

Choose separate worker chats when more than one live visual check must run at once (each chat has its own
live tab [M42]), or when the operator chose them in Round 0. Then `docs/CHATS.md` and `fleet-run` apply. Worktrees are opt-in for code tasks: `docs/WORKTREES.md`, with merges by a
Sonnet `[exec]` agent into an integration checkout (`fleet-plan` 8b). See `docs/LANES.md` for the widths.
