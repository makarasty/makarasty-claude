# Review task

Dir: {{DIR}}

Review one committed change for real defects: bugs, security holes, data loss, broken edge cases, wrong
behaviour against what the change was meant to do. Not style.

Everything you need is in this dir, and only here: `change.diff` (the change), `change.json` (the commit
message, the changed files, what `tree/` holds) and `tree/` (the files of the touched directories as they
were at that commit). Read nothing outside this dir: the benchmark scores what you find from the change
itself, and other folders hold other reviewers' answers.

Every finding needs evidence: the file:line in the diff, the input or state that triggers it, and what goes
wrong. No evidence, no finding.

Write `review.json` in this dir:
{"findings":[{"file":"...","line":123,"severity":"high|medium|low","what":"one sentence","trigger":"input/state -> wrong result"}]}
An empty list is a valid answer.

Final reply: one line, "<count> findings".
