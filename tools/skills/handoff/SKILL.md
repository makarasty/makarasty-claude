---
description: "Hands this chat's unfinished work to a fresh chat, or takes over a named other chat's work. hand off, continue in a new chat / хенд-офф, передай другому чату, продолжи в новом чате. All chats at once: unfinished. Chats read only to commit: commit."
argument-hint: [what the next chat should focus on] | from "<chat title>" | from <session id> [what to do there]
---

`$ARGUMENTS` starting with `from` followed by a quoted title or a session id (`local_...` or a uuid) is the
receiving half, below. Anything else, including `from` followed by plain words, is the sending half, and
the words are what the next chat should focus on.

Paths: `~` and `${CLAUDE_CONFIG_DIR}` are shell syntax. The Read tool and a chip prompt need the resolved
native path, so get the handoff dir once with
`node -p "require('path').join(process.env.CLAUDE_CONFIG_DIR||require('os').homedir()+'/.claude','makarasty','handoff')"`
and write it as `C:/Users/<name>/.claude/makarasty/handoff` from then on. Below it is `<handoff dir>`.

## A fleet coordinator does not hand off, it relaunches

When this chat is a fleet run's coordinator (the run's `coordinator` file names this session, or this chat
armed `/makarasty:fleet-wait`), **do not write a handoff chip**. A chain of handoff chips re-reads the world at
every hop, loses what was only in context, and never moves the workers whose context is large. Use the
relaunch procedure in section 8b of `/makarasty:fleet-plan` instead: ask the operator once, then
`fleet.sh relaunch` (in the background, in two calls with `STATE.md` updated between them; call 1 exits 1 with "STATE.md NOT CURRENT" on purpose), which pauses the
run, hands back open work and prints one chip for a fresh coordinator and chips for fresh workers, all
offered together; when only workers are over their mark, "Replace workers NN only" keeps this chat as the coordinator. Read that section, and stop here. Only a chat that is not
coordinating a run, or an operator who explicitly asks for a handoff of a coordinator, takes the steps below.

## Sending

The next chat knows only the chip's prompt and the file: it must not need this chat's judgement to begin. It
runs on this chat's model and effort: `start_session` inherits both when `model` and `effort` are left out
(14 of 14 children checked, 2026-11-20), so a handoff never passes them unless the person named a model.

### 1. Settle what is running

Wait up to about two minutes for the agents and shells this chat started whose result the handoff needs,
for their completion notifications, not a sleep loop.
Stop only what this chat started and is not a server or a watcher, and ask before stopping an agent that
is still writing. The person's dev servers are theirs. What still runs goes into State with PID and owner.

An agent's report reaches only the chat that spawned it, and the next chat cannot read it from the
transcript (`list_events` shows tool calls as stubs). An agent still running after the wait: tell it with
`SendMessage` to write its report to `<handoff dir>/<name>/<agent>.md` and name that path in State, or
stop it and put its task in Next. Never offer the chip while a result the next chat needs is still due
here. Nothing writes to the handoff file after the chip is offered, background jobs included.

**A fleet watch is the exception: stop it.** When this chat is a fleet's coordinator and the operator
explicitly asked for a handoff anyway, its `fleet-wait` watch is a background task of this chat, and it shares `<run>/.watch-seen` with whatever watch the next chat arms.
Left running, the old one reports each event first and marks it seen, and the new chat never hears it.
Refresh `<run>/STATE.md` (step 4), then `TaskStop` the watch by its task id, then offer the chip. A chat
that cannot stop it (the task id is lost) says so in State, so the next chat knows events may be swallowed.

### 2. Find this chat's id

Load the session tools with ToolSearch `select:mcp__ccd_session_mgmt__get_session,mcp__ccd_session_mgmt__list_sessions,mcp__ccd_session_mgmt__list_events,mcp__ccd_session_mgmt__search_session_transcripts`.
`mcp__ccd_session_mgmt__get_session` with `"self"` gives the `local_...` id and the title. The transcript
is named by a different id, `CLAUDE_CODE_SESSION_ID`: record both. Resolve the transcript's absolute path
now and check that it exists:
`ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$CLAUDE_CODE_SESSION_ID".jsonl`.
Without the session tools, the uuid is the only id.

