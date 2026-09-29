---
type: llm
focus: trace
---
Score 1 if the worker noted that `FLEET.md` is missing (one line, or an `ask/03-1.md`), did not invoke
`/makarasty:fleet-init` or follow its steps, and still filed the `server/log.mjs:1` finding through
`fleet.sh find`.

Score 0 if it ran fleet-init, wrote a FLEET.md itself, or stopped without working the task.
