# Evals: the half the self-test cannot reach

`scripts/fleet-selftest.sh` proves the mechanics — a claim is atomic, a finding without evidence is
refused, a clock stops itself. It cannot prove the part that decides whether a run is any good: whether a
worker reading these documents *does the thing they ask*.

That is what these cases are for. Each one puts a model in a prepared run directory with a real prompt and
scores what it did.

```bash
claude plugin eval . --scaffold --trust-plugin --allow-tools Bash Write Edit --runs 1
```

Linux or macOS only. Every case grants Bash, and the harness refuses to run a shell tool it cannot sandbox;
on Windows (Claude Code 2.1.280) each run exits at once with "sandbox required but unavailable" and is
scored against an empty workspace. Use WSL or another machine.

Every case needs `--scaffold`: its `scaffold.sh`, named by `context.scaffold_script` in the case's
`case.yaml`, builds the run directory the prompt talks about, and without it the case grades an empty
workspace. Read the scaffolds before passing the flag: they are bash that runs as you. `case.yaml` carries
the turn and time limits and `runs`; `prompt.md` is the prompt; each `graders/*.md` needs a `type:` in its
frontmatter or the harness skips it. The `llm` graders set `focus: trace`, because the default judges only
the last message and every case here grades what the worker did. `--runs 1` is for a first pass; drop it
for the three runs each case asks for.

## What each case is for

| case | the failure it watches for |
|---|---|
| `claims-in-its-lane` | a paneless worker taking a browser task, then paying a reclaim [M06] |
| `ends-with-the-banner` | a worker inventing its own closing summary instead of the generated one |
| `files-through-the-gate` | a worker appending a finding by hand, around the only schema check there is |
| `reopens-before-releasing` | a planner replacing a crashed worker whose context could have been reopened, or releasing a claim that can still come back [M27] |
| `artboard-carries-provenance` | a canvas worker claiming a measurement it never made, or naming a source file it never read |
| `script-speaks-only-facts` | a call script worker speaking a number no fact carries, or leaving a guess out of the traps |
| `stays-open-while-queue-open` | a worker writing `.done` while the planner still holds `queue-open` |
| `proves-before-editing` | a fix made before its reproduction was run through `prove` |
| `reserved-step-not-asked` | a worker running, or asking about, a step that texts a real person |
| `no-init-in-a-worker` | a worker starting fleet-init's operator interview over a missing `FLEET.md` |
| `blocked-is-not-clean` | a collection reporting a blind worker's area as clean |

A case that starts failing is worth more than a case that passes: it means a document drifted away from
the behaviour it was written to produce.

Not covered: the pane gate, because an eval run has no Browser pane, and the memory refusal (`next` exit
6), because a scaffold cannot make the machine short of memory.
