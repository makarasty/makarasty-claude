# Driving a browser from an agent session

Measured against Claude Code's in-app Browser pane on Windows, across three sessions and one spawned
worker [M01].

## Blind

A pane stops compositing when its tab is not the selected tab of its window, or when that window is
minimised. It still navigates, still loads pages, still returns plausible DOM, and it still returns
screenshots. A session working through it cannot tell, so it reports fiction with full confidence, and
that output is indistinguishable from real findings.

**Being on screen has nothing to do with it** [M33]. A pane fully covered by another window composites at
300 frames a second. So does one on a second monitor with a corner showing, and so does one pushed
entirely past the edge of the desktop. Two things stop a pane, and only two: another tab being selected in
its window, and that window being minimised.

This is the failure this plugin exists to prevent, and it is not only a tester's problem. Measured
2026-08-26: a fix worker hit it while trying to measure whether its own repair had worked, and correctly
refused to change code for a metric it could not read, reporting the two items as decisions rather than
as tasks. **Blind** is a state to test for, not a risk to keep in mind.

Symptoms, every one of which reads as an application defect and is not:

| Symptom | Cause |
|---|---|
| a screenshot arrives, fresh and correct-looking | the capture forces a paint; the page behind it is still not running, so what you have is a photograph of a stopped clock |
| `requestAnimationFrame` never fires, so a sampling loop returns an empty array | no compositing, so no frames are scheduled. `setInterval` still runs |
| CSS transitions frozen at their start value, enter classes never clearing | `transitionend` never fires |
| virtualized rows read as empty text | they need layout the blind pane never runs |
| in-page requests hang to their timeout | measured: an axios POST sat to its 180 second timeout while `curl` answered the same endpoint in 4 seconds |

Three signals look like they could replace the gate and cannot. `innerWidth` held its real value through
142 consecutive seconds of zero frames. `document.visibilityState` answered `visible` on a pane
delivering nothing, immediately after a screenshot was taken of it. And `tabs_context` reported
**`The Browser pane is currently displayed`** while the page inside it drew zero frames at a width of
949 px [M33]. The host's own flag tells you whether the pane has a place in the layout, which is a
different question. Only the frame count answers the one you are asking.

## The gate

This is the canonical form. Everything that needs it points here, with one deliberate copy: `fleet-run`
inlines the expression at the top of its file, because a pane worker runs the gate before it has read
anything else, and a pointer there would cost the turn the gate exists to save. Change both together.

```js
new Promise(res => { let f = 0; requestAnimationFrame(function t(){ f++; requestAnimationFrame(t); }); setTimeout(() => res(f), 1000); })
```

Ten or more means the pane is live; under ten means blind (a pane that is not drawing reads zero, with
stray seconds of 2 to 4 out of a minimised window). **From ten to fifty-nine the pane is live on a loaded
machine** [M38]: 28 to 37 frames was read on a selected pane while the box ran tests beside the fleet.
Carry on and put the number in the report. Never ask the operator to focus the chat, use split view or
move the window over it: none of that changes the reading, and the question costs them a turn. What a
loaded machine does spoil is timing: a duration or smoothness figure taken then measures the machine,
and says so beside it. A reading between one and fifty-nine can also be the one second a tab spends
arriving or leaving, so read again a second later and believe the second reading.

Run it before the first visual step, and again before each batch of visual work. A pane collapsed mid run
takes the worker blind silently, and every observation after that point is worthless.

**A single zero is not an answer; measure twice with a second between.** The first second after a tab
becomes the selected one delivers **zero frames**, measured at both transitions in the same run [M33]. A
gate fired the instant an operator says they have opened the pane therefore reads blind, and sends the
worker back to ask for a pane that is already open - which is the shape that cost six pane workers between
1 and 34 minutes each [M20]. Read zero, wait a second, read again, and believe the second one.

