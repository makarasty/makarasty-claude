---
description: How to build or change a Claude Code tool - a skill, slash command, hook, subagent or plugin - so it triggers on the right words, costs few tokens and is shown to change behaviour. Use when writing or editing a SKILL.md, a command, an agent file, a hook or a plugin manifest, or on "сделай тул", "сделай скилл", "перепиши скиллы", "скилл не срабатывает", "напиши плагин", "проверь скилл", "лучшие практики для скиллов", "build a skill", "audit this skill".
argument-hint: [what to build or which tool to check]
---

The reader of what you write is a strong model that already knows how to code, review and write. A
tool earns its place only with what that model lacks: facts about this machine and project, the
person's taste, a contract other code depends on, and the mistakes the model makes by default here.
A line that restates a default costs tokens on every use and can push a better model off its own
better judgement. A line that is wrong does more harm than a missing one.

## 1. Find the failure first

Before writing, find what goes wrong without the tool: the person's own words in past chats (they live
in `~/.claude/projects/*/*.jsonl`; count distinct chats, not prompts, and merge cloned chats that share
a first prompt and timestamp), and one run of the task with no tool. Write down the failure in one line.
No failure found: the tool is not needed yet, say so.

## 2. Pick the mechanism

- **Must hold every time** (never run X, always check Y): a hook. Prose is followed most of the time; a
  hook all of the time.
- **Fixed steps, exact output, or fragile commands**: a script the tool runs. Only its output costs tokens.
- **Judgement** (what to group, what to ask, what matters): prose.
- **Reference read on need** (a format, a long table): a separate file, linked one level from the main one.
- **Only a person should start it**: `disable-model-invocation: true`, and no trigger phrases.
- **Already done by an installed skill, a built-in command or the project**: use that; write nothing.

## 3. Write the description as the trigger

It decides whether the tool is ever loaded. First sentence: what it does and when, in third person.
Then one phrase per distinct case and per language the person types, taken from the transcripts; a
synonym of a phrase already listed adds cost, not triggers, and a voice-typo form earns a place only when
a test shows the plain form misses it.
Add a `Not for ...` clause when a neighbour skill could take the same words. Every description of every
installed skill is paid on every turn, so keep it under about 400 characters unless the trigger set needs
more, and check it against the other installed descriptions for collisions.

## 4. Write the body

- Say the outcome and the standard of done, not a persona. "Senior engineer with ten years" buys tone,
  not skill.
- Put the reason next to the rule, in a clause. A model generalises from the reason to the cases you
  did not list.
- State the target ("one line per item"), not the forbidden thing; a negation names what it forbids.
- Calm words. Capitals, MUST and CRITICAL make a strong model over-apply the rule.
- One default plus its escape hatch, not a menu of options.
- One term per thing, and words the model already reads one way. Unsure a word lands: ask a small fresh
  agent to retell the tool in its own words and compare.
- No dates, model names or version-specific tricks in rules: they rot when the model changes. A fact
  that needs a date goes into the project's measurement log, cited from the rule.
- Most important rules first: after a compaction only the head of a loaded skill survives. Under 500
  lines; long reference goes to files.

## 5. Keep the running cost near zero

Anything at SessionStart or UserPromptSubmit is paid on every session or every prompt: print nothing when
there is nothing to say, measure the bytes it adds, give every hook a timeout, and let a hook that fails
pass (the person's prompt matters more). A hook text is a fact, not a command. Windows: no `&&` in
PowerShell 5.1, LF line endings pinned, paths with spaces quoted, `node` over `sh` when both can do it.

## 6. Prove it changes behaviour

- `claude plugin validate --strict <dir>`: manifest, paths, names.
- **A/B and ablation**: `node "${CLAUDE_SKILL_DIR}/ab.mjs" <cases.json>` runs each prompt in each arm in an
  empty folder with no user plugins (arm A) and with the tool or with one line removed (arm B), and scores
  the reply with regexes. Usage is in the script's header. 2-3 runs per prompt on the model that will use
  the tool; a line whose removal changes nothing is a line to delete. Include prompts that must not
  trigger it.
- `claude plugin eval` for graded cases with tool-call checks. On native Windows only cases that grant no
  Bash or PowerShell run, and it needs `ANTHROPIC_API_KEY` set; suites that grant a shell need WSL2.
- `/skill-doctor` for the listing cost of every skill and the ones never used; `/doctor` for the rest.
- A cold read: one small agent reads only the tool and returns the questions it would still need answered.
  Answer them in the tool, not in chat.
- Code in the tool gets its own small test that fails when the code is wrong.

## 7. Attack it, then ship it

Run `/makarasty-tools:redteam` on the tool: false triggers and missed ones, token cost, destructive paths,
Windows, two chats running it at once. Then bump the version (an installed plugin is a cached copy that
changes only with its version string), add the changelog entry, and update the install
(`claude plugin marketplace update <market>`, `claude plugin update <plugin>@<market>`); new sessions pick it up.

## When a new model ships

Re-run the A/B cases without the tool. A rule the bare model now follows is absorbed: delete it.

## Done when

The failure is written down, the mechanism is the lightest that holds, the description triggers on the
person's words and not on a neighbour's, each rule was either measured or marked untested, and the
red-team findings are fixed or answered.

Status: this file's own rules come from Anthropic's skill and prompting guides and from the owner's
chats; the description routing was measured with `ab.mjs` [M50], the body rules were not.
