# Your first fleet, in fifteen minutes

For somebody who has never run one. It uses two workers, a repository you do not mind touching, and no
browser. Everything here is a command you type or a button you click; nothing is left as an exercise.

If you only want to know whether the plugin works on your machine, stop after step 1.

---

## 1. Prove the machine can run it — one second

```bash
f=$(node -p 'JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.claude/plugins/installed_plugins.json","utf8")).plugins["makarasty@makarasty"][0].installPath.split(String.fromCharCode(92)).join("/")' 2>/dev/null || ls -dt ~/.claude/plugins/cache/*/makarasty/*/ | head -1)/scripts/fleet.sh
```

```bash
sh "$(dirname "$f")/fleet-selftest.sh"
```

From a checkout rather than an install, both lines are simply `sh scripts/fleet-selftest.sh` and
`f=scripts/fleet.sh`. `$f` is used by every later step on this page.

Expect the last line to read `N passed, 0 failed`. This runs the whole protocol — claims, lanes, the
schema gate, the clocks, the markers, the landing check — against a temporary directory, with no sessions,
no browser and no tokens. It is also the portability probe: if it passes on your operating system, the
mechanical half of this plugin works there. It is checked under `bash` and under `dash`, so a strict POSIX
`sh` is a supported shell rather than a hope.

A failure here is a bug in the plugin or an unsupported shell, and it is worth reporting with the failing
line. Nothing below will work until it passes.

## 2. Pick a repository and set it up — two minutes

In a normal Claude Code session, in the repository you chose:

```
/makarasty:fleet-init
```

It reads the project, asks you for anything it cannot discover, writes `FLEET.md` at the root, creates
`.fleet/` and adds it to your ignore file. For a paneless first run you can answer "no app" to the origin
question; the browser half is skipped entirely.

**Keep `.fleet/` on a local disk.** Inside Dropbox, OneDrive or iCloud, the sync client rewrites the
directory behind you and the atomic claim stops meaning anything.

## 3. Ask for a plan — three minutes

Same chat:

```
/makarasty:fleet-plan find every place this repository logs a value it should not, two workers, no browser
```

It will interview you. Answer briefly; each answer visibly edits a line of the draft plan it is holding.
It stops when a round changes nothing, then writes a queue under `.fleet/<run-id>/tasks/ready/` and offers
you **one chip per worker** — a button that starts a new session on that work.

You will see a run id like `2026-08-31-logging-sweep`. Everything below uses it.

## 4. Click the chips — one minute

Click both. Two new chats appear, each titled `fleet <run-id> NN`. They claim tasks, work them, and write
findings to disk. You do not need to watch them, and nothing you type in those chats is required.

If a worker needs a browser pane it asks you inside its first minute, in its own chat, and that is the only
question a worker is ever allowed to ask you.

## 5. Watch from one chat — however long the work takes

The planner chat is already watching. Every ten quiet minutes it reports what is outstanding and who holds
it, so silence and progress look different from each other.

Two glances tell you where a run is without opening a worker chat:

- **the sidebar** — a finished worker renames itself `fleet <run-id> NN - done 12f`
- **the background task panel of a worker** — empty means it is finished, because its clocks stop
  themselves when its work closes

## 6. Read what it found — two minutes

When every worker has landed, the planner merges the run itself and prints one block:

```
==============================================================
 RUN FINISHED - 2026-08-31-logging-sweep
==============================================================
  01   done     tasks 3   findings 7   blocker 1  major 3  minor 3  polish 0  unreached 0
  02   done     tasks 2   findings 4   blocker 0  major 2  minor 2  polish 0  unreached 1
--------------------------------------------------------------
  workers done 2, blind 0, waiting on the operator 0
  tasks 5 of 5 finished, findings 11, blockers 1, majors 5
  backlog: .fleet/2026-08-31-logging-sweep/backlog.md
fleet-summary: {"run":"...","workers_done":2,...}
==============================================================
```

The ranked backlog is `backlog.md`. Findings that were set aside are in `skipped.md`, with the reason.
Areas nobody finished are listed as unreached, because an area nobody reached is never a clean one.

## 7. Hand the fixes to a second fleet — optional

```bash
sh "$f" fixqueue .fleet/<run-id>
```

That turns every blocker and major into a task with its reproduction attached, and a second fleet claims
it with `/makarasty:fleet-run .fleet/fix-<run-id>/`.

---

## What to do when it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| A worker asks you to display its Browser pane | It measured the pane and got no frames, so anything it reports would be fiction | Display that chat's pane. It re-measures rather than trusting your answer |
| The planner says a claim has been quiet for longer than its budget | A worker may have died holding a task | `sh "$f" sweep .fleet/<run-id>` lists them; `--release` hands them back |
| A worker chat looks busy long after it finished | It should not: clocks stop themselves | Check its background task panel; report it, that is a defect in this plugin |
| Nothing has changed on disk for an hour and no stall line appeared | The watch is not running | Re-arm it: `/makarasty:fleet-wait <run-id> <worker count>` |
| A change you made to the plugin does nothing | The install is a cache | `claude plugin uninstall makarasty@makarasty` then `install` |

## What this run cost

A two-worker paneless run over a small repository is minutes and a few tens of thousands of tokens. The
numbers that matter at scale are in [`MEASUREMENTS.md`](MEASUREMENTS.md): the 14-worker run behind this
release filed 246 findings in 153 minutes.

## Where to read next

- [`PROTOCOL.md`](PROTOCOL.md) — the run layout, the finding schema, and the two rules a worker must obey.
- [`LANES.md`](LANES.md) — why a fleet queues for the browser, the test suite, or nothing at all, and how
  wide each lane should be.
- [`MISSIONS.md`](MISSIONS.md) — the six kinds of mission and the axis each one splits along.
- [`BROWSER.md`](BROWSER.md) — read before a run that needs the running application.
