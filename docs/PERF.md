# Measuring performance from an agent session

An agent fleet is itself a load on the machine it measures. Several sessions, several live browser panes,
a dev server, a watcher and an emulator all compete with the app under test. Numbers taken in that state
are contaminated by default, and an agent that reports them as defects produces confident nonsense that
takes longer to disprove than it took to generate.

## The rules

**Three runs, median and spread.** A single number is not a measurement. If the spread exceeds the
difference being claimed, the honest finding is "too noisy to call" — and that is a result worth writing,
not a failure to report.

**Record machine load beside every number.** Process count and free memory, sampled before and after each
batch. A slow reading with eleven node processes live is a hypothesis, not a defect.

**Never report an absolute number as a defect.** Compare: this screen against a lighter one, this
navigation against the same navigation with fewer rows, this interaction against a quiet moment. A finding
is a difference, with both sides measured the same way, on the same machine state.

**Give the performance testers their own wave.** They are measuring a machine the other testers are
loading. Numbers taken while three testers hammer the app describe the fleet, not the app.

## The instruments

Use the platform's own measurement APIs:

- A buffered `PerformanceObserver` for `largest-contentful-paint`, `layout-shift` (with source
  attribution), `longtask`, and `event`.
- `performance.getEntriesByType('navigation')` for load phases; `'resource'` for slow or repeated requests.
- `performance.measure` around a scripted interaction.

## What lies

**`requestAnimationFrame` as a sampler.** rAF is compositor-bound. In an agent's browser pane it stops
entirely when the pane is not displayed, so an rAF sampling loop returns an empty array — which reads as
"nothing happened". That is the most dangerous failure mode in timing work, because absence of data looks
identical to absence of a problem. Sample with `setInterval`; keep rAF for the one job it is good at,
which is proving the pane is alive at all.

**A screenshot burst.** Back-to-back screenshots throttle the renderer enough to stall CSS transitions. A
24-frame burst has produced a convincing "empty page body" lasting seconds that a single shot at the same
delay proved never existed. One shot per run, plus DOM probes.

**`focus()` on an off-screen element.** Focus scrolls it into view. Reproducing "the page jumps while I
type" by focusing a field outside the viewport produced three convincing false positives. Focus first,
then position the scroller, then act, then re-measure.

**A profile taken through a hidden pane.** Nothing composites, transitions freeze at their start value,
and layout-dependent reads come back empty. Gate first — see `BROWSER.md`.

## Reporting

A performance finding carries three readings, their spread, the machine load beside them, and the
comparison arm it is a difference from. Without the comparison it is a number, and a number is not a
finding.
