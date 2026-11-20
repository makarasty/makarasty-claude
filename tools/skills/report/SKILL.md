---
description: "Explains a result, plan or decision to someone who saw none of the work: the story first, a picture or example where it helps, in chat or as an HTML page. make a report, explain it clearly / сделай отчёт, объясни понятно, сводка. Not screenshots (proof) or data exports (export)."
---

You hold all the context and the reader holds none: they saw no tool calls, files, agents or other chats, and they
switch in from other work. What reads as obvious to you reads as a riddle to them. The job is understanding,
not a summary: the reader finishes knowing what happened, why it matters to them and what to do, without
guessing. Long is fine when it explains; a short text that needs your hidden context is the failure.

## 1. Chat or file

- **Chat text** is the default for an answer in the conversation. Sections 2 and 4 apply there too.
- **A page** when the person asks for a file, report or page, or when the answer needs a picture chat cannot show,
  a table wider than chat, or will be reread on another day (a plan, an instruction to follow later).
- A standing rule like "files for me are HTML on my Desktop" says what a file looks like, not that every answer
  becomes a file.
- One topic is one file: the same subject the person asked about keeps its file name, and an update overwrites it.
  Never a new file per turn, never a file nobody asked for. The chat reply names the path and says why it is a page.

## 2. How to write it

Order:
1. **Title**: the news in one plain sentence, what a person would say aloud: «Stedi на проде: проверка страховки
   работает, поиск Medicare ID пока нет», not «Сводка по Stedi».
2. **Opening paragraph**: the whole story in 3–6 sentences for someone who knows nothing about it: what this is,
   what happened, what it means for the reader, what is needed from them («от тебя нужно только...» or «от тебя
   ничего не нужно»), and the one unknown that would change that, if there is one. A reader who stops here has
   the essentials.
3. **The picture**, near the top. Most results have something to show: what calls what and where it broke, a
   timeline, a before/after, numbers side by side, the real screen, the real message or error text. Show the thing
   instead of describing it. A picture that repeats a sentence, or numbers that compare nothing, is noise. In chat:
   a table, or a short arrow line in a code block (`LifeLines → Stedi → Medicare: ошибка 41`); when the picture is
   essential and chat cannot hold it, make the page.
4. **Explanation** in connected prose: why it happened, what each part means, with a concrete example for every
   abstract claim: the real error text, a real case, the real question a user typed, the exact number.
5. **Что от тебя нужно** (when something is): a numbered list, one action per item, each with how: the exact menu
   path in «quotes», the file path, or the command in a code block. A decision is its own `### N. Question?` heading
   with every option as a bullet: what it is, what changes if picked, «(рекомендую)» on yours and why; no
   recommendation you cannot back. Actions and questions share one count straight through (actions 1–2, then
   `### 3. Question?`), in chat too, so the person can answer «3 две, 4 свернуть».
6. **Подробности** (when there is more): the full steps of later actions (who, where, what to click, what to undo
   after), the rest of the facts, smaller risks. Plain headings lower on the page, never collapsed: the important
   part is on top and the reader scrolls down for the rest. A later action the person may answer about continues
   the numbering of the questions above it.
7. **Чем проверено**, always: what you checked yourself now (a command and its result, a file read, a page looked
   at), what you took from someone else's report, and what nobody checked. This is the one place for your process.

Complete, then short. Before writing, list every action (with who does it and how), decision, open question,
risk, way back and "not checked" flag in your facts; each one is on the page, on top or in Подробности, with its
exact steps and its flag. Shortening drops words, never one of these, and never turns "checked two of nine" into
"checked all" or adds a recommendation the facts do not make. Then cut words: the top part (title to «Что от тебя
нужно») reads in about a minute; Подробности are numbered steps, tables and one-line items, not paragraphs; a
sentence that only repeats, introduces or softens goes. A full page in long prose reads as "too much text".

Plain words:
- Every name, product, abbreviation, id or term on first use gets a plain explanation, in the same sentence or the
  next: «HETS-аттестация (подтверждение у подрядчика Medicare, что практика разрешает проверять её пациентов)».
  Terms you coined while working («флот», «раунд 42», «класс B», «судья») are replaced with what they are. Only
  names the person wrote themself need none.
