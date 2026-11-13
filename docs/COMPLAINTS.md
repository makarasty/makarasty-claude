# Complaints library

Every rule here began as the operator's own words about how a chat behaved. Each row: his words (date, chat id
prefix), what went wrong, the rule, where it is enforced, and the test that holds it. "Code" means a hook refuses,
rewrites or answers; "text" means only a prompt says it. Counts and method: [M73]. When a complaint repeats, its
rule moves from text to code; add a row here with the test.

Hooks live in `tools/hooks/` (registered in `index.ts`), the inbox in `tools/skills/inbox/`, the session text in
`tools/hooks/gates.ts` (`economy`, `habits`, `asking`, `findings` plus the person's `profile.md` and `answers.md`).

## Enforced by code

| id | his words | what went wrong | rule | where | test |
|---|---|---|---|---|---|
| C01 | «я опять же не верю, что ты все починил» 08-14 8ed9f7e8; «Ты уверен, что эта миграция точно сработала» 09-20 20c04018 | "fixed / works" said with nothing run after the edit (~47) | The end-of-turn box that claims done after a code edit with no check run after it is refused once; a recap that says what is not checked passes | `verify-guard.ts` | `verify-guard.test.ts` |
| C02 | «Поставить хук, который блокирует git stash, reset --hard, clean и checkout -- .» 10-01 8521ce25 | another chat's uncommitted work erased | stash/reset/clean/checkout --/restore/add -A/commit -a and history rewrites refused in a shared tree | `git-guard.ts` | `git-guard.test.ts` |
| C03 | «Запретить себе обивать процессы по имени ... только строго по PID» 08-19 32443872 | killed his sandbox by name | kill by name, `/T`, `Stop-Process -Name` refused; by PID allowed | `kill-guard.ts` | `kill-guard.test.ts` |
| C04 | «Меня ужасно бесит, что все проекты убивают тестами мой компьютер» 10-16 42b9433e; «Твоя штука уже крутится два часа!» 10-19 | whole-suite runs stacked, no timeout | a heavy run while another is live, or in background with no kill-after, refused | `budget-guard.ts` | `budget-guard.test.ts` |
| C05 | «мне еще не нравится, что оно коммитит все в корень диска C» 09-08 e5e3d5e2 | a delete one bad path from the drive | deletes of a drive root, home, project, `.git`, temp root refused | `delete-guard.ts` | `delete-guard.test.ts` |
| C06 | «Да, продолжай все, не спрашивай.» 08-07 cab9c677; «Меня очень бесят такие вопросы» 11-11 | "continue?" asked about asked work | a continue-only dialog or box is refused; the inbox answers one from the standing «да» | `ask-guard.ts` `onlyContinue`; `inbox.ts` + `core.mjs` | `ask-guard.test.ts`, `inbox.test.ts` |
| C07 | «Что за тупые вопросы ... Никакие пароли не нужны» 11-12 3dc16175; «Базу данных можешь почитать сам» 08-13 0d3cf7ce | asked a password or to run what it could run, asked what it could find | a question asking a secret or a by-hand run is refused; every other question is screened once (`metadata.screened`) unless it holds a stake [M72] | `ask-guard.ts` `SELF`, `SCREEN` | `ask-guard.test.ts` |
| C08 | «дай команды чтоб я тупо в повершел вставил» 10-25 7d43892b | a command inside a dialog cannot be copied, `&&` fails in PowerShell 5.1 | a command in a question or option is refused; it goes above, `;` not `&&` | `ask-guard.ts` `COMMAND` | `ask-guard.test.ts` |
| C09 | «Написал, пожалуйста, исправь ... чтобы оно перед вопросом писало, где и что сделать» 11-12 8bed257b | "the chat above" he cannot find; a dialog pointing into another chat | a question pointing "above" with no link, or sending him into another chat, is refused; that step ends the turn with the chat's link and account | `ask-guard.ts` `ELSEWHERE`, `OTHER_CHAT` | `ask-guard.test.ts` |
| C10 | «каждый чат задаёт вопросы ... плохо объяснено» 11-11; «опять вопросы продублировались» 11-12 8bed257b | questions lost among 20-30 chats, duplicated, lost answers | one inbox: every dialog, box and card relayed, explained, answered once, re-asks merged, answers delivered between turns, dead dialogs answered as a prompt | `inbox.ts`, `inbox.mjs` | `inbox*.test.ts`, `inbox-selftest.mjs` |
| C11 | «так же чат у тебя там как будто завис» 08-19 050642f2; «основной чат почему-то не триггернулся» 08-26 c1fe4fbc | no word when a chat finished or stalled | each finish of an enrolled chat is a report to the inbox; one phone push per unanswered item | `inbox.ts` reports, `notify.mjs` | `inbox-reports.test.ts`, `notify-selftest.mjs` |
| C12 | «Ты почему не уследил, что у тебя чат ... под 900 тысяч контекста?» 10-07 71e2c499; «Да, все чаты» 11-12 | context left to rot; then the reminder said "do not hand off unasked" against his standing yes | at 700K a reminder; with a relaunch line in answers.md it says relaunch now with a handoff, no question | `gates.ts` `remind`, `standingRelaunch`; `inbox.mjs start --standing` | `gates.test.ts`, `inbox-selftest.mjs` |
| C13 | «Да, хук» 11-12 (block a push without his word); three pushes nobody asked for 11-10 | pushes with no request | `git push` runs only on his word in this turn: his typed «запушь», a yes to a push dialog or box, or the inbox delivering that yes; a brief, plugin text, paste or standing answer never | `push-guard.ts` | `push-guard.test.ts` |
| C14 | «Это выглядит как издевательство» 11-12 (plugin text read as his) | app reminders, plugin messages and pastes were stored as his words, the consent a chat start reads | said.jsonl keeps only what he typed around them | `inbox.ts` `ownWords` | `inbox.test.ts` |
| C15 | «Модели ставить тупые, это вообще неудобно» 10-05 9021aa63; «нельзя ни в коем случае терять качество» 08-24 c1fe4fbc | wrong model for the job | cheap tagged spawns routed, reviewer never; model and effort per stage in text | `router.ts`; text `economy`, `docs/MODELS.md` | `router.test.ts` |
| C16 | «не надо мне ... в промпты вписывать это оповещение» 11-11 | owner facts in shipped prompts | owner facts only in `profile.md`/`answers.md`, read when present | `gates.ts` `profile` | `gates.test.ts` |
| C18 | «чтобы я не сидел с микроскопом и не выявлял их» 11-10 5f5413b2 | fleet workers end with work held | a worker cannot stop holding a claim; long replies go to report files | `hooks/gate.ts` | `hooks/gate.test.ts` |

## Text only (no reliable code check yet)

| id | his words | rule | where |
|---|---|---|---|
| T01 | «простым языком на русском» 08-08 e01e0b19; «слишком длинно» 08-24 225b65c6 (~28) | plain, short, his language; what happened, why, what was done, what he must do | `profile.md` Language; `habits`; `unslop`, `explain` skills |
| T02 | «Мне кажется, ты не доделала работу» 09-10 d67358b8 (~13) | finish asked work; list what was skipped | `habits`, `asking` |
| T03 | «Твоя проблема, что ты строишь все юайки, от контекста» 10-20 24d97524 | UI checked by eye and a blind user, edge cases | `blindtest`, `antislop`, `proof` skills |
| T04 | «нужно запретить красной команде тейкать что-то про время» 10-16 42b9433e | effort or time is no reason to reject | `redteam` SKILL |
| T05 | «я не хочу, чтобы ты лез сейчас в работу других чатов» 08-17 b03c00e3 | own files only; name another chat's file | `habits`; `commit`/`ship` skills (git-guard holds the sweeps, C02) |
| T06 | «Какого фига ты решил, что у нас вообще есть CI» 08-31 cca42c91 | research the project before asserting; ask what is not findable | `habits`, `SCREEN` (C07) |
| T07 | «Мы работаем в пределах medium и high» 11-12 8bed257b | effort medium or high only | `profile.md` Effort; `economy` |
| T08 | «чтобы они не спамили: принял, принял» 10-12 0ac02e40 | workers report by file, three lines back | `docs/PROTOCOL.md`; SubagentStop limit (C18) |
| T09 | «хватит нажимать на правый шифт» 11-09 5f4a02f7 | no key presses on his desktop unasked | computer-use rules (outside this plugin) |
| T10 | «Сам всё обнови, сам всё закоммить, не надо меня спрашивать тупые вопросы» 11-11 97bee9eb | a local commit of own files is no question (push stays one, C13); a `Commit: ask` profile line brings the question back | `habits`; `commit` skill; inbox SKILL; no hook reads `Commit: ask` yet |
