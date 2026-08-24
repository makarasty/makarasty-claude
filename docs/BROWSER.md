# Driving a browser from an agent session

Everything here was measured against Claude Code's in-app Browser pane on Windows, 2026-08-24, with three
sessions and one spawned chip.

## The one rule: a hidden pane lies

A Browser pane that is **not displayed on screen** does not composite frames. It still navigates, still
loads pages, and still returns plausible-looking DOM — so a session working through a hidden pane cannot
tell that it is blind. It reports fiction with full confidence. This is the most dangerous failure mode in
agent-driven UI work, because the output looks exactly like real findings.

Symptoms, all of which read as application bugs and are not:

| Symptom | Reality |
|---|---|
| `screenshot` times out after 5s | Pane not displayed |
| `requestAnimationFrame` never fires — a sampling loop returns an empty array | No compositing, so no frames are scheduled. `setInterval` still runs |
| CSS transitions frozen at their start value; enter-classes never clear | `transitionend` never fires |
| Virtualized rows read as empty text | They need layout the hidden pane never runs |
| In-page network requests hang until their timeout | Observed: an axios POST sat to its 180-second timeout while `curl` answered the same endpoint in 4s |

## The gate

One call, before anything else, and again before each batch of visual work:

```js
new Promise(res => { let f = 0; requestAnimationFrame(function t(){ f++; requestAnimationFrame(t); }); setTimeout(() => res(f), 1000); })
```

Roughly 60 or more: live. `0`: blind — stop, ask the operator to display the pane, then **re-measure**.
Never take the answer as proof; they may have opened a different pane, or opened and collapsed it.

Page text length is not a gate. Measured 157 characters on the same page in both the live and the dead
reading — identical. Only the frame count separates them.

## What is true about multiple panes

- One pane per session; several sessions each get their own.
- **Panes composite independently.** Measured: a chip's pane read 301 and 302 frames per second and
  returned real screenshots while its own chat was greyed out and unfocused, with another session's pane
  live at the same time.
- The gate is the **pane being displayed**, not chat focus and not which chat is active.
- Two concurrent live panes are confirmed. Three or more are untested; so is an occluded or collapsed pane.
  Beyond two, run in waves rather than assuming.

## Order of operations

1. `preview_start` — creating the pane and loading the app works fine while blind, and it means the
   operator sees the real app when they display it rather than a blank tab.
2. Gate.
3. Only then log in and navigate. Both can hang for minutes through a blind pane, and the hang reads as a
   broken backend.

## Delegating browser work

A subagent can drive the parent session's pane. Two things to put in its brief:

- The `mcp__Claude_Browser__*` tools are **deferred** for subagents. It must load them first with
  `ToolSearch`, query `select:mcp__Claude_Browser__javascript_tool,mcp__Claude_Browser__computer`.
  Without that line it reports having no browser tools and stops.
- It shares the parent's pane and tab, so browser subagents run **one at a time**, never concurrently.

Screenshots and DOM reads then land in the subagent's context, and only its final message reaches the
parent. Give it a bounded output contract and forbid pasting DOM dumps, accessibility trees or page text —
otherwise the bulk you delegated arrives in the parent anyway.

## Project-specific traps live in the project

Origins, ports, login recipe and app-specific quirks belong in the repo being tested — conventionally
`docs/HOW_TO_LOGIN_AS_AI.md`. This plugin deliberately hardcodes none of them. If that file is missing,
the login command says so and stops rather than guessing at a login form.
