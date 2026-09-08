# Writing this plugin's commands

Every command here is a file in `commands/`, which Claude Code reads with the same frontmatter as a skill.
This page is what an author has to know before adding or editing one. It exists because two of the rules
below were broken in this repository and neither was visible from reading the file that broke them.

## Who may invoke what, and the one exception

`disable-model-invocation: true` means **only the operator** can start the command. Claude Code blocks a
model that tries and tells it not to reproduce the steps by hand.

| Command | Flag | Why |
|---|---|---|
| `fleet`, `fleet-plan`, `fleet-design`, `fleet-redesign`, `fleet-call` | set | They spend money and depend on the operator's clicks |
| `fleet-run` | **not set, deliberately** | The operator starts a worker by clicking its chip; the model in that new session is what invokes `fleet-run` there |
| `fleet-init`, `fleet-login`, `fleet-wait`, `fleet-collect`, `fleet-resume` | not set | An agent that needs them must be able to reach them |

**Giving `fleet-run` the flag would break every worker**, at the moment it tried to begin. The prose in
`README.md` and `commands/fleet.md` used to list `fleet-run` among the operator-only commands, which is the
kind of error that stays harmless until somebody tidies the frontmatter to match it.

**Never write an instruction telling the model to invoke a command that carries the flag.** It cannot
comply, and the failure looks like the model refusing to work. `fleet-redesign` did this: it told the model
to run `/makarasty:fleet-design` when the canvas was missing. The shape that works is to print the line for
the operator and stop. Anything a command tells the model to invoke - `fleet-init`, `fleet-wait`,
`fleet-collect`, `/makarasty-tools:unslop` - must be a command without the flag.

## `allowed-tools` is a pre-approval, not a restriction

This is the field most easily misread. It lists tools the model may use **without a permission prompt**,
for the turn that invoked the command only, and it clears at the operator's next message. It does not stop
the model using anything else, and it does not narrow what the command can do.

Two consequences worth knowing:

- **It cannot separate our safe helper calls from our destructive one.** `fleet-collect` runs
  `sh "$f" merge`, `sh "$f" landed` and `sh "$f" clean --remove` through the same `sh` prefix, so no
  pattern like `Bash(sh *)` can pre-approve the first two and hold back the third. Scoping the grant would
  buy nothing here, so the grant stays broad and the protection stays where it actually works: `clean` is a
  dry run unless given `--remove`, and every deletion passes the path gate in `SAFETY.md`.
- **`disallowed-tools` is the field that restricts**, and nothing here uses it yet. It removes a tool from
  the model's pool while the command is active. A command that must never ask the operator a question is
  the case it exists for.

## The rest, briefly

- **`description` is capped at 1,536 characters** together with `when_to_use`, and is truncated in the
  listing beyond that, so the first sentence carries the load. The longest here is 560. Put what the
  command does first and when to reach for it second.
- **A command with `disable-model-invocation` has a human-facing description**: the operator reads it in
  the `/` menu and no model matches against it. Trigger phrases in one are wasted words. A command without
  the flag is the opposite - `commit` and `say` carry the phrasings people actually type, in both
  languages, because that is what makes them fire.
- **`argument-hint`** is autocomplete text. Omit it when the command takes no arguments, as `fleet-init`
  and `fleet` do.
- **`model` and `effort`** apply for the rest of the invoking turn. No command here sets them: a planner's
  work is choosing the model *per task*, which belongs in the task file, not in the command that writes it.
- **Keep a command under 500 lines** and push reference material into `docs/`, which is what every command
  here does through its first paragraph. The longest is `fleet-run` at 334.
- **`commands/` is the legacy location and still supported.** The documentation recommends
  `skills/<name>/SKILL.md` for new work, which would keep every invocation name identical and add support
  for per-command files. This plugin has not moved, because its reference material is shared between
  commands and already lives in `docs/`. Moving is a mechanical change nobody has needed yet.

## Before adding a command

1. Does an existing one cover it? Reference belongs in `docs/`, not in a second command.
2. Does the operator start it, or a model? That decides `disable-model-invocation`, and the answer is
   load-bearing rather than cosmetic.
3. Does anything it tells the model to invoke carry that flag? If so the instruction cannot be followed.
4. Does the first sentence of the description say what it does and when to reach for it?
5. Does it point at `docs/` rather than restating a rule that lives there?
