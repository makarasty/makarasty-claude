---
description: "Asks you rounds of questions about a plan, design or idea until nothing is assumed, before any code. grill me, stress-test my plan / грилинг, задай вопросы, проведи интервью. Not attacking finished work (redteam) or a diff (review)."
argument-hint: [the plan or idea, "короткий" for one or two rounds]
---

Interview the person about `$ARGUMENTS` (or the plan in this chat) until you both hold the same picture
of what will be built. You collect decisions; you do not build anything until the person confirms the
picture, because a guess made now becomes code that has to be undone. No argument and no plan in the
chat: ask in one line what to grill.

## Before the first round

Read what is already known: the chat, the code and docs the plan touches. A fact you can look up (what
the code does now, which file, what a library supports) is yours to find, by yourself or a subagent;
put to the person only what is theirs to decide: what they want, their taste, a real fork between
outcomes. Asking them a fact wastes their answer.

## Rounds

Keep the decisions as a tree: each one opens the decisions that hang off it. A round asks the frontier,
every decision whose prerequisites are already settled. A question that depends on another one still
open waits for a later round.

- One `AskUserQuestion` per round, up to four questions, upstream ones first when the frontier is
  bigger. Follow the asking rule makarasty-tools gives every session (plain words, the recommended
  option first, why each option wins, a question that stands alone). No `AskUserQuestion` in this
  session: the same round as numbered questions in one message.
- A fact a subagent is still finding blocks only the questions below it; ask the rest now. A fact
  counts as settled once you or the subagent checked it in the code, docs or a run, not on a guess.
- A question the person skips or waves off ("реши сам"): take your recommended option, mark it settled
  by you, and name it in the final plan.
- After each round, recompute the frontier from the answers. An answer in the person's own words that
  changes the plan goes into the tree as said, not rounded to the nearest option.
- "Короткий" or "short": one or two rounds on the decisions that change the most; say what you left
  open.

## Done when

The frontier is empty: every branch was asked or settled by a fact you checked, and nothing is silently
assumed. Then write the settled plan back in a few plain lines (each decision and who settled it: the
person or a fact) and ask once whether that is the shared picture. Work starts only on their yes.

## After the yes: hand it on

When the plan is code, the settled picture also answers, from a read of the code and not from memory:
what the code must guarantee; which existing helpers, components and patterns it reuses (file:line);
and, for each guarantee, the test that proves it, written before the code. A new module, data shape or
public interface gets this as a short design pass before any edit, written by the same agent that then
builds it: on one feature, "design it, then build it" in one Sonnet run gave tidier code than building
directly (judge 5:0, mostly less duplication) for +38% cost, while a separate Opus design agent cost
3.6x and won nothing more [M92].

Then name the next step by size, and start it unless the person said to wait: one piece, built here;
several independent parts, subagents per the parallel line; a long multi-task run, `fleet-plan` with
the plan file as its mission. When the plan goes to another step (a subagent, fleet-plan, another chat),
write it to the project's plan doc first (where its plans already live, else `docs/<area>/PLAN.md`) in
this shape: Problem; Decisions and who settled each; Guarantees, each with its test; Reuse (file:line);
Out of scope. Every brief cites that file by its absolute path; a plan that stays in this chat needs no
file.
