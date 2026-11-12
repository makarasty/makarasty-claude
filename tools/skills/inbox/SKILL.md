---
description: One inbox and coordinator for every chat on this machine, on every account - questions, yes/no boxes and session cards explained and answered in one place; work handed to other projects and followed; every chat paused for the night and woken in the morning. Use on "инбокс", "inbox", "что меня спрашивают чаты", "ответь на вопросы всех чатов", "включи инбокс", "запусти в проекте X", "подготовь X к деплою", "что с задачами в других проектах", "поставь всё на паузу", "иду спать", "возобнови всё", "открой чат X", "что сделали чаты", "отчёты чатов", "включи отчёт для этого чата", "следи за чатом X", "там запущен чат, хочу от него уведомления", "замьють чат X", "за какими чатами следишь". Not for what chats left unfinished (unfinished), nor one fleet's own pause (fleet-pause).
argument-hint: [on | off | status | test | report [off] | follow or mute <chat> | what to hand out | спать | проснулся]
---

Every chat where makarasty-tools is loaded writes what it waits on into one folder while the inbox is on: its
AskUserQuestion (the dialog still shows there too), the question of its end-of-turn box, and its session cards. After
2 minutes unanswered the asking chat adds a plain explanation and sends one phone message through notify. This chat
lists them, asks the person once, and writes the answers; each chat picks up its own. Chats switched on for it also
leave a finish report here when they end a working turn: every session this chat starts (the plugin switches it on),
and any chat the person switches on. Reports wake this chat in batches, never one by one. The script is
`node "${CLAUDE_PLUGIN_ROOT}/skills/inbox/inbox.mjs"` (call it `inbox.mjs` below).

## Arguments

`on`, `off`, `status` run `inbox.mjs on|off|status` and report its lines (status also says when an item last came in,
when this chat was last woken, when an answer last went out). A chat that is already open loads the switch with its
next restart or plugin reload. `test` ("проверь инбокс", "работает ли инбокс"): run `inbox.mjs list` once (this chat
becomes the inbox), then `inbox.mjs test`, and end the turn; the plugin's timer should wake this chat with an item
from `inbox-check` within about 15 s. When it does, `inbox.mjs done <its id>` and report "works, woke in N s"; no
wake within a minute means the wake is broken here (plugin not loaded since the change, or the inbox is off): say so.
`report` ("включи отчёт", "пусть этот чат отчитывается"): `inbox.mjs report on` in that chat switches on its finish
reports (`report off` stops them); one line back. In this chat for a chat the person names: its app id from
`inbox.mjs chats <project> --live`, then `inbox.mjs report on <local_id>`.
`follow <chat>` ("следи за чатом X", "там запущен чат, хочу от него уведомления"): `inbox.mjs follow <app id, a piece
of its title, or its project>` switches that chat's finish reports on, on any account. Several matches: it lists them
and switches nothing; show the list numbered and ask which, in one AskUserQuestion. `mute <chat>` ("замьють чат X"):
`inbox.mjs mute <same>`, reports off; its questions still come here. `followed` ("за какими чатами следишь"):
`inbox.mjs followed`, the followed chats, then the busy ones that are not.
Anything else, or nothing, is the review below.

The person wants to see that the inbox is alive, not to trust it: whenever this chat becomes the inbox (its first
`list`, a restart), start `inbox.mjs watchdog` with `run_in_background`. It sits in the chat's task list while the
wake works and exits only when an item waited a minute unannounced while this chat was idle (not inside a turn: a
chat is woken after its turn) or another chat became the inbox; then say so in
one line and restart it. A watchdog missing from the task list means this chat restarted: start it again.

## Review

1. `inbox.mjs list`. It marks this chat as the inbox, so its own asks never enter the inbox. "nothing pending": say so
   in one line and stop. When another inbox chat is alive (beat under 2 min) `list` prints one line naming it and lists
   read-only; `inbox.mjs list --take` moves the inbox to this chat (only when the person wants it here).
