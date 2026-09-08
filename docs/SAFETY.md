# Safety: what an unattended fleet is allowed to do to the disk

A fleet runs a dozen sessions nobody is watching, each holding a shell. What they may remove has to be a
closed list decided once, here, rather than a judgement each worker makes while unattended.

## The closed list

1. **The run's own scratch**, under `.fleet/<run-id>/`, which `PROTOCOL.md` declares scratch and which
   belongs in the project's ignore file.
2. **The worktrees the run's own workers created**, under `.claude/worktrees/`, and only through
   `fleet.sh clean`.

Nothing else. There is no `git reset --hard`, no `git clean`, no `git checkout --` anywhere in this
plugin, and no recursive force-delete of a path it did not create.

The procedure for removing a worktree is [`WORKTREES.md`](WORKTREES.md); the measurement that shapes it is
[M32](MEASUREMENTS.md). This page is the reasoning behind the guards and an account of where they stop.

## Why a path is checked twice

A path rarely goes wrong in the middle. It goes wrong at the end, and in one of a few ways: a variable
that was empty, a `dirname` taken once too often, a prefix stripped twice. Each of those turns a path into
its own **parent**. So the useful question about a guard is which parents it catches.

Take a real worktree, eight named segments deep:

```
C:/Users/you/Desktop/projects/app/.claude/worktrees/wtA
```

| slip | lands on | caught by |
|---|---|---|
| 1 | `.claude/worktrees` | not a registered worktree: `git worktree list` membership |
| 2 | `.claude` | containment: no `.claude/worktrees/` segment |
| 3 | the project's main checkout | containment, and the explicit main-checkout test |
| 4-8 | `projects`, `Desktop`, the user, `C:/Users`, `C:/` | containment, and the depth floor |

**Containment does most of the work**: the path must carry a `.claude/worktrees/` segment, and git must
call it a worktree. **The depth floor is the second, independent guard**, and it earns its place on the
case containment cannot see: a path that does carry the right segment and is still near the root, such as
`C:/.claude/worktrees/x`, or a worktree somebody created at `C:/wtmerge`. Four is a chosen floor, not a
measured one.

Both fired the first time `clean` ran against a real project: eleven worktrees at the root of drive C,
reported and untouched.

## The other two guards

**Dry run.** `fleet.sh clean` prints what it would do and why, and changes nothing, unless it is given
`--remove`. A destructive command whose first behaviour is to destroy is the wrong shape for a tool an
agent invokes.

**Keep anything holding work.** A worktree with uncommitted changes, or whose branch holds commits that
are neither in the main checkout's branch nor on that branch's upstream, is kept and reported. That test
is `merge-base --is-ancestor`, which is the question `git branch -d` asks, run **before** the tree is
removed so the whole tree survives rather than only the branch. Branches go by `git branch -d`, never
`-D`.

## Where the guards stop, which is the part worth reading

`unsafe_path()` runs inside `fleet.sh worktree` and `fleet.sh clean`. Nothing else on the machine goes
through it.

- **A worker's own exit is not gated.** The rule that a worker unlinks its junctions before calling the
  harness's `ExitWorktree` lives in `fleet-run.md` as prose, and `ExitWorktree` is the harness's tool, not
  this plugin's. `fleet.sh unlink` gives the worker a gated command to use instead, but nothing forces it
  to. By this repository's own ledger that is the step most likely to fail. **Not done.**
- **An agent's own shell is not gated.** A model that types a recursive delete directly meets nothing from
  this plugin. That layer is the host's permission configuration, not this repository.
- **The measurement is one machine.** [M32] is Git 2.53.0 on Windows 11, one filesystem. The unlink-first
  rule should hold anywhere a recursive delete follows links, and has not been run anywhere else.

## A gate beats a rule written in prose

Three rules in this repository were measured against the behaviour they asked for, and all three failed:

- A clock the worker was asked to stop: armed 87 times across two runs, stopped **zero** times [M04].
- A lane rule retyped into chip prompts instead of being an argument: **73 claims hand-rolled** beside 113
  through the helper, and a hand-rolled claim skips the schema check [M06].
- "Read before Edit" in `PULL.md` argued with the harness's own system prompt and lost on three runs in a
  row [M31].

The rules that were gates held: **1,516 of 1,516 findings** in one run carried the stamp only
`fleet.sh find` writes.

So the prose on this page is not what makes the deletion safe. `unsafe_path`, the dry-run default and
git's own refusals are, on the paths that reach them; and the section above says which paths do not.

## On writing the reason before the rule

This plugin writes the reason above the destructive code and above the destructive instruction. The
evidence for that convention is split, and worth stating accurately.

**For text a model generates, the ordering has a controlled ablation behind it.** Wei et al. put the chain
of thought *after* the answer and it performed like no chain of thought at all
([2201.11903](https://arxiv.org/abs/2201.11903), §3.3) - measured on their arithmetic and commonsense
sets, not established in general. Turpin et al. showed the failure mode: a model steered toward an answer
produces a justification that rationalises it ([2305.04388](https://arxiv.org/abs/2305.04388)). So where
this plugin asks a worker to **judge**, the document demands the evidence before the verdict. The finding
schema's split of `observed` from `mechanism` came from [M09](MEASUREMENTS.md) rather than from this
literature; the two agree.

**The same generation-order evidence also runs the other way, on the task class this page is about.**
Asked to reason first, fifteen models followed explicit instructions *worse*, with attention drawn off the
instruction tokens ([2505.11423](https://arxiv.org/abs/2505.11423)). Reasoning first helps a worker
deciding whether something is a defect. It does not help a worker obeying a rule.

**For a document a model reads, the ordering is not established at all.** No source found says a
justification must precede an imperative. Anthropic's guidance is to *include* the motivation, because the
model generalises from it, and says nothing about placing it first; the same guidance puts instructions
**after** longform data, reporting up to 30% better answers, and one study found instruction-after-input
better by up to 9.7 BLEU ([2308.12097](https://arxiv.org/abs/2308.12097)).

The convention therefore stays in this shape: state the reason, keep it short, put it next to the rule,
and expect nothing of it beyond helping the next reader generalise to a case the document did not
anticipate.