A blind worker asks the operator to display the pane, then **measures again**. This holds for every
session that reads a pane, the coordinator included, and the ask goes out in the same turn - with
`AskUserQuestion`. The push notification is the coordinator's: it adds `PushNotification` where the session has
it, since the operator is usually looking at another chat. A worker's route is its `.waiting` marker plus
`AskUserQuestion` (`fleet-run`, "Gate the pane before trusting it"), and the coordinator's watch reports that
marker as `NEEDS OPERATOR` in the chat the operator is reading. Recording the visual check as a debt "for when the pane is open" is not an ask: nobody is
told, nothing wakes anyone, and the check never happens. Measured 2026-10-05: a coordinator's pane read
0 fps, it wrote three screens into a backlog and went quiet, and the operator found out by scrolling. All eight panes of the
first eight-worker run opened blind, and the gate is what kept them from filing findings off a pane that
was not drawing [M02]. The reading is the proof. An operator can open a different pane, or open one and
collapse it, and both answers sound like yes.

Page text length is not a gate. It measured 157 characters on the same page in both the live and the blind
reading. The frame count is the only separator.

A successful navigation is not a gate either. `preview_start` returned `navOk: true` with the correct tab
title on a pane compositing zero frames, measured 2026-08-26. The page really did load, which is why the
DOM looks plausible. Title, URL and navigation success all survive blindness. The frame count does not.

## Evidence a browser tool cannot give you

`read_page` prints an accessible name for buttons and a `href` for links. A link therefore shows no name
in that output whether or not it has one, so an empty name column there is a property of the renderer
rather than a finding about the page. Measured 2026-08-26: a worker nearly filed a WCAG 4.1.2 failure
against thirteen navigation links on that basis, and caught it because a plainly labelled profile link
came back equally nameless.

Accessibility claims come from the DOM or from the browser's own computed accessible name, never from a
tool's summary formatting. The same goes for any finding whose only evidence is the shape of a tool's
output.

## Multiple panes

- One pane per session. Several sessions each get their own.
- Panes composite independently. Measured: a worker's pane read 301 and 302 frames per second and returned
  real screenshots while its own chat was greyed out and unfocused, with another session's pane live at the
  same time.
- The gate is the tab being selected in a window that is not minimised. Chat focus does not enter into it,
  neither does which chat is active, and neither does whether any of it is visible.
- Two concurrent live panes are confirmed under real concurrent work, 2026-08-26: two workers walked
  different screens at the same time, each reading roughly 300 frames per second, neither observing
  anything attributable to the other.
- Occluded, half off a second monitor, and wholly off screen were untested until 2026-09-10 and are now
  measured: all three composite at full rate [M33]. Collapsed and minimised are the two that do not.
- So the number of live panes a fleet can hold is the number of windows the operator is willing to keep
  un-minimised, and those windows can be anywhere, including nowhere the operator can see.

## Wave sizing

**Everything in this section sizes the pane lane and nothing else.** A worker that never opens a pane is
not competing for a display, and capping the file half of a fleet at the width of a monitor is how a run
ends up with eight browser workers queued behind each other and nobody reading the source tree. The repo
lane's width comes from the machine, in `LANES.md`.

**The ceiling is memory, not monitors** [M33, M34]: a pane off the edge of the desktop composites exactly
as well as one in the middle of it. A pane costs one renderer process per tab - about 113 MB of it, plus
whatever the page weighs. One tab holding 150,000 DOM nodes read **2,061 MB** [M34]. Size the lane by
dividing free memory, less the operator's reserve, by the weight of this project's own page. Measure it
rather than guessing: `node scripts/fleet-load.mjs` prints the largest renderer on the machine, so one
reading with the application open and one without gives you the figure. No command takes it for you, and
no file stores it yet - so today the floor in `calibration.json` and the refusal in `fleet.sh next` are
what hold the line.

**Two is usually what is needed, whatever the ceiling allows.** Seven open panes carried 104 minutes of
actual browser driving across a 153 minute run, no pane busy for 38 percent of it, peak three [M15].
Opening a pane costs the operator a question, a piece of screen and the obligation to keep it displayed,
and it buys nothing while nobody is driving it. Start at two, and add one when the browser work is visibly
queueing - `LANES.md` for how to see that, `BROKER.md` for the shape that makes adding one cheap.

Five sessions tile side by side at a readable width with nothing stacked below. That is a comfort number
for panes the operator intends to watch, not a ceiling: panes nobody is watching can be parked off screen
and go on working.

