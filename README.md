# makarasty

Two Claude Code plugins in one marketplace. Install one or both; they are versioned separately.

- **`makarasty`** (the fleet) runs one job across subagent workers from one chat: a test sweep of a live
  app, a fix run over a backlog, a refactor, a research sweep, a design pass. The coordinator keeps a task
  queue on disk and spawns a fresh subagent per task. Every finding goes through an evidence gate, a fix is
  refused without a reproduction that failed first, and a browser check counts frames before it trusts
  the page. Separate worker chats are opt-in.
- **`makarasty-tools`** is twenty-five everyday skills that need no fleet (commit under your name, ship,
  review, red team, hand off a chat, collect bugs until a codeword, phone notifications, disk cleanup)
  plus guard hooks that refuse commands which lose uncommitted work, kill other chats' processes or
  delete the project.

A few tools use the fleet plugin when it is installed: `blindtest` and the visual check in `hold` use its
browser agents, `tune` reads its price table, and `handoff` of a coordinator uses its relaunch.

## Install

In Claude Code:

```
/plugin marketplace add makarasty/makarasty-claude
```

```
/plugin install makarasty@makarasty
```

```
/plugin install makarasty-tools@makarasty
```

Restart Claude Code; plugins load at session start. To install from a local checkout, pass its path to
`marketplace add`. To pick up a new version:

```bash
claude plugin marketplace update makarasty
claude plugin update makarasty@makarasty
claude plugin update makarasty-tools@makarasty
```

Chats that are already running keep the old copy until they restart.

### Requirements

- Claude Code with function hooks. This release ran on 2.1.322 [M65]. The hooks run inside the engine, so a
  chat outside a fleet starts no process for them [M40].
- Browser checks use the desktop app's built-in browser pane. A run with no browser tasks works anywhere
  Claude Code does.
- A POSIX shell. On Windows that is Git Bash, which Claude Code already needs. The self-test passes under
  `bash` and `dash`.
- Node.js 20.11 or newer. `scripts/fleet.sh` is a short shim; its commands run in compiled JavaScript that
  ships with the plugin. Nothing is installed or built on your machine.
- Nothing else is required. `fleet-init` offers `rg`, `sg`, `jq` and similar tools.

### Check that it works on your machine

```bash
node scripts/fleet-selftest.mjs
```

Run it from a checkout, or from the plugin's `installPath` in `~/.claude/plugins/installed_plugins.json`.
It runs the whole protocol (claims, lanes, the schema gate, clocks, markers, the landing check) in
temporary directories, with no sessions, no browser and no tokens. It takes about 75 seconds on a
16-thread Windows machine and ends with `N passed, 0 failed`. One part only:
`node --test scripts/selftest/<part>.test.mjs`. `--jobs N` sets how many parts run at once (3 by default).

## Five minutes with each main command

You type a slash command or plain words in either language; most commands also fire on phrasing such as
"запусти флит на это" or "commit as me". Blocks marked **real** are trimmed output of the scripts, run in
a scratch repository on 2026-11-11 (absolute paths shortened). Blocks marked **shape** are a model's reply:
the format is fixed by the command, the content depends on your project.

### Fleet

**`/makarasty:fleet-init`**, once per project. It finds the app's origin and services, sets up a login an
agent can use on its own, writes `FLEET.md` at the root ([`examples/FLEET.md`](examples/FLEET.md)) and adds
`.fleet/` to your ignore file. A project with no app answers "no app" and skips the browser half.

**`/makarasty:fleet-plan <mission> [fast]`** plans and launches the run.

```
/makarasty:fleet-plan найди все места, где логируется секрет, без браузера
```

It drafts a plan, then asks four questions in one window, the recommended option first: scale, speed
against quality, economy, and isolation and commits ("One chat, main checkout, one commit at the end" is
the default). The answers become one `pace:` line in `STATE.md`. Worker count is never a question: it comes
from `fleet.sh width`. The planner then files the queue and starts working it. Under the hood every
step is one `fleet.sh` call; you do not type these, the coordinator does. **Real:**

```
$ sh scripts/fleet.sh file .fleet/2026-11-11-logging-sweep t01-log-scan < task.md
FILED t01-log-scan lane repo
$ sh scripts/fleet.sh file .fleet/2026-11-11-logging-sweep t02-env-dump < task2.md
FILED t02-env-dump lane repo after t01-log-scan
$ sh scripts/fleet.sh chips .fleet/2026-11-11-logging-sweep 01-02 repo --agents
SLOT 01 lane repo
SLOT 02 lane repo
spawn one background subagent per claimed task; see docs/ONECHAT.md
$ sh scripts/fleet.sh next .fleet/2026-11-11-logging-sweep 01 repo
CLAIMED t01-log-scan
LANE repo
BUDGET_MIN 15
ABORT_AFTER_SEC 1800
...
$ sh scripts/fleet.sh next .fleet/2026-11-11-logging-sweep 02 repo      # t02 waits for t01 (exit 7)
QUEUE WAITING for lane repo: 1 task(s) held by an unfinished `after:` dependency, a held verify lane, or an `operator:` line not yet cleared
```

A finding reaches the findings file only through the gate. **Real:**

