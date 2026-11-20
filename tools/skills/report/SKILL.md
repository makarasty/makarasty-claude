---
description: "Builds a summary or overview as one visual HTML file on the Desktop, items numbered and triaged. make a report, summary for me / сделай отчёт, сводка, отчёт в html, покажи визуально. Not before/after screenshots (proof)."
---

The reader scans in seconds and wants pictures before prose; the page labels are Russian. You write DATA (a JSON file);
`report.mjs` draws the page. Never hand-write the HTML or its CSS: the look, both themes, phone width and
contrast are already solved there.

## Steps

0. Never print a secret. To check a config that may hold a token or key, test that the file or key exists
   (`Test-Path`, `jq 'has("token")'`, a modified time); never output its values, not even to your own log.
1. Collect the facts. Every number, id, path and date comes from a source you read in this session. A thing
   you did not verify is said to be unverified in its text. Never write that the reader did or sent
   something unless they said so. A changelog or log tells the past, not the present: before an item asks the
   reader to do something, look at the current state (a file, a command, a status) and write what you looked at
   and when in `checked` (it is shown on the card). Never write «проверено» in `src`: it only names the source.
   If you cannot check, the title starts with «Проверить».
2. Cut the facts into items: one item = one thing someone does or decides. Item count follows the reader's
   priority, not how much you found: his main topics get the items, a topic he called minor gets ONE item with
   everything else about it in that item's `more`, and goes in `minor` (the build counts its mentions). Answer for each: who holds it
   (`owner`) and when it matters (`stop`). A shipped change is ONE done row; what the reader should know about
   it goes in that row's `more`. A card only when the reader must do or decide something; an info card only for what is
   not in done: a risk, a behaviour the reader will notice, a number they need.
3. Order: stops in time order (what needs the reader now first). Inside a stop, the reader's own items first.
4. Write `<name>.json` in your scratchpad or the system temp dir, never on the Desktop (schema below), then run
   `node "${CLAUDE_SKILL_DIR}/report.mjs" <name>.json "<Desktop>/<Title>.html"` (Desktop: `[Environment]::GetFolderPath('Desktop')`
   on Windows, `~/Desktop` elsewhere).
   Every `ERROR` stops the build and no file is written: fix the content and run again. Never rename or reword
   a title just to pass a check. If a check is plainly wrong for this report, set `"allowWarnings": true` and
   say which one in your reply.
   Before building, re-read every number and every "what switches what" against the source: a weak draft
   inverts numbers (30 instead of 139) and pins a switch to the wrong feature.
5. Cold read, for a report built from research or with more than 10 items: give one fresh agent (Sonnet) ONLY the
   JSON, nothing of your research, and ask for each item: what is this, why does it matter to the reader, what
   does he do, what changes with each answer. Rewrite every item it cannot answer or answers wrong, then build again.
6. Reply with the exact path and one line on what is inside.

## Write for a reader who was not there

The reader saw none of your research: no sources, agents, tabs or chats. Each card stands on its own.
- First use of a tool, product, service, command, skill, abbreviation or internal id on the page: say in plain
  words what it is, in parentheses: «context7 (сервис, который подсовывает модели свежую документацию библиотек)»,
  or «сервис документации (context7)». `known` lists only names the reader used himself (his messages, his
  profile), never one you met in research. A «quoted» button or menu label needs no explanation. Words you
  coined while working («повтор», «флот», «строка», «книга жалоб») are explained the same way.
- A title says the thing in plain words: no unexplained names, abbreviations, internal ids (task, rule, agent,
  source numbers) or code. «Чужое (Trail of Bits, context7): ставить или своё?» fails; «Взять чужие проверки
  кода или написать свои?» with the names explained in `text` passes.
- `text` says why it matters to the reader: what he gains, loses or risks (time, money, safety, comfort).
- A question to the reader (a `?` or a title starting «Решить», «Выбрать») has `answers`: each answer and
  what it changes, [["да", "ночью идут тесты, утром сводка"], ["нет", "всё как сейчас"]]. Never «Ответь да или нет» alone.
  Each question is its own item: never several questions packed into one card's `tags`.
- No pointers into context he never saw: «вариант B» or «случай A» without what it is, «как нашёл агент 3»,
  «первая волна», «из повтора», «источник [4]», «см. выше» (cards open from the overview, out of order).
  `src` names a source he can open or knows, never your working files (`12-verification.md`).
- One fact in one card; others name what follows from it. A set of reports from one research: each item lives
  in one report, the others say where it is. A minor topic never leads the page (headline, item 1).

## Writing an item

- `title`: what to do, starting with a verb or the thing's name, at most 60 characters. `text`: one or two short
  sentences, shown first in the card: an intro, never the conclusion. Long text goes to `more`.
- One visual per item: `steps` for an order of actions, `bars` for comparing numbers, `big` for one number
  that matters, `tags` for a set of ids or names, `figure` (own inline SVG/HTML, no `<script>`, no links) if none fits.
- `owner` holds the item; add others to `owners`. `who` only for a hand-off, 2 words ("Аня → ты"), never someone else.
- The reader's colour means "needs you". The reader's items need them unless the stop has `"info": true` or
  the item `"ask": false` (for facts and things they only should know). The `[[N]]` count in `headline` equals the
  items at the first stop that need the reader.
