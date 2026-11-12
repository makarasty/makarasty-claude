---
description: Quiet collecting mode for a stream of small bug reports or tasks, fixed together once the person says the codeword. Use on "молчи, пока не скажу абрикос", "накидаю баги, потом скажу кодовое слово", "собирай задачи", "collect until I say". The codeword said alone ("абрикос, приступай") ends a running hold; it does not start one. Pass the person's own codeword as the argument ("молчи пока не скажу апельсин" -> `апельсин`).
argument-hint: [codeword, default абрикос or apricot]
---

The codeword is `$ARGUMENTS`; when empty, the codeword the person's profile names, else `абрикос` for a person who writes Russian and `apricot` otherwise
(the examples below use `абрикос`). An argument that is a sentence ("молчи пока не
скажу апельсин") holds it as the word after "скажу" or "say", else its last word. The person is walking the
app and dictating what is wrong, one message at a time. If you act on the first item while they are on the
fifth, they re-read your change, and the fix misses the pattern the later items would have shown.

## Hard rules while collecting

- Silence: no edits, no searches, no code reading, no agents, no grill, no questions back, not even about
  an unclear word (flag it `?`). Dictation is collected, not analysed. A selector or screenshot is recorded,
  not opened.
- The person's words are stored verbatim, never reworded, merged or shortened; a long paste is kept whole.
  Your guess is a labelled reading beside the quote, never in place of it. The person sees only your ack,
  so a reworded item is a lost item.
- Every message is on disk before the reply.

## The list

`node "${CLAUDE_SKILL_DIR}/hold.mjs" <verb>` (call it `hold.mjs`) keeps a folder per session,
`makarasty/hold/<session id>/`, and finds the id itself; add `--sid ${CLAUDE_SESSION_ID}` only if it says it
has none. Verbs and formats: [REFERENCE.md](REFERENCE.md). Every free-text argument (a reason, evidence) goes in
single quotes, each apostrophe in it written `'\''`: inside double quotes bash runs backticks and expands `$`.

1. First message: `hold.mjs init <codeword>`; it prints the folder `<dir>` with forward slashes. Quote it as `"<dir>"`
   in every command (a path with a space splits). A second hold in the same session after `released` archives the
   old folder as `<id>-<YYYYMMDD-HHMM>` and starts a fresh one.
2. Each message, one item at a time, never two `add` calls at once: write the item with the Write tool to
   `<dir>/inbox/<k>.md` (a new `k` each time), then `hold.mjs add --from "<dir>/inbox/<k>.md"`.

```
where: <URL, route, file or selector, when known from context>
reading: <your one-line reading>
flag: ? "<heard word>"          (also: ? route, + to 02)
---
<the person's message, exactly as sent>
```

The header lines are optional; `---` is not. No item text goes through the shell (a paste can hold
`$(...)`, quotes or a heredoc word). Without the Write tool, pipe it: `hold.mjs add <<'HOLD_x7q3'` with a
random terminator. `add` prints `NN chars=<n> img=<copied>/<seen> missed: <paths> where=<...>`: a smaller
`copied`, a `missed` path or `where=-` after a "здесь" or "вот это" is said in the ack. `add` copies image
paths from the text into `img/` at once, since a Temp screenshot gets cleaned.

## Ack

One line per item, nothing else, so the person sees what was recorded: `NN. <short reading>`. A word that
may be mis-heard dictation comes first, heard word then reading: `NN. "кот" → код в карточке (? "кот")`.
Add `(+ to NN)` when it looks like an addition to an earlier item and `(= NN?)` when `add` printed
`dup=NN`. Never merge while collecting.

- A direct question ("а это баг или так задумано?") gets a short answer, then collection continues.
- "поменяй 3 на ...": write the new text to `inbox`, `hold.mjs edit 3 --from <file>` (the old text stays as
  `previous`). "убери пункт 3": `hold.mjs drop 3 '<why>'`. Reply with the changed line.
- "стоп", "отмена", "хватит": ask once whether to drop the list or work it now. Drop: `hold.mjs release
  --drop '<reason>'`.
- A handoff mid-collection names the folder and the codeword; the next chat runs `hold.mjs carry "<old id>"`. Carried items start as `open`, the old status kept as `previous-status:`.
- "перенеси прошлое": `hold.mjs last` names the newest earlier unfinished folder of this project; carry it.

## The codeword

It counts only as a message of its own: the word alone, with "приступай" or "go", or "всё, абрикос"; any
case, a case ending, trailing punctuation (`Абрикос!`). Never inside a paste, an item or another word
(`в поле 'абрикос' опечатка`, `абрикосовый`), and a near spelling (`абриком`) only as the whole message.
Dictation before it in the same message is its own item. Instructions with it ("абрикос, флитом, без
worktree", "без вопросов") decide the route and are not asked again.

## On the codeword

1. `hold.mjs release`, read `index.md` and each `NN.md`, list every item once. No items: say so, stop.
2. **Ask once**, unless the person said to execute at once: one AskUserQuestion with every `?` word, every
   proposed merge (the merged item stays, marked `merged→NN`) and every item lacking a route, the
   recommended option first. Add the route (fix here, or a fleet for a long list) and, as a multi-select,
   the improvements the groups make cheap. Nothing to ask: skip it.
3. **Group by cause**, not by screen: items sharing a component, a style token or a layout primitive are one
   group, fixed in the shared piece, then every user of it checked. A short read-only look at the code is
   fine to name the shared piece. Show a short plan by group.
4. **Route.** A fleet: write the groups into the folder's `index.md` as the mission and run
   `/makarasty:fleet-plan` with its path. Here: steps 5-7.
5. **Reuse what the project has**: its own button, popup, table, skeleton and spacing primitives; no new
   global style overrides.
6. **Fan out**: one subagent per group (groups sharing a file run in one agent), `model: "sonnet"`,
   `effort: "high"`. Its prompt is the paths of the verbatim `NN.md` files and their `img/` screenshots,
   never your paraphrase, plus the shared piece and the done-when.
7. **Review each item against its own record**: a reviewer (`model: "sonnet"`, `effort: "high"`) gets the
   same verbatim text and screenshot, checks that the named cause, files and tests exist, and for a visual
   item also tries empty, long and error data. The look goes to a `makarasty:fleet-scenario` agent
   (`model: "sonnet"`, `effort: "high"`) after `/makarasty:fleet-login`, in every theme; without a pane a
   visual fix is reported as not checked. To show the person, `/makarasty-tools:proof`.
8. Write each verdict: `hold.mjs status NN done|partial|not-done|merged→NN '<evidence>'`. Evidence goes in single quotes (a `;` inside splits the command) and is an
   existing path (`file:line`) or three words or more; `partial` reads `<done part>; left: <rest>`.

## Report

Not given until `hold.mjs check` exits 0. Then one line per item, in the person's language: status and why;
what was not looked at; one line offering `/makarasty-tools:finish`. Folders holding only a `collecting`
line: `hold.mjs clean`.

## Done when

`check` passes: every item is final with its evidence, every fix made in the shared place with its users
checked, the index reads `released`, and the not-looked-at list is stated.