```
$ echo '{"area":"app.js","severity":"major","observed":"...","repro":"node app.js","evidence":"app.js:1"}' | sh scripts/fleet.sh find .fleet/2026-11-11-logging-sweep 01
REFUSED: missing mechanism_status                                     # exit 1
$ echo '{..., "mechanism":"console.log of the env var","mechanism_status":"established","conditions":"any"}' | sh scripts/fleet.sh find .fleet/2026-11-11-logging-sweep 01
FILED 1 lines in 01.jsonl
```

A sample task file is [`examples/task.md`](examples/task.md); the full format is in
[`docs/PROTOCOL.md`](docs/PROTOCOL.md), "Task format".

**`/makarasty:fleet-wait <run-id> [n]`** waits without spending model turns: a background loop prints a
line only when something needs the coordinator (a service down, low disk, a hung subagent, the run
complete). `fleet-plan` arms it for you. When the run lands it prints the end banner. **Real:**

```
==============================================================
 RUN FINISHED - 2026-11-11-logging-sweep
==============================================================
  01   done     tasks 1   findings 1     blocker 0   major 1   minor 0   polish 0   unreached 0
  02   done     tasks 1   findings 0     blocker 0   major 0   minor 0   polish 0   unreached 0
--------------------------------------------------------------
  workers done 2, blind 0, waiting on the operator 0
  tasks 2 of 2 finished, findings 1, blockers 0, majors 1
  backlog: .fleet/2026-11-11-logging-sweep/backlog.md
```

**`/makarasty:fleet-collect <run-id>`** merges every worker's findings into one ranked backlog, enforces
the evidence contract and dedupes. **Real** (the two scripts it runs):

```
$ sh scripts/fleet.sh merge .fleet/2026-11-11-logging-sweep
chip files read  1: 01.jsonl
input findings   1  (0 blocker / 1 major / 0 minor / 0 polish)
merged entries   1  (0 blocker / 1 major / 0 minor / 0 polish)
skipped entries  0
deduped away     0
reconciled: 1 findings off 1 chip file(s), 1 carried by 1 rows read back off disk
$ sh scripts/fleet.sh render .fleet/2026-11-11-logging-sweep
rendered backlog.md (1 entries) and skipped.md (0)
$ sh scripts/fleet.sh landed .fleet/2026-11-11-logging-sweep 2
LANDED: 2 workers, every claim closed, backlog written, FINISHED written
```

The result is [`examples/backlog.md`](examples/backlog.md); the run directory it leaves is
[`examples/run-directory.txt`](examples/run-directory.txt). `sh scripts/fleet.sh fixqueue <run-dir>` turns
the blockers and majors into a fix queue for a second run.

**`/makarasty:fleet-login [origin]`** opens the project's app in this chat's browser pane and signs in with
the login runbook named in `FLEET.md`, never with credentials from the chat. Say "залогинься" or "log in
as AI". **Shape:** the reply names the origin, the frame count it read, and either the signed-in screen or
the step that failed.

**`/makarasty:fleet-pause <run-id> [off] [reason]`** really stops every worker: after a 30 s grace the hooks
refuse their edits, browser and shell calls until the pause is lifted. "Поставь флит на паузу" or "pause
the fleet" fires it. **Real** (the script it runs, trimmed):

```
$ sh scripts/fleet.sh pause .fleet/2026-11-11-logging-sweep "lunch"
PAUSED 2026-11-11-logging-sweep: 2026-11-11T23:31:28+02:00 - lunch
  0 worker(s) hold claims
  Each worker gets 30 s from its first call after this to finish the step in hand (120 s from now at the latest, for one that never calls); then the hooks refuse everything but git, fleet.sh and the wake loop.
$ sh scripts/fleet.sh resume .fleet/2026-11-11-logging-sweep
RESUMED 2026-11-11-logging-sweep: workers wake within 30 s; resumed: carry on with the claim you hold, call next only if you hold none (a pane worker may still take its one repo task)
```

**`/makarasty:fleet-run <brief or run dir>`** is what a worker chat runs. In the default one-chat run you
never type it; with opt-in separate chats, each worker chat starts it from its card.

### Tools

**`/makarasty-tools:commit`** — "закоммить от меня". Commits only this chat's files, by path, under
`git config user.name` and `user.email`, with a short message and no AI trailer. No push. **Shape:** the
reply is the subject line, plus one line naming any file left out because another chat is editing it.

**`/makarasty-tools:ship [branches|all] [mine] [tag <name>]`** — "закоммить от моего имени отдельными
коммитами и запушь". Splits the tree into separate commits, merges the named branches and resolves
conflicts, pushes, and tags with notes if asked. **Shape:** the commit subjects, the branches merged and
skipped, each conflict and its resolution in one line, the notes if made.

**`/makarasty-tools:handoff [focus] | from <chat>`** — "сделай хенд-офф". Writes
`~/.claude/makarasty/handoff/<yyyy-mm-dd>-<id6>-<slug>.md` plus a patch of the uncommitted files, outside
every repository, and offers the next chat as a card. `from "<chat title>"` takes over another chat's work
and checks each of its claims first. **Shape:** the file path, the card, and the claims marked checked or
unchecked.

**`/makarasty-tools:hold [codeword]`** — "молчи, пока не скажу абрикос". The chat stops acting and stores
each bug you dictate verbatim, one file per item. On the codeword it asks once about unclear items, then
fixes them grouped by shared cause, here or as a fleet. **Real** (the list script, run by the skill):

