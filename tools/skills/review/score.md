# `--score`

Read from `SKILL.md` section 9, only when `--score` is on.

Grades the work against what the person asked, not only for bugs, and fixes until every criterion holds.
The judge never sees this chat: the chat that did the work agrees with its own work and fills gaps from
context the reader will not have.

1. **Criteria first, then frozen.** One fresh subagent (`model: "opus"`, `effort: "medium"`) gets only the
   request in the person's words, quoted, and the target's file list, and writes 5-8 numbered criteria
   (C1...) to a file in the scratchpad. Each is pass/fail and checkable: a command with its expected
   result, a fact at a file:line, or a screenshot this session takes and saves beside the file. Together
   they cover: what was asked is done, the edge cases the request implies, the narrow tests pass, nothing
   outside the target changed, and "no blocking line" (sections 3-4, 10.2). When the target holds heuristic
   code, one criterion is its frozen labelled set and pass line (10.1, step 3), written now. Note
   `git hash-object <file>`; it is checked again before every judge, and a changed hash stops the run, since
   a rubric rewritten after the work grades what it sees.
2. **Evidence gathered here.** Each round this session runs every criterion's command (the narrow-check and
   timeout rules of section 8, step 2), takes its screenshots, and has the finders of 10.3 run sections 3-4
   on the whole target without the ledger; their lines, sorted by the judge, are the evidence for "no
   blocking line". A command the person declines is a FAIL marked `not run`.
3. **A new judge each round.** A fresh subagent (`model: "opus"`, `effort: "medium"`, never one used in an
   earlier round) gets the criteria file, the diff or target, the outputs, screenshot paths, finding lines
   and the ledger, and does the judge's work of 10.3 step 3; not this chat's claims, not an earlier score. Per criterion: PASS or FAIL
   with its evidence (an output line, a file:line), or INVALID when the criterion itself cannot be checked
   (a wrong command, a file this chat does not own). A PASS without evidence is a FAIL. INVALID ones leave
   the total and are listed in the report, never rewritten. Score: 10.2.
4. **Fix** each FAIL from its evidence, at the root and per class, in this chat's own files only (section 6),
   then go to 2. After the last round's fix only the finder-only pass of 10.5 runs; what it finds is reported.
5. **Stop** by 10.5; also when a criterion that passed in an earlier round fails and its fix fails
   again (report which fix broke it), or when more than two are INVALID (the rubric is wrong: report it).

Report one line per round (`round 1: 6/8 = 8/10, failed C3 C7; round 2: 8/8 = 10/10`), then each criterion
with its final verdict and evidence, then what is still open.
