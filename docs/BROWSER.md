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
- Two concurrent live panes are confirmed under real concurrent work, 2026-08-26: two workers walked
  different screens at the same time, each reading roughly 300 frames per second, neither observing
  anything attributable to the other. Three or more is untested, and so is an occluded or collapsed
  pane.

## Wave sizing

**Five is the comfortable number.** Five sessions tile side by side at a readable width with nothing
stacked below, and that is the shape to plan for by default.

**Ten is the ceiling, and the step from five to ten is a decision rather than a slope.** Past five, panes
stack in a second row at roughly half height: still composited, still usable, noticeably cramped. Once the
operator accepts a second row they should fill it, because six workers pay the whole cost of stacking for
one extra slot. Five, or ten. Sitting between them buys the worst of both.

Zooming the application window out is what buys another readable column, and nobody thinks of it with
eight chats already open. Say it before the first wave rather than after.

**The memory ceiling usually arrives before the pane ceiling.** Measured 2026-08-26 with eight workers on
a 16 core, 31 GB box: 5.0 GB physical free of 31.2, **42 GB committed against 31 GB of physical memory**,
14 node processes, 41 agent processes, 60 percent CPU. The box stayed up and it was paging, so every speed
number taken in that window describes a paging machine rather than the application.

So the check before adding a wave is free physical memory against commit charge, not a count of panes.
Committed above physical means the next worker buys its slot from the pagefile.

Close a wave's panes before opening the next.

Workers measuring speed get a wave to themselves, and at this scale it is not optional. They are measuring
a machine the other workers are loading, so numbers taken alongside them describe the fleet rather than
the application. See [`PERF.md`](PERF.md).

## Screen ergonomics the operator will not discover alone

These are worth saying before the first wave, because every one of them is invisible until someone points
it out and painful to realise afterwards.

**Pull the planning chat into its own window.** Press and hold the chat in the chat list and drag it out.
It becomes a separate window that floats above the tiled workers, so the chat coordinating the run stops
competing for space with the run itself. This is the single change that makes eight workers manageable
rather than merely possible.

**Zooming the application window out buys another readable column.** Nobody thinks of it with eight chats
already open.

**On Windows a window can be made larger than the monitors.** Windows only; macOS has no window manager
equivalent, though a virtual display or a second Space serves the same end, and on Linux it depends on the
compositor. Drag it left until its left edge passes
beyond the screen, then grab the right edge and pull, and the top edge as well. The window keeps growing
past what the desktop can show. Parts of it, whole panes included, can end up entirely off screen while
the compositor keeps rendering them.

That last trick is the one to use carefully, because it points straight at the thing that makes a worker
blind. Do not reason about whether an off screen pane still composites: **let the gate answer.** A worker
whose pane stopped compositing reads zero frames, stops, and asks, so the arrangement checks itself. If
the workers you parked out of sight keep reporting live frame counts, the trick is working for them; if
one goes blind, it just told you so. Either way nobody has to guess, and nobody gets fiction.

## The viewport is not the operator's browser

A worker's pane is a panel inside an application window, so its viewport is smaller than the browser
window the same person would open by hand, and a different shape. Two consequences, both load bearing.

**Every layout finding records the viewport it was measured at**, alongside the zoom. A column that
overflows at 1100 px wide and fits at 1600 is a responsive finding, not a defect report, and the number is
what separates them. Read it rather than assuming:

```js
JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
  zoom: getComputedStyle(document.documentElement).zoom })
```

**A worker can change the size deliberately.** `resize_window` emulates a viewport on its tab: presets
`mobile` (375x812), `tablet` (768x1024), and `desktop`, which clears emulation and returns the tab to the
pane's own size. Custom sizes need both width and height. `colorScheme` emulates `prefers-color-scheme`.

Three things to know before using it:

- The emulated size **persists on that tab** across reloads and navigation until `desktop` clears it. A
  worker that finishes a responsive pass and leaves the tab at 375 px hands every later observation a
  phone layout. Reset it.
- A width below 768 also emulates a mobile **device**: Android user agent, touch points, and mouse events
  translated to touch, so hover states stop existing. That is the right emulation for a phone check and
  the wrong one for "narrow desktop window".
- **Reload after switching**, so anything the application decides at load time about the device runs again.

Responsive work is worth a deliberate pass rather than an accident: check the default, one width narrow
enough to trigger the application's own breakpoints, and one wide enough to prove nothing depends on a
narrow container. Then reset to `desktop`.
## Order of operations

1. `preview_start`. Creating the pane and loading the app both work while blind, and it means the operator
   sees the real application when they display it rather than a blank tab.
2. Gate.
3. Log in and navigate, once the gate reads live. Both can hang for minutes through a blind pane, and the
   hang reads as a broken backend.

## Delegating browser work

A subagent can drive the parent session's pane. Two things belong in its brief:

- The `mcp__Claude_Browser__*` tools are deferred for subagents. It loads them first with `ToolSearch`,
  query `select:mcp__Claude_Browser__browser_batch,mcp__Claude_Browser__javascript_tool,mcp__Claude_Browser__computer`. Without that line it
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

## Spend round trips, not seconds

Every tool call is a model round trip, and round trips dominate the wall clock of a browser walk far more
than the page does. Measured 2026-08-26: two workers, 33 tool calls each, 219 s and 322 s.

Three habits cut that without giving up a single check:

- **Batch with `browser_batch`.** It runs a sequence of pane actions in ONE round trip: navigate, click,
  type, press a key, read. A walk written as batches costs a fraction of the same walk written one call at
  a time. Coordinates inside a batch refer to the screenshot taken before the call, so put a screenshot at
  the end of a batch rather than relying on one mid-sequence.
- **One expression, many answers.** A single `javascript_tool` call can return every value a step needs as
  one small JSON object: row count, claimed total, scroll geometry, zoom, the store flag, the console
  error count. Ten separate probes for ten values is ten round trips buying nothing.
- **Wait on a condition, not on a clock.** Poll the state that means ready, inside one expression, rather
  than sleeping a guessed interval and hoping. A `setInterval` that resolves when a store flag flips ends
  as soon as the app is ready; a fixed sleep is either too short and flaky or too long and wasteful.

What stays expensive on purpose: three runs per performance claim. That rule refused a 4552 ms difference
whose own spread was 5116 ms, which is exactly the confident nonsense the method exists to prevent. Buy
speed from round trips, never from sample size.
