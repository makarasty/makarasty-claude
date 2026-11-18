# Telegram: the phone channel

The person's own bot (`/makarasty-tools:notify setup`) carries, both ways:

- **out**: a question a chat asked and nobody answered for 2 minutes (inbox on), with a button per option and
  "❔ Подробнее"; a finish he armed (`notify --arm`), silent; needs-you and errors, with sound; the inbox's answers to
  his messages.
- **in**: a tap (answers the item), a reply to a question (a free answer, or a question about it when it ends in "?"),
  and any plain text, which the inbox model does: answers, starts a chat, sends a desktop screenshot, a file, a
  picture, a video or a voice note (`notify.mjs file|screenshot`), adds a task to Obsidian. The only command is
  `/start` (what the bot does); `/status` is a debug view in no menu (owner, 2026-11-17: no commands, everything is
  text; the ideas list is gone, "create a task in Obsidian" replaces it).

Nothing else is sent: no per-edit or per-agent noise (owner, 2026-11-17). The owner picked the compact look B3:
the question first and bold, "project · kind · age" small under it. An answered message collapses to one grey line
"question — answer", kept rather than deleted so history scrolls back easily.

## Who does what

| Part | Where | Cost when idle |
|---|---|---|
| Poll, taps, replies, /start, /status, collapse | `tools/hooks/telegram.ts`, inside the hook engine (`$.http.fetch`), called from every chat's inbox timer | one HTTPS request per 15 s across all chats, no process |
| Ask message (text, buttons) | `tools/skills/inbox/core.mjs` `phoneAsk`, `phoneKeyboard`; sent by `notify.mjs ask` | only when an item is due |
| Finish, needs-you, error | `notify.mjs` hook mode (armed chats only) | none: no marker, no node |
| His free message | always `inbox.mjs telegram`: one headless `claude -p --model sonnet` turn of a session kept for a day, then a fresh one, so its context stays small ("typing…" on the phone while it runs; `INBOX_TG_MODEL` overrides the model). Never a prompt into the inbox chat or any other: until 1.19.71 it went into the inbox chat, a working Opus chat, a whole turn per message, and in two days into five different chats (2026-11-18) | only per message |
| Files, screenshot, typing | `notify.mjs file <path>` (photo, video, voice, audio, animation or document by extension, `--as` overrides; 50 MB), `notify.mjs screenshot` (every monitor, Windows), `notify.mjs typing` | only when the model calls them |
| "❔ Подробнее" | Haiku via `$.model.complete`, only on the tap | only per tap |

Files: `~/.claude/makarasty/notify.json` (token, chat), `~/.claude/makarasty/telegram/` (layout in the header of
`telegram.ts`). His taps and messages count as his word, like typing (owner, 2026-11-17): a `[Telegram]` prompt's
quoted lines are read by push-guard and the start consent, and nothing else in that prompt is.

## Edge cases

Network and Telegram
1. Network or Telegram down: no offset move; the next tick retries. Node-side sends keep their marker (flushUnsent).
2. 429: waits `retry_after` (engine up to 5 s, node up to 10 s), once.
3. HTML Telegram cannot parse: the same words once as plain text.
4. Over 4096: fields are cut as plain text before escaping; a long answer shows its head and folds the rest into an
   expandable quote, 3800 at most.
5. Editing a message over 48 h old, or deleted: the edit fails quietly; the ask still closes.
6. A late `answerCallbackQuery`: it is sent first, before any slow work, so the spinner stops at once.
7. Token revoked or bot blocked (401/403/404): the poller waits 10 minutes; no loop of failures.
8. Computer off over 23 h: one line says older messages were lost (Telegram keeps updates a day).
Restarts and concurrency
9. Two chats poll at once: `polled` is claimed ("<ms> <session>") and read back; only the writer polls.
10. The same batch twice, or a crash before the offset: `seen.json` (the last 300 update ids), written before effects.
11. A half-written offset: `offset.bak` beside it.
12. Messages that arrive while a headless run is busy wait in `inbound/`; the next round takes them as one prompt.
13. Whether an inbox chat runs does not matter: the headless inbox always answers.
14. The headless session is resumed for a day (`headless.json` `at`), then a new one starts.
15. A run that failed or timed out: a short "не получилось ответить".
16. Headless already running: a lock (8 min stale); a run takes what arrives meanwhile, up to three rounds; a 5 min
    timeout says so.
17. A plugin update moves `${CLAUDE_PLUGIN_ROOT}`: nothing on disk is keyed by it.
Environment
18. Each config dir is its own setup; one dir serves every account that shares it.
19. A second computer on the same bot steals updates from the first: run setup there with a new bot.
20. Inbox off: no timer, no poll. `/status` then goes unanswered until it is on.
21. `NOTIFY_TELEGRAM_API` (tests) is honoured only for 127.0.0.1/localhost: a repository's env cannot redirect the token.
Security
22. Only his private chat, from his account, not forwarded; anything else gets no answer at all.
23. Everything sent passes the secret-shape redaction; the explanation goes out only when he taps for it.
24. A tap is an index into the ask on disk; an unknown or closed ask answers "уже закрыто" and loses its buttons.
UX
25. Answered on the computer, gone, or past 12 h (inbox `STALE_MS`): collapsed with that reason.
26. A second tap on an answered ask: "уже закрыто".
27. Voice, sticker, a picture without a caption: "понимаю только текст"; a caption is read as text.
29. A dialog of several questions: one ask per question (`q`, `of` in the ask file); a tap or reply records its pick
    in `telegram/partial/<item>.json`, collapses that message, and the last one answers the item with the whole map.
30. The headless turn runs with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`: `claude -p` waits for its background tasks,
    so one started there held the answer and "typing…" until the kill (2026-11-18). Long work goes to a started chat.
31. A run busy with an earlier message: a new one gets a silent "in the queue" line; what is left after a run is taken
    by a new detached run at once.
32. A chat started for a Telegram message: the run writes his messages to `inbox/said.jsonl` with `via: telegram`
    (the inbox chat's capture does too), and `start`'s consent takes such a line with no start verb: a message to the
    bot is the ask. One message, one start, as for typed prompts.
33. Long work from the phone is a job, not a started app chat (that needs the inbox chat to drain the queue and send the
    brief): `inbox.mjs job` writes `inbox/jobs/<id>.json` and runs a detached `claude -p` in the folder (3 h cap, model
    and effort as asked); its final message goes to Telegram, a failure as one line. Once `-p` has ended (never before:
    two writers break a session) it opens in the app as a chat of the same name (`claude://resume`, the window flips
    back to the chat it showed); `inbox.mjs job-open <id>` does it for a job that ended without.
28. Until 1.19.63 `inbox.mjs telegram` sat after the item-id check and exited "needs an item id": no free message was
    ever answered with the inbox chat closed. The inbox selftest now runs it.
