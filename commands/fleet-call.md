---
description: Plan a call run - dig every fact about a topic out of the project, then write the bilingual script a non-native speaker reads aloud on the call. With `live <run-id>`, sit in on the call in a fresh chat and answer from those facts in both languages, one turn per question.
argument-hint: <who you are talking to and what about> [fast] | live <run-id>
disable-model-invocation: true
---

The `docs/*` and `scripts/*` files named below live in this plugin's own directory,
`${CLAUDE_PLUGIN_ROOT}`, not in the project you are working on.

## Missing prerequisites are work, not a refusal

No `FLEET.md`, no `.fleet/`: say what is missing in one line, run `/makarasty:fleet-init` to produce it,
and continue. A call run needs no pane and no login, so a project with no running application is not
missing anything. Stop for exactly two things: a credential only the operator can provide, and a
reserved control.

## Two shapes, by the argument

`$ARGUMENTS` starting with `live` names a run that already holds `call/`: skip to section 6. Anything
else is a topic, and sections 1 to 5 plan the run that prepares it.

## What this is

`fleet-plan` with the kind, the axis and the stages fixed. The mission is `kind: call`: one facts task
per source, then one script task on the top model, then the page in the operator's hands. Read
`docs/CALL.md` for the fact shape, the page, the register and the gate; read `docs/PULL.md` for the
queue. Whatever this file leaves out - the interview discipline, the chip prompts, the watch - comes from
`fleet-plan`, sections 2b, 7 and 8; follow it.

You write the queue and deliver the page. You do not write a fact and you do not write a line of the
script.

## 1. Ground yourself

Read `FLEET.md`: the query tool, the accelerators, the reserved actions. Then the project's own
documentation for the area the call is about, and whatever the mission names as already existing: the
previous call's notes, the letters, the vendor's documents in the repository. Find them with `rg`; do not ask
where they are.

Work out the two languages from the mission text itself: the **read** language is the one the operator
wrote in, and the **speak** language is the one they named, English when they named none.

## 2. Draft the plan, then one round

Hold a complete draft from the first exchange: run id `<date>-call[-<slug>]`, the counterpart, the two
languages, the enumerated source list with what each one is expected to yield, the answers to bring
home, the reserved topics, and where the page goes. Then ask one round, numbered, each with your
recommended answer, so "all yours" loses nothing:

```
Q1 - Counterpart: the carrier API's support desk. They can explain a response and say what we send wrong; they
     cannot add a field or promise a change. That decides the question shape: we do this, we get this,
     how should it work. An engineer or an interviewer changes the shape, so correct this first.
     -> Recommend support desk, from the mission text.
Q2 - Languages: read Russian, speak English.
     -> Recommend as read from the mission.
Q3 - Sources: five, listed above, each with a path or a query. Correct the list; there is no question to
     answer.
     -> Recommend all five; the previous call's notes are the cheapest one and the one most often skipped.
Q4 - Answers to bring home: the four listed. Without them the call did not happen.
     -> Recommend the four; add or strike.
Q5 - Reserved: money, customer data, and the two things you said not to raise.
     -> Recommend those, plus whatever FLEET.md reserves.
Q6 - Where the page goes: on disk under the run, opened in this chat when it lands; published as a
     private artifact only if you say so, because it leaves the machine and you may want to read it from
     a phone during the call.
     -> Recommend disk.
```

`fast` in the arguments means take the draft as answered. A round that changes nothing ends the
interview, as in `fleet-plan`.

## 3. Write the queue

Pull mode, under `.fleet/<run-id>/tasks/ready/`, each task filed with `fleet.sh file` (`fleet-plan` 3b), `kind: call`, `isolation: none`, `needs: repo`
throughout. Write `call/CALL.md` yourself before the first chip: the counterpart and what they can do,
the two languages, the answers to bring home, the reserved topics, the window the facts should cover.
The script task rewrites it with what the facts changed.

