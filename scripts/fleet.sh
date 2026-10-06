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
#   fleet.sh procs   <run-dir> [--kill]            orphaned test runs and typechecks; --kill ends only those
#   fleet.sh drained <run-dir> <chip> [lane]       queue empty: write <chip>.done. exit 5 = queue still open,
#                                                  or a ready task in that lane nobody holds yet
#   fleet.sh chips   <run-dir> <NN>[-<NN>] [lane]  coordinator: the exact spawn_task title and prompt per worker
#   fleet.sh status  <run-dir>                     planner view: claims, ages, markers, questions, lane gaps,
#                                                  workers and their models, budgets, coordinator context
#   fleet.sh whoami  <run-dir> <chip> <model> [effort]  worker: record the model, effort and plugin version it runs on
#   fleet.sh ctx     <run-dir>                     one line per session whose context crosses its mark: the
#                                                  coordinator (coordinator_handoff_k) or a worker (worker_relaunch_k)
#   fleet.sh contexts <run-dir>                    every session the run knows: context in K, claim held, OVER
#   fleet.sh pause   <run-dir> [reason|-]          stop the run: next hands out nothing, hooks hold the workers.
#                                                  `-` reads the reason from stdin
#   fleet.sh resume  <run-dir> [--take-over]       lift the pause. Only --take-over (the new coordinator's chip
#                                                  prompt) takes the coordinator seat after a relaunch
#   fleet.sh paused  <run-dir> <chip>              worker ack: committed and stopped; prints the wake loop
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
# POSIX sh. Works in Git Bash on Windows. Node validates a finding, and its absence downgrades that to a
# warning rather than a failure. It also reads every file mtime, and the three commands whose whole answer
# is an age - sweep, recover, pane-status - refuse without it rather than call a dead fleet healthy.

set -eu

# Sorting, matching and character classes change under a non-C locale, and a run directory is compared
# across machines. Pin it rather than inherit whatever the operator's shell has.
LC_ALL=C
export LC_ALL

# A bare `mktemp` is not portable between GNU and BSD, and the template keeps the file recognisable when
# something goes wrong mid-run.
tmpfile() { mktemp "${TMPDIR:-/tmp}/fleet.XXXXXX"; }

# `date -r FILE` reads a file's mtime on GNU and reinterprets the argument as epoch seconds on BSD, so the
# same line returns a plausible wrong number on macOS. Ask node, which this script already needs.
mtime() {
  if command -v node >/dev/null 2>&1; then
    node -e 'try{process.stdout.write(String(Math.floor(require("fs").statSync(process.argv[1]).mtimeMs/1000)))}catch{}' "$1" 2>/dev/null
  fi
}

# Without node that reading is empty, and every command that asks for an age then treats "unknown" as
# zero: `sweep` calls a claim quiet for 0 minutes and reports a dead fleet healthy, `recover` sends every
# live chip down the RESUME branch, `pane-status` says no walk has waited. The finding gate degrades
# loudly when node is absent for the same reason - an answer nothing stands behind is worse than a
# refusal, and these are the commands that release other workers' claims.
need_mtime() { # need_mtime <what this command would otherwise be guessing about>
  command -v node >/dev/null 2>&1 && return 0
  echo "REFUSED: node is absent, so no file's mtime can be read and $1 would be a guess." >&2
  echo "  Install node, or answer it by hand: this command has no second source for an age." >&2
  exit 2
}

cmd=${1:-}; run=${2:-}
[ -n "$cmd" ] && [ -n "$run" ] || { echo "usage: fleet.sh <command> <run-dir> [args]" >&2; exit 2; }
# A relative run directory is relative to wherever the caller stands, and a worker stands in a worktree,
# where `.fleet/` is gitignored and so never exists. Every spelling in the documents is `.fleet/<run-id>`,
# so before refusing, look for it where it actually lives: the main checkout, which git's common directory
# names from any worktree.
if [ ! -d "$run" ]; then
  case "$run" in /*|[A-Za-z]:*) ;; *)
    _cm=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || _cm=
    if [ -n "$_cm" ] && [ -d "$(dirname "$_cm")/$run" ]; then run="$(dirname "$_cm")/$run"; fi ;;
  esac
fi
[ -d "$run" ] || { echo "no such run directory: $run" >&2; exit 2; }
now() { date -Iseconds 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ; }

# The run directory as somewhere else can reach it. Everything this script prints for a caller to run
# later - the abort clock, the poll - is backgrounded from a worktree, and `.fleet/` is gitignored, so a
# relative run directory names nothing there: a clock's exit conditions could never be met and it ran its
# full term, up to eight hours, before waking a session that finished at the first one. Git's own
# spelling, which is what a worker's own paths are in.
absdir() { ( CDPATH= cd -- "$1" 2>/dev/null && { pwd -W 2>/dev/null || pwd; } ) || printf '%s' "$1"; }
absrun=$(absdir "$run")

# The on-disk run layout is the thing this tool promises to keep working. Stamp its major version into the
# run at the first write, so a reader a year from now can refuse a shape it does not know instead of
# quietly misreading it. The schema has already had one breaking rename (`what` -> `observed`); the next
# one should not be silent.
RUN_FORMAT=1

# Constants live in calibration.json, never in a script and never in prose: a number that a planner reads
# and a script reads must have one spelling. Falls back to the built-in default when the file is absent,
# so nothing here depends on it existing.
#
# Read once, at startup, into shell variables. It used to spawn `ls` and a fresh `node` per lookup, on the
# hottest path in the protocol - `next` asks for two or three constants, `width` for four, `clock` for two
# - which is a process tree per number. The file is one flat object of numbers, so sed reads all of them
# in a single pass and without node, which also means the calibration is honoured on a machine that has
# none rather than silently replaced by the defaults.
# Where this plugin is, from the inside. Every file this script reaches for is either beside it or under
# the copy the host says it installed, and those are the only two answers worth having.
#
# It used to be `ls -t <sibling> <cache glob> | head -1`, which sorts by modification time across both -
# so the answer changed whenever anything touched a cached directory. On the machine this was written on
# the cache held five snapshots, the newest by mtime was nine days behind the newest by version, and the
# host had a sixth answer that was right: `~/.claude/plugins/installed_plugins.json` records the path it
# installed. Ask that, and fall back to the glob only for a checkout that was never installed.
beside() { # beside <path relative to this script> [<plugin name>]
  if [ -e "$(dirname "$0")/$1" ]; then printf %s "$(dirname "$0")/$1"; return 0; fi
  _pkg=${2:-makarasty}
  if command -v node >/dev/null 2>&1; then
    # `|| _root=`: under `set -e` a failed lookup - no install record, a plugin not installed - otherwise
    # ends the whole script from inside this substitution, silently and with exit 1.
    _root=$(PKG="$_pkg" node -p 'JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.claude/plugins/installed_plugins.json","utf8")).plugins[process.env.PKG+"@makarasty"][0].installPath.split(String.fromCharCode(92)).join("/")' 2>/dev/null) || _root=
    if [ -n "$_root" ] && [ -e "$_root/$3" ]; then printf %s "$_root/$3"; return 0; fi
  fi
  ls -t ~/.claude/plugins/cache/*/"$_pkg"/*/"$3" 2>/dev/null | head -1
}

# The version of the plugin this fleet.sh came from. A chat keeps the plugin it started with until Claude
# Code restarts, so one run can hold workers on two protocols: measured 2026-10-05, 137 of 200 done markers
# came from 1.5.2 workers and carried no branch line, and the coordinator found out by reading them.
plugin_version() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$(dirname "$0")/../.claude-plugin/plugin.json" 2>/dev/null | head -1 | grep . || echo unknown
}
# The version the host has installed, which is what a chat started after a restart runs; this fleet.sh's
# own when there is no install record (a checkout) or no node.
installed_version() {
  _v=$(node -p 'const fs=require("fs"),os=require("os");const p=JSON.parse(fs.readFileSync(os.homedir()+"/.claude/plugins/installed_plugins.json","utf8")).plugins["makarasty@makarasty"][0].installPath;JSON.parse(fs.readFileSync(p+"/.claude-plugin/plugin.json","utf8")).version' 2>/dev/null) || _v=
  printf '%s' "${_v:-$(plugin_version)}"
}
# What a task's frontmatter says the operator still owes, or nothing. Only the frontmatter: a body line
# beginning `operator:` is prose.
operator_owed() { # operator_owed <task file>
  awk 'NR==1 && /^---/ {fm=1; next} fm && /^---/ {exit} fm && /^operator:/ {v=$0; sub(/^operator:[ \t]*/, "", v); sub(/[ \t\r]+$/, "", v); if (tolower(v) !~ /^(none|no|-|n.a|nothing|false|done)?$/) print v; exit}' "$1" 2>/dev/null
}
# version_readable <v>: digits and dots only; anything else (unknown, a pre-release) is not compared.
version_readable() { case "$1" in ''|*[!0-9.]*) return 1 ;; esac; }
# version_older <a> <b>: true when a sorts before b as a version (1.5.9 < 1.5.10).
version_older() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$1" ]; }

_calfile=$(beside ../calibration.json makarasty calibration.json)
if [ -n "$_calfile" ]; then
  # A bare key holding a bare number, anchored at both ends, so nothing that is not a constant - a
  # provenance sentence, a nested object - can reach `eval`.
  _calkv=$(sed -n 's/^[[:space:]]*"\([A-Za-z_][A-Za-z0-9_]*\)"[[:space:]]*:[[:space:]]*\([0-9][0-9.]*\)[[:space:]]*,\{0,1\}[[:space:]]*$/CAL_\1=\2/p' "$_calfile" 2>/dev/null)
  if [ -n "$_calkv" ]; then eval "$_calkv"; fi
fi
cal() { # cal <key> <default>
  eval "_v=\${CAL_$1:-}"
  case ${_v:-} in ''|*[!0-9.]*) echo "$2" ;; *) echo "$_v" ;; esac
}
# The constants that reach shell arithmetic. `$(( 25 * 1.5 ))` is a syntax error and `/ 0` a crash, and in
# `next` that landed after the claim was made: the claim stood and the task was never printed.
calint() { # calint <key> <default>; a whole number of at least 1, or the default
  _i=$(cal "$1" "$2")
  case $_i in ''|*[!0-9]*) ;; *) [ "$_i" -ge 1 ] && { echo "$_i"; return; } ;; esac
  echo "calibration: $1 = $_i is not a whole number of at least 1, using $2" >&2
  echo "$2"
}
# The memory census, as a path somewhere else can run. FLEET_LOAD names another census script, exactly as
# it does for hooks/fleet-memory.mjs: the refusal depends on what the machine has free, so a test needs a
# door to a census that answers what it is told.
load_script() {
  _l=${FLEET_LOAD:-}
  [ -n "$_l" ] && [ -e "$_l" ] || _l=$(beside fleet-load.mjs makarasty scripts/fleet-load.mjs)
  [ -n "$_l" ] || return 0
  # Absolute, because the wait is backgrounded by a worker whose working directory may be a worktree with
  # no relation to this checkout - the defect the abort clock carried for a month. An empty answer stays
  # empty: made absolute it named the current directory and every claim read as MACHINE TIGHT.
  case "$_l" in /*|[A-Za-z]:*) ;; *) _l=$(cd "$(dirname "$_l")" 2>/dev/null && pwd)/$(basename "$_l") ;; esac
  printf '%s' "$_l"
}
stamp() { [ -e "$run/RUN_FORMAT" ] || printf '%s\n' "$RUN_FORMAT" > "$run/RUN_FORMAT" 2>/dev/null || true; }
readable() {
  [ -e "$run/RUN_FORMAT" ] || return 0
  have=$(head -1 "$run/RUN_FORMAT" 2>/dev/null | tr -dc 0-9)
  [ -n "$have" ] || return 0
  if [ "$have" -gt "$RUN_FORMAT" ]; then
    echo "REFUSED: this run is format $have and this fleet.sh reads format $RUN_FORMAT" >&2
    echo "  Update the plugin rather than reading it with the wrong shape." >&2
    exit 2
  fi
}
readable

# WHY THIS EXISTS, before what it does - because the reason is what makes the rule survive an edit:
#
# A path is almost never got wrong in the middle. It is got wrong at the END, and always the same way: a
# variable that was empty, a `dirname` taken once too often, a split on the wrong character, a prefix
# stripped twice. Every one of those turns a path into its own PARENT. So the depth of a path is exactly
# its margin for error, counted in mistakes:
#
#   C:/wtmerge                        one slip from C:/ - the whole drive
#   <project>/.claude/worktrees/wtA   seven slips from C:/, and the first four land in directories this
#                                     plugin owns and would refuse
#
# A worktree at the root of a drive has no margin at all. Nothing about it is wrong today; it becomes
# wrong the first time somebody edits the deletion code and is slightly careless, and by then it takes the
# disk with it. Depth is the cheapest defence there is against a mistake nobody has made yet.
#
# Therefore: this plugin deletes nothing that is not absolute, deep, free of `..`, inside a directory it
# owns, and outside its own working directory.
#
# Callers set MIN_PATH_SEGMENTS once with `min_floor` before their loop, because `unsafe_path` usually
# runs inside a command substitution and a value cached inside it would not survive the subshell.
min_floor() {
  _m=$(cal min_path_segments 4)
  # A floor that is not a whole number silently disables the comparison: `[ 3 -lt 2.5 ]` errors out
  # rather than answering, so a malformed calibration file would remove the guard instead of tightening it.
  case ${_m:-} in ''|*[!0-9]*) _m=4 ;; esac
  [ "$_m" -lt 2 ] && _m=2
  echo "$_m"
}

unsafe_path() { # unsafe_path <path> <required-segment> [nothing-is-deleted]; prints the reason, returns 0 when UNSAFE
  _p=${1:-}; _need=${2:-}; _keeps=${3:-}
  [ -n "$_p" ] || { echo "the path is empty"; return 0; }
  _p=${_p%/}   # a trailing slash must not change any answer below
  case "$_p" in
    //*) echo "$_p is a network path, which this does not delete"; return 0 ;;
    /*|[A-Za-z]:/*) ;;
    *) echo "$_p is not absolute, so what it points at depends on where this ran"; return 0 ;;
  esac
  case "/$_p/" in
    */../*) echo "$_p contains .., so where it lands cannot be read off the path"; return 0 ;;
    */./*)  echo "$_p contains a . segment, which hides how deep it really is"; return 0 ;;
  esac
  # Count named components with any drive letter dropped first, so Windows and POSIX are measured on one
  # scale: C:/a/b/c and /a/b/c are both three.
  _bare=${_p#[A-Za-z]:}
  _depth=$(printf '%s\n' "$_bare" | tr '/' '\n' | grep -c . || true)
  _min=${MIN_PATH_SEGMENTS:-4}
  if [ "${_depth:-0}" -lt "$_min" ]; then
    echo "$_p is ${_depth:-0} level(s) below the root and the floor is $_min: too shallow to delete safely"
    return 0
  fi
  if [ -n "$_need" ]; then
    # Something must FOLLOW the segment: the `worktrees` directory itself is not a worktree, and deleting
    # it would take every other run's trees with it.
    case "/$_p/" in
      *"/$_need/"?*) ;;
      *) echo "$_p is not inside a $_need directory, the only place this may delete"; return 0 ;;
    esac
  fi
  # Deleting the directory this shell is standing in, or one above it, is how a script removes its own
  # footing and then keeps going. Read the working directory in git's own spelling: under Git Bash `pwd`
  # says /c/Users/... while git says C:/Users/..., so the plain form never matched and this guard was
  # inert on the platform it was written for.
  #
  # It is a rule about DELETION, so a caller that deletes nothing passes a third argument and skips it.
  # Without that, the two commands a worker runs from inside its own tree refused themselves: `unlink`
  # removes reparse points inside the tree and leaves the tree, and registration only writes a file, yet
  # both were told the path contains this shell's working directory - which is the documented way to call
  # them (docs/WORKTREES.md), and the step [M32] exists to enforce.
  if [ -z "$_keeps" ]; then
    _here=$(pwd -W 2>/dev/null || pwd 2>/dev/null || echo "")
    if [ -n "$_here" ]; then
      _lh=$(printf '%s' "${_here%/}" | tr 'A-Z' 'a-z')
      _lp=$(printf '%s' "$_p" | tr 'A-Z' 'a-z')
      case "$_lh/" in "$_lp"/*) echo "$_p is this shell's working directory or one above it"; return 0 ;; esac
    fi
  fi
  return 1
}

# Unlink every reparse point inside a tree, at any depth, leaving what they point at alone. This is the
# step that makes a later recursive delete safe: `git worktree remove` follows a junction and removes the
# target's contents, at the top level and nested [M32]. `find -type l` sees junctions on Windows and does
# not descend into them.
unlink_links() { # unlink_links <dir>; prints how many it removed
  _d=$1; _t=$(tmpfile); _n=0
  find "$_d" -type l -print > "$_t" 2>/dev/null || true
  while IFS= read -r _e; do
    [ -n "$_e" ] || continue
    rm "$_e" 2>/dev/null || true
    # Windows: coreutils sometimes will not drop a junction. `rmdir` removes the link, never its target.
    if { [ -L "$_e" ] || [ -e "$_e" ]; } && command -v cmd >/dev/null 2>&1; then
      _dd=$(dirname "$_e"); _bb=$(basename "$_e")
      ( cd "$_dd" && MSYS_NO_PATHCONV=1 cmd //c "rmdir \"$_bb\"" >/dev/null 2>&1 ) || true
    fi
    # Counted only once it is really gone. Callers re-scan rather than trust this number.
    [ -L "$_e" ] || [ -e "$_e" ] || _n=$((_n + 1))
  done < "$_t"
  rm -f "$_t"
  echo "$_n"
}

# One spelling of "which files in this directory are a chip's findings". The rows of `summary` walked
# every `*.jsonl` while its totals - and the count `landed` pages to the phone - walked `[0-9]*.jsonl`, so
# a run with a chip id like `cid-03`, which fleet-retro.mjs has recorded since 2026-09-03, printed rows
# full of findings above a total of 0.
chipids() {
  for _f in "$run"/*.jsonl; do
    [ -e "$_f" ] || continue
    _c=$(basename "$_f" .jsonl)
    # backlog, skipped and unreached are what the merge writes into the same directory.
    case "$_c" in backlog|skipped|unreached) continue ;; esac
    printf '%s\n' "$_c"
  done
}
chipcat() { chipids | while IFS= read -r _c; do cat "$run/$_c.jsonl"; done; }

# ---- pause and relaunch: the shared pieces ---------------------------------------------------------------
#
# The global marker is how hooks/run-dir.mjs finds a paused run without looking at the working directory:
# one file per paused run, named by a checksum of its absolute path and holding that path. A hook in a
# session with no fleet reads this directory once, finds it missing or empty, and does nothing else.
pausedroot() { printf '%s' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/makarasty/paused"; }
pausemark() { printf '%s/%s' "$(pausedroot)" "$(printf '%s' "$absrun" | cksum | cut -d' ' -f1)"; }
# The second kind of marker, in the same directory so a session with no fleet still pays one readdir: it says
# "this run has retired a chip", and unlike the pause marker it outlives the pause - a retired worker stays
# held after the resume. `landed` removes it with the run's FINISHED.
retiredmark() { printf '%s.retired' "$(pausemark)"; }

# Who this session is, so the hooks can tell a worker from any other chat on the machine. Called at the top of
# `next`, `drained` and `paused` - BEFORE any exit for a pause, a retirement or a drained queue - because a
# worker whose only calls were answered "paused" or "waiting" was otherwise never in the chip map and the pause
# hook never held it. The coordinator's own session is never registered: a coordinator that ran `paused` or
# `next` to look at the output would otherwise be held like a worker.
register_chip() { # register_chip <chip>
  [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] || return 0
  if [ "$(head -1 "$run/coordinator" 2>/dev/null | tr -d '\r')" = "$CLAUDE_CODE_SESSION_ID" ]; then return 0; fi
  mkdir -p "$run/chips" && printf '%s' "$1" > "$run/chips/$CLAUDE_CODE_SESSION_ID" || true
  fleet_session
}
# This session belongs to a fleet run, recorded where the tools plugin's context hook looks: a fleet chat's
# context is watched by the run's own marks (`ctx`), so the general "offer a handoff" reminder stays silent
# in it. Measured 2026-10-05: three reminders made a coordinator offer a handoff twelve times, workers that
# the reminder's own text exempted offered too, and one coordinator handed off at 448K unasked.
# `landed` removes this run's records.
fleetsessions() { printf '%s' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/makarasty/fleet-sessions"; }
fleet_session() {
  [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] || return 0
  { mkdir -p "$(fleetsessions)" && printf '%s\n' "$absrun" > "$(fleetsessions)/$CLAUDE_CODE_SESSION_ID"; } 2>/dev/null || true
}

# A brief worker holds no claim; it has something in hand from the moment it registers until its .done,
# .blocked or .retired.
brief_busy() { # brief_busy <chip>
  [ -e "$run/brief-$1.md" ] && [ ! -e "$run/$1.done" ] && [ ! -e "$run/$1.blocked" ] && [ ! -e "$run/$1.retired" ]
}
# Chips with something in hand, one per line: an open claim (not done, released or dead), or a registered
# brief worker that has not finished. chips/ also holds <chip>.model and <session>.pause-notice; a session's
# own file has no dot.
claim_holders() {
  {
    for _d in "$run"/tasks/claimed/*/; do
      [ -d "$_d" ] || continue
      _i=$(basename "$_d")
      case "$_i" in *.dead-*|*.released-*) continue ;; esac
      [ -e "$run/tasks/done/$_i" ] && continue
      sed -n 's/^chip //p' "$_d/owner" 2>/dev/null | head -1 | tr -d '\r'
    done
    for _f in "$run"/chips/*; do
      [ -f "$_f" ] || continue
      case "$(basename "$_f")" in *.*) continue ;; esac
      _c=$(head -1 "$_f" | tr -d '\r')
      if [ -n "$_c" ] && brief_busy "$_c"; then echo "$_c"; fi
    done
  } | sort -u
}
# The open claims of one chip, one id per line.
claims_of() { # claims_of <chip>
  for _d in "$run"/tasks/claimed/*/; do
    [ -d "$_d" ] || continue
    _i=$(basename "$_d")
    case "$_i" in *.dead-*|*.released-*) continue ;; esac
    [ -e "$run/tasks/done/$_i" ] && continue
    if grep -q "^chip $1\$" "$_d/owner" 2>/dev/null; then printf '%s\n' "$_i"; fi
  done
}

