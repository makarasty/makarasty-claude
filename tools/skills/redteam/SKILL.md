---
description: Red team - cheap agents attack a plan, idea, design, tool, data export or finished change from different angles; a strong judge keeps only findings with evidence. Use on "красная команда", "подними красную команду", "запусти red team", "пусть поищут, где развалится", "что тут может развалиться", "перепроверь с красной командой", "поспорь с ней", "red team this". For line-by-line bugs in a diff use /makarasty-tools:review.
argument-hint: [what to attack: nothing for the latest work | a file, folder or plan] [--fix]
---

A red team is worth its cost only when it finds what the author could not see, and only if its findings
are true. Cheap attackers find many things; most are wrong, vague or about taste. The judge is what makes
the result usable.

## 1. Name the target

`$ARGUMENTS`, or what this chat produced last: the plan, the files this chat changed, the export, the
skill. Say in one line what is attacked and what "it breaks" means for it (a wrong number in the export, a
step the plan cannot do, a prompt the skill misfires on). "Исправь", "по кругу", "fix" in the request mean
`--fix`.

## 2. Attack

Three to five subagents in parallel, `subagent_type: Explore` (read-only by its tools), `model: "sonnet"`,
each with its own angle chosen for this target. Angles that tend to pay:

- **a plan or idea**: the assumption it rests on that is false here; a case it does not cover; an
  existing tool or library that already does it; what happens on this machine (Windows, shared RAM, other
  chats running); how the person will actually use it.
- **a number or export**: recount it independently from the raw source; filters, time zones, duplicates
  and joins; what each column will be read as.
- **a tool, skill or hook**: prompts that should trigger it and do not, prompts that should not and do;
  the tokens it adds per turn; the paths it can delete or overwrite; two chats running it at once.
- **a change**: the inputs and states it was not run with; what calls it that nobody checked.

Each brief carries the target, the angle, `~/.claude/MACHINE.md` when it exists and the target touches
tooling or the OS, and this contract:

- Every finding names its evidence - the input, command, file and line, or number that shows it - or it
  is dropped. A code defect needs the input that breaks it.
- Effort, time and migration cost are not findings: agents do the work. Judge by whether it works, what
  it breaks, what it costs at run time, and safety. No style or naming preferences.
- No whole-repo typecheck and no whole test suite. At most one scoped run, after checking that no other
  test or typecheck is live on the machine, with a hard timeout of about twice its normal time; a timeout
  is reported, never retried.

## 3. Judge

On Opus or better: here if this chat runs on one, otherwise one `Agent` with `model: "opus"` given the
findings and the sources. Re-check every finding against the source. Each one is **confirmed** (you
reproduced it, or for a non-code finding read it in the source), **refuted** (one line why, the evidence
that disproves it), or **unclear** (what would settle it). Merge duplicates. Do not soften a confirmed
finding or keep a refuted one to look thorough.

## 4. Fix, or report

With `--fix`: fix the confirmed findings in the files this chat changed, with the smallest change; a
defect shared by several callers is fixed once in the shared place. A confirmed finding in someone else's
file is reported as not edited. Then continue the attacker that found it (`SendMessage` to its agent id)
with only the fix, to check it is closed. At most three rounds; the last round also gets one fresh
attacker on the diff of all the fixes. A finding still open after that is listed as open. One that needs
the person's decision is asked in one AskUserQuestion at the end, not mid-round.

## Report

Confirmed, one line each with its evidence and whether it was fixed; refuted, a count and the reason for
any the person might believe; unclear and open, what would settle each; and what no attacker looked at.

## Done when

Every finding is confirmed, refuted or unclear with its evidence; with `--fix` every confirmed one is
fixed and re-checked, or listed as open or not this chat's file; and the report names what was not
attacked.
