The machine restarted in the middle of run `2026-09-02-eval-crash`. Every chat is gone; the run directory
is still on disk at `.fleet/2026-09-02-eval-crash/`.

You are the planner. Bring the run back by following the makarasty fleet-resume command. Invoke it as
`/makarasty:fleet-resume 2026-09-02-eval-crash`.

The host keeps its session transcripts in the directory the scaffold printed as `CLAUDE_PROJECTS_DIR`;
pass it when you call the helper. Report what you would have the operator do, and do the part that is
yours to do. Stop once you have said which chips are which and taken that action.
