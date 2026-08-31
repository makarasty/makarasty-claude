# What this plugin assumes about its host

The pattern here outlives any particular tool: several agent sessions working one job, each holding its
own context, each able to see a real running system, coordinating through a substrate none of them owns.

The tool changes. The pattern should not have to. This page names every assumption the plugin makes about
the thing running it, what breaks when that assumption fails, and what to put in its place. Porting to a
different harness is then a checklist rather than a rewrite.

## The ten assumptions

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

Weakly held today, and worth knowing it is weak: sessions are offered as a chip and started by a human
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

**10. Something about a session is visible from outside it.**

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

## Porting checklist

1. Confirm assumption 1. Without it, stop.
2. Write the reality check for the new browser driver, the equivalent of the frame count, and prove it
   fails on a driver you have deliberately broken. A reality check that has never returned false is not
   known to work.
3. Choose the atomic claim primitive and prove it under concurrency, the way `PULL.md` records: many
   claimers, exactly one winner, later attempts refused.
4. Re-measure the delegation ratio in `MODELS.md`. It is a number from one host, not a law.
5. Re-measure the concurrency ceiling **per lane**. On this one the pane lane's ceiling was the operator's
   screen and the repo lane's was the machine, and the two numbers are years apart in size.
6. Keep the finding schema and the evidence contract unchanged. They are the part with no host dependency
   at all, and they are why a run from a year ago can still be read.

## What has no host dependency

The evidence contract. The gate as an idea, separate from its implementation. Splitting by an axis rather
than by convenience. Longest task first. A refuted claim being worth recording. A worker that cannot see
reporting nothing instead of guessing.

Those survive every port, and they are most of what makes the runs worth reading.
