---
description: Bring a fleet run back after the machine died - reopen the workers whose context survived, respawn the ones whose did not, and account for what neither covers. Use after a crash, a power cut, or a restart that closed every chat.
argument-hint: <run-id>
allowed-tools: Bash, Read, Write, Glob, Grep, Monitor, TaskStop
---

The run is on disk and the sessions are not. This command turns that into three lists and a wave of clicks.

## Why this is a different command from `sweep`

`sweep` and the revive message both assume the workers are still there. One names a claim nobody is
advancing so the planner can poke the chat holding it; the other is the message that pokes it. Measured
2026-08-27: three workers dead for nearly three hours came back within seconds of a cross-session status
check, and nothing else in the system can do that.

None of it survives the machine going down. A message needs a live receiver, and after a reboot there are
none. Measured 2026-09-01: the 26 worker sessions of two runs were gone from `ListAgents` (which listed
five unrelated chats started minutes earlier) and absent from the app's own session list, archived or not.
A planner asked to bring the run back answered, correctly, that it could not - and the operator was left
choosing between a fresh run and walking the queue by hand.

What survived is enough. `chips/<session-id>` was written at the first claim, so the run knows which
session was which chip. The claims are still standing. And Claude Code keeps each session's transcript
under `~/.claude/projects/<slug>/<session-id>.jsonl`, so a session with a transcript can be reopened with
its context intact. **A reopened worker is worth several fresh ones**: it still holds the files it read,
the refutations it already made, and the half-written finding it was about to file.

## Do this

### 1. Read the run before touching it

Locate the helper once, as every other command does:

```bash
f=$(ls -t ~/.claude/plugins/cache/*/makarasty/*/scripts/fleet.sh | head -1)
```

```bash
sh "$f" recover .fleet/<run-id>
sh "$f" status  .fleet/<run-id>
```

`recover` prints one line per chip:

- **LANDED** - a `.done` or `.blocked` marker and no open claim. Leave it alone.
- **RESUME** - its transcript is on disk. It gets reopened, not replaced, and the line carries the exact
  `claude -r <session-id>` to do it.
- **RESPAWN** - no transcript. Its context is gone; its tasks go back in the queue.
- **UNKNOWN** (only under `--release`) - a claim whose chip never registered a session id. That is not
  evidence of death: registration needs `CLAUDE_CODE_SESSION_ID`, and a claim made without it looks exactly
  like a live worker's. Those belong to `sweep`, which asks the three-term heartbeat question instead.

Then the queue: how many ready tasks nobody holds, and how many released tasks are still waiting to be
re-filed under a new id.

If the host keeps transcripts somewhere other than `~/.claude/projects`, point at it:
`CLAUDE_PROJECTS_DIR=/path sh "$f" recover .fleet/<run-id>`. Without them the RESUME list is empty and
everything else still works - recovery degrades to respawning with fresh context, it does not fail.

### 2. Reopen what can be reopened, first

Hand the operator the `claude -r` lines, one per RESUME chip, and say what each was holding. They run them
in a terminal; a resumed session comes back with its context and its claim, and its next act should be
`fleet.sh beat` to prove it is alive.

Do this **before** releasing anything. A worker that comes back to find its task handed to somebody else
has to be told to stop, and two workers on one task is the failure the claim exists to prevent.

### 3. Release only what cannot come back

```bash
sh "$f" recover .fleet/<run-id> --release
```

This releases the claims of chips whose sessions are gone, and moves their task files to
`tasks/released/`. As everywhere else, **a released task returns under a NEW id** - re-file it, never hand
back the old one, or a late write from the old worker lands on live work.

### 4. Re-file, then re-spawn

Write the released work as new tasks in `tasks/ready/`, then `spawn_task` one chip per worker you want,
titled exactly `fleet <run-id> NN` as in `fleet-plan`. Size the wave off `fleet.sh width`, not off how many
workers died: the survivors usually finished several tasks before the lights went out.

If the run had a `verify` or `pane` lane, say which lane each new chip is for. A pane worker whose pane is
not open stops and asks a person, and a recovery is exactly the moment nobody is watching that chat.

### 5. Re-arm the watch and say what was lost

`/makarasty:fleet-wait <run-id> <count>` again, with the count you now expect - it is the surviving chips
plus the new ones, and it is almost never the number the run started with.

Then report, in one block: which chips were reopened, which were written off, which tasks went back in the
queue under which new ids, and what has no owner at all. **A crashed run that lands quietly is worse than
one that lands short**, because the missing work is invisible from the backlog.

## What this cannot do

- **It cannot reopen a session for you.** `claude -r` runs in the operator's terminal; a fleet has no way
  to type into a chat, which is the same constraint the revive message works around and the reason the
  guard hook exists at all.
- **It cannot tell a crash from a quiet worker**, except through the transcript. That is why an UNKNOWN
  claim is reported rather than released.
- **It does not recover findings that were never written.** Everything a worker held in context and had not
  yet filed died with the session. That is the standing argument for `fleet.sh find` at the moment a
  finding's evidence is complete, rather than a batch at the end of a task.
