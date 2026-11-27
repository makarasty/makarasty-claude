# Handoff to a chat that runs a fleet

Read from `SKILL.md` step 6, only when the next chat is to run a fleet.

When the next chat is to run a fleet (a coordinator relaunch builds its own chip, with its own prompt, and
never reaches this step), the first Next step depends on whether a run exists. A new run:
`/makarasty:fleet-plan` with the plan's path as its mission. A run already under way: read
`<run>/STATE.md` (it holds the plan path, the run dir, the worker count `n`, the chips offered by lane, the
integration checkout's path and URL, any extra watched URLs, whether the queue is open, the merges in
order, the reviews in flight, the fix tasks and why, the operator's decisions and the pane check tasks
filed with their state), re-arm `/makarasty:fleet-wait <run> <n>` with that `n` and the integration URL
added to `svc` (which records the new chat as the coordinator), and use `/makarasty:fleet-resume` only if
the worker chats are gone. Read sections 3b and 8b of `/makarasty:fleet-plan` before re-arming - the review,
queue and pane-check rules live there - without re-running its interview or its chips. If `/makarasty:fleet-plan` does not resolve (a chat started before the plugin was
updated keeps the old install until it restarts), read the command file at `<plugin root>/commands/fleet-plan.md`
and follow it. Offer no new chips
there, since the existing ones carry the same titles; the one exception is a lane `fleet.sh status` names
as without a worker. Name `opus` in the Model line for a fleet coordinator. A coordinator that improvises
the launch from docs gets the chips wrong, and the project's own rules fill the gaps.
