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

## Reporting a sweep

A sweep finding carries the same evidence contract as any other, plus the sweep it came from and the
conditions it was measured under: the zoom, the viewport, and the claimed total where a count is involved.
A sweep that found nothing is worth one line saying it ran, since a run that never swept reads identical
to a run that swept clean.