- **facts**, one per source, `budget: 25`, `model: opus`. The source by path or by query tool, the
  questions the call will put to it, the file to write - `call/facts/<source>.md` - the fact shape from
  `docs/CALL.md` with the id prefix `F<NN>-` for this task's number, and the instruction that a claim
  the mission or the notes make which the facts refute is filed through `fleet.sh find` with the fact's
  evidence. Say that a fact nobody could verify is written as a guess, never left out.
- **script**, one, `after:` every facts task, `budget: 45`, the design model `docs/MODELS.md` names.
  The facts directory, `call/CALL.md`, the template at `templates/call-script.html` in this plugin, the
  section list and the register from `docs/CALL.md`, the two output paths, and
  `node <plugin>/scripts/fleet-call.mjs check .fleet/<run-id> --stale <days>` before `finish`. Say in
  the task that every question carries `data-facts`, that every number in a spoken line is a word, and
  that the traps section is written from the guesses and from the findings the facts tasks filed.

Order the files longest budget first. Touch `tasks/queue-open` before offering a chip and delete it once
every task is filed - here that is immediately, because the queue is known in full from the source list.
Use the `after:` gate, not the order, for the script task: `fleet.sh next` holds it and tells its worker
`QUEUE WAITING` until the last facts file lands.

## 4. Offer the chips

Repo chips only, from `sh "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh" width .fleet/<run-id>`; no pane is opened for a call run. Chip titles and
prompts verbatim from `sh "${CLAUDE_PLUGIN_ROOT}/scripts/fleet.sh" chips .fleet/<run-id> 01-<NN> repo`.

Pass the chips `--model <the opus id, as get_session prints it>`: the facts tasks want `opus`, and the script task, which wants the
design model, is delegated by its worker to one `Agent` at that tier (`fleet-run`). `docs/MODELS.md`,
"Switching a worker", covers a chip that starts on another model.

## 5. Arm the watch, and deliver when it lands

Invoke `/makarasty:fleet-wait <run-id> <count>` yourself. When the run lands, `/makarasty:fleet-collect`
as usual: a call run's findings are the claims the facts refuted, and the backlog is where the operator
sees what the last letter or the last call got wrong.

Then run the gate yourself, `node <plugin>/scripts/fleet-call.mjs check .fleet/<run-id> --stale <days>`,
and put the page in front of the operator: `SendUserFile` with `display: render` on
`.fleet/<run-id>/call/script.html`. Publish it with the `Artifact` tool only when Q6 said so; the page
carries the project's numbers and identifiers, and that decision stays the operator's.

Report, in this order: the page's path or link, the questions by block with the facts each cites, the
traps, the measured facts the gate listed as stale, and one sentence about what comes next: open a fresh
chat when the call starts and run `/makarasty:fleet-call live <run-id>` there.

## 6. Live

The run's `call/` directory is the whole context. Do exactly what `docs/CALL.md`, section "Live",
says, and nothing it does not say:

1. Read `call/CALL.md`, every `call/facts/*.md`, and `call/log.md` if it exists. Read nothing else.
2. `/makarasty-tools:unslop on` when that plugin is installed. Its rules hold either way.
3. Say you are ready, in both languages, and name the answers to bring home. Then wait.
4. Every message from the operator gets the two-block reply from `docs/CALL.md`: the read language on
   top with the source tag, the speak language below, one sentence per line, numbers as words. Nothing
   else in the message.
5. A question the facts do not answer gets the dig notice in both blocks first, then the dig in the same
   turn, then the answer with its tag; what was found goes to `call/facts/live.md`.
6. "Они ответили" logs to `call/log.md`. "Закончили" writes `call/letter.md` and reports which answers
   landed.

No subagent, no reading the script, no reading the project's source before a question needs it. The
speaker is on a call, and the reply is one turn.

## Done when

Planning: every source in the corrected list has a facts task, the script task is gated on all of them,
`call/CALL.md` is on disk, the chips are offered, the watch is armed, and - once the run lands - the gate
passed and the page is in front of the operator with the sentence about the live chat.

Live: every reply was two blocks with a source tag, every answer the operator reported is in the log,
and the letter exists when the call ended.
