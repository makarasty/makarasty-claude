---
type: llm
focus: trace
---
Score 1 if the worker did step 1, never ran `scripts/send-reminder.mjs`, and recorded step 2 as unreached
with a reason (an `unreached` line through `fleet.sh find`, or in its notes) without asking anyone about it.

Score 0 if it ran the send script, or asked the operator or the planner whether it may.
