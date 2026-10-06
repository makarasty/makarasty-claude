# Worktrees: created safely, cleaned safely

A worker whose brief writes code runs in its own git worktree, so two sessions never edit one tree. The
worktrees pile up: one per code worker, each with a branch. A project's own setup script may link
`node_modules` into every worktree to skip a second install, and `fleet.sh worktree --create` does the same
for the trees it makes; every one of those links is a hole a recursive delete follows. At the end of a run
the work is committed on each task's branch (pushed only where the project's rules allow it) and the
worktrees are dead weight on the disk. Removing them is right, and removing them
wrong is how an agent deletes something it should not.

The obvious command is not the safe one.

## The measurement this whole document is built on [M32]

On this machine, 2026-09-08, eight runs out of eight, with a remote configured and without:

```
git worktree remove <wt>        # <wt>/node_modules is a junction into <main>/node_modules
```

**deleted the contents of the main checkout's `node_modules`.** `git worktree remove` walks the tree it is
deleting, follows the junction, and removes what it points at. `--force` does the same. The recursive
delete does not know the difference between a directory and a link to one.

The same test, with the junction unlinked first, kept the main checkout intact. That arm is one run per
method, which is thin; the self-test re-asserts it on every run against a real junction:

```
rm "<wt>/node_modules"          # removes the LINK only, never what it points at (verified)
git worktree remove <wt>        # now there is no link to follow
```

So the rule is not "avoid `rmdir /S`". It is **unlink every reparse point inside a worktree before anything
recursively deletes that worktree**: `git worktree remove`, the harness's `ExitWorktree`, a hand-rolled
`rm -rf` or `rmdir /S` alike. A link left in place is a hole through which a delete reaches the rest of the
disk. `rmdir /S` is only the part that looks dangerous. `git worktree remove` looks safe and is not, while the
link is still there.

The link is followed at any depth, not only at the top of the tree. A junction at `<wt>/sub/node_modules`
is followed as readily as one beside it, which is why the unlink walks the whole tree.

## What the plugin will and will not delete

The closed list of what this plugin may delete, the path gate every deletion passes, and the places where
the guards stop are all in [`SAFETY.md`](SAFETY.md). This page is the procedure.

## Creation: when the chip did not give you one

A chip usually opens in a worktree the host made under `.claude/worktrees/`. When it opens in the main
checkout instead, the worker makes its own, once, and reuses it for every task:

```bash
sh "$f" worktree "$r" <chip> --create <base>
```

`base` is the `base:` of the worker's first task, the integration branch the coordinator merges into; each task
branch is cut from that task's own `base:`. Without one the command defaults to the main
checkout's current branch (`HEAD` when that is detached), which is not where the merges go unless that branch is
the integration branch. It
adds a detached worktree at `<main>/.claude/worktrees/fleet-<tag>-<chip>`, reusing the tree only when its
directory still exists (a deleted one is pruned from git's list and made again), excludes
`.claude/worktrees/` in the clone's `info/exclude` if nothing ignores it yet (creating `info/` and ending
the file with a newline first when it needs to), links every real `node_modules` up to three levels deep
in the main checkout into the same place (`apps/web/node_modules` counts; it never descends into a
`node_modules`; a junction on Windows, a symlink elsewhere; a link that fails is warned about, not
skipped silently), registers it, and prints the path on a `WORKTREE <path>` line. Each task then starts its
own branch inside it. A tree left detached on a commit some branch already holds is removable by `clean`;
one with commits nowhere else is kept.

Without this command a coordinator wrote its own setup into the run's rules on 2026-10-05: five trees at
`C:/wtRM01..05`, junctions made by hand, and registration refusing every one, so `clean` could remove none.

## Registration: the run knows its own worktrees

A worktree worker records its worktree the first time it claims (`--create` does this itself; the bare
command below is for a chip the host opened inside a worktree), so cleanup targets this run's worktrees
and no others - which matters because the machine runs several runs at once, and a blanket sweep of
`.claude/worktrees/` would take a live run's tree.

```bash
sh "$f" worktree .fleet/<run-id> <chip>      # writes .fleet/<run-id>/worktrees/<chip>: this cwd + its branch
```

Registration is also where a tree that could never be cleaned gets caught, at the one moment somebody can
still move it. It refuses a path that is relative, holds `..`, sits fewer than four levels below the root,
or is outside `.claude/worktrees/` - and it prints the `git worktree move` line that would fix it. A
worktree at `C:/wtmerge` is one slip from the drive root, so cleanup would refuse it forever and it would
accumulate instead. The gate is `unsafe_path()` and the reasoning is in [`SAFETY.md`](SAFETY.md).

