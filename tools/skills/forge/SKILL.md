---
description: "How to write or change a Claude Code skill, slash command, hook, subagent or plugin so it triggers right and stays cheap. build a skill, skill won't trigger / сделай скилл, напиши плагин, перепиши скиллы, проверь скилл."
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

One mechanism for every case: build the general path that holds at the edge cases, and give a special case its
own rule only once it repeats (two or more chats or runs), with that evidence cited. A rule per incident grows the
tool and still misses the next case.

Shipped text names nobody's machine. A fact about one person (their language, paths, RAM, notify channels,
accounts, standing answers) goes in their profile, `<config dir>/makarasty/profile.md` (`CLAUDE_CONFIG_DIR`, else `~/.claude`), which makarasty-tools hands
to every main session when it exists (subagents get what their brief passes) [M67]; the tool says "the person's language" or "the machine facts in their
profile", not the fact. A tool that asks the person follows the asking rule that ships with makarasty-tools'
session text (`asking` in `tools/hooks/gates.ts`), not a copy of it.

## 3. Write the description as the trigger

It decides whether the tool is ever loaded, and it is paid in every chat. About 200-250 characters: one plain
sentence of what it does and when, then the words many people use for it, English then Russian (`commit this,
commit as me / закоммить, сделай коммит`), then `Not for ...` naming the neighbour that could take the same words.
Words anyone would say, not one person's phrases or typos: those raised the real-phrase score and lowered the
small-model router's, and a skill shipped to others must trigger for them. Shorter (about 110) lost 7 points,
names only lost 32 [M80]. In this repo the makarasty-tools skill router reads the descriptions for every prompt,
so a description is also its index. Check new text with `node "${CLAUDE_SKILL_DIR}/route.mjs"` (section 6).

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
- A tool that waits waits for a background task's completion notification, never a `sleep` loop or the same
  check repeated (each poll is a model turn), and sizes a kill-after limit to about twice the command's
  measured time, not a blanket 600 s. A tool that asks the person asks only what is theirs to decide
  (irreversible, production, money or data loss, a real fork); otherwise it takes the recommended option,
  says so in one line and keeps working [M52].

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
- **Triggering**: `node "${CLAUDE_SKILL_DIR}/route.mjs" <arms.json> <cases.json>` runs each request headless and
  reads which skill the model called first; `route-cases.json` beside it holds 271 phrases, near-miss negatives and
  regression cases for this repo's skills. Usage is in the script's header; about $0.07 a run on Sonnet.
- `claude plugin eval` for graded cases with tool-call checks. On native Windows only cases that grant no
  Bash or PowerShell run, and it needs `ANTHROPIC_API_KEY` set; suites that grant a shell need WSL2.
- `/skill-doctor` for the listing cost of every skill and the ones never used; `/doctor` for the rest.
- A cold read: one small agent reads only the tool and returns the questions it would still need answered.
  Answer them in the tool, not in chat.
- Code in the tool gets its own small test that fails when the code is wrong.

## 7. Attack it, then ship it

Run `/makarasty-tools:redteam` on the tool: false triggers and missed ones, token cost, destructive paths,
Windows, two chats running it at once. Then bump the version, add the changelog entry and run
`node "${CLAUDE_SKILL_DIR}/release.mjs"`. Installed from this checkout's marketplace, the plugins load in place from
the repo folder: an edit is live in every chat started after it (uncommitted ones too) and in a running chat once
`/reload-plugins` is typed in it, so release.mjs copies nothing and only reports. A copied install (another machine,
the GitHub marketplace) is updated by it, or by `claude plugin marketplace update <market>` and
`claude plugin update <plugin>@<market>`.

## When a new model ships

Re-run the A/B cases without the tool. A rule the bare model now follows is absorbed: delete it.
The owner's rules have one registry, `rules/registry.json` (where each rule is written, how it is enforced, the
complaint it answers); `node "${CLAUDE_SKILL_DIR}/rules.mjs"` checks each is in force in the installed copy and
counts his complaints per week, `--evals` re-runs every A/B with a blind judge and marks each rule pays, absorbed,
none, hurts or regressed. A new rule gets its registry entry, and an eval when text alone is meant to hold it.

## Done when

The failure is written down, the mechanism is the lightest that holds, the description triggers on the
person's words and not on a neighbour's, each rule was either measured or marked untested, and the
red-team findings are fixed or answered.

Status: this file's own rules come from Anthropic's skill and prompting guides and from the owner's
chats; the description routing was measured with `ab.mjs` [M50], the body rules were not.
