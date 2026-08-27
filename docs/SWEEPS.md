# Sweeps

A sweep is a check that catches a whole class of defect rather than one screen's bug, applied to every
screen a brief owns. Each one below carries what it catches, the probe, and the rule for calling it.

Sweeps are why a worker clicks rather than reads. A screen that renders correctly on arrival can still be
broken in every direction the operator would take it.

## Interaction posture

**Exercise every control that neither mutates shared state nor leaves the machine.** Tabs, filters, sorts,
search boxes, expand and collapse, pagination, column pickers, zoom, keyboard shortcuts, and any dialog
that can be opened and then cancelled.

Open a dialog, read it, cancel it. The cancel path is a control too, and a dialog that leaves state behind
after cancel is a finding.

Setting up a scene in your own pane is not mutating shared state: a store write or an intercepted response
lives in one tab, vanishes on reload, and no other worker can see it. See `MOCKING.md`. Anything that
reaches the server is a different thing entirely.

The controls that stay with the operator are the ones the project's `FLEET.md` reserves, plus anything
that writes shared data the other workers are observing. Those get read, not pressed, and a screen only
observable by pressing one is recorded as unreached.

**A control that does nothing is a finding.** Note every button that produced no observable change: no
navigation, no network request, no DOM difference, no toast. Say which of those you checked.

## Truncation sweep

**Catches:** a list that holds a fraction of its own reported total and says nothing about it. The
operator sees a full-looking page, works a quarter of the queue, and never learns the rest exists.

Measured case, 2026-08-26: a queue reported 158 open in its header and its tab strip, loaded the first
page of 40, and stopped. Scrolling added nothing. Counters were correct and internally consistent, so
nothing on screen contradicted anything else on screen.

**Probe.** Open the list, note the total it claims, then scroll to the bottom, wait, and measure:

```js
(() => { const sc = document.querySelector('.table__scroller, [data-scroller], main');
  return JSON.stringify({ rowsInDom: document.querySelectorAll('tbody tr').length,
    scrollTop: sc?.scrollTop, clientHeight: sc?.clientHeight, scrollHeight: sc?.scrollHeight,
    scrollable: sc ? sc.scrollHeight > sc.clientHeight : null,
    zoom: getComputedStyle(document.documentElement).zoom }); })()
```

On a virtualized table `rowsInDom` is the visible window, so it proves nothing on its own. `scrollHeight`
divided by the row height estimates how many rows the store actually holds. Compare that against the
claimed total.

Scroll to the bottom a second time and measure again. A `scrollHeight` that does not grow means paging is
not happening.

**Watch the requests while scrolling**, because two different causes produce the same screen. A second
request that never fires, a second request carrying the same offset as the first, a response that says
there is no more while the total says otherwise, and a response that arrives and is discarded are four
separate defects with one symptom. Record which of the four you saw: the offset on the second request and
whether rows were appended separate them.

**Rule.** Reachable rows below the claimed total is a blocker when the page gives no sign it is partial,
and a major when it does. Report the claimed total, the reachable count, and the request evidence.

## Zoom and viewport sweep

**Catches:** layout and measurement that break at anything other than the size the developer happened to
have open. Applications with a global CSS zoom hit this constantly, because imperative measurement and
observers do not all agree about the coordinate space.

**Read both numbers rather than assuming either.** A worker's pane is smaller than the browser window a
person would open by hand, so the default it sees is already not the default a developer sees:

```js
JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
  zoom: getComputedStyle(document.documentElement).zoom })
```

**Zoom.** Use the application own scale control when it has one. Many applications do not: the zoom is a
build time constant applied to `html`, with nothing to click. Then set it yourself with
`document.documentElement.style.zoom` and record in the finding that the change was simulated rather than
operated, because a simulated zoom exercises the layout without exercising whatever the real control also
does. Repeat the key assertions at the default,
one step down and one step up.

**Viewport.** `resize_window` emulates a size on the tab: presets `mobile` (375x812), `tablet` (768x1024),
`desktop` (clears emulation), or a custom width and height together. Check the default, one width narrow
enough to cross the application's own breakpoints, and one wide enough to prove nothing depends on a
narrow container.

Two traps. The emulated size persists on that tab across reloads and navigation until `desktop` clears it,
so a worker that forgets to reset hands every later observation a phone layout. And a width below 768 also
emulates a mobile device, with a touch stack and no hover states, which is right for a phone check and
wrong for "narrow desktop window". Reload after switching so load-time device decisions run again.

At each combination check: rows not overlapping, sticky headers above the content they cover, action cells
keeping their buttons inside, scrollers still reaching their end, tooltips still openable, and any count
derived from geometry still matching the count derived from data.

**Rule.** A defect that appears at one size or zoom and not another is a finding in its own right, and it
changes the fix. Never report a layout finding without the zoom and the viewport it was measured at, and
reset the tab to `desktop` before finishing.

## Overflow sweep

**Catches:** content that escapes its container. Judge by the longest real value on the screen rather than
the first row, since the first row is usually short and the defect hides in row forty.

Check each column and card for text painting outside its box, buttons pushed out of an action cell,
a value clipped without an ellipsis, and a tooltip that never opens because its trigger has zero width.

**Rule.** Report the specific value that overflows and the viewport plus zoom it overflowed at.

## Pixel seam and scroll sweep

