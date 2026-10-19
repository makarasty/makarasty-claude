# Which model runs which stage

A claim here that is a measurement says so and gives the number. Everything else is a judgement call, and
says so.

## The roster

Write the alias in a brief's `model:` line and in agent frontmatter; the alias follows the tier, the ID
pins one release. Lineup as of 2026-10-12:

| Alias | Model, ID | Fits |
|---|---|---|
| `fable` | Fable 5.1, `claude-fable-5-1` | The design model: proposing how a screen should look, writing markup and copy meant to be seen, ruling on taste. The top tier, and nothing cheaper touches its result afterwards: `MISSIONS.md`, design. On an account without it, `opus`. |
| `opus` | Opus 5.5, `claude-opus-5-5` | Judgement. Deciding whether an observation is a defect, ranking severity, writing a brief another model will execute without supervision. |
| `sonnet` | Sonnet 5.5, `claude-sonnet-5-5` | Execution carrying judgement. Walking a scenario, noticing that something is wrong rather than merely different, following a spec that has gaps in it. |
| `haiku` | Haiku 5.5, `claude-haiku-5-5` (Haiku 4.5 on Bedrock, Vertex and Foundry) | Mechanical work under an exact contract. Fetching a value, running a fixed probe, reformatting, counting. |

## The delegation measurement

A Haiku subagent driving a live Browser pane, 2026-08-24: **45,775 tokens for 3 tool calls**, 16 seconds,
4 lines returned to the parent. Nearly all of that is fixed startup, being the system prompt plus the tool
schemas it had to fetch. It ran the mechanics correctly.

Two conclusions that point in different directions:

- **On context, delegation always wins.** A screenshot plus an accessibility tree can be tens of thousands
  of tokens that sit in the parent's context for the rest of the session. Delegated, roughly 80 come back.
  Parent context is the scarce resource, and it does not refill.
- **On cost, delegation wins only across a long burst,** because of the fixed overhead per spawn. A single
  probe is cheaper inline. Give a subagent a whole scenario, fifteen steps returning ten lines, rather than
  one step at a time.

The measurement does not show that Haiku can judge an interface. It ran a fixed probe and described a
login screen, so read it as evidence about mechanics alone.

Measured again on a real scenario rather than a probe, 2026-08-26: a Sonnet `fleet-scenario` executor
walking two screens spent **57,103 tokens over 33 tool calls in 219 seconds**, and returned roughly **750
tokens** to the parent. That is **1.3 percent**, the case the fixed overhead was always waiting for. The
screenshots, DOM reads and settle polling stayed in the subagent.

Confirmed at scale, 2026-08-26: executor return ratios across eight workers ran 0.96 to 2.04 percent,
bracketing that reference. The ratio is stable and is not the lever. **The denominator varies by an
order of magnitude**: the cheapest executor made 30 tool calls, took no screenshots and read 4.0 M cached
tokens; the most expensive made 194, took 51 screenshots and read 55.6 M (both counted per transcript
line, so about half that in absolute terms; the ratio holds). Both returned about the same
number of lines. What a run costs is decided by how much the executor looked at, never by how much it
said.

The same run read 163.8 M cached tokens against 4.21 M non-cached, a ratio of 39 to 1, so most of what a
fleet moves is cache rather than new context. (An earlier count per transcript line gave 311 M and 8.31 M;
every message spans about two lines.)

The parent then spent six inline probes ruling on what came back, which was cheaper than a second spawn.
The rule from the other side: one probe inline beats a spawn, and one scenario delegated beats running it
inline.

## How a stage picks its model

The brief carries the choice, in `model:` and `verdict-model:`. A single brief splitting the two is normal:
one model walks the scenario, another rules on what the walk produced.

Neither field changes the model of the session reading the brief: a session never switches itself. They
are honoured by dispatch, and in a queue the dispatch is the worker's: a task whose `model:` is above the
model `fleet.sh whoami` recorded for the worker is delegated to one `Agent` at that tier, and one at or
below it is worked in place. The worker's own model is the coordinator's to set, once, at its start
("Switching a worker", below); a queue task's `model:` is met by a spawn, never by switching the worker per task. `model:` is passed as the `Agent` call's per-invocation parameter,
which outranks the agent definition's own frontmatter, so a brief naming a tier gets it. `verdict-model:`
is honoured by spawning a second pass at that tier over the returned observations, and a definition whose
own frontmatter already carries the tier - `fleet-design-eye` on `fable` - honours it without the brief saying
anything. Effort travels the same way since Claude Code 2.1.292, as the call's `effort` parameter, below.

Guidance:

