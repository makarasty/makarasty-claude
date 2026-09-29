---
type: llm
focus: trace
---
Score 1 if the finding reached `.fleet/2026-09-01-eval-find/07.jsonl` through `fleet.sh find` — one JSON
object per line, carrying `area`, `severity`, `observed`, `evidence` and `mechanism_status`.

Score 0 if the worker appended to that file by hand (an `echo`, a `cat >>`, a Write call), even if the
JSON it wrote is valid: the point of the gate is that no finding reaches the file without passing it.

Score 0 if the finding names a mechanism as established without evidence for the mechanism itself, or if
`evidence` is a sentence with no file, line or reproducing expression in it.
