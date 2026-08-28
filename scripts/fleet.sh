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
#   fleet.sh next    <run-dir> <chip>              claim the first free task, print it. exit 3 = drained
#   fleet.sh beat    <run-dir> <chip> <task-id>    refresh heartbeat. exit 4 = claim lost, take another
#   fleet.sh finish  <run-dir> <chip> <task-id>    mark the task done
#   fleet.sh find    <run-dir> <chip>              read one JSON finding on stdin, validate, append
#   fleet.sh ask     <run-dir> <chip>              read a question on stdin, file it, print the path
#   fleet.sh drained <run-dir> <chip>              queue empty: write <chip>.done
#   fleet.sh status  <run-dir>                     planner view: claims, ages, markers, questions
#   fleet.sh landed  <run-dir> <expected-chips>    is the run genuinely finished? exit 0 yes, 1 no
#   fleet.sh merge   <run-dir>                     findings -> backlog.jsonl, reconciled or refused
#   fleet.sh render  <run-dir>                     backlog.jsonl -> backlog.md and skipped.md
#   fleet.sh fixqueue <run-dir>                    backlog.jsonl -> a queue a second fleet can claim
#
# POSIX sh. Works in Git Bash on Windows. Node is used only to validate a finding, and its absence
# downgrades that to a warning rather than a failure.

set -eu

cmd=${1:-}; run=${2:-}
[ -n "$cmd" ] && [ -n "$run" ] || { echo "usage: fleet.sh <command> <run-dir> [args]" >&2; exit 2; }
[ -d "$run" ] || { echo "no such run directory: $run" >&2; exit 2; }
now() { date -Iseconds 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ; }

case "$cmd" in

next)
  chip=${3:?chip id required}
  mkdir -p "$run/tasks/claimed" "$run/tasks/done"
  for f in "$run"/tasks/ready/*.md; do
    [ -e "$f" ] || continue
    id=$(basename "$f" .md)
    [ -e "$run/tasks/done/$id" ] && continue
    if mkdir "$run/tasks/claimed/$id" 2>/dev/null; then
      t=$(now)
      printf 'chip %s\nclaimed %s\n' "$chip" "$t" > "$run/tasks/claimed/$id/owner"
      printf '%s\n' "$t" > "$run/tasks/claimed/$id/heartbeat"
      b=$(sed -n 's/^budget:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$f" | head -1)
      [ -n "$b" ] || b=25
      echo "CLAIMED $id"
      echo "BUDGET_MIN $b"
      echo "ABORT_AFTER_SEC $((b * 120))"
      echo "---"
      cat "$f"
      exit 0
    fi
  done
  echo "QUEUE DRAINED"
  exit 3
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
  chip=${3:?chip id required}; id=${4:?task id required}
  d=$run/tasks/claimed/$id
  if [ -d "$d" ] && ! grep -q "chip $chip\$" "$d/owner" 2>/dev/null; then
    echo "CLAIM LOST $id, done marker NOT written"; exit 4
  fi
  [ -d "$d" ] && now > "$d/heartbeat"
  mkdir -p "$run/tasks/done"; : > "$run/tasks/done/$id"
  echo "DONE $id"
  ;;

find)
  chip=${3:?chip id required}
  tmp=$(mktemp); cat > "$tmp"
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs=require("fs");
      let o; try { o = JSON.parse(fs.readFileSync(process.argv[1],"utf8")); }
      catch (e) { console.error("REFUSED: not one JSON object: "+e.message); process.exit(1); }
      const sev=["blocker","major","minor","polish"];
      const problems=[];
      if (o.unreached) { if (!o.reason) problems.push("unreached line needs reason"); }
      else if (o.created || o.state_changed) { /* auxiliary shapes carry their own fields */ }
      else {
        for (const k of ["area","severity","observed","evidence","mechanism_status"])
          if (!o[k] || String(o[k]).trim()==="") problems.push("missing "+k);
        if (o.severity && !sev.includes(o.severity)) problems.push("severity not one of "+sev.join("|"));
        if (o.mechanism_status && !["established","hypothesis","unknown"].includes(o.mechanism_status))
          problems.push("mechanism_status not established|hypothesis|unknown");
        if (o.evidence && String(o.evidence).length < 12) problems.push("evidence too thin to reproduce from");
        if (o.what) problems.push("`what` is the retired field name, use `observed`");
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
    ' "$tmp" "$chip" >> "$run/$chip.jsonl" || { rm -f "$tmp"; exit 1; }
  else
    echo "warning: node absent, finding appended unvalidated" >&2
    tr -d '\n' < "$tmp" >> "$run/$chip.jsonl"; echo >> "$run/$chip.jsonl"
  fi
  rm -f "$tmp"
  echo "FILED $(wc -l < "$run/$chip.jsonl" | tr -d ' ') lines in $chip.jsonl"
  ;;

ask)
  chip=${3:?chip id required}
  mkdir -p "$run/ask"
  n=1; while [ -e "$run/ask/$chip-$n.md" ]; do n=$((n + 1)); done
  cat > "$run/ask/$chip-$n.md"
  echo "ASKED $run/ask/$chip-$n.md, read $run/answers/$chip-$n.md at your next boundary"
  ;;

