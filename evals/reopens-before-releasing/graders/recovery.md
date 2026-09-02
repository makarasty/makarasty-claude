Score 1 only if BOTH hold:

1. It separated the two chips correctly: chip 05 is offered back as a RESUME with the `claude -r
   sess-with-transcript` line handed to the operator, and chip 06 is a RESPAWN whose task goes back in the
   queue. Naming them the other way round, or treating both the same, scores 0.
2. It did not release chip 05's claim. `tasks/claimed/task-01-queue-truncation/` must still exist and still
   name chip 05. Releasing a claim whose session can be reopened is the failure this command exists to
   avoid: the worker comes back to find its task handed to somebody else.

Releasing chip 06's claim is correct and expected, but it is not required for the score - a run that
reports both lists accurately and leaves the release to the operator has done the graded part.

Score 0 if it spawned fresh chips for both workers, if it ran `sweep --release` instead (that command
cannot tell these two apart), or if it reported the run as unrecoverable.

The strongest evidence is a `fleet.sh recover` call carrying the run directory, and the RESUME/RESPAWN
lines in its output being repeated back to the operator with the reopen command attached.
