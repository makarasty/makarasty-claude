# bench-arch: does "design first, then implement" beat "just implement" on an existing project?

Owner's items 1 and 4 (ledger-2026-11-25.md). Runner: `claude -p` on the subscription, nothing is installed.

## Files

- `fixture/`: taskly, a dependency-free Node ESM task tracker (library + `node:http` server, 9 tests). Its README ends with the
  specification of the feature (recurrence, per-user reminders), so every arm can pass the hidden tests.
- `hidden/accept.test.js`: 24 hidden acceptance tests (module API + HTTP routes). Not visible to the agents.
- `reference/`: a hand-written solution; `hidden/accept.test.js` passes 24/24 against it (proves the tests are passable).
- `bench.mjs`: the harness. `results/`: the real run. `results-smoke/`: the one-run-per-arm smoke test.

## Arms

| arm | calls |
|---|---|
| direct-sonnet | Sonnet (`claude-sonnet-5-5`): the request |
| arch-frame | Sonnet: "First, as a senior software architect, design this change ... write the design to DESIGN.md. Then implement it." + request |
| two-phase | Opus writes DESIGN.md only (tools: Read/Glob/Grep/Write(DESIGN.md), default permission mode), then a fresh Sonnet session implements from DESIGN.md |
| direct-opus | Opus: the request (reference arm: stronger model vs better question) |

All calls: `claude -p --effort medium --setting-sources project --no-session-persistence --strict-mcp-config --disable-slash-commands`,
env `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, fresh temp copy of `fixture/` with its own git repo, tools Read/Edit/Write/Glob/Grep/Bash
(only `node:*` and `npm test:*` allowed), `acceptEdits`, 15 min kill-after per call, `--max-budget-usd 10`.
The request ends with "The interface is specified in README.md." in every arm.

## Rerun

    node bench.mjs run   --runs 5 --jobs 5          # all arms into results/ (skips finished runs; --force to redo; --arms a,b)
    node bench.mjs judge --runs 5 --jobs 5          # blind pairwise opus judge on the diffs (DESIGN.md is removed from the diff)
    node bench.mjs report                           # tables -> results/REPORT.md

Per run in `results/<arm>-<i>/`: `result.json` (metrics), `diff.patch`, `DESIGN.md` (if any), `hidden.tap`, `orig.tap`,
`stream-N.jsonl` (raw agent stream). "orig tests ok" = the 9 original fixture tests, run from a pristine copy against the
agent's tree. "own tests ok" = the agent's `test/` folder passes. Cost is `total_cost_usd` (notional API price).

Two additions beyond the first design, both after the main run showed 24/24 everywhere:

    node bench.mjs judge --runs 5 --srconly         # same judge, but it sees only the diff of src/ (test volume sways it) -> results/judge-src.json, REPORT-src.md
    node ext.mjs run --runs 5 --jobs 5              # extension probe: rebuild each tree (fixture + results/<arm>-<i>/diff.patch), ask Sonnet for a
                                                    # follow-up (yearly + interval recurrence), run hidden/ext.test.js (9 tests) and the 24 again -> results-ext/

`reference/` is the fixture plus a hand-written solution including the yearly/interval follow-up; both hidden suites pass on it.
`results-smoke/` is the one-run-per-arm smoke test, made with an earlier harness (the two-phase design call could not write DESIGN.md
there until it was fixed); ignore it.

## Result of the run on 2026-11-25 (5 runs per arm, claude-sonnet-5-5 and claude-opus-5-5, `--effort medium`)

See `results/REPORT.md`, `results/REPORT-src.md`, `results-ext/REPORT.md`. Short version: every run of every arm passed 24/24 hidden tests
and the 9 original tests, so correctness does not separate the arms here. The blind judge ranks direct-opus >= arch-frame > two-phase >
direct-sonnet, and direct-sonnet loses to both design arms 0-5 under both judge variants. Limits: one small fixture, a README that already
fixes the interface, one judge model, 5 runs per arm.
