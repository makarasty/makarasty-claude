# Relaunch

The procedure `fleet-plan` section 8b points at, read when the watch prints `COORDINATOR CONTEXT` or
`WORKER CONTEXT`, or when the operator asks for a relaunch. `${CLAUDE_PLUGIN_ROOT}` is the makarasty plugin's
directory.

1. `PushNotification` first, one line, so the ask below is seen from another chat (skip it when the
   tool does not exist).
2. Ask **one** `AskUserQuestion`, in the operator's language, with the numbers in it. Say what you
   propose: pause the run; a fresh coordinator; fresh workers for the chips over the mark, named; the
   other workers keep running after the resume. For example: "Coordinator at 720K, worker 03 at 710K;
   auto-compaction starts a little past 900K. Relaunch: pause the run, a fresh coordinator and fresh
   workers 03 and 05, the rest keep running." Options: **"Relaunch now (recommended)"**, **"Only the
   coordinator"**, **"Not now"**. **When only workers are over their mark, add a fourth, "Replace workers
   NN only"** (name them), and recommend that one: the coordinator keeps its seat and context. On "Not
   now" carry on, and ask again only at the next mark.
3. Run `relaunch` **in the background** (`run_in_background`: it waits for acks, minutes at most, and a
   foreground call dies at the shell's two-minute timeout):
   `sh "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh" relaunch <absolute run dir> [--wait N] [--keep-coordinator] [NN ...]`
   `NN` are chip numbers exactly as offered (`03`; a bare `3` or anything else is exit 2), `--wait N` the
   minutes to wait for acks (default 5), and `--keep-coordinator` is "Replace workers NN only". On
   "Relaunch now" name the chips over the mark; on "Only the coordinator" name none. **It runs in two
   calls.** Call 1 pauses the run, waits for every worker holding a claim to stop (naming any that never
   does; say so), and hands back the open claims of the named chips: each dirty worktree is committed on its
   own branch as `wip: handed back` (the files are printed), each claim is re-filed as a ready task
   `<id>-r<n>` carrying `handback-of: <id>`, `continued-from-chip: <NN>` and, for a code task whose worker
   was on `fleet/<NN>/<id>`, `continue-from: <that branch>`, and each chip gets `<NN>.retired` (which ends
   its wake loop; the retired worker is refused every call afterwards, resume or not). Then, when
   `STATE.md` is not newer than the pause, it prints "STATE.md NOT CURRENT: ..." (naming the file and why)
   and **exits 1 on purpose**: that is the expected stop, not a failure. Update `STATE.md` (fleet-plan 8b),
   listing the handed-back ids and what replaced them. Call 2, the same command again, is idempotent, does
   not wait for acks again (`acks: <k> of <n> (not waited again)`) and prints the chips: fresh workers
   numbered after the highest offered, in the same lanes, and one coordinator chip titled
   `fleet <run-id> coordinator`.
4. Do what call 2 prints. `TaskStop` your own watch (two watches share `.watch-seen`, and the old one would
   swallow the events the new coordinator needs), offer **every printed chip in one turn**, then tell the
   operator in one line: click the coordinator chip first, then the worker chips; the run stays paused
   until the new coordinator resumes it. Then stop. Do not resume the run yourself.
**With `--keep-coordinator`** the same two calls print only the fresh worker chips, write no
`coordinator-pending`, and **resume the run themselves at the end**: you carry on as coordinator. Offer the
chips in one turn, then re-arm the watch (`TaskStop` the old one first) with `n` = every chip ever offered,
retired ones included (`ls <run>/offered | wc -l`), since the fresh chips raise the count.
A worker has `pause_grace_seconds` (30), counted from its first call after the pause, to finish its step,
then commits, stops its subagents and background shells and acknowledges; `status` shows a holder as "no
ack yet" and, from 150 seconds after the pause (`pause_still_working_seconds`), as "still working", and
you can message it by title.
The new coordinator's chip prompt tells it to read `STATE.md` in full and sections 3b and 8b of fleet-plan and this file (without
re-running the interview or offering any chip `STATE.md` does not list as pending), run
`fleet.sh resume <abs run> --take-over` (**only `--take-over` takes the coordinator seat**; a plain
`resume`, from the operator's chat for instance, never does), and arm `/makarasty:fleet-wait <run-id> <n>`
with the `n` in the chip prompt, which counts retired chips too, not the workers still active. The workers
you did not replace wake on the resume and carry on with the context they have.
