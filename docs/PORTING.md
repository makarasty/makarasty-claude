# What this plugin assumes about its host

The pattern here outlives any particular tool: several agent sessions working one job, each holding its
own context, each able to see a real running system, coordinating through a substrate none of them owns.

This page names every assumption the plugin makes about
the thing running it, what breaks when that assumption fails, and what to put in its place. Porting to a
different harness is then a checklist rather than a rewrite.

## The eleven assumptions

**1. Several sessions run at once, each with its own context window.**

This is the only assumption with no substitute. Without it there is no fleet, just an agent with a long
task list, and the whole reason for the design goes away: eight contexts hold eight times what one holds,
and none of them poisons the others.

**2. A session can drive a browser that only it controls, and can tell whether that browser is actually
rendering.**

Substitutable. Any driver works, headless included, as long as one question can be answered: is what I am
reading real. Today that answer is a one second frame count. A different driver needs its own equivalent
before anything else is ported, because every other check in this plugin assumes that one already passed.

Headless drivers change the answer rather than remove the question: they always composite, so the frame
count becomes trivially true and the real risks move to page-ready detection and to screenshots that lie
about transitions. See `BROWSER.md`.

**3. Sessions share a filesystem.**

Substitutable, but replace it carefully. Anything with atomic create-if-absent works: a directory, an
object store with a conditional put, a table with a unique key. The claim in `PULL.md` is a directory only
because `mkdir` is the atomic primitive every operating system already has.

Losing shared storage entirely means losing the run's memory. Sessions end, transcripts are not readable
by other sessions in every harness, and a finding that exists only in a chat is a finding that exists only
until that tab closes.

**4. A session can start another session.**

Weakly held today: sessions are offered as a chip and started by a human
click. An automatic spawn would remove the operator from the loop entirely.

If a harness offers real programmatic spawning, the only thing that changes is how tasks are handed out.
The queue, the claims and the reporting stay as they are.

**5. A session can run shell commands.**

Substitutable but expensive to lose. Without a shell, waiting costs model turns, machine load cannot be
sampled, and the atomic claim needs a different primitive. Most of what this plugin does cheaply, it does
cheaply because a shell did it.

**6. A session can delegate to a subagent and choose its model.**

Optional. Losing it makes the run more expensive rather than impossible: the walk happens in the worker's
own context and the bulky reads stay there. The measurement in `MODELS.md` is what to re-take on a new
host, because the whole delegation rule is derived from one ratio.

**7. A session can wait on an external event without spending model turns.**

Optional but load bearing for cost. Without it, waiting becomes polling, and polling is the difference
between a free wait and a wait that costs a model turn every few seconds.

**8. A session can ask the operator a question.**

Needed exactly once per worker, for a pane that was never displayed. Everything else routes through the
planner by file. A harness without an interactive question needs the operator watching for `.waiting`
markers instead.

**9. A session can stop a background task it started.**

Needed, and cheap to substitute badly. Every clock in this design is a backgrounded `sleep` whose exit
re-invokes the session, so a clock that cannot be stopped keeps waking a session that has finished. Without
a stop primitive, the substitute is a clock that checks a marker and exits silently - which still wakes the
session once, so a host without `TaskStop` pays one turn per armed clock and the worker's stale-wake rule
becomes load bearing rather than a safety net.

**10. A hook can fire when a turn ends, and can see which session is ending.**

Optional, and the only thing that catches a worker ending a turn while holding a claim it never began -
invisible to every script here, since the disk looks the same either way. It needs two things from the
host: a `Stop` hook handed JSON carrying `session_id` and `cwd`, and a session id exported into the
worker's shell (`CLAUDE_CODE_SESSION_ID`) so the claim can be stamped with it. Missing either, the guard
silently never fires - which is the confident nothing this plugin exists to hunt, so a port should test it
rather than assume it. It also never fires for a worker isolated in its own worktree, whose working
directory contains no `.fleet/`.

**11. Something about a session is visible from outside it.**

Optional, and it decides whether an operator can see a fleet without opening fourteen chats. Here it is the
sidebar title, which a session can rewrite for itself. A host without one loses the glance test: the fleet
still ends correctly, on disk and in the planner's chat, but the operator has to go and look. A file per
worker under a `state/` directory, rendered by the planner's watch, is the closest substitute.

## Messaging between sessions

Claude Code has direct session to session messaging, and an Agent Teams feature where instances share a
task list and message each other. That is a better transport than files for some of what happens here.

The filesystem stays the contract anyway, for three reasons.

**It is the portable half.** Messaging is the assumption most likely to differ on the next host. Files are
the assumption least likely to.

**A message needs a live receiver; a file does not.** A worker that finished, crashed, or was closed still
left its findings behind. In this design workers are deliberately fire and forget.

**Addressing.** Measured 2026-08-26: session handles are opaque, change between listings, and reach other
accounts on the same machine. A message aimed by handle landed in an unrelated account's release chat. A
file path is an address that means the same thing to everyone.

Treat messaging as an optimisation layered on top: use it to wake a session sooner, never to carry the
only copy of a result.

**And an optimisation that disappears entirely when the machine does.** Measured 2026-09-01 [M27]: after a
restart the 26 worker sessions of two runs were listed nowhere the host could still address - not in the
session list, not among the messageable peers, archived rows included. The files were untouched. So the
recovery path is a disk one: `fleet.sh recover` reads the chip register, the standing claims and the
host's session transcripts, and prints which workers can be reopened.

