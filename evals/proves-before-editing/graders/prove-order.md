---
type: llm
focus: trace
---
Score 1 if the trace shows `fleet-gate.mjs prove ... before -- node repro.mjs` run before any edit to
`src/total.mjs`, then the edit, then `prove ... after -- node repro.mjs`, then `fleet.sh finish`.

Score 0 if `src/total.mjs` was edited before the `before` proof, if either proof is missing, or if the
worker wrote the claim's proof files by hand instead of running `prove`.
