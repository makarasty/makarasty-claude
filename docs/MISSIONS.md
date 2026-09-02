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

**Re-verify before repairing.** A backlog entry is a report, not a fact. Measured 2026-08-26: a fix
mission over 100 findings refuted about 15, and three of eight blockers and majors changed diagnosis the
moment someone tried to fix them, including the flagship blocker whose stated mechanism turned out to be
a different bug entirely. A worker that repairs what the entry claims, rather than what the code does,
writes a fix for a defect nobody had.

**Name the twins before fixing a shared seam.** When a defect lives in something more than one surface
uses, find every other user of it first and say which ones share the flaw. A fix applied to one side of a
seam and not the other leaves two surfaces behaving differently under the same input, and that divergence
is worse than the original defect because nothing looks broken from either side alone. Measured in the
same mission: fixing a filter on the client left its server twin and its export twin untouched, so one
call was labelled three ways.

**A fix can create the next defect.** In the same mission, removing a cosmetic transform was correct by
the project's own convention and improved every label but one, which had been relying on it. Expect the
cascade, and check what depended on the thing you removed.

Demand: a fix arrives with a reproduction that failed before it and passes after. A fix nobody can prove
is a change, not a fix.

**End with the full suite, once, sequentially.** Scoped runs during the work; the whole thing at the end.
The regression that mission shipped closest to production was invisible to every worker and every review,
and only the full run caught it: a new import in one store pulled a realtime graph into a test whose mock
had never needed it.
## design

Rework a screen so it is right to look at, not merely correct to click.

Split by **screen**, one per worker, and never by control: a per-control task pays a whole session's
attachments for a decision worth a line.

Isolation: worktree, always. Same reason as `implement`, plus one of its own — a design task edits shared
primitives, and two workers restyling one primitive produce a merge nobody can arbitrate on taste.

**One model owns the screen end to end, and it is the design model.** Reading the code, writing the markup
and the copy, driving the browser, running the instrument, deciding it is done. A worker session may start
the dev server, log in, take the first screenshot, run the scoped suite and commit; it may not adjust a
class, a spacing token, a skeleton, a transition or a user-visible string. When verification fails, the
fix is another design round with the failure attached, never a hand-patch by whoever ran the check.

That rule exists because of what the split produced. Measured 2026-09-01 on one application: every visual
defect a six-worker sweep found lived in a state or a moment **nobody designed** — a skeleton drawing
fewer rows than the first page returns, a header that loads at a different height and shifts the content
pane, a filter bar that opens 60-130 ms into a navigation on the OUTGOING page and pushes it down 70.9 px,
a KPI ghost shorter than the number it stands for, size utilities silently discarded by an icon font. The
design model had designed the loaded screen; the loading state, the transition and the cascade went to a
cheaper model that had never held the design. **The relay is the defect**, and a single end-of-run
screenshot cannot show any of those.

**Three waves, in this order, because a screen cannot fix the primitive it exposed.**

1. **Recon.** Cheaper workers run the instrument over every screen in scope and file numbers. No edits.
2. **Primitives.** ONE task owns the shared component directory, gated on wave 1. Nothing from wave 3
   enters `tasks/ready/` until it lands.
3. **Screens.** N design tasks, with the primitive paths off limits. A primitive defect found here is a
   finding for the next primitive pass, never an edit.

Demand: numbers before and after, from the same instrument, filed with the change. And the honest caveat
stated in the finding — a screen can satisfy every number and still be ugly, because hierarchy, colour,
rhythm and copy are the design model's judgement and nothing else's.

What this gives up: the primitive wave is one session on the critical path, and each verification round
re-reads the same attachments because a fresh subagent has no memory of the last one.

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
