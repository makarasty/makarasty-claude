---
description: Analyze how a fleet run worked - where task time went, how fast the workers were, where the tokens and money went - from the session transcripts, without spending model turns on parsing. Use on "проанализируй флит", "проанализируй скорость флита", "почему флит медленный", "куда ушли токены", "сколько стоил флит", "analyze the fleet run", "analyze the speed", "where did the tokens go".
argument-hint: <run-id>
allowed-tools: Bash, Read
---

The script in `scripts/` lives in this plugin's own directory, `${CLAUDE_PLUGIN_ROOT}`, not in the project.

Reading transcripts by hand is the expensive way to answer this. On 2026-10-08 the analysis behind M36 took
a chat a dozen ad-hoc scripts; numbers of the same kinds now come from one call that reads a six-worker run
in under a second and an about-340-task, 28-worker run in about three. Its counting is stricter in places -
a re-read must overlap lines already read - so a figure can sit a little below the one M36 records.

## Run it

```bash
m=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")   # the main checkout, from any worktree
run=".fleet/<run-id>"; [ -d "$run" ] || run="$m/.fleet/<run-id>"
# only when no run id was given: run=$(dirname "$(ls -td .fleet/*/chips | head -1)")
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet-analyze.mjs" "$run"
```

It finds the transcripts itself (`~/.claude/projects/<slug of the project>`, then every project folder).
Pass `--projects <dir>` when they live elsewhere and `--prices <file.json>` to replace the price table.
A live run is fine: tasks still claimed are counted as open, nothing is written.

## Answer

1. Show the report as printed, in a code block. Do not retype or round its numbers.
2. Under it, at most three lines in the operator's language, each pointing at a number in the report:
   what dominated task time, what one change would save the most, and anything the report flags as
   missing (a transcript not found, a coordinator not found).
3. Offer the details: `--json` has the split per task, per worker and per subagent, every cache rewrite,
   and the fine-grained time kinds behind each bucket.

## Reading the numbers

- **Where task time went** covers only done tasks that did not overlap another task of the same worker,
  so its parts sum to real wall time. Parent and subagent work at the same moment share it.
- **Outages >45m** are idle stretches with nothing recorded: a crash, a restart, a blind pane (M35). They are
  lost time, not slowness; on `2026-10-07-rm-ui-intake` they were 21% of task time.
- **One tool call** and **read-only turns after another** are the M36 habit: most of a worker's time is
  turns, and a turn costs about the same whatever it does. Batching reads is the lever.
- **Re-reads** count a read only when its lines overlap lines that chat already read; paging is not a re-read.
- **Cost** is a list-price estimate per model (Opus 5.5 $4/$20 per million, cache read $0.20, cache writes at
  1.25x and 2x of input), what the tokens would cost on the API, not what a subscription bills. Subagent
  transcripts keep only the stream-start output count, so their output is estimated from what they wrote,
  a lower bound. The coordinator is its whole session, planning included.

Do not recommend anything the report does not carry a number for. Its own recommendations already cross a
threshold each; repeat them, do not add to them.
