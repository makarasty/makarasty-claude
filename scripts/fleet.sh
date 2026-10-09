#!/bin/sh
# fleet.sh - the protocol bookkeeping of a pull mode run, one call per boundary.
#
# Measured 2026-08-27 over a six worker run: 235 of 612 worker shell calls, 38 percent, were protocol
# paperwork done by hand - walk ready, mkdir the claim, write owner, read the task, append a finding,
# touch the done marker. Every one of them is a model round trip. This collapses them to one call each,
# and validates the finding schema on the way in, which is the only place a contract can be enforced
# rather than requested.
#
# Usage, from anywhere:
#   fleet.sh next    <run-dir> <chip> [lane]       claim the first free task in that lane, print it. exit 3 =
#                                                  drained, nothing left and nothing waiting. exit 7 = waiting:
#                                                  tasks exist but an `after:`, a held verify lane or `operator:` holds them.
#                                                  exit 8 = the run is paused. exit 9 = this chip was retired
#   fleet.sh beat    <run-dir> <chip> <task-id>    refresh heartbeat. exit 4 = claim lost, take another
#   fleet.sh clock   <run-dir> <chip> <task-id> [budget-min]   print the self-disarming abort clock to background
#   fleet.sh finish  <run-dir> <chip> <task-id> [branch]   mark the task done; its clock then exits on its own.
#                                                  A branch is written into the marker as `branch <name>`
#   fleet.sh find    <run-dir> <chip>              read one JSON finding on stdin, validate, append
#   fleet.sh ask     <run-dir> <chip>              worker: read a question on stdin, file it, print the path
#   fleet.sh answer  <run-dir> <id> [id...]        planner: one answer on stdin, filed under every id it settles
#   fleet.sh broadcast <run-dir>                   planner: append something every worker reads at its next boundary
#   fleet.sh file    <run-dir> <task-id> [path|-]  planner: file one task (stdin by default), checked: UTF-8,
#                                                  frontmatter, lane, task-id, no duplicate id. FILED or REFUSED
#   fleet.sh stranded <run-dir> [branch]           done tasks whose branch has commits integration lacks
#   fleet.sh cleared <run-dir> <task-id>           planner: the operator did a task's `operator:` part; next hands it out
#   fleet.sh procs   <run-dir> [--kill]            orphaned test runs and typechecks, and shells ended chat
#                                                  processes left; --kill ends those, never a tree serving something
#   fleet.sh drained <run-dir> <chip> [lane]       queue empty: write <chip>.done. exit 5 = queue still open,
#                                                  or a ready task in that lane nobody holds yet
#   fleet.sh chips   <run-dir> <NN>[-<NN>] [lane] [--model <id> [--effort <level>]]
#                                                  coordinator: the exact spawn_task title and prompt per worker,
#                                                  and the model and effort each should run on (want/<NN>)
#   fleet.sh status  <run-dir>                     planner view: claims, ages, markers, questions, lane gaps,
#                                                  workers and their models, budgets, coordinator context
#   fleet.sh whoami  <run-dir> <chip> <model> [effort]  worker: record the model, effort and plugin version it
#                                                  runs on. exit 10 = not what want/<chip> says: end the turn
#   fleet.sh ctx     <run-dir>                     one line per session whose context crosses its mark: the
#                                                  coordinator (coordinator_handoff_k) or a worker (worker_relaunch_k)
#   fleet.sh contexts <run-dir>                    every session the run knows: context in K, claim held, OVER
#   fleet.sh pause   <run-dir> [reason|-]          stop the run: next hands out nothing, hooks hold the workers.
#                                                  `-` reads the reason from stdin
#   fleet.sh resume  <run-dir> [--take-over]       lift the pause. Only --take-over (the new coordinator's chip
#                                                  prompt) takes the coordinator seat after a relaunch
#   fleet.sh paused  <run-dir> <chip>              worker ack: committed and stopped; prints the wake loop
#   fleet.sh retire  <run-dir> <chip>              coordinator: a queue worker past its context mark leaves at its
#                                                  next claim, its tree committed; prints the chip for its lane
#   fleet.sh handback <run-dir> <chip>             commit the chip's unsaved work, release its open claims, re-file
#                                                  each as <id>-r<n> (`continue-from:` its branch), write <chip>.retired
#   fleet.sh relaunch <run-dir> [--wait N] [--keep-coordinator] [NN...]  pause, wait for acks, hand the named
#                                                  chips' work back; run it again once STATE.md is current and it
#                                                  prints the chips. Run it in the background: it can wait minutes
#   fleet.sh sweep   <run-dir> [--release]         claims and pane walks nobody is advancing; --release
#                                                  moves the claim, its task and anything whose `after:`
#                                                  named it aside, for the planner to re-file under new ids
#   fleet.sh recover <run-dir> [--release]         cold start after a crash: which chips reopen with
#                                                  `claude -r`, which must be respawned, what is unheld
#   fleet.sh width   <run-dir>                     how many repo workers this queue and this machine want
#   fleet.sh pane-ask   <run-dir> <chip>           file a browser walk for a pane host to run, on stdin
#   fleet.sh pane-next  <run-dir> <host>           claim the oldest pending walk. exit 3 = none pending
#   fleet.sh pane-serve <run-dir> <host> <id>      answer one walk with JSON on stdin, gate reading included
#   fleet.sh pane-status <run-dir>                 backlog depth, oldest wait, median lease
#   fleet.sh summary <run-dir> [chip]              the end banner: counts from disk, plus one JSON line
#   fleet.sh worktree <run-dir> <chip> [path]      a worktree worker registers its tree (default cwd);
#                                                  `--create [base]` makes one first, base defaulting to the
#                                                  main checkout's current branch
#   fleet.sh unlink  <worktree-path>               unlink every junction/symlink in it, targets untouched
#   fleet.sh clean   <run-dir> [--remove]          remove THIS run's worktrees safely; dry run without --remove
#   fleet.sh landed  <run-dir> <expected-chips>    is the run genuinely finished? exit 0 yes, 1 no
#   fleet.sh merge   <run-dir>                     findings -> backlog.jsonl, reconciled or refused
#   fleet.sh render  <run-dir>                     backlog.jsonl -> backlog.md and skipped.md
#   fleet.sh fixqueue <run-dir>                    backlog.jsonl -> a queue a second fleet can claim
#
# The run directory carries a RUN_FORMAT file naming the layout's major version. A newer format is
# refused rather than misread.
#
# The commands run in fleet.mjs beside this file, compiled from src/scripts/fleet.mts (edit that, then
# `npm run build --prefix src`). This was 3,000 lines of POSIX sh until 2026-10-09, and on Git Bash a fork
# costs about 25 ms: `next` on a 62-task queue took 3-8 s and `status` 5-12 s, against 0.1-0.6 s and 0.13 s
# in node [M37]. This file stays the one stable entry every command, skill and worker calls, in plain sh.

case $0 in */*|*\\*) _here=${0%[/\\]*} ;; *) _here=. ;; esac
command -v node >/dev/null 2>&1 || {
  echo "fleet.sh needs Node.js 20.11 or newer (https://nodejs.org): its commands run in $_here/fleet.mjs." >&2
  exit 2
}
# node.exe under a Git Bash terminal sees a pipe where the shell sees a terminal; `file` asks which it is.
FLEET_STDIN_TTY=; if [ -t 0 ]; then FLEET_STDIN_TTY=1; fi; export FLEET_STDIN_TTY
exec node "$_here/fleet.mjs" "$0" "$@"