**Ten is the ceiling, and the step from five to ten is a decision rather than a slope.** Past five, panes
stack in a second row at roughly half height: still composited, still usable, noticeably cramped. Once the
operator accepts a second row they should fill it, because six workers pay the whole cost of stacking for
one extra slot. Five, or ten; anything between gets the worst of both.

Zooming the application window out buys another readable column, and nobody thinks of it with eight chats
already open. Say it before the first wave rather than after.

**The memory ceiling usually arrives before the pane ceiling.** Measured 2026-08-26 with eight workers on
a 16 core, 31 GB box: 5.0 GB physical free of 31.2, **42 GB committed against 31 GB of physical memory**,
14 node processes, 41 agent processes, 60 percent CPU. The box stayed up and it was paging, so every speed
number taken in that window describes a paging machine rather than the application.

So what bounds a wave is free physical memory, not a count of panes. Nobody has to check it: `fleet.sh
next` reads it before every claim and refuses below the floor, and a worker driving a pane on a full
machine is told to swap its heavy tab for an empty one ("Order of operations").

Workers measuring speed get a wave to themselves, and at this scale it is not optional. They are measuring
a machine the other workers are loading, so numbers taken alongside them describe the fleet rather than
the application. See [`PERF.md`](PERF.md).

## Screen ergonomics the operator will not discover alone

Say these before the first wave: each is invisible until someone points it out and painful to realise
afterwards.

**Pull the planning chat into its own window.** Press and hold the chat in the chat list and drag it out.
It becomes a separate window that floats above the tiled workers, so the chat coordinating the run stops
competing for space with the run itself. This one change makes eight workers manageable rather than merely
possible.

**Zooming the application window out buys another readable column.** Nobody thinks of it with eight chats
already open.

**On Windows a window can be made larger than the monitors.** Windows only; macOS has no window manager
equivalent, though a virtual display or a second Space serves the same end, and on Linux it depends on the
compositor. Drag it left until its left edge passes
beyond the screen, then grab the right edge and pull, and the top edge as well. The window keeps growing
past what the desktop can show. Parts of it, whole panes included, can end up entirely off screen while
the compositor keeps rendering them.

An off-screen pane still composites: a window at `screenX` 5032, entirely past the edge of the desktop, held
300 frames a second for twenty-two seconds [M33]. So park the panes nobody is watching off the desktop
and keep the screen for the chats.

Keep running the gate anyway. It costs a second and it is the only instrument that has never lied.

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

Do responsive work as a deliberate pass: check the default, one width narrow enough to trigger the
application's own breakpoints, and one wide enough to prove nothing depends on a narrow container. Then
reset to `desktop`.
## Order of operations

1. `preview_start`. Creating the pane and loading the app both work while blind, and it means the operator
   sees the real application when they display it rather than a blank tab.
2. Gate.
3. Log in and navigate, once the gate reads live. Both can hang for minutes through a blind pane, and the
   hang reads as a broken backend.
4. **Keep the pane open until the run ends.** Its last tab closing closes it, `preview_start` then reopens
   it hidden, and only the operator can put it back on screen [M35]. To give memory back, swap tabs:
   `tabs_create`, `tabs_select` the new tab, `tabs_close` the heavy one; then gate the new tab and log in
   again before the next observation. A fresh tab getting a fresh renderer is inferred from M34, not
   measured. On a full machine, wait for the memory before loading the heavy page again. A retired worker is
   the exception: its chat is not reused, so it closes every tab, the last one too.

## Delegating browser work

A subagent can drive the parent session's pane. Two things belong in its brief:

- The `mcp__Claude_Browser__*` tools are deferred for subagents. It loads them first with `ToolSearch`,
  query `select:mcp__Claude_Browser__browser_batch,mcp__Claude_Browser__javascript_tool,mcp__Claude_Browser__computer`. Without that line it
  reports having no browser tools and stops.
- It shares the parent's pane and tab, so browser subagents run one at a time.
- **The `tabId`.** The agent is told to use the tab it was given and has no way to discover which one that
  is, so a brief that omits it leaves the agent guessing at a pane it may not own.

Screenshots and DOM reads then land in the subagent's context, and only its final message reaches the
parent. Give it a bounded output contract, and say that its final message carries findings alone;
otherwise the bulk you delegated arrives in the parent anyway.

## Reading state cheaply

