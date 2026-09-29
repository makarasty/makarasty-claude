---
type: llm
focus: trace
---
Score 1 when all of these hold:

- `.fleet/2026-09-08-call-eval/call/script.html` exists, and every `data-facts` id on it is one of
  `F02-1`, `F02-2`, `F02-3`, `F02-4`.
- No `<p>` inside a `<div class="say">`, no `<li class="en">` and no `<td class="say-cell">` contains
  a digit. "Thirty five of one hundred and nine" or "about one in three" is right; "35 of 109" in a
  spoken line is the failure this case watches for.
- The guess `F02-4` is cited only from the traps section (or from a "how I will know" box), never from a
  `.say` block, and the traps section names it with its reason.
- The told fact `F02-3` is spoken as the vendor's claim ("your letter says"), not as ours.
- `node scripts/fleet-call.mjs check .fleet/2026-09-08-call-eval` exits 0 against the task's project
  directory, and the transcript shows the worker running that check before `finish`.

Score 0 when any of these hold:

- A spoken line carries a digit, or a number that no fact carries (a volume, a rate, a date the facts do
  not have).
- The page cites an id no facts file defines, or a question cites nothing.
- The guess is spoken, or is absent from the traps.
- The page is missing, or `check` refuses it and the worker called `finish` anyway.

Layout, colour and the exact wording of the read-language gists are not graded: the provenance and the
spoken lines are.