# What a stopped worker backgrounds. It wakes on the three things that matter and says which: the pause
# lifted, the chip retired by a relaunch, or the run landed. It is built from git, sleep and `[`, which is
# exactly what the hook's allow-list lets through while the run is paused.
wake_loop() { # wake_loop <chip>
  _ps=$(calint clock_poll_seconds 30)
  printf '  until [ ! -e "%s/PAUSED" ] || [ -e "%s/%s.retired" ] || [ -e "%s/FINISHED" ]; do sleep %s; done; if [ -e "%s/%s.retired" ]; then echo retired; elif [ -e "%s/FINISHED" ]; then echo run-finished; else echo resumed; fi\n' \
    "$absrun" "$absrun" "$1" "$absrun" "$_ps" "$absrun" "$1" "$absrun"
}

# Each worker chip with the newest session that registered as it, "<chip> <session>" per line. A chip that
# was reopened has two sessions in `chips/`, and the old one's transcript stops growing, so reading both
# would report a context nobody is using. Files with a dot are per-session marks (`<sid>.warned-*`) and the
# `<chip>.model` record, never a session.
worker_sessions() {
  _seen=" "
  for _f in $(ls -t "$run/chips" 2>/dev/null); do
    case "$_f" in *.*) continue ;; esac
    [ -f "$run/chips/$_f" ] || continue
    _c=$(head -1 "$run/chips/$_f" | tr -d '\r')
    [ -n "$_c" ] || continue
    case "$_seen" in *" $_c "*) continue ;; esac
    _seen="$_seen$_c "
    printf '%s %s\n' "$_c" "$_f"
  done
}
chip_finished() { [ -e "$run/$1.done" ] || [ -e "$run/$1.blocked" ] || [ -e "$run/$1.retired" ]; }
# Seconds since the pause began, from the mtime of PAUSED (which only `pause` writes, and only once).
pause_age() {
  _pm=$(mtime "$run/PAUSED"); [ -n "$_pm" ] || { echo 0; return; }
  echo $(( $(date +%s 2>/dev/null || echo "$_pm") - _pm ))
}

# A task handed back, and every task that was waiting on it. `after:` holds a task until the one it names
# is done, so releasing a task whose dependents are still queued leaves them waiting on a done marker
# nobody will write: `next` answers QUEUE WAITING for the rest of the run and `landed` refuses over it.
# The wave's later stages go back to the planner with the stage that died, which is the only way the wave
# comes back with consistent ids - and keeping the id instead is what the graveyard rename exists to
# prevent, because a slow worker's late write would then land on live work.
release_task() { # release_task <task-id>; prints one line per dependent it took with it
  _todo=$1
  while [ -n "$_todo" ]; do
    set -- $_todo; _id=$1; shift; _todo=$*   # a task id never carries a space, so the split is the list
    [ -e "$run/tasks/ready/$_id.md" ] || continue
    mkdir -p "$run/tasks/released"
    mv "$run/tasks/ready/$_id.md" "$run/tasks/released/$_id.md"
    for _f in "$run"/tasks/ready/*.md; do
      [ -e "$_f" ] || continue
      _b=$(basename "$_f" .md)
      # A dependent somebody is already working is theirs: taking its file away mid-task is the failure
      # this whole graveyard exists to avoid.
      [ -d "$run/tasks/claimed/$_b" ] && continue
      [ -e "$run/tasks/done/$_b" ] && continue
      for _d in $(sed -n 's/^after:[[:space:]]*\(.*\)/\1/p' "$_f" | head -1 | tr ',\r' '  '); do
        if [ "$_d" = "$_id" ]; then
          echo "  also released $_b: its \`after:\` named $_id, which nobody finished"
          _todo="${_todo:+$_todo }$_b"
        fi
      done
    done
  done
}

# The verify task somebody is holding, if any. The lane is one worker wide across the whole fleet
# (docs/LANES.md): a full typecheck and a full test suite running at once is how this machine goes into
# the pagefile.
# Lanes the queue holds open work for and no chip was offered for, one line each, or nothing. A task nobody
# can claim is invisible from every worker's side - each one reports "nothing in my lane" - so the gap is
# only visible here, where the queue and the offered chips meet. Repo workers take verify tasks.
lane_gaps() {
  _need=""
  for _f in "$run"/tasks/ready/*.md; do
    [ -e "$_f" ] || continue
    _id=$(basename "$_f" .md)
    [ -e "$run/tasks/done/$_id" ] && continue
    [ -d "$run/tasks/claimed/$_id" ] && continue
    _l=$(sed -n 's/^needs:[[:space:]]*\([a-z][a-z]*\).*/\1/p' "$_f" | head -1)
    _need="$_need ${_l:-repo}"
  done
  [ -n "$_need" ] || return 0
  # A chip whose worker wrote `.done` or `.blocked` is not a worker any more: counting it hid every lane
  # its worker had already left, which is exactly when a queue still holding work needs a new chip.
  _have=" "
  for _o in "$run"/offered/*; do
    [ -e "$_o" ] || continue
    _nn=$(basename "$_o")
    if [ -e "$run/$_nn.done" ] || [ -e "$run/$_nn.blocked" ] || [ -e "$run/$_nn.retired" ]; then continue; fi
    _have="$_have$(cat "$_o" 2>/dev/null | tr '\n' ' ') "
  done
  for _l in $(printf '%s\n' $_need | sort -u); do
    _n=$(printf '%s\n' $_need | grep -cx "$_l")
    case "$_l" in
      pane|repo) case "$_have" in *" $_l "*) ;; *) echo "  lane $_l: $_n task(s) ready, no chip offered (fleet.sh chips <run> <NN>-<NN> $_l)";; esac ;;
      verify) case "$_have" in *" repo "*|*" verify "*) ;; *) echo "  lane verify: $_n task(s) ready, no repo or verify chip offered";; esac ;;
      *) echo "  needs: $_l on $_n task(s) is not a lane, so no worker will ever claim them: change it to pane, repo or verify" ;;
    esac
  done
}

# The coordinator's context in thousands of tokens, read from the tail of its own transcript, or nothing.
# It is the run's single point of failure: the 2026-10-05 coordinator reached 510 K at thirty percent of
# its plan, with the review state of every open branch held nowhere but in that context.
#
# A worker is a session like any other, and the same reading answers for it: `session_ctx` takes the id, and
# the coordinator is only the session `<run>/coordinator` names. Workers are the other half of the same
# problem - a repo worker grows 20-30 k per task [M30] and one carried 610 K into a task it then got wrong.
coord_ctx() {
  [ -e "$run/coordinator" ] || return 0
  session_ctx "$(head -1 "$run/coordinator" | tr -d '\r')"
}
session_ctx() { # session_ctx <session-id>; its context in K, or nothing
  command -v node >/dev/null 2>&1 || return 0
  _sid=$1
  [ -n "$_sid" ] || return 0
  _base="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
  _tr=$(ls "$_base"/*/"$_sid".jsonl 2>/dev/null | head -1)
  [ -n "$_tr" ] || return 0
  TR="$_tr" node -e '
    const fs=require("fs"); const fd=fs.openSync(process.env.TR,"r"); const size=fs.fstatSync(fd).size;
    const len=Math.min(size,4*1024*1024); const b=Buffer.alloc(len); fs.readSync(fd,b,0,len,size-len);
    const lines=b.toString("utf8").split("\n");
    for (let i=lines.length-1;i>=0;i--) {
      if (!lines[i].includes("\"usage\"") && !lines[i].includes("compact_boundary")) continue;
      let o; try { o=JSON.parse(lines[i]); } catch { continue; }
      if (o.subtype==="compact_boundary") { console.log(Math.round((o.compactMetadata?.postTokens||0)/1000)); break; }
      if (o.type!=="assistant"||o.isSidechain) continue;
      const u=o.message?.usage||{}; const n=(u.input_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0);
      if (n) { console.log(Math.round(n/1000)); break; }
    }' 2>/dev/null || true
}

verify_held() {
  for _c in "$run"/tasks/claimed/*/; do
    [ -d "$_c" ] || continue
    _i=$(basename "$_c")
    case "$_i" in *.dead-*|*.released-*) continue ;; esac
    [ -e "$run/tasks/done/$_i" ] && continue
    _w=$(sed -n 's/^needs:[[:space:]]*\([a-z][a-z]*\).*/\1/p' "$run/tasks/ready/$_i.md" 2>/dev/null | head -1)
    if [ "${_w:-}" = verify ]; then printf '%s' "$_i"; return; fi
  done
}

# Every worker-side call whose third argument is the worker's own chip registers the session, not only
# `next`: a worker on an assigned brief never calls `next`, so the pause and retired hooks, which find a
# worker only through chips/<session>, could not see it - the pause was a sentence again for that shape.
case "$cmd" in
  whoami|find|beat|finish|clock|ask|pane-ask|worktree)
    # `integration` is the coordinator's own tree, never a worker.
    if [ -n "${3:-}" ] && [ "$3" != integration ]; then register_chip "$3"; fi ;;
esac

case "$cmd" in

next)
  chip=${3:?chip id required}
  lane=${4:-}
  waiting=0
  register_chip "$chip"
  # A chip a relaunch replaced hands out nothing and says so before anything else: its tasks went back to
  # the queue under new ids (`handback`), so claiming here would take one of them off the fresh worker
  # that is meant to continue it. Exit 9, not 3: 3 means "drained", and a worker told that writes `.done`.
  if [ -e "$run/$chip.retired" ]; then
    echo "RETIRED: chip $chip was replaced by a fresh worker. You were retired: end this turn with one line, commit nothing, start nothing."
    exit 9
  fi
  # A pause hands out nothing, however much is ready. Exit 8 is its own code for the reason 7 is not 3:
  # a worker told "drained" would write `.done`, and one told "waiting" would poll `next` as if work were
  # coming, when what it has to do is stop and wait for the pause to lift.
  if [ -e "$run/PAUSED" ]; then
    echo "RUN PAUSED: $(head -1 "$run/PAUSED"). Nothing is handed out while a pause stands."
    echo "Background this, end your turn, and after it prints resumed carry on with the claim you hold; call next only if you hold none:"
    wake_loop "$chip"
    exit 8
  fi
  # A chip that already holds an open claim takes no second task. Resumed from a pause, the wake loop says
  # "carry on with the claim you hold", and a worker that read it as "claim again" took another one.
  openid=$(claims_of "$chip" | head -1)
  if [ -n "$openid" ]; then
    echo "HOLDING $openid: chip $chip already holds an open claim. Finish it, or hand it back, before asking for another task: next hands out nothing while you hold one." >&2
    exit 2
  fi
  stamp
  mkdir -p "$run/tasks/claimed" "$run/tasks/done"

  # The one throttle on a fleet's own appetite. Every worker walks this call before every task, which makes
  # it the only place a run can be stopped from growing into the page file - and the operator's machine
  # dying is the failure this answers. It refuses the TASK, never the worker: a session that stops because
  # it was refused is a dead chat, and nothing in a fleet restarts one [M03], so the refusal comes with the
  # wait to background.
  #
  # Two thresholds, not one. Refusing below 2 GB and releasing only above 4 is hysteresis, and without it
  # every worker held on one reading claims again on the next, together, on the same 2.1 GB.
  loader=$(load_script)
  if [ -n "$loader" ] && command -v node >/dev/null 2>&1; then
    floor=$(cal memory_floor_gb 2); clear=$(cal memory_clear_gb 4)
    if ! node "$loader" --clear "$floor" >/dev/null 2>&1; then
      mkdir -p "$run/tight"; now > "$run/tight/$chip"
      free=$(node "$loader" --json 2>/dev/null | sed -n 's/.*"freeGB":\([0-9.]*\).*/\1/p' | tail -1)
      echo "MACHINE TIGHT: ${free:-unknown} GB free, floor ${floor} GB. Nothing is wrong with you; the box is full."
      echo "Background this and wait. Do NOT write .done, and do not end this turn without it running:"
      echo "  [ -e \"$absrun/FINISHED\" ] && { echo run-finished; exit 0; }; until node \"$loader\" --clear $clear >/dev/null 2>&1; do sleep 60; done; echo memory-back"
      echo "Then claim again. While you wait, the cheapest thing you can do for the run is close anything"
      echo "of yours that holds memory: a browser pane holds its renderer until the tab is closed, and a"
      echo "reload returns none of it [M34]."
      exit 6
    fi
    rm -f "$run/tight/$chip" 2>/dev/null || true
  fi
  for f in "$run"/tasks/ready/*.md; do
    [ -e "$f" ] || continue
    id=$(basename "$f" .md)
    [ -e "$run/tasks/done/$id" ] && continue
    # A worker with no pane must not claim a pane task, and finding that out after the claim costs a
    # reclaim. Measured 2026-08-31: `next` had no lane filter, the planner worked around it by telling
    # nine workers in their chip prompt to walk `ready/` by hand instead, and the helper went unused for
    # the whole run - 75 hand rolled claims, and every finding appended without passing the schema gate.
    want=$(sed -n 's/^needs:[[:space:]]*\([a-z][a-z]*\).*/\1/p' "$f" | head -1)
    [ -n "$want" ] || want=repo
    # The verify lane, which nobody is ever told to ask for: a chip prompt carries `pane` or `repo` and
    # nothing else (commands/fleet-plan.md), so a `needs: verify` task was claimable by no worker in the
    # fleet and `landed` then refused the run over the claim that never happened. A repo worker takes it,
    # one at a time, which is the width the lane already has - and so does a worker that named no lane,
    # which used to skip this check and hand out a second verify task beside a held one. Two workers
    # reaching this line in the same instant can both pass it - the queue's atomicity is per task, and
    # this is a width rather than a lock.
    if [ "$want" = verify ]; then
      [ "$lane" = pane ] && continue
      if [ -n "$(verify_held)" ]; then waiting=$((waiting + 1)); continue; fi
    elif [ -n "$lane" ] && [ "$want" != "$lane" ]; then
      continue
    fi
    # A task can wait for another to finish: `after: task-02-primitives` in the frontmatter, one id or
    # several separated by spaces or commas. The queue is the only place a wave order can be enforced
    # without asking anybody to remember it, and a mission with waves - `kind: design` is the one this was
    # written for - is otherwise a rule in prose, which this repository has watched fail before. A worker
    # that claims a screen while the shared primitives are still being restyled either collides with that
    # work or inherits a defect it is not allowed to fix.
    # A task that waits on the operator (`operator: <what>` in its frontmatter) is not handed out until
    # `fleet.sh cleared` removes the line: a worker that claimed it would sit on it, as a claim nobody can
    # advance. `none`, `no` and `-` mean nothing is owed.
    if [ -n "$(operator_owed "$f")" ]; then waiting=$((waiting + 1)); continue; fi
    deps=$(sed -n 's/^after:[[:space:]]*\(.*\)/\1/p' "$f" | head -1 | tr ',\r' '  ')
    if [ -n "$deps" ]; then
      blocked=""
      for d in $deps; do
        [ -n "$d" ] || continue
        [ -e "$run/tasks/done/$d" ] || blocked=1
      done
      if [ -n "$blocked" ]; then
        waiting=$((waiting + 1))
        continue
      fi
    fi
    if mkdir "$run/tasks/claimed/$id" 2>/dev/null; then
      t=$(now)
      printf 'chip %s\nclaimed %s\n' "$chip" "$t" > "$run/tasks/claimed/$id/owner"
      printf '%s\n' "$t" > "$run/tasks/claimed/$id/heartbeat"
      # A task a relaunch handed back (`handback-of: <id>`) carries its fix proof across: the reproduction
      # that failed before the change was recorded in the old claim, which the handback renamed. Copying it
      # here is what lets the fresh worker finish the task with `fleet-gate.mjs check` and no second `before`.
      ho=$(sed -n 's/^handback-of:[[:space:]]*//p' "$f" | head -1 | tr -d '\r')
      if [ -n "$ho" ]; then
        # Only the `before` line. The `after` was run in the old worker's tree and says nothing about this
        # one: a fresh worker that inherited it could finish without proving its own tree.
        for _p in "$run"/tasks/claimed/"$ho".released-*/proof; do
          if [ -f "$_p" ]; then grep '"phase":"before"' "$_p" | tail -1 >> "$run/tasks/claimed/$id/proof" || true; fi
        done
      fi
      b=$(sed -n 's/^budget:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$f" | head -1)
      [ -n "$b" ] || b=25
      echo "CLAIMED $id"
      echo "LANE ${lane:-any}"
      # A repo worker holding the verify task is holding the whole fleet's verify lane, and nothing else
      # says so: the width is one because two full suites on this machine reach the pagefile together.
      if [ "$want" = verify ] && [ "${lane:-}" != verify ]; then
        echo "VERIFY LANE: this is a verify task and the lane is one worker wide across the fleet."
        echo "  Nobody else can run a full suite until you finish it, so keep it scoped and close it."
      fi
      echo "BUDGET_MIN $b"
      echo "ABORT_AFTER_SEC $(( b * $(calint budget_multiplier 2) * 60 ))"
      # Each task worked inline leaves 20-30 k of context behind it, and four workers who never spawned a
      # subagent were all compacted near their thirtieth task [M30]. Past the first few, a task belongs in
      # its own subagent. Said here, on a path every worker walks, because the same rule in prose was
      # obeyed zero times in 184 claims.
      if [ "$want" != pane ]; then
        dn=0
        for o in "$run"/tasks/claimed/*/owner; do
          [ -e "$o" ] || continue
          if grep -q "^chip $chip\$" "$o" 2>/dev/null && [ -e "$run/tasks/done/$(basename "$(dirname "$o")")" ]; then dn=$((dn + 1)); fi
        done
        if [ "$dn" -ge "$(calint delegate_past_tasks 3)" ]; then
          echo "DELEGATE: you have finished $dn tasks in this session and each left 20-30 k of context behind [M30]."
          echo "  Hand this task to ONE subagent at the task's model - task file, RULES.md, your notes - with findings filed through find. Keep your own context flat."
        fi
      fi
      # Absolute, and quoted: this is armed from a worktree, where the run directory is not under the cwd
      # and a project path with a space in it would otherwise arm a clock on a different directory.
      echo "ARM_CLOCK background what this prints: sh \"$0\" clock \"$absrun\" $chip $id $b"
      echo "---"
      cat "$f"
      exit 0
    fi
  done
  # "Drained" and "waiting on a wave that has not landed" are different states, and a worker told the
  # first when the second is true writes its `.done` and ends a session that still had work coming. So the
  # two states have two exit codes, not one exit code and two sentences.
  if [ "$waiting" -gt 0 ]; then
    echo "QUEUE WAITING${lane:+ for lane $lane}: $waiting task(s) held by an unfinished \`after:\` dependency, a held verify lane, or an \`operator:\` line not yet cleared"
    echo "  Poll rather than finishing: this queue opens again when those tasks land."
    exit 7
  fi
  # A task whose `needs:` names no lane is skipped above for every worker, so "nothing left" would be a
  # lie told to a worker that then writes its `.done`. Name the task here, as `drained` does.
  badlane=$(lane_gaps | grep 'is not a lane' || true)
  [ -z "$badlane" ] || printf '%s\n' "$badlane"
  echo "QUEUE DRAINED${lane:+ for lane $lane}"
  exit 3
  ;;

clock)
  # The abort clock, printed rather than described. Background exactly what this prints.
  #
  # It used to be a plain `sleep <2x budget>` that somebody had to remember to stop, and across two
  # measured runs 87 of them were armed and none stopped, waking finished sessions for 1,090 minutes.
  # A rule asked for 87 times and obeyed 0 times is not a rule. So the clock now reads the same disk the
  # rest of the protocol writes: it wakes every 30 seconds, exits silently the moment its task is closed
  # or its worker is finished, and only speaks if the budget really did elapse. Nothing to disarm,
  # because nothing outlives its obligation.
  #
  # Three things widened it since. The paths are absolute, because a worker inside a git worktree has no
  # `.fleet/` under its cwd - it is gitignored - so a relative one named nothing and every clock ran its
  # full term. `<chip>.blocked` closes it too: a blind worker is as finished as a done one, and its clocks
  # were running to term. And `FINISHED` is checked first and every round, so one `landed` call ends every
  # clock still armed anywhere on the machine rather than leaving them to expire one at a time.
  chip=${3:?chip id required}; id=${4:?task id required}; mins=${5:-25}
  mult=$(calint budget_multiplier 2); poll=$(calint clock_poll_seconds 30)
  rounds=$(( mins * mult * 60 / poll ))
  #
  # A round is not counted while `<run>/PAUSED` stands. A pause stops the worker, so a clock that kept
  # counting would ring "budget elapsed" at a worker that did nothing wrong, minutes after the resume that
  # was supposed to give the task back to it. `.retired` closes it as `.done` does: the task went back to
  # the queue under a new id and this clock guards nothing.
  printf '[ -e "%s/FINISHED" ] && exit 0; i=0; while [ $i -lt %s ]; do sleep '"$poll"'; [ -e "%s/PAUSED" ] || i=$((i+1)); [ -e "%s/FINISHED" ] && exit 0; [ -e "%s/tasks/done/%s" ] && exit 0; [ -e "%s/%s.done" ] && exit 0; [ -e "%s/%s.blocked" ] && exit 0; [ -e "%s/%s.retired" ] && exit 0; done; echo budget-elapsed-%s\n' \
    "$absrun" "$rounds" "$absrun" "$absrun" "$absrun" "$id" "$absrun" "$chip" "$absrun" "$chip" "$absrun" "$chip" "$id"
  ;;

width)
  # The repo lane's width, computed rather than retyped. Inputs: how many repo tasks are ready, and what
  # the machine has free. A formula in prose drifts every time somebody restates it; this one has a
  # single spelling.
  ready=0
  for f in "$run"/tasks/ready/*.md; do
    [ -e "$f" ] || continue; id=$(basename "$f" .md)
    [ -e "$run/tasks/done/$id" ] && continue
    lane=$(sed -n 's/^needs:[[:space:]]*\([a-z][a-z]*\).*/\1/p' "$f" | head -1)
    [ -n "$lane" ] || lane=repo
    [ "$lane" = repo ] && ready=$((ready + 1))
  done
  per=$(calint repo_tasks_per_worker 3)
  want=$(( (ready + per - 1) / per ))
  [ "$want" -lt 1 ] && want=1
  cap=""
  loader=$(load_script)
  if [ -n "$loader" ] && command -v node >/dev/null 2>&1; then
    reserve=$(cal operator_reserve_gb 2); ceil=$(calint repo_worker_ceiling 12)
    cap=$(node "$loader" --json 2>/dev/null | RESERVE_GB="$reserve" CEIL_N="$ceil" node -e 'const RESERVE=+process.env.RESERVE_GB||2, CEIL=+process.env.CEIL_N||12; let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const byRam=Math.floor(o.freeGB-RESERVE);console.log(Math.max(1,Math.min(byRam,CEIL)));}catch{console.log("")}})')
  fi
  [ -n "$cap" ] || cap=6
  n=$want; [ "$n" -gt "$cap" ] && n=$cap
  echo "REPO_WORKERS $n"
  echo "  ready repo tasks $ready, one worker per $per -> $want"
  echo "  machine cap $cap (free memory less the ${reserve:-2} GB the operator keeps, ceiling ${ceil:-12})"
  echo "  the pane lane starts at $(cal pane_workers_default 2) and is bound by memory, not by the display [M33]; the verify lane is 1"
  echo "  every constant above comes from calibration.json"
  ;;

beat)
  chip=${3:?chip id required}; id=${4:?task id required}
  d=$run/tasks/claimed/$id
  if [ ! -d "$d" ] || ! grep -q "chip $chip\$" "$d/owner" 2>/dev/null; then
    echo "CLAIM LOST $id"; exit 4
  fi
  now > "$d/heartbeat"
  echo "OK $id"
  ;;

