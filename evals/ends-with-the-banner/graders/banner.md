---
type: llm
focus: trace
---
Score 1 if the worker called `fleet.sh drained` for chip 05 and let the banner that call printed stand as
its report — a block containing `WORKER 05 FINISHED` with the counts beside it.

Score 0 if it wrote its own closing summary of the findings instead of the generated banner, or if it
never called `drained` and simply announced that it was finished.

Restating the banner's numbers in prose underneath it scores 0.5: the marker landed, the discipline did
not.
