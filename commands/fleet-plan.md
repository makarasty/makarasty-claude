---
description: Split a mission into independent briefs and offer one worker chip per brief
argument-hint: <mission> [worker count]
disable-model-invocation: true
---

The reference files named below (`docs/PROTOCOL.md` and its siblings) live in this plugin's own directory,
not in the project you are working on. Resolve that directory once, before following any pointer:

```bash
ls -dt ~/.claude/plugins/cache/*/makarasty/*/docs 2>/dev/null | head -1
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

Count the independent slices the axis produces. That is your worker count, capped hard at ten and
practically at three to five per wave. Ten is where browser panes stop fitting a single display; the
memory ceiling usually arrives first. Cap it by what the$
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
zoom and viewport sweep wherever layout or geometry decides what the operator sees. Name the zoom levels
and the widths, and say that the worker resets the tab to `desktop` before finishing: an emulated size
persists across reloads and quietly reshapes everything measured afterwards.

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

    Run the brief at .fleet/<run-id>/brief-NN.md by following the makarasty fleet-run command. Invoke it as /makarasty:fleet-run .fleet/<run-id>/brief-NN.md, and if that name does not resolve in this session, read the command file directly: ls -t ~/.claude/plugins/cache/*/makarasty/*/commands/fleet-run.md | head -1

## 8. Arm the watch, then hand over

**Invoke `/makarasty:fleet-wait <run-id> <count>` yourself, before you stop.** Do not print it as a command
for the operator to run. Measured 2026-08-26: a planner that printed the line and stopped left seven
finished workers sitting on disk unnoticed, because the operator assumed the planner was watching and the
planner assumed the operator would run it. The watch waits in the shell, so arming it early costs nothing
and it fires whether the chips are clicked in one minute or twenty.

Then tell the operator, in this order: the run id, how many chips are waiting, the wave order you
recommend and why, and that each worker needing a browser wants its pane opened and kept on screen.

Say the pane arithmetic out loud, because the operator is about to discover it the hard way: five sessions
tile side by side at a readable width, further ones stack below at half height, and ten is where panes
stop being usable. Five or ten, never six. Pass on the three ergonomics from `docs/BROWSER.md` as well:
drag the planning chat out into its own floating window, zoom the application window out to buy a column,
and on Windows a window can be sized past the monitors by pushing it off one edge and pulling the opposite
one. Nobody thinks of any of that with eight chats already open.

Before each wave after the first, have them check free physical memory against the commit charge.
Committed above physical means the next worker is paged from disk, and every speed number still in flight
is measuring a paging machine rather than the application.

## Done when

Every brief exists on disk, every slice of the axis has exactly one owner, every chip is offered, **the
watch is armed**, and the operator has the wave order. Then stop, without opening a browser and without
starting the mission.