```
$ node tools/skills/hold/hold.mjs --sid demo-sid init абрикос
.../makarasty/hold/demo-sid
$ printf 'where: /settings\n---\nкнопка Сохранить не реагирует на второй клик\n' | node tools/skills/hold/hold.mjs --sid demo-sid add
01 chars=44 img=0/0 where=/settings
$ node tools/skills/hold/hold.mjs --sid demo-sid check          # exit 1 until every item is final
01 open: кнопка Сохранить не реагирует на второй клик
02 open: the date picker opens off screen on 1366x768
index.md still reads "collecting абрикос": run release
2 of 2 items not final
```

The whole list before and after is in [`examples/hold-list.md`](examples/hold-list.md).

**`/makarasty-tools:review [target] [--fix|--loop]`** — "проведи ревью и исправь все находки". Reviews a
diff, branch, PR number, file or folder for bugs. Each finding is checked by a pass that tries to disprove
it. `--loop` fixes and re-reviews until a round finds nothing, three rounds at most. **Shape**, one line per
finding:

```
path:line: <bug|risk|q> [high|med]: <problem>. breaks on: <the input or sequence>. fix: <the change>.
```

**`/makarasty-tools:redteam [target] [--fix]`** — "подними красную команду". Three to five cheap read-only
attackers hit a plan, export, tool or change from different angles; a strong judge keeps only findings with
evidence. **Shape:** confirmed findings one line each with evidence and whether fixed; refuted ones as a
count; open ones with what would settle each; what no attacker looked at.

**`/makarasty-tools:finish [--no-push] [--no-redteam]`** — "доведи до идеала и запушь". Review until a
round finds nothing (three rounds at most), red team, fix what holds, run the narrow tests, commit under
your name and push, touching only this chat's files. Nothing is committed after a failing test. **Shape:**
one block with the review rounds, red-team findings, the test command and result, the commit hash and where
it was pushed, then what was not run.

**`/makarasty-tools:cleanup [processes|disk|all|deep]`** — "почисти за собой", "что жрёт диск". Finds
processes that ended chats left running, stale worktrees, caches, old app versions, scratch folders, unused
games and big files, and acts only on the numbers you pick. **Shape:**

```
Frees about <N> GB RAM / <M> GB disk.
Processes:
1. pid <n> <what> - <MB>, <age> - <why it is nobody's>
Disk:
2. <what> - <GB> - <why it is nobody's; what is lost> - <how>  [<scan id>]
Yours to decide: <n>. <game, program or file> - <GB> - <last used> - <how>  [<id>]
Undo: what went to the Recycle Bin comes back from it; what was deleted does not.
```

Caches are deleted; personal files go to the Recycle Bin; a game opens its own uninstaller; admin items go
into a `.bat` you run. Your own places go in `~/.claude/makarasty/cleanup-rules.json`.

**`/makarasty-tools:prune [scan|list|restore <id>|empty <id>]`** — "почисти ветки". Moves merged local
branches and clean stale worktrees into an undoable trash inside the repo's git directory. It never
touches a remote and never follows a junction. Nothing is deleted until you empty the trash. **Real:**

```
$ node tools/skills/prune/prune.mjs scan
...\demo  default master
  1. ask    b:fix/old-login  in master, but made or moved in the last 24 h: maybe new work
     keep   b:feat/wip       unique work: 1 commit not in master, last "wip", on no remote
trash 0, ask 1, keep 1
```

**`/makarasty-tools:notify [what you wait for]`** — "скинь в телеграм когда закончишь". Sends one message to
your phone when this chat, another chat or a fleet run finishes: Telegram, Discord, ntfy or a webhook. Setup
is one command in your own terminal; it saves the token to `~/.claude/makarasty/notify.json` only after a
test message arrives, so the token never passes through a chat:

```bash
node <makarasty-tools installPath>/hooks/notify.mjs setup
```

**Real**, before setup:

```
$ node tools/hooks/notify.mjs --arm --session demo-sid "tests on the billing branch"
notify: armed - "tests on the billing branch"
channels: none yet. The person runs "notify.mjs setup" in a terminal; the marker waits, and a finish that happens before that is delivered when a channel is saved.
$ node tools/hooks/notify.mjs --status --session demo-sid
notify: armed (tests on the billing branch, since 2026-11-11T21:32:50.101Z)
```

A chat that ends on a question is reported as waiting for you; one that leaves a background job running is
not finished and stays armed.

### Guards (always on, makarasty-tools)

Function hooks, so no tool call pays a process for them [M40]. Each prints why and a safe way round it, and
each has an off switch. **Real** refusals from this machine:

```
Blocked by makarasty-tools git-guard: git add: git add -A / -u / --all / . stages every session's uncommitted files, not only yours: git add your own paths by name. ...
Blocked by makarasty-tools kill-guard: taskkill /IM (or /FI on a name): it kills every process of that name, other sessions' and the person's own included. Find the PID first ...
```

