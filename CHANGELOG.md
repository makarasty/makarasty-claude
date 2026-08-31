# Changelog

## 1.0.0 — 2026-08-31

First release. The version numbers before this one were development markers in an unpublished manifest,
never installed by anyone but the author, and they are not part of any history worth keeping: nothing was
released, so nothing was ever upgraded. This is version one.

What it is: a plugin for running one mission across several Claude Code sessions at once. Each worker
holds its own context, claims one task at a time from a queue on disk, gates whether it can actually see
what it is inspecting, and reports by writing files. Nothing messages anything.

### What this release is built on

Four measured runs over six days against one large Vue and Node application, the last two on 2026-08-31:
an audit run (14 workers, 54 tasks, 246 findings, 32 blockers) and the fix run that followed it (8
workers, 32 tasks, 741 files changed, 83 commits, every cited commit verified present on the branch).

### The rules that came from those runs

- **The frame gate.** A browser pane that is not displayed stops compositing while still navigating and
  still returning plausible DOM, so a blind worker reports fiction with full confidence. Every browser path
  measures a one-second `requestAnimationFrame` count first. Before the gate: 8 of 8 workers blind and 94
  confident fabrications. After: 22 of 22 workers across two runs saw what they claimed to see.
- **The finding schema is a gate, not a request.** `fleet.sh find` refuses a finding with no evidence, a
  severity outside the four, or the retired field name. 246 of 246 findings in the audit run carry the
  stamps only that path writes.
- **Lanes.** A fleet queues for whatever the machine has one of: `pane` for the browser, `verify` for the
  test suite, `repo` for work that only reads files. `next` takes the lane as an argument and refuses to
  hand a paneless worker a browser task. The lanes are capped separately - the pane lane by the operator's
  display, the repo lane by the machine - because capping file work at the width of a monitor is how a run
  ends up eight browsers wide and two files wide.
- **Pending work mirrors unwritten obligations, in both directions.** A session runs only while something
  invokes it, so a worker with an obligation arms a clock; a worker with none must have nothing armed.
  Across the two runs 87 clocks were armed and none stopped, which cost 1,090 minutes and 282 model turns
  of session life after the workers' own completion markers. A clock now watches the disk that closes its
  obligation and exits on its own, so there is nothing left to remember.
- **A run ends visibly.** A generated banner from disk, the session renamed so the sidebar shows it
  finished, one notification for the whole run, and a `FINISHED` file that survives every missed
  notification.
- **Two panes, not ten.** Seven panes carried 104 minutes of browser driving in a 153-minute run; two
  carried three minutes in the run after it. The display fits five; the work has needed two.

### Rules that stopped being rules

Three of them were deleted rather than restated, because the measurement said asking harder would not
work:

- **The abort clock disarms itself.** `fleet.sh clock` prints a loop that watches for its own task's done
  marker and exits when it appears. The previous shape asked the worker to stop it: asked 87 times across
  two runs, obeyed zero times.
- **`drained` ends the worker.** It writes the marker, prints the banner generated from disk, and prints
  the exact session title to set. Four prose rules became one call.
- **`fleet.sh width` sizes the repo lane** from the ready queue and free memory, so the formula has one
  spelling instead of one per doc that quotes it.

The rule behind all three: a requirement belongs in a script when the script sits on a path the worker
already walks, in a hook when only the harness can see it, and in prose only when neither can - and prose
costs are paid on every read by every worker.

### What a stranger has to be able to do

- [`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md) is a fifteen-minute first run for somebody who has never used
  this: prove the machine can run it in one second, set a project up, plan, click two chips, read the
  banner. It names what to do when each of the five common failures appears.
- The README says **what the version number covers** and what is explicitly calibration rather than
  contract, and carries a troubleshooting section for the four failures that are not in this plugin: a
  stale plugin cache, a run directory inside a sync client, CRLF line endings on Windows, and Git Bash
  not being found.
- **The three side commands moved to their own plugin**, `makarasty-tools`, from the same marketplace.
  They travel with a fleet and have nothing to do with its contract, so they version apart from it.

### Measurements live in one place now

`docs/MEASUREMENTS.md` holds 23 entries: what was run, what was counted, how, and which rule it produced.
Rules carry the number and cite the entry (`[M04]`), so a reader deciding whether to remove a rule sees the
cost of removing it without paying for the story on every read. The self-test fails on a citation with no
entry and on an entry nothing cites.

`calibration.json` holds every constant a script or a planner reads — lane widths, the frame-gate
threshold, the budget multiplier, the fan-out width — with the measurement each came from. A number that a
script reads cannot go stale the way a number retyped into prose does.

### Hardened against what other people's runs already hit

Read from the issue trackers of comparable orchestrators and from classic file-queue designs:

- **`fleet.sh sweep`** names claims nobody is advancing and, with `--release`, hands them back. Atomic
  claiming prevents two workers taking one task and does nothing about a worker that died holding one.
- **A `Stop` hook** refuses, once, to let a worker end its turn on a claim it took in the last ten minutes
  and never touched again — the signature of the failure that cost one run 516 minutes, and the one thing
  here that no script can see. A worker that has written a heartbeat, or whose claim is older than that
  window, is left alone: that case belongs to the planner's stall report and `fleet.sh sweep`.
- **Portability**: one locale pinned, temp files with explicit templates, no `date -r` on a file (it means
  two different things on GNU and BSD), `.gitattributes` pinning shell scripts to LF so a Windows clone
  cannot produce a CRLF shebang.
- **A run directory on a sync client is documented as unsupported** rather than left to fail strangely.

### What ships

The fleet plugin: seven commands (`fleet`, `fleet-init`, `fleet-plan`, `fleet-run`, `fleet-login`,
`fleet-wait`, `fleet-collect`), three agents, the reference documents under `docs/`, and the scripts —
the queue bookkeeping and schema gate (`fleet.sh`), the reconciling merge (`fleet-merge.mjs`), the
self-test that runs the whole protocol against a temporary directory in about a second
(`fleet-selftest.sh`), a machine census (`fleet-load.mjs`), a post-run forensics reader
(`fleet-retro.mjs`), and the geometry probe (`visual-probe.js`).

The `makarasty-tools` plugin: `commit`, `review`, `unslop`, and the hook that carries the humanised reply
mode between prompts.

### Known limits, written down rather than fixed

- Every number here was measured on **one machine** (Windows 11, 31.2 GB, 16 cores), by **one operator**,
  against **one application**. They are real measurements and a weak sample.
- The **pane broker** (`docs/BROKER.md`) has never run live. Its mechanics carry 12 self-test assertions
  and nothing else.
- The **published install path is untested**: this release was developed and installed from a local
  directory marketplace.
- **Portability is half exercised.** `docs/PORTING.md` names eleven host assumptions and only Windows has
  run a fleet. The scripts are better tested than that: the self-test passes under `dash` as well as
  `bash`, so the POSIX claim is checked rather than asserted — but a real run on macOS or Linux has not
  happened.
- The self-test covers **mechanics only**. Whether a worker asks for its pane in the first minute, renames
  its session, or splits its own work sensibly is asked for in prose and enforced by nothing — and this
  plugin's own measurements include two cases of a prose rule being routed around. Where that mattered
  most, the rule was moved into a script instead; where it could not be, it is named here.
- `fleet-retro.mjs` reads the host's transcript layout directly and will break if that layout changes.
- The **eval suite in `evals/` has never been run**: `claude plugin eval` is in early access and was
  refused on the account this release was built on. Three cases are written against its documented shape,
  and they are the plugin's only test of whether a worker reading these documents does what they ask.
