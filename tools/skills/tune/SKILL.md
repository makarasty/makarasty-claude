---
description: Re-checks which model and effort each role should use (main chat, coder, reviewer, judge, scouts) from this machine's own transcripts and git history, with an optional paid blind benchmark. Use on "перепроверь модели", "какую модель для чего", "новая модель вышла, пересчитай", "tune models", "benchmark the models".
argument-hint: "[usage|quality|bench] [--days N]"
allowed-tools: Bash(node:*), Read, Write, Agent
---

The goal is one dated table, role -> model + effort, each row backed by evidence, compared with the last
run. Scripts do the counting; the chat only judges. `"${CLAUDE_SKILL_DIR}/tune.mjs"` is the script; its header lists
every command. All output lands in `~/.claude/makarasty/tune/` (call it `$OUT`).

Ground rules, with the reason:
- Run one `node "${CLAUDE_SKILL_DIR}/tune.mjs" ...` at a time and wait for it: the scans stream gigabytes of transcripts and hold a
  lock; each command already has its own hard timeout. Exit 124 = timed out: report it, do not retry.
- Objective signals rank first (known bugs caught, tests passing, review rounds, fix-needed share, owner
  corrections); the judge's score second. A judge is a model and has its own taste.
- Compare model with model at the same effort, and effort with effort on the same model. An arm pair that
  changes both proves nothing about either; `plan` prints `CONFOUND` for it.
- Models come from the transcripts and prices from the one table in the makarasty plugin. A model printed
  as `UNPRICED` is new: get its list price from the person or the vendor page and pass
  `--prices <file.json>` (`{"claude-x-1": {"in":..,"out":..,"cr":..,"w5m":..,"w1h":..}}`); never price it
  as another model.

## Step 1: usage (free)

`node "${CLAUDE_SKILL_DIR}/tune.mjs" usage --days 7`. Where the money went: per model, per role x model x effort, main vs subagent,
project, main-chat context buckets, per day. Read it for which roles matter: a role under a few percent of
the spend is not worth a benchmark.

## Step 2: quality from history (free)

`node "${CLAUDE_SKILL_DIR}/tune.mjs" quality --days 30`. Per coder model+effort: findings in the first review, fix-needed share,
review rounds, $ per task; per subagent role: runs and median $; per main-chat model+effort: owner
corrections per 100 messages. Say the sample size beside every claim, and check the bias line: an arm
that got the smaller tasks looks better than it is. Agent types are matched by `coder` and `review`;
other naming: `--coder <regex> --reviewer <regex>`.

Stop here when steps 1-2 answer the question (no new model, no row in doubt).

## Step 3: benchmark (paid, only with consent)

1. `node "${CLAUDE_SKILL_DIR}/tune.mjs" pick --n 10` picks real diffs from the repos in the history, by markers fixed before any
   result: commits a later fix blamed or a revert undid, tasks that took 2+ review rounds, and controls,
   with a seeded draw. Categories and known bugs are sealed in `review/sealed/answers.json`: do not read it
   until scoring, so nothing you say steers the reviewers.
2. Choose arms that separate model from effort, for example `opus:high,sonnet:high,sonnet:medium` with the new and the current model's names (`plan` refuses a name it has no price for).
   `node "${CLAUDE_SKILL_DIR}/tune.mjs" plan <run> --arms <...> [--whole K]` prints the cost estimate per arm and in total, seals the
   codes once, and makes one folder per reviewer, `blind/<NN>-<CODE>/`, holding only the change and a
   snapshot of the files at the commit (no repo path, no answers). It stops on an `UNPRICED` arm or judge
   and on a run already planned; `--force-new-run` voids the old plan's reviews and starts over.
3. Ask the person in one AskUserQuestion: the arms, the number of diffs, the estimate. No answer or no:
   stop, and keep steps 1-2 as the result.
4. Reviewers: one subagent per folder, with the model and effort of its code's arm, prompt exactly
   `Follow <folder>/review-task.md. tune-run=<run id> NN=<NN>, CODE=<CODE>`. Codes come from
   `review/sealed/map.json`; never put a model name in a prompt a judge will read.
5. Judges: strongest model, each given a few diffs, prompt exactly
   `Follow <run>/review/judge-task.md for diffs <NN list>. tune-run=<run id> JUDGE=<j1, j2...>`. The tag
   lets `cost` count judge spend; judges never see `map.json`.
6. `node "${CLAUDE_SKILL_DIR}/tune.mjs" cost <run>` then `node "${CLAUDE_SKILL_DIR}/tune.mjs" score <run>`: unseals, writes `score.md`, objective columns first.

Whole-task arms (optional, `--whole K`, the costliest part): candidates come fresh from current open work
(the backlog, the handoff, open questions). For each, run `node "${CLAUDE_SKILL_DIR}/tune.mjs" open <repo> --since <date the item
was written> --files <its files> --grep <its id>`, then its reproduction at HEAD; drop it when either says
it is done. One `node "${CLAUDE_SKILL_DIR}/tune.mjs" clone <repo> HEAD <dir>` per task x arm; the prompt is `task-common.md` with its
placeholders filled. Score by the task's tests first, then a blind judge reading both diffs and
BENCH_RESULT.md files by code; write `<run>/whole/results.json` as
`[{"task":"t1","code":"A","tests_pass":true,"score":8}]` before `score`.

## The result

Write `$OUT/<YYYY-MM-DD>.md`:

```
| role | model | effort | evidence |
|---|---|---|---|
| main chat | ... | ... | step 2: corrections 3.1 vs 4.0 per 100 msgs (n=40/12 chats) |
| fleet-coder | ... | ... | bench: 4/5 tests pass vs 2/5; step 2: rounds 1.4 vs 1.9 (n=22/31) |
```

One row per role that has spend in step 1; evidence names the step, the numbers and n. A row with no new
evidence keeps last run's choice and says so. Then `node "${CLAUDE_SKILL_DIR}/tune.mjs" diff` and report to the person, in their
language: what changes, why, what it costs or saves per week from step 1, and what was not measured
(roles with too small n, effort levels not tried, the judge's single taste). Applying the table to agent
files, routers or docs is a separate change the person asks for.
