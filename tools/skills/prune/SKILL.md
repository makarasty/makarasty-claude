---
description: Moves local branches and worktrees left over after merges into an undoable local trash, and never touches GitHub or any remote. Use on "удали лишние ветки и worktree", "почисти ветки", "убери бесполезные деревья", "удали ветки после мержа", "prune merged branches". Not for machine-wide leftovers (processes, caches, scratch folders): that is /makarasty-tools:cleanup.
argument-hint: "[scan | list | restore <id> | empty <id> | --older 30d | --all]"
allowed-tools: Bash(node:*), Bash(git:*), Read
---

A script does every git step; the chat reads its output, asks about the doubtful items and reports.
Shell variables do not survive between calls: spell the full script path each time. Every command takes `--repo <dir>` (default: the current directory)
and `--json`.

What it promises, so the reply can say it plainly: it is local only. Nothing is pushed, fetched or deleted
on any remote, because other developers may still use those branches. A trashed branch keeps its commits
under `refs/makarasty-trash/`; a trashed worktree is moved, not deleted, into `<git dir>/makarasty-trash/`.
Each entry comes back with `restore <id>`, a week or a month later.

## Flow

1. `node "${CLAUDE_SKILL_DIR}/prune.mjs" scan`. Each candidate gets a verdict and a reason:
   - `trash`: a branch merged into the default branch (origin/HEAD, else main, else master) and checked out
     nowhere; a clean worktree on a merged commit; a worktree whose folder is already gone and whose commit
     is merged or on some branch, remote branch or tag.
   - `ask`: upstream gone with commits not in the default branch (the reason says when they look
     squash-merged); a worktree touched in the last 24 h or with a Claude chat active in it in the last
     2 h, since a chat may still use it; a branch made in the last 24 h; a worktree whose folder is gone
     and whose commit exists nowhere else (once trashed, a trash ref keeps that commit until `empty`).
   - `keep`: unique work; changed or untracked files, whatever `status.showUntrackedFiles` or a
     submodule's `ignore` says; files marked assume-unchanged or skip-worktree (an edit there does not
     show in `git status`); a worktree that holds another worktree inside it; a locked worktree; a branch
     checked out in a live one.
   Show the list in the person's language, one line per item, numbers and ids exactly as printed (`b:<branch>`,
   `w:<worktree>`); `keep` items have no number and cannot be chosen.
2. Skip the rest when they only asked to look ("покажи", "что можно удалить"). Nothing moves without the
   person's own answer, read by a script from this chat: not even `trash --safe`, and a bare "да" is no
   selection, and `#N` is not read: numbers only. Ask which numbers: one `AskUserQuestion`, options "Все" and "Ничего", numbers through Other
   (say in the question that "Все" includes the `ask` items, with their reasons).
3. `node "${CLAUDE_SKILL_DIR}/../lib/confirm.mjs" select prune-trash`. Exit 2: ask again with its reason.
   Show its restated block as printed, then one `AskUserQuestion` with one question per `ASK:` line, options
   exactly that label and "Нет" (the label alone: the grant needs one answer line equal to it, nothing added). Then `node "${CLAUDE_SKILL_DIR}/../lib/confirm.mjs" grant prune-trash`.
4. `node "${CLAUDE_SKILL_DIR}/prune.mjs" trash <id> <id> ...` with only the ids after `GRANTED:`; it refuses
   any other. Nothing granted: nothing more.
5. Report in a few lines: what went to the trash (branch name or worktree path, and its trash id), each
   `left in place` line with its reason, and the exact restore command with the real script path,
   `node "<path>/prune.mjs" restore <id>`. Say that nothing on the remote was touched, and that the trash
   stays until the person empties it; nothing empties it on its own.

A `left in place` worktree whose rename failed (`EBUSY`/`EPERM` on Windows) is held open by a process, a
shell, an editor or a dev server: name it; after it is closed, the same `trash` call moves it. Linux and
macOS would rename such a folder silently, so there `trash` first looks for a process whose working
directory is inside (`/proc`, else `lsof` when installed) and leaves the worktree in place with its pid.
`trash` also re-checks changes and nested worktrees at move time.

## Other commands

- `list` (this repo) or `list --all` (every repo on this machine that has trash).
- `restore <id>`: a branch whose name is taken now is refused; `--as <new name>` restores it beside. A
  worktree goes back to its old path, refused when that path exists, and brings its branch back with it.
- `empty <id> ... | --older 30d | --all`: deletes for good, only when the person asks, and only what they
  chose. A bare `empty` deletes nothing and names the three choices. A question like "а это почистить?" is
  not the choice. Run `list` (it prints the numbered list and writes the plan), then the same steps as in
  Flow 2-3 with `prune-empty` (the ASK labels say "навсегда"); `empty` refuses ids that were not granted. A `list --all` plan is for `empty --all` only, and a grant is for
  the repo it was made in (a trash id like `20261104-131209-1` can exist in two repos; `list --all` holds those).
- `restore` and `empty` act only on an index line whose ref is its own `refs/makarasty-trash/<id>/...`
  and whose paths are its own trash folder (and, for `from`, a folder outside the git dir). Any other line
  is refused with its line number in `index.jsonl` and left as it is.

## Why not plain git

This replaces `git worktree remove` and `git branch -D`. `git worktree remove` follows a `node_modules`
junction and empties the main checkout's `node_modules` (docs/MEASUREMENTS.md M32, M45), which is why the
git guard refuses it. The script moves a worktree by rename, never by copy, and `empty` unlinks every
junction and symlink inside before it deletes the folder. A branch is deleted only after its trash ref is
verified, and only at the tip the scan saw.

## Done when

The `trash` items and the chosen `ask` items are in the trash or reported as left in place with a reason,
the person has the restore command for each, and a second `scan` shows no `trash` item beyond those.
