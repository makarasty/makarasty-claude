---
description: Quiet collecting mode - takes a stream of small bug reports or tasks without acting on any until the person says the codeword, then fixes them all in one pass, at the shared component and everywhere it is used. Use on "молчи, пока не скажу абрикос", "накидаю баги, потом скажу кодовое слово", "собирай задачи", "collect until I say". Pass the person's own codeword as the argument: "молчи пока не скажу апельсин" -> `апельсин`.
argument-hint: [codeword, default абрикос]
---

The codeword is `$ARGUMENTS`, or `абрикос` when empty. An argument that is a sentence ("молчи пока не
скажу апельсин") holds it as the word after "скажу" or "say", else its last word. The person is walking the app and dictating what is
wrong, one message at a time. Acting on the first item while they are still on the fifth costs them a
re-read and costs the fix the pattern the later items would have shown.

## While collecting

Reply to each message with one line and nothing else - a context-size reminder waits for the codeword
too: its number and the item restated in ten words or fewer, in the person's language, like
`3. двойной отступ в таблице заказов`. One message with several items gets several numbered lines.
Every tenth item, print the whole numbered list instead, so it survives a compacted context.

- No edits, no searches, no agents. A selected element or screenshot in the message: keep its selector or
  path in the restated line, do not open it yet.
- A direct question ("а это баг или так задумано?") gets a short answer, then collection continues.
- "убери пункт 3" removes it, "поменяй 3 на ..." replaces it; reply with the changed line.
- "стоп", "отмена", "хватит": ask once whether to drop the list or fix it now, and do what they answer.
- A handoff asked for mid-collection carries the full list and the codeword.

## The codeword

It counts when the message is the word alone or ends with it: any case, a case ending, trailing
punctuation (`Абрикос!`, `всё, абрикос`). Text before it is the last item, except filler like "всё",
"ну", "окей", "go". The word inside an item (`в поле
'абрикос' опечатка`) is an item; when it is unclear which was meant, ask. A near spelling (`абриком`) counts
only when it is the whole message.

## On the codeword

1. **List** every item once, numbered, duplicates merged. No items: say so in one line and stop.
2. **Group by cause**, not by screen. Items that share a component, a style token or a layout primitive
   are one group: the fix goes into the shared piece, then every place that uses it is checked. Fixing only
   the screen the person happened to look at is the correction they make most often.
3. **Reuse what the project has**. Find its own button, popup, table, skeleton and spacing primitives
   before writing any; no new global style overrides.
4. **Fan out** when groups touch disjoint files: one subagent per group with `model: "sonnet"`, each
   given its items, the shared piece and the done-when. Review every returned diff yourself before
   accepting it. Groups that share a file run in one agent, or here.
5. **Look**: before and after for each group, in every theme the app has. Screenshots are heavy, so the
   look goes to a `makarasty:fleet-scenario` agent with `model: "sonnet"` after `/makarasty:fleet-login`,
   and only its findings come back. Without a pane, a visual fix nobody looked at is reported as not checked.

## Report

One line per item, in the person's language: fixed, or not and why. Then what was not looked at.

## Done when

Every collected item is fixed or has its reason, every fix was made in the shared place with its users
checked, and the not-looked-at list is stated.
