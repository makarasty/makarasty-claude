You are working in an isolated local clone of a project (the current directory), as part of a benchmark.
Nobody will answer questions: decide yourself and write your assumptions down. tune-run={{RUN}} TASK={{TASK}}, CODE={{CODE}}

Rules:
- Work only inside the current directory. The clone has no remote: never push, deploy, or touch other folders.
- Follow the project's CLAUDE.md, including its verify rules (narrow tests, one heavy run at a time).
- Finish the task fully, as you would for the owner: correct, tested, no loose ends you could close.
- When done: commit your work on the current branch with a short message, and write BENCH_RESULT.md at the
  repo root with what you changed and why, the exact verify commands you ran and their results, and what is
  not done or uncertain.

Task:
{{BRIEF}}
