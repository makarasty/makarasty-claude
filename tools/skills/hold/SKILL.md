---
description: Quiet collecting mode for a stream of small bug reports or tasks, fixed together once the person says the codeword. Use on "молчи, пока не скажу абрикос", "накидаю баги, потом скажу кодовое слово", "собирай задачи", "collect until I say". The codeword said alone ("абрикос, приступай") ends a running hold; it does not start one. Pass the person's own codeword as the argument ("молчи пока не скажу апельсин" -> `апельсин`).
argument-hint: [codeword, default абрикос]
---

The codeword is `$ARGUMENTS`, or `абрикос` when empty. An argument that is a sentence ("молчи пока не
скажу апельсин") holds it as the word after "скажу" or "say", else its last word. The person is walking the app and dictating what is
wrong, one message at a time. If you act on the first item while they are on the fifth, they have to
re-read your change, and the fix misses the pattern the later items would have shown.

## The list file

The list lives on disk, so a compaction, a handoff or a crash loses nothing. Its first line is
`collecting <codeword>` while collecting and `released <codeword>` after the codeword; the handoff reminder
stays quiet while it reads `collecting`. Then one line per item, `N. <item>`, with any selector, path or
screenshot reference the message carried. The file is the list: an edit or a removal is made in it first.

Write it with Bash only (PowerShell 5.1 adds a byte-order mark or loses Cyrillic), and put the item text
in a quoted heredoc, never in `echo` or `printf`: a pasted selector can hold `$(...)`, backticks or quotes
that the shell would run or eat. Before each reply:

```bash
d="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/makarasty/hold"; mkdir -p "$d"
cat >> "$d/${CLAUDE_SESSION_ID}.md" <<'HOLD'
3. двойной отступ в таблице заказов (div.orders > table)
HOLD
```

The first message of a new hold writes the file fresh (`cat >`) with the `collecting` line first. A
resumed hold appends. A chat that was cloned or forked has a new session id: when this id has no file but
the list started earlier, copy the earlier file to this id's name. A write that fails is said in the reply
line, and the list then lives in the replies.

## While collecting

Reply to each message with one line and nothing else: its number and the item restated in ten words or
fewer, in the person's language, like `3. двойной отступ в таблице заказов`. One message with several
items gets several numbered lines.

- No edits to the project, no searches, no agents, no grill and no questions back. A selected element or
  screenshot: keep its selector or path in the item, do not open it yet.
- A direct question ("а это баг или так задумано?") gets a short answer, then collection continues.
- "убери пункт 3" removes it, "поменяй 3 на ..." replaces it; reply with the changed line.
- "стоп", "отмена", "хватит": ask once whether to drop the list or work it now, and do what they answer;
  a dropped list's first line becomes `released`.
- A handoff asked for mid-collection names the list file and the codeword; the next chat keeps appending.

## The codeword

It counts when the message is the word alone or ends with it: any case, a case ending, trailing
punctuation (`Абрикос!`, `всё, абрикос`). Text before it is the last item, except filler like "всё",
"ну", "окей", "go". The word inside an item (`в поле 'абрикос' опечатка`) is an item; when it is unclear
which was meant, ask. A near spelling (`абриком`) counts only when it is the whole message. Instructions
that come with the codeword ("абрикос, флитом, без worktree") decide the route and are not asked again.

## On the codeword

1. **Read the file**, set its first line to `released <codeword>` (`sed -i '1s/^collecting/released/'`
   on it), and list every item once, numbered,
   duplicates merged. No items: say so in one line and stop.
2. **Group by cause**, not by screen. Items that share a component, a style token or a layout primitive
   are one group: the fix goes into the shared piece, then every place that uses it is checked. Fixing only
   the screen the person happened to look at is the correction they have to make most often. A short
   read-only look at the code is fine here, to name each group's shared piece.
3. **Ask once**: one AskUserQuestion, at most four questions, each with the recommended option first.
   Ask only what changes the work: an item you cannot read two ways apart, two items that contradict, the
   route when they did not name one (fix here, or a fleet in this chat for a long list), and a
   multi-select of improvements the groups make cheap now (the same fix in the places nobody mentioned, a
   shared component replacing copies, a missing state such as empty or loading). Nothing to ask: skip it.
4. **Route.** Fix here: steps 5-7. A fleet: write the groups as the mission into the list file and run
   `/makarasty:fleet-plan` with its path; the file is the mission, and fleet-plan asks its own pace
   questions. Pass along what the person already said ("без worktree", "в этом чате") so it is not asked.
5. **Reuse what the project has**. Find its own button, popup, table, skeleton and spacing primitives
   before writing any; no new global style overrides.
6. **Fan out** when groups touch disjoint files: one subagent per group with `model: "sonnet"`, each
   given its items, the shared piece and the done-when. Review every returned diff yourself before
   accepting it. Groups that share a file run in one agent, or here.
7. **Look**: before and after for each group, in every theme the app has. Screenshots are heavy, so the
   look goes to a `makarasty:fleet-scenario` agent with `model: "sonnet"` after `/makarasty:fleet-login`,
   and only its findings come back. Without a pane, a visual fix nobody looked at is reported as not checked.
   When the person wants to see it ("покажи скриншотами", "как было, как стало"), record each group with
   `/makarasty-tools:proof`: the before shot goes before the edit, and the report numbers the blocks.

## Report

One line per item, in the person's language: fixed, or not and why. Then what was not looked at, and one line offering `/makarasty-tools:finish` for the fixed files. Write
the same status after each item in the file.

## Done when

Every collected item is fixed, handed to a fleet, or has its reason; every fix was made in the shared
place with its users checked; the file reads `released`; and the not-looked-at list is stated.