- An item that needs the reader says how: `steps`, `cmd`, `answers`, or a `how` line («Ответь номером: "2 забыть"»).
- `cmd`: a command or chat phrase the reader runs, exactly, with an absolute path; it gets a copy button. Find the path
  first; never pin a cache version that the next update removes. Step text then names it in a few words.
- A count in `text` or a step title equals what it counts ("3 шага" next to 3 steps). A `big` total equals its bars.
- `steps`: each `title` is one whole Russian phrase ("Деплой кода", not "Деплой" + "кода", not "Job"); ids and
  commands go in step `text`. `must` only on a step people skip at a cost, never on every step.
- `bars`: `barsNote` says what they count; `barsUnit` is a symbol ("KB", "$", "%", "мс") or three noun forms
  (["обход", "обхода", "обходов"]). Sort them (a time series: `"barsKeepOrder": true`); `hot: true` marks the one that matters.
- A change is never justified by its size (lines, files, KB, tokens). `effect` is optional: only where you
  propose or ship a change and its value to the reader is not already in the title or text, never on an info
  card. It has `text`, `basis`, `how`. "measured" = a number you or a named check produced, with the sample in
  `how`; a changelog claim or anything unchecked is "forecast". An item about cost itself: `"costIsGoal": true`.
- `warn` only for a real consequence. `more`: the text behind "Подробнее" (string or list; done rows too),
  at most 1200 characters, only what the reader can use: a file or folder name, not a full path, unless the reader must open it.
- `flag`: 1–4 words naming what is unverified («чаты не проверены») or your suggestion, at most 40 characters;
  the reason goes in `text`. The card says it once: a flag, not also the text.
- Stops are time. A milestone stop holds the event itself; category stops ("Риски", "Не проверено") go after the
  last time stop. A stop `note` never repeats the count or the stop name. `kind: "done"` only for finished work.
- Say the source once: `meta` or footer (not both) for one source, `src` on cards if they differ. `meta` is under
  80 characters and never repeats `project`; `headline` is under 100.
- Backticks around every command, path, file, ref, env var, id, hash and version, lowercase ids too (`vue-tsc`,
  `d5aecfa3d6`), `done` too; dates and counts plain. One style per tag list. `[[text]]` only in `headline`, `sub`.
- Typography: en dash in ranges ("6–9 KB"), decimal comma ("1,8"), "2 400" not "2400", "тыс." not "K",
  «около 40» or «примерно на 40» not "~40" (read it aloud: «на около» is wrong), × → − not x -> -. No HTML, no em dash, no emoji.

## Schema

```json
{
  "title": "Сводка проекта 10–17.11",           // browser tab name
  "project": "Atlas",
  "meta": "10–17.11 · 55 чатов · сверено 17.11 14:39",
  "headline": "Сейчас на тебе [[3 пункта]]. Деплой ведёт Аня.",   // the one sentence that matters
  "sub": "optional second line",
  "owners": { "you": "Ты", "anya": "Аня" },      // first is always the reader; colour and shape follow this order
  "known": ["Telegram", "API"],                  // names the reader uses himself: no explanation needed
  "minor": ["Spotify"],                          // topics he called minor: at most one item each
  "stops": [ { "id": "now", "name": "Сейчас", "note": "Нужен ты", "kind": "now" },
             { "id": "deploy", "name": "Деплой", "kind": "milestone" },
             { "id": "later", "name": "Без срока", "kind": "nodate" },
             { "id": "fyi", "name": "Для сведения", "info": true },
             { "id": "done", "name": "Готово", "kind": "done" } ],  // kind: now | milestone | nodate | done | none
  "items": [ { "stop": "now", "owner": "you", "who": "Аня → ты", "ask": true, "title": "...", "text": "...",
               "steps": [ { "title": "Колонки рассылок", "text": "джоба `add-automation-send-columns`", "must": true }, { "title": "Деплой кода", "main": true } ],
               "cmd": "node \"C:\\full\\path\\tool.mjs\" setup", "how": "Ответь номером: «1 да» или «1 нет».",
               "answers": [ ["да", "что изменится"], ["нет", "что изменится"] ],
               "bars": [ { "label": "main", "value": 1149, "hot": true } ], "barsNote": "what the bars count", "barsUnit": "KB",
               "big": { "value": "$36,6 тыс.", "note": "..." }, "figure": "<svg viewBox=...>...</svg>",
               "tags": [ ["SH-5", "аудио как рабочее время"] ], "warn": "...",
               "effect": { "text": "what changes for the reader", "basis": "measured", "how": "method, sample, who checked" },
               "more": [ "paragraph", "paragraph" ], "flag": "моё предложение", "src": "where it comes from",
               "checked": "what you looked at now, and when" } ],
  "done": [ { "date": "17.11", "text": "...", "more": "optional" } ],
  "footer": "..."
}
```

Example: `${CLAUDE_SKILL_DIR}/example.json`. Stops are yours to name: for a review use
"Блокеры / Исправить / Потом / Готово", for research "Вывод / Варианты / Риски".
Numbers run down the page in stop order. Write plain spaces: the page keeps numbers and ids together itself.
