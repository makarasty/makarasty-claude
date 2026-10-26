---
description: Moves local branches and worktrees left over after merges into an undoable local trash, and never touches GitHub or any remote. Use on "удали лишние ветки и worktree", "почисти ветки", "убери бесполезные деревья", "удали ветки после мержа", "prune merged branches". Not for machine-wide leftovers (processes, caches, scratch folders): that is /makarasty-tools:cleanup.
argument-hint: "[scan | list | restore <id> | empty <id> | --older 30d | --all]"
allowed-tools: Bash(node:*), Bash(git:*), Read
---

A script does every git step; the chat reads its output, asks about the doubtful items and reports.
`P="${CLAUDE_SKILL_DIR}/prune.mjs"`. Every command takes `--repo <dir>` (default: the current directory)
and `--json`.

What it promises, so the reply can say it plainly: it is local only. Nothing is pushed, fetched or deleted
on any remote, because other developers may still use those branches. A trashed branch keeps its commits
under `refs/makarasty-trash/`; a trashed worktree is moved, not deleted, into `<git dir>/makarasty-trash/`.
Each entry comes back with `restore <id>`, a week or a month later.

## Flow

1. `node "$P" scan`. Each candidate gets a verdict and a reason:
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
   Show the list in the person's language, one line per item, ids exactly as printed (`b:<branch>`,
   `w:<worktree>`).
2. `node "$P" trash --safe`, with no question first: it is local and undoable, and the person asked for
   the cleanup. Skip this step when they only asked to look ("покажи", "что можно удалить").
3. The `ask` items go in one `AskUserQuestion` call, `multiSelect: true`, one option per item with its reason
   as the description (four options per question; more items, more questions in the same call). Then
   `node "$P" trash <id> <id> ...` for the chosen ones. Nothing chosen: nothing more.
4. Report in a few lines: what went to the trash (branch name or worktree path, and its trash id), each
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
  chose. A bare `empty` deletes nothing and names the three choices.
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
