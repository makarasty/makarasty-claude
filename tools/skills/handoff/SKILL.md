---
description: Hand this chat's unfinished work to a fresh chat, offered as a chip, with everything it needs and a way back to ask this one - or, with `from "<chat title>"` or `from <session id>`, take over another chat's work by reading its history. Use on "сделай хенд-офф", "передай другому чату", "предложи чипом", "продолжи в новом чате", "почитай историю того чата и продолжи", handoff, hand off.
argument-hint: [what the next chat should focus on] | from "<chat title>" | from <session id> [what to do there]
---

`$ARGUMENTS` starting with `from` followed by a quoted title or a session id (`local_...` or a uuid) is the
receiving half, below. Anything else, including `from` followed by plain words, is the sending half, and
the words are what the next chat should focus on.

Paths: `~` and `${CLAUDE_CONFIG_DIR}` are shell syntax. The Read tool and a chip prompt need the resolved
native path, so get the handoff dir once with
`node -p "require('path').join(process.env.CLAUDE_CONFIG_DIR||require('os').homedir()+'/.claude','makarasty','handoff')"`
and write it as `C:/Users/<name>/.claude/makarasty/handoff` from then on. Below it is `<handoff dir>`.

## Sending

The next chat knows only the chip's prompt and the file, on whichever model the person picks: it must not
need this chat's judgement to begin.

### 1. Settle what is running

Wait up to about two minutes for the agents and shells this chat started whose result the handoff needs.
Stop only what this chat started and is not a server or a watcher, and ask before stopping an agent that
is still writing. The person's dev servers are theirs. What still runs goes into State with PID and owner.

### 2. Find this chat's id

Load the session tools with ToolSearch `select:mcp__ccd_session_mgmt__get_session,mcp__ccd_session_mgmt__list_sessions,mcp__ccd_session_mgmt__list_events,mcp__ccd_session_mgmt__search_session_transcripts`.
`mcp__ccd_session_mgmt__get_session` with `"self"` gives the `local_...` id and the title. Without the
session tools, use `CLAUDE_CODE_SESSION_ID` and the transcript path
`<config dir>/projects/<cwd with every non-alphanumeric as ->/<id>.jsonl`.

### 3. Snapshot the checkout

A chip opens in a fresh worktree, without this checkout's uncommitted and untracked files. Record
`git rev-parse HEAD` and the branch, then write every change, tracked and untracked, to a binary patch
without touching the real index:

```bash
p="<handoff dir>/<name>.patch"; i="${p%.patch}.index"; mkdir -p "$(dirname "$p")" &&
GIT_INDEX_FILE="$i" git read-tree HEAD && GIT_INDEX_FILE="$i" git add -A \
  && GIT_INDEX_FILE="$i" git diff --cached --binary HEAD > "$p"; rm -f "$i"; [ -s "$p" ] || rm -f "$p"
```

`<name>` is the handoff file's name from step 4 without `.md`. The patch holds every uncommitted file in
the checkout, other chats' too, and not what `.gitignore` hides. Staging is not kept. A clean tree leaves
no patch.

### 4. Write the file

`<handoff dir>/<yyyy-mm-dd>-<id6>-<slug>.md`, outside every repository; `<id6>` is the first 6 characters
of the session id after `local_`, so parallel chats never share a name. In English,
whatever language the chat was in: it is read by a model. Sections, each only when it has content:

- **Goal**: the person's request in their own words, quoted short, then one line on what done means. A
  chat that was compacted no longer holds the request: take it from the compaction summary and mark it
  "(from compaction summary)".
- **Done**: what changed, by commit hash or path, and how each piece was verified (the command, the
  result). Something not verified says so.
- **Next**: the remaining steps in order, each with its done-when. The first step is the one the next
  chat can start without asking anything. Items collected with /makarasty-tools:hold and not yet fixed
  go here, every one, numbered as the person gave them.
- **Decided**: what the person already ruled on, and ideas they rejected, so nobody asks again.
- **Traps**: what failed here and why, so it is not tried twice.
- **State**: the absolute path of this checkout, the branch and HEAD sha from step 3, the patch path, the
  uncommitted files and whose they are (this chat's, another chat's, unknown), running processes, local URLs.
