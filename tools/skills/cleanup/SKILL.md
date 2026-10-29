---
description: Finds what this computer holds for nobody - ended chats' processes and scratch, stale worktrees, caches, old app versions, unused games, big files - and removes what the person picks. Use on "почисти за собой", "убери за собой", "почисти комп", "найди мусор", "что жрёт диск", "мало места на диске", "освободи место", "что жрёт память", "найди утечки", "убери хвосты", "почему тормозит комп", "free up disk space". Not for secrets in chats (scrub) or app updates (update).
argument-hint: "[processes | disk | all | deep]"
allowed-tools: Bash, PowerShell, Read, Grep, Glob, Agent, Skill, ToolSearch, SendMessage, TaskStop, mcp__Claude_Browser__preview_stop, mcp__Claude_Browser__tabs_close
---

Find what this machine holds that nobody uses any more. The output is a short list with sizes, and the
operator decides what goes.

The disk part is a script with a catalog of places: `node "${CLAUDE_SKILL_DIR}/machine.mjs"` (that path is
filled in when this skill loads; type it as shown in each call, since a shell variable set in one call is
gone in the next), rules in
`rules.json` beside it, this machine's own rules in `~/.claude/makarasty/cleanup-rules.json` on top. The
script measures, checks live chats and running programs, and acts only on the ids picked; the chat explains,
asks and reports. Reasoning each run from scratch was tried: a judge overruled cheap scouts on 13 of the 14
places they disagreed on, so a place enters the catalog only with its evidence (step 5).

