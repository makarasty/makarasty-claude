---
description: What the fleet commands are and which one to reach for
disable-model-invocation: true
---

The `docs/*` and `scripts/*` files named below live in this plugin's own directory,
`${CLAUDE_PLUGIN_ROOT}`, not in the project you are working on.

A fleet runs one mission as a queue of tasks. By default one coordinator chat runs it: it claims each task
and spawns one fresh background subagent for it, in the main checkout, and every result is a file on disk
(`docs/ONECHAT.md`). Separate worker chats, each with its own browser and context, and worktrees are
opt-in, chosen in the plan's first question round.

## The commands

| Command | Reach for it when |
|---|---|
| `/makarasty:fleet-init` | A project has never run a fleet: writes FLEET.md, sets up the agent login, sizes the machine. The other commands run it themselves when they find it missing |
| `/makarasty:fleet-plan <mission> [fast]` | You have a mission: four pace questions, a queue, then the run from that chat with one subagent per task (chips per worker only with separate chats) |
| `/makarasty:fleet-run <brief>` | Opt-in separate chats: you are inside a worker session and want it to execute its brief |
| `/makarasty:fleet-login [origin]` | A session needs the project's app open and authenticated, at `FLEET.md`'s origin or the one given |
| `/makarasty:fleet-wait <run-id> [n]` | Workers are running and you want each finish to announce itself |
| `/makarasty:fleet-collect <run-id>` | Workers have finished and you want one ranked backlog |
| `/makarasty:fleet-analyze <run-id>` | You want to know how a run went: speed, tokens, money, what to change |
| `/makarasty:fleet-pause <run-id> [off] [reason]` | You want every worker to really stop (they are refused every tool call except `git` and `fleet.sh`, after a 30 s grace), or want the pause lifted. Also what a coordinator relaunch uses |
| `/makarasty:fleet-resume <run-id>` | The machine restarted mid-run: reopen the workers whose context survived, respawn the rest |
| `/makarasty:fleet-design <screens>` | You want the application's screens as artboards on disk, assembled into a Claude Design canvas you can open and edit |
| `/makarasty:fleet-redesign <screens and direction>` | That canvas exists and you want proposals beside the captured screens, states included |
| `/makarasty:fleet-call <who and what about>` | You have a call, a meeting or an interview to hold in a language you do not speak well, about a system you know: the fleet digs the facts, the top model writes the page you read from, and `live <run-id>` answers beside you during the call |

`fleet`, `fleet-design`, `fleet-redesign` and `fleet-call` carry `disable-model-invocation: true`: they
spawn paid work and depend on your clicks, so no agent starts them. `fleet-pause` does not: it spends nothing,
and a coordinator that is asked to pause has to be able to run it. `fleet-plan` does not, since 1.5.7: a
chat that became a coordinator by handoff, or was told "launch the fleet", could not load it and launched
without its chip rules. Nothing it does costs money until you click a chip. The others are reachable by an
agent that needs them, and `fleet-run` has to be: you start a worker by
clicking its chip, and the model in that new session is what invokes `fleet-run` there.

## A run, start to finish

1. `/makarasty:fleet-plan <mission>` in a planning session. It asks four pace questions in one card, writes
   the queue, registers the subagent slots and starts the loop in that chat. Keep its Browser pane on
   screen when the mission has browser work.
2. `/makarasty:fleet-wait <run-id> <slot count>` watches for what a task notification does not bring:
   the coordinator's own context, a service down, a stall. Only the coordinator can near its context limit
   (700K, asked again at 800K; auto-compaction starts a little past 900K): it asks you once, then offers one
   fresh coordinator chip to click.
3. `/makarasty:fleet-collect <run-id>` commits as the pace chose, merges the findings into
   `.fleet/<run-id>/backlog.md`, and lands the run with `landed <run> <slot count>`.

With separate chats (opt-in): the plan offers one chip per worker, you click them in waves and open each
pane worker's Browser pane, and a relaunch offers a fresh coordinator chip and fresh worker chips together;
click the coordinator first. When only workers are over, you can choose to replace just them.

## Reference

- `docs/ONECHAT.md`: the default loop - slots, one subagent per task, commits, the economy flow, pause, crash and relaunch in one chat.
- `docs/WALKTHROUGH.md`: the fifteen-minute first run, for an operator who has never done one.
- `docs/PROTOCOL.md`: run layout, brief format, finding schema, project configuration.
- `docs/MEASUREMENTS.md`: the measurement behind every rule, by id.
- `docs/MISSIONS.md`: the ten mission kinds and how each one splits.
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
- `docs/PORTING.md`: every assumption this makes about its host, what to replace each one with, the
  commands that differ per operating system, and the shell traps.
- `docs/PERF.md`: measuring speed on a machine the fleet is loading.
- `docs/MODELS.md`: which model per stage, and the delegation economics behind it.