| Guard | Refuses | Off |
|---|---|---|
| git | Discarding uncommitted work (`git stash`, `reset --hard`, `clean -f`, `checkout -- <path>`, `restore` without `--staged`, a forced switch), `add -A`, skipping hooks or signing (`--no-verify`, `commit -n`, `-c core.hooksPath=`, `HUSKY=0`, `--no-gpg-sign`), deleting remote refs, `--autostash`, `git worktree remove`. Discards in a chat's own `.claude/worktrees/` tree or a temp clone run [M46] | `MAKARASTY_GIT_GUARD=off` |
| delete | A recursive delete of the project, its `.git`, your home, a drive root, the temp folder or a folder holding the project, in Bash, cmd and PowerShell. Only what the command line shows: a path in a variable runs. `rm -rf dist` runs [M45] | `MAKARASTY_DELETE_GUARD=off` |
| kill | Killing by name (`taskkill /IM`, `Stop-Process -Name`, `pkill`, `killall`) and `taskkill /T`. By PID runs | `MAKARASTY_KILL_GUARD=off` |
| budget | A whole-suite test run or whole-project typecheck while another one is live on the machine, and a heavy run in the background with no `timeout`. Scoped runs always run [M46] | `MAKARASTY_BUDGET_GUARD=off` |
| secret | A Write or Edit that puts a live-looking token into a project file. `.env`, files outside the project and values marked fake are allowed [M46] | `MAKARASTY_SECRET_GUARD=off` |
| generated | An edit of a compiled file listed in `src/build.sha256` (only in a repo that has that file) | — |
| loop | Never refuses. After the same failure three times it tells the chat to change approach | `MAKARASTY_LOOP_GUARD=off` |
| ask | An `AskUserQuestion` question or end-of-turn box that only asks whether to go on with work you already asked for ("Continue?" with yes/stop answers). A push, delete, budget, relaunch or a real choice is still asked [M67] | `MAKARASTY_ASK_GUARD=off` |
| push | `git push` with no word of yours in this turn: a typed "push", or a yes to the chat's push question. A brief, a plugin message or a standing answer is not your word. `--dry-run` runs | `MAKARASTY_PUSH_GUARD=off` |
| verify | Once per turn, an end-of-turn box that says done, fixed or works after a code edit with no test, build or run after it; a recap that says what is not checked passes [M73] | `MAKARASTY_VERIFY_GUARD=off` |

Every guard and the complaint behind it: `docs/COMPLAINTS.md`.

