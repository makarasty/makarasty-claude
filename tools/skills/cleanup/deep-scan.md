# Deep scan: find places the catalog does not know yet

Read by `/makarasty-tools:cleanup` step 5. The ordinary scan finds known places in a minute; this finds new
ones once, so the next ordinary scan knows them. It costs about ten agents, so it is for a disk that is still
full after a scan, or when the operator asks.

## 1. Scouts

`Agent` × one per area, `subagent_type: Explore`, `model: haiku`, in parallel. Areas on Windows: `%LOCALAPPDATA%`,
`%APPDATA%`, Program Files and ProgramData, the home folder's dot folders, the project folders (the parents
of live sessions' repos), `%TEMP%`, every other drive's top level, developer caches (`~/.gradle`, `~/.m2`,
`~/.cargo`, `~/.nuget`, toolchains). Give each the rules below, `~/.claude/MACHINE.md` if it exists, and the
current scan's output (`node "${CLAUDE_SKILL_DIR}/machine.mjs" scan --json` saved to a file) so it spends its
time on what the scan missed. Windows only for now: the `find -printf` below is GNU (Git Bash), not macOS.

Rules every scout gets:

- Read only. Delete, move, rename, uninstall, kill, clean or prune nothing; its report is its final message.
- Sizes with Git Bash `du -sk` under `timeout 300` (it does not follow junctions). Age is the newest file
  inside, found with `find <dir> -type f -printf '%T@\n' | sort -n | tail -1`, not the folder's own date.
- Never open or quote the contents of personal exports, databases, backups or chat transcripts: names and
  sizes only.
- Anything a live Claude session uses is not junk: live means `~/.claude/sessions/<pid>.json` with that pid
  running.
- Usage evidence on Windows: the uninstall keys, the running process list, Steam's `appmanifest_*.acf`
  `LastPlayed`. UserAssist is often reset and BAM or Prefetch need admin: without them a "last used" date is a
  file-write proxy, and the scout says so.
- Return at most 45 lines, largest first, items of 50 MB or more:
  `path | MB | newest file | what it is | junk / probably-junk / ask | evidence (one sentence) | how to remove | what breaks if wrong`.

## 2. Judge

One `Agent`, `model: opus`, in the foreground, given every scout's report (the chat saves each to a file in
its scratch folder and passes the paths). It re-measures each item itself
(scouts misreport sizes by orders of magnitude and miss live use), checks what refers to it (a project's
scripts and config, `PATH`, environment variables, a running process, a newer version that is the one in
use), and sorts each into the catalog's tiers (safe, close-app, admin, owner) or keep, with the measurement as evidence.
Its keep list matters as much as its remove list: append it, one line per place with its reason, to
`~/.claude/makarasty/cleanup-keep.md`, and give that file to the scouts and the judge of the next deep scan
so they do not propose those places again.

## 3. Promote

A judged place that will come back (a cache, an app's old versions, a tool's leftovers) becomes a rule in
`~/.claude/makarasty/cleanup-rules.json`, in the shape of `rules.json` beside this file: the narrowest path or
pattern, its tier, its method, the `running` apps that write there, a `minAgeHours` when it can be in use, and
a `lose` line that says what the operator loses in their words. A one-off (a single installer, a single
archive) gets no rule: the operator gets it in the report with its command. A place useful on any machine is
worth proposing for the shipped `rules.json`. Then run `node "${CLAUDE_SKILL_DIR}/machine.mjs" scan` again.

Done when every new rule finds its place in that scan and nothing on the judge's keep list appears; a rule
that misses or catches a keep item is fixed or removed before the report.
