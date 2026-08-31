---
description: What the fleet commands are and which one to reach for
disable-model-invocation: true
---

The reference files named below (`docs/PROTOCOL.md` and its siblings) live in this plugin's own directory,
not in the project you are working on. Resolve that directory once, before following any pointer:

```bash
ls -dt ~/.claude/plugins/cache/*/makarasty/*/docs 2>/dev/null | head -1
```

Empty output means the plugin is running from a checkout instead of an install: look for `docs/` beside
the `commands/` directory holding this file.

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

`fleet-plan` and `fleet-run` answer only to you. They spawn paid work and depend on your clicks, so no
agent starts them on its own initiative. The other three are reachable by an agent that needs them.

## A run, start to finish

1. `/makarasty:fleet-plan <mission>` in a planning session. It writes briefs and offers one chip each.
2. Click the chips in waves. Open the browser pane in each worker's chat for missions that need one.
3. `/makarasty:fleet-wait <run-id> <count>` reports each finish.
4. `/makarasty:fleet-collect <run-id>` merges everything into `.fleet/<run-id>/backlog.md`.

## Reference

- `docs/PROTOCOL.md`: run layout, brief format, finding schema, project configuration.
- `docs/MISSIONS.md`: the five mission kinds and how each one splits.
- `docs/BROWSER.md`: the pane gate and why a hidden pane invents findings.
- `docs/BROKER.md`: one or two sessions hold the panes, everyone else files a browser walk as a file.
- `docs/SWEEPS.md`: the interaction posture, and the checks that catch a class of defect rather than one bug.
- `docs/MOCKING.md`: reaching the states real data will not produce, and the line between a scene and a mutation.
- `docs/PULL.md`: the task queue shape, where workers claim work when free and the planner keeps adding it.
- `docs/PORTING.md`: every assumption this makes about its host, and what to replace each one with.
- `docs/PERF.md`: measuring speed on a machine the fleet is loading.
- `docs/MODELS.md`: which model per stage, and the delegation economics behind it.
