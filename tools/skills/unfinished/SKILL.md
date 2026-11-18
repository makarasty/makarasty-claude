---
description: "Reads this project's recent chats and reports what each left open: unfinished work, uncommitted files, waiting questions. open tasks across chats / что не закрыто, что осталось в других чатах. Not passing work on (handoff), not chats read to commit (commit)."
argument-hint: [days, default 7] [project path, default this one]
---

The person has many chats open or finished over the last days and has lost track of what is still
undone. A script reads the transcripts, which are too large to read here, and prints a short card per chat.
You judge the cards. The script sorts nothing into "done" or "open": that needs the repository and
reading the text.

## 1. Run the script

```bash
node "${CLAUDE_SKILL_DIR}/chats.mjs" --cwd "<project path>" --self ${CLAUDE_SESSION_ID} [--days N] [--limit N] [--all]
```

`<project path>` is this chat's working directory unless the person named another project. Days come
from `$ARGUMENTS` or the person's words; 7 otherwise. `--self` leaves this chat out. Worktree chats of
the project are included. `--json` gives the same data for a script of your own.

A card holds: title (and the Desktop account), age of the last message, first and last asks, the last
assistant reply and whether it ends with a question, files edited inside the project and which of them
are still uncommitted, unfinished todos, counts of `git commit` and `git push`, a handoff mark, and clone
ids (the same chat copied; only the newest is shown, with the files of all copies). A chat that forked from
another (same start, different prompts) is its own card, marked `fork of <id8>`. Pasted secrets are masked as
`‹masked›`; never ask for them back. The header says `showing N of M` when `--limit` cut the list: raise it
or say so. Uncommitted files are looked up in the repository that owns each file, so a `.claude/worktrees/`
edit counts.

The person's earlier answers live in a ledger, `~/.claude/makarasty/unfinished/<project folder name>.md`, one line per chat:
`- <id8> | <verdict> | <YYYY-MM-DD> | <why>`, verdict `closed`, `abandoned`, `skip`, `later:<date>` or `handed:<chat>`. The script hides a
chat with a line unless it has a newer message (then its card says `settled earlier: <verdict> <date>`); `later:<date>` hides until
that date. The header counts the hidden ones; `--all` shows them. Never ask again about a chat the ledger settled.

## 2. Decide per chat

Pick one: **closed**, **open**, **waiting on the person**, **abandoned**.

- A "done" in the last reply is a claim. Check it cheaply against the repo: `git log --oneline -n 15`,
  `git status --short`, a look at the one file it names. A transcript is not evidence that the work landed.
- A "waiting" item that rests on state outside the repo (a file on the Desktop, a remote branch, a message
  sent, a vendor's reply, "the owner did X") is a claim too: check it (`Test-Path`, `git ls-remote origin <branch>`
  after `git fetch --prune`) or mark it "из чата, не проверено". An intent the chat wrote as a past fact
  ("отправляем" as "sent") is reported as an intent.
- Before asking the person anything, check it yourself: git, `Test-Path`, the chat's transcript, the other chat's last reply.
  Only what no check answers becomes a question.
- Open findings files are open items: the project's `docs/FINDINGS-OPEN.md` and
  `~/.claude/makarasty/findings/<project>.md`. List their lines under open work.
- A chat that is **live** (marked LIVE) is someone's work in progress: report it and leave its files alone,
  so two chats do not edit the same file.
- Uncommitted files are listed per chat, but the working tree is shared, so a file may have been
  changed since. Look at `git diff --stat` before calling it that chat's.
- Need a detail the card lacks? Grep the one transcript (`~/.claude/projects/<slug>/<id>.jsonl`) for a
  phrase. Reading one whole costs more than the answer is worth.
- Old, no todos, no uncommitted files, last reply a conclusion: closed. Say so in one line, not a card.
  Never use this shortcut when the card says `NOT CHECKED` (the worktree of an edited file is gone, or it is
  not a repo) or `partly read` (an assistant line over 2 MB was read only at its ends, so edits and todos in
  it can be missing): the edited files could not all be checked, so look at the repo or the transcript, or
  report the chat as unchecked.

## 3. Report

In the person's language, short, grouped, each item with the chat title and the first 8 characters of its id:

1. **Open work**, with the next step for each.
2. **Done but uncommitted**, with the files.
3. **Waiting on the person**, the question as the chat asked it.
4. **Live now**, hands off.

Closed and abandoned chats go in one line each at the end, or a count. Nothing is left out silently: the
count of chats read is stated.

Then one `AskUserQuestion`: continue one of them here (`/makarasty-tools:handoff from "<title>"`),
collect the open items into a hold list (`/makarasty-tools:hold`), hand them to a fleet, or nothing.
Start none of them before the answer.

## 4. Record the answers

When the person answers, append to the ledger one line per chat they settled, their words quoted and today's date
(`- 4f2a91bc | skip | 2026-11-18 | not ours. Owner: «пропускаем»`). A findings-file item they skipped is marked there
`SKIPPED <date> (owner: «...»)` instead of staying open. Chats you classified closed or abandoned get a line too, with the check as the why.

## Done when

Every chat the script listed is classified, each "done" and each outside-state "waiting" was checked or marked unchecked,
and the person got the grouped report plus the one question; their answers are in the ledger.