### 3. Snapshot the checkout

A chip opens in a fresh worktree, without this checkout's uncommitted and untracked files. Record
`git rev-parse HEAD` and the branch, then write every change, tracked and untracked, to a binary patch
without touching the real index:

```bash
p="<handoff dir>/<name>.patch"; i="${p%.patch}.index"; big="${p%.patch}.untracked-big.txt"; mkdir -p "$(dirname "$p")" &&
GIT_INDEX_FILE="$i" git read-tree HEAD && GIT_INDEX_FILE="$i" git add -A &&
git ls-files -z --others --exclude-standard | xargs -0 -r stat -c '%s %n' | awk '$1>1048576{sub(/^[0-9]+ /,"");print}' > "$big" &&
{ [ ! -s "$big" ] || tr '\n' '\0' < "$big" | GIT_INDEX_FILE="$i" xargs -0 git rm -q --cached --; } &&
GIT_INDEX_FILE="$i" git diff --cached --binary HEAD > "$p"; rm -f "$i"; [ -s "$p" ] || rm -f "$p"; [ -s "$big" ] || rm -f "$big"
```

`<name>` is the handoff file's name from step 4 without `.md`. The patch holds every uncommitted file in
the checkout, other chats' too, and not what `.gitignore` hides. Untracked files over 1 MB (screenshots,
photos, build output) stay out of it; their paths are in `<name>.untracked-big.txt`, which State cites.
A clean tree leaves no patch.

Staging is not kept in the patch, and in a shared checkout it is someone's: record
`git diff --cached --name-only` in State, each file with its owner, so the next chat does not commit
another chat's staged file with its own.

Anything the next chat needs from this session's scratchpad (screenshots the person sent, measuring
scripts, a drafted commit message or reply) dies with it. Copy those files to `<handoff dir>/<name>/`
and cite that path; short drafted text goes into the file itself, verbatim.

### 4. Write the file

`<handoff dir>/<yyyy-mm-dd>-<id6>-<slug>.md`, outside every repository; `<id6>` is the first 6 characters
of the session id after `local_`, so parallel chats never share a name. In English,
whatever language the chat was in: it is read by a model. That covers the file only: anything the next
chat says or asks the person stays in the person's language. Sections, each only when it has content:

- **Goal**: the person's request in their own words, quoted short, every part of it (a "review, red team,
  in a loop, finish it" keeps all four), then one line on what done means. Done is the person's bar, not a
  smaller one this chat would like: "доведи до конца" stays "until finished", not "committed locally, the
  rest to the owner". A chat that was compacted no longer holds the request: take it from the compaction
  summary and mark it "(from compaction summary)".
- **Done**: what changed, by commit hash or path, and how each piece was verified (the command, the
  result). Something not verified says so.
- **Next**: the remaining steps in order, each with its done-when. The first step is the one the next
  chat can start without asking anything. Items collected with /makarasty-tools:hold and not yet fixed
  go here, every one, numbered as the person gave them. So does every known defect or review finding left
  open, each with where it is: an open item not written here is lost. One is "report, do not fix" only
  when the person said so, quoted.
- **Decided**: what the person already ruled on, and ideas they rejected, so nobody asks again.
- **Traps**: what failed here and why, so it is not tried twice, with the exact working command next to the
  failing one (a server that starts only from its own folder, a flag a guard blocks). How a commit goes
  through in this project, when this chat learned it: hooks, guards, which tests the hook runs, what an
  agent may not do (`--no-verify`) and so must hand to the person.
- **State**: the absolute path of this checkout, the branch and HEAD sha from step 3, the patch path, the
  uncommitted and the staged files and whose they are (this chat's, another chat's, unknown), other live
  chats on the same checkout or branch by title, running processes, local URLs.
