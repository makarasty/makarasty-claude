# The gate between a finding and a change

A run finds well. Across seventeen runs on one application, 7 findings of 2,851 carried neither a
`file:line` nor a single number, so the evidence contract holds where it was put. What those runs also show
is that nothing between the backlog and the product exercises judgement, and three failures follow from
that. This page is the stage that answers them, and `scripts/fleet-gate.mjs` is all of it.

Everything here is a refusal wired to an executed command or a string match. That is deliberate. A
published campaign over 31 days had ten dedicated reviewers unanimously endorse a padding oracle that did
not exist, and it was killed by one empirical test — which is why the same paper's pipeline made an
empirical gate mandatory, and why adding a fourth reviewer to this plugin would have bought nothing.
Opinions correlate. A test does not.

The three failures, and what refuses each:

| What went wrong | What refuses it now |
|---|---|
| A fix landed on the strength of its own argument | `prove` / `check` — a reproduction that failed before and passes after, over a tree that moved |
| One cause was patched once per surface, three times | `cluster` — the shared seam becomes one task and the rest wait behind it |
| A change broke a consumer nobody in the run could see | `fleet-contract.mjs` — the edit is blocked until a question or a recorded decision names it |

## Where it sits

```bash
g=$(ls -t ~/.claude/plugins/cache/*/makarasty/*/scripts/fleet-gate.mjs | head -1)

sh  "$f" merge    .fleet/<run-id>                 # findings -> backlog.jsonl
sh  "$f" fixqueue .fleet/<run-id>                 # backlog -> one task per finding
node "$g" cluster .fleet/<run-id> --queue .fleet/fix-<run-id>   # and the roots in front of them
```

`cluster` runs after `fixqueue` and rewrites what it wrote. It never touches findings.

## surface — the names this project promised somebody outside it

```bash
node "$g" surface .            # -> .fleet/contract-surface.txt
```

Routes, exported names, configuration keys, event names, read out of the tracked files by pattern. It errs
wide on purpose. A token in here that nothing depends on costs a worker one question; a token missing from
here costs the outage the whole mechanism exists to prevent.

**The file is meant to be edited.** It is a plain three-column text file, and a project knows things the
patterns cannot: that one endpoint is internal, that a config key was deprecated last year, that a
generated client re-exports half of `api.ts`. Cut those lines and commit the file.

It will miss a route built by concatenation and a key read through a variable. That ceiling is marked in
the script, and the answer to it is the same one: add the line by hand.

Regenerate after a release, or whenever a run starts asking about names that no longer exist.

## The hook

`hooks/fleet-contract.mjs` runs on `PreToolUse` for `Edit`, `Write`, `MultiEdit` and `NotebookEdit`. It
compares the two sides of the edit and fires only when a surface token is in the text going out and not in
the text coming in. Present on both sides is a line being worked around; present on neither is an edit that
never touched it.

It is timid on the same principle as `fleet-guard.mjs`: no fleet under the working directory, no chip
registered for this session, or no `contract-surface.txt` and it exits 0 without a word. It raises a given
name once per session, ever, and records that it did — a hook that repeats itself is one workers learn to
route around.

When it fires there are two ways past, both one command, and the edit goes through on either:

- **Ask**, when a person's answer would change what you do. `ask/<chip>-<n>.md`, naming the token, what
  breaks, and your recommendation. Then take another task; blocking on an answer turns a question into a
  stall.
- **Decide**, when it would not. `fleet-gate.mjs decide`, with the token and your rationale as JSON on
  stdin. The token goes on stdin rather than in an argument because Git Bash rewrites any argument
  beginning with a slash into a Windows path, and a route is the commonest token there is.

Deciding is legitimate. Deciding silently is what shipped two endpoints behind authentication and broke
monitoring nobody in the run could see. `decisions.jsonl` is one line each and the operator reads them
before the run lands.

## cluster — candidates, not diagnoses

