---
description: Finds what on this computer is out of date and worth updating - apps, runtimes, CLIs, Claude Code and its plugins, other agents like Codex, drivers, and anything an earlier `game` run installed - ranks it by what the update fixes and how much the item is used, has a red team challenge each pick, and ends with a short plain report. Updates nothing without a yes per item. Use on "обнови всё", "обнови всё что устарело", "что можно обновить", "что устарело", "проверь обновления", "старая версия", "update everything", "what is outdated", "check for updates".
argument-hint: "[apps | dev | claude | drivers | all]"
allowed-tools: Bash, PowerShell, Read, Grep, Glob, Agent, ToolSearch, WebSearch, WebFetch, SendMessage, Write
---

Find what is out of date on this machine and which updates are worth doing. The output is a short ranked
list, and the operator decides what to update.

The area in `$ARGUMENTS` picks the sources: `apps` the package managers, `dev` developer tools and their pins,
`claude` Claude Code, its plugins and other agent CLIs, `drivers` the drivers; `all` or nothing, everything.

## 1. Inventory, read only, in one script

Start with `[Console]::OutputEncoding=[Text.Encoding]::UTF8` in PowerShell. Skip a source whose tool is
missing and name it once.

- **Package managers**: `winget upgrade --include-unknown --disable-interactivity` (parse by the dash line's
  column offsets: headers are localised and long names cut); `scoop status *>&1` - when it warns its buckets
  are stale, report scoop as "not checked: buckets stale" and run no `scoop update`, which writes;
  `choco outdated`, `brew outdated`, `apt list --upgradable`.
- **Developer tools**: `node -v`, `npm outdated -g`, `python -m pip list --outdated --not-required
  --format=json --disable-pip-version-check` for the user's own interpreters, `rustup check`, `go version`,
  every Java (`where.exe java`, the launchers' runtimes, `cmd /c "java -version 2>&1"`), `git --version`, and
  hand-managed installs (a `.tools` folder, `D:\java`).
- **Pins**: `package.json` engines and `.nvmrc`, `go.mod`'s go line, `pyvenv.cfg` of known venvs, a
  launcher's Java path, IDE SDK paths, the version an installed skill is tied to.
- **Claude**: every copy - `claude --version` on PATH and `Get-Process claude | Select Path` (desktop profiles
  run their own) - against `npm view @anthropic-ai/claude-code version`; `claude plugin list`; for a GitHub
  marketplace `git -C ~/.claude/plugins/marketplaces/<m> rev-parse --short HEAD` against `git ls-remote <repo>
  HEAD`; for a directory marketplace, its `plugin.json` version and whether that bump is committed. Other
  agent CLIs on PATH (`codex --version` and the like). Never `claude plugin marketplace update` here: it writes.
- **Drivers**: `nvidia-smi --query-gpu=name,driver_version --format=csv` or `Win32_VideoController`. The
  current version only from the vendor's own page or app; unverified, say so.
- **Where each item lives**: `InstallLocation` from the Uninstall keys (HKLM, WOW6432Node, HKCU), and the disk
  type through `Get-Partition -DriveLetter X | Get-Disk | Get-PhysicalDisk`.
- **What holds files now**: `Get-Process | Select Name,Path`, matched to each item's install folder.
- **How much it is used**: running now, its service status and start type, else the newest `LastWriteTime` in
  its own `%APPDATA%`/`%LOCALAPPDATA%` folder; otherwise "unknown". UserAssist, Prefetch and last-access times
  are off or admin-only on many machines: do not rely on them.
- `~/.claude/makarasty/upkeep.json`: what `game` or an earlier `update` installed.

Then look up the changelogs of the candidates in one parallel batch of searches. Done when every source has
been read or named as absent.

## 2. Picks

Per item: installed and available version, what the update fixes (a security fix with its CVE, a bug fix,
speed, nothing that matters here), how much it is used, the command, the rollback. Rank security fixes and
daily tools first.

- An item whose files a running process holds - Claude Code, a directory-marketplace plugin, Git Bash, node
  or npm, Python with live venvs, the terminal, a GPU driver - is `wait` until that process ends; with a fleet
  running, until it is idle.
- An app with its own updater, or one winget matched through the `msstore` source when it is not a Store
  install, is updated through its own updater, never winget: that path installs a second copy.
- A plugin bump that is not committed is never installed.
- Rollback with `winget install -v <old>` works only while that version's manifest exists; otherwise the
  rollback is "back up <folder> first".
- An install outside its vendor's or launcher's default, or on a full or slow disk, gets a `Move` line.

## 3. Red team

One `Agent` (`subagent_type: general-purpose`, `model: opus`, in the foreground), the picks inline in its
prompt, told: read only - install, download and write nothing, keep commands light while other sessions run;
challenge each pick - it breaks a pin, the changelog holds nothing worth the risk, the item is unused, a
running process holds it, the move would break a launcher or an IDE; return `update`, `wait` or `skip` with a
source per pick. Where it is wrong, answer once with `SendMessage` to its agent id.

## 4. Report, then update on a yes

Plain text in the chat, in the operator's language:

```
Update now:
1. <item> <old> -> <new> - <why> | <command>
Wait: <item> - <until when, and why>
Skip: <item> - <why>
Move: <item> from <path> to <path> - <why>   (or: Move: none)
```

Ask once which numbers to apply. Apply each approved number on its own - `winget upgrade --id <id> -e`, never
`--all`, and no `--accept-package-agreements` or `--accept-source-agreements` without the operator's yes -
naming package, source and size first. Record each in `~/.claude/makarasty/upkeep.json` (create the folder if
missing; read, merge, write) as `{"items":[{"item","manager","id","old","new","path","date","by":"update","undo"}]}`,
the same shape `game` writes.
Drivers and Windows settings are the operator's: give the steps. Claude Code updates with `claude update` and
plugins with `claude plugin update`, between fleet runs only.

Done when the operator has the report and every applied item is recorded. For a monthly run, a local
scheduled task (the `scheduled-tasks` tools) can start it; a cloud `/schedule` cannot see this machine.