- No pointers into context they never saw: «вариант B», «как нашёл агент 3», «как прошлое письмо», «другой чат»,
  a commit hash or file name as the reason for something. Say what it is instead.
- Prose for reasoning, lists for separate items and steps. A sentence over about 25 words or a paragraph over
  5 sentences usually hides two thoughts: split it. A long text gets headings that say what each part tells.
- Numbers come with what they count and compare to («4 из 13 вопросов не прошли ни разу»). A change is justified
  by its effect for the reader (measured: with method and sample; or a forecast, said so), never by its size
  in lines, files or tokens.
- Before asking the reader to act on history (a changelog, git log, another chat's report), look at the current
  state and say what you looked at.
- Never write that the reader did, sent or decided something without their words; never print a secret: to check
  a config, test that the key exists, never its value.
- Leave out what the reader will not use: the story of your process, ids nobody opens, the full list of done items
  when one sentence covers them, legends, badges, collapsed sections.

## 3. Build the page

Write `<name>.md` in your scratchpad or the system temp dir (never on the Desktop) with the Write tool, which saves
UTF-8 (PowerShell 5.1 `Set-Content` turns Cyrillic into `?`), then:
`node "${CLAUDE_SKILL_DIR}/report.mjs" <name>.md "<Desktop>/<Topic>.html"`
`<Topic>` is a short name of the subject that stays the same across updates («Stedi на проде»), not the title
sentence. Desktop: `[Environment]::GetFolderPath('Desktop')` on Windows, `~/Desktop` elsewhere. An `ERROR` writes no file:
fix the text and run again. A `NOTE` is advice. Never hand-write HTML or CSS; the look, both themes and phone
width are solved in the script. Markdown it reads, with pictures:

````
```flow
Broward, проверка | LifeLines -> Stedi -> Medicare (ok: покрытие активно)
Artisans, проверка | LifeLines -> Stedi -> Medicare (bad: ошибка 41)
= Где оборвался каждый запрос
```
````
`flow`: one row per line, an optional label before `|`, steps joined by `->`, a step may end with `(ok: note)`,
`(bad: note)` or `(wait: note)`; the last line `= caption`. Good for what calls what, where it broke, a timeline.

````
```bars
* Opus: 34 %
Sonnet: 61 %
= Доля ответов с ошибкой на 200 вопросах
```
````
`bars`: `label: number unit` per line (thousands with a space: `2 400`), `*` marks the one that matters,
`= what they count` is required; sizes only, signed numbers go in a table.
Also: tables (`| a | b |` with a `|---|` line) for side-by-side facts, `> ` for a warning or a way back,
```` ```svg ```` for a drawing nothing else fits (a `viewBox`, shapes and text only, `currentColor` for ink so it
reads in the dark theme),
`![caption](file.png)` for a real screenshot (embedded into the page). Example: `${CLAUDE_SKILL_DIR}/example.md`.

## 4. Blind reader (acceptance)

A page is done when a reader without your context understands it. Give one fresh agent (Sonnet) the `.md` path and
nothing about your work. If it needs to know who the reader is, give it a card written only from the person's own
messages and profile (their company, people, products), never from this work and never a term the page explains.
Ask, in the page's language:
1. Retell in 3–6 sentences what this is about and what happened.
2. What must you do now, step by step?
3. Which decisions are asked, and what changes with each option?
4. What is not checked or unknown?
5. Every word, name, number or sentence you did not understand or had to guess, quoted.
Compare 1–4 with what you meant. Fix every miss and every quote in 5 that the person would not know either
(explain, replace or cut), rebuild, and ask one new reader. Stop when 1–4 are right and 5 holds nothing the person
lacks, or after three readers; «Чем проверено» then says how many readers ran and what they still could not follow.
For chat text that carries a decision or more than a few facts, reread it as that reader before sending.
The reader cannot see what the page left out: when the page retells a longer source (another report, a plan, a
log), also give one agent the source and the page and ask for every action, decision, risk and flag the page
dropped, weakened or added; fix each one. Neither agent gets a secret, a key or a patient's data: hand them the
page and source with those removed.

## 5. Reply

The exact path of the page, why it is a page, and one line on what the reader needs to do.
