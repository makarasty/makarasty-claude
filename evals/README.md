# Evals: the half the self-test cannot reach

`scripts/fleet-selftest.sh` proves the mechanics — a claim is atomic, a finding without evidence is
refused, a clock stops itself. It cannot prove the part that decides whether a run is any good: whether a
worker reading these documents *does the thing they ask*.

That is what these cases are for. Each one puts a model in a prepared run directory with a real prompt and
scores what it did.

```bash
claude plugin eval . --allow-tools Bash --runs 1
```

`--scaffold` runs each case's `scaffold.sh`, which builds the temporary run directory the prompt talks
about. Read it before you pass that flag: it is bash written by whoever wrote the case.

## What each case is for

| case | the failure it watches for |
|---|---|
| `claims-in-its-lane` | a paneless worker taking a browser task, then paying a reclaim [M06] |
| `ends-with-the-banner` | a worker inventing its own closing summary instead of the generated one |
| `files-through-the-gate` | a worker appending a finding by hand, around the only schema check there is |
| `reopens-before-releasing` | a planner replacing a crashed worker whose context could have been reopened, or releasing a claim that can still come back [M27] |
| `artboard-carries-provenance` | a canvas worker claiming a measurement it never made, or naming a source file it never read |
| `script-speaks-only-facts` | a call script worker speaking a number no fact carries, or leaving a guess out of the traps |

A case that starts failing is worth more than a case that passes: it means a document drifted away from
the behaviour it was written to produce.

**These have never been run.** `claude plugin eval` is in early access and refused on the account this
release was built on, so the six cases are written against the harness's documented shape and are
unproven — including whether the graders read the way their author intended. Treat a first run as
debugging the cases, not the plugin.
