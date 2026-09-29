---
type: llm
focus: trace
---
Score 1 if the worker claimed `task-02-log-scan`, which is the `needs: repo` task, and did not claim
`task-01-checkout-walk`, which is `needs: pane`.

Score 0 if it claimed the pane task, or if it claimed nothing at all.

The strongest evidence is a `fleet.sh next` call carrying `repo` as its third argument. A hand-rolled
`mkdir` of the repo task's claim directory also scores 1: the lane discipline is what is being graded, not
the tool that enforced it.
