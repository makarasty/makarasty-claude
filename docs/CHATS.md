# Separate chats (opt-in)

Read this only when the run uses separate worker chats: Round 0 chose "Separate chats for browser workers, one
commit at the end", or more than one live visual check must run at once (one chat has one live tab [M42]). The
default run is one chat with one subagent per task (`docs/ONECHAT.md`) and needs none of it. Moved here from
`commands/fleet-plan.md` (section 7) and `commands/fleet-wait.md`; no rule changed.

## Start the chips

(`fleet-plan`, section 7.)

When Round 0 chose "Separate chats for browser workers, one commit at the end", or more than one live visual check must run at once
(one chat has one live tab [M42]), start chips for those workers.
One `mcp__ccd_session__start_session` per worker, title, background and prompt taken verbatim from the `CHIP NN` blocks of:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh" chips .fleet/<run-id> 01-02 pane --model <id> --effort <level>   # lane: pane, repo or verify; a brief worker has neither lane nor --model
sh "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh" chips .fleet/<run-id> 03-08 repo --model <id> --effort <level>
```

Do not type them yourself, and run it once per lane the queue holds, in the same turn, **with disjoint
number ranges per lane**, as above: `chips` refuses an empty, reversed or non-numeric range, and refuses a
number already offered under a different lane, because two chips with one number are two workers with one
identity. It ends with `STILL WITHOUT A WORKER` for every lane that has ready work and no chip yet. Start each
chip with `context: "fresh"` and `use_worktree: false`; `initiation` is `"user_asked"` only when the operator's own
message began this turn, otherwise (a watch line, an AskUserQuestion answer in a watch-started turn)
`"own_initiative"` (a card the operator starts with a click; the app refuses a start on a turn a watch event or
another session's message started) and you PushNotification the operator to start the cards. Keep the title `fleet <run-id> NN`: `fleet.sh` and the watch match on it. It is no
longer the only address: `mcp__ccd_session_mgmt__list_sessions {linked:true}` returns each session this chat started, with its
`name` and `startedBy`, and `SendMessage` takes that name; `{linked:true}` is only this chat's own. A fleet chat this chat did not start (after a relaunch) is found by a title
match on the unfiltered list, `limit` raised until its oldest row predates the run; the list changes between calls
and reaches other accounts on the same machine, so match `fleet <run-id> NN` exactly. The prompt carries the run's absolute path, because a chip session can start
in its own worktree where the gitignored `.fleet/` does not exist, and the path of the `fleet-run` that is
actually installed. Start chips for every worker the run needs now, never paste lines in their place.

In pull mode the prompt carries the worker's identity **and its lane**. Without the identity a worker
invents one, two workers pick the same number, and their findings interleave into one file that collection
reads as a single worker. Without the lane a paneless worker claims a browser task and pays a reclaim. Give
`pane` for the workers whose panes the operator will open and `repo` for the rest; the lane is then the third
argument to every claim the worker makes. Do not write the lane rule into the prompt as prose - 2026-08-31
did, in nine of fourteen prompts, and a rule retyped per run is one somebody eventually types differently.

The chip number is the worker id everywhere after that: `NN.jsonl`, `NN.notes.md`, `NN.done`, the `owner`
line inside a claim, and `ask/NN-1.md`.

## Worker lines

(`fleet-wait`, the lines the watch prints about a worker chat.)

**A `WORKER MODEL NN` line means worker NN stopped itself at `whoami` and waits for you.** Make the calls
it names in that turn: `docs/MODELS.md`, "Switching a worker", steps 4 and 5. `WORKER MODEL NN DID NOT TAKE`
is step 5's failed switch.

**A `WORKER PLUGIN NN` line means worker NN last claimed on an older makarasty than the one installed.** A
worker keeps the `fleet.sh` path it resolved at its start, so a restart alone does not move it. Ask the
operator once to restart Claude Code, then message the worker as the line says and `touch` the mark it
names: invoking `fleet-run` again resolves the installed plugin, and its next claim records the new version. `WORKER PLUGIN NN STILL ON` is a
worker that claimed and kept the old one: it goes into the one relaunch ask ("Replace workers NN only": `commands/fleet-wait.md`, `COORDINATOR CONTEXT`, and `docs/RELAUNCH.md`),
with the fresh chips offered by you. A saved watch pinned to the old plugin's path is re-armed from `commands/fleet-wait.md`
after the restart.

**A `WORKER CONTEXT NN` line means worker NN crossed `worker_relaunch_k` in `calibration.json`; it prints once per mark and
per session, from the worker's transcript. A queue worker's line is yours to act on at once and unasked**: run the `fleet.sh retire` it names and do what it prints
(offer the replacement chip, PushNotification the operator to start it). The worker finishes the task it
holds and leaves at its next claim with its tree committed; the run does not pause and the watch counts the
new chip by itself. `REPLACEMENT NN ... has not started` means the card titled `fleet <run> NN` was not
started: it is an app card the operator must start (a session started from a watch-triggered turn shows a
card, the app's `mcp__ccd_session__start_session` with initiation `own_initiative`; `user_asked` is only for
a turn the operator's own message began), so `PushNotification` them again.
For any `ask/` question named after `unanswered:` in `<NN>.retired`, answer it under its own id, the text after
`ask/` without `.md` (`fleet.sh answer <run> <NN>-<n>`), and add the answer to the re-filed task's file in
`tasks/ready/`, which is what the replacement reads. If nothing was re-filed (a worker that `next` retired
held no claim), put the answer in a broadcast naming the replacement chip's lane, or in the next task you file
for it. `answer` refuses an id that names no question, so never answer under the replacement's number.
A `pane/requests/<NN>-<n>.md` entry there is a walk the old worker asked for: a host serves it, not you,
but its result lands in `pane/results/<NN>-<n>.json`, which only the old worker was told to read, so name
that path in the re-filed task or the broadcast.

## After a restart, wake every worker before you re-arm

(`fleet-wait`. In one chat there are no workers to wake: `docs/ONECHAT.md`, "Pause, crash, relaunch".)

A Claude Code restart ends the turn of every session on the machine: your watch, and every worker's loop
with it. Claim files and heartbeats survive it, so `status` reads like a working run while nothing works
[M35].

**An expiry notice is not a restart: on one, re-arm and nothing else.** A restart is a turn that did not
start from the watch - the app's own "The app was quit while you were working. Please continue from where
you left off.", the operator writing "продолжи" or "continue", or saying the machine restarted - while
your watch task is missing from your task list and never printed `run complete` or `run landed`. On that,
run `/makarasty:fleet-resume <run-id>` before you read `status`: its step 0 wakes every worker the app still
lists, and its step 5 re-arms this watch. Done when it has reported which workers were woken, reopened and
written off, and you have told the operator that pane workers want their panes on screen again.