The shell guards read the command inside `bash -c`, `cmd /c` (and Git Bash's `cmd //c`), `powershell -Command`
and a bare `powershell <command>`. Text in single quotes, a heredoc or a PowerShell here-string is text: a
commit message that quotes `pkill node` runs. They stop accidents, not someone set on getting round them:
a backslash inside a word, brace expansion or `Start-Process` gets through.

Three more hooks change behaviour without refusing:

- **Context.** Past 700k tokens, and every 150k above, the chat is told to state its context size and save
  its notes. A handoff is offered only if you asked. `MAKARASTY_HANDOFF_AT`, `MAKARASTY_HANDOFF_STEP`;
  `MAKARASTY_HANDOFF_AT=0` turns it off. Why 700k: strict corrections ("перепроверь", "не работает") did not rise with context up to 800k [M49].
- **Model router.** A subagent that Opus or Fable spawns without naming a model runs on Sonnet when its
  description starts with `[exec]` and on Haiku with `[mech]`. Untagged work and a named model are never
  changed; `Explore` and `fleet-reviewer` are never moved. `/router` shows what it changed;
  `MAKARASTY_ROUTER=off`.
- **Reads through tools.** One system-prompt line sends file reads to Read, Grep and Glob instead of `cat`
  or `grep` in the shell [M40]. `MAKARASTY_READS=off`.
- **How questions are asked.** At session start, one line: a question stands alone, a list you answer point by
  point is numbered, a step left to you comes with its link, a delete-or-keep question says what the thing is,
  what made it, its size, what breaks and a recommendation [M67]. Rides with `MAKARASTY_ECONOMY=off`.
- **Your profile.** Facts about you that no shipped tool should guess (the language you want, your machine,
  your notify channels, standing answers such as "always run the tests") go in
  `~/.claude/makarasty/profile.md` (under `CLAUDE_CONFIG_DIR` when that is set), plain text. Every session start reads it when it exists, first 2,000
  characters. Subagents do not see it; a skill that briefs one passes what it needs. Lines the tools read:
  `Language: <name>, plain and short` (replies in that language, short), `Continue questions about work already
  asked are answered yes` (the inbox answers such asks itself; never a commit, push, delete or money question),
  `Fleet foreign code: wait|fix|leave` and `Fleet crash watch: yes|no` (fleet-plan asks once, then reads them),
  `Effort: <when medium, when high>` (overrides the plugin's effort defaults for spawned agents and sessions; the
  default is high for Sonnet coders and finders, medium for Opus reviewers), `Commit: ask` (a chat asks before
  its local commit; by default it commits its own files when its task is done, and only a push is asked).
  With no line, each tool asks or uses its own default. Standing answers the inbox records go in
  `~/.claude/makarasty/answers.md` (one `<topic>: <answer> (<date>)` line each, first 4,000 characters read).

## All commands

### Fleet (`/makarasty:<name>`)

| Command | What it does |
|---|---|
| `fleet` | Lists the commands and when to use each (you only) |
| `fleet-init` | Prepares a project: origin, services, agent login, `FLEET.md`, lane widths |
| `fleet-plan <mission> [fast]` | Four pace questions, the plan, the queue, then runs it in this chat |
| `fleet-run <brief or run dir>` | A worker works one brief or a queue (opt-in worker chats) |
| `fleet-login [origin]` | Opens and signs in to the app in this chat's pane |
| `fleet-wait <run-id> [n]` | Waits without model turns, then collects |
| `fleet-collect <run-id>` | Merges, enforces the evidence contract, dedupes, ranks |
| `fleet-pause <run-id> [off] [reason]` | Stops every worker for real, or lifts the pause |
| `fleet-resume <run-id>` | After a crash: reopens workers whose context survived, respawns the rest |
| `fleet-analyze <run-id>` | Where a run's time, turns, tokens and estimated money went, from its transcripts |
| `fleet-design <screens> [fast]` | Captures screens as artboards and assembles a Claude Design canvas (you only) |
| `fleet-redesign <screens and direction> [fast]` | Proposes redesigns beside the captured screens (you only) |
| `fleet-call <who and what about> [fast]` | Facts for a vendor call with evidence, and a bilingual page to read aloud; `live <run-id>` answers during the call (you only) |

"You only" commands carry `disable-model-invocation: true`: they start paid work and wait on your clicks.
`fleet-run` must never get that flag, because the worker's own model invokes it ([`docs/COMMANDS.md`](docs/COMMANDS.md)).

Agents: `fleet-coder` (one code task, touches only its task's `owns:` paths, commits nothing),
`fleet-reviewer` (reviews one diff, edits nothing), `fleet-scenario` (a multi-step browser walk, returns
bounded JSON), `fleet-profiler` (load and interaction timings with spread and machine load),
`fleet-triage` (merges and ranks findings), `fleet-design-eye` (design defects by geometry, then a
screenshot per candidate), `fleet-naive-user` (a first-time user with no code access), `fleet-lead`
(one slot end to end, only with `leads: on`).

### Tools (`/makarasty-tools:<name>`)

| Command | What it does |
|---|---|
| `commit` | This chat's files, your name, short message, no AI trailer |
| `ship` | Separate commits, merges, conflicts, push, optional tag with notes |
| `finish` | Review to zero, red team, narrow tests, commit and push |
| `review` | Bugs with the input that breaks them; `--loop` fixes to zero |
| `redteam` | Cheap attackers, a strong judge, evidence only; `--fix` |
| `handoff` | Hands this chat to a fresh one as a card, or takes over another chat |
| `hold` | Collects dictated bugs until the codeword, then fixes them grouped |
| `unfinished` | What this project's recent chats left open |
| `notify` | One phone message when a chat or run finishes |
| `inbox` | One place for every chat's questions and cards, answers routed back (off until `on`) |
| `cleanup` | Processes, caches, scratch and big files nobody needs; acts on your picks |
| `prune` | Merged branches and stale worktrees into an undoable local trash |
| `scrub` | Masks secrets pasted into this machine's transcripts; dry run first. Does not revoke a key |
| `blindtest` | First-time-user agents try plain tasks on the live screen; fixes are re-run |
| `proof` | Before and after screenshots in an HTML report, kept out of the model's context |
| `antislop` | A rule set against AI-looking UI, plus an audit of existing UI [M47] |
| `forge` | How to build or check a skill, command, hook, agent or plugin, with an A/B script |
| `craft` | Refactor, dedupe and test rules: pin behaviour first, keep tests seen failing |
| `explain` | Where this chat's work stands, in plain words |
| `unslop` | Strips assistant tics from text; a fact lock keeps numbers, paths and negations |
| `say` | Simple English for a vendor call, ticket or email |
| `selfreview` | This month of your chats against the last one |
| `tune` | Which model and effort each role should use, from your transcripts and git |
| `game` | Tunes the machine for one game; applies nothing without a yes per item |
| `update` | What is out of date and worth updating; updates only on a yes |

## How a fleet works

**One chat by default.** The coordinator claims a task, spawns one fresh background subagent for it, gets
a three-line reply, spawns a reviewer, and marks the task done. Everything is in the main checkout on its
current branch, and one commit lands at the end. Separate worker chats and worktrees are opt-in
([`docs/ONECHAT.md`](docs/ONECHAT.md), [`docs/CHATS.md`](docs/CHATS.md)).

**Lanes.** Each task declares `needs: pane` (the browser), `verify` (the test suite and typechecker) or
`repo` (files only), and each lane has its own cap. The pane lane is 1 in one chat, because only the
foreground tab draws [M42]. A run with no pane tasks still has a gate; the evidence changes to a failing
reproduction, a quoted source or a test count ([`docs/LANES.md`](docs/LANES.md)).

**Mission kinds.** Each task has a `kind` that sets how the job splits: `verify` by screen, `fix` by file
cluster, `investigate` by hypothesis, `implement` by seam, `research` by source, and `design`, `critique`,
`canvas`, `redesign`, `call` by screen or source ([`docs/MISSIONS.md`](docs/MISSIONS.md)). Two workers on one
slice cost twice and then agree with each other, which looks like corroboration and is not.

**The pane gate.** A browser pane that is not displayed stops drawing and says nothing: screenshots time
out, `requestAnimationFrame` never fires, virtual lists read empty, yet navigation still reports the right
title. So a worker counts frames for one second before it looks:

```js
new Promise(res => { let f = 0; requestAnimationFrame(function t(){ f++; requestAnimationFrame(t); }); setTimeout(() => res(f), 1000); })
```

Ten or more is live. Under ten, the worker asks you to show the pane and measures again; one that stays
blind writes `.blocked` and no findings, and collection names it ([`docs/BROWSER.md`](docs/BROWSER.md)).

**A session with nothing pending stops.** A worker that ends a turn with no subagent and no background
command running never runs again [M03]. So a worker claims and starts in the same turn, and the watch
reports silence as well as progress ([`docs/PROTOCOL.md`](docs/PROTOCOL.md)).

**The gate between a finding and a fix.** A `fix` task is refused by `finish` unless a reproduction ran
through `fleet-gate.mjs prove`, failing before the change and passing after [M09]. A cause several
findings share is ruled on once. An edit that drops a name something outside the repo reads (a route, a
config key) is blocked until a question or a recorded decision names it ([`docs/GATE.md`](docs/GATE.md)).

**Relaunch past the context mark.** A coordinator or worker near 700k tokens (`coordinator_handoff_k`,
`worker_relaunch_k` in `calibration.json`) drains the run and hands its state to a fresh one in one ask
([`docs/RELAUNCH.md`](docs/RELAUNCH.md)).

## Measured vs claimed

Measured: each number has an entry in [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md). All come from one
machine and one operator.

| What | Number | Entry |
|---|---|---|
| Panes that opened blind in the first eight-worker run; the gate caught each | 8 of 8 | [M02] |
| Workers that ended a turn after a claim and sat dead | 3 of 6, for 169-176 min each | [M03] |
| Findings refuted once somebody tried to fix them | about 15 of 100 | [M09] |
| Where the tokens go | output 0.3% of tokens moved; 6,421 M cache read over 19,535 turns | [M24] |
| `git worktree remove` with a `node_modules` junction inside | emptied the main checkout's folder 8 of 8 runs | [M32] |
| `fleet.sh next` / `status`, sh against node | 3.4-7.7 s to 0.10-0.62 s / 4.6-6.1 s to 0.13 s | [M37] |
| One tool call, no hook against a node command hook | 0.088 s against 0.199 s median | [M40] |
| One chat's browser tabs | foreground 272-300 fps, background 0-2 | [M42] |
| Guards in a live engine | stash, `checkout -- .`, `--no-verify` refused, edit intact; 0 false blocks of 3 | [M44] |
| Guards replayed over 4.3 months of commands | delete-guard flagged 138 of 331,132, none was a real project, home or `.git` target; 0.013-0.017 ms a check | [M46] |
| Skill routing, right first call | 58 of 65 prompts | [M50] |
| Context per spawn in a one-chat coordinator | about 9 k, against a 3-4 k estimate | [M54] |
| Handoff against `/compact` at real relaunch points | confidently wrong answers: handoff 0, compact up to 2 per case | [M64] |
| Slot leads on a six-task fixture | 2.6K against 8.2K coordinator growth per task, 1.71 x the wall clock, n = 1 | [M65] |
| Design probe on a fixture | 9 of 9 planted defects, 0 of 10 look-alikes | [M29] |

Claimed by design, not measured:

- The memory throttle in `next` and the hooks that refuse heavy runs on a full machine. Their thresholds in
  `calibration.json` were chosen; they never fired in a real run.
- The contract hook (an edit that drops a route or config key). No live worker has been stopped by it.
- The finding-to-fix gate on a real project. It ran on two fixture runs [M65], not on a live backlog.
- The pane broker ([`docs/BROKER.md`](docs/BROKER.md)). Never run live.
- A canvas of a real application. `fleet-canvas.mjs` ran on a fixture only; its 2 px tolerance is a
  starting number.
- Any fleet on macOS or Linux. Only the self-test runs there.

## Real runs, and what they cost

A selection of real runs, not all of them. They come from two different projects, a large private
TypeScript web app and the public Kotlin plugin [Essentials](https://github.com/makarasty/Essentials), and
cover different scenarios: browser sweeps of a running app, audits, fix runs, refactors and performance
measurement. Each one is written up in [`docs/RUNS.md`](docs/RUNS.md) with how it was set up, what it
produced, what went wrong, and the cost.

| Run | Workers | Wall clock | Result | Worker cost |
|---|---|---|---|---|
| First eight-worker browser sweep | 8 pane | 104 min | 94 findings, 3 blockers; all 8 panes opened blind and the gate caught every one | ~$140 |
| Pull run, 34 tasks | 6 pane | 4 h 57 min | 254 findings; three workers sat dead for about 3 h each | not separable |
| Audit, then fix | 14, then 8 | 132 + 80 min | 246 findings, then 38 fixed and merged, 3 refuted | ~$560 + ~$430 |
| Eighty tasks across three lanes | 13 | 4 h 6 min | 80 tasks; third verify round green at about 37,000 tests | ~$1,600 |
| Read-only sweep, then a fix run | 12, then 4 | ~90 min active, then 3 h 51 min | 1,500 findings, then 175 tasks worked, 93 fixed | ~$740 + ~$1,110 |
| Refactor, then shrink | 9, then 10 | 71 + 107 min | 96 fixed, 32 refuted; then about 27,000 lines removed (−17.6% against a −25% target) | ~$480 + ~$740 |
| Essentials, audit to green | 4-10 per run | ~50 h calendar | 436 findings; 251 tests with 20 failing to 383 with 0, ten green runs of ten | ~$1,400, plus ~$820 planners |

Every number here is approximate and rounded; the point is the order of magnitude. Dollars are API list
prices for the same tokens; the runs themselves were made on a subscription, and the first one above used
about 6% of a weekly maximum allowance. Across 21 runs and 186 sessions the total is at most about
$11,000, and **74% of it is cache reads**. What a run costs is turns multiplied by the context each turn
carries: in one fix run the workers held about 500 k of context per turn and 87% of the money went on
reading it back, while a broad sweep that fanned its reading out to subagents came to about 50 cents a
finding. What a worker says costs almost nothing next to what it reads. The full ledger, with every
measurement a rule cites, is [`MEASUREMENTS.md`](docs/MEASUREMENTS.md).

Every defect those runs exposed in the plugin itself is in [`CHANGELOG.md`](CHANGELOG.md), with the fix.

## What it may delete

A fleet runs unattended, so what it may remove is a closed list:

1. Its own scratch, under `.fleet/<run-id>/`.
2. The worktrees its own workers created under `.claude/worktrees/`, only through `fleet.sh clean`.

There is no `git reset --hard`, `git clean` or `git checkout --` in the plugin, and no recursive delete of
a path it did not create. `fleet.sh clean` is a dry run unless given `--remove`. It touches only worktrees
this run registered, keeps any tree with uncommitted changes or unmerged, unpushed commits, and deletes a
branch only with `git branch -d`. Every deletion passes a path gate: absolute, no `..` or `.` segments, at
least four levels deep, inside `.claude/worktrees/`, never a directory holding the shell's working
directory. It unlinks every junction and symlink inside a worktree first, because `git worktree remove`
follows a junction and deletes its target [M32]. A plain `rm -rf` unlinks a junction and spares the target
[M45]. See [`docs/WORKTREES.md`](docs/WORKTREES.md) and [`docs/SAFETY.md`](docs/SAFETY.md).

The tools that delete ask first: `cleanup` acts only on the numbers you pick and sends personal files to
the Recycle Bin, `prune` moves into a trash you empty yourself, `scrub` is a dry run until `--apply`.

## What the version number covers

Under semver, 1.x will not break:

- **The run directory layout**: `tasks/ready`, `tasks/claimed/<id>/owner`, `tasks/claimed/<id>/proof`,
  `tasks/done`, `ask/`, `answers/`, `pane/`, `decisions.jsonl`, `clusters.jsonl`, the `<chip>.jsonl`,
  `.notes.md`, `.done`, `.blocked`, `.waiting`, `.retiring` and `.retired` files, `PAUSED`,
  `stopped/<chip>`, `want/<chip>`, `replaced/<chip>`, and `.fleet/contract-surface.txt` beside the runs.
  Each run stamps `RUN_FORMAT`; a `fleet.sh` that reads an older format refuses a newer run.
- **`fleet.sh` subcommands and exit codes**: 0 done; 1 refused by the schema gate, a walk from a blind
  pane, or a run not landed; 2 wrong usage or an unreadable run; 3 the lane is drained; 4 the claim is no
  longer yours; 5 from `drained`, not finished; 6 free memory under the floor; 7 from `next`, tasks held by
  `after:` or the verify lane; 8 paused; 9 retired, or the run has landed; 10 the session runs another model
  or effort than `want/<chip>`; 13 draining before a coordinator relaunch. `dispatch` adds 11 (refuted: the
  repro already passes) and 12 (no `owns:` or `repro:`).
- **The four line shapes** a findings file may hold (a finding, `unreached`, `created`, `state_changed`)
  and the fields the gate enforces on each.
- **The markers**: `.done` finished, `.blocked` never saw, `.retired` replaced, `.waiting` stopped on a
  person, `PAUSED` paused, `FINISHED` landed.

Everything else is calibration: prose rules, agent briefs, the numbers in `calibration.json` and in this
README. [`scripts/fleet-selftest.mjs`](scripts/fleet-selftest.mjs) and [`scripts/selftest/`](scripts/selftest/)
are the contract in executable form.

## Known limits

- **Every number comes from one machine, one operator and a few projects.** Only Windows has run a real
  fleet.
- **The pane states in [M33] were driven by hand, once, on Windows.** macOS and Linux may stop a pane for
  other reasons.
- **The heavy-page figure (2,061 MB) came from a synthetic page of 150,000 DOM nodes** [M34]. Measure your
  own app with `node scripts/fleet-load.mjs`, once with it open and once without.
- **The contract surface is a regular expression over text.** It misses a route built by concatenation
  and a config key read through a variable. Edit `.fleet/contract-surface.txt` by hand and commit it.
- **The design probe was checked in one browser on one fixture** [M29]. It cannot see an overlapping
  sibling when it reads contrast; its `offScale` and `ghostBoxes` results are candidates, not findings.
- **`recover` cannot confirm a resume.** It prints the command and you run it. A resumed session has no
  browser pane, so repo-lane workers come back and pane-lane workers do not.
- **The evals in [`evals/`](evals/) have not been run against this release.** They need Linux or macOS:
  `claude plugin eval` cannot sandbox a shell tool on Windows.
- **The largest cost measured is not this plugin's to fix.** A permission mode that adds 1.5-2 s to every
  gated call cost 16.55 h of a 211 h tool wall [M28]. Only an allowlist or another permission mode removes it.
- **No session-to-session messaging in the normal path.** Session handles change and can reach another
  account's chat; files have addresses, sessions do not. Messaging is used only to revive a stalled worker.

## When something looks broken

**A change to the plugin did not take effect.** The install is a cached copy, and `claude plugin update`
can say "already at latest version" while the source moved. Bump the version, or run
`claude plugin uninstall makarasty@makarasty` and install again.

**`.fleet/` is in a cloud-synced folder or on a network share.** The atomic claim is `mkdir`, which means
nothing once a sync client copies the folder behind you. Keep `.fleet/` on a local disk.

**"bad interpreter" on Windows.** A `.sh` file checked out with CRLF endings. `.gitattributes` pins LF; a
clone made before that needs a fresh checkout.

**Git Bash not found.** Set `CLAUDE_CODE_GIT_BASH_PATH`.

**A path or a word that starts with `/` arrives as `C:/Program Files/Git/...`.** Git Bash rewrites every argument
that starts with a slash before a program sees it, quoted or not, and also inside a `node -e` script.
`fleet.sh` switches that off for its own commands, and the hold, notify, proof and `fleet-gate.mjs prove`
scripts undo it for text arguments. Your own scripts need `MSYS_NO_PATHCONV=1` with a Windows-form or relative
script path (with `/c/...` as the script path node then looks for `C:c...`).

**Every `fleet.sh` command exits 2 with "fleet.sh needs Node.js 20.11 or newer".** Node is not on the
shell's `PATH`. The shim refuses rather than guess, because a dead fleet that reads healthy is worse than
a refusal.

**A worker holds a claim and nothing moves.** `sh scripts/fleet.sh sweep <run-dir>` lists quiet claims;
`--release` hands them back. More cases: [`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md), "What to do when it
goes wrong".

## Changing the code

The scripts and hooks are TypeScript under `src/` and `tools/src/`, compiled to the `.mjs` beside them;
the `.mjs` files are committed and are what runs. `src/probes/*.ts` compiles to `scripts/*.js`. Edit the
`.mts` or `.ts`, never the generated file (the `generated` guard refuses it):

```bash
npm install --prefix src
npm run build --prefix src
node scripts/fleet-manifest.mjs check
```

The first line is once. The build compiles all three trees and rewrites `src/build.sha256`; commit the
source, the output and that file together. The last line prints `BUILD CURRENT` or `STALE`.

Hook tests (`*.test.ts`) run with `claude plugin test tools` (tools) and `claude plugin test .` (fleet).
The second also picks up `tools/**/*.test.ts` under the wrong hooks module, so read only its `hooks/`
results. Skill scripts have their own self-tests, for example `node tools/hooks/notify-selftest.mjs`.

A change reaches users only with a version bump in the plugin's `plugin.json` and a `CHANGELOG.md` entry.

## Documentation

| Page | What is in it |
|---|---|
| [`WALKTHROUGH`](docs/WALKTHROUGH.md) | A first fleet in fifteen minutes, two workers, no browser |
| [`ONECHAT`](docs/ONECHAT.md) | The default run: coordinator plus one subagent per task |
| [`CHATS`](docs/CHATS.md) | Opt-in separate worker chats |
| [`PROTOCOL`](docs/PROTOCOL.md) | Run layout, task and brief format, finding schema, `FLEET.md` |
| [`PULL`](docs/PULL.md) | The queue, claims, heartbeats, budgets, asking the planner |
| [`RELAUNCH`](docs/RELAUNCH.md) | Replacing the coordinator or workers past their context mark |
| [`LANES`](docs/LANES.md) | What a fleet queues for; a run with no browser |
| [`MISSIONS`](docs/MISSIONS.md) | The ten kinds and the axis each splits along |
| [`GATE`](docs/GATE.md) | The stage between a finding and a change |
| [`BROWSER`](docs/BROWSER.md) | Blind panes, the frame gate, viewports |
| [`DESIGN`](docs/DESIGN.md) | Critique by geometry, the canvas, redesign |
| [`CALL`](docs/CALL.md) | Vendor-call facts, the page read aloud, the live chat |
| [`SWEEPS`](docs/SWEEPS.md) | Checks that catch a class of defect |
| [`MOCKING`](docs/MOCKING.md) | Reaching states the sandbox data will not produce |
| [`WORKTREES`](docs/WORKTREES.md) | Registration, the junction measurement, the one path that deletes |
| [`SAFETY`](docs/SAFETY.md) | What an unattended fleet may delete, and the path gate |
| [`COMMANDS`](docs/COMMANDS.md) | Who may invoke each command, what `allowed-tools` grants |
| [`MODELS`](docs/MODELS.md) | Which model per stage, pace, the router |
| [`PERF`](docs/PERF.md) | Measuring speed on a loaded machine |
| [`BROKER`](docs/BROKER.md) | The pane as a shared instrument (never run live) |
| [`PORTING`](docs/PORTING.md) | Every assumption about the host, and its substitute |
| [`RUNS`](docs/RUNS.md) | Real runs: setup, results, failures, cost |
| [`MEASUREMENTS`](docs/MEASUREMENTS.md) | The ledger every `[Mnn]` cites |
| [`CHANGELOG`](CHANGELOG.md) | Every version, and every defect a run exposed, with the fix |

## License

[MIT](LICENSE)
