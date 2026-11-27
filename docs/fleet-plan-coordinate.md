# Coordinating a run: the rules a coordinator reads on need

Read from `commands/fleet-plan.md`, section 8b. Each section here is the text of one bullet of 8b, moved out so a call that never reaches it does not load it; 8b names when to read each.

## Back from a crash or a restart
**Back from a crash in one chat, your subagents died with you**: `git status`, attribute partial edits by
`owns:`, re-spawn per held claim, never discard (`docs/ONECHAT.md`, "Pause, crash, relaunch").
With separate chats: **back from a restart, wake the workers before reading `status`.** A restart stops every chat and leaves
the claims on disk looking alive: `docs/CHATS.md`, "After a restart, wake every worker before you re-arm".
An expiry notice is not a restart.

## Watch the machine's memory, and clean up what nobody waits for
**Watch the machine's memory, and clean up what nobody waits for.** The watch prints a `LEFTOVER` line
once per process that `fleet.sh procs <run>` finds: a shell a closed chat left running with everything
under it (wake loops, a `find`, a polling script), or an orphaned test run or typecheck. Run `fleet.sh
procs <run> --kill` on it unasked: the operator's standing word since 2026-10-08. A closed chat's tree that
serves something - a dev server, an `http.server`, anything holding a listening port - comes as `LEFTOVER,
ASK THE OPERATOR`: it may be what they are looking at, so ask, and `--kill` never ends it. Never kill a
process with a live parent.

## Relaunch at the mark, by asking once, not at the wall and not on your own
**Relaunch at the mark, by asking once, not at the wall and not on your own.** The marks are the
operator's, set 2026-10-06: auto-compaction starts a little past 900 K, so you are asked at 700 K, and
again at 800 K, which leaves room to write the state and stop the workers. The watch prints
`COORDINATOR CONTEXT <n>K` when your context crosses `coordinator_handoff_k` in `calibration.json` (700 as
shipped, repeating every `coordinator_handoff_step_k`, 100, so the second line comes at 800), and a
`WORKER CONTEXT NN` line when a worker crosses `worker_relaunch_k` (700); `fleet.sh contexts <run>` lists
every session's size and marks the ones `OVER`. In one chat only you cross the mark, since every subagent
starts fresh. **At the first mark the run drains, it does not relaunch at once**: a relaunch stops every
subagent in flight, and the last four runs lost 2 or 3 agents and 100 to 150 minutes each that way (a
fresh coordinator cannot adopt an agent). The first `COORDINATOR CONTEXT` line says `DRAIN`: `fleet.sh next`
and `dispatch` hand out nothing, so start no new task; let the agents in flight finish and review their
reports. The watch prints `DRAINED: no task in flight, relaunch by card now, no question` once no claim is
open, and work is left: **no agent is stopped, so you do not ask**. Update `STATE.md`, run relaunch call 1 and
2 yourself, offer the coordinator card (`own_initiative`) and notify the operator once (`/makarasty-tools:notify`);
the click on the card is the consent [M56], and a card not started within 30 minutes gets one more notice
(`docs/RELAUNCH.md`, "One chat"). A mark crossed with nothing in flight says so in its first line and does the
same at once. If claims are still open at the next step (800 K),
the line says the drain ran out: ask then, with `AskUserQuestion`, and tell the operator that a relaunch stops those
agents. A `DRAIN TIMED OUT` line (a claim open past `drain_cap_min`, 60 minutes [M57]: a hung or dead agent?) is the same ask, now: both stop agents. On "no", run `fleet.sh undrain <run>` (never `rm` the marker): the drain starts again at the next step. Then relaunch naming no chips
(`docs/RELAUNCH.md`, "One chat"). The operator may also just ask, at any time. Do not hand off by chip and
do not run `/makarasty-tools:handoff`: a chain of handoff chips re-reads the world at every hop and loses
what was only in context, and workers with a large context were never moved at all. One controlled
relaunch replaces the chain. A `WORKER CONTEXT` line for a queue worker is the exception: it names
`fleet.sh retire`, which you run unasked (`fleet-wait`); for a brief worker it points at this same single
ask. **The procedure is in `docs/RELAUNCH.md`: read it when the mark comes**, before
you act: at `DRAINED` one notification, no question; when agents are stopped, one notification and one `AskUserQuestion`; then `fleet.sh relaunch` in two calls, then the chips, then `detach_session` on the fresh coordinator (or `clear_session` "self" when detach is refused): a started session stays linked and wakes you at every turn it ends [M56].

## Never hold a check you cannot run
**Never hold a check you cannot run.** A screen check belongs to a `needs: pane` task. In one chat it
runs against the main checkout's own dev server, after the build task it is `after:`, one browser
subagent at a time on this chat's tab. **Opt-in worktrees:** it is served from the
integration checkout, never to the build worker, whose pane shows the main checkout and not its
worktree. The **integration checkout** is the worktree where you merge finished branches, with its own
dev server on its own port, started once by you (`FLEET.md`'s services line may name how). Make it with
`sh "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh" worktree <absolute run dir> integration --create <integration
branch>`, then `git -C <its path> switch <integration branch>` - a branch the main checkout does not have
checked out - and record its path, branch, URL and start command in `STATE.md`. A pane check whose build
is not merged yet comes back to you as an `ask/` and an unreached line; merge, then re-file it under a new
id. Give every
such task `origin: <that url>`, which the pane worker opens instead of `FLEET.md`'s origin, and add the
url to the watch's `svc` as well. When you must look yourself and your pane reads
blind, ask the operator in that turn (`docs/BROWSER.md`). On `SERVICE DOWN` from the watch, restart the
service or tell the operator in that turn.

## With separate chats: what to say at hand over
With separate chats, three sentences:

- Every pane worker asks for its pane within a minute of its chip being clicked, so open the chips in a
  wave and walk the row once rather than answering them one at a time over half an hour.
- A finished chat renames itself in the sidebar (`... - done 23f`) and its background task panel goes
  empty. That is the glance test, and it works from whatever chat they happen to be sitting in.
- The run ends exactly once, here, with one notification and one summary table in this chat. No
  notification means it has not finished.

With separate chats, say the pane arithmetic out loud, because the operator is about to discover it the hard way. Two numbers,
and do not blur them: **the default of two is what the work has needed** in both measured runs, and the
display ceiling above it is what tiles at a readable width before panes stack below at half height. The
second is a ceiling for a mission that genuinely queues, not a target, and both are in `calibration.json`.
Pass on three ergonomics as well: drag the planning chat out into its own floating window, zoom the
application window out to buy a column, and on Windows a window can be sized past the monitors by pushing
it off one edge and pulling the opposite one. Nobody thinks of any of that with eight chats already open.
