---
description: Sign this session's browser into the project's locally running app, proving the pane is live first
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, mcp__Claude_Browser__preview_start, mcp__Claude_Browser__preview_logs, mcp__Claude_Browser__javascript_tool, mcp__Claude_Browser__navigate
---

Get this session's Browser pane authenticated against the app running locally. Do not ask the operator for
credentials, and do not start, stop or restart anything of theirs.

## 1. Find the project's runbook

Look for `docs/HOW_TO_LOGIN_AS_AI.md`, then any file matching `*LOGIN*AS*AI*` or `docs/**/login*.md`.

If there is none, **stop**. Say what you searched for and that the project has no documented agent login
path. Do not improvise against a login form — a scripted fill commonly fails silently against framework
inputs that ignore synthetic events, and you will spend an hour proving nothing.

## 2. Check what is already serving

Read the ports the runbook names and confirm something is listening:

```
Get-NetTCPConnection -State Listen -LocalPort <ports from the runbook>
```

Dev servers, emulators and watchers belong to the operator. Never start a second one. If something the
runbook requires is not listening, name it precisely and stop.

## 3. Open the pane

`preview_start` at the origin the runbook gives. Honour its literal host — some projects must be reached
as `[::1]` rather than `localhost`, and getting this wrong lands on an error page whose title still looks
correct.

## 4. Prove the pane composites — before touching login

```js
new Promise(res => { let f = 0; requestAnimationFrame(function t(){ f++; requestAnimationFrame(t); }); setTimeout(() => res(f), 1000); })
```

`0` means the pane is not displayed. Call `AskUserQuestion`, ask the operator to open the Browser pane in
this chat, and **re-measure when they reply**. Their answer is not the proof; the frame count is.

Do not attempt login while the reading is `0`. A blind pane can hang the login request until its timeout
and then look exactly like a broken backend. See `${CLAUDE_PLUGIN_ROOT}/docs/BROWSER.md`.

## 5. Probe before signing in

Panes usually keep a persistent profile across sessions, so you may already be authenticated. Read the
auth state the runbook names. Non-empty user id: stop, you are done.

## 6. Sign in, then prove it

Follow the runbook's path exactly. Then re-read the auth state and assert a non-empty user id.

Assert identity, never a landing URL — landing routes differ per account and per role. Never a screenshot;
a store read is stronger and costs a fraction as much.

## Report

Two lines: already signed in or signed in now, and the identity you read back.