- **Dense state, unfamiliar domain, or a subtle correctness question**: Opus walks it. Weaker models do not
  fail loudly here. They fail by not noticing, and silence looks like a pass.
- **Clear spec, obvious pass or fail**: Sonnet walks it, Opus rules on the findings.
- **Fixed probe, extraction, counting, reformatting**: Haiku under an exact output contract.
- **A screen that has to look right, or a proposal for how it should**: `model: fable`, end to end, and
  it is the one place where the top tier is the cheap choice - a proposal from a weaker model is a redesign
  the operator has to redo. Capturing a screen from source is not that job; the strong general model
  copies exact values well. Reviewing a screen for design defects is the same tier: `fleet-design-eye` runs
  the geometry probes and rules on what they return in one pass, on `fable`, because what is left after the
  probes is a taste verdict nobody downstream re-decides.
- **A page somebody will read aloud to a vendor**: the design model for the page, for the copy reason above;
  Opus for the facts behind it, because "every number about this topic" is not a clear spec and a weaker
  model finishes it early and quietly. `CALL.md` has the stages.
- **Uncertain**: go one tier up. A missed defect costs a release and a tier costs cents.

## The router

`makarasty-tools` carries a function hook on `agent.spawn` (`tools/hooks/router.ts`) that moves a spawn to
a cheaper model only where the caller says that is safe. It touches only the built-in `general-purpose` and `Explore` agents, and the fleet's own `fleet-coder` (routed like `general-purpose`) and `fleet-reviewer` (never moved: a tag on it is ignored, because it is the check that makes a tag safe) [M41], spawned without
`model` from an Opus or Fable parent; a named model, any other agent (your own `Explore.md` included: the `agent.offer` event says where each type came from), a workflow agent and a fork go through
as written.

- `Explore` goes to `haiku`: it locates, it does not judge.
- A description that starts with `[exec]` goes to `sonnet`, one that starts with `[mech]` to `haiku`.
- Anything else keeps the parent's model.

Tag `[exec]` only when something independent checks the result afterwards: an Opus review, or tests the
agent did not write. Replayed on three real ports [M39], Sonnet tied Opus twice at 26-40 % of the cost and
once closed a task the shell would have left open, which its own 146 test cases never exercised; only the
other side's tests and a blind review found it. A keyword guess was tried first and dropped for the same
reason: it would have sent that port to Sonnet. `/router` prints what it changed; `MAKARASTY_ROUTER=off`
turns it off.

## Pace

The questionnaire (`fleet-plan`, at most four questions in one `AskUserQuestion` call, each with a
recommended first option) is what picks the tiers and the review rounds. The answers go to the `pace:` line
of `STATE.md`. Width is never an answer: it is `fleet.sh width`. The loop that uses these is in
[`ONECHAT.md`](ONECHAT.md).

| Scale | What it edits in the plan |
|---|---|
| Let the plan count it (recommended) | the draft's own count; warn as for Large when it lands past about 150 tasks |
| Small (a few tasks) | a queue of a few tasks; no warning |
| Medium (an afternoon) | a queue of an afternoon's tasks; no warning |
| Large (a day+, queue it) | the whole queue filed at launch; tell the operator it may run overnight and that the coordinator is relaunched at each 700 K mark, about every 150 to 200 tasks (estimate, [M43]) |

One chat always works a queue: `chips --agents` refuses a slot that has a brief. Fixed briefs are for
separate chats, over a surface no larger than the plan (`fleet-plan` 3b). Scale sets no budget: the first
wave's default budget is replaced by the run's measured median once three tasks are done (`fleet-plan` 2b).

| Economy | Coder | Reviewer, the verdict |
|---|---|---|
| Maximum (recommended) | Sonnet, effort `high`, never `max` | Sonnet, spawned on every code task |
| Balanced | Sonnet, effort `high` | Sonnet, effort `high`; Opus on implement, root, design |
| Spend for speed | Opus, `high` | Opus, `xhigh` |

| Speed against quality | Rounds |
|---|---|
| Fastest finish | one review; only blockers become fix tasks; one scoped verify at the end |
| Balanced (recommended) | one review and one fix round |
| Best quality | review until a round finds nothing, bounded by the 2x-budget clock |

**Economy flow.** The coordinator's top model decides and nothing else; every mechanical step goes to a
cheaper model. Commits, `STATE.md` updates and log reading go to Haiku, the description starting `[mech]`
(the router above sends it to `haiku`), except `STATE.md` while the run is paused: the hooks hold every
subagent then, so the coordinator writes it. Merges, which exist only with the opt-in worktrees, go to Sonnet
tagged `[exec]`. Design is the exception to all of it and stays on the top tier. A task the reviewer rejects
after a cheaper tier did it is re-spawned once, one tier up (Haiku, Sonnet, Opus); a second reject goes to
the operator as one `AskUserQuestion` (`ONECHAT.md`, "Economy").

