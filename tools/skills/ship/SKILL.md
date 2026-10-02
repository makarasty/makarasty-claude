---
description: Ships the working tree - splits all changes into separate commits under the user's own name, merges the named branches in and resolves conflicts, pushes, optionally tags with patch notes. Use for "commit everything as separate commits and push", "pull all branches into mine and fix conflicts", "tag a release with patch notes", or in Russian закоммить от моего имени отдельными коммитами и запушь, стяни все ветки, смержи, подтяни, слей, влей все ветки в мою, учти параллельную работу, закоммить только своё, запушь, залей. A single commit with no push is the commit command.
argument-hint: [branch ... | all] [mine] [tag [<name>]] [notes]
allowed-tools: Bash(git:*), Bash(gh:*), Read, Grep, Glob, Edit, Agent, ToolSearch, mcp__ccd_session_mgmt__list_sessions, mcp__ccd_session_mgmt__list_events
---

Ship means: the user's work committed as separate commits under their own name, the requested branches
merged in, everything pushed. Before the first commit, Read `${CLAUDE_PLUGIN_ROOT}/skills/commit/SKILL.md`
and apply all of it to every commit: the state check, committing by path in the shared index, the
message, identity and hook rules, and the check and amend rule for the commit just made.

**Arguments.** `all`, `mine`, `tag`, `tag <name>` and `notes` are keywords only as separate words; every
other word is a branch, with a remote prefix (`origin/x`, any name `git remote` lists) stripped. A word
that is both a keyword and an existing branch: ask which. Nothing given: commit and push. A request that
only says to push ("запушь", "залей") skips step 1 unless the uncommitted files are this chat's own.

**Guardrails.** Pushes are fast-forward only (never `--force`, `--force-with-lease` or `+refspec`) and every
hook runs (never `--no-verify`). Other chats' uncommitted work lives in this checkout, so never
`git stash`, `git reset --hard`, `git clean`, `git checkout -- .`/`git restore .`, `git tag -f` or
`git tag -d` here, and never `git worktree remove`: it once followed a `node_modules` junction and
emptied the main checkout. A step that seems to need one of them stops and asks.

The state as this command was invoked, so the first look costs no tool calls:

!`git status --short --branch || true`

!`git branch -vv --no-color || true`

!`git remote -v || true`

!`git log --oneline -5 || true`

## 0. Other chats in this checkout

A file another chat is halfway through is not this commit's to make. The session tools are often
deferred: load them with ToolSearch `select:mcp__ccd_session_mgmt__list_sessions,mcp__ccd_session_mgmt__list_events`,
and use the fallback below only when that finds nothing. `list_sessions` with `limit: 50`, kept to the
ones whose `cwd` is this checkout and that were active in the last day. Give those to one `Agent` with
`model: "sonnet"`: it reads each one's last 20 events with `list_events` and returns one line per chat -
the files it edited, and whether its last turn reported the work complete.

- A chat is finished only when it is not running and its last turn reported completion. One that stopped
  on a question or mid-task is in progress.
- A file a chat in progress is editing stays out of every commit; name it and the chat in the reply.
- A finished chat's files are committed, and its history is the best source for their commit messages.
- With `mine`, commit only the files this chat changed; everything else is named and left.

Without the session tools, a changed file this chat cannot explain is asked about once, all such files
in one question.

## 1. Commit the tree

1. `git status`, `git diff --stat`, `git log --oneline -8`. A detached `HEAD` stops everything: name the
   sha from `git rev-parse --short HEAD`, push nothing, ask which branch.
2. Leave out, and name in the reply:
   - a file in HEAD (`git cat-file -e HEAD:<file>` exits 0) whose `git diff HEAD --ignore-cr-at-eol
     --quiet -- <file>` also exits 0: only its line endings changed, an editor's doing, not a change.
     Untracked files are never skipped this way (the diff is empty for them too);
   - a submodule (mode `160000` in `git ls-files -s -- <path>`) whose new commit is on no remote branch
     (`git -C <path> branch -r --contains HEAD` prints nothing): the pointer would name a commit nobody
     else can fetch.
3. Group the rest by intent: one logical change per commit (a fix, a feature, a doc update, a dependency
   bump), ordered so each commit leaves the tree working. A file that mixes two intents goes with its
   dominant one; say which in the reply.
4. Commit each group per commit.md, by path.

Done when `git status --short` shows only the files step 0 and this step left out.

## 2. Merge the branches

Only when branches were named or `all` was given. `git fetch --all --prune` first.

**Candidates.** Each named branch: its remote one when it exists, plus the local one when that has
commits the remote lacks (`git log --oneline origin/<b>..<b>`). With `all`: `git branch --no-merged HEAD
--format='%(refname)'` and the same with `-r`, dropping `refs/remotes/*/HEAD` (the short form prints it
as a bare `origin`) and this branch's own upstream (step 4 pulls that), then shortened; a local branch
and its remote twin count once, as above.

