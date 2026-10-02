# Measuring performance from an agent session

A fleet is itself load on the machine it measures. Several sessions, several live browser panes, a dev
server, a watcher and an emulator all compete with the application under test. Numbers taken in that state
are **contended** by default, and an agent that reports them as defects produces confident nonsense that
costs more to disprove than it cost to generate.

## Rules

**Three runs, median and spread.** A single number is not a measurement. When the spread exceeds the
difference being claimed, the finding is "too noisy to call", and that is a result worth writing.

**Record machine load beside every number.** Process count and free memory, sampled before and after each
batch. A slow reading taken with eleven node processes live is a hypothesis.

**Report a difference, not a number.** Compare this screen against a lighter one, this navigation against
the same navigation over fewer rows, this interaction against a quiet moment. Both sides measured the same
way, on the same machine state. Without a comparison arm you have a number, not a finding.

**Give the measuring workers their own wave.** They are measuring a machine the other workers are loading.

## Instruments

- A buffered `PerformanceObserver` for `largest-contentful-paint`, `layout-shift` with source attribution,
  `longtask`, and `event`.
- `performance.getEntriesByType('navigation')` for load phases, `'resource'` for slow or repeated requests.
- `performance.measure` around a scripted interaction.
- `setInterval` for sampling anything over time - **with the frame gate beside every series it produces.**
  A pane that is laid out but not compositing runs `setInterval` at full rate: measured at 142 ticks in
  142 seconds, one per second, exactly on time, while the page drew nothing at all [M33]. A timing series
  taken there is correctly spaced, plausible, and about nothing. It is the one instrument on this page that
  fails without looking like it failed.

## What lies

**`requestAnimationFrame` as a sampler.** rAF is compositor bound. In an agent's browser pane it stops
entirely when the pane is not displayed, so an rAF sampling loop returns an empty array, which reads as
"nothing happened". Absence of data looks identical to absence of a problem, which makes this the most
dangerous instrument in timing work. Keep rAF for the one job it is good at, proving the pane is alive.

**A screenshot burst.** Back to back screenshots throttle the renderer enough to stall CSS transitions. A
24 frame burst produced a convincing empty page body lasting seconds, which a single shot at the same delay
proved had never existed. Take one shot per run, and pair it with DOM probes.

**`focus()` on an off screen element.** Focus scrolls it into view. Reproducing "the page jumps while I
type" by focusing a field outside the viewport produced three convincing false positives. Focus first, then
position the scroller, then act, then measure again.

**A profile taken through a blind pane.** Nothing composites, transitions freeze at their start value, and
layout dependent reads come back empty. Gate first, see [`BROWSER.md`](BROWSER.md).

**A count of animations.** `document.getAnimations()` misses SMIL entirely, so an SVG animating forever is
invisible to it while it burns a core. Check the animation list and the SVG separately when hunting idle
CPU.

## Reporting

A performance finding carries three readings, their spread, the machine load beside them, and the
comparison arm it is a difference from.