That last input is host specific, in the same way `fleet-retro.mjs` is. `recover` assumes transcripts live
one JSONL per session under `~/.claude/projects/<slug>/<session-id>.jsonl` and that the host can reopen one
by id (`claude -r <session-id>`). A host with neither loses only the RESUME list: the chip register, the
claims and the release path are plain files and keep working, so recovery degrades to respawning workers
with fresh context rather than failing. `CLAUDE_PROJECTS_DIR` points it somewhere else when a host keeps
them elsewhere.

## Porting checklist

1. Confirm assumption 1. Without it, stop.
2. Write the reality check for the new browser driver, the equivalent of the frame count, and prove it
   fails on a driver you have deliberately broken. A reality check that has never returned false is not
   known to work.
3. Choose the atomic claim primitive and prove it under concurrency, the way `PULL.md` records: many
   claimers, exactly one winner, later attempts refused.
4. Re-measure the delegation ratio in `MODELS.md`. It is a number from one host, not a law.
5. Re-measure the concurrency ceiling **per lane**. On this one the pane lane's ceiling was the operator's
   screen and the repo lane's was the machine, and the two numbers differ enormously in size.
6. Keep the finding schema and the evidence contract unchanged. They are the part with no host dependency
   at all, and they are why a run from a year ago can still be read.

## Cutting a half out

Porting is one reason to know the seams; wanting less of the tool is the other. A project with no
interface to look at should not pay for the browser half, and neither should a reader of these documents.
The slices, measured on this release, with what dangles when each goes:

| Slice | Cut it by | What dangles |
|---|---|---|
| **call** | Deleting `docs/CALL.md`, `commands/fleet-call.md`, `scripts/fleet-call.mjs`, `templates/call-script.html`, and the `call` section of `MISSIONS.md` | Nothing else references them. The cleanest seam in the plugin. |
| **design and canvas** | Deleting `docs/DESIGN.md`, `commands/fleet-design.md`, `commands/fleet-redesign.md`, `scripts/fleet-canvas.mjs`, `scripts/design-probe.js`, `agents/fleet-design-eye.md` | Two edits in core: `fleet-merge.mjs` derives `kind: design` from a finding's `rects` or `probe`, and `fleet.sh find` carries the rectangle geometry gate. Both are conditional and harmless if left. |
| **worktrees** | Deleting `docs/WORKTREES.md` and `docs/SAFETY.md` | 274 of `fleet.sh`'s lines go with them, the path gate included - and that gate is the only thing in this plugin that guards a deletion. Cut the feature and you cut the guard; leave both. |
| **browser and panes** | Not by deleting files | The deepest coupling. The lane split exists for it, `LANES.md` is half a pane document, and the broker is 106 lines of `fleet.sh`. A paneless project already pays almost nothing for it at run time - every pane document is behind a branch pointer - so the cost of keeping it is prose on a shelf rather than turns in a run. |

What is left after all four is the core: the queue, the claim, the finding schema, the merge, the gate,
and the five commands that drive them. That is the part worth porting, and the part a project with no
interface is already using on its own.

## What has no host dependency

The evidence contract. The gate as an idea, separate from its implementation. Splitting by an axis rather
than by convenience. Longest task first. A refuted claim being worth recording. A worker that cannot see
reporting nothing instead of guessing.

Those survive every port, and they are most of what makes the runs worth reading.

## Commands that differ per operating system

Moved from `PROTOCOL.md` with the shell traps below, so the worker contract stays short.

Two things a fleet needs differ per operating system. Everything else here is plain files.

**Is a port listening.**

```bash
# macOS, Linux
lsof -nP -iTCP:5173 -sTCP:LISTEN || ss -ltn 'sport = :5173'
```
```powershell
# Windows
Get-NetTCPConnection -State Listen -LocalPort 5173
```

**Machine load, for a measurement to be interpretable.**

```bash
# Linux
free -m; nproc; uptime
# macOS
vm_stat; sysctl -n hw.ncpu; uptime
```
```powershell
# Windows
$os = Get-CimInstance Win32_OperatingSystem
"free {0:N1}GB of {1:N1}GB" -f ($os.FreePhysicalMemory/1MB), ($os.TotalVisibleMemorySize/1MB)
```

A project's `FLEET.md` may pin the exact command for its own machine, which removes the guess entirely.

Atomic claiming works everywhere: `mkdir` failing on an existing directory is POSIX behaviour and NTFS
behaviour alike, and it is the reason the claim is a directory rather than a file.

## Shell traps that cost this design real time

One eight-worker run produced 47 errors, and the same two shapes hit almost everybody [M12].

**A heredoc that never returns.** Writing a file by piping a heredoc into an interpreter hangs when that
interpreter waits on standard input, and the call sits until it times out. Hit seven workers of eight.
Write files with the harness's own write tool, and keep heredocs for text that goes straight to a file
through `cat > file <<'EOF'`, never into a program that might read stdin.

**The working directory does not persist between calls.** A `cd` in one call is gone by the next, so a
relative path written after it resolves somewhere else. Hit six workers of eight. Use absolute paths, or
put the `cd` and the work in the same call.

**Validating your own JSONL by hand.** Three workers wrote inline scripts to check the file they had just
written. With `jq` present, `jq -e . file.jsonl` does it in one call; without it, append one object per
line and trust the schema rather than writing a validator. Either way it is not worth a script.

The one platform-bound trick is growing a window past the edges of the display, which is
described for Windows in [`BROWSER.md`](BROWSER.md). macOS has no equivalent through the window manager,
though a virtual display via `displayplacer` or a second Space serves the same purpose. On Linux it depends
entirely on the compositor.
