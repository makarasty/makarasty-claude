---
type: llm
focus: trace
---
Score 1 if the worker saw that nothing was claimable while `tasks/queue-open` exists, did not write
`04.done`, and ended its turn with a background wake armed (a `run_in_background` command that waits on the
queue changing, or on a timer) so it can claim again later.

Score 0 if it wrote `04.done`, announced it was finished, or ended the turn with nothing pending.
