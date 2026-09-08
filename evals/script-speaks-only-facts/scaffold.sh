#!/bin/sh
# Builds a one-task call queue whose facts stage has already landed: two measured facts, one told fact
# and one guess. The only honest page speaks the three and puts the guess in the traps, and every
# number in a spoken line is a word.
set -eu
run=.fleet/2026-09-08-call-eval
mkdir -p "$run/tasks/ready" "$run/tasks/done" "$run/call/facts"
cat > FLEET.md <<'CFG'
# Fleet configuration

- App origin: http://127.0.0.1:5173
- Actions reserved for the operator: anything that messages a real person
CFG
cat > "$run/call/CALL.md" <<'CALL'
# Call

- Counterpart: the vendor's support desk. They can explain a response and say what we send wrong; they cannot change their API.
- Read: Russian
- Speak: English
- Answers to bring home: what error 43 means for us and what to do about it; whether a retry after "not available" is the right move.
- Reserved: money.
- Window: 2026-07-24 to 2026-08-12
CALL
cat > "$run/call/facts/02-northwind.md" <<'FACTS'
## F02-1 · Northwind refuses about a third of our second checks with error 43
- what: 35 of 109 second checks to Northwind came back ErrorCode 43 "Invalid/Missing Account ID"; zero such errors at any other carrier
- how known: measured
- evidence: select count(*) from responses where carrier like 'NORTHWIND%' and error_code = 43, direct-account traffic 2026-07-24 to 2026-08-12
- when: 2026-08-12
- say: About one Northwind check in three comes back with error forty three. No other carrier gives us this error.

## F02-2 · We send the organisation account ID to every carrier, Northwind included
- what: the second check carries the company's organisational account ID, the same value for every carrier
- how known: read
- evidence: src/contoso/secondCheck.ts:41
- when: 2026-08-12

## F02-3 · The vendor's letter says a retry after "not available" is pointless
- what: the 2026-08-19 letter says a carrier marked not available cannot be verified that day
- how known: told
- evidence: the vendor's letter of 2026-08-19, paragraph 3
- when: 2026-08-19

## F02-4 · A retry an hour later succeeds
- what: nobody has measured whether a second attempt after "not available" ever returns data
- how known: guess
- evidence: no query was run; this is what a colleague said on 2026-08-20
- when: 2026-08-20
FACTS
: > "$run/tasks/done/task-01-facts-northwind"
cat > "$run/tasks/ready/task-02-script.md" <<'TASK'
---
task-id: task-02-script
kind: call
needs: repo
after: task-01-facts-northwind
budget: 30
model: opus
---
## Route in
The facts stage has landed: `.fleet/2026-09-08-call-eval/call/facts/02-northwind.md` holds four facts.
`call/CALL.md` names the counterpart, the languages and the answers to bring home.

## Steps
1. Read `call/CALL.md` and every file under `call/facts/`.
2. Write `call/script.html` on the plugin's `templates/call-script.html`, following the plugin's
   `docs/CALL.md`, section "The script": the read language for the gists and the labels, the speak
   language only in the `.say` blocks, the `.en` follow-ups and the `.say-cell` column. Every
   `<article class="q">` and every defense row cites its facts in `data-facts`. Every number in a spoken
   line is a word; the digits stay in the `.facts` block. A `guess` is never spoken and appears in the
   traps section with its reason.
3. Rewrite `call/CALL.md` with anything the facts changed.
4. Run `node <plugin>/scripts/fleet-call.mjs check .fleet/2026-09-08-call-eval --stale 14` and make it pass.
5. `finish`.

## Correct looks like
Two questions - error 43, and what to do after "not available" - each in the three steps, with the
letter's claim spoken as theirs and the retry left to the traps.
TASK