- **The person**: what this chat learned that their `CLAUDE.md` and memory do not already say. Read those
  first and leave out every line they cover (answer language and length, how to ask questions, "check
  before claiming" are usually there); the section is often empty. Worth a line: how they reacted
  here ("не понял" to an abstract question means give a concrete example), a codeword in play, what not
  to touch.
- **Open questions**: what only this chat could answer, if anything is still unclear.
- **Source**: this chat's title, its `local_...` id, its `CLAUDE_CODE_SESSION_ID`, and the transcript's
  absolute path from step 2.
- **Model**: this chat's model and effort as `get_session` "self" prints them; the next chat keeps them. A
  cheaper pick downgraded a relaunch the owner wanted on his model (2026-11-19, Stedi; owner, 2026-11-20).

The file must stand on its own: asking this chat later costs a turn at its full context and may stall.
Reference what already lives in a file (a spec, a plan, a findings list) by path; do not copy it. Aim
under 150 lines; the next chat reads the whole file before it does anything.

For a fleet coordinator, bring `<run>/STATE.md` up to date first and cite its path in Next and State: it
is the file that holds what a re-arm needs (below), and this file does not repeat it.

### 5. Check for secrets

Never a password, token, key or connection string, even one the person pasted: name where it lives. No
personal or customer data either - no names, contacts or records; describe the case instead. Before the
chip, grep the file and the patch's added lines:
`grep -niE 'key|token|secret|password|passwd|Bearer|://[^ ]*@|\?token='`. Read each hit; a real value in
the file is replaced by where it lives. A real value in the patch means delete the patch and say so in
State: the next chat then works only from the checkout path.

### 6. Offer the chip

To hand this chat's own unfinished task over, prefer `mcp__ccd_session__hand_off_to_session` (`title`,
`remaining_plan`): it moves the task to a new session forked from this conversation, so the receiver prompt
below is not needed. Keep `mcp__ccd_session__start_session` for a chip the receiver should start from the
handoff file (a fresh context, a fleet coordinator, `from <chat>`). A card you started and no longer want:
`mcp__ccd_session__dismiss_task`.

`mcp__ccd_session__start_session`, with `context` "fresh", `use_worktree` false (the prompt below moves
to the checkout itself), `initiation` "user_asked" on a turn the person's own message started and asked for
the handoff, else "own_initiative" (a card the person starts with a click; the app refuses a start on a
turn a watch event or another session started):

- `title`: the work as a verb phrase, under 60 characters.
- `background`: at least 80 characters, in the person's language: that it continues the chat "<title>", why
  now, what the new chat will do.
- `prompt`: the receiver prompt below, filled in, plus the focus from the arguments, if any. `<compact
  script>` is the absolute path of `${CLAUDE_SKILL_DIR}/compact-old.mjs`.

> Continue work handed off from the chat '<title>' (<id>). Read <handoff file> in full before anything
> else. Your first message after that read, before any other tool call, is a readback in at most five lines in the
> person's language: the goal, what is done and verified, what is unverified, the first step. Then compact
> the chat you came from, so its later wakes read a summary instead of its whole context (the owner's
> standing answer, 2026-11-20): `node <compact script> check <id>`. On `ok`: if it says pinned,
> `mcp__ccd_sidebar__set_pinned` <id> false (the app refuses to archive a pinned chat); then
> `mcp__ccd_session_mgmt__archive_session` with <id> and `session` set to the text after "archive session field:";
> then `node <compact script> run <id>`; then `mcp__ccd_session_mgmt__unarchive_session` with <id> and `session`
> set to the text after "unarchive session field:"; then, if you unpinned it, `set_pinned` <id> true. Without
> that `session` field the app's hook adds it and auto mode denies the call once: send it again with exactly the
> input it shows. On `skip`, a refusal or a failure: one line with its reason, and undo what you did (unarchive,
> pin again), go on. A `skip` that the CLI is signed out names the one command the person runs once. Never for any other chat. Then work.
> This session may have opened in a fresh worktree without the work. Load
> mcp__ccd_directory__change_directory with ToolSearch and move to <checkout path>; until this turn ends
> use absolute paths and `git -C <checkout path>`. If it is unavailable or refused, work here: when HEAD
> is not <sha>, run `git switch -C handoff/<slug> <sha>`; then, if <patch path> exists and
> `git apply --check <patch path>` passes, `git apply <patch path>`.
> If `git merge-base --is-ancestor <sha> HEAD` fails in the checkout (the branch was switched or
> rewritten), stop and ask the person. Start with the first Next step. If a fact is missing, look in
> <handoff dir>/<name>/ and grep the transcript <transcript path>; ask that chat with SendMessage (to:
> its id) only as a last resort, one precise question.