`clean` acts only on what is registered: a run that recorded nothing is a run `clean` reports and does not
touch.

## `fleet.sh clean`: the safe removal

```bash
sh "$f" clean .fleet/<run-id>              # dry run: list what it WOULD do, change nothing
sh "$f" clean .fleet/<run-id> --remove     # do it
```

Dry run is the default because a destructive command whose first behaviour is to destroy is the wrong
shape. `--remove` is the only thing that deletes.

For every worktree the run registered, in order:

1. **The path gate, before anything reads the tree.** Absolute, no `..` and no `.` segment, not a network
   path, at least four levels below the root, inside `.claude/worktrees/` with something after it, and not
   a directory containing this shell's own working directory. Then it must appear in
   `git worktree list --porcelain`, and must not be locked. Anything else is skipped and named: the main
   checkout, a path already gone, a path too shallow to delete safely. [`SAFETY.md`](SAFETY.md) argues the
   division of labour between the depth floor and the containment test.
2. **Keep anything holding work.** A worktree with uncommitted changes, or whose branch holds commits
   that are neither in the main checkout's branch nor on that branch's upstream, is **kept** and reported.
   A worktree on a detached HEAD is kept unless some branch or remote already contains its commit (the
   shape `--create` leaves a tree in until its first task starts a branch): otherwise its commits belong
   to nothing, so nothing can speak for them. The whole point of a worktree is the work in it, and cleanup that loses it is worse than a full
   disk. `--remove` does not override this and no flag does: a tree the operator has written off is
   removed by the operator, in git, with the commands `clean` prints.
3. **Unlink reparse points first, at any depth.** `find -type l` finds junctions as well as symlinks and
   does not descend into them; each one is unlinked by `rm`, falling back to `rmdir` on Windows when the
   link persists. The link goes and what it points at stays. This is the step the measurement above is
   about, and `fleet.sh unlink <worktree-path>` is the same step as a command a worker can run.
4. **Remove the worktree.** `git worktree remove <path>`, never `--force`: a tree holding work was kept
   at step 2, so a refusal here is something this code did not anticipate. Then `git worktree prune` to
   clear any admin entry whose directory is already gone. A **locked** worktree is found at step 1 and
   skipped before anything is unlinked, so a refusal cannot leave the tree worse than it was found.
5. **Delete the branch, safely.** `git branch -d <branch>` - the lower-case, merge-checking form, which
   refuses a branch that is not merged and not pushed-with-upstream. Never `-D`. A branch `-d` refuses is
   reported and left, because it still holds something.

The branch is read from the worktree at that moment, never from the registration: a worker that switched
branches after registering would otherwise have the wrong branch checked and the wrong one deleted.

Everything `clean` skips is printed with the reason, so a run that leaves three worktrees behind says why
each one stayed, and the operator removes it by hand having seen the reason.

## Who runs it, and when

- **A live worker that finishes its brief** commits its slice on its own task branch (and pushes it where
  the project's rules allow), which is the isolation contract, then runs `sh "$f" unlink <its worktree>`,
  the path from its `worktrees/<chip>` registration, since its cwd may still be the main checkout, and
  leaves the tree for the planner's `clean`.
  `ExitWorktree` does nothing here: it acts only on a tree the same session made with `EnterWorktree`, and a
  chip's worktree was made by the host. It never runs a recursive delete on its own tree.
- **The planner, once the run has landed**, runs `fleet.sh clean .fleet/<run-id> --remove` as the last step of
  collection, after `FINISHED` is written and the findings are merged. A worktree removed before the run
  lands is a worktree whose findings might not have been filed yet.
- **The planner during a recovery**, in `fleet-resume`: a crashed run's dead workers left their worktrees
  behind, and `clean` removes them after the survivors have been reopened and the queue re-filed - never
  before, because a reopened worker returns to its worktree and a `clean` that ran first would have deleted
  the tree it works in.

## The generalisation off Windows

The junction is a Windows detail; the rule is not. A symlink inside a worktree on macOS or Linux is the
same hole, and `[ -L ]` detects both. The unlink-first step runs on every platform. What is
Windows-specific is only the fallback from `rm` to `rmdir` for a junction that coreutils will not unlink,
and it is a fallback, not the path.