**Why it is cheaper.** A chat worker starts a task at about 92 to 107 k of context and re-reads its earlier
tasks, 27 to 54 % of its cache reads and 55 % in [M41]. A fresh subagent per task starts at about 40 to 75 k
with nothing carried over, and idle gaps over five minutes, which rewrote the cache for 4 to 6 % of spend,
do not occur. Estimated 14 to 20 % cheaper than the hybrid of the 2026-10-14 run ($735) and two to three
times cheaper than inline chat workers [M43]. **That is an estimate; no one-chat run has been measured end
to end.** The first one is analysed with `fleet-analyze`.

## Reasoning effort

**The operator's policy, 2026-10-08.** `high` is the default for every worker session (`chips --effort`).
`medium` for plain, well-specified work. `xhigh` for the hardest lanes - coordination, UI, a subtle
correctness question - and the ceiling: the docs warn `max` "can be prone to overthinking", and the operator
saw it make workers do far more than asked. `fleet.sh chips` refuses `--effort max`. The agent files keep
their own effort, each with its reason. For one task that needs more than `xhigh`, the operator turns on
ultracode (`/effort ultracode`, or the word `ultracode` in a prompt they type), which has Claude run the task
as a workflow of subagents at the current effort; the coordinator asks for it, since no tool sets it. An effort change keeps the prompt cache on the
5.5 models and Fable 5.1; a model change does not (`code.claude.com/docs/en/prompt-caching`).

Effort is settable per subagent, in the definition file's frontmatter. The `effort` field is documented at
`code.claude.com/docs/en/sub-agents` as "Effort level when this subagent is active. Overrides the session
effort level. Default: inherits from session. Options: `low`, `medium`, `high`, `xhigh`, `max`; available
levels depend on the model." Four of the six agents in `agents/` carry one, with its reason in the file; `fleet-coder` and `fleet-reviewer` carry neither `model:` nor `effort:`, because the caller sets both. In one chat every `Agent` call passes `effort` and `model` explicitly from the `pace:` line.

From Claude Code 2.1.292 the `Agent` call also takes a per-invocation `effort`, which outranks the
frontmatter; `CLAUDE_CODE_EFFORT_LEVEL` outranks both. With neither, a subagent runs at the session's
effort, and so does one the router moved to Sonnet or Haiku: `agent.spawn` carries no effort field. A
running session still cannot raise its own effort.

Anthropic's starting points (`platform.claude.com/docs/en/build-with-claude/effort`, 2026-10-12): Sonnet
5.5 `medium` for well-specified agentic work and `high` for harder or longer tasks; Haiku 5.5 `medium`, and
`high` for long agent tasks and strict instruction following, because at `low` it skips searches and checks;
nothing recommends `xhigh` for either. In Claude Code the 5.5 models default to `medium`. Measured here
[M39], effort changed cost per call by under 5 % at the same context; what it changes is how much a call
checks.

