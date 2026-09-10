---
description: What the fleet commands are and which one to reach for
disable-model-invocation: true
---

The `docs/*` files named below live in this plugin's own directory, not in the project you are working on.
Resolve it once, before following any pointer, with
`ls -dt ~/.claude/plugins/cache/*/makarasty/*/docs 2>/dev/null | head -1`. Empty output means a checkout
rather than an install: `docs/` sits beside the `commands/` directory holding this file.

A fleet runs one mission across several Claude Code sessions at once. Each session opens its own browser,
holds its own context, works one brief, and reports by writing a file. Nothing messages anything.

## The commands

| Command | Reach for it when |
|---|---|
| `/makarasty:fleet-init` | A project has never run a fleet: writes FLEET.md, sets up the agent login, sizes the machine. The other commands run it themselves when they find it missing |
| `/makarasty:fleet-plan <mission> [n]` | You have a mission and want it split into briefs with a chip offered per brief |
| `/makarasty:fleet-run <brief>` | You are inside a worker session and want it to execute its brief |
| `/makarasty:fleet-login` | A session needs the project's app open and authenticated |
| `/makarasty:fleet-wait <run-id> [n]` | Workers are running and you want each finish to announce itself |
| `/makarasty:fleet-collect <run-id>` | Workers have finished and you want one ranked backlog |
| `/makarasty:fleet-resume <run-id>` | The machine restarted mid-run: reopen the workers whose context survived, respawn the rest |
| `/makarasty:fleet-design <screens>` | You want the application's screens as artboards on disk, assembled into a Claude Design canvas you can open and edit |
| `/makarasty:fleet-redesign <screens and direction>` | That canvas exists and you want proposals beside the captured screens, states included |
| `/makarasty:fleet-call <who and what about>` | You have a call, a meeting or an interview to hold in a language you do not speak well, about a system you know: the fleet digs the facts, the top model writes the page you read from, and `live <run-id>` answers beside you during the call |

`fleet`, `fleet-plan`, `fleet-design`, `fleet-redesign` and `fleet-call` carry
`disable-model-invocation: true`: they spawn paid work and depend on your clicks, so no agent starts them.
The others are reachable by an agent that needs them, and `fleet-run` has to be: you start a worker by
clicking its chip, and the model in that new session is what invokes `fleet-run` there.

## A run, start to finish

1. `/makarasty:fleet-plan <mission>` in a planning session. It writes briefs and offers one chip each.
2. Click the chips in waves. Open the browser pane in each worker's chat for missions that need one.
3. `/makarasty:fleet-wait <run-id> <count>` reports each finish.
4. `/makarasty:fleet-collect <run-id>` merges everything into `.fleet/<run-id>/backlog.md`.

## Reference

- `docs/WALKTHROUGH.md`: the fifteen-minute first run, for an operator who has never done one.
- `docs/PROTOCOL.md`: run layout, brief format, finding schema, project configuration.
- `docs/MEASUREMENTS.md`: the measurement behind every rule, by id.
- `docs/MISSIONS.md`: the nine mission kinds and how each one splits.
- `docs/DESIGN.md`: the design half - critique with geometry probes, the canvas on disk, redesign beside it, and the loop back to code.
- `docs/CALL.md`: the call half - the facts with their evidence, the page a non-native speaker reads aloud, and the live chat that answers from the same facts.
- `docs/WORKTREES.md`: how a code worker gets its worktree and how a run removes them without reaching the main checkout.
- `docs/GATE.md`: what stands between a finding and a change - the reproduction executed, the shared cause ruled on first, and the contract surface a hook refuses to let an edit drop.
- `docs/SAFETY.md`: the closed list of what a fleet may delete, the path-depth gate, and why a gate beats a prose rule.
- `docs/COMMANDS.md`: how a command in this plugin is written - who may invoke it, what `allowed-tools` really does, and the checklist before adding one.
- `docs/LANES.md`: what a lane is, how wide each one goes, and why the repo lane is not capped by a monitor.
- `docs/BROWSER.md`: the pane gate and why a hidden pane invents findings.
- `docs/BROKER.md`: one or two sessions hold the panes, everyone else files a browser walk as a file.
- `docs/SWEEPS.md`: the interaction posture, and the checks that catch a class of defect rather than one bug.
- `docs/MOCKING.md`: reaching the states real data will not produce, and the line between a scene and a mutation.
- `docs/PULL.md`: the task queue shape, where workers claim work when free and the planner keeps adding it.
- `docs/PORTING.md`: every assumption this makes about its host, and what to replace each one with.
- `docs/PERF.md`: measuring speed on a machine the fleet is loading.
- `docs/MODELS.md`: which model per stage, and the delegation economics behind it.
