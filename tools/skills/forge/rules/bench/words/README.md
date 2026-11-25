# bench-words: does the wording of a coding instruction change code quality?

Claim tested: negative wording ("do not write buggy code") makes the model write worse code than positive wording ("write professional, production-grade code ...").

## Layout

- `fixtures/ratelimiter`, `fixtures/csv` (the two requested tasks) and `fixtures/cache` (LRU+TTL), `fixtures/emitter` (event emitter) (two harder tasks added after the first 80 runs hit the ceiling of the hidden tests): what the agent starts with (README spec, package.json, 3 visible tests).
- `hidden/*.test.mjs`: 16, 18, 16 and 17 edge-case tests, never shown to the agent; run after it finishes, against its `src/`.
- `ref/`: my own reference implementations, used only to check that the hidden tests are fair (both pass 16/16 and 18/18 with visible tests).
- `arms/*.txt`: the text appended to the system prompt (`neutral` appends nothing).
- `run.mjs`: runner, judge and report. `runs/<name>/`: one JSON per run (source code, reply, tools, cost), `judge.json`, `report.md`.

## How a run works

A fresh temp dir is copied from the fixture. `claude -p --model <m> --effort medium --setting-sources project --no-session-persistence --permission-mode acceptEdits --tools Read,Edit,Write,Glob,Grep,Bash --allowedTools "...Bash(node:*),Bash(npm:*)" [--append-system-prompt-file arms/X.txt]`, prompt on stdin: "Implement src/<module>.js per README.md. Visible tests: npm test." The same in every arm. `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and the parent session's `CLAUDE_*` variables are removed so the owner's CLAUDE.md and session settings do not leak (checked: init lists only built-in plugins).
After the run the original visible test is restored, the hidden test is copied in and both are run with `node --test --test-reporter=tap`. Timeout 10 min per run, 1 min per test run.

## Rerun

```
node run.mjs run    --out full --n 5 --conc 5                 # 4 tasks x sonnet,haiku x 4 arms x 5 = 160 runs; use --tasks to pick; resumes (skips existing files)
node run.mjs judge  --out full                                # blind pairwise judge (opus, no tools), pairs = run i of arm A vs run i of arm B
node run.mjs report --out full                                # writes runs/full/report.md
```

Options: `--models sonnet,haiku,opus`, `--tasks csv`, `--arms neutral,negative`, `--judge opus`. Do not run two copies on the same `--out`.

Judge pairs: positive-vs-negative, positive-vs-neutral, neutral-vs-negative, positiveLong-vs-neutral; order randomised per call, arm names never shown, only the code (`src/`) and the README.

## Limits

- 5 runs per cell; the tasks are small, so a strong model may sit at the ceiling of the hidden tests and then only LOC and the judge can differ.
- The judge reads code, does not run it. It is one opus per pair.
- Bash is not sandboxed beyond the permission mode: agents sometimes write scratch files outside the run dir.