Model reaches a subagent through four places, in this order: the per-invocation `model` parameter, then the
definition's `model` frontmatter, where `inherit` selects the main conversation's model, then the
`CLAUDE_CODE_SUBAGENT_MODEL` environment variable, then the main conversation's model. Setting
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` to `1` moves that environment variable to the front, where it overrides
both the per-invocation parameter and the frontmatter; with `FORCE` set and no `CLAUDE_CODE_SUBAGENT_MODEL`
alongside it, every subagent runs on the main conversation's model. That ordering holds from Claude Code
v2.1.251. Before it the environment variable came first on its own.

What the ordering means for this plugin: `fleet-run` spawns its pane agents with the brief's `model:` as a
per-invocation parameter, which is the top of the order, so the `model:` line in `fleet-scenario`,
`fleet-profiler` and `fleet-design-eye` is the fallback for a brief that omits one, not the tier those
agents actually run at. `fleet-triage` is spawned by `fleet-collect` with no model, so its frontmatter is
what runs. The `effort:` line is what runs in all four of those unless a call passes its own `effort`.

## Switching a worker

**Opt-in chats only.** In one chat, the default, there is no worker session to switch: the coordinator names
the model on each `Agent` call. What follows is for a run that chose separate worker chats.

The coordinator sets each queue worker's model and effort; the operator does not [M35]. A chip starts on
whatever the app's model menu shows at the click, so the run says what it wants and the coordinator
switches any worker that started on something else.

The tools are the desktop app's session tools, deferred, so load them with ToolSearch first:

- `mcp__ccd_session_mgmt__set_session_model`: a `session_id` and a model id as `get_session` prints it.
  A wrong id is refused with the list of ids.
- `mcp__ccd_session_mgmt__set_session_effort`: `low`, `medium`, `high`, `xhigh` or `max`.
- `mcp__ccd_session_mgmt__list_sessions` turns the title `fleet <run-id> NN` into a `session_id`; resolve
  it right before each call, because handles are opaque.

What bounds them, per the tools' own descriptions (2026-10-08):

- **A switch lands on the next turn.** A turn in flight finishes on the old model, and a queue worker's loop
  is one long turn. That is why `whoami` ends the worker's turn on a mismatch: the wrong model runs only the
  `whoami` call.
- **Never this session.** No session switches itself. The operator picks the coordinator's model in the
  app's menu.
- **The approval card.** No card for a chip this coordinator offered when the target is the coordinator's
  own model or a cheaper family, at its own effort or lower. A dearer model or effort, or a chip another
  chat offered (a relaunch, a handoff), shows the operator one card per call.
- **The prompt cache does not carry over.** The next turn re-reads the whole context uncached on the new
  model, so switch at the worker's start, while its context is small. A heavier task later is an `Agent`
  spawn, never a switch.
- **Queue workers only.** A brief is one turn, which no switch reaches, and `chips` refuses `--model` for
  one: tell the operator which model to pick in the menu before clicking a brief chip. A worker reopened
  in a terminal with `claude -r` is outside the app, and nothing switches it.

The loop:

1. Read your own pair with `get_session` on `self`. Pick each lane's pair at or below it, or say at
   hand-over that one approval card per switch is coming.
2. `fleet.sh chips <run> 01-04 repo --model <id> --effort <level>` writes `want/NN`. A re-offer without
   `--model` keeps the wish; `--model none` drops it.
3. The worker runs `whoami` before its first claim. On a mismatch it prints `SWITCH`, exits 10 and ends its
   turn; `next` claims nothing for it meanwhile. An effort the worker could not read passes.
4. The watch prints `WORKER MODEL NN` with the exact calls, and again every ten minutes while the worker
   waits. Make them on the session titled `fleet <run-id> NN`, then `send_message` it the line the watch
   gives, which has it run `whoami` with `switched` as its last argument. During a pause, wait for
   `RESUMED` first.
5. Done when `status` shows no `WAITS FOR A MODEL SWITCH` under NN. The same mismatch after `switched`
   means the switch did not take: the worker goes on with what it has, the watch prints `WORKER MODEL NN DID NOT
   TAKE` once, and you switch it again or accept it with `rm <run>/want/NN`. `RUNS OFF ITS WISH` in
   `status` is a worker that never compared, an older plugin or a skipped `whoami`: switch it the same way.

Effort, measured 2026-10-05: the plan said Sonnet for 81 of 125 tasks, every worker was Opus at medium,
and the one data point on effort did not favour high: the worker on high had all three of its first tasks
sent back for fixes, the workers on medium six of about eighteen, and every return came from the hardest
area of the plan. The operator's policy above stands; this one data point does not overturn it.

Outside a run, the operator still sets defaults once: `model` and `effortLevel` in settings for where
sessions start, `CLAUDE_CODE_SUBAGENT_MODEL` for every otherwise-unassigned subagent, and `model:` plus
`effort:` in the agent files that carry them for the work a fleet dispatches.

## Cost discipline that is not about models

Most waste is not the tier. In order of size:

1. **Raw page data in the parent's context.** One full accessibility tree on a dense list is a large,
   permanent cost. Return small JSON from a targeted expression, and let subagents hold the bulky reads.
2. **Many small spawns instead of one large one.** Fixed overhead each, measured above.
3. **Round trips.** Independent tool calls issued one per message cost a full model turn each. Send them
   in one message.
4. **Unscoped verification.** In a large repository a full test suite and a full typecheck dwarf every
   token decision on this page, and two of them at once put the machine this was written on into the page
   file. You do not need to remember this one: a hook refuses a full suite or a full typecheck from a
   worker that does not hold the verify lane, and names the scoped form in the refusal.

## Writing for the models you dispatch

A prompt sent to a subagent is read by a model, not a person. Compress it: drop articles, filler and
pleasantries, keep every technical term, number, unit and negation exact. Expect little from it in tokens:
M24 puts output at 0.3% of what a run moves.

Keep the part of a brief that states what correct looks like at full length. A dropped negation in an
assertion turns a passing screen into a defect report, and no token saving covers the hour spent chasing
it.
