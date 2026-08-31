# The pane broker: binding the browser to the work instead of to a session

New in 1.0.0, and the one part of this plugin that has not yet been through a real run. Read
`LANES.md` first; this is the pane lane's second shape, not a replacement for the protocol.

## The measurement that forced it

2026-08-31, fourteen workers, 153 minutes. Seven of them were given browser panes. Reconstructed from
their transcripts, every interval in which a pane was actually being driven, overlapping intervals counted
once:

| worker | session life | pane actually driven | share |
|---|---|---|---|
| 01 | 148 min | 47 min | 32% |
| 02 | 150 min | 15 min | 10% |
| 03 | 129 min | 19 min | 15% |
| 06 | 61 min | 0 min | 0% |
| 12 | 85 min | 4 min | 5% |
| 13 | 75 min | 9 min | 12% |
| 14 | 52 min | 10 min | 19% |

Sampled once a minute: **no pane busy for 75 of 153 minutes, one busy for 55, two for 19, three for 4.**
Peak three. Total pane-driven time 104 minutes - **0.68 panes' worth of demand measured against the whole
153 minute run, 0.80 against the 129 minutes in which any pane was driven at all** - spread across seven
open panes, each of which the operator had to open, keep on screen, and answer a question for. Both
denominators are honest and neither reaches one pane; `scripts/fleet-retro.mjs` prints the second.

**Low utilisation is not the finding.** A walk's wall clock is dominated by model round trips, so a pane
driven in bursts is intrinsic and always will be. Three other things are the finding:

1. **The split is decided at plan time, and the planner is measured bad at it, twice.** 2026-08-27: 33 of
   34 tasks written as browser tasks, several of which never needed a pane. 2026-08-31: seven panes opened
   against 0.68 panes of demand, one of them driven for zero minutes over 61.
2. **Session-bound pane width can shrink but never grow.** A repo session cannot grow a pane, so
   undersizing mid-run is unrecoverable except by opening a cold session, and oversizing spends the actual
   scarce thing, which is the operator's screen and attention.
3. **Session binding serialises the thinking behind the lease.** The 2.6 tasks an hour ceiling exists
   because twenty minutes of reading and writing findings queue behind the session holding the pane.

## The shape

One or two **host** sessions own the only panes. Everyone else is `repo` and files a walk when it needs
browser evidence.

```
.fleet/<run-id>/pane/
  requests/  07-1.md          a whole walk, filed by worker 07
  running/   07-1/owner       claimed by a host, atomically, exactly as tasks are
  results/   07-1.json        the answer, with the frame count it was measured under
```

```bash
sh "$f" pane-ask    .fleet/<run-id> 07  <<'EOF'      # requester, does not need a pane
Walk the Completed tab of the cases list and answer: does its count equal the rows it lists?
Steps, the assertion each one settles, and what to return.
EOF
sh "$f" pane-next   .fleet/<run-id> 02               # host claims the oldest walk. exit 3 = none pending
sh "$f" pane-serve  .fleet/<run-id> 02 07-1 <<'EOF'  # host answers, and the gate reading is mandatory
{"gate":301,"conditions":"1440x900, zoom 100","observations":[{"observed":"...","evidence":"..."}]}
EOF
sh "$f" pane-status .fleet/<run-id>                  # backlog depth and the oldest wait, for the planner
```

The requester reads `pane/results/<id>.json` at its next task boundary. It does not block: it claims a
repo task while the walk is being run, which is the idle-window rule from `LANES.md` moved to where it
belongs.

## Why this does not damage the trust in a browser finding

Because the trust never lived in the requesting session. What makes a browser finding trustworthy is the
frame gate, the `conditions` it was measured under, and the evidence contract - all of which live in the
executor. A worker already hands a self-contained brief to a `fleet-scenario` subagent and reads back a
bounded result; the broker is the same brief travelling as a file rather than as a spawn.

The boundary is in fact **stronger** than a subagent's, and `pane-serve` is where that is enforced: a
result without a numeric `gate`, or with a gate under sixty, is refused rather than filed. A parent
session cannot check that about its own subagent today. A requester can now refuse a walk measured blind.

## The request unit is one whole walk, never smaller

Same test as merging tasks in `LANES.md`: if the second question can be answered by an instrument
installed during the first walk, it is one request; if it needs its own navigation, it is two.

Named checkpoints across requests do not exist. The queue cannot promise page state between leases, and a
request that assumes "the state the last walk left behind" is a request that will silently be answered
against a different state. The one legitimate pinned state is a **host property**, not request addressable:
a host logs in once, and two hosts can hold two roles.

## What it gives up

- **Follow-up latency.** A second question pays queue wait plus re-navigation instead of a warm pane. At
  the measured demand that is minutes, not tens, with two hosts.
- **Page state reuse.** Gone by construction. Every walk must end having read everything it will need.
- **Timing purity.** A host interleaves unrelated scenarios, so a performance measurement does not belong
  in the broker: perf keeps one session-bound pane in its own wave, as `PERF.md` already requires.
- **Blast radius.** A blind host stalls the whole pane lane rather than one worker. Against that: there
  are two panes for the operator to keep alive instead of seven, and one asker instead of seven.
- **Peripheral vision.** A requester sees only what it asked. Keep the standing "report anything anomalous
  en route, tagged incidental" line in every walk, and accept that the loss is real.
- **Adoption risk.** The failure mode is a politely deadlocked run: walks filed, no host pane open. The
  planner's watch reports `pane-status` on its stall line for exactly this reason.

## Sizing, from three file stats rather than a guess

`sh "$f" pane-status .fleet/<run-id>` prints all three:

- backlog: how many requests have no result
- oldest wait: the age of the oldest unanswered request
- median lease: claim to result, across `results/` — each served walk carries the time it was claimed, so
  the lease survives the claim directory being removed

**Start with one host. When the oldest unanswered walk has waited longer than one median lease, offer the
operator one more host chip.** Until a first walk has been served there is no lease to compare against, so
`pane-status` falls back to a flat twenty minutes and says so. Cap at what the display holds. Every term is
on disk, which is the whole point: under session binding the planner sizes against a memory of the last
run, and here it sizes against a directory.

The 2026-08-31 run resolves to **two hosts** against the seven panes it opened.

## When not to use it

- A mission that is entirely browser work with no repo half. Then the broker is a queue in front of a
  queue, and session-bound panes are simpler.
- Performance work, per above.
- The first run on a new project, where the login runbook has not been proven yet. Prove it in one
  session-bound worker first; a broken runbook behind a broker fails as a stalled backlog, which is a
  worse way to learn it.

**And do not run both shapes for the same evidence in one run.** A pane host and a session-bound pane
worker walking the same screens will file the same finding twice, and collection will read the pair as two
independent sightings, which is exactly the corroboration this plugin refuses to manufacture.
