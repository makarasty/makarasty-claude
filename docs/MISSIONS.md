# Mission kinds

A fleet is a way to run several sessions against one job. What each worker does inside its session depends
on the mission kind, declared as `kind:` in the brief. Each kind names the working style, the isolation it
needs, and the skill that already does that job well when one is installed.

Pick the kind before writing briefs. It decides how the mission splits, and a mission split along the
wrong axis produces workers that collide.

## verify

Exercise a running system and report what is wrong with it.

Split by **screen ownership**. Workers share one account against one running instance, so two workers on
one screen invalidate each other the moment either changes state. Two workers on two screens do not.

Isolation: none. Verification changes no stored data.

Posture: exercise every control that neither mutates shared state nor leaves the machine, and read the
rest. Open a dialog and cancel it. State a worker actually changes is state another worker was measuring,
so the line is drawn at mutation rather than at clicking. See `SWEEPS.md` for the interaction posture and
the sweeps a verify brief carries.

Reference: [`BROWSER.md`](BROWSER.md) for the pane gate, [`SWEEPS.md`](SWEEPS.md) for the interaction
posture and the class-of-defect checks, [`PERF.md`](PERF.md) when the mission includes
speed or stability.

## investigate

Find the cause of a symptom that is already known to exist.

Split by **hypothesis**, one per worker, each stated as a claim that can be refuted. Splitting by area
instead produces four workers reading the same stack trace.

Isolation: none for reading, worktree for a worker that needs to add instrumentation.

Demand: a worker returns the evidence that killed its hypothesis just as readily as the evidence that
confirmed it. A refuted hypothesis is a result, and the cheapest kind to produce.

Pairs with the `diagnosing-bugs` skill when installed, which supplies the tight reproduction loop this
kind depends on.

## implement

Build a slice of new work.

Split by **seam**, one per worker: a module boundary, a route, a table, a screen. Workers that share a
file share a merge conflict.

Isolation: worktree, always. Two sessions editing one tree produce a merge nobody asked for, and a session
that reverts a path can destroy another session's uncommitted work.

Demand: each worker ships its slice with the test the project's conventions require, and reports which
verification it ran. Scoped verification during the work, full sweep once at the end, by the operator.

Pairs with the `tdd` skill when installed.

## fix

Work through a backlog of known defects.

Split by **file cluster**, so no two workers open the same file. Rank the backlog first: a worker given
twelve unrelated fixes does the first three well.

Isolation: worktree.

Demand: a fix arrives with a reproduction that failed before it and passes after. A fix nobody can prove
is a change, not a fix.

## research

Read sources and produce an answer.

Split by **source**, one per worker: this vendor's documentation, that subsystem, the last six months of
one log stream. Splitting by question instead makes every worker read everything.

Isolation: none.

Demand: every claim carries its source. A synthesis with no citations cannot be checked, and an
uncheckable answer is where a confident wrong answer hides.

Pairs with the `research` skill when installed.

## Choosing the number of workers

Count the independent slices the split axis produces, then cap it by what the machine and the operator can
actually run. Workers that need a visible browser pane are capped hardest: see the wave sizing in
[`BROWSER.md`](BROWSER.md). Workers that only read files scale until memory runs out.

Splitting past the axis is worse than under splitting. Two workers on one slice cost twice and agree with
each other, which reads as corroboration and is not.
