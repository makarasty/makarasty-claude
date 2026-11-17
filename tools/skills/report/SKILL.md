---
description: Builds a report, summary or overview for the person as one visual HTML file on their Desktop - numbered items triaged by time and owner, a route map on top, details on demand. Use on "сделай отчёт", "сводка", "отчёт в html", "покажи визуально", "summary for me", or whenever a file is handed to the person to read.
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
2. Cut the facts into items: one item = one thing someone does or decides. Answer for each: who holds it
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
5. Reply with the exact path and one line on what is inside.

## Writing an item

- `title`: what to do, starting with a verb or the thing's name, at most 60 characters. `text`: one or two short
  sentences, shown first in the card: an intro, never the conclusion. Long text goes to `more`.
- One visual per item: `steps` for an order of actions, `bars` for comparing numbers, `big` for one number
  that matters, `tags` for a set of ids or names, `figure` (own inline SVG/HTML, no `<script>`, no links) if none fits.
- `owner` holds the item; add others to `owners`. `who` only for a hand-off, 2 words ("Аня → ты"), never someone else.
- The reader's colour means "needs you". The reader's items need them unless the stop has `"info": true` or
  the item `"ask": false` (for facts and things they only should know). The `[[N]]` count in `headline` equals the
  items at the first stop that need the reader.
- An item that needs the reader says how: `steps`, `cmd`, or a `how` line («Ответь номером: "2 забыть"»).
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
  only what the reader can use: a file or folder name, not a full path, unless the reader must open it.
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
  "stops": [ { "id": "now", "name": "Сейчас", "note": "Нужен ты", "kind": "now" },
             { "id": "deploy", "name": "Деплой", "kind": "milestone" },
             { "id": "later", "name": "Без срока", "kind": "nodate" },
             { "id": "fyi", "name": "Для сведения", "info": true },
             { "id": "done", "name": "Готово", "kind": "done" } ],  // kind: now | milestone | nodate | done | none
  "items": [ { "stop": "now", "owner": "you", "who": "Аня → ты", "ask": true, "title": "...", "text": "...",
               "steps": [ { "title": "Колонки рассылок", "text": "джоба `add-automation-send-columns`", "must": true }, { "title": "Деплой кода", "main": true } ],
               "cmd": "node \"C:\\full\\path\\tool.mjs\" setup", "how": "Ответь номером: «1 да» или «1 нет».",
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

Example: `${CLAUDE_SKILL_DIR}/example-summary.json`. Stops are yours to name: for a review use
"Блокеры / Исправить / Потом / Готово", for research "Вывод / Варианты / Риски".
Numbers run down the page in stop order. Write plain spaces: the page keeps numbers and ids together itself.