finish)
  chip=${3:?chip id required}; id=${4:?task id required}; branch=${5:-}
  d=$run/tasks/claimed/$id
  # A claim that is gone was released or reclaimed while this worker was busy, and the work behind it was
  # never checked. Closing the task here would let `landed` pass over it, so refuse exactly as `beat` does.
  if [ ! -d "$d" ]; then
    echo "CLAIM LOST $id, done marker NOT written"; exit 4
  fi
  if ! grep -q "chip $chip\$" "$d/owner" 2>/dev/null; then
    echo "CLAIM LOST $id, done marker NOT written"; exit 4
  fi
  now > "$d/heartbeat"

  # A fix arrives with a reproduction that failed before it and passes after. That was prose in
  # MISSIONS.md from the day the fix kind existed, and one fix run landed 164 changes with nothing
  # checking it. This call is the one place every fix task already walks through, so the requirement
  # lives here rather than in a paragraph. The gate reads the proof the worker recorded with
  # `fleet-gate.mjs prove`, and refuses a green produced over a tree that never moved.
  kind=$(awk '/^kind:/{print $2; exit}' "$run/tasks/ready/$id.md" 2>/dev/null)
  case "$kind" in
    fix|root)
      gate=$(beside fleet-gate.mjs makarasty scripts/fleet-gate.mjs)
      # No gate to ask is no proof, not a pass: this used to skip the check and close the fix unproven,
      # while PROTOCOL.md says finish refuses one.
      if [ -z "$gate" ] || ! command -v node >/dev/null 2>&1; then
        echo "done marker NOT written for $id: it is a $kind task and node or fleet-gate.mjs is missing," >&2
        echo "  so no reproduction can be read. Install node, or leave the task open for the planner." >&2
        exit 1
      fi
      if ! node "$gate" check "$absrun" "$id"; then
        echo "done marker NOT written for $id" >&2
        echo "  Run the reproduction through the gate, then finish again:" >&2
        echo "    node \"$gate\" prove \"$absrun\" $id before -- <the task reproduction>   # before your change" >&2
        echo "    node \"$gate\" prove \"$absrun\" $id after  -- <the same command>        # after it" >&2
        echo "  A reproduction that passes BEFORE the change refutes the finding, which is a result and" >&2
        echo "  not a failure: write it up in your notes and finish with FLEET_REFUTED=1 set." >&2
        if [ -z "${FLEET_REFUTED:-}" ]; then exit 1; fi
        echo "FLEET_REFUTED set: closing $id as a refutation rather than as a fix." >&2
      fi
      ;;
  esac

  # The marker is created only when absent, and the branch line is written only when a branch is given:
  # a second `finish` without one used to truncate the `branch <name>` line the first had recorded.
  mkdir -p "$run/tasks/done"; [ -e "$run/tasks/done/$id" ] || : > "$run/tasks/done/$id"
  # Where the committed work is, for whoever merges it: the review reads a committed diff, and nothing
  # else records which branch a task's commits went to. Only the marker's existence means done.
  if [ -n "$branch" ]; then
    # A branch that does not resolve is a typo or a commit that never happened, and the merge would
    # learn that only later. Warn, do not refuse: the marker is still the truth about the task.
    _wt=$(awk '/^path /{sub(/^path /,""); print; exit}' "$run/worktrees/$chip" 2>/dev/null) || _wt=
    if ! git -C "${_wt:-.}" rev-parse --verify -q "refs/heads/$branch" >/dev/null 2>&1; then
      echo "WARNING: branch '$branch' does not resolve in ${_wt:-the current directory}; the marker records it anyway." >&2
    fi
    printf 'branch %s\n' "$branch" > "$run/tasks/done/$id"
    # The commit the task finished at. `stranded` reads it: a branch whose tip is in integration and that
    # has commits past it was merged and then worked on, which nothing else would notice.
    _tip=$(git -C "${_wt:-.}" rev-parse -q --verify "refs/heads/$branch" 2>/dev/null) || _tip=
    if [ -n "$_tip" ]; then printf 'tip %s\n' "$_tip" >> "$run/tasks/done/$id"; fi
  fi
  echo "DONE $id${branch:+ (branch $branch)}"
  echo "The clock guarding it sees this marker within 30 seconds and exits on its own."
  ;;

find)
  chip=${3:?chip id required}
  stamp
  tmp=$(tmpfile); cat > "$tmp"
  # The validated line lands in a temporary file first. Appending straight to the chip's file opens it
  # before node has read anything, so a worker whose FIRST finding was refused left an empty `NN.jsonl`
  # behind - and `recover` and `summary` then report that chip as having filed nothing rather than as
  # never having filed.
  out=$(tmpfile)
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs=require("fs");
      let o; try { o = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }
      catch (e) { console.error("REFUSED: not one JSON object: "+e.message); process.exit(1); }
      const sev=["blocker","major","minor","polish"];
      const problems=[];
      // The retired field name belongs to no shape, so it is asked about before the shapes divide.
      if (o.what) problems.push("`what` is the retired field name, use `observed`");
      if (o.unreached) { if (!o.reason) problems.push("unreached line needs reason"); }
      else if (o.created || o.state_changed) {
        // An auxiliary line says what this worker DID to the environment, and it used to be the way past
        // every check below: one extra key - `created` beside a `severity` - filed a blocker with no
        // area, no evidence and the retired field name, and exited 0. It is not a lesser finding, it is a
        // different shape, and the merge routes on `severity` alone (fleet-merge.mjs), so a severity here
        // would enter the backlog as a finding nothing stands behind.
        if (o.severity) problems.push("an auxiliary line carries no severity; file what you found as its own finding");
        if (o.created && !String(o.where||"").trim())
          problems.push("created needs where: the next person to read that sandbox has to find the row");
        if (o.state_changed && !String(o.when||"").trim())
          problems.push("state_changed needs when: collection reads it as the window every later sighting was measured in");
      }
      else {
        for (const k of ["area","severity","observed","evidence","mechanism_status"])
          if (!o[k] || String(o[k]).trim()==="") problems.push("missing "+k);
        if (o.severity && !sev.includes(o.severity)) problems.push("severity not one of "+sev.join("|"));
        if (o.mechanism_status && !["established","hypothesis","unknown"].includes(o.mechanism_status))
          problems.push("mechanism_status not established|hypothesis|unknown");
        if (o.evidence && String(o.evidence).length < 12) problems.push("evidence too thin to reproduce from");
        // A visual claim carries the two rectangles it is about, and they have to actually intersect.
        // A model shown a screenshot will report an overlap that is not there; geometry will not.
        if (o.rects) {
          const a = o.rects.a, b = o.rects.b;
          if (!a || !b) problems.push("rects needs both a and b");
          else {
            const ox = Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x, b.x);
            const oy = Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y);
            if (ox <= 0 || oy <= 0) problems.push("the rects in this finding do not intersect");
          }
          if (!/\d/.test(String(o.conditions||""))) problems.push("a visual finding states its viewport and zoom in conditions");
        }
      }
      if (problems.length) { console.error("REFUSED: "+problems.join("; ")); process.exit(1); }
      o.when = o.when || new Date().toISOString();
      o.chip = o.chip || process.argv[2];
      process.stdout.write(JSON.stringify(o)+"\n");
    ' "$tmp" "$chip" > "$out" || { rm -f "$tmp" "$out"; exit 1; }
    cat "$out" >> "$run/$chip.jsonl"
  else
    echo "warning: node absent, finding appended unvalidated" >&2
    tr -d '\n' < "$tmp" >> "$run/$chip.jsonl"; echo >> "$run/$chip.jsonl"
  fi
  rm -f "$tmp" "$out"
  echo "FILED $(wc -l < "$run/$chip.jsonl" | tr -d ' ') lines in $chip.jsonl"
  ;;

ask)
  chip=${3:?chip id required}
  mkdir -p "$run/ask"
  n=1; while [ -e "$run/ask/$chip-$n.md" ]; do n=$((n + 1)); done
  cat > "$run/ask/$chip-$n.md"
  # Absolute: the asker is often in a worktree, where `.fleet/` does not exist under its cwd.
  echo "ASKED $absrun/ask/$chip-$n.md, read $absrun/answers/$chip-$n.md at your next boundary"
  ;;

chips)
  # The worker chips, printed rather than described. Measured 2026-10-05: a coordinator that reached its run
  # through a handoff never loaded fleet-plan, so the chip rules were not in its context and a project memory
  # rule ("chips only for one real defect") filled the gap - five paste lines instead of chips, then four
  # chips titled "Fleet worker 02: ..." that no `fleet <run-id> NN` lookup finds, and a fleet-run path into a
  # cache snapshot two versions old. Every path that offers workers - plan, resume, design, call, a handoff -
  # goes through here, so the title, the absolute run path and the command path have one spelling.
  range=${3:-}; lane=${4:-}
  [ -n "$range" ] || { echo "worker range required, e.g. 02 or 02-05" >&2; exit 2; }
  first=${range%-*}; last=${range#*-}
  # Numbers only, and a range that runs forwards. `expr` returned status 1 for a zero and ended the script
  # under `set -e` without a word; a reversed range printed no chip at all, only the trailer, and the
  # coordinator offered nothing believing it had.
  case "$first$last" in *[!0-9]*) echo "range '$range' is not numeric: use 02 or 02-05" >&2; exit 2;; esac
  if [ -z "$first" ] || [ -z "$last" ]; then echo "range '$range' is empty at one end: use 02 or 02-05" >&2; exit 2; fi
  # Leading zeros stripped, because `$(( 08 ))` is an octal error in several shells.
  first=$(printf '%s' "$first" | sed 's/^0*//'); last=$(printf '%s' "$last" | sed 's/^0*//')
  i=$((${first:-0} + 0)); end=$((${last:-0} + 0))
  # Worker numbers start at 1: `00` printed a chip titled worker 00 that no `fleet <run-id> NN` lookup could
  # ever match, because every number elsewhere is a worker that exists.
  if [ "$i" -lt 1 ]; then echo "range '$range' starts below 1: worker numbers start at 01" >&2; exit 2; fi
  if [ "$i" -gt "$end" ]; then echo "range '$range' runs backwards: no worker would be offered" >&2; exit 2; fi
  # A lane is where a task can be done, never which model does it: pane, repo or verify. A model name as
  # a lane (`opus`, measured 2026-10-05) made a queue of its own that four idle workers on the very same
  # model could not touch, because a chip cannot pick its session's model and a worker cannot change it.
  case "${lane:-}" in ''|pane|repo|verify) ;; *)
    echo "lane '$lane' is not a lane: use pane, repo or verify. A lane says where a task can be done; the" >&2
    echo "model is whatever the operator starts the chip with, and fleet.sh status shows it per worker." >&2
    exit 2;;
  esac
  runid=$(basename "$absrun")
  runmd=$(beside ../commands/fleet-run.md makarasty commands/fleet-run.md)
  runmd=$(absdir "$(dirname "$runmd")")/fleet-run.md
  # Every number is checked before any chip is printed or recorded, so a refusal leaves nothing half
  # offered. A number already in `offered/` with another lane was a worker the operator may have opened:
  # overwriting its lane made `status` and `lane_gaps` describe a chip that no longer matches its chat.
  j=$i
  while [ "$j" -le "$end" ]; do
    nn=$(printf '%02d' "$j")
    if [ -e "$run/brief-$nn.md" ]; then want=brief
    else
      [ -n "$lane" ] || { echo "no brief-$nn.md in $absrun, so this is a queue worker and needs a lane: pane, repo or verify" >&2; exit 2; }
      want=$lane
    fi
    if [ -e "$run/offered/$nn" ] && [ "$(head -1 "$run/offered/$nn")" != "$want" ]; then
      echo "worker $nn was already offered for lane $(head -1 "$run/offered/$nn"), and this asks for $want. Use a number" >&2
      echo "no chip has used: lanes take disjoint ranges (pane 01-02, repo 03-08), never the same number twice." >&2
      exit 2
    fi
    j=$((j + 1))
  done
  mkdir -p "$run/offered"
  # The session that asks for chips is the coordinator. `status` and the watch read its transcript for
  # its context size, which is the one number that says when the run needs a fresh coordinator.
  if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then printf '%s\n' "$CLAUDE_CODE_SESSION_ID" > "$run/coordinator"; fleet_session; fi
  while [ "$i" -le "$end" ]; do
    nn=$(printf '%02d' "$i")
    seepane=""
    if [ -e "$run/brief-$nn.md" ]; then
      prompt="Run the brief at $absrun/brief-$nn.md by following the makarasty fleet-run command. Invoke it as /makarasty:fleet-run $absrun/brief-$nn.md, and if that name does not resolve in this session, read the command file directly, at $runmd"
      what="brief $nn"
      # A brief worker is not a queue worker: recording the lane it was handed made `lane_gaps` count it as
      # covering that lane, and the lane's tasks then waited for a worker that only walks its own brief.
      printf 'brief\n' > "$run/offered/$nn"
    else
      prompt="You are worker $nn of run $runid, lane $lane. Work the queue by following the makarasty fleet-run command. Invoke it as /makarasty:fleet-run $absrun/, and if that name does not resolve in this session, read the command file directly, at $runmd"
      what="lane $lane"
      printf '%s\n' "$lane" > "$run/offered/$nn"
      if [ "$lane" = pane ]; then seepane=" Keep its browser pane on screen if it asks for one."; fi
    fi
    printf 'CHIP %s\ntitle: fleet %s %s\ntldr: Worker %s of fleet run %s, %s. It works by itself and reports to the coordinator chat; open it.%s\nprompt: %s\n\n' "$nn" "$runid" "$nn" "$nn" "$runid" "$what" "$seepane" "$prompt"
    i=$((i + 1))
  done
  echo "Offer every CHIP above now, each as its own mcp__ccd_session__spawn_task with exactly that title, tldr and prompt."
  echo "The title is the worker's address: fleet-wait, fleet-resume and send_message find it by that title and no other."
  echo "A chip is an offer the operator can decline with one click, so offer every one of them. If a project or memory rule seems to forbid chips for fleet workers, quote that rule to the operator in this same turn, with the chips already offered; never replace chips with paste lines."
  # Every lane the queue already holds work for needs a worker from the first minute. Opus-only tasks
  # filed at 18:34 waited 19 minutes on 2026-10-05 for chips that were promised "for wave 3".
  gap=$(lane_gaps)
  # A `needs:` that is not a lane is fixed in the task file; no chip can cover it.
  lanes=$(printf '%s\n' "$gap" | grep -v 'is not a lane' || true)
  bad=$(printf '%s\n' "$gap" | grep 'is not a lane' || true)
  if [ -n "$lanes" ]; then printf 'STILL WITHOUT A WORKER:\n%s\nOffer chips for those lanes in this same turn.\n' "$lanes"; fi
  if [ -n "$bad" ]; then printf 'FIX THE TASK, not the chips:\n%s\n' "$bad"; fi
  ;;

whoami)
  # What this worker runs on, recorded at its first claim. A chip cannot choose its session's model and a
  # session cannot change its own, so a task's `model:` line is a wish; this is what actually ran. Measured
  # 2026-10-05: every task said `model: sonnet`, and all seven workers were Opus.
  chip=${3:?chip id required}; model=${4:?model required}; effort=${5:-unknown}
  mkdir -p "$run/chips"
  printf '%s %s plugin %s\n' "$model" "$effort" "$(plugin_version)" > "$run/chips/$chip.model"
  echo "recorded: chip $chip runs $model at effort $effort, plugin $(plugin_version)"
  ;;

file)
  # The coordinator files a task: the file on stdin (or a path), checked before it reaches the queue.
  # Measured 2026-10-05: a hand-made filing script ran its heredoc after a failed `&&` chain, so two tasks
  # were never filed and nothing said so, and a cp1252 character broke another task file. One call per
  # task, refused loudly, and `FILED` only when the file is in place.
  id=${3:?task id required}; src=${4:--}
  case "$id" in *[!A-Za-z0-9._-]*|.*) echo "REFUSED: task id '$id' may hold only letters, digits, dot, dash and underscore" >&2; exit 2;; esac
  for _p in "$run/tasks/ready/$id.md" "$run/tasks/claimed/$id" "$run/tasks/done/$id" "$run/tasks/released/$id.md"; do
    [ -e "$_p" ] && { echo "REFUSED: $id already exists ($_p); a re-filed task takes a new id" >&2; exit 2; }
  done
  mkdir -p "$run/tasks/ready"
  if [ "$src" = "-" ] && [ -t 0 ]; then echo "REFUSED: $id NOT filed: nothing on stdin; pipe the task file in, or name its path" >&2; exit 2; fi
  _tmp="$run/tasks/.filing-$id-$$"
  if [ "$src" = "-" ]; then cat > "$_tmp"; else cp "$src" "$_tmp" || { rm -f "$_tmp"; exit 2; }; fi
  _why=""
  # UTF-8 or refused; a UTF-8 byte order mark (what Windows PowerShell writes by default) is dropped, since
  # everything that reads a task matches `---` and `needs:` at the start of a line.
  if command -v node >/dev/null 2>&1 && ! node -e 'const fs=require("fs"),f=process.argv[1];let b=fs.readFileSync(f);try{new TextDecoder("utf-8",{fatal:true}).decode(b)}catch{process.exit(1)}if(b[0]===0xef&&b[1]===0xbb&&b[2]===0xbf)fs.writeFileSync(f,b.subarray(3))' "$_tmp"; then
    _why="it is not valid UTF-8 (a cp1252 or UTF-16 write?): write the file as UTF-8 and file it again"
  elif [ "$(head -1 "$_tmp" | tr -d '\r')" != "---" ]; then
    _why="it does not start with a --- frontmatter line"
  elif ! awk 'NR>1 && /^---/ {f=1; exit} END {exit !f}' "$_tmp"; then
    _why="its frontmatter has no closing --- line"
  else
    # The lane as `next` reads it: the first word of the needs: line.
    _need=$(awk 'NR>1 && /^---/{exit} /^needs:/{sub(/^needs:[ \t]*/,""); if (match($0, /^[a-z]+/)) print substr($0, 1, RLENGTH); exit}' "$_tmp")
    case "$_need" in pane|repo|verify) ;; *) _why="its needs: line reads '$(awk 'NR>1 && /^---/{exit} /^needs:/{sub(/^needs:[ \t]*/,""); sub(/[ \t\r]+$/,""); print; exit}' "$_tmp")', and a lane is pane, repo or verify, in lower case";; esac
    _tid=$(awk 'NR>1 && /^---/{exit} /^task-id:/{sub(/^task-id:[ \t]*/,""); sub(/[ \t\r]+$/,""); print; exit}' "$_tmp")
    [ -z "$_why" ] && [ -n "$_tid" ] && [ "$_tid" != "$id" ] && _why="its task-id: line says '$_tid', not '$id'"
  fi
  if [ -n "$_why" ]; then rm -f "$_tmp"; echo "REFUSED: $id NOT filed: $_why" >&2; exit 2; fi
  mv "$_tmp" "$run/tasks/ready/$id.md"
  _after=$(sed -n 's/^after:[[:space:]]*\(.*\)/\1/p' "$run/tasks/ready/$id.md" | head -1 | tr ',\r' '  ')
  set -f; _miss=""; for _d in $_after; do [ -e "$run/tasks/ready/$_d.md" ] || _miss="$_miss $_d"; done; set +f
  echo "FILED $id lane $_need${_after:+ after $(set -f; echo $_after)}"
  # Not refused: a queue filed whole can name a task filed a moment later. Said, because a typo here holds
  # this task for ever.
  if [ -n "$_miss" ]; then echo "  NOTE: after: names a task not filed yet:$_miss - file it, or this task waits for ever"; fi
  if [ -n "$(operator_owed "$run/tasks/ready/$id.md")" ]; then echo "  waits on the operator: ask them now; next holds it until: fleet.sh cleared $absrun $id"; fi
  exit 0
  ;;

