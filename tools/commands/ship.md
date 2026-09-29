---
description: Ship the working tree - merge the named branches in and resolve conflicts, split all changes into separate commits under the user's own name, push, optionally tag with patch notes. Use for "commit everything as separate commits and push", "pull all branches into mine and fix conflicts", "tag a release with patch notes", or in Russian закоммить всё отдельными коммитами и запушь, влей все ветки в мою.
argument-hint: [branch ... | all] [tag <name>] [notes]
allowed-tools: Bash, Read, Grep, Glob, Edit
---

Ship means: the user's work committed as separate commits under their own name, the requested branches
merged in, everything pushed. Every commit follows `${CLAUDE_PLUGIN_ROOT}/commands/commit.md`: read it
once before the first commit and apply its message, identity, hook and attribution-check rules to each commit.

Arguments: branch names (or `all`) to merge; `tag <name>` to tag the result; `notes` for patch notes
without a tag. Nothing given: commit and push only.

The guardrails hold for every step: pushes are fast-forward only (never `--force`, `--force-with-lease`
or `+refspec`), and every hook runs (never `--no-verify`).

## 1. Commit the tree

1. `git status --short`, `git diff --stat`, `git log --oneline -8`.
2. Group the changed and untracked files by intent: one logical change per commit (a fix, a feature, a
   doc update, a dependency bump). Order the groups so each commit leaves the tree working.
3. For each group: `git add -- <paths>`, then commit per commit.md. A file that mixes two intents goes
   with its dominant one; say which in the reply.

Done when `git status --short` prints nothing.

## 2. Merge the branches

Only when branches were named. `git fetch --all --prune` first. `all` means every branch in
`git branch -r --no-merged HEAD` except `origin/HEAD`; name them in one line before merging.

For each branch, `git merge <remote>/<branch>`. On a conflict, per file:

1. Read three versions: base `git show :1:<path>`, ours `:2:<path>`, theirs `:3:<path>`, and what each side
   meant: `git log --oneline HEAD...MERGE_HEAD -- <path>`.
2. Write a resolution that keeps both sides' intent: both fixes, both new entries, the rename applied to
   the other side's new code.
3. When the intents contradict each other (one side deletes what the other changes, two different values
   for the same setting, two rewrites of the same logic), stop: show both sides in a few lines and ask
   which wins. Leave the merge in progress.
4. Run the narrowest check that covers the file (its test, or a typecheck of its project), respecting the
   machine's verify budget.

Then `git add -- <paths>` and `git commit --no-edit`. Done when `git diff --check` is clean and
`git grep -nE '^(<<<<<<<|>>>>>>>)'` finds nothing.

## 3. Push

`git push` (with `-u origin <branch>` when there is no upstream). A rejection because the remote moved:
`git pull --no-rebase`, resolve as in step 2, push again. Done when `git status -sb` shows neither
`ahead` nor `behind`.

## 4. Tag and patch notes

Only with `tag <name>` or `notes`.

- Range: `git log <last tag>..HEAD --no-merges --format=%s` (`git describe --tags --abbrev=0` gives the
  last tag; none means the whole history).
- Notes: a few lines grouped as new / fixed / other, each a plain sentence a user of the software would
  understand, no commit prefixes or hashes. Write them in Russian when the user writes in Russian.
- `tag <name>`: `git tag -a <name> -F -` with the notes as the message, then `git push origin <name>`.

## Done when

The tree is clean, the branch is level with its remote, and the tag, if asked for, is on the remote. The
reply lists the commit subjects, the branches merged, each conflict with its resolution in one line, and
the notes if made.