- **The person**: only what this chat learned and their `CLAUDE.md` and memory do not already say - how
  they want answers, a codeword in play, what not to touch.
- **Open questions**: what only this chat could answer, if anything is still unclear.
- **Source**: this chat's title and id, and its transcript path.
- **Model**: `sonnet` when Next is a written plan to carry out, `opus` when judgement is left, `fable`
  only for design.

The file must stand on its own: asking this chat later costs a turn at its full context and may stall.
Reference what already lives in a file (a spec, a plan, a findings list) by path; do not copy it. Aim
under 150 lines; the next chat reads the whole file before it does anything.

### 5. Check for secrets

Never a password, token, key or connection string, even one the person pasted: name where it lives. No
customer or customer data either - no names, contacts or records; describe the case instead. Before the
chip, grep the file and the patch's added lines:
`grep -niE 'key|token|secret|password|passwd|Bearer|://[^ ]*@|\?token='`. Read each hit; a real value in
the file is replaced by where it lives. A real value in the patch means delete the patch and say so in
State: the next chat then works only from the checkout path.

### 6. Offer the chip

`mcp__ccd_session__spawn_task`:

- `title`: the work as a verb phrase, under 60 characters.
- `tldr`: one or two sentences in the person's language: that it continues the chat "<title>", why now,
  what the new chat will do.
- `prompt`: the receiver prompt below, filled in, plus the focus from the arguments, if any.

> Continue work handed off from the chat '<title>' (<id>). Read <handoff file> in full before anything
> else. This session may have opened in a fresh worktree without the work. Load
> mcp__ccd_directory__change_directory with ToolSearch and move to <checkout path>; until this turn ends
> use absolute paths and `git -C <checkout path>`. If it is unavailable or refused, work here: when HEAD
> is not <sha>, run `git switch -C handoff/<slug> <sha>`; then, if <patch path> exists and
> `git apply --check <patch path>` passes, `git apply <patch path>`.
> If `git merge-base --is-ancestor <sha> HEAD` fails in the checkout (the branch was switched or
> rewritten), stop and ask the person. Before acting, reply in at most five lines in the person's
> language: the goal, the first step, and what is unverified. Then start with the first Next step. If a
> fact is missing, read that chat with mcp__ccd_session_mgmt__list_events; ask it with SendMessage (to:
> its id) only as a last resort, one precise question.

Without `spawn_task` (the CLI), print that prompt in a fenced block for the person to paste into a new
chat started in the checkout, with the directory step dropped, the patch step kept, the transcript path
in place of the chat id, and the last sentence replaced by: "If a fact is missing, read that
transcript, or ask the person."

### 7. Reply and stop

Two lines in the person's language: the chip is up, and which model to open it on, with the reason in a
few words. Then stop working on the task: two chats editing the same files is the failure this avoids. Do
not archive this chat; the person does that once the new chat has given its readback. Questions arriving
from the next chat are answered from what this chat knows, briefly.

## Receiving: `from <chat>`

### 1. Find the chat

Load the session tools as in Sending, step 2. A session id is used as given. A title: match it in
`mcp__ccd_session_mgmt__list_sessions` with `limit: 50` (`include_archived` when nothing matches), and
also run `mcp__ccd_session_mgmt__search_session_transcripts` with a distinctive phrase from it. More than
one candidate: ask, listing them. `get_session` on the match gives its working directory and branch; every
git check below runs with `git -C <that path>`, not in this session's cwd.

A chat that is still running, or was active in the last few minutes, is someone's live work: report its
state and ask before continuing it, or two chats edit the same files.

A handoff file in `<handoff dir>` naming it is read first; it saves reading the transcript. It may be
stale: compare its HEAD and time with `git -C <path> log`, and read the transcript after the file's time.
Work done after the file wins.

### 2. Read only what answers three questions

What was asked, what was claimed done, what was next. A long chat takes many pages, so give the reading
to one `Agent` with `model: "sonnet"`: it pages `mcp__ccd_session_mgmt__list_events` back with
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
