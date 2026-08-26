# Mocking: seeing states real data will not produce

A sandbox holds whatever somebody happened to put in it. That is a small fraction of what an interface has
to survive: the empty case, the single row, the four hundred rows, the name that is sixty characters long,
the value that failed to load, the state that only exists for three seconds during a transition.

Testing only what the data happens to show means testing the easy half. Mocking is how a worker reaches
the rest, and it is the difference between a run that says "the list works" and one that says what the
list does with forty rows of the longest name in the table.

## The line that matters

**Injecting into your own pane is not changing shared state.** A store write, a route interception, a
class toggled on an element: these live in one browser tab, vanish on reload, and no other worker can see
them. The read-only posture is about the server and the shared account, not about the page in front of you.

**Anything that reaches the server is still off limits.** A mock that saves, sends, dials or deletes is
not a mock.

The test: could another worker notice this if it looked right now? If yes, you changed shared state. If
no, you set up a scene.

## What to inject, in order of usefulness

**Store state.** The application's own reactive stores are the highest leverage surface: reach them
through the framework's devtools handle, write the rows you want, and the whole screen re-renders around
them. This is how you get four hundred rows into a list whose sandbox has seventeen.

**Route responses.** Intercepting a request lets you produce what the server will not: a 500, a slow
response, an empty page, a page whose total disagrees with its rows. Include the CORS headers the
application expects, and answer the preflight, or the interception looks like a network failure instead of
the response you wrote.

**The values themselves.** Long names, zero, negative numbers, nulls, a date in 1970, a date in 2099, an
emoji, right-to-left text, a hundred-character identifier. Judge every column by its longest plausible
value rather than by row one.

**Time and viewport.** Freeze a clock to see a relative timestamp render, resize to cross a breakpoint,
zoom to see whether geometry still agrees with data.

## Traps

**Injected state outlives the screen.** A store you wrote to stays written until something refetches or
you reload. Findings after that point describe your scene, not the application. Reload between scenes, and
say in the finding which state it was measured under.

**A mock can hide the defect you were looking for.** Filling a store directly bypasses the loading path,
the paging path and the error path, which is where a good half of interface defects live. Use injection to
test what the screen does with data, and the real path to test how it gets there. Never conclude that
loading works from a screen you filled by hand.

**Made-up data is not a finding.** A rendering flaw is real: the column overflows, the count disagrees,
the row overlaps. A value being wrong is not, when you wrote the value. Every finding from a mocked scene
says so explicitly, and says what was injected.

**A shape the application cannot produce proves nothing.** Before filing a defect about how a screen
handles some value, check whether any write path can create it. An impossible input rendering badly is a
curiosity; a possible one is a defect. One earlier run filed an impossible date as a defect, and the fix
mission spent its time proving no code could write it.

## Reporting

A mocked finding carries, in `conditions`: what was injected, where, and whether the screen was reached
through its normal path or filled directly. Without that, nobody can reproduce it, and the first person
who tries will conclude the finding was imaginary.
