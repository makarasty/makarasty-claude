---
description: Finds what this computer is carrying for nobody - processes ended chats left running (wake loops, servers, test runs, finds), runaway logs and scratch folders of ended sessions, stale git worktrees, package caches - sizes each, has a red team challenge every pick, and ends with a short plain report. Ends processes only on a yes; files it never deletes itself, it gives the commands. "Почисти за собой" stops only what this chat started. Use on "почисти за собой", "убери за собой", "почисти комп", "найди утечки", "что жрёт память", "что жрёт диск", "убери хвосты", "почему тормозит комп", "clean up after yourself", "clean up the machine", "find leaks".
argument-hint: "[processes | disk | all]"
allowed-tools: Bash, PowerShell, Read, Grep, Glob, Agent, ToolSearch, SendMessage, TaskStop, mcp__Claude_Browser__preview_stop, mcp__Claude_Browser__tabs_close
---

Find what this machine holds that nobody uses any more. The output is a short list with sizes, and the
operator decides what goes.

## 0. "After yourself": only this chat's own

When the request is about this chat ("почисти за собой", "убери за собой", "clean up after yourself"), the
scope is what this session started, and nothing else on the machine:

1. `TaskStop` every background task of this session still running (shells, Monitors, servers, watches),
   except one the operator asked to keep.
2. `preview_stop` every preview server it started, and close its browser tabs.
3. Processes whose command line carries this session's id or its shell snapshot: end those exact pids,
   children first.
4. Its own scratch folder: name it and its size; deleting it is the operator's call.

No red team here: the operator asked, and nothing outside this session is touched. Report in two or three
lines what was stopped and what is left. Done when a second listing shows nothing of this session running
that the operator did not ask to keep.

## 1. Inventory, read only, in about three calls

**Live first.** A session is live when `~/.claude/sessions/<pid>.json` exists and that pid is running; read
only its `sessionId`, `pid` and `cwd` (`node -e` printing those fields). A fleet run is live when its
coordinator session is live or its `watch.sh` runs: its worktrees (`.fleet/<run>/worktrees`), dev servers
and watch are never picks, and package caches wait until it ends. The repositories to look at are the
parents of the live sessions' `cwd`s and the git repos one level below them.

**Call 1**: the census in Bash, then the top ten memory users and the junctions in PowerShell.

- Census (Bash): `node "$(ls -d ~/.claude/plugins/cache/makarasty/makarasty/*/ | sort -V | tail -1)scripts/fleet-load.mjs" --leftovers`
  (never `--kill` here). Without it, or with a census older than 1.5.14 (its file has no `--pid`, and it does
  not know chat shells), also list by hand: only bash, sh, cmd, powershell, node or python processes at least ten
  minutes old, whose parent is gone or younger than them, whose command line carries `.claude/shell-snapshots`
  or `Temp/claude/<project>/<uuid>/` of a session that is not live, and that point into no live fleet run.
- Top ten: `Get-CimInstance Win32_Process | Sort WorkingSetSize -Desc | Select -First 10
  ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine`, each with its parent chain, so a server the
  operator started from their terminal reads as theirs.
- Junctions: `cmd /c dir /AL /S /B` over each repo's `.claude\worktrees`.

**Call 2, Bash**: worktrees. Per repo `git worktree list --porcelain`, marking `prunable` ones and trees
merged into `origin/HEAD` (not into whatever the main checkout is on), with unpushed commits or uncommitted
files named; folders under `<repo>/.claude/worktrees/` that git does not list; a worktree living inside a
session's scratch folder.

**Call 3, Bash, in the background**: sizes with one `du -sk` over all paths (it does not follow junctions;
`Get-ChildItem -Recurse` in Windows PowerShell 5.1 does, and counts the main `node_modules` once per tree).

- Scratch: only `<temp>/claude/C--*/<uuid>/`. Everything else under `claude/` (`bundled-skills/<version>`,
  test folders) is Claude Code's own and never a pick. A folder is a pick when its uuid is not live and its
  newest file is over a day old; name its largest file - usually one `tasks/*.output` a runaway background
  command filled.
- Caches: npm (`npm config get cache`), pip `%LOCALAPPDATA%\pip\Cache`, uv `%LOCALAPPDATA%\uv\cache`, cargo
  `~/.cargo/{registry,git}`, gradle `~/.gradle/caches`, maven `~/.m2/repository`, bun `~/.bun/install/cache`,
  and the temp directory's largest top-level entries. Skip anything whose newest file is under an hour old.

Done when each area has a list or says "nothing found".

## 2. Picks

Per item: what it is, size or memory, age, why it is nobody's, the command, and what breaks if that is
wrong. Rank by what it frees. Hundreds of folders of one kind are one pick with one generated command.
Commands that remove folders are `rm -rf` in Git Bash or `cmd /c rmdir /s /q`, never `Remove-Item -Recurse`,
which follows a junction into its target. Caches are cleaned by their own tool (`npm cache clean --force`,
`pip cache purge`, `uv cache clean`, `bun pm cache rm`). A worktree is removed through its run's `fleet.sh
clean`, or after its `node_modules` junctions are unlinked: `git worktree remove` with a junction in place
followed it and emptied the main checkout's `node_modules` seven times out of seven. When `git worktree
remove --force` stops on "Filename too long", `rm -rf` the folder, then `git worktree prune`.

## 3. Red team

One `Agent` (`subagent_type: general-purpose`, `model: opus`, in the foreground), given the picks as a file
path, told: read only - end nothing, delete nothing, write nothing; defend each item against removal - a live
chat still uses it (Git Bash breaks parent links, so a live chat's `cmd &` can look orphaned), the operator's
own server or emulator, a live fleet's worktree, unpushed commits, a cache a running build fills, a temp file
being written now; return `remove`, `keep` or `ask` per item with its evidence. Where it is wrong, answer
once with `SendMessage`.

## 4. Report, then act on a yes

Plain text in the chat, in the operator's language; the totals count only `remove` items:

```
Frees about <N> GB RAM / <M> GB disk.
Processes:
1. pid <n> <what> - <MB>, <age> - <why it is nobody's>
Disk:
2. <path> - <GB> - <why>  | <command>
Ask: <item> - <question>
Kept until the fleet ends: <item> - <why>
```

Ask once which numbers to act on. Processes on a yes: `CLOSED CHAT` and `ORPHANED RUN` census lines through
the census again with `--leftovers --kill --pid <the chosen pids, comma-separated>`, which ends only those
trees, children first - when that census file contains `--pid` (makarasty 1.5.14 and later; an older one
ignores the filter and ends every eligible line, so then go pid by pid as below). Every other chosen process - a `CLOSED CHAT SERVING` line the operator named, a line
the census left alone, a pid found by hand - is ended pid by pid with `taskkill /PID <n> /F`, children first,
never `/T`, which follows reused pids. Then list again.
Files are the operator's to delete: print the commands for the chosen items.

Done when the chosen processes are gone, confirmed by a second listing, and the operator has the commands
for the rest.