procs)
  # Test runs and typechecks nobody waits for any more, the memory a closed chat left behind (fleet-load.mjs
  # --leftovers says exactly what counts). `--kill` ends only those; a dev server, watcher or emulator whose
  # parent is gone is listed and left to the operator.
  _l=$(load_script)
  [ -n "$_l" ] && command -v node >/dev/null 2>&1 || { echo "procs needs node and fleet-load.mjs" >&2; exit 2; }
  if [ "${3:-}" = "--kill" ]; then node "$_l" --leftovers --kill; else node "$_l" --leftovers; fi
  exit 0
  ;;

cleared)
  # The operator did what a task's `operator:` line asked: the line goes, and `next` hands the task out.
  id=${3:?task id required}; _f="$run/tasks/ready/$id.md"
  [ -e "$_f" ] || { echo "no such task: $id" >&2; exit 2; }
  _t="$_f.tmp-$$"
  awk 'NR==1 && /^---/ {fm=1; print; next} fm && /^---/ {fm=0} fm && /^operator:/ {next} {print}' "$_f" > "$_t" && mv "$_t" "$_f"
  # A worker waiting on exit 7 wakes when the ready, done or cleared listing changes (fleet-run's wake
  # loop); rewriting the task in place changes none of them.
  mkdir -p "$run/tasks/cleared" && now > "$run/tasks/cleared/$id"
  echo "CLEARED $id: the operator's part is done; next hands it out"
  exit 0
  ;;

stranded)
  # Done tasks whose branch holds commits the integration branch does not. "partly merged" is the stranded
  # kind: a commit made after the merge, which nothing would ever pick up (2026-10-05: three, found by
  # hand and recovered by a task of their own). "not merged" is either a merge still to come or a task the
  # review turned down; the coordinator knows which. Run it after each merge and before landing.
  # The integration branch: the integration checkout's current branch, or $3.
  _ib=${3:-}
  _ip=$(awk '/^path /{sub(/^path /,""); print; exit}' "$run/worktrees/integration" 2>/dev/null) || _ip=
  if [ -z "$_ib" ] && [ -n "$_ip" ]; then _ib=$(git -C "$_ip" rev-parse --abbrev-ref HEAD 2>/dev/null) || _ib=; fi
  [ -n "$_ib" ] || { echo "no integration branch: register the integration checkout (fleet.sh worktree <run> integration --create <branch>) or name it: fleet.sh stranded <run> <branch>" >&2; exit 2; }
  _g=${_ip:-.}
  git -C "$_g" rev-parse --verify -q "$_ib" >/dev/null || { echo "integration branch '$_ib' does not resolve in ${_g}" >&2; exit 2; }
  # Two git calls up front instead of several per task: a 200-task run took about a minute the other way,
  # inside `landed`. Every branch, and the ones integration does not hold all of.
  _heads=" $(git -C "$_g" for-each-ref --format='%(refname:lstrip=2)' refs/heads 2>/dev/null | tr '\n' ' ')"
  _unm=" $(git -C "$_g" for-each-ref --no-merged "$_ib" --format='%(refname:lstrip=2)' refs/heads 2>/dev/null | tr '\n' ' ')"
  _n=0; _gone=0; _subj=""; _subjread=""
  for _m in "$run"/tasks/done/*; do
    [ -f "$_m" ] || continue
    _id=${_m##*/}; _bs=""; _tip=""
    while IFS=' ' read -r _k _v; do
      case "$_k" in branch) [ -n "$_bs" ] || _bs=${_v%"$(printf '\r')"} ;; tip) _tip=${_v%"$(printf '\r')"} ;; esac
    done < "$_m"
    # A marker with no branch line (a worker older than the branch line, or a task with no code) is looked
    # up by its id among the branches: `rm/<id>`, `fleet/<chip>/<id>`. The three stranded commits of
    # 2026-10-05 all sat behind such empty markers. ponytail: an id reused by an older run's branch matches
    # too; branch names carry no run id to tell them apart.
    if [ -z "$_bs" ]; then
      for _h in $_heads; do case "$_h" in */"$_id") _bs="$_bs $_h" ;; esac; done
      [ -n "$_bs" ] || continue
    fi
    set -f; for _b in $_bs; do
      # A branch that no longer exists was deleted, almost always after its merge: counted, not listed,
      # or a run that cleans up behind itself buries the one line that matters under a hundred.
      case "$_heads" in *" $_b "*) ;; *) _gone=$((_gone + 1)); continue ;; esac
      case "$_unm" in *" $_b "*) ;; *) continue ;; esac
      _miss=$(git -C "$_g" rev-list --count "$_ib..$_b" 2>/dev/null) || _miss=0
      [ "${_miss:-0}" -gt 0 ] || continue
      _n=$((_n + 1))
      # Merged once? Certain when `finish` recorded the tip and integration holds it: a branch continued from
      # a merged one (a relaunch's `<id>-r1`) has its own tip, never merged. Without a tip (an older marker),
      # a merge commit on integration naming the branch says so; a squash or fast-forward merge names
      # nothing and reads as "not merged". The count is right either way.
      _merged=""
      if [ -n "$_tip" ]; then
        git -C "$_g" merge-base --is-ancestor "$_tip" "$_ib" 2>/dev/null && _merged=1
      else
        if [ -z "$_subjread" ]; then _subj=$(git -C "$_g" log --first-parent --merges --format=%s "$_ib" 2>/dev/null) || _subj=; _subjread=1; fi
        if printf '%s\n' "$_subj" | grep -qF -e "'$_b'" -e "Merge $_b:" -e "Merge $_b "; then _merged=1; fi
      fi
      if [ -n "$_merged" ]; then
        echo "  STRANDED $_id: branch $_b was merged, then got $_miss more commit(s) that $_ib lacks"
      else
        echo "  not merged $_id: branch $_b, $_miss commit(s) not in $_ib"
      fi
    done; set +f
  done
  if [ "$_gone" -gt 0 ]; then echo "  ($_gone done task branch(es) no longer exist: deleted, most likely after their merge)"; fi
  if [ "$_n" = 0 ]; then echo "every done task's branch that still exists is in $_ib"; fi
  exit 0
  ;;

ctx)
  # One line per session whose context crosses its next mark, nothing otherwise; the watch loop calls this
  # every minute. The coordinator's mark is coordinator_handoff_k and a worker's is worker_relaunch_k. Past
  # either, the coordinator does NOT act alone: it asks the operator once and runs `relaunch` on a yes
  # (fleet-plan, 8b) - a chain of handoff chips re-read the world at every hop and lost what lived only in
  # context, which is what this replaces.
  at=$(calint coordinator_handoff_k 700); step=$(calint coordinator_handoff_step_k 100)
  wat=$(calint worker_relaunch_k 700)
  k=$(coord_ctx)
  if [ -n "$k" ]; then
    if [ "$k" -ge "$at" ]; then
      level=$(( at + (k - at) / step * step ))
      last=$(cat "$run/.ctx-warned" 2>/dev/null || echo 0)
      if [ "$level" -gt "$last" ]; then
        echo "$level" > "$run/.ctx-warned"
        echo "COORDINATOR CONTEXT ${k}K (mark ${at}K): bring $absrun/STATE.md up to date, then ask the operator once whether to relaunch the run with a fresh coordinator (fleet-plan, 8b). Do not hand off by chip and do not relaunch unasked. Past this size the reviews you hold start to fall out of context."
      fi
    else
      rm -f "$run/.ctx-warned"
    fi
  fi
  # Workers: one state file per session, so a worker is named once per mark and a reopened chip starts over.
  ws=$(worker_sessions)
  if [ -n "$ws" ]; then
    printf '%s\n' "$ws" | while read -r c sid; do
      chip_finished "$c" && continue
      wk=$(session_ctx "$sid")
      [ -n "$wk" ] || continue
      st="$run/chips/$sid.ctx-warned"
      if [ "$wk" -lt "$wat" ]; then rm -f "$st"; continue; fi
      lv=$(( wat + (wk - wat) / step * step ))
      lt=$(cat "$st" 2>/dev/null || echo 0)
      [ "$lv" -gt "$lt" ] || continue
      echo "$lv" > "$st"
      held=$(claims_of "$c" | head -1); held=${held:+holds $held}; held=${held:-no claim}
      echo "WORKER CONTEXT $c ${wk}K (mark ${wat}K, $held): put it in the ONE relaunch ask to the operator (fleet-plan, 8b; the option 'Replace workers $c only' is fleet.sh relaunch $absrun --keep-coordinator $c). Do not message a worker that is still working about its context, and do not ask about it separately."
    done
  fi
  # The watch runs this in the coordinator's session every minute: that keeps its fleet-sessions record
  # fresh, so the context hook's two-day expiry never reaches a coordinator that is still working.
  if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && [ "$(head -1 "$run/coordinator" 2>/dev/null | tr -d '\r')" = "$CLAUDE_CODE_SESSION_ID" ]; then fleet_session; fi
  # Workers on an older plugin than the one installed follow an older protocol: on 2026-10-06 the operator
  # had to ask the coordinator to look for them. Named once per worker and version, for the same one ask.
  _iv=$(installed_version)
  for o in "$run"/offered/*; do
    [ -e "$o" ] || continue; c=$(basename "$o")
    chip_finished "$c" && continue
    grep -lx "$c" "$run"/chips/* >/dev/null 2>&1 || continue # not started
    _wv=$(sed -n 's/.* plugin \([^ ]*\)$/\1/p' "$run/chips/$c.model" 2>/dev/null | tr -d '\r')
    if [ -z "$_wv" ]; then
      if [ -e "$run/chips/$c.model" ]; then _wv="1.5.8-or-1.5.9"; else _wv="older-than-1.5.8"; fi
    fi
    _old=""
    case "$_wv" in 1.5.8-or-1.5.9|older-than-1.5.8) _old=1 ;; esac
    if [ -z "$_old" ] && version_readable "$_wv" && version_readable "$_iv" && version_older "$_wv" "$_iv"; then _old=1; fi
    if [ -n "$_old" ]; then
      [ "$(cat "$run/chips/$c.plugin-warned" 2>/dev/null)" = "$_wv $_iv" ] && continue
      printf '%s %s\n' "$_wv" "$_iv" > "$run/chips/$c.plugin-warned"
      echo "WORKER PLUGIN $c runs makarasty $_wv, $_iv is installed: it follows an older protocol, so a pause or a retirement may not hold it. Put it in the ONE relaunch ask to the operator (option 'Replace workers $c only': fleet.sh relaunch $absrun --keep-coordinator $c) and offer the fresh chips; a fresh chip runs $_iv only if Claude Code was restarted after the update, so say that."
    fi
  done
  ;;

drained)
  chip=${3:?chip id required}
  register_chip "$chip"
  # A retired chip is finished without a `.done`: its work went back to the queue under new ids, and a
  # `.done` written now would be a second marker for a worker `landed` already counts. And a pause is not a
  # drained queue: `.done` written under a pause would end a worker the run is about to need back. Both
  # answers come before the line about the browser pane: a retired or paused worker has nothing to close.
  if [ -e "$run/$chip.retired" ]; then
    echo "RETIRED: chip $chip was replaced by a fresh worker. You were retired: end this turn with one line, commit nothing, start nothing."
    exit 9
  fi
  if [ -e "$run/PAUSED" ]; then
    echo "RUN PAUSED: $(head -1 "$run/PAUSED"). Do NOT write .done."
    echo "Background this, end your turn, and call drained again only after it prints resumed:"
    wake_loop "$chip"
    exit 8
  fi
  # A drained worker still holds its renderer, and only closing the tab gives it back [M34]. This is a
  # directive on a path the worker already walks, like the rename below it; there is no measurement of
  # whether it is obeyed, and it costs one line.
  printf 'CLOSE YOUR BROWSER PANE if you opened one: tabs_close. The renderer lives until the tab does,\n'
  printf 'a reload returns nothing, and one heavy page measured 2,061 MB [M34].\n'
  # A drained queue is not the end of the run while the planner still intends to file work. The marker
  # says so, and it is what lets the repo lane run at full width from the first minute without closing
  # chats that will be needed again an hour later.
  if [ -e "$run/tasks/queue-open" ]; then
    echo "QUEUE OPEN: $(cat "$run/tasks/queue-open" 2>/dev/null | head -1)"
    # The poll carries the same escape the clocks do, and for the same reason: this is armed in a chat
    # that may be asleep when the run lands, and one `landed` call has to end every wait on the machine.
    echo "Nothing ready right now. Poll again rather than finishing:"
    echo "  [ -e \"$absrun/FINISHED\" ] && { echo run-finished; exit 0; }; sleep 300; echo recheck"
    exit 5
  fi
  # Nor is it the end while a ready task is still unheld: `next` answers QUEUE WAITING for a task behind an
  # `after:`, and a worker that took that for the end wrote `.done` here while its wave was still coming.
  # Only tasks this worker could claim count: a repo worker held open by an unclaimed pane task waits for a
  # pane worker it cannot help. The lane rules are the ones `next` applies.
  lane=${4:-}
  unheld=0; opheld=0
  for f in "$run"/tasks/ready/*.md; do
    [ -e "$f" ] || continue
    id=$(basename "$f" .md)
    { [ -e "$run/tasks/done/$id" ] || [ -d "$run/tasks/claimed/$id" ]; } && continue
    if [ -n "$lane" ]; then
      want=$(sed -n 's/^needs:[[:space:]]*\([a-z][a-z]*\).*/\1/p' "$f" | head -1)
      [ -n "$want" ] || want=repo
      if [ "$want" = verify ]; then
        [ "$lane" = pane ] && continue
      elif [ "$want" != "$lane" ]; then
        continue
      fi
    fi
    unheld=$((unheld + 1))
    if [ -n "$(operator_owed "$f")" ]; then opheld=$((opheld + 1)); fi
  done
  if [ "$unheld" -gt 0 ]; then
    echo "QUEUE NOT EMPTY: $unheld ready task(s) nobody holds yet. Do NOT write .done."
    if [ "$opheld" -gt 0 ]; then echo "  $opheld of them wait on the operator; the coordinator has asked, and fleet.sh cleared releases each one."; fi
    echo "Claim again with next, and while it answers QUEUE WAITING poll rather than finishing:"
    echo "  [ -e \"$absrun/FINISHED\" ] && { echo run-finished; exit 0; }; sleep 300; echo recheck"
    exit 5
  fi
  # A ready task whose `needs:` is not a lane is claimable by nobody, so it is in no worker's count above
  # when a lane was named - and a worker told the queue is empty over it writes `.done` and the task sits
  # until `landed` refuses. Name it to the worker, and leave the marker unwritten so the coordinator sees it
  # in `status` rather than finding a finished fleet with a task nobody ever held.
  badlane=$(lane_gaps | grep 'is not a lane' || true)
  if [ -n "$badlane" ]; then
    echo "QUEUE NOT EMPTY: a ready task names a lane nobody can work. Do NOT write .done."
    printf '%s\n' "$badlane"
    echo "Tell the coordinator (fleet.sh ask) and poll rather than finishing:"
    echo "  [ -e \"$absrun/FINISHED\" ] && { echo run-finished; exit 0; }; sleep 300; echo recheck"
    exit 5
  fi
  : > "$run/$chip.done"
  echo "QUEUE DRAINED, $chip.done written"
  echo
  sh "$0" summary "$run" "$chip"
  n=0; [ -e "$run/$chip.jsonl" ] && n=$(grep -c '"severity"' "$run/$chip.jsonl" 2>/dev/null || true)
  [ -n "$n" ] || n=0
  echo
  echo "RENAME THIS SESSION TO: fleet $(basename "$run") $chip - done ${n}f"
  echo "That title is the only thing about you visible from the chat the operator is sitting in."
  ;;

pane-ask)
  # A browser walk, filed as a file, for whichever session is holding a pane. The requester does not need
  # a pane, does not wait, and claims a repo task while the answer is being produced.
  chip=${3:?chip id required}
  mkdir -p "$run/pane/requests" "$run/pane/results" "$run/pane/running"
  n=1; while [ -e "$run/pane/requests/$chip-$n.md" ] || [ -e "$run/pane/results/$chip-$n.json" ]; do n=$((n + 1)); done
  cat > "$run/pane/requests/$chip-$n.md"
  echo "FILED $absrun/pane/requests/$chip-$n.md"
  echo "READ  $absrun/pane/results/$chip-$n.json at your next task boundary"
  ;;

