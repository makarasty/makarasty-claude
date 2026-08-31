---
description: Open and authenticate this project's app in this session's browser pane. Use before any visual check, or when a pane shows a login screen or reads empty.
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, mcp__Claude_Browser__preview_start, mcp__Claude_Browser__preview_logs, mcp__Claude_Browser__javascript_tool, mcp__Claude_Browser__navigate
---

The reference files named below (`docs/PROTOCOL.md` and its siblings) live in this plugin's own directory,
not in the project you are working on. Resolve that directory once, before following any pointer:

```bash
ls -dt ~/.claude/plugins/cache/*/makarasty/*/docs 2>/dev/null | head -1
```

Empty output means the plugin is running from a checkout instead of an install: look for `docs/` beside
the `commands/` directory holding this file.

Get this session's Browser pane authenticated against the project's local app. Everything here runs on
localhost against whatever account the project provisioned for agents, so it needs nothing from the
operator except an open pane.

## 1. Find the project's runbook

Probe the session before reading anything. Three workers in the 2026-08-26 run read 58 KB of login runbook
after they had already established they were signed in, which is a whole document of context bought for
nothing. Read `FLEET.md` for the origin and probe; open the runbook only when the probe says signed out.

`FLEET.md` at the repository root carries the login runbook path, the origin, and the services that must
be running. Without it, look for `docs/HOW_TO_LOGIN_AS_AI.md`, then any `*LOGIN*AS*AI*` or
`docs/**/login*.md`.

Nothing found ends this: name what you searched for and say the project has no documented agent login path.
A scripted fill against an undocumented form is the classic hour with nothing to show, because framework
inputs commonly ignore synthetic events and the form then blocks submit in silence.

## 2. Confirm the services are up

Check that the ports the runbook names are listening, using the command for this operating system from
`docs/PROTOCOL.md`. Dev servers, emulators and watchers belong to the
operator, so a missing one is a precise report rather than something to start.

## 3. Open the pane

`preview_start` at the runbook's origin, honouring its literal host. Some projects must be reached as
`[::1]` rather than `localhost`, and getting that wrong lands on an error page whose title still looks
correct.

## 4. Gate the pane

Run the gate from `docs/BROWSER.md`.

Blind: ask the operator to open the Browser pane in this chat with `AskUserQuestion`, then measure again
when they reply. Hold the login until the reading is live, because an in-page login request through a
blind pane can hang to its timeout and then look exactly like a broken backend.

## 5. Probe before signing in

**Probe with an authenticated request, not only a store read.** A pane keeps a persistent profile, so the
client state can read as signed in while the token behind it expired: every later call then returns 401
and every list renders empty, which reads as an application defect rather than a failed session. A
non-empty local identity whose authenticated request fails means signed out.

Panes usually keep a persistent profile across sessions, so this one may already be authenticated. Read
the auth state the runbook names. A non-empty identity ends the command here.

## 6. Sign in, then prove it

Follow the runbook exactly. Then read the auth state again and assert a non-empty identity.

Identity is the assertion. Landing URLs differ per account and per role, and a screenshot costs more while
proving less than the store read.

## Done when

The auth state reads a non-empty identity, read after the sign in rather than assumed from it.

## Report

Two lines: already authenticated or authenticated now, and the identity you read back.