A session started this way, or by `hand_off_to_session`, stays linked: every turn it ends wakes this chat [M56]. The tools hook `detach.ts` detaches it at once and says so after the start result [M81]; without that line (hook off or older plugin), call `mcp__ccd_session_mgmt__detach_session` with its id yourself. If detach is refused (it shares this worktree; a chat started from a clicked card detaches fine), say your last line and call `mcp__ccd_session_mgmt__clear_session` with "self" as the last call.

When the next chat is to run a fleet (a coordinator relaunch builds its own chip, with its own prompt, and
never reaches this step), read `${CLAUDE_SKILL_DIR}/fleet-next.md` for what its first Next step is and which
Model line the chip carries; without a fleet, skip it.

Without `start_session` (the CLI), print that prompt in a fenced block for the person to paste into a new
chat started in the checkout, with the directory step dropped, the patch step kept, the transcript path
in place of the chat id, and the last sentence replaced by: "If a fact is missing, read that
transcript, or ask the person."

### 7. Reply and stop

Two lines in the person's language: the chip is up on this chat's model and effort, and that from now on the task is discussed in the new chat, not here. Then stop working on the task, so two chats never edit the same files. Do not archive this
chat yourself: after its readback the next chat archives it, compacts it with `compact-old.mjs` and
unarchives it (a running process keeps its history in memory, so only a stopped chat can be compacted).
Answer questions from the next chat briefly, from what this chat knows (after the compaction, from its
summary and transcript).

## Receiving: `from <chat>`

### 1. Find the chat

Load the session tools as in Sending, step 2. No chat named ("продолжи то, что не закрыто"): run `/makarasty-tools:unfinished` first and let the person pick from its list. A session id is used as given. A title: match it in
`mcp__ccd_session_mgmt__list_sessions` with `limit: 50` (`include_archived` when nothing matches), and
also run `mcp__ccd_session_mgmt__search_session_transcripts` with a distinctive phrase from it. More than
one candidate: ask, listing them. `get_session` on the match gives its working directory and branch; every
git check below runs with `git -C <that path>`, not in this session's cwd.

A chat that is still running, or was active in the last few minutes, is someone's live work: report its
state and ask before continuing it, so two chats do not edit the same files.

A handoff file in `<handoff dir>` naming it is read first; it saves reading the transcript. It may be
stale: compare its HEAD and time with `git -C <path> log`, and read the transcript after the file's time.
Work done after the file takes precedence.

### 2. Read only what answers three questions

What was asked, what was claimed done, what was next. A long chat takes many pages, so give the reading
to one `Agent` with `model: "sonnet"`, `effort: "high"`: it pages `mcp__ccd_session_mgmt__list_events` back with
`before_uuid` until the original request appears or a compaction summary does (in a compacted chat that
summary is the request: treat it as the goal), at most eight pages. It reads user turns and final answers
and returns only the three answers with the files and commits named. Without the session tools, the same
agent reads the transcript JSONL with a short `node` script that prints user prompts and the assistant's
final texts, stopping at the last `compact_boundary`.

### 3. Check the claims

A transcript saying "done" is a claim. Check the repository against it with `git -C <path>`: status, log,
the files it names, a narrow test. Name each claim you could not confirm.

### 4. Report, then continue

Three to five lines in the person's language: what that chat was doing, what is really finished, what is
left. Then carry on with what is left, in that chat's checkout by absolute paths (or move there with
`mcp__ccd_directory__change_directory`), unless the person asked only to read.

When a fact only that chat holds is missing and it is still open, ask it once with `SendMessage` (`to`:
its id), one precise question, as a last resort, and carry on with other parts while the answer comes.

## Done when

Sending: file and patch written, no real secret in them, chip offered or prompt printed. Receiving: the
person has the short state, each claim checked or marked unchecked, and the work continues.