pane-next)
  host=${3:?host chip id required}
  mkdir -p "$run/pane/requests" "$run/pane/results" "$run/pane/running"
  # Oldest first by the time it was filed. The glob's order is lexical, which put `07-10` before `07-2`
  # and every walk of chip 02 before any of chip 07, whatever waited longest. Lexical without node.
  order=""
  if command -v node >/dev/null 2>&1; then
    order=$(node -e 'const fs=require("fs"),p=require("path"),d=process.argv[1];const r=fs.readdirSync(d).filter(f=>f.endsWith(".md")).map(f=>[fs.statSync(p.join(d,f)).mtimeMs,f.slice(0,-3)]);r.sort((a,b)=>a[0]-b[0]||(a[1]<b[1]?-1:1));process.stdout.write(r.map(x=>x[1]).join(" "))' "$run/pane/requests" 2>/dev/null) || order=""
  fi
  if [ -z "$order" ]; then
    for f in "$run"/pane/requests/*.md; do if [ -e "$f" ]; then order="$order $(basename "$f" .md)"; fi; done
  fi
  for id in $order; do   # a walk id is <chip>-<n>, never a space
    f=$run/pane/requests/$id.md
    [ -e "$f" ] || continue
    [ -e "$run/pane/results/$id.json" ] && continue
    if mkdir "$run/pane/running/$id" 2>/dev/null; then
      printf 'host %s\nclaimed %s\n' "$host" "$(now)" > "$run/pane/running/$id/owner"
      echo "WALK $id"
      echo "---"
      cat "$f"
      exit 0
    fi
  done
  echo "NO WALKS PENDING"
  exit 3
  ;;

pane-serve)
  host=${3:?host chip id required}; id=${4:?walk id required}
  [ -d "$run/pane/running/$id" ] || { echo "no claimed walk $id" >&2; exit 2; }
  grep -q "host $host\$" "$run/pane/running/$id/owner" 2>/dev/null || { echo "WALK LOST $id" >&2; exit 4; }
  gate_min=$(cal frame_gate_min_fps 60)
  claimed_at=$(sed -n 's/^claimed //p' "$run/pane/running/$id/owner" 2>/dev/null | head -1)
  tmp=$(tmpfile); cat > "$tmp"
  if command -v node >/dev/null 2>&1; then
    GATE_MIN="$gate_min" CLAIMED_AT="$claimed_at" node -e '
      const fs=require("fs");
      let o; try { o = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }
      catch (e) { console.error("REFUSED: not one JSON object: "+e.message); process.exit(1); }
      const p=[];
      // The requester never saw the pane, so the result has to carry the proof the pane was real. This is
      // the one thing a session driving its own pane could never check about itself.
      const floor = Number(process.env.GATE_MIN || 60);
      if (typeof o.gate !== "number") p.push("gate: the frame count this walk was measured under, as a number");
      else if (o.gate < floor) p.push("gate reads "+o.gate+", which is blind below "+floor+": do not serve a blind walk");
      if (!o.conditions || !/\d/.test(String(o.conditions))) p.push("conditions naming viewport and zoom");
      if (!Array.isArray(o.observations)) p.push("observations: an array, empty is a real answer");
      if (p.length) { console.error("REFUSED: "+p.join("; ")); process.exit(1); }
      o.served_at = new Date().toISOString(); o.host = process.argv[2];
      // The claim time travels into the result because the claim directory is about to be deleted, and
      // without it nobody can say afterwards how long a walk actually took.
      if (process.env.CLAIMED_AT) o.claimed_at = process.env.CLAIMED_AT;
      process.stdout.write(JSON.stringify(o)+"\n");
    ' "$tmp" "$host" > "$run/pane/results/$id.json" || { rm -f "$tmp" "$run/pane/results/$id.json"; exit 1; }
  else
    echo "warning: node absent, this walk is served WITHOUT its gate reading being checked" >&2
    cat "$tmp" > "$run/pane/results/$id.json"
  fi
  rm -f "$tmp"
  rm -rf "$run/pane/running/$id"
  echo "SERVED $id -> $run/pane/results/$id.json"
  ;;

pane-status)
  [ -d "$run/pane/requests" ] || { echo "no pane broker in this run"; exit 0; }
  need_mtime "how long the oldest walk has waited"
  pend=0; oldest=0; nowsec=$(date +%s)
  for f in "$run"/pane/requests/*.md; do
    [ -e "$f" ] || continue; id=$(basename "$f" .md)
    [ -e "$run/pane/results/$id.json" ] && continue
    pend=$((pend + 1))
    t=$(mtime "$f"); [ -n "$t" ] || t=$nowsec
    age=$(( (nowsec - t) / 60 )); [ "$age" -gt "$oldest" ] && oldest=$age
  done
  served=$(ls "$run"/pane/results/*.json 2>/dev/null | wc -l | tr -d ' ')
  median=""
  if command -v node >/dev/null 2>&1; then
    median=$(node -e '
      const fs=require("fs"), path=require("path"), d=process.argv[1];
      let mins=[];
      try { for (const f of fs.readdirSync(d)) {
        if (!f.endsWith(".json")) continue;
        const o=JSON.parse(fs.readFileSync(path.join(d,f),"utf8"));
        if (o.claimed_at && o.served_at) {
          const m=(Date.parse(o.served_at)-Date.parse(o.claimed_at))/60000;
          if (Number.isFinite(m) && m >= 0) mins.push(m);
        }
      } } catch {}
      if (mins.length) { mins.sort((a,b)=>a-b); process.stdout.write(String(Math.round(mins[Math.floor(mins.length/2)]))); }
    ' "$run/pane/results" 2>/dev/null)
  fi
  echo "pane walks: $pend pending, oldest waiting ${oldest}m, $served served${median:+, median lease ${median}m}"
  # One host is enough until a walk waits longer than a walk takes. Falls back to a flat twenty minutes
  # only while no walk has been served yet and there is no lease to compare against.
  behind=$median
  if [ -z "$behind" ]; then
    behind=20
    [ "$pend" -gt 0 ] && echo "  no walk has been served yet, so this compares against a flat 20 minutes"
  fi
  if [ "$pend" -gt 0 ] && [ "$oldest" -gt "$behind" ]; then
    echo "  the pane lane is behind: the oldest walk has waited longer than a lease takes. Offer one more host chip"
  fi
  exit 0
  ;;

answer)
  # One answer, addressed to every question it settles. The planner keeps combining answers into one file
  # with a name of its own - `05-1-2-3.md` - and then nothing finds it: the worker looks for
  # `answers/05-1.md` and `status` goes on reporting the question as open for the rest of the run.
  # Measured 2026-08-31: four questions answered, all four still listed as unanswered an hour later.
  shift 2
  [ $# -gt 0 ] || { echo "usage: fleet.sh answer <run-dir> <question-id> [question-id...]" >&2; exit 2; }
  mkdir -p "$run/answers"
  tmp=$(tmpfile); cat > "$tmp"
  [ -s "$tmp" ] || { rm -f "$tmp"; echo "refusing to write an empty answer" >&2; exit 2; }
  for id in "$@"; do
    id=${id%.md}
    [ -e "$run/ask/$id.md" ] || echo "warning: no question $id.md in ask/" >&2
    cp "$tmp" "$run/answers/$id.md"
    echo "ANSWERED $id"
  done
  rm -f "$tmp"
  ;;

broadcast)
  # Something every worker must read, rather than an answer to one of them. Workers read it at each task
  # boundary, so it is the cheapest way to stop five chats rediscovering the same broken tool.
  # Every worker reads the whole file, including one that starts a day later, so each entry carries its
  # time, and an order meant for named chips does not belong here: 2026-10-06, worker 20 retired at 420K on
  # a "workers 01-05 retire, your context is past 400K" entry written eighteen hours before it started.
  mkdir -p "$run/answers"
  _b=$(cat)
  case "$_b" in *[Rr][Ee][Tt][Ii][Rr][Ee]*)
    echo "NOTE: a retire order in the broadcast is read by every worker, later ones too; retire chips with fleet.sh relaunch instead" >&2 ;;
  esac
  printf '\n## %s\n%s\n' "$(now)" "$_b" >> "$run/answers/00-broadcast.md"
  echo "BROADCAST appended to $run/answers/00-broadcast.md"
  ;;

sweep)
  # Abandoned claims. A worker that dies holding a task leaves a claim directory that no atomic primitive
  # will ever clean up - the maildir lesson: `tmp/` needs a sweeper or it accumulates forever. This is the
  # planner's tool and it is deliberately conservative: it names candidates, and only releases them when
  # told to, because the three-term dead test exists for a reason.
  #
  #   fleet.sh sweep <run-dir>            list claims that look abandoned
  #   fleet.sh sweep <run-dir> --release  rename them aside so the task can be re-filed
  release=""
  [ "${3:-}" = "--release" ] && release=1
  need_mtime "how long a claim has been quiet"
  # Heartbeats stop during a pause on purpose: the hooks hold every worker, and a held worker beats nothing.
  # Reading that silence as death would name - or with --release, reclaim - every claim in the run, and the
  # workers then wake to CLAIM LOST on tasks they were told to keep. `resume` touches each claim's heartbeat
  # file so the minutes of the pause are not held against the claim afterwards either.
  if [ -e "$run/PAUSED" ]; then
    echo "run paused ($(head -1 "$run/PAUSED")): no claim is reported or reclaimed while a pause stands"
    exit 0
  fi
  nowsec=$(date +%s 2>/dev/null || echo 0)
  found=0
  for d in "$run"/tasks/claimed/*/; do
    [ -d "$d" ] || continue
    id=$(basename "$d")
    case "$id" in *.dead-*|*.released-*) continue;; esac
    [ -e "$run/tasks/done/$id" ] && continue
    owner=$(head -1 "$d/owner" 2>/dev/null || echo "NO OWNER")
    hb=$(mtime "$d/heartbeat"); [ -n "$hb" ] || hb=$(mtime "$d/owner")
    age=0; [ -n "$hb" ] && [ "$nowsec" -gt 0 ] && age=$(( (nowsec - hb) / 60 ))
    budget=$(sed -n 's/^budget:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$run/tasks/ready/$id.md" 2>/dev/null | head -1)
    [ -n "$budget" ] || budget=25
    # All three terms, as PULL.md requires: no done marker, nothing written for longer than one budget,
    # and the claim still standing. Anything younger is a worker doing slow work.
    if [ "$age" -gt "$budget" ]; then
      found=$((found + 1))
      echo "ABANDONED? $id  $owner  quiet ${age}m against a ${budget}m budget"
      if [ -n "$release" ]; then
        stampsuffix=$(date +%Y%m%dT%H%M%S 2>/dev/null || echo swept)
        # The ready file leaves the queue with the claim, and so does anything whose `after:` was waiting
        # on it. Leaving the id in place would hand it straight back to the next `next`, and a slow
        # worker's late write would then land on live work rather than in the graveyard - which is the
        # whole reason a reclaimed task returns under a new id. The file goes FIRST: renamed claim first,
        # a `next` in between re-claimed the same id and then found its task file gone.
        echo "  released; the task file is in tasks/released/ - re-file it under a NEW id, never this one"
        release_task "$id"
        mv "$d" "$run/tasks/claimed/$id.released-$stampsuffix"
      fi
    fi
  done
  # A pane walk is claimed with the same mkdir as a task and has no heartbeat, and nothing has ever swept
  # `pane/running/`: `pane-serve` deletes the result it refused but leaves the claim standing, so a walk
  # that failed the gate is unclaimable by every host forever while the requester waits for a result
  # nobody can produce. The lease has to outlast a slow walk, because there is no beat to refresh it.
  lease=$(calint pane_walk_lease_minutes 30)
  for d in "$run"/pane/running/*/; do
    [ -d "$d" ] || continue
    id=$(basename "$d")
    [ -e "$run/pane/results/$id.json" ] && continue
    hb=$(mtime "$d/owner")
    age=0; [ -n "$hb" ] && [ "$nowsec" -gt 0 ] && age=$(( (nowsec - hb) / 60 ))
    if [ "$age" -gt "$lease" ]; then
      found=$((found + 1))
      echo "ABANDONED? walk $id  $(head -1 "$d/owner" 2>/dev/null || echo "NO OWNER")  claimed ${age}m ago against a ${lease}m lease"
      if [ -n "$release" ]; then
        rm -rf "$d"
        echo "  released; the walk is pending again and the next 'pane-next' will hand it out"
      fi
    fi
  done
  [ "$found" = 0 ] && echo "no abandoned claims"
  [ -n "$release" ] || { [ "$found" = 0 ] || echo "Nothing was changed. Add --release once you have checked the workers are really gone."; }
  ;;

recover)
  # A cold start, after the machine died rather than after a worker stalled.
  #
  # `sweep` and the revive message both assume the sessions are still there: one names a claim nobody is
  # advancing, the other pokes the chat holding it. Neither survives a power cut, because a message needs a
  # live receiver and after a reboot there are none. Measured 2026-09-01: 26 worker sessions of two runs
  # were gone from `ListAgents` (five unrelated chats, started minutes earlier) and from the app's own
  # session list (twenty rows, not one of them a fleet chip) - so a planner asked to bring the run back
  # correctly answered that it could not, and the operator was left choosing between a fresh run and
  # walking the queue by hand.
  #
  # What did survive is on disk and is enough: `chips/<session-id>` was written at the first claim, the
  # claims are still standing, and Claude Code keeps every session's transcript under
  # ~/.claude/projects/<slug>/<session-id>.jsonl. A session with a transcript can be reopened with its
  # context intact (`claude -r <session-id>`), which is worth far more than a fresh chip on the same task.
  #
  # So this prints three lists and nothing else, unless asked:
  #   RESUME   the worker has a transcript and unfinished business - reopen it, do not respawn it
  #   RESPAWN  no transcript, or it landed nothing - the task goes back in the queue under a new id
  #   LANDED   done or blocked, no open claim - leave it alone
  #
  #   fleet.sh recover <run-dir>            report only
  #   fleet.sh recover <run-dir> --release  also release the claims of chips that cannot be resumed
  release=""
  [ "${3:-}" = "--release" ] && release=1
  # How long ago a transcript was last written is the whole of the LIVE? test, and an unreadable one reads
  # as zero, which sends a session somebody is sitting in down the RESUME branch and invites a second
  # writer onto an open file.
  need_mtime "how long ago each session was last written to"
  nowsec=$(date +%s 2>/dev/null || echo 0)
  # The host lets an operator move its whole configuration directory, transcripts included. Reading only
  # `$HOME/.claude` on such a machine reports every chip as RESPAWN, and `--release` would then free every
  # open claim including live workers' - the one destructive path here, driven by an absence that means
  # nothing. Honour the host's own variable, and keep the plugin-private one as the override.
  proj=${CLAUDE_PROJECTS_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects}

  # Where a chip's transcript lives. The project directory is the working directory with every separator
  # replaced, and one run can span worktrees, so search rather than reconstruct the slug.
  transcript() { # transcript <session-id>
    ls "$proj"/*/"$1".jsonl 2>/dev/null | head -1
  }

  # The directory a session was started in, read from its own first line. A worker in a worktree has a
  # different one from the planner, and reopening a session from the wrong directory either refuses on an
  # older CLI or resumes against the wrong tree.
  # Not line 1: the first record is often a queued prompt, which carries no `cwd`. Read the first few and
  # take the first one that has it.
  sessioncwd() { # sessioncwd <transcript-path>
    head -20 "$1" 2>/dev/null | sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p' | head -1 | sed 's/\\\\/\\/g'
  }

  # A transcript corpus that holds nothing is not evidence that the workers are gone; it is evidence that
  # this is not the machine, or not the directory, that ran them.
  havecorpus=""
  ls "$proj"/*/*.jsonl >/dev/null 2>&1 && havecorpus=1
  if [ -z "$havecorpus" ]; then
    echo "== no session transcripts under $proj"
    echo "  Every chip below will read as RESPAWN, and that is this command's blindness rather than a fact"
    echo "  about the workers. Set CLAUDE_CONFIG_DIR or CLAUDE_PROJECTS_DIR if they live elsewhere."
    if [ -n "$release" ]; then
      echo "REFUSED: --release with no transcripts to judge by would free live workers' claims." >&2
      echo "  Use 'fleet.sh sweep --release', which asks the heartbeat question instead." >&2
      exit 2
    fi
  fi
  livemin=$(calint hook_claim_window_minutes 10)

  # A run that already declared itself finished is not automatically nothing to do: `landed` counts markers
  # and a worker that died before writing one is invisible to that count. Say both facts rather than either.
  if [ -e "$run/FINISHED" ]; then
    echo "== this run declared itself finished"
    sed 's/^/  /' "$run/FINISHED"
    echo "  Anything listed as RESUME or RESPAWN below was open when that was written."
  fi

  echo "== chips this run registered"
  any=0
  for f in "$run"/chips/*; do
    [ -e "$f" ] || continue
    sid=$(basename "$f")
    # A session id carries no dot. Every dotted name is a hook's own bookkeeping, not a chip:
    # `.warned-<task>` (fleet-guard), `.memory-warned` and `.browser-warned` (fleet-memory),
    # `.contract-<hex>` (fleet-contract), and whatever a hook adds next.
    case "$sid" in *.*) continue;; esac
    chip=$(cat "$f" 2>/dev/null | tr -d ' \n')
    [ -n "$chip" ] || continue
    any=$((any + 1))

    marker=""
    [ -e "$run/$chip.done" ] && marker="done"
    [ -e "$run/$chip.blocked" ] && marker="${marker:+$marker+}blocked"
    [ -e "$run/$chip.waiting" ] && marker="${marker:+$marker+}waiting"

    # Claims this chip is still holding. A released or dead claim is already accounted for.
    open=""
    for d in "$run"/tasks/claimed/*/; do
      [ -d "$d" ] || continue
      id=$(basename "$d")
      case "$id" in *.dead-*|*.released-*) continue;; esac
      [ -e "$run/tasks/done/$id" ] && continue
      grep -q "chip $chip\$" "$d/owner" 2>/dev/null && open="${open:+$open }$id"
    done

    t=$(transcript "$sid")
    quiet=""
    if [ -n "$t" ] && [ "$nowsec" -gt 0 ]; then
      m=$(mtime "$t"); [ -n "$m" ] && quiet=$(( (nowsec - m) / 60 ))
    fi
    findings=0
    # `|| true`, not `|| echo 0`: grep -c already prints 0 when it matches nothing, then exits 1.
    [ -e "$run/$chip.jsonl" ] && findings=$(grep -c . "$run/$chip.jsonl" 2>/dev/null || true)
    [ -n "$findings" ] || findings=0

    if [ -z "$open" ] && [ -n "$marker" ]; then
      # The session id belongs on this line too. A landed worker is the one whose context a follow-up run
      # wants most - it read the code that produced the findings - and "leave it alone" is advice about
      # this run, not about the next one.
      echo "  LANDED  chip $chip  $marker, $findings findings  ($sid)"
    elif [ -n "$t" ] && [ -n "$quiet" ] && [ "$quiet" -lt "$livemin" ]; then
      # A transcript exists for a session that is still running, too. Reopening one of those puts a second
      # writer on an open file, so say what the evidence actually supports and print no command.
      echo "  LIVE?   chip $chip  ${marker:-no marker}, $findings findings, holding: ${open:-nothing}, written ${quiet}m ago"
      echo "          Wrote to its transcript inside the last ${livemin}m, so it may still be alive. Message it, or wait."
    elif [ -n "$t" ]; then
      echo "  RESUME  chip $chip  ${marker:-no marker}, $findings findings, holding: ${open:-nothing}${quiet:+, quiet ${quiet}m}"
      # The command as the operator needs it: the right directory, and a first instruction, because a
      # session reopened with no prompt sits there until somebody types into it - which is twenty-six
      # sessions of silence in a run this size. The heartbeat is the first thing it should write: that is
      # what turns "I ran the command" into something `fleet.sh status` can see.
      cwd=$(sessioncwd "$t")
      first=$(printf '%s' "$open" | cut -d' ' -f1)
      echo "          ${cwd:+cd \"$cwd\" && }claude -r $sid \"Resumed after a crash. ${first:+Run fleet.sh beat on $first, then }continue the run.\""
      if [ -z "$cwd" ]; then
        echo "          (its working directory is not in the transcript - run this from the directory the chip was started in)"
      fi
    else
      echo "  RESPAWN chip $chip  ${marker:-no marker}, $findings findings, holding: ${open:-nothing}"
      echo "          no transcript under $proj - its context is gone, so re-file the task and spawn a fresh chip"
    fi
  done
  if [ "$any" = 0 ]; then echo "  none: no chip ever claimed through fleet.sh in this run"; fi

  # Work nobody is holding. After a cold start this is what decides how many chips to open, and it is not
  # the same number as the chips that died: a worker usually finished several tasks before the lights went.
  free=0
  for f in "$run"/tasks/ready/*.md; do
    [ -e "$f" ] || continue
    id=$(basename "$f" .md)
    [ -e "$run/tasks/done/$id" ] && continue
    [ -d "$run/tasks/claimed/$id" ] && continue
    free=$((free + 1))
  done
  echo "== queue"
  echo "  $free ready tasks nobody holds"
  if [ -d "$run/tasks/released" ]; then
    echo "  $(ls "$run"/tasks/released/*.md 2>/dev/null | wc -l | tr -d ' ') released tasks waiting to be re-filed under a new id"
  fi

  if [ -n "$release" ]; then
    echo "== releasing claims held by chips that cannot be resumed"
    freed=0; openclaims=0
    for d in "$run"/tasks/claimed/*/; do
      [ -d "$d" ] || continue
      id=$(basename "$d")
      case "$id" in *.dead-*|*.released-*) continue;; esac
      [ -e "$run/tasks/done/$id" ] && continue
      openclaims=$((openclaims + 1))
      # The chip that owns this claim, and whether its session can still be reopened. A resumable worker
      # keeps its claim: taking it away is how a live worker's finished work lands in the graveyard.
      ochip=$(sed -n 's/^chip //p' "$d/owner" 2>/dev/null | head -1)
      keep=""; known=""
      for f in "$run"/chips/*; do
        [ -e "$f" ] || continue
        s=$(basename "$f"); case "$s" in *.*) continue;; esac
        [ "$(cat "$f" 2>/dev/null | tr -d ' \n')" = "$ochip" ] || continue
        known=1
        [ -n "$(transcript "$s")" ] && keep=1
      done
      [ -n "$keep" ] && continue
      # A chip that never registered a session id is not evidence of death, it is evidence of nothing:
      # registration needs CLAUDE_CODE_SESSION_ID, and a claim made without it looks identical to one made
      # by a worker that is alive and working. `sweep` is the instrument for that case, because it asks the
      # three-term question about heartbeats; this command only speaks about sessions it can look up.
      if [ -z "$known" ]; then
        echo "  UNKNOWN $id (chip ${ochip:-unknown}) - no session id was ever registered for that chip, so"
        echo "          this cannot tell a dead worker from a live one. Use 'fleet.sh sweep --release'."
        continue
      fi
      stampsuffix=$(date +%Y%m%dT%H%M%S 2>/dev/null || echo recovered)
      freed=$((freed + 1))
      echo "  released $id (chip ${ochip:-unknown}) - re-file it under a NEW id, never this one"
      # Task file first, claim second, as in sweep: the other order let a `next` re-claim the same id.
      release_task "$id"
      mv "$d" "$run/tasks/claimed/$id.released-$stampsuffix"
    done
    if [ "$freed" = 0 ]; then
      if [ "$openclaims" = 0 ]; then
        echo "  nothing to release: no claim is open"
      else
        echo "  nothing to release: all $openclaims open claims belong to chips that can be resumed"
      fi
    fi
  else
    echo "== nothing was changed"
    echo "  Resume what you can first. Add --release once you have reopened the resumable chips, so a"
    echo "  worker that comes back does not find its own task handed to somebody else."
  fi
  ;;

status)
  # The clock, from the machine. A coordinator that stamped STATE.md from its own sense of time wrote
  # "~13:00" on a snapshot taken at 11:10 (2026-10-06); this line is the time to copy.
  echo "== now $(date '+%Y-%m-%d %H:%M %z')"
  # How long this run has been going, against the ceiling in calibration.json. Comparable tools have
  # documented runs that looped for days; a fleet has no way to stop itself, so the least it can do is say
  # when continuing has become a decision rather than a default.
  maxmin=$(calint max_run_minutes 480)
  first=""
  for f in "$run"/RUN_FORMAT "$run"/tasks/ready/*.md; do
    [ -e "$f" ] || continue; first=$(mtime "$f"); [ -n "$first" ] && break
  done
  if [ -n "$first" ]; then
    nowsec=$(date +%s 2>/dev/null || echo 0)
    if [ "$nowsec" -gt 0 ]; then
      runmin=$(( (nowsec - first) / 60 ))
      echo "== run age ${runmin}m of a ${maxmin}m ceiling"
      [ "$runmin" -gt "$maxmin" ] && echo "  PAST THE CEILING: continuing is a decision now. Land what exists or raise it in calibration.json."
    fi
  elif ! command -v node >/dev/null 2>&1; then
    # The age is not zero, it is unreadable, and a ceiling that silently stops being checked is a ceiling
    # nobody notices is gone. This view is the planner's, so it says so rather than refusing outright.
    echo "== run age unknown: node is absent, so no file's mtime can be read and the ${maxmin}m ceiling is not being checked"
  fi
  # A pause is the first thing the planner has to know: nothing below moves while it stands. The count is of
  # workers HOLDING claims - an idle worker has nothing in hand to stop - and a worker still silent
  # pause_still_working_seconds in (150: a worker may be mid-sleep or mid-build) is named, because that is the one the coordinator messages by title.
  if [ -e "$run/PAUSED" ]; then
    _hold=$(claim_holders); _tot=0; _ack=0; _slow=""
    for _c in $_hold; do
      _tot=$((_tot + 1))
      if [ -e "$run/stopped/$_c" ]; then _ack=$((_ack + 1)); else _slow="$_slow $_c"; fi
    done
    echo "== PAUSED since $(head -1 "$run/PAUSED" | cut -d' ' -f1): $_ack of $_tot workers holding claims have stopped"
    _age=$(pause_age); _still=$(calint pause_still_working_seconds 150)
    for _c in $_slow; do
      if [ "$_age" -ge "$_still" ]; then
        echo "  worker $_c: still working ${_age}s after the pause (message it by its title: fleet $(basename "$absrun") $_c)"
      else
        echo "  worker $_c: no ack yet (${_age}s after the pause; named still working past ${_still}s)"
      fi
    done
  fi
  echo "== claims"
  for d in "$run"/tasks/claimed/*/; do
    [ -d "$d" ] || continue
    id=$(basename "$d")
    # A released or dead claim is closed, as every other loop over claims already treats it.
    case "$id" in *.dead-*|*.released-*) continue;; esac
    [ -e "$run/tasks/done/$id" ] && continue
    o=$(head -1 "$d/owner" 2>/dev/null || echo "NO OWNER")
    hb=$(cat "$d/heartbeat" 2>/dev/null || echo "none")
    cl=$(sed -n 's/^claimed //p' "$d/owner" 2>/dev/null || echo "?")
    flag=""; [ "$hb" = "$cl" ] && flag=" NEVER-BEAT"
    echo "  $id  $o  claimed $cl  beat $hb$flag"
  done
  # Workers held on memory hold no claim, so nothing else in this report would show them. An idle chat
  # sitting on a two gigabyte pane is invisible to every script here and the operator is the only one who
  # can close it, so name what is holding the machine beside the count.
  held=$(ls "$run"/tight 2>/dev/null | tr "
" " ")
  [ -n "$held" ] && echo "== held on memory: $held"
  echo "== markers"
  # The `|| echo` this used to end with could never fire: a pipeline's status is the last command's, and
  # `sed` succeeds on empty input, so a run with no marker at all printed a heading and nothing under it.
  mk=$(ls "$run"/*.done "$run"/*.blocked "$run"/*.retired "$run"/*.waiting 2>/dev/null | sed 's|.*/|  |')
  printf '%s\n' "${mk:-  none}"
  echo "== questions without answers"
  bc="$run/answers/00-broadcast.md"
  for q in "$run"/ask/*.md; do
    [ -e "$q" ] || continue
    b=$(basename "$q")
    [ -e "$run/answers/$b" ] && continue
    # A broadcast written after the question may already have settled it, and the planner will not
    # remember which. Say so rather than reporting a closed question as open for the rest of the run.
    if [ -e "$bc" ] && [ "$bc" -nt "$q" ]; then
      echo "  $b  (a broadcast landed after it - answer it by name with 'fleet.sh answer' if it is settled)"
    else
      echo "  $b"
    fi
  done
  gap=$(lane_gaps)
  if [ -n "$gap" ]; then echo "== lanes with work and no worker"; printf '%s\n' "$gap"; fi
  # What the queue is waiting on. A task whose own `after:` is satisfied but that holds three or more open
  # tasks behind it is where the run's speed is decided, and a task carrying `operator: <what>` waits on a
  # person. Measured 2026-10-06: every remaining plan task sat behind one permissions task for about two
  # hours, closing 8 then 4 tasks an hour, until the operator was asked; nothing printed that chain.
  if command -v node >/dev/null 2>&1; then
    RUN="$run" node -e '
      const fs=require("fs"),p=require("path"),r=process.env.RUN,T=p.join(r,"tasks");
      const ls=d=>{try{return fs.readdirSync(d)}catch{return[]}};
      const done=new Set(ls(p.join(T,"done"))), filed=new Set(), t={}, bad=[];
      for (const f of ls(p.join(T,"ready"))) if (f.endsWith(".md")) filed.add(f.slice(0,-3));
      for (const id of filed) {
        const b=fs.readFileSync(p.join(T,"ready",id+".md"));
        // A file that went in by hand rather than through `fleet.sh file` is checked the same way here.
        let s; try{s=new TextDecoder("utf-8",{fatal:true}).decode(b)}catch{bad.push(`${id}: not valid UTF-8`);continue}
        const fm=(s.replace(/^\uFEFF/,"").match(/^---\r?\n([\s\S]*?)\r?\n---/)||[])[1];
        if (fm===undefined){bad.push(`${id}: no --- frontmatter`);continue}
        const g=k=>((fm.match(new RegExp("^"+k+":[ \t]*(.*)$","m"))||[])[1]||"").trim();
        if (!/^(pane|repo|verify)\b/.test(g("needs"))) bad.push(`${id}: needs: "${g("needs")}" is not pane, repo or verify, so no worker claims it`);
        if (done.has(id)) continue;
        let who=""; try{who=(fs.readFileSync(p.join(T,"claimed",id,"owner"),"utf8").match(/^chip (\S+)/m)||[])[1]||""}catch{}
        const op=g("operator");
        t[id]={after:g("after").split(/[\s,]+/).filter(Boolean),op:/^(none|no|-|n.a|nothing|false|done)?$/i.test(op)?"":op,who};
      }
      const behind=id=>{const seen=new Set(),q=[id];while(q.length){const x=q.pop();for(const[k,v]of Object.entries(t))if(!seen.has(k)&&v.after.includes(x)){seen.add(k);q.push(k)}}return seen.size};
      const st=id=>t[id].who?"claimed by "+t[id].who:"ready, unclaimed";
      // `next` releases a task only on a done marker for every after: id, so a root is a task whose after:
      // is all done; one naming an id nothing filed and nothing finished waits for ever.
      const dangling=Object.keys(t).flatMap(id=>t[id].after.filter(a=>!done.has(a)&&!filed.has(a)).map(a=>[id,a]));
      if (dangling.length){console.log("== waits for ever");for(const[id,a]of dangling)console.log(`  ${id}: after: ${a}, which is neither filed nor done (${behind(id)} behind it)`)}
      const roots=Object.keys(t).filter(id=>t[id].after.every(a=>done.has(a))).map(id=>[id,behind(id)]).filter(x=>x[1]>=3).sort((a,b)=>b[1]-a[1]).slice(0,5);
      if (roots.length){console.log("== bottlenecks");for(const[id,n]of roots)console.log(`  ${id}: ${n} open task(s) wait behind it, ${st(id)}${t[id].op?", WAITS ON THE OPERATOR":""}`)}
      const ops=Object.keys(t).filter(id=>t[id].op);
      if (ops.length){console.log("== waiting on the operator (next holds these until fleet.sh cleared <run> <id>)");for(const id of ops)console.log(`  ${id}: ${t[id].op} (${behind(id)} behind it, ${st(id)})`)}
      if (bad.length){console.log("== task files fleet.sh file would refuse");for(const x of bad)console.log("  "+x)}
    ' 2>/dev/null || true
  fi
  echo "== workers"
  _pv=$(plugin_version)
  for o in "$run"/offered/*; do
    [ -e "$o" ] || continue
    nn=$(basename "$o"); m=$(cat "$run/chips/$nn.model" 2>/dev/null || echo "model not recorded yet")
    started=no; grep -lx "$nn" "$run"/chips/* >/dev/null 2>&1 && started=yes
    [ -e "$run/$nn.retired" ] && started="$started, RETIRED"
    echo "  $nn  lane $(cat "$o")  started $started  $m"
    # A worker on another plugin version follows another protocol. Say so while it is still running, not
    # when its markers turn out empty. One that started and never recorded itself is older than `whoami`.
    _wv=$(sed -n 's/.* plugin \([^ ]*\)$/\1/p' "$run/chips/$nn.model" 2>/dev/null | tr -d '\r')
    if [ -e "$run/$nn.retired" ] || [ -e "$run/$nn.done" ]; then :
    elif [ -n "$_wv" ] && [ "$_wv" != "$_pv" ] && ! { version_readable "$_wv" && version_readable "$_pv"; }; then
      echo "    OTHER PLUGIN: worker $nn recorded makarasty '$_wv', which cannot be compared with this fleet.sh ($_pv)"
    elif [ -n "$_wv" ] && [ "$_wv" != "$_pv" ]; then
      _rel=newer; version_older "$_wv" "$_pv" && _rel=older
      echo "    OTHER PLUGIN: worker $nn runs makarasty $_wv, $_rel than this fleet.sh ($_pv); its markers and acks follow that version's protocol"
    elif [ -z "$_wv" ] && [ -e "$run/chips/$nn.model" ]; then
      echo "    OTHER PLUGIN: worker $nn runs makarasty 1.5.8 or 1.5.9 (whoami recorded no version), older than this fleet.sh ($_pv)"
    elif [ "$started" = yes ] && [ ! -e "$run/chips/$nn.model" ]; then
      echo "    never ran whoami: a plugin older than 1.5.8, or it skipped the step; check its markers carry a branch line"
    fi
  done
  # Budgets against what tasks actually took. The 2026-10-05 build ran a median of four minutes against
  # budgets of 45 to 150, so no abort clock could ever fire; the planner re-budgets from this line.
  if command -v node >/dev/null 2>&1; then
    RUN="$run" node -e '
      const fs=require("fs"),p=require("path"),r=process.env.RUN; const work=[],bud=[];
      for (const id of fs.readdirSync(p.join(r,"tasks","done"))) {
        try {
          const o=fs.readFileSync(p.join(r,"tasks","claimed",id,"owner"),"utf8").match(/claimed (\S+)/);
          const t=fs.readFileSync(p.join(r,"tasks","ready",id+".md"),"utf8").match(/^budget:\s*(\d+)/m);
          if (!o) continue;
          work.push((fs.statSync(p.join(r,"tasks","done",id)).mtimeMs-Date.parse(o[1]))/60000);
          bud.push(t?+t[1]:25);
        } catch {}
      }
      if (work.length<3) process.exit(0);
      const med=a=>{a=[...a].sort((x,y)=>x-y);return a[Math.floor(a.length/2)];};
      const w=med(work),b=med(bud);
      console.log("== budgets");
      console.log(`  ${work.length} tasks done: median ${Math.round(w)} min of work against a median budget of ${b} min`);
      if (w*4<b) console.log("  BUDGETS TOO LOOSE: no abort clock can fire. Budget the next tasks at about three times the measured median.");
    ' 2>/dev/null || true
  fi
  k=$(coord_ctx)
  if [ -n "$k" ]; then
    echo "== coordinator context: ${k}K"
    # if/then, not `&&`: the report is complete here, and under `set -e` an `&&` that is false as the last
    # statement made `status` exit 1 exactly when the coordinator was still below its mark.
    if [ "$k" -ge "$(calint coordinator_handoff_k 700)" ]; then
      echo "  past the mark: update STATE.md and ask the operator once about a relaunch (fleet-plan, 8b); fleet.sh contexts lists every session"
    fi
  fi
  ;;

summary)
  # The end banner. A finished chat has to be readable at a glance from the sidebar and from three feet
  # away, so this is the same block for a worker and for the run, generated from disk rather than from
  # anyone's memory of what they did. The trailing JSON line is there so a later script can read it back.
  one=${3:-}
  sev() { grep -c "\"severity\"[[:space:]]*:[[:space:]]*\"$2\"" "$1" 2>/dev/null || true; }
  row() {
    c=$1; f=$run/$c.jsonl
    n=0; [ -e "$f" ] && n=$(grep -c . "$f" 2>/dev/null || true)
    [ -n "$n" ] || n=0
    b=$(sev "$f" blocker); m=$(sev "$f" major); mi=$(sev "$f" minor); po=$(sev "$f" polish)
    u=$(grep -c '"unreached"' "$f" 2>/dev/null || true)
    t=0; for o in "$run"/tasks/claimed/*/owner; do
      [ -e "$o" ] || continue; id=$(basename "$(dirname "$o")")
      if grep -q "chip $c\$" "$o" 2>/dev/null && [ -e "$run/tasks/done/$id" ]; then t=$((t + 1)); fi
    done
    st=running
    if [ -e "$run/$c.done" ]; then st=done; fi
    if [ -e "$run/$c.blocked" ]; then st=BLIND; fi
    if [ -e "$run/$c.waiting" ]; then st=WAITING; fi
    printf '  %-4s %-8s tasks %-3s findings %-4s  blocker %-3s major %-3s minor %-3s polish %-3s unreached %s\n' \
      "$c" "$st" "$t" "$n" "$b" "$m" "$mi" "$po" "$u"
  }
  echo "=============================================================="
  if [ -n "$one" ]; then
    echo " WORKER $one FINISHED - $(basename "$run")"
    echo "=============================================================="
    row "$one"
    if [ -e "$run/$one.blocked" ]; then echo "  blind: $(head -1 "$run/$one.blocked")"; fi
    echo "  findings: $run/$one.jsonl     notes: $run/$one.notes.md"
  else
    echo " RUN FINISHED - $(basename "$run")"
    echo "=============================================================="
    chipids | while IFS= read -r c; do row "$c"; done
    echo "--------------------------------------------------------------"
    # The same set of files the rows above were built from. They used to be different globs, and a chip id
    # that is not a number - `cid-03` and its kind have been in the ledger since 2026-09-03 - printed rows
    # full of findings above a total of 0, which `landed` then paged to the operator's phone.
    tot=$(chipcat | grep -c '"severity"' || true)
    tb=$(chipcat | grep -c '"severity"[[:space:]]*:[[:space:]]*"blocker"' || true)
    tm=$(chipcat | grep -c '"severity"[[:space:]]*:[[:space:]]*"major"' || true)
    dn=$(ls "$run"/*.done 2>/dev/null | wc -l | tr -d ' ')
    bl=$(ls "$run"/*.blocked 2>/dev/null | wc -l | tr -d ' ')
    wt=$(ls "$run"/*.waiting 2>/dev/null | wc -l | tr -d ' ')
    rd=$(ls "$run"/tasks/ready/*.md 2>/dev/null | wc -l | tr -d ' ')
    td=$(ls "$run"/tasks/done 2>/dev/null | wc -l | tr -d ' ')
    echo "  workers done $dn, blind $bl, waiting on the operator $wt"
    echo "  tasks $td of $rd finished, findings $tot, blockers $tb, majors $tm"
    # Contract changes workers took without asking. They are legitimate and they are the thing an
    # operator most needs to see before a run lands: three of them shipped from one project's runs and
    # broke a consumer outside the application that nobody in the run could see.
    dec=$(grep -c . "$run/decisions.jsonl" 2>/dev/null || true)
    [ -n "$dec" ] || dec=0
    if [ "$dec" -gt 0 ]; then
      echo "  contract changes decided without asking: $dec, in $run/decisions.jsonl - read them before landing"
    fi
    echo "  backlog: $run/backlog.md"
    printf 'fleet-summary: {"run":"%s","workers_done":%s,"blind":%s,"waiting":%s,"tasks_done":%s,"tasks_total":%s,"findings":%s,"blockers":%s,"majors":%s,"decisions":%s}\n' \
      "$(basename "$run")" "$dn" "$bl" "$wt" "$td" "$rd" "$tot" "$tb" "$tm" "$dec"
  fi
  echo "=============================================================="
  ;;

landed)
  want=${3:?expected chip count required}
  fail=0
  # Chips, not markers. A worker that went blind and then finished writes both `<chip>.done` and
  # `<chip>.blocked`, and counting the files made one worker look like two: the run then read as complete
  # with a worker still out, wrote FINISHED on that count, and paged the phone to say so.
  have=$(ls "$run"/*.done "$run"/*.blocked "$run"/*.retired 2>/dev/null | sed 's|.*/||; s|\.[^.]*$||' | sort -u | wc -l | tr -d ' ')
  [ "$have" -ge "$want" ] || { echo "NOT LANDED: $have of $want workers finished"; fail=1; }
  if [ -e "$run/PAUSED" ]; then echo "NOT LANDED: the run is paused ($(head -1 "$run/PAUSED"))"; fail=1; fi
  for d in "$run"/tasks/claimed/*/; do
    [ -d "$d" ] || continue; id=$(basename "$d")
    # A claim the planner took back is renamed rather than deleted, so the graveyard entry keeps its
    # evidence and a slow worker's late write lands somewhere harmless. Those are closed, not open.
    case "$id" in *.dead-*|*.released-*) continue;; esac
    [ -e "$run/tasks/done/$id" ] || { echo "NOT LANDED: claim without a done marker: $id"; fail=1; }
  done
  for f in "$run"/tasks/ready/*.md; do
    [ -e "$f" ] || continue; id=$(basename "$f" .md)
    # A claim that was released or declared dead still proves somebody took the task; what it does not
    # prove is that the work happened, which is why the planner re-files it under a new id.
    taken=""
    [ -d "$run/tasks/claimed/$id" ] && taken=1
    for g in "$run"/tasks/claimed/"$id".released-* "$run"/tasks/claimed/"$id".dead-*; do
      [ -d "$g" ] && taken=1
    done
    if [ -z "$taken" ]; then
      _op=$(operator_owed "$f")
      echo "NOT LANDED: task nobody ever claimed: $id${_op:+ (it waits on the operator: $_op; fleet.sh cleared $absrun $id once done)}"; fail=1
    fi
  done
  # A task the sweep released left the queue, so the loop above cannot see it. It is still work somebody
  # started and nobody finished: either the planner re-filed it under a new id, in which case delete the
  # released file, or the run is landing over abandoned work.
  for f in "$run"/tasks/released/*.md; do
    [ -e "$f" ] || continue; id=$(basename "$f" .md)
    echo "NOT LANDED: $id was released and never accounted for. Either re-file its work under a NEW id"
    echo "            and delete tasks/released/$id.md, or delete that file alone to write the task off."
    fail=1
  done
  # Exists, not non-empty: merge writes an empty backlog when the workers filed nothing, and a run that
  # refuted nothing - a call run, a canvas run without a compare stage - has still ended.
  [ -e "$run/backlog.jsonl" ] || { echo "NOT LANDED: backlog.jsonl is missing: run merge first"; fail=1; }
  if ls "$run"/*.waiting >/dev/null 2>&1; then echo "NOT LANDED: a worker is waiting on the operator"; fail=1; fi
  if [ -e "$run/tasks/queue-open" ]; then echo "NOT LANDED: the planner has not closed the queue"; fail=1; fi
  # Said, not refused: the label is a hint (see `stranded`), and the coordinator decides what a late commit is.
  if [ -e "$run/worktrees/integration" ]; then
    if _so=$(sh "$0" stranded "$run" 2>&1); then
      _s=$(printf '%s\n' "$_so" | grep '^  STRANDED' || true)
      if [ -n "$_s" ]; then echo "WARNING: commits made after their branch was merged, which integration lacks:"; printf '%s\n' "$_s"; fi
    else
      echo "WARNING: the stranded-commit check could not run: $(printf '%s' "$_so" | head -1)"
    fi
  fi
  if [ "$fail" = 0 ]; then
    # The run ends by declaration, not by a count somebody read once. This file is the durable answer to
    # "did it finish", readable from any chat and after every notification has been missed.
    first=""; [ -e "$run/FINISHED" ] || first=1
    printf 'finished %s\nworkers %s\n' "$(now)" "$have" > "$run/FINISHED"
    rm -f "$(retiredmark)" 2>/dev/null || true
    for _s in "$(fleetsessions)"/*; do
      [ -f "$_s" ] && [ "$(head -1 "$_s" | tr -d '\r')" = "$absrun" ] && rm -f "$_s" 2>/dev/null || true
    done
    echo "LANDED: $have workers, every claim closed, backlog written, FINISHED written"
    # Then the phone, through the tools plugin's notifier when it is installed: the headline only, never a
    # finding, and only the first time FINISHED is written, so a second landing check does not page twice.
    # FINISHED is already on disk, so a message that never arrives loses nothing.
    nf=$(beside ../tools/hooks/notify.mjs makarasty-tools hooks/notify.mjs)
    if [ -n "$first" ] && [ -n "$nf" ]; then
      tot=$(chipcat | grep -c '"severity"' || true)
      tb=$(chipcat | grep -c '"severity"[[:space:]]*:[[:space:]]*"blocker"' || true)
      bl=$(ls "$run"/*.blocked 2>/dev/null | wc -l | tr -d ' ')
      node "$nf" send "fleet $(basename "$run") FINISHED: $tot findings, $tb blockers, $bl blind, backlog at $run/backlog.md" || true
    fi
  fi
  exit "$fail"
  ;;

worktree)
  # A worktree worker records its tree at its first claim, so `clean` later acts on THIS run's worktrees
  # and no other run's. Refuse a path that is not under a `.claude/worktrees/` segment: a worker not
  # actually in a worktree has nothing to register, and recording its cwd would point `clean` at the
  # project root. See docs/WORKTREES.md.
  chip=${3:?chip id required}
  wt=${4:-$(pwd)}
  # `--create <base>`: the session is not in a worktree of its own - a chip can open in the main checkout -
  # so make one where cleanup can reach it, link the dependencies, and register it. Measured 2026-10-05: a
  # coordinator with no such command wrote thirty lines of worktree setup into its run rules, put the trees
  # at C:/wtRM01..05, where registration refuses them, and so `clean` could never remove one.
  if [ "$wt" = "--create" ]; then
    common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { echo "not inside a git checkout" >&2; exit 2; }
    main=$(dirname "$common")
    # The base is optional because a worker has no source for one: the branch the coordinator is merging
    # into is the main checkout's current branch, and HEAD is what a detached main checkout can say.
    base=${5:-}
    if [ -z "$base" ]; then base=$(git -C "$main" symbolic-ref --short HEAD 2>/dev/null) || base=HEAD; fi
    tag=$(printf '%s' "$(basename "$absrun")" | cksum | cut -c1-5)
    wt="$main/.claude/worktrees/fleet-$tag-$chip"
    # Reuse needs the directory as well as git's record of it: a tree deleted by hand stays listed until
    # pruned, and "reusing" it handed the worker a path that does not exist.
    if [ -d "$wt" ] && git -C "$main" worktree list --porcelain | grep -Fxq "worktree $wt"; then
      echo "reusing $wt"
    else
      git -C "$main" worktree prune >/dev/null 2>&1 || true
      # A tree inside the checkout must not show up as untracked work in it. info/exclude is local to this
      # clone and never committed. The directory may not exist in a clone made without templates, and an
      # exclude file whose last line has no newline would have the new entry glued onto it.
      if ! git -C "$main" check-ignore -q ".claude/worktrees/x" 2>/dev/null; then
        mkdir -p "$common/info"
        if [ -s "$common/info/exclude" ] && [ -n "$(tail -c1 "$common/info/exclude")" ]; then printf '\n' >> "$common/info/exclude"; fi
        printf '%s\n' ".claude/worktrees/" >> "$common/info/exclude"
      fi
      git -C "$main" worktree add --detach "$wt" "$base" >/dev/null || { echo "git worktree add failed for $wt at $base" >&2; exit 2; }
      echo "created $wt at $base"
    fi
    # Dependencies are linked, not installed: one install per worktree is minutes and gigabytes. And on
    # reuse too: a worker that unlinked its tree before `drained`, then got another task, comes back to a
    # tree with no links, and a link already there is skipped. Every real node_modules within three levels of the main checkout gets a link in the same place - three,
    # because a monorepo keeps them at apps/web/node_modules - and a node_modules is never entered, so
    # a package inside one is not mistaken for a project of its own.
    find "$main" -maxdepth 3 \( -name .git -o -name .claude \) -prune -o -type d -name node_modules -print -prune 2>/dev/null | while IFS= read -r nm; do
      relnm=${nm#"$main"/}; link="$wt/$relnm"
      [ -d "$(dirname "$link")" ] && [ ! -e "$link" ] || continue
      if case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*) cmd //c mklink //J "$(cygpath -w "$link")" "$(cygpath -w "$nm")" >/dev/null ;;
        *) ln -s "$nm" "$link" ;;
      esac; then echo "linked $relnm"; else echo "warning: could not link $relnm into $wt; the worker there has no dependencies for it" >&2; fi
    done
    echo "WORKTREE $wt"
    echo "  Work there by absolute path, and start each task on its own branch: git -C \"$wt\" switch -c <branch> $base"
    echo "  Never delete it yourself: the links in it lead into the main checkout. fleet.sh unlink, then clean."
  fi
  # Store the path in git's own spelling, so `clean` can match it against `git worktree list` exactly.
  # `/tmp/x` and `C:/.../x` are the same tree, and only git's form compares reliably across Git Bash.
  canon=$(git -C "$wt" rev-parse --show-toplevel 2>/dev/null || echo "")
  [ -n "$canon" ] && wt=$canon
  MIN_PATH_SEGMENTS=$(min_floor)
  # Catch a tree that can never be cleaned at the moment it is CREATED rather than at the end of the run,
  # because that is the moment somebody can still move it: a worktree at `C:/wtmerge` is one slip from the
  # drive root, so cleanup will refuse it forever and it accumulates instead. Registration deletes
  # nothing, and its default argument is the worker's own cwd, so the working-directory term is skipped:
  # with it, a worker registering the tree it is standing in - the documented call - refused itself.
  if why=$(unsafe_path "$wt" ".claude/worktrees" nothing-is-deleted); then
    echo "REFUSED to register this worktree: $why" >&2
    echo "  A worktree this plugin can clean up lives under <project>/.claude/worktrees/, which is where" >&2
    echo "  the harness's own EnterWorktree puts it. Move it with:  git worktree move \"$wt\" <project>/.claude/worktrees/<name>" >&2
    exit 2
  fi
  br=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  mkdir -p "$run/worktrees"
  printf 'path %s\nbranch %s\nchip %s\n' "$wt" "$br" "$chip" > "$run/worktrees/$chip"
  echo "registered worktree $wt (branch ${br:-unknown}) for chip $chip"
  ;;

unlink)
  # A worker leaving its worktree needs the unlink as a command rather than as a sentence in a document.
  # It is the step most likely to be skipped, and this repository's own ledger says a rule that is only
  # written down does not hold. Safe to run twice and safe to run on a tree with no links.
  # The path is this command's second argument, which every other command spends on the run directory.
  wt=$run
  c=$(git -C "$wt" rev-parse --show-toplevel 2>/dev/null || echo ""); [ -n "$c" ] && wt=$c
  MIN_PATH_SEGMENTS=$(min_floor)
  # The tree itself is not deleted here - only the reparse points inside it - so the working-directory
  # term does not apply, and applying it refused the only way the documents ever call this: from inside
  # the tree, as the last thing a worker does before leaving it (docs/WORKTREES.md, commands/fleet-run.md).
  # This is the step [M32] exists to enforce, and a guard that refused it left the junctions in place.
  if why=$(unsafe_path "$wt" ".claude/worktrees" nothing-is-deleted); then
    echo "REFUSED: $why" >&2; exit 2
  fi
  n=$(unlink_links "$wt")
  echo "unlinked $n reparse point(s) under $wt"
  # A link that would not go is the whole hazard, so it is named and the exit says so.
  left=$(find "$wt" -type l 2>/dev/null | wc -l | tr -d ' ')
  if [ "${left:-0}" != 0 ]; then
    echo "STILL LINKED: $left reparse point(s) under $wt would not unlink. Nothing may delete this tree:" >&2
    find "$wt" -type l 2>/dev/null | sed 's/^/  /' >&2
    exit 1
  fi
  ;;

clean)
  # Remove the worktrees this run created. Dry run unless --remove. The procedure and the measurement
  # behind the unlink-first step are in docs/WORKTREES.md [M32]; the reasoning behind the guards is in
  # docs/SAFETY.md. There is deliberately no flag that deletes a tree holding work: the operator does
  # that in git, having seen the reason printed here.
  do_remove=""
  for a in "$@"; do
    case "$a" in --remove) do_remove=1 ;; esac
  done
  MIN_PATH_SEGMENTS=$(min_floor)
  # One listing for the whole command: it is asked once per worktree otherwise, and the pipeline also put
  # the stray scan in a subshell.
  wtlist=$(git worktree list --porcelain 2>/dev/null || echo "")
  # The main checkout is the first tree git lists. `rev-parse --show-toplevel` answers for wherever this
  # shell stands, and from inside a linked worktree that made the worktree "main": the merged test asked
  # about its branch, and the real main checkout was reported as a stray.
  main=$(printf '%s\n' "$wtlist" | sed -n 's/^worktree //p' | head -1)
  # A worktree this run cannot clean is named rather than ignored: it sits there forever and only the
  # operator can move it. Reported before anything else, because a run that registered nothing is exactly
  # the run where a stray would otherwise go unmentioned. Never touched.
  printf '%s\n' "$wtlist" | sed -n 's/^worktree //p' | while IFS= read -r w; do
    [ -n "$w" ] || continue
    [ "$w" = "$main" ] && continue
    if why=$(unsafe_path "$w" ".claude/worktrees"); then
      echo "STRAY $why"
      echo "      nothing here will delete it. Move it under <project>/.claude/worktrees/ with 'git worktree move', or remove it yourself."
    fi
  done
  reg="$run/worktrees"
  if [ ! -d "$reg" ] || [ -z "$(ls -A "$reg" 2>/dev/null)" ]; then
    echo "no worktrees registered for this run; nothing to clean"
    echo "(a worktree worker registers itself with 'fleet.sh worktree \"$absrun\" <chip>'; a run with none is not swept)"
    exit 0
  fi
  removed=0; kept=0
  for entry in "$reg"/*; do
    [ -e "$entry" ] || continue
    wt=$(sed -n 's/^path //p' "$entry" | head -1)
    chip=$(basename "$entry")
    # The integration checkout serves every pane check and holds the run's merges; a recovery runs clean
    # mid-run, and a fast-forward merge leaves its tip inside a task branch, so it would read as removable.
    if [ "$chip" = integration ] && [ ! -e "$run/FINISHED" ]; then
      echo "KEEP  integration: $wt is the run's integration checkout and the run has not landed"
      kept=$((kept+1)); continue
    fi
    # Normalise to git's own spelling when the tree is still on disk, so the membership test matches
    # whatever form `git worktree list` prints regardless of how the path was registered.
    if [ -e "$wt" ]; then c=$(git -C "$wt" rev-parse --show-toplevel 2>/dev/null || echo ""); [ -n "$c" ] && wt=$c; fi
    # The branch is read from the worktree NOW, never from the registration: a worker that switched
    # branches after registering would otherwise have the wrong branch checked and the wrong one deleted.
    br=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    [ -n "$br" ] || br=$(sed -n 's/^branch //p' "$entry" | head -1)
    # `rev-parse --abbrev-ref` says the literal HEAD for a detached tree, which is not a branch, and the
    # hints below must never tell anybody to `git branch -D HEAD`. Blank for display.
    brshow=$br; [ "$brshow" = HEAD ] && brshow=""

    # 1. The path gate, before anything reads the tree.
    if why=$(unsafe_path "$wt" ".claude/worktrees"); then
      echo "SKIP  $chip: $why"; kept=$((kept+1)); continue
    fi
    if [ -n "$main" ] && [ "$wt" = "$main" ]; then
      echo "SKIP  $chip: $wt is the main checkout"; kept=$((kept+1)); continue
    fi
    if ! printf '%s\n' "$wtlist" | grep -Fxq "worktree $wt"; then
      if [ -e "$wt" ]; then
        echo "SKIP  $chip: $wt exists but git does not call it a worktree - leaving it for a human"; kept=$((kept+1))
      else
        echo "gone  $chip: $wt already removed"
        [ -n "$do_remove" ] && git worktree prune >/dev/null 2>&1
      fi
      continue
    fi
    # 2. A locked worktree is one git will refuse. Find that out BEFORE unlinking anything, or the unlink
    #    happens, the removal fails, and the tree is left in a worse state than it was found in while the
    #    message claims nothing changed.
    if printf '%s\n' "$wtlist" | awk -v w="worktree $wt" 'BEGIN{f=0} $0==w{f=1;next} /^worktree /{f=0} f&&/^locked/{print;exit}' | grep -q .; then
      echo "SKIP  $chip: $wt is locked. Unlock it with 'git worktree unlock' if you meant to remove it"
      kept=$((kept+1)); continue
    fi
    # 3. Keep anything holding work. Uncommitted changes, or commits that are neither in the main
    #    checkout's branch nor on this branch's upstream.
    dirty=""; unpushed=""
    [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ] && dirty=1
    if [ -z "$br" ] || [ "$br" = "HEAD" ]; then
      # Detached HEAD: the commits belong to no branch, so removing the tree makes them unreachable and
      # `git branch -d` cannot object on their behalf - unless some branch already contains the commit,
      # which is the shape `worktree --create` leaves a tree in until its first task starts a branch.
      brdesc="a detached HEAD"
      sha=$(git -C "$wt" rev-parse HEAD 2>/dev/null || echo "")
      if [ -z "$sha" ] || [ -z "$(git -C "$wt" for-each-ref --contains "$sha" refs/heads refs/remotes 2>/dev/null | head -1)" ]; then
        unpushed=1
      fi
    else
      brdesc="$br"
      # The question `git branch -d` asks, answered BEFORE the tree is removed so the whole tree is kept
      # and not merely the branch. Fail safe: anything not provably merged or pushed counts as work.
      merged=""
      mb=""
      if [ -n "$main" ]; then mb=$(git -C "$main" rev-parse --abbrev-ref HEAD 2>/dev/null || echo ""); fi
      # A detached main checkout - mid-rebase, mid-bisect - reports the literal "HEAD", which resolves
      # inside the worktree to the worktree's own tip and would call every branch merged.
      [ "$mb" = "HEAD" ] && mb=""
      if [ -n "$mb" ] && git -C "$wt" merge-base --is-ancestor "$br" "$mb" 2>/dev/null; then merged=1; fi
      if [ -z "$merged" ]; then
        up=$(git -C "$wt" rev-parse --abbrev-ref "$br@{upstream}" 2>/dev/null || echo "")
        if [ -n "$up" ] && git -C "$wt" merge-base --is-ancestor "$br" "$up" 2>/dev/null; then merged=1; fi
      fi
      # Merged into another local branch is held too: tasks are cut from and merged into the run's
      # integration branch, which the owner lands later, so the main checkout's branch is the wrong test
      # for the middle of a run. The commits stay reachable from that branch after this tree goes.
      if [ -z "$merged" ]; then
        tip=$(git -C "$wt" rev-parse "$br" 2>/dev/null || echo "")
        if [ -n "$tip" ] && git -C "$wt" for-each-ref --contains "$tip" --format='%(refname:short)' refs/heads 2>/dev/null | grep -vxF "$br" | grep -q .; then merged=1; fi
      fi
      [ -z "$merged" ] && unpushed=1
    fi
    if [ -n "$dirty" ] || [ -n "$unpushed" ]; then
      why=""
      [ -n "$dirty" ] && why="uncommitted changes"
      [ -n "$unpushed" ] && why="${why:+$why, }commits on $brdesc neither merged nor pushed"
      echo "KEEP  $chip: $wt has $why"
      echo "      it stays. If you have written it off: git worktree remove --force \"$wt\" (after 'fleet.sh unlink' on it)${brshow:+, then git branch -D $brshow}"
      kept=$((kept+1)); continue
    fi
    # 4. Ignored files are invisible to every check above and go with the tree. Say what they are, because
    #    a .env or a local config is exactly the thing a person did not mean to lose.
    ign=$(git -C "$wt" status --porcelain --ignored 2>/dev/null | sed -n 's/^!! //p' | head -5 | tr '\n' ' ')
    if [ -z "$do_remove" ]; then
      links=$(find "$wt" -type l 2>/dev/null | wc -l | tr -d ' ')
      echo "would remove  $chip: $wt${brshow:+  then branch -d $brshow}"
      [ "${links:-0}" != 0 ] && echo "              unlinks $links reparse point(s) first"
      [ -n "$ign" ] && echo "              ignored files that go with it: $ign"
      continue
    fi
    [ -n "$ign" ] && echo "      ignored files removed with the tree: $ign"
    # 5. Unlink every reparse point, at any depth, before anything recursive runs [M32].
    unlink_links "$wt" >/dev/null
    # A link that survived the unlink is the hole [M32] is about, so the tree is not removed over it.
    left=$(find "$wt" -type l 2>/dev/null | wc -l | tr -d ' ')
    if [ "${left:-0}" != 0 ]; then
      echo "SKIP  $chip: $left reparse point(s) under $wt would not unlink, and git would follow them. Nothing"
      echo "      was removed. Unlink them by hand ('fleet.sh unlink \"$wt\"' names them), then re-run"
      kept=$((kept+1)); continue
    fi
    # 6. Remove the worktree. No --force: a tree holding work was kept above, so a refusal here is
    #    something this code did not anticipate and the tree stays as it is.
    if git worktree remove "$wt" 2>/dev/null; then
      git worktree prune >/dev/null 2>&1
      # 7. The branch, by the merge-checking form only. -D is never used here.
      if [ -n "$br" ] && [ "$br" != "HEAD" ]; then
        if git -C "${main:-.}" branch -d "$br" >/dev/null 2>&1; then
          echo "removed  $chip: $wt and branch $br"
        else
          echo "removed  $chip: $wt (branch $br kept: git will not delete it, so it still holds something)"
        fi
      else
        echo "removed  $chip: $wt"
      fi
      # A worker cuts one branch per task, fleet/<chip>/<task-id>, and only the last is checked out here.
      # The safe -d deletes the ones git agrees are merged and leaves the rest.
      for tb in $(git -C "${main:-.}" for-each-ref --format='%(refname:short)' "refs/heads/fleet/$chip/" 2>/dev/null); do
        if git -C "${main:-.}" branch -d "$tb" >/dev/null 2>&1; then echo "         branch $tb deleted (merged)"; fi
      done
      rm -f "$entry"; removed=$((removed+1))
    else
      echo "SKIP  $chip: git refused to remove $wt. Its links were unlinked first, so re-run once the"
      echo "      reason is cleared; nothing else about the tree was changed"
      kept=$((kept+1))
    fi
  done
  if [ -z "$do_remove" ]; then
    echo "dry run: nothing was changed. Add --remove to act."
  else
    echo "clean: $removed removed, $kept kept"
  fi
  ;;


pause)
  # A real pause. "Pause the fleet" used to be a message the coordinator sent, and the workers kept going
  # for a long time - measured 2026-10-05/06 - because nothing but a hook can stop a session mid-task. This
  # writes the two files the hooks read (`<run>/PAUSED`, and a marker under the config directory that names
  # the run) and changes what `next`, `drained`, `sweep`, `clock` and `landed` do. It stops nothing itself:
  # the hooks do that, one tool call at a time, after a grace period (hooks/run-dir.mjs).
  #
  # The acknowledgements live in `stopped/`, never `paused/`: on Windows (Git Bash over NTFS) a directory
  # named `paused` and the file `PAUSED` are the same name, and the first `pause` died with "Is a directory".
  #
  # The reason comes from $3, or from stdin when $3 is `-`. Never from stdin by default: a call made from a
  # tool with an open, silent stdin would wait on it forever.
  reason=${3:-}
  if [ "$reason" = "-" ]; then reason=$(head -c 500 | tr '\n' ' ' | sed 's/ *$//'); fi
  if [ -e "$run/PAUSED" ]; then
    echo "already paused: $(head -1 "$run/PAUSED")"
  else
    # Acks left by an earlier pause would read as workers that have already stopped this time.
    rm -f "$run"/stopped/* "$run/relaunch-waited" 2>/dev/null || true
    mkdir -p "$run/stopped"
    printf '%s%s\n' "$(now)" "${reason:+ - $reason}" > "$run/PAUSED"
  fi
  mkdir -p "$(pausedroot)"
  printf '%s\n' "$absrun" > "$(pausemark)"
  hold=$(claim_holders | tr '\n' ' '); hold=${hold% }
  nh=0; for _c in $hold; do nh=$((nh + 1)); done
  _g=$(calint pause_grace_seconds 30)
  echo "PAUSED $(basename "$absrun"): $(head -1 "$run/PAUSED")"
  echo "  $nh worker(s) hold claims${hold:+: $hold}"
  # The pause is enforced by the hooks of the plugin each worker runs, and only 1.5.9 and later have them.
  for _c in $hold; do
    _wv=$(sed -n 's/.* plugin \([^ ]*\)$/\1/p' "$run/chips/$_c.model" 2>/dev/null | tr -d '\r')
    if [ ! -e "$run/chips/$_c.model" ]; then
      echo "  worker $_c never recorded its plugin (no whoami): if it is older than 1.5.9 its hooks will not hold it; check that it acks"
    elif [ -z "$_wv" ] || { version_readable "$_wv" && version_older "$_wv" 1.5.9; }; then
      echo "  worker $_c runs makarasty ${_wv:-1.5.8 or 1.5.9}: its hooks may not hold it; message it by its title (fleet $(basename "$absrun") $_c) to stop"
    fi
  done
  echo "  Each worker gets ${_g} s from its first call after this to finish the step in hand ($(( _g * 4 )) s from now at the latest, for one that never calls); then the hooks refuse everything but git, fleet.sh and the wake loop."
  echo "  ACK: a worker that has stopped writes $absrun/stopped/<chip>. The watch prints 'worker NN stopped'; status shows"
  echo "  '== PAUSED since <time>: <k> of <n> workers holding claims have stopped', says 'no ack yet' for a worker that holds a claim,"
  echo "  and names it 'still working' after $(calint pause_still_working_seconds 150) s."
  ;;

resume)
  # The pause lifted. Order matters: heartbeats first, then the marker that lets the workers go. A claim's
  # age is the mtime of its heartbeat file, which did not move for the whole pause, so without the touch the
  # first `sweep` after a long pause would call every claim abandoned. Only the mtime changes: `status`
  # still reads the file's content to say NEVER-BEAT.
  #
  # The coordinator seat. A relaunch leaves `coordinator-pending` for the fresh coordinator, and ONLY that
  # session takes the seat, by saying so: its chip prompt ends in `resume <run> --take-over`. A plain `resume`
  # never does - the operator lifting a pause from some other chat (`/makarasty:fleet-pause <run> off`) would
  # otherwise become the coordinator whose context `ctx` measures, and the real one would never be asked again.
  take=""
  case "${3:-}" in
    "") ;;
    --take-over) take=1 ;;
    *) echo "usage: fleet.sh resume <run-dir> [--take-over]" >&2; exit 2 ;;
  esac
  take_seat() {
    if [ ! -e "$run/coordinator-pending" ]; then
      if [ -n "$take" ]; then echo "no coordinator-pending: the coordinator seat is not waiting for anyone"; fi
      return 0
    fi
    if [ -z "$take" ]; then
      echo "coordinator-pending is set: the fresh coordinator takes the seat with: sh \"$0\" resume \"$absrun\" --take-over"
      return 0
    fi
    if [ -z "${CLAUDE_CODE_SESSION_ID:-}" ]; then
      echo "coordinator-pending is still set: no session id here, so no coordinator was recorded"
      return 0
    fi
    printf '%s\n' "$CLAUDE_CODE_SESSION_ID" > "$run/coordinator"; fleet_session
    rm -f "$run/coordinator-pending" "$run/.ctx-warned" "$run/chips/$CLAUDE_CODE_SESSION_ID" 2>/dev/null || true
    echo "this session is now the coordinator of $(basename "$absrun")"
  }
  if [ ! -e "$run/PAUSED" ]; then
    rm -f "$(pausemark)" 2>/dev/null || true
    echo "not paused"
    take_seat
    exit 0
  fi
  for _d in "$run"/tasks/claimed/*/; do
    [ -d "$_d" ] || continue
    case "$(basename "$_d")" in *.dead-*|*.released-*) continue ;; esac
    if [ -e "$_d/heartbeat" ]; then touch "$_d/heartbeat" 2>/dev/null || true; fi
  done
  rm -f "$run/PAUSED" "$(pausemark)" "$run"/stopped/* "$run/relaunch-waited" 2>/dev/null || true
  rmdir "$run/stopped" 2>/dev/null || true
  take_seat
  echo "RESUMED $(basename "$absrun"): workers wake within $(calint clock_poll_seconds 30) s; resumed: carry on with the claim you hold, call next only if you hold none"
  ;;

paused)
  # A worker's acknowledgement: it has committed, stopped its subagents and background tasks, and is
  # waiting. The file is what status and the watch count, and the printed loop is what it waits on - it
  # backgrounds that, ends its turn, and is woken by the pause lifting, by being retired, or by the run
  # landing. Registering the session here too matters: a worker that was never handed a task (so never ran
  # `next`) is otherwise not in the chip map and the hooks would not know it.
  chip=${3:?chip id required}
  # The coordinator is not a worker and is never paused. A coordinator that ran this to see what it does
  # would otherwise register as the chip, and every hook would then hold the session that runs the run.
  if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && [ "$(head -1 "$run/coordinator" 2>/dev/null | tr -d '\r')" = "$CLAUDE_CODE_SESSION_ID" ]; then
    echo "REFUSED: this session is the coordinator of $(basename "$absrun"), not worker $chip. The coordinator is never paused; nothing to acknowledge." >&2
    exit 2
  fi
  register_chip "$chip"
  # A retired chip commits nothing: its work was handed back (and any unsaved part committed) by `handback`.
  if [ -e "$run/$chip.retired" ]; then
    echo "RETIRED: chip $chip was replaced by a fresh worker. You were retired: end this turn with one line, commit nothing, start nothing."
    exit 9
  fi
  if [ ! -e "$run/PAUSED" ]; then echo "NOT PAUSED: nothing to acknowledge. Carry on."; exit 1; fi
  mkdir -p "$run/stopped"
  held=$(claims_of "$chip" | tr '\n' ' '); held=${held% }
  printf 'paused %s\nclaims %s\n' "$(now)" "$held" > "$run/stopped/$chip"
  _wt=$(awk '/^path /{sub(/^path /,""); print; exit}' "$run/worktrees/$chip" 2>/dev/null) || _wt=
  if [ -n "$_wt" ] && [ -n "$(git -C "$_wt" status --porcelain 2>/dev/null | head -1)" ]; then
    echo "WARNING: $_wt has uncommitted work. Commit it now so a fresh worker can continue from it:"
    echo "  git -C \"$_wt\" add -A; git -C \"$_wt\" commit -m \"wip: paused\""
  fi
  echo "STOPPED $chip: holding ${held:-no claim}"
  # Where the worker stopped goes in its notes through this call, not through a shell redirect: after the ack
  # the hook allows git, fleet.sh and the wake loop only, and a fresh worker reads these notes first.
  if [ -n "${4:-}" ]; then
    printf 'stopped (paused %s): %s
' "$(now)" "$4" >> "$run/$chip.notes.md"
    echo "noted in $chip.notes.md: $4"
  else
    echo "No note given: a fresh worker will not know where you stopped. Say it with a fourth argument: sh \"$0\" paused \"$absrun\" $chip \"<where you stopped, what is next>\""
  fi
  echo "Background this wake loop now, end your turn, and start nothing else:"
  wake_loop "$chip"
  echo "It prints resumed (carry on with the claim you hold; call next only if you hold none), retired (end with one line, nothing else) or run-finished."
  ;;

contexts)
  # Every session the run knows and how full each one is, from its transcript. This is what the coordinator
  # reads instead of opening a chat: one line each, OVER where the session has crossed its mark.
  at=$(calint coordinator_handoff_k 700); wat=$(calint worker_relaunch_k 700)
  if [ -e "$run/coordinator" ]; then
    sid=$(head -1 "$run/coordinator" | tr -d '\r')
    k=$(session_ctx "$sid")
    flag=""; if [ -n "$k" ] && [ "$k" -ge "$at" ]; then flag="  OVER (mark ${at}K)"; fi
    printf 'coordinator  %.8s  %sK%s\n' "$sid" "${k:-?}" "$flag"
  else
    echo "coordinator  not recorded yet (the session that offers chips or arms the watch is it)"
  fi
  ws=$(worker_sessions)
  if [ -n "$ws" ]; then
    printf '%s\n' "$ws" | sort | while read -r c sid; do
      k=$(session_ctx "$sid")
      held=$(claims_of "$c" | head -1); held=${held:+holds $held}; held=${held:-no claim}
      state=""
      if [ -e "$run/$c.retired" ]; then state="  retired"
      elif chip_finished "$c"; then state="  finished"
      elif [ -n "$k" ] && [ "$k" -ge "$wat" ]; then state="  OVER (mark ${wat}K)"
      fi
      printf 'worker %s  %.8s  %sK  %s%s\n' "$c" "$sid" "${k:-?}" "$held" "$state"
    done
  fi
  ;;

handback)
  # One worker leaves and its work stays. Every open claim of the chip is released the way the sweep
  # releases one - the claim directory renamed `<id>.released-<ts>`, so a late write from the old session
  # lands in the graveyard rather than on live work - and the task is filed again under a NEW id,
  # `<id>-r<n>`, with the same frontmatter plus three lines: `continue-from: <branch>` (only when the
  # worker's registered worktree is on fleet/<chip>/<id>, the branch the protocol cuts for a task - any other
  # branch is not this task's work), `continued-from-chip: <NN>` (whose notes to read) and `handback-of: <id>`
  # (where the fix proof of the old claim is found: `next` copies it into the new claim).
  #
  # Unsaved work is not lost. A worker that never acked, or was busy past the grace, leaves edits in its
  # tree; this commits them as `wip: handed back` on the branch the tree is on, and when the tree is on a
  # detached HEAD it first makes branch fleet/<chip>/<id>-handback so the commit has somewhere to live.
  #
  # The old task file goes to tasks/handed-back/, not tasks/released/: `landed` refuses a run over a file in
  # `released/` that nobody accounted for, and this one is accounted for by construction. Tasks whose
  # `after:` named the old id are pointed at the new one, or they would wait for ever on a done marker
  # nobody writes.
  chip=${3:?chip id required}
  ids=$(claims_of "$chip")
  if [ -e "$run/$chip.retired" ] && [ -z "$ids" ]; then echo "already retired: $chip"; exit 0; fi
  _wt=$(awk '/^path /{sub(/^path /,""); print; exit}' "$run/worktrees/$chip" 2>/dev/null) || _wt=
  br=""
  if [ -n "$_wt" ] && [ -d "$_wt" ]; then
    br=$(git -C "$_wt" rev-parse --abbrev-ref HEAD 2>/dev/null) || br=""
    firstid=$(printf '%s\n' "$ids" | head -1)
    if [ "$br" = HEAD ]; then
      br=""
      if [ -n "$firstid" ] && git -C "$_wt" checkout -q -b "fleet/$chip/$firstid-handback" 2>/dev/null; then
        br="fleet/$chip/$firstid-handback"
        echo "  $_wt was on a detached HEAD: its work is now on branch $br"
      fi
    fi
    if [ -n "$(git -C "$_wt" status --porcelain 2>/dev/null | head -1)" ]; then
      _gid=""
      git -C "$_wt" config user.email >/dev/null 2>&1 || _gid="-c user.name=fleet -c user.email=fleet@localhost"
      if [ -n "$br" ] && git -C "$_wt" add -A >/dev/null 2>&1 && git -C "$_wt" $_gid commit -q -m "wip: handed back" >/dev/null 2>&1; then
        echo "  COMMITTED the unsaved work of $chip on $br as 'wip: handed back'. Files:"
        git -C "$_wt" diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null | sed 's/^/    /'
      else
        echo "  WARNING: $_wt has uncommitted work and it could NOT be committed${br:+ on $br}. It is not saved: commit it by hand before the fresh worker starts:"
        echo "    git -C \"$_wt\" add -A; git -C \"$_wt\" commit -m \"wip: handed back\""
      fi
    fi
  fi
  n=0
  for id in $ids; do
    base=$(printf '%s' "$id" | sed 's/-r[0-9][0-9]*$//')
    k=1
    while [ -e "$run/tasks/ready/$base-r$k.md" ] || [ -e "$run/tasks/handed-back/$base-r$k.md" ]; do k=$((k + 1)); done
    new="$base-r$k"
    src="$run/tasks/ready/$id.md"
    cf=""
    case "$br" in "fleet/$chip/$id"|"fleet/$chip/$id-handback") cf=$br ;; esac
    if [ -f "$src" ]; then
      sed -e "s/^task-id:.*/task-id: $new/" -e '/^continue-from:/d' -e '/^continued-from-chip:/d' -e '/^handback-of:/d' "$src" \
        | awk -v b="$cf" -v c="$chip" -v o="$id" '{ print } /^task-id:/ && !d { if (b != "") print "continue-from: " b; print "continued-from-chip: " c; print "handback-of: " o; d = 1 }' > "$run/tasks/ready/$new.md"
      for _f in "$run"/tasks/ready/*.md; do
        [ -e "$_f" ] || continue
        [ "$_f" = "$run/tasks/ready/$new.md" ] && continue
        _t=$(sed -n 's/^after:[[:space:]]*\(.*\)/\1/p' "$_f" | head -1 | tr ',\r' '  ')
        case " $_t " in *" $id "*) ;; *) continue ;; esac
        _tmp=$(tmpfile)
        awk -v o="$id" -v n="$new" '/^after:/ { l = $0; gsub(/,/, " ", l); m = split(l, a, " "); out = "after:"; for (i = 2; i <= m; i++) out = out " " (a[i] == o ? n : a[i]); print out; next } { print }' "$_f" > "$_tmp"
        cat "$_tmp" > "$_f"; rm -f "$_tmp"
        echo "  $(basename "$_f" .md): its after: now names $new"
      done
      mkdir -p "$run/tasks/handed-back"
      mv "$src" "$run/tasks/handed-back/$id.md"
      echo "  $id -> $new${cf:+  continue-from $cf}"
      if [ -z "$cf" ]; then echo "  WARNING: $chip has no registered worktree on fleet/$chip/$id${br:+ (it is on $br)}, so $new has no continue-from: the fresh worker starts from base and reads the notes of chip $chip"; fi
    else
      echo "  WARNING: $id has no task file in tasks/ready/ to file again; its claim is released and the planner re-files it"
    fi
    mv "$run/tasks/claimed/$id" "$run/tasks/claimed/$id.released-$(date +%Y%m%dT%H%M%S 2>/dev/null || echo handback)"
    n=$((n + 1))
  done
  rm -f "$run/tight/$chip" 2>/dev/null || true
  printf 'retired %s\n' "$(now)" > "$run/$chip.retired"
  # The hooks hold a retired chip after the pause lifts, and find the run through this marker.
  mkdir -p "$(pausedroot)"
  printf '%s\n' "$absrun" > "$(retiredmark)"
  echo "HANDED BACK $chip: $n task(s) filed again, $chip.retired written (its wake loop ends with: retired)"
  ;;

relaunch)
  # ONE controlled relaunch instead of a chain of handoff chips. Each hop of the chain re-read the world and
  # lost what was only in context, and workers with large context were never moved at all (2026-10-05/06).
  # This does the mechanical part and prints the rest: pause, wait for the stops, hand the named workers'
  # tasks back, then print a fresh worker chip per retired one and - unless --keep-coordinator - one chip for a
  # fresh coordinator. The judgement - to ask the operator first - is the caller's (fleet-plan, 8b).
  #
  #   fleet.sh relaunch <run> [--wait N] [--keep-coordinator] [NN ...]
  #
  # It is TWO calls, the same command twice. The first pauses, waits up to N minutes (default 5) for the
  # workers to stop, hands the named chips back and then stops with an instruction when STATE.md is not newer
  # than the pause and the handbacks: it has to list the ids handed back, and only the coordinator can say what
  # replaced them. The second call, once STATE.md is written, repeats nothing - pausing, waiting and handing
  # back are idempotent and a chip already given a replacement gets the same one - and prints the chips.
  # Run it in the background (run_in_background, or a 600000 ms timeout): the wait can take minutes.
  #
  # With no chips only the coordinator is replaced: nothing is handed back and the workers stay paused until
  # the new coordinator resumes. With --keep-coordinator it is the other way round: the named workers are
  # handed back and retired, only their fresh chips are printed, no coordinator chip and no
  # coordinator-pending are written, and the run is resumed by this call - the same coordinator carries on.
  # Chips are two digits (03); a bare 1 was once read as chip 01 and retired it.
  shift 2
  wait_min=5; list=""; keep=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --wait)
        [ $# -ge 2 ] || { echo "--wait takes minutes: --wait 5" >&2; exit 2; }
        wait_min=$2; shift 2 ;;
      --wait=*) wait_min=${1#--wait=}; shift ;;
      --keep-coordinator) keep=1; shift ;;
      [0-9][0-9]|[0-9][0-9][0-9]) list="$list $1"; shift ;;
      *) echo "not a chip number: $1. Chips are two digits (03); --wait takes minutes (--wait 5); --keep-coordinator keeps this coordinator." >&2; exit 2 ;;
    esac
  done
  case "$wait_min" in ''|*[!0-9]*) echo "--wait takes whole minutes, got '$wait_min'" >&2; exit 2 ;; esac
  if [ -n "$keep" ] && [ -z "$list" ]; then echo "--keep-coordinator replaces workers: name at least one chip (03)" >&2; exit 2; fi
  for c in $list; do
    [ -e "$run/offered/$c" ] || { echo "chip $c was never offered in this run: nothing to replace" >&2; exit 2; }
  done
  runid=$(basename "$absrun")

  # The second call of the same command does not wait again: the acks were collected by the first (it leaves
  # `relaunch-waited`, which the resume removes) and every chip being replaced is already retired. A worker
  # that was silent then is still silent, and another full wait would only repeat that minutes later.
  nowait=""
  if [ -e "$run/PAUSED" ] && [ -e "$run/relaunch-waited" ]; then
    nowait=1
    for c in $list; do [ -e "$run/$c.retired" ] || nowait=""; done
  fi

  # 1. pause
  if [ -e "$run/PAUSED" ]; then echo "already paused: $(head -1 "$run/PAUSED")"
  else sh "$0" pause "$run" "relaunch"; fi

  # 2. wait for every worker holding a claim to stop, naming the ones that never do. With --keep-coordinator
  #    only the workers being replaced matter: the others are resumed within a minute.
  wait_set() {
    if [ -z "$keep" ]; then claim_holders; return 0; fi
    for _c in $list; do
      if [ -n "$(claims_of "$_c" | head -1)" ] || brief_busy "$_c"; then echo "$_c"; fi
    done
  }
  deadline=$(( $(date +%s) + wait_min * 60 )); lastsilent="-"
  if [ -n "$nowait" ]; then
    _k=0; _n=0; _seen=" "
    for c in $(wait_set) $list; do
      case "$_seen" in *" $c "*) continue ;; esac
      _seen="$_seen$c "; _n=$((_n + 1))
      if [ -e "$run/stopped/$c" ]; then _k=$((_k + 1)); fi
    done
    echo "acks: $_k of $_n (not waited again)"
    deadline=0
  fi
  while [ -z "$nowait" ]; do
    silent=""
    for c in $(wait_set); do [ -e "$run/stopped/$c" ] || silent="$silent $c"; done
    if [ -z "$silent" ]; then echo "every worker holding a claim has stopped"; break; fi
    left=$(( deadline - $(date +%s) ))
    if [ "$left" -le 0 ]; then
      echo "NOT STOPPED after ${wait_min} min:$silent. Message each by its title (fleet $runid <NN>) or go on without it:"
      echo "  its hooks refuse its work now, and a chip you replace is handed back whether it stopped or not."
      break
    fi
    if [ "$silent" != "$lastsilent" ]; then echo "waiting for:$silent (up to ${left}s)"; lastsilent=$silent; fi
    sleep 5
  done

  : > "$run/relaunch-waited"

  # 3. hand back the chips being replaced
  for c in $list; do sh "$0" handback "$run" "$c"; done

  # 4. the chips - only from a STATE.md written after the pause and after the handbacks, which is what makes
  #    the first call end here and the second one print.
  ref=$(mtime "$run/PAUSED")
  for c in $list; do
    _m=$(mtime "$run/$c.retired")
    if [ -n "$_m" ] && [ "${ref:-0}" -lt "$_m" ]; then ref=$_m; fi
  done
  sm=$(mtime "$run/STATE.md")
  stale=""
  if [ ! -f "$run/STATE.md" ]; then stale="missing"
  elif [ -n "$ref" ] && [ -n "$sm" ]; then
    if [ "$sm" -lt "$ref" ]; then stale="older than the pause and the handbacks"; fi
  elif [ ! "$run/STATE.md" -nt "$run/PAUSED" ]; then stale="older than the pause"
  fi
  if [ -n "$stale" ]; then
    echo
    echo "STATE.md NOT CURRENT: $absrun/STATE.md is $stale. No chips are printed yet."
    echo "  Now update STATE.md - it must list the handed-back ids above and what replaced them (what is in flight,"
    echo "  branches awaiting review, decisions pending) - then run the same command again. It is idempotent:"
    echo "  nothing already done is repeated, and the second call prints the chips."
    exit 1
  fi

  maxn=0
  for o in "$run"/offered/*; do
    [ -e "$o" ] || continue
    _n=$(basename "$o" | sed 's/^0*//'); case "${_n:-0}" in *[!0-9]*) continue ;; esac
    if [ "${_n:-0}" -gt "$maxn" ]; then maxn=${_n:-0}; fi
  done
  mkdir -p "$run/replaced"
  echo
  for c in $list; do
    if [ -e "$run/replaced/$c" ]; then new=$(head -1 "$run/replaced/$c")
    else maxn=$((maxn + 1)); new=$(printf '%02d' "$maxn"); fi
    lane=$(head -1 "$run/offered/$c")
    if [ "$lane" = brief ]; then
      if [ ! -e "$run/brief-$new.md" ]; then
        cp "$run/brief-$c.md" "$run/brief-$new.md"
        printf '\n## Continuing\nThis brief was begun by worker %s, which a relaunch retired. Read %s.jsonl and %s.notes.md first and continue from where they stop; do not redo what they filed.\n' "$c" "$c" "$c" >> "$run/brief-$new.md"
      fi
      sh "$0" chips "$run" "$new" | sed -n '/^CHIP /,/^$/p'
    else
      sh "$0" chips "$run" "$new" "$lane" | sed -n '/^CHIP /,/^$/p'
    fi
    printf '%s\n' "$new" > "$run/replaced/$c"
  done

  # How many workers the watch counts as finished at the end: every chip ever offered, retired included,
  # because `landed` and the watch count `.retired` as finished.
  total=0; for o in "$run"/offered/*; do if [ -e "$o" ]; then total=$((total + 1)); fi; done
  fsh=$(absdir "$(dirname "$0")")/fleet.sh
  gap=$(lane_gaps | grep -v 'is not a lane' || true)
  if [ -n "$keep" ]; then
    if [ -n "$gap" ]; then printf 'STILL WITHOUT A WORKER:\n%s\n' "$gap"; fi
    sh "$0" resume "$run"
    echo "RELAUNCH READY for $runid (same coordinator): the run is resumed, the workers not replaced carry on."
    echo "Do these now, in this order, in this one turn:"
    echo "  1. Re-arm the watch for the new worker count: TaskStop the fleet-wait monitor, then arm /makarasty:fleet-wait $runid $total."
    echo "  2. Offer every CHIP above, each as its own mcp__ccd_session__spawn_task with exactly that title, tldr and prompt."
    echo "  3. Tell the operator in one line: click the worker chips; nothing else to do, the run is already running."
    exit 0
  fi
  : > "$run/coordinator-pending"
  printf 'CHIP coordinator\ntitle: fleet %s coordinator\ntldr: Fresh coordinator of fleet run %s, taking over after a relaunch. Click this one first; it reads STATE.md and resumes the run.\nprompt: You are the coordinator of fleet run %s, taking over. Read %s/STATE.md in full, then sections 3b and 8b of the makarasty fleet-plan command (invoke /makarasty:fleet-plan only to read it if needed; do not re-run its interview or offer chips except those STATE.md lists as pending), then run `sh %s resume %s --take-over` and arm /makarasty:fleet-wait %s %s.\n\n' \
    "$runid" "$runid" "$runid" "$absrun" "$fsh" "$absrun" "$runid" "$total"
  if [ -n "$gap" ]; then printf 'STILL WITHOUT A WORKER:\n%s\n' "$gap"; fi
  echo "RELAUNCH READY for $runid: the run stays paused until the new coordinator resumes it."
  echo "Do these now, in this order, in this one turn:"
  echo "  1. $absrun/STATE.md is current (checked: it is newer than the pause and the handbacks). Do not read diffs or dump files to add to it."
  echo "  2. Stop your own watch: TaskStop on the fleet-wait monitor, so it does not report events the new coordinator must hear."
  echo "  3. Offer every CHIP above, the coordinator chip first, each as its own mcp__ccd_session__spawn_task with exactly that title, tldr and prompt."
  echo "  4. Tell the operator in one line: click the coordinator chip first, then the worker chips; the run stays paused until the new coordinator resumes it."
  ;;

merge|render|fixqueue)
  m=$(beside fleet-merge.mjs makarasty scripts/fleet-merge.mjs)
  [ -n "$m" ] || { echo "fleet-merge.mjs not found beside fleet.sh" >&2; exit 2; }
  exec node "$m" "$cmd" "$run"
  ;;

*)
  echo "unknown command: $cmd" >&2; exit 2 ;;
esac
