---
description: Pause a fleet run so every worker really stops, or lift the pause. Use on "поставь флит на паузу", "останови флит", "заморозь воркеров", "сними с паузы", "продолжи флит после паузы", "pause the fleet", "stop the workers", "resume the fleet".
argument-hint: <run-id> [off] [reason]
allowed-tools: Bash, Read, Glob, Grep, mcp__ccd_session_mgmt__send_message
---

A pause that is only a sentence to the workers does not stop them: on 2026-10-05 the coordinator said
"pause", and the workers went on "wrapping up" for a long time. This command makes the pause a file the
hooks enforce. While `<run>/PAUSED` exists, a worker's edit, browser action or shell command is refused,
except `fleet.sh`, `git` and a wake loop, so it commits what it has, stops its subagents and background
tasks, acknowledges, and waits.

It is not an instant wall. A worker's grace, `pause_grace_seconds` (30 as shipped, in `calibration.json`),
starts at its first call after the pause, not at the pause: a worker inside one long call still gets it. That
first call is refused once, with a notice that says what to do, how many seconds are left and that the call
did not run (repeat it if it is part of finishing). Calls pass for the rest of the grace. A worker that never
calls again is held anyway from the pause plus four times the grace (120 s); that ceiling is only for a
worker that never calls. A subagent whose parent has not called yet (the normal case: the parent is blocked
inside `Agent`) gets 30 s counted from the pause. After the grace the hard rule applies
until resume: a subagent's own tool calls are refused too, a new subagent (`Agent`, `Task`) is refused from
the first call, and so are `Skill` and `NotebookEdit`; `Monitor` is gated like `Bash`. The browser tools
gated are the Claude Browser pane and Claude in Chrome only; other browser MCPs (Playwright, chrome-devtools,
puppeteer, computer-use) and every other MCP tool are not gated. The shell check is a drift guard for a
cooperative worker, not a sandbox: it is an allow-list of `fleet.sh`, `git` and a wake loop, and it refuses
what could run something else. That is `$(...)`, backticks, a lone `&`, an unquoted `>` (but not `2>&1`,
`>/dev/null`, `2>/dev/null`, `2>$null`), a `(` or `@(` that does not start a segment (PowerShell `(npm t)`),
a quote or backslash inside the first three words of a `git` command (`git "-c" ...`), `git -c`,
`--exec-path`, `--ext-diff`, `rebase -x`, `bisect run`, `submodule foreach`, `filter-branch`, `config`,
`difftool`, `--upload-pack`, `grep -O`, and the variables `PAGER`, `EDITOR`, `VISUAL`, `GIT_EDITOR`, `HOME`
and `XDG_*` set in front of a command.

`$ARGUMENTS` is `<run-id>`, then optionally `off`, then an optional reason. `off` lifts the pause. The run
is `.fleet/<run-id>`, in the main checkout when the cwd is a worktree.

```bash
f="${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh"
r=<absolute path of .fleet/<run-id>>
```

## Pause

```bash
printf '%s\n' "<reason>" | sh "$f" pause "$r" -
```

(`sh "$f" pause "$r" "<reason>"` does the same; with no reason, leave out the last argument. The reason is
read from stdin only when that argument is a lone `-`: piped without it, the reason is silently dropped.) It writes `$r/PAUSED` and a marker under
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/makarasty/paused/` that the hooks read, then prints how many workers
hold claims and the line to watch for. The coordinator itself is never blocked: its own tools keep working.

Then check that they stopped, and report in plain words, in the person's language:

```bash
sh "$f" status "$r" | grep -A12 '^== PAUSED'
```

The line reads `== PAUSED since <time>: <k> of <n> workers holding claims have stopped` and lists the
workers that have not. A holder that has not acknowledged reads "no ack yet"; 150 seconds
after `PAUSED` (`pause_still_working_seconds`) it reads "still working", and the watch says so too. Workers
legitimately sleep 90 to 120 seconds, so an earlier word would send you after the wrong ones. Repeat the
check about every 20 seconds, for at most 3 minutes, until `k` equals `n`. Each worker commits its work in progress on its task branch, stops its
subagents and background tasks, runs `fleet.sh paused <run> <chip>` (which writes `$r/stopped/<chip>`) and
waits. Say how many stopped. For each worker still working after 3 minutes, name it by number and send
one status message to the session titled `fleet <run-id> NN` with `mcp__ccd_session_mgmt__send_message`
("the run is paused: finish the step, commit, run fleet.sh paused, wait"); a worker inside one long tool
call stops at its next one.

While paused, `next` hands out nothing and exits 8, `drained` writes no `.done`, the abort clocks stand
still, and `sweep` reclaims nothing: heartbeats stop during a pause on purpose.

## Resume

```bash
sh "$f" resume "$r"
```

It removes `$r/PAUSED` and the global marker. Each worker's wake loop prints `resumed` and the worker goes
back to the claim it holds (it calls `next` only if it holds none). Say so in one line. If a watch is armed,
it prints `RESUMED` once. A worker a relaunch retired stays held: its first call after the resume is refused
with "you were retired: end this turn with one line, commit nothing, start nothing". A retired chat is not
reused; the hold ends only when the run lands (`FINISHED`, or the run directory is gone).

A plain `resume` never takes the coordinator seat, so lifting a relaunch's pause from this chat does not make
it the coordinator. Only `resume "$r" --take-over`, which ends the new coordinator's chip prompt, does.

This is not `/makarasty:fleet-resume`, which brings a run back after the machine died. Use that one when the
chats are gone.

## When a pause is part of a relaunch

A coordinator relaunch (`fleet.sh relaunch`, `fleet-plan` section 8b) pauses the run itself. It resumes it
only with `--keep-coordinator`; otherwise the new coordinator does, with `--take-over`. Run this command for
a plain pause the operator asked for, and for lifting the pause a relaunch left when nobody else has.