**Catches:** the small visual wrongness that survives every functional check. A one pixel line along the
top or right edge of a virtualized table. A border that doubles where a sticky header meets its first row.
A scrollbar that appears for two pixels of content. A container that scrolls when nothing overflows, or
refuses to when something does. Layout that grows on interaction and never shrinks back.

These are the defects users report as "it looks broken" and nobody can reproduce from a description, so
they need measuring rather than looking.

**Probe.** For each scrolling container and each table:

```js
(() => { const el = document.querySelector('SELECTOR'); const r = el.getBoundingClientRect();
  return JSON.stringify({ w: Math.round(r.width*100)/100, h: Math.round(r.height*100)/100,
    sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight,
    overflowsX: el.scrollWidth > el.clientWidth, overflowsY: el.scrollHeight > el.clientHeight,
    gutter: el.offsetWidth - el.clientWidth,
    zoom: getComputedStyle(document.documentElement).zoom, vw: innerWidth }); })()
```

**Rules.**

- `scrollWidth` exceeding `clientWidth` by one or two pixels is the classic stray seam: a border, a
  rounding error under zoom, or a child a fraction wider than its parent. Report the exact difference.
- A fractional width on a table or its header, when the two disagree, misaligns every column below.
  Compare header and body cell rectangles rather than trusting that they match.
- Scroll to the end and back. Geometry that changes after scrolling means a virtualizer estimating row
  height wrongly, and it is worth the finding even when nothing looks wrong at rest.
- Interact, then measure again. A panel, tooltip or dropdown that grows its container and leaves it grown
  is a defect the screenshot at rest will never show.

Measure at more than one zoom. Under a scaled root a one pixel seam is a rounding artifact of the scale
factor as often as it is a real border, and which one it is decides whether there is anything to fix.

## Every control opens

**Catches:** the select, facet, dropdown or picker that renders but never opens, opens empty, opens behind
something, or opens off screen. A control that cannot be opened is invisible to every test that only reads
the page.

Open every one of them. For each, record that it opened, that it had options, and that its panel is inside
the viewport. Then close it and confirm it closed: a picker that stays open under the next click is as
broken as one that never opens, and it is the half people forget to check.

## Empty against failed

**Catches:** the screen that shows "nothing here" when the truth is "the request failed". The two look
identical and mean opposite things: one is a working screen with no data, the other is an outage nobody
was told about.

For every empty state you meet, check whether the request that feeds it succeeded. An empty state sitting
on top of a failed or refused request is a finding, and a common one after a permission change.

**Rule.** Report the request status beside the empty state. "The list is empty" without it is not evidence.

## Navigation round trip

**Catches:** state that survives a departure it should not, and state that dies when it should persist.

Leave the screen and come back. The list should render the same rows, the filters should behave as the
application documents, and a second visit should not silently show fewer rows than the first.

**Rule.** A second visit that differs from the first is a finding, whichever direction it differs in.

## Route transition sweep

**Catches:** what the screen does *during* a navigation, which every other check misses because they all
measure at rest. Content from the page you left still painted under the page you arrived at. An overlay,
tooltip or dropdown that outlives the route that opened it. A skeleton in the shape of the old page. Scroll
position carried across. A panel that unmounts a beat late, so for a few hundred milliseconds two pages
are on screen at once.

Users describe this as "it flickers" or "the old page hangs around", and it never reproduces from a
description because it is gone by the time anyone looks.

**This sweep needs a live pane.** In a blind one transitions freeze at their start value and
`transitionend` never fires, so the artifact either never appears or never clears, and both readings are
fiction. Gate immediately before it.

**Probe.** Sample across the transition rather than around it, with `setInterval` rather than
`requestAnimationFrame`:

```js
(() => { const marks = [], t0 = performance.now();
  const snap = () => marks.push({ t: Math.round(performance.now() - t0),
    path: location.pathname,
    roots: [...document.querySelectorAll('[data-page], main > *')].map(e => e.className).slice(0, 6),
    overlays: document.querySelectorAll('[role="dialog"], .popup, .tooltip, [data-overlay]').length,
    scrollTop: (document.scrollingElement || document.body).scrollTop });
  const id = setInterval(snap, 40); snap();
  return new Promise(r => setTimeout(() => { clearInterval(id); r(JSON.stringify(marks)); }, 1200)); })()
```

Fire the navigation, then read the samples. Walk the busiest pairs of screens in both directions, since
teardown is rarely symmetric: leaving a heavy page for a light one exposes different ordering than the
reverse.

**Rules.**

- Content belonging to the previous route present in a sample where `path` already reads the new route is
  a finding. Report the interval it persisted and both routes by name.
- An overlay count that does not return to its baseline after the navigation settles is a leak, not a
  flicker: the element is still in the document.
- Scroll position that survives a route change, or that resets when the application documents that it
  should not, is a finding either way.
- Two page roots in one sample means overlapping mount and unmount. Give the millisecond window.

**Rule.** Every transition finding names both routes, the direction, and the timings from the samples. A
transition artifact without a duration cannot be told apart from a normal frame of rendering.

## Reporting a sweep

A sweep finding carries the same evidence contract as any other, plus the sweep it came from and the
conditions it was measured under: the zoom, the viewport, and the claimed total where a count is involved.
A sweep that found nothing is worth one line saying it ran, since a run that never swept reads identical
to a run that swept clean.
