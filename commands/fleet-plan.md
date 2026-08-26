---
description: Split a mission into independent briefs and offer one worker chip per brief
argument-hint: <mission> [worker count]
disable-model-invocation: true
---

The reference files named below (`docs/PROTOCOL.md` and its siblings) live in this plugin's own directory,
not in the project you are working on. Resolve that directory once, before following any pointer:

```bash
ls -d ~/.claude/plugins/cache/*/makarasty/*/docs 2>/dev/null | tail -1
```

Empty output means the plugin is running from a checkout instead of an install: look for `docs/` beside
the `commands/` directory holding this file.

Split the mission in `$ARGUMENTS` into briefs, one per worker session, then offer a chip for each and
stop. You write briefs. You do not do the mission.

Read `docs/PROTOCOL.md` for the run layout and brief format,
and `docs/MISSIONS.md` for the mission kinds. Both are short.

## 1. Ground yourself in the project

Read the project's `FLEET.md` if it has one. It carries the app origin, which services must already be
running, the login runbook, the naming rules, and the actions reserved for the operator.

Then read the project's own documentation for the area the mission touches. Start at its index and follow
it to the specific page. Briefs written from memory of a feature invent names, and a brief that names a
screen the project does not call that produces findings nobody can match to anything.

Search with `rg` for text and with `sg` for TypeScript structure when both are available. Send independent
searches in one message, since each round trip costs a full model turn.

## 2. Choose the kind, then the axis

The mission's kind decides how it splits, and the wrong axis is what makes a fleet run worthless. Take the
axis from `MISSIONS.md`: screen ownership for verify, hypothesis for investigate, seam for implement, file
cluster for fix, source for research.

Count the independent slices the axis produces. That count is your worker count, capped by what the
machine and the operator can run. Two workers on one slice cost twice and then agree with each other,
which reads as corroboration and is not.

## 3. Write the briefs

One file per worker at `.fleet/<run-id>/brief-NN.md`, in the format `PROTOCOL.md` gives.

Every brief carries:

- **Exclusive ownership.** `owns` lists what this worker may touch, and the out of scope section names the
  areas the other workers hold, by number.
- **Assertions rather than intentions.** "The Completed tab's count equals the number of rows it lists"
  gives a worker something to be right or wrong about. "Check the tabs work" does not.
- **The evidence contract**, restated in one line: a finding carries a `file:line`, a reproducing
  expression, or three readings with spread and machine load.
- **A model choice per stage.** `model:` walks the work and `verdict-model:` rules on it. Take the tiers
  from `docs/MODELS.md` rather than defaulting.
- **Whole brief demand.** The worker completes its entire brief before writing findings, rather than
  stopping at the first interesting thing.

Briefs that write code carry `isolation: worktree`.

## 4. Guard the actions that leave the machine

When an area can reach something outside the machine, telephony, payments, email or SMS, a shipping or
fulfilment vendor, anything that costs money or contacts a real person, the brief gets a section
naming what the worker observes and what stays with the operator.

Write the observable path first, so attention lands there: read the screens, the lists, the history, the
configuration, the state behind them. Then name the reserved controls specifically, by their label. "Dial,
including click to call from a row" survives contact with a curious model where "avoid placing calls"
does not.

Close it with the escape hatch: a screen that reveals its behaviour only by firing a reserved control is a
limit of this run, recorded as unreached. Without that sentence the boundary reads as a puzzle to route

## 5. Give verify briefs their sweeps

A verify brief that only says "look at these screens" produces a worker that reads the first row of each
and calls it fine. Name the sweeps it must run, from `docs/SWEEPS.md`, and say which screens each applies
to.

The interaction posture belongs in the brief in one line: exercise every control that neither mutates
shared state nor leaves the machine, open dialogs and cancel them, and record every control that produced
no observable change.

Carry the truncation sweep on every screen that lists rows and claims a total, since a list holding a
fraction of its own count while looking complete is invisible to a worker that is only reading. Carry the
zoom sweep wherever layout or geometry decides what the operator sees, and name the zoom levels.

Findings from a sweep report the conditions they were measured under: the zoom, the viewport, and the
claimed total where a count is involved.
around.

## 6. Add measurement rules when speed is in scope

A brief that measures speed carries a "How to measure" section built from
`docs/PERF.md`: three runs with median and spread, machine load
recorded beside every number, a named comparison arm, `setInterval` for sampling.

Schedule those workers in their own wave. They are measuring a machine the other workers are loading.

## 7. Offer the chips

One `spawn_task` per brief, titled exactly `fleet <run-id> NN`. That title is the only reliable address
later: session handles from `ListAgents` are opaque, change between calls, and reach other accounts on the
same machine.

Each chip's prompt is one line:

    Run the brief at .fleet/<run-id>/brief-NN.md by following the makarasty fleet-run command. Invoke it as /makarasty:fleet-run .fleet/<run-id>/brief-NN.md, and if that name does not resolve in this session, read the command file directly: ls ~/.claude/plugins/cache/*/makarasty/*/commands/fleet-run.md

## 8. Hand over

Tell the operator, in this order: the run id, how many chips are waiting, the wave order you recommend and
why, that each worker needing a browser wants its pane opened and kept on screen, and that
`/makarasty:fleet-wait <run-id> <count>` reports the finishes.

## Done when

Every brief exists on disk, every slice of the axis has exactly one owner, every chip is offered, and the
operator has the wave order. Then stop, without opening a browser and without starting the mission.
