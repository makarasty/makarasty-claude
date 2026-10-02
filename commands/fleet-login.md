---
description: Open and authenticate this project's app in this session's browser pane. Use before any visual check, when a pane shows a login screen or reads empty, or on "залогинься", "зайди в приложение", "открой localhost", log in as AI.
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, mcp__Claude_Browser__preview_start, mcp__Claude_Browser__preview_logs, mcp__Claude_Browser__javascript_tool, mcp__Claude_Browser__navigate, mcp__Claude_Browser__read_network_requests
---

The `docs/*` and `scripts/*` files named below live in this plugin's own directory,
`${CLAUDE_PLUGIN_ROOT}`, not in the project you are working on.

Get this session's Browser pane authenticated against the project's local app. Everything here runs on
localhost against whatever account the project provisioned for agents, so it needs nothing from the
operator except an open pane.

Credentials come from where the runbook says they live, never from the chat. When the operator pastes a
password into the message anyway, use the runbook's path regardless, and say once that a pasted password
stays in the chat's transcript on disk.

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
`docs/PORTING.md`.

**Which of them you may start is the project's call, not a rule of this command.** A dev server the
operator runs is theirs; a backend or emulator the project hands you a launch entry for is yours, and
reporting it as missing when the runbook told you how to start it is a failed run, not a careful one.
`FLEET.md` says which is which.

Re-check this whenever a login fails later. A service that was up at the start of a run can be down by
the middle of it, and nothing in the app announces that.

## 3. Open the pane

`preview_start` at the runbook's origin, honouring its literal host. Some projects must be reached as
`[::1]` rather than `localhost`, and getting that wrong lands on an error page whose title still looks
correct.

**A second host is a second session.** Where a project serves an admin or operator surface on its own
hostname, that origin authenticates separately, and the pane will not `navigate` across the boundary —
open it with the launch entry the project provides for it. Signed in on one host proves nothing about the
other, so probe the one you are about to use.

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

## When the sign in fails, read the network log before you doubt the credentials

**The message the app shows is not a diagnosis.** A login form has one failure toast and every cause
arrives wearing it: a refused connection to the API, a backend that cannot reach its own datastore, a
second-factor rule that redirected the account to email — all of them render as "invalid credentials".
The call itself is often no better; an app's own login helper commonly rejects with a bare `undefined`,
carrying no status and no message.

So read the request. `read_network_requests` filtered to the login path separates the four cases in one
call — a failed connection, a 4xx, a 5xx, or a 200 whose body chose a path you cannot complete — and each
has a different fix. Retyping the password fixes none of them.

**Never ask the operator to relay a code or a link from their mailbox.** An account that answers with an
emailed step is the wrong account for an agent; say so and name the account the project provisioned.

## Done when

The auth state reads a non-empty identity, read after the sign in rather than assumed from it.

## Report

Two lines: already authenticated or authenticated now, and the identity you read back.