**Preview each one** without touching the tree:

- `git merge-tree --write-tree --name-only HEAD <b>` (git 2.38 or newer). The first line is the tree the
  merge would make: equal to `git rev-parse HEAD^{tree}` means the branch adds nothing (merged,
  squash-merged or cherry-picked already), so skip it. `git cherry` and `--no-merged` both miss squash
  merges. The lines after it, up to a blank line, are the files that would conflict.
- `git shortlog -sne HEAD..<b>` for who wrote it.

List the candidates in one line each: branch, authors, commits, conflicting files. Branches the user
named, or `all` covered, go ahead. Ask once, all together, only about a branch found by `all` that holds
another author's commits (`--no-merged` also lists other developers' work in progress), and about any
branch that would conflict in more than ten files.

**Before each merge** `git diff --cached --name-only` must print nothing, and no dirty file may be one
the branch changes (`git diff --name-only HEAD...<b>` against `git status --short`); git refuses the
merge otherwise. Those files are another chat's: stop and name them. Do not stash or commit them.

Note the pre-merge sha (`git rev-parse HEAD`), then `git merge --no-edit <b>`. On a conflict, per file:

1. `git ls-files -u -- <path>` lists the stages present: 1 base, 2 ours, 3 theirs. With all three, read
   them (`git show :1:<path>`, `:2:`, `:3:`) and what each side meant:
   `git log --oneline HEAD...MERGE_HEAD -- <path>`. A missing stage is add/add or modify/delete; those,
   binary files, LFS pointers and submodules are decisions, not text edits: ask.
2. Write a resolution that keeps both sides' intent: both fixes, both new entries, the rename applied to
   the other side's new code.
3. Intents that contradict (one side deletes what the other changes, two values for one setting, two
   rewrites of the same logic), or more conflicted files than previewed: ask.
4. Run the narrowest check that covers the file (its test, or a typecheck of its project), respecting the
   machine's verify budget.

**Asking during a merge**: `git merge --abort` first, then show both sides in a few lines and ask. A merge
left open while waiting gets finished by the next commit any other chat makes in this checkout. After
the answer, merge again and apply it.

Then `git add -- <resolved paths>` and `git commit --no-edit`. A merge commit cannot be limited to paths,
so `git diff --cached --name-only` must hold only files the merge brought in; anything else is another
chat's, staged meanwhile: stop and ask. Done when `git diff --check <pre-merge sha> HEAD` is clean and
`git grep -nE '^(<<<<<<<|>>>>>>>)( |$)' -- <conflicted paths>` finds nothing.

## 3. Patch notes and update log

Only with `tag` or `notes`. This comes before the push, so the log entry travels with it and the tree is
clean after.

- Tag name: `tag <name>` as given. `tag` alone: take `git describe --tags --abbrev=0`, bump its last
  number, and ask. A name that `git rev-parse -q --verify refs/tags/<name>` already resolves: stop and ask.
- Range: `git log <last tag>..HEAD --no-merges --format='%an%x09%s'`; no tag means the whole history.
  Commits by other authors stay out unless the user asks: the notes are about this user's work.
- Format: when the repository has its own release how-to or update log (`git ls-files` names something
  like release, changelog or update log), follow it, and read the last two entries so the new one
  repeats neither their wording nor their items. Write the entry and commit it per commit.md.
- Notes: a few lines grouped as new / fixed / other, each a plain sentence a user of the software would
  understand, no commit prefixes or hashes. In Russian when the user writes in Russian.

## 4. Push

A request that said to push settles it, on the default branch too, and so does invoking ship with no
arguments, whose whole meaning is commit and push. Without either, ask once before the
first push to the default branch (commit.md says how to find it). Then `git push`, or `git push -u origin
<branch>` when there is no upstream. Read the output:

- `! [rejected] ... (fetch first)` or `(non-fast-forward)`: the remote moved. `git fetch`, step 2's
  check with `@{u}` as the branch, `git merge --no-edit @{u}`, resolve as in step 2, push again. Twice at
  most; a third rejection: stop and report.
- `! [remote rejected]`, `pre-receive hook declined`, `GH006` or "protected branch": the server will not
  take this branch, and pulling changes nothing. Stop and offer to push a branch and open a PR
  (`gh pr create`).
- `fatal: No configured push destination` (`git remote` prints nothing): everything stays committed and
  merged locally; the reply says "not pushed: no remote", and that is done.
- Anything else: stop and quote the line.

Done when `git status -sb` shows neither `ahead` nor `behind`.

## 5. Tag

Only with `tag`, after the push: `git tag -a <name> -F -` with the notes as the message, then
`git push origin <name>`.

## Done when

The tree is clean apart from the files named as left out, the branch is level with its remote (or the
reply says why not), and the tag, if asked for, is on the remote. The reply lists the commit subjects,
the branches merged and skipped, each conflict with its resolution in one line, and the notes if made.