Prefer an expression that returns a small JSON string over a full accessibility tree. A dense list page
produces thousands of tokens of tree, and it stays in context for the rest of the session. A store read or
a targeted `querySelectorAll(...).length` answers the same question in twenty.

Screenshots earn their cost when the question is about pixels. For everything else, the DOM read is
cheaper and stronger evidence.

## Instruments that return a confident zero

A blind pane is not the only way to get a plausible nothing. A six worker run hit these on 2026-08-27,
each found the hard way, and each returns a number rather than an error.

- **`performance.getEntriesByType('resource')` reported 0 API requests on a page issuing more than twenty.**
  The default 250-entry buffer was already full before the application booted: `{link: 2, script: 248}`,
  because a dev server serves every module as its own script request. Call
  `performance.setResourceTimingBufferSize(6000)` at document start, or patch `fetch` and
  `XMLHttpRequest` and count there. A worker that trusts the empty buffer concludes the screen makes no
  requests.
- **`transferSize` and `encodedBodySize` read 0 cross-origin** when the API sends no `Timing-Allow-Origin`.
  Byte counts have to come from decoded response bodies read off the request, and the finding says which
  it measured. Wire size is not available.
- **Patching only `fetch` misses half an application.** Anything on axios uses the XHR adapter. Patch both,
  and re-install after every full page load, because a reload wipes the patch and the next measurement
  silently runs unpatched.
- **`javascript_tool` hard-times-out at 30 seconds.** One 16 route navigate-and-measure batch was lost
  whole to it. Around six routes is the ceiling, and batches are budgeted by route count rather than by
  expression size.
- **Evaluating an expression blurs the page**, which closes an open dropdown or panel. State that only
  exists while a control is open cannot be read by a probe that closes it: install a `setInterval` sampler
  writing into a global, drive the control, then read the global back.
- **Programmatic `element.click()` does not always reach a component's handler**, and a synthetic
  `KeyboardEvent` is worse: one earlier false finding came entirely from dispatching Escape on `document`.
  Press controls through the browser tool, as a real event.
- **`ctrl+a` does not select all in the pane.** Typed text concatenated with what was already there, and
  once landed at position 0. Use `triple_click` to select before typing.
- **The screenshot coordinate frame is not the CSS viewport.** Measured 800x381 against a CSS viewport of
  1516x723, about 0.528x. Rectangles from `getBoundingClientRect` are scaled before they are handed to a
  click, or the click lands somewhere else entirely.
- **The pane can resize itself mid-run**, measured 1516x723 to 1666x866 with no emulation involved. Every
  geometric finding carries the viewport it was measured at, for this reason rather than for tidiness.

## Screenshots are the expensive read

The ban on full accessibility trees works: across an eight worker run, zero were pulled. The cost moved to
screenshots, 120 of them, 3.4 MB of base64, roughly 207,000 image tokens, all of it inside four workers.
One took fifty one.

Fifty one screenshots is not fifty one questions about pixels. Take one when the question is visual, when
a measurement disagrees with what the DOM says, or when the finding needs the picture as evidence. A
screenshot to confirm a navigation landed, or to see whether a list has rows, is a DOM read in disguise.

The delegation ratio held regardless, 0.96 to 2.04 percent returned across that run. The denominator
varied by an order of magnitude: the cheapest executor made 30 calls and took no screenshots, the most
expensive made 194 and took 51.

## Spend round trips, not seconds

Every tool call is a model round trip, and round trips dominate the wall clock of a browser walk far more
than the page does. **259 of 1,350 tool calls in one run were avoidable** — a fifth to a third of every
call made [M22]. Three shapes account for almost all of it, and each is recognisable while you are about
to make the mistake:

- **103 pairs of adjacent read-only probes.** Two `javascript_tool` calls in a row, neither changing
  anything, each returning one value. One expression returns both.
- **117 independent searches issued one per message.** Greps and file reads with no dependency between
  them, each paying a full model turn. They go in one message.
- **30 pairs of documentation reads.** Two files opened back to back that were always going to be read
  together.

Before any tool call, ask what else you already know you will need, and whether this call and that one
depend on each other. Independent calls belong in one message; dependent ones do not.

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
whose own spread was 5116 ms, the confident nonsense the method exists to prevent. Buy speed from round
trips, never from sample size.