drained)
  chip=${3:?chip id required}
  : > "$run/$chip.done"
  echo "QUEUE DRAINED, $chip.done written"
  ;;

status)
  echo "== claims"
  for d in "$run"/tasks/claimed/*/; do
    [ -d "$d" ] || continue
    id=$(basename "$d")
    [ -e "$run/tasks/done/$id" ] && continue
    o=$(head -1 "$d/owner" 2>/dev/null || echo "NO OWNER")
    hb=$(cat "$d/heartbeat" 2>/dev/null || echo "none")
    cl=$(sed -n 's/^claimed //p' "$d/owner" 2>/dev/null || echo "?")
    flag=""; [ "$hb" = "$cl" ] && flag=" NEVER-BEAT"
    echo "  $id  $o  claimed $cl  beat $hb$flag"
  done
  echo "== markers"
  ls "$run"/*.done "$run"/*.blocked "$run"/*.waiting 2>/dev/null | sed 's|.*/|  |' || echo "  none"
  echo "== questions without answers"
  for q in "$run"/ask/*.md; do
    [ -e "$q" ] || continue
    b=$(basename "$q")
    [ -e "$run/answers/$b" ] || echo "  $b"
  done
  ;;

landed)
  want=${3:?expected chip count required}
  fail=0
  have=$(ls "$run"/*.done "$run"/*.blocked 2>/dev/null | wc -l | tr -d ' ')
  [ "$have" -ge "$want" ] || { echo "NOT LANDED: $have of $want workers finished"; fail=1; }
  for d in "$run"/tasks/claimed/*/; do
    [ -d "$d" ] || continue; id=$(basename "$d")
    [ -e "$run/tasks/done/$id" ] || { echo "NOT LANDED: claim without a done marker: $id"; fail=1; }
  done
  for f in "$run"/tasks/ready/*.md; do
    [ -e "$f" ] || continue; id=$(basename "$f" .md)
    [ -d "$run/tasks/claimed/$id" ] || { echo "NOT LANDED: task nobody ever claimed: $id"; fail=1; }
  done
  [ -s "$run/backlog.jsonl" ] || { echo "NOT LANDED: backlog.jsonl is missing or empty"; fail=1; }
  ls "$run"/*.waiting >/dev/null 2>&1 && { echo "NOT LANDED: a worker is waiting on the operator"; fail=1; }
  [ "$fail" = 0 ] && echo "LANDED: $have workers, every claim closed, backlog written"
  exit "$fail"
  ;;

merge|render|fixqueue)
  m=$(ls -t "$(dirname "$0")/fleet-merge.mjs" ~/.claude/plugins/cache/*/makarasty/*/scripts/fleet-merge.mjs 2>/dev/null | head -1)
  [ -n "$m" ] || { echo "fleet-merge.mjs not found beside fleet.sh" >&2; exit 2; }
  exec node "$m" "$cmd" "$run"
  ;;

*)
  echo "unknown command: $cmd" >&2; exit 2 ;;
esac