The argument picks the areas: `processes` is call 1 below, `disk` is calls 2 and 3 (with call 1's junction
line), `all` is every call, `deep` is step 5. With no argument the words decide: disk space ("мало
места", "что жрёт диск", "освободи место") is `disk`, memory or slowness is `processes`, "почисти комп" is
`all`.

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
- Families the census may not name, found by command line, each older than ten minutes: headless Chrome or
  Chromium whose command line carries a playwright or puppeteer profile dir (`ms-playwright`,
  `playwright_chromiumdev_profile`, `puppeteer_dev_chrome_profile`; headed Chrome is out of scope); `npx ...
  mcp-*` and other MCP servers started by ended chats; `claude ... --output-format stream-json`, listed only
  when no live session matches it (SDK, IDE and live sessions run that way too). Keep-list: a process whose
  ancestor chain reaches a live `claude` or `Claude.exe`, an interactive shell or terminal, or an IDE
  (Cursor, VS Code) is its owner's, not a leak. A parent counts only if it was created before the child
  (PIDs get reused). No `PPID=1` orphan test: Git Bash breaks parent links on Windows.
- Top ten: `Get-CimInstance Win32_Process | Sort WorkingSetSize -Desc | Select -First 10
  ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine`, each with its parent chain, so a server the
  operator started from their terminal reads as theirs.
- Junctions: `cmd /c dir /AL /S /B` over each repo's `.claude\worktrees`.

**Call 2, Bash**: worktrees. Per repo `git worktree list --porcelain`, marking `prunable` ones and trees
merged into `origin/HEAD` (not into whatever the main checkout is on), with unpushed commits or uncommitted
files named; folders under `<repo>/.claude/worktrees/` that git does not list; a worktree living inside a
session's scratch folder.

**Call 3, Bash, in the background**: `node "${CLAUDE_SKILL_DIR}/machine.mjs" scan` (about a minute; read
only; a 10-minute timeout; wait for it before the report). A timeout or empty output is reported as it is,
not retried. A non-zero exit prints why: the process list could not be read, PowerShell is in Constrained
Language Mode, another apply holds the lock, or a rules file is malformed (its path and rule are named).
For the operator's own `cleanup-rules.json`: say so, and on their yes run again with `--rules` pointing at a
file in the scratch folder that holds `{"rules": []}`, written with Bash, while they fix theirs; that file
stands in for theirs, so pass the same `--rules` to `apply` and `admin`, and their switched-off rules come
back for that run. The shipped `rules.json`: report it
and stop, since without it there is no catalog. An item `HELD: rule failed: ...` is reported as it stands.
One block per tier:

- `safe`: caches that refill, scratch of ended chats, old app versions beside the one in use, temp untouched
  for 2 days. On a yes they are deleted for good, by the tool's own command where it has one; the worst case
  is a download, a rebuild or an ended chat's task output, named in each item's `lose:` line.
- `close-app`: the same kind, but an app writes there; `HELD: <app> is running` until the operator closes it.
- `admin`: needs an elevated shell; the agent never runs these.
- `owner`: games, programs, big personal files, build output of repos with no commit for 30 days, the Recycle
  Bin, transcripts. Never a default pick. Build output is here because the script cannot see a server started
  with a relative path (`node dist/x.js`), so it cannot hold that output for it.

Each item has an id, size, age of its newest file, the method, the path, its evidence and what is lost.
`held, nothing to do now` lists what a live chat or a running program holds. `scan --json` prints the full
record. Its own rule for sizes: links are never followed (`du -sk` and `Get-ChildItem -Recurse` disagree
because PowerShell 5.1 follows junctions and counts a main `node_modules` once per tree). Items marked
`[none]` are steps only the operator can take (in an app, in Explorer): give them as steps, never pass them
to `apply`, which answers `skipped ... yours to do` and exits 1.

Linux and macOS: the shipped rules are Windows-only for now (each has `os`); there only build output is
acted on, loose files (files lying beside the repos, outside any of them) are listed, and scratch (`$TMPDIR/claude/<project>/<uuid>/`, not live, over a day
old) and package caches (each tool's own clean command) are found by hand.

Done when each area has a list or says "nothing found".

## 2. Picks

Per item: what it is, size or memory, age, why it is nobody's, the command, and what breaks if that is
wrong. Rank by what it frees. Hundreds of folders of one kind are one pick with one generated command.
Commands that remove folders are `rm -rf` in Git Bash or `cmd /c rmdir /s /q`, never `Remove-Item -Recurse`,
which follows a junction into its target. Caches are cleaned by their own tool (`npm cache clean --force`,
`pip cache purge`, `uv cache clean`, `bun pm cache rm`). A stale worktree or merged branch of a repo is one pick whose command is `/makarasty-tools:prune`, run
only on the yes: it moves them to an undoable local trash and never follows a junction. A fleet run's own
worktree is removed through its run's `fleet.sh clean`.

Disk items from the scan are picks as they stand: the script already measured them and holds what is in
use, so their command is their script id. Group them the way the operator thinks: one line per `safe` and
`close-app` item, one per `owner` item, and `admin` items in a block of their own. Keep each number's id
beside it on the line, since `apply` takes ids. "Всё безопасное" means every `safe` id; HELD ones are
skipped by the script with their reason. An `owner` item is a pick only when the operator names it.

## 3. Challenge

One `Agent` (`subagent_type: general-purpose`, `model: opus`, in the foreground), given the picks as a file
path, told: read only - end nothing, delete nothing, write nothing; defend each item against removal - a live
chat still uses it (Git Bash breaks parent links, so a live chat's `cmd &` can look orphaned), the operator's
own server or emulator, an MCP server or browser a live `claude`, terminal or IDE owns, a live fleet's worktree, unpushed commits, a cache a running build fills, a temp file
being written now; return `remove`, `keep` or `ask` per item with its evidence. Where it is wrong, answer
once with `SendMessage`. Scan items from the catalog skip this step: their evidence is the rule's, checked
again by the script at the moment it acts. Picks the chat found by hand do not.

## 4. Report, then act on a yes

Plain text in the chat, in the operator's language; the totals count only the hand-found picks the
challenge marked `remove` and the scan's `safe` and `close-app` items that are not HELD, never `owner` ones:

```
Frees about <N> GB RAM / <M> GB disk.
Processes:
1. pid <n> <what> - <MB>, <age> - <why it is nobody's>
Disk:
2. <what, in plain words> - <GB> - <why it is nobody's; what is lost> - <how>  [<scan id or command>]
Close first: <n>. <what> - close <app> - <how>  [<id>]
Admin (.bat): <n>. <what> - <GB or "size unknown without admin">  [<id>]
Yours to decide: <n>. <game, program or file> - <GB> - <last used, or "unknown"> - <how>  [<id>]
Held now: <what> - <the chat or program holding it>
Ask: <item> - <question>
Kept until the fleet ends: <item> - <why>
Undo: what went to the Recycle Bin comes back from it; what was deleted does not. Log: ~/.claude/makarasty/cleanup-log.jsonl
```

The labels and every line are in the operator's language, the rule titles turned into plain words (no
`vendor`, `scratch`, `close-app`, no method tags); only the id in brackets stays as printed. `<how>` is one of:
deleted for good, to the Recycle Bin, its uninstaller opens (one window per program), by hand. A null size
is "size unknown", never counted. `Yours to decide` shows the ten largest; the rest come on "покажи все".
The Recycle Bin line says not to empty it until the operator has checked what this run moved there.

Ask once which numbers to act on. Processes on a yes: `CLOSED CHAT` and `ORPHANED RUN` census lines through
the census again with `--leftovers --kill --pid <the chosen pids, comma-separated>`, which ends only those
trees, children first - when that census file contains `--pid` (makarasty 1.5.14 and later; an older one
ignores the filter and ends every eligible line, so then go pid by pid as below). Every other chosen process - a `CLOSED CHAT SERVING` line the operator named, a line
the census left alone, a pid found by hand - is ended pid by pid with `taskkill /PID <n> /F`, children first,
never `/T`, which follows reused pids. Then list again.
Files found by hand are the operator's to delete: print the commands for the chosen items.

Scan items on a yes, by id. A group item (scratch, temp, crash dumps) is whatever matches when `apply`
runs, so when more than an hour has passed since the scan, scan again and show what changed before acting.

- `node "${CLAUDE_SKILL_DIR}/machine.mjs" apply <id> ...`: looks again first, then per method: `delete` for
  good (caches, old versions, scratch), `vendor` through the tool's own command (`npm cache clean --force`),
  `recycle` to the Recycle Bin only when it fits the bin's free room (the bin holds about 10% of a drive; an
  item that does not fit is kept and says so), `uninstall` opens the program's own uninstaller or
  `steam://uninstall` for the operator to confirm there (0 GB freed until they do; scan again after). It
  prints per id `deleted`, `recycled`, `opened`, `partly left` (files in use), `unchanged` or `skipped` with
  the reason, and the freed size from a measurement after the act (what went to the Recycle Bin is counted
  apart: it still takes the disk until the bin is emptied), plus each drive's free space before and after;
  it exits 1 when any id was skipped, unchanged or `error` (its note says why). Report those numbers, not the
  scan's, and each skipped id with its reason; do not retry it in the same turn. What went to the Recycle Bin
  frees the disk only when the bin is emptied: say that beside its size. A crash midway still leaves the log
  of every id done.
- `admin` items: `node "${CLAUDE_SKILL_DIR}/machine.mjs" admin <id> ...` writes
  `~/.claude/makarasty/cleanup-admin.bat` (a HELD item is left out and named; ids under `not admin items or
  not found` go back to the operator by name). Admin ids never go to `apply`. The operator right-clicks it,
  Run as administrator. Before they do, say in their language what Windows will show: the UAC prompt (yes =
  this file may change system folders), then each step's own line the file echoes (from the rule's
  `explain`). Never run it yourself.
- Every outcome is in `~/.claude/makarasty/cleanup-log.jsonl`: what went, how big, and how: `recycled` comes
  back from the Recycle Bin, `deleted` does not.

Done when the chosen processes are gone, confirmed by a second listing, every chosen scan id has its
outcome from `apply` or a written `.bat`, and the operator has the commands for the rest.

## 5. New places (`deep`)

The catalog only knows places it was taught. When the operator asks for a deep look ("найди мусор везде",
`deep`), or the scan finds under 1 GB outside the owner tier while a drive is over 90% full, first save `scan --json` to a file in the
scratch folder, then follow `deep-scan.md` beside this file: cheap scouts per area, one strong judge, and a
place the judge confirms becomes a rule in `~/.claude/makarasty/cleanup-rules.json`, so the next ordinary
scan finds it in a minute.
