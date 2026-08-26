# Driving a browser from an agent session

Measured against Claude Code's in-app Browser pane on Windows, 2026-08-24, across three sessions and one
spawned worker.

## Blind

A pane that is not displayed on screen stops compositing. It still navigates, still loads pages, still
returns plausible DOM. A session working through it cannot tell, so it reports fiction with full
confidence, and that output is indistinguishable from real findings.

This is the failure this plugin exists to prevent. Treat **blind** as a state to test for, not a risk to
keep in mind.

Symptoms, every one of which reads as an application defect and is not:

| Symptom | Cause |
|---|---|
| screenshot times out after 5s | pane not displayed |
| `requestAnimationFrame` never fires, so a sampling loop returns an empty array | no compositing, so no frames are scheduled. `setInterval` still runs |
| CSS transitions frozen at their start value, enter classes never clearing | `transitionend` never fires |
| virtualized rows read as empty text | they need layout the blind pane never runs |
| in-page requests hang to their timeout | measured: an axios POST sat to its 180 second timeout while `curl` answered the same endpoint in 4 seconds |

## The gate

This is the canonical form. Everything that needs it points here.

```js
new Promise(res => { let f = 0; requestAnimationFrame(function t(){ f++; requestAnimationFrame(t); }); setTimeout(() => res(f), 1000); })
```

Sixty or more means the pane is live. Zero means blind.

Run it before the first visual step, and again before each batch of visual work. A pane collapsed mid run
takes the worker blind silently, and every observation after that point is worthless.

A blind worker asks the operator to display the pane, then **measures again**. The reading is the proof.
An operator can open a different pane, or open one and collapse it, and both answers sound like yes.

Page text length is not a gate. Measured at 157 characters on the same page in both the live and the blind
reading, identical. The frame count is the only separator.

Neither is a successful navigation. `preview_start` returning `navOk: true` with the correct tab title,
measured 2026-08-26 on a pane compositing zero frames, is the same false comfort: the page really did load,
which is exactly why the DOM looks plausible. Title, URL and navigation success all survive blindness. The
frame count does not.

## Evidence a browser tool cannot give you

`read_page` prints an accessible name for buttons and a `href` for links. A link therefore shows no name
in that output whether or not it has one, so an empty name column there is a property of the renderer
rather than a finding about the page. Measured 2026-08-26: a worker nearly filed a WCAG 4.1.2 failure
against thirteen navigation links on that basis, and caught it because a plainly labelled profile link
came back equally nameless.

Accessibility claims come from the DOM or from the browser's own computed accessible name, never from a
tool's summary formatting. The same caution applies to any finding whose only evidence is the shape of a
tool's output.

## Multiple panes

- One pane per session. Several sessions each get their own.
- Panes composite independently. Measured: a worker's pane read 301 and 302 frames per second and returned
  real screenshots while its own chat was greyed out and unfocused, with another session's pane live at the
  same time.
- The gate is the pane being displayed. Chat focus does not enter into it, and neither does which chat is
  active.
- Two concurrent live panes are confirmed. Three or more is untested, and so is an occluded or collapsed
  pane.

## Wave sizing

Start workers that need a visible pane in waves of two or three, and close a wave's panes before opening
the next. Each live pane costs real memory on a machine that is usually already running a dev server, a
watcher and an emulator.

Workers measuring speed get a wave to themselves. They are measuring a machine the other workers are
loading, so numbers taken alongside them describe the fleet rather than the application. See
[`PERF.md`](PERF.md).

## Order of operations

1. `preview_start`. Creating the pane and loading the app both work while blind, and it means the operator
   sees the real application when they display it rather than a blank tab.
2. Gate.
3. Log in and navigate, once the gate reads live. Both can hang for minutes through a blind pane, and the
   hang reads as a broken backend.

## Delegating browser work

A subagent can drive the parent session's pane. Two things belong in its brief:

- The `mcp__Claude_Browser__*` tools are deferred for subagents. It loads them first with `ToolSearch`,
  query `select:mcp__Claude_Browser__javascript_tool,mcp__Claude_Browser__computer`. Without that line it
  reports having no browser tools and stops.
- It shares the parent's pane and tab, so browser subagents run one at a time.

Screenshots and DOM reads then land in the subagent's context, and only its final message reaches the
parent. Give it a bounded output contract, and say that its final message carries findings alone. Left
open, the bulk you delegated arrives in the parent anyway.

## Reading state cheaply

Prefer an expression that returns a small JSON string over a full accessibility tree. A dense list page
produces thousands of tokens of tree, and it stays in context for the rest of the session. A store read or
a targeted `querySelectorAll(...).length` answers the same question in twenty.

Screenshots earn their cost when the question is about pixels. For everything else, the DOM read is both
cheaper and stronger evidence.
