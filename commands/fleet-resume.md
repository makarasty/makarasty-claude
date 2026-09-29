---
description: Bring a fleet run back after the machine died - reopen the workers whose context survived, respawn the ones whose did not, and account for what neither covers. Use after a crash, a power cut, or a restart that closed every chat.
argument-hint: <run-id>
allowed-tools: Bash, Read, Write, Glob, Grep, Monitor, TaskStop
---

The run is on disk and the sessions are not. This command turns that into three lists and a wave of clicks.

`sweep` and the revive message both assume the workers are still there, and after a restart none of them
are: a message needs a live receiver, and `mcp__ccd_session_mgmt__list_sessions` no longer lists them [M27]. What survives is
`chips/<session-id>`, written at the first claim, the standing claims, and each session's transcript under
`~/.claude/projects/<slug>/<session-id>.jsonl` — enough to reopen a worker with its context intact. **A
reopened worker is worth several fresh ones**: it still holds the files it read, the refutations it already
made, and the half-written finding it was about to file.

## Do this

### 1. Read the run before touching it

Locate the helper once, as every other command does:

```bash
f="${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh"
```

```bash
sh "$f" recover .fleet/<run-id>
sh "$f" status  .fleet/<run-id>
```

`recover` prints one line per chip:

- **LANDED** - a `.done` or `.blocked` marker and no open claim. Leave it alone.
- **RESUME** - its transcript stopped being written, so the session is gone and its context is not. The
  line carries the whole command: the directory that session was started in (a worktree worker's is not
  the planner's), the `claude -r <session-id>`, and a first instruction telling it to write its heartbeat
  before it continues. **Hand that line over as printed.** A session reopened with no prompt sits there
  until somebody types into it, and twenty-six of those is a recovery that recovered nothing.
- **LIVE?** - a transcript written to within the last few minutes. It may still be running, and reopening
  a live session puts a second writer on its file. No command is printed for it: message it with
  `mcp__ccd_session_mgmt__send_message`, or wait.
- **RESPAWN** - no transcript. Its context is gone; its tasks go back in the queue.
- **UNKNOWN** (only under `--release`) - a claim whose chip never registered a session id. That is not
  evidence of death: registration needs `CLAUDE_CODE_SESSION_ID`, and a claim made without it looks exactly
  like a live worker's. Those belong to `sweep`, which asks the three-term heartbeat question instead.

LANDED lines carry their session id too. A worker that finished is the one whose context a follow-up run
wants most - it read the code that produced the findings - so "leave it alone" is advice about this run,
not about the next one.

Then the queue: how many ready tasks nobody holds, and how many released tasks are still waiting to be
re-filed under a new id.

`recover` reads the host's own `CLAUDE_CONFIG_DIR` when it is set, and `CLAUDE_PROJECTS_DIR` overrides
both. If it finds no transcripts at all it says so, because that absence is its own blindness rather than
a fact about the workers - and it **refuses `--release` outright** in that state, since releasing on no
evidence would free the claims of workers that are alive. `fleet.sh sweep --release` is the instrument for
a machine with no transcripts: it asks the heartbeat question instead.

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

Write the released work as new tasks in `tasks/ready/`, then `mcp__ccd_session__spawn_task` one chip per worker you want,
titled exactly `fleet <run-id> NN` as in `fleet-plan`. Size the wave off `fleet.sh width`, not off how many
workers died: the survivors usually finished several tasks before the lights went out.

If the run had a `verify` or `pane` lane, say which lane each new chip is for. A pane worker whose pane is
not open stops and asks a person, and a recovery is exactly the moment nobody is watching that chat.

### 4b. Only then, sweep the worktrees of the workers that are not coming back

```bash
sh "$f" clean .fleet/<run-id>              # dry run first, always
sh "$f" clean .fleet/<run-id> --remove
```

**After the reopening, never before it.** A reopened worker returns to its own worktree, and a clean that
ran first would have pulled the floor out from under it. `clean` keeps any tree holding uncommitted or
unmerged-and-unpushed work, which after a crash is exactly the tree worth keeping - a dead worker's
half-finished slice is recoverable from its branch, and a report saying which trees were kept is more
useful here than a tidy disk.

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