The merge holds one symptom in two areas apart on purpose: proving a shared cause is judgement and that
pass is mechanical. What *is* mechanical is the candidate. Findings whose evidence names the same file, or
whose stated mechanism names the same identifier, in areas that different workers owned.

Two ceilings, both measured against a 436-finding backlog:

- **A candidate over six findings wide is a place, not a defect.** That backlog offered one 51 findings
  wide, because they all touched a 5,000-line command file. Gating fifty-one tasks behind one worker
  serialises the run and returns nothing the file-cluster split does not already give. Those are listed as
  hotspots and gate nothing.
- **A token more than 15% of the run mentions is the project's vocabulary.** With no such cut, `forEach`
  and `playerData` came out as candidate causes.

Identifiers are read from the mechanism and the observation, never from the evidence: reading the whole
finding catches the subsystem's vocabulary, which every finding in that subsystem shares and none of them
is explained by. File paths cited at two depths — `Timer.java` and `.../arc/util/Timer.java` — are one
file, and the longest spelling is the one printed.

What lands in the queue is one `kind: root` task per surviving candidate, and `after: task-root-NNN` on
each member. That field is the queue's own ordering mechanism and `fleet.sh next` already enforces it, so
a member cannot be claimed until the root has a done marker.

**The root task is the one place exclusive file ownership does not apply**, which is the whole point:
every task it gates is held while it runs, so nothing is editing beside it. That exclusivity is why a
shared seam went unfixed through three runs while three separate documents recorded that it should be
fixed once.

**Refuting is a complete result.** A root that finds the shared name to be a coincidence writes that down
and finishes; the members unblock on the done marker either way and are then fixed on their own evidence.
Roughly 15 findings in every 100 are refuted the moment somebody tries to fix them, and almost always the
mechanism rather than the symptom, so a root that never refuted anything is not ruling on anything.

## prove and check — the reproduction, executed

```bash
node "$g" prove .fleet/<run-id> <task-id> before -- <the reproduction>   # expected to fail
# ... make the change ...
node "$g" prove .fleet/<run-id> <task-id> after  -- <the same command>   # expected to pass
```

`prove` runs the command rather than recording a claim about it, and writes the exit code, the commit, and
a digest of the working tree into the claim. `check` refuses the task unless all five hold:

1. A `before` exists. 2. An `after` exists. 3. `before` failed. 4. `after` passed. 5. The tree moved
between them, and the command was the same one.

The fifth is not pedantry. A build daemon that died mid-run on a real fix run returned `BUILD SUCCESSFUL,
0 failures` over a tree whose fix had been reverted, and only a forced rebuild found it. A green whose tree
is byte for byte the red one's proves nothing whatever its exit code says. The run's own directory is
excluded from that digest, since recording the `before` proof would otherwise move the tree by itself.

A `before` that passes is a refutation and says so. That is the cheapest good news a fix run gets: the
finding was wrong, nothing needs changing, and it cost one command.

## asks — the open questions as one round

```bash
node "$g" asks .fleet/<run-id>
```

Every question with no answer beside it, each with the recommendation its worker filed, and the decisions
taken without asking listed underneath. Measured over four runs on one project, 86 questions were asked
and 85 answered — the mechanism works and the operator answers. What costs them is the shape: a question
arriving alone in a chat they are not sitting in is a context switch each time, and eight answered in one
pass is one.

## What this does not do

- **It does not rank, and it does not decide what is worth fixing.** That is still the backlog's severity
  and the operator's call.
- **It does not verify the fix is good**, only that the reproduction moved. A reproduction that tests the
  wrong thing passes this gate. The project's own tests are still the project's own tests.
- **The surface is a heuristic over text.** Everything in "surface" above about what it misses is a real
  limit, not a caveat.
- **`cluster` proves nothing.** It generates candidates a person or a model then rules on, and the ruling
  is the root task's whole job.
