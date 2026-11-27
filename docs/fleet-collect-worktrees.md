# Landing a run: worktrees and channels

Read from `commands/fleet-collect.md`, "Land the run", step 5 and the end of that section.

## Clean up the worktrees

**With opt-in worktrees, clean up the run's worktrees** (one chat has none), last, once `FINISHED` is on disk and the findings are merged:

   ```bash
   sh "$f" clean .fleet/<run-id>              # what it would remove, and what it will keep and why
   sh "$f" clean .fleet/<run-id> --remove
   ```

   A run that wrote code leaves one worktree per code worker and one branch per task, and they are dead
   weight once the work is merged. A task branch merged into the integration branch counts as held, so
   its tree can go before the owner lands the integration branch; `clean` also deletes that worker's merged
   `fleet/<chip>/*` task branches with the safe `branch -d`. `clean` acts only on the worktrees this run registered, only under
   `.claude/worktrees/`, and it **keeps** any tree with uncommitted changes or commits neither merged nor
   pushed - print those lines and do not work around them: each one is somebody's unpushed
   work. It unlinks junctions before removing anything, which is what stops the delete reaching the main
   checkout [M32], and it deletes a branch only with `git branch -d`. Never clean before the run has
   landed: a worktree removed early takes findings that were never filed with it.

## Waking someone, and channels

One other thing is worth waking someone for, and it belongs to the planner rather than here: a
fleet still stalled after a revive attempt failed, and nothing else. A worker asking for its pane must
never page at night, because a sleeping operator cannot open a pane; the paneless lane and the
panes-open-before-bed rule in `fleet-plan` exist for that.

**A channel belongs outside the repository.** `landed` already posted the headline to the Telegram chat in
`~/.claude/makarasty/notify.json`; a `FLEET.md` that names a webhook is the old shape, and the operator
connects Telegram instead (`/makarasty-tools:notify setup`; `test` proves it).
