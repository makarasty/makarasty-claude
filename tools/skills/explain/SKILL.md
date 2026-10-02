---
description: Explains plainly, in the person's language, where this chat's work stands - what happened, why, what was done, what is left, whether it can ship, and what was not checked. Use on "объясни простым языком", "простым языком на русском", "в чём суть", "объясни что случилось", "можно деплоить? объясни", explain plainly, explain in simple words. Not for token usage, and not while a /makarasty-tools:hold list is being collected.
argument-hint: [topic, or nothing for this chat's work]
---

Explain `$ARGUMENTS`, or the work in this chat when empty. The person asked because the last answer was
too long, too technical, or they were not watching. This one answer is full plain sentences, whatever
terse or compressed mode is on; the next reply goes back to that mode.

Several chats work in one checkout, so `git status` shows other chats' files too. Explain only what this
chat did and touched; another chat's uncommitted file is not "left" here. Nothing happened in this chat and
no topic was given: ask in one line what to explain.

## Check before you say it

Every claim is something the person may repeat to someone else. Before writing a claim that is cheap to
check now - committed or not, a test passing, what a function does, what is deployed - check it: `git
status`, `git log`, one narrow test, the file. Three such checks at most, and no whole test suite or
typecheck: they cost gigabytes on a machine other chats share. A claim you did not check is said as
unchecked.

## The answer

Short paragraphs or a few plain lines, in this order, skipping any that do not apply:

1. **What happened.** One or two sentences a person outside the code understands. A word they would have
   to look up gets replaced, not explained.
2. **Why.** The cause, plainly.
3. **What was done.** And how it was checked: the test or the run that showed it.
4. **What is left, and what the person must do.** A deploy, a migration, a click in an admin page. A
   command they will run goes in its own fenced `powershell` block: one command per line, no `&&`, which
   Windows PowerShell 5.1 rejects.
5. **Can it ship.** Yes, no, or yes once something happens - only when shipping is the question.
6. **Not checked.** What you did not verify, plainly. Nothing: leave it out.

No headings, no tables, no emoji, no `file:line` unless asked. Keep the specifics - numbers, names, IDs -
since plain is not vague. Around five to twelve lines; longer only when the person asked for detail.

## Done when

Each of the six points that applies is answered for this chat's own work, every claim was checked or is
marked unchecked, and the person could repeat the answer without opening the code.
