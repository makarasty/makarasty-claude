# Judge task: paired review benchmark

Dir: {{DIR}}
Reviewer answers: {{BLIND}}

Anonymous reviewers, each a one-letter code, reviewed the same diffs. You judge their findings. Never open
`sealed/map.json` (it would unblind you). Read `sealed/answers.json` for the known bug of your diffs only
AFTER you have judged every finding on its own merits.

For each of your diffs NN:
1. Read `NN.diff` and `NN.json` in Dir, and every `<Reviewer answers>/NN-<CODE>/review.json` (the folder
   name gives the code).
2. For every finding decide REAL / FALSE / UNSURE by checking the code at that commit, read-only
   (`git -C <repo> show <sha>:<path>`, `git -C <repo> grep -n <pattern> <sha>`). REAL needs the trigger to
   actually produce the wrong result. Rate how much it matters: high / medium / low.
3. Merge duplicates across reviewers (same root cause = one defect).
4. Then open `sealed/answers.json`: did each reviewer catch the known bug of this diff, if it has one?

Write `judge/NN.json` in Dir:
{"defects":[{"id":"d1","what":"...","severity":"high|medium|low","real":"REAL|FALSE|UNSURE","found_by":["A","K"]}],"known_bug":{"exists":true,"caught_by":["A"]}}

Final reply: per diff one line `NN: <code> real/false, ... known bug caught by [...]`.