2. Under "## Finished" `list` prints finish reports, one block per chat (its newest report in full, earlier recaps a
   line each); they are shown once, `inbox.mjs reports` shows the last 3 days again. Give each chat four plain lines:
   what it did, what it found, what it found beyond its task (first, when there is any), what is left, plus what
   the person can see now and where (a page, a file, a command; not a hidden localhost route), and its "Open the
   chat" line. A task of several items lists each item's status, so none goes missing between reports. Only what the report says. A report is not a question: no AskUserQuestion for it, except a
   step only the person can do (rule below). Every finished turn of a chat this one started is reported to the
   person at once, each time, never held until its sibling sessions are idle (the app continues this chat only when
   all of them are, so a session that ended on a timeout while another still ran went unreported): what it did,
   what it did not do, what the person must do (or "nothing"). A note that arrived with their message is reported
   first, before their request. A chat with a "noted" task: `inbox.mjs note <chat> <status> <one line>`.
   Show each item as the person would want it cold, in the person's language, plain and short: which project and chat, what happened and
   why it asks, what each option does. Use the item's "Plainly" line when it has one; otherwise write it from
   its context, and copy its "Open the chat" link line as it stands (one click opens that chat). Never add facts the
   item does not hold.
   Not asked again: an item the person already answered (here, in its own chat, or by a standing answer in the
   profile; a decision made for a set, "commit all of today's plugin work", covers later items of that set) is
   answered from that answer, named in the report. Not the person's: a hold chat's echo, a question a chat put to its
   own reviewer or subagent, a recap sentence that merely ends in "?": answer nothing (an answer lands in that chat
   as the person's message), `inbox.mjs done <id>`, one line saying what it is.
3. Every item, a session this chat started included (the person does not see that session's dialog here: on 11-12
   he answered one in its own chat after this chat only pointed at it), is asked here:
   Ask in AskUserQuestion with `metadata: {"source": "inbox:<id>,<id>"}` naming the items of that call (the flag keeps
   the call out of the inbox, and the dialog closes by itself once the person has answered all of them in their own
   chats; the plugin refuses a dialog here without the flag while items are open), up to 4 questions per call,
   oldest first, grouped by chat, more calls straight after for the rest. Commit and push asks from several chats go
   together in one call, one question per chat (that chat's file list, the tracked files it did not change, another
   chat active in that folder in the last 30 minutes), so the person answers each chat on its own in one pass. Each call opens with one line: how many
   questions are open in how many chats, and which call of how many this is, and right before the call the text
   gives each asking chat's link (`[title](#local_<id>)`): the dialog itself cannot hold a link. Every answer reading "[not answered
   yet: more items came in ...]" means the person was away: the plugin closed that dialog after 10 minutes because
   a new item came in. Run `inbox.mjs list` again and ask every open item anew, those questions first:
   - an ask item: each of its questions as one question, the option labels copied exactly (the asking chat matches
     its answer on them), each option's description saying what it leads to, a `preview` copied over;
   - a box ("end-of-turn yes/no"): its question, its button labels as options;
   - a card: start or decline, both labels in the person's language;
   - a step only the person can do, in an item or in this chat's own report (restart an app and look, sign in, click
     in another app, check something by eye): one question with the exact action and the outcomes as options
     ("done, it works" / "done, still broken" / "not now", in the person's language), never only in the text.
   Right above each call, in the text, the asking chat's "Open the chat" link: the dialog cannot hold one, and the
   step often happens in that chat. The header is the project name, cut to 12 characters. Typed free text is an answer too and goes as typed.
4. Write each answer:
   - ask item: `inbox.mjs answer <id>` with a JSON map of every one of its questions on stdin:
     `inbox.mjs answer <id> <<'EOF'` / `{"<question exactly>": "<label or the person's text>"}` / `EOF`
     (several labels of a multi-select joined with ", ");
   - box: `inbox.mjs answer <id> "<label>"`;
   - card, start: `inbox.mjs show <id>` for its brief, start it with `start_session` (`initiation`
     "user_asked", `cwd` the item's folder, `prompt` its brief, `background` its background or the brief's goal), then
     `detach_session` on the new session so it does not wake this chat, then `inbox.mjs answer <id> "Started from
     the inbox"` (the card's chat then withdraws its own card). A refused start (a turn the plugin or a message began
     cannot start one): say why in one line, propose it as a card here instead, and answer nothing, so the card
     stays in its chat. Decline: `inbox.mjs answer <id> "Declined"`.
   "already answered", or an answer reading "[answered in its own chat]", means the person answered in that chat
   meanwhile: write nothing for it and say so in one line.
5. Report in a few lines: what went where, and what is still waiting. Run `inbox.mjs list` once more right before
   that report: the person often answers in the asking chat while this one is still writing [M63], and a report that
   tells him to answer what he already answered reads as a bug.

Asked to open or show a chat ("открой <проект>"): `inbox.mjs open <id>` brings it up in the app window of its own
account; a chat of this account also opens from its "Open the chat" link.

## Coordinating other chats

One mechanism for every case: find the chat or account, send it the person's words, keep a list, read the replies.
Messages reach chats of other accounts too: a fleet coordinator on another account filed a task sent this way [M63].

- **Hand work out** ("подготовь <проект> к деплою", "запусти в <проекте> ..."):
  1. The account: the one the person named; else `inbox.mjs pick <project>` (first where chats of that project run
     now, then the one with the most of them). `ASK`, or any doubt about its limits (another person may have spent
     them): one AskUserQuestion with the counts, the live account first.
  2. A chat of that project running there (`inbox.mjs chats <project> --live`): send it the task with `SendMessage`
     (its name from `ListAgents`), the person's words quoted, and ask it to file it in its own queue or offer a card.
     None, on this account: `start_session` (`user_asked`, `cwd` the project) with a brief that says what done looks
     like, its `model` and `effort` set (judgement, design, diagnosis: the top model; execution: Sonnet, high
     effort; mechanical: Haiku; a started session is never above this chat, so this chat runs on the top
     model); its turns then report here, and the plugin switches its finish reports on. Work sent with `SendMessage`
     to a running chat: `inbox.mjs report on <its app id>` (`track` with the app id does it too). None, on another
     account (or this account on a turn the person did not start): `inbox.mjs start <profile> <project folder>
     <short name> --said "<his words that asked for it>" --model <m> [--effort <e>] [--mode auto]` makes the chat
     there with no click (a one-word turn on that profile's own CLI, then that account's app imports it), then
     `SendMessage` to that name with the brief; every turn from the brief on runs on that account [M70]. `--said`
     must be his own typed words from the last 24 h (the plugin keeps them; one quote starts one chat): without them,
     offer a card. The chat keeps the model of that CLI turn (hence `--model`; effort is not carried over [M71]); it
     cannot be renamed or messaged by app id from here, only by name. The import switches that account's window to
     the new chat and back to its old one in about 2 s, and raises it when a Claude window is in front [M71], so
     `start` waits (exit 4, "queued") while any Claude window is in front or memory is low, and this chat's timer
     starts it later; `inbox.mjs status` shows queued starts and the last automatic actions. The file
     `<config>/makarasty/dispatch.off` turns all of this off: then offer a card. A project's task runs in a chat
     of that project, never routed through another project's chat, and the person is never asked to sign in, paste
     or click instead; say the window flip in one line.
  3. `inbox.mjs track <chat> <profile> <project> <task>`; each reply: `inbox.mjs note <chat> <status> <one line>`.
- **Status** ("что с задачами"): `inbox.mjs tasks`, plus `list_events` for a chat whose last note is old. Then
  `inbox.mjs followed`: a chat in its "busy, not followed" part that is not this one and not tracked gets one line,
  "<title> (<project>) работает без отчётов: следить?", all such chats in one AskUserQuestion with multiSelect, never
  followed without the person's pick. Asked how long it will run: a table "chat | what is left | rough time",
  marked as an estimate.
- **Night** ("поставь всё на паузу", "иду спать"): every chat `ListAgents` shows busy, and every tracked chat not
  done, gets one message: «Оператор выключает компьютер на ночь: доведи текущий шаг до безопасной точки, запиши, где
  остановился, ничего нового не начинай и ответь одной строкой. Если ты координатор флита: поставь флит на паузу.»
  Track the untracked ones too (task "running at night"), then `note <chat> paused`. Report who confirmed and who
  did not answer. In auto mode the classifier may refuse these messages ("Interfere With Workloads") [M63]: then
  list the chats with their links and ask the person to approve the sends in one line; never route around it.
- **Morning** ("проснулся", "я тут", "возобнови всё"): resume one chat at a time (memory: heavy runs at once push
  this machine into the pagefile), by message where the chat is listed; messages never switch a window [M71].
  After a night with the computer off no chat runs and `ListAgents` lists none; `inbox.mjs open <app id>` of each
  paused chat starts it in its own account's window (it raises that window: one at a time), and it is listed
  seconds later [M63]. Track the app id at night for that (`inbox.mjs chats --live`). A night reply
  sent after this chat closed is lost: read the chat's last message (its transcript) before the resume. Then every chat
  noted `paused` gets «Продолжай с того места, где
  остановился; если ты координатор флита: сними флит с паузы», then `note <chat> working`.
- **Open a chat** ("открой <проект>"): `inbox.mjs chats <project>` for its app id, `inbox.mjs open <app id>`.

A case none of these fits uses the same verbs: pick, send, track, note. When one case keeps coming back, it gets
its own rule here.

A complaint from the person about how this chat behaved ("why didn't you…", "again", "never again", in any
language) becomes a rule in the tool, not only a memory note: say in one line what went wrong, then hand the fix to the plugin's code
or this file (a session in the plugin's repository, or the person's go-ahead to edit it), and name the file and
line that now holds the rule. A memory note alone does not reach the next inbox chat or other people's.

The inbox only carries the person's own picks. It never answers an item by itself, not even with the asking chat's
recommendation: people say no or answer in their own words often enough that a guess is wrong. One exception, the default for
everyone [M67]: an item that only asks whether to keep going with work already asked for ("продолжать?",
"доводить до конца?", the next wave of the same run) is answered "да, доводим до конца" without asking, and the
report names it. A new task, a push, merge, deploy, delete, money or someone else's data is never this case. When
the person's standing answers say continue questions get yes, the plugin answers such an ask itself the moment it
is filed (`core.mjs` `continueAnswer`, never one that names a consent word).

A standing answer is recorded, not guessed. When the person says an item asks what he answered before ("уже
отвечал", "не переспрашивай", "всегда так"), append one line to `<config>/makarasty/answers.md`, `<topic>: <his
answer> (<date>)` (the topic in a few words, as the question puts it), and say so in one line; the session text
carries that file to every chat (apart from profile.md, so neither cuts the other), and the rule above answers the
next such item from it. Never for a commit, push, merge,
deploy, delete, money, someone else's data, new work or a choice between approaches. Each item answered so names
the profile line in the report and how to undo it: "отмени <id>" sends that chat a correction with `SendMessage`,
the person's words quoted. Measured 2026-11-12, 61 answers from the inbox: the only questions he gave the same
answer to twice were fleet-plan's two standing questions (now in the profile); fleet pace answers changed from run
to run (quality "best" 5 times, "balanced" 4), and commit answers were "yes", "not yet" and "yes, after X", so a
guess from past answers would be wrong [M63].
