---
description: Turn what you mean into simple English a person can say on a call with, or send to, a vendor, a partner or their support, with the gist in the person's own language beside it. Use to prepare a call script or meeting questions, to phrase one reply on a live call, or to write a support ticket or email to a vendor. Also on "подготовь вопросы для звонка", "напиши им простым языком", "как сказать это на звонке", "что ответить вендору", "напиши в саппорт", "составь тикет". Not for plain translation or for rewriting prose (that is /makarasty-tools:unslop).
argument-hint: <what you want to say, in any language, what the vendor just said, or a file with the points>
---

Write lines a person will read aloud, or paste, to someone across a company boundary: a vendor, a
partner, their support desk. The speaker is good at technology and not at conversation, and English is
not their first language. Every line has to be sayable, or readable, at first sight.

The gist is always in the person's main language, the one they usually write to you in, even when this
request came in English. Only when that language is English is there no gist.

## Pick the mode

**Live reply** - they are on the call now: a short "how do I say this", or the vendor's own English pasted
in. One to three English lines first, then the gist in one line. Nothing else: no heading, no notes, no
table. When the input is what the vendor said, give its gist in one line, then two reply options, each one
or two English lines with its gist.

**Call script** - preparing a call or a meeting. The shape and every rule below.

**Written** - a support ticket, an email, a chat message. Digits stay digits. Ids, codes, field names,
HTTP statuses and timestamps stay exactly as they appear, ids and field names in code spans. Facts first,
in this order: environment (sandbox or production), time with its time zone, request id, what we sent,
what we expected, what we got. Then one question, in the same ask-how-it-should-work voice as a call.
Plain short paragraphs. The gist goes above the text, never inside it.

When two modes fit: on a call right now, by voice or in the call's own chat, is Live reply. Anything sent
and read later, an email, a ticket, a Slack thread, is Written, even when it answers a pasted vendor email.

## The call script

One line, one sentence, in every spoken line. A blank line where the speaker pauses. Each point opens with
its gist, one or two sentences, so the speaker knows what the point is; then the English to say. The points
go in speaking order, the most urgent first, the tempo falling in blocks. At the end, an answer sheet with a
row per question: what they said, who said it, by when in writing.

The script opens with these lines, so the speaker has them before they are needed:

```
"Hi, thank you for your time. English is not my first language, so I may ask you to repeat."
"Could you speak a bit slower, please?"
"Could you repeat that, please?"
"Let me check I understood: <what they said>. Is that right?"
"Could you spell that, please?"
"Thank you, this helps. Could you send a short summary by email?"
```

A point that reports a problem takes three steps, and only these:

1. **What we do.** "For a priority customer we send a rate check with carrier code <carrier code>."
2. **What we get.**
   "The answer names the plan as text."
   "It never has a code for that plan."
3. **One question, then wait.**
   "How should we get that code?"
   *(stop - their turn)*

The sharper follow-ups wait under "If the answer is vague", and go one at a time, each after an answer.

## The rules

**We do not propose. We ask how it is meant to work.** Not "please add the field": the person on the line
cannot add a field, and asking them to is how a call ends with nothing. "How should we handle this? What do
your other customers do here?" is a question a support desk can answer.

**Leave them the exit.** Close a hard question with "Maybe we send it wrong, or read the wrong field. Please
tell me." People answer that. They defend against an accusation.

**Ask, then stop.** After the line with the question, the next line is theirs. One question per step. No
new fact until they have answered.

**Plain words.** The speaker stopped on `verbatim`, `canonical`, `envelope`, `machine-readable`. Say what
the word means: "we save every answer exactly as it comes". Say, get, send, wrong, works - never state,
receive, transmit, incorrect, functions. If the speaker would look a word up, it is the wrong word.

**Every answer in writing.** After an oral answer: "Can you send that to me in writing?" A month later the
oral answer does not exist.

**Argue only with their own identifiers.** A request number, a ticket number, a field name from their own
document. Never "it does not work"; "here is the request number, please look at it on your side".

**Money stays off unless they raise it.** Then listen, write it down, and name no figure of ours.

## Saying numbers and names (spoken lines only; written mode keeps them as they are)

| What | Written | Said |
|---|---|---|
| HTTP status | 404, 500 | "four oh four", "five hundred" |
| short error number | error 72 | "error seventy two" |
| code or id with leading zeros, or longer than three digits | 00112, 273143568 | digit by digit, "zero" not "oh", long ones in threes: "two seven three - one four three - five six eight" |
| hex id, UUID | 9f3a...c41d | "starts nine F three A, ends C four one D"; paste the whole one in the chat |
| field name | order_id, orderId | "order underscore I D", "order I D in camel case"; paste it in the chat |
| version | v2.3.1 | "version two point three point one" |
| percent, decimal | 12.5% | "twelve point five percent" |
| year | 2026 | "twenty twenty six" |
| time | 14:30 ET | "two thirty p m, Eastern time" - always with the zone |
| date | 2026-08-01 | "August first" |
| rounded count | 803 | "about eight hundred", exact figure in the gist |

Add rows for any number the speaker may need that is not in the text.

## What each point also carries

- **If the answer is vague**: two or three sharper follow-ups, still questions, asked one at a time. "What
  do your other customers do here?" "Can you look at this one on your side? I will give you the request
  number."
- **How I will check the answer**: what in our own data confirms or refutes it, so the speaker recognises
  a good answer when they hear one.
- **Traps**: the sentence the speaker must not say because our own evidence contradicts it, and the
  figure that was never measured. In the gist language, with the reason.

## What to keep exactly

Numbers, codes, field names, request ids, dates, and every negation. Simplifying the English never changes
a fact. A number rounded for speech says so ("about eight hundred") and the exact one stays in the gist
beside it. Never invent an id, code, count, date or name: if the person did not give it, ask, or leave a
placeholder like `<request id>`.

## Before replying

Spoken lines: a digit becomes words by the table; a line with two sentences becomes two lines; a line with
two questions keeps the first; a word from the plain-words rule gets its plain form. Written text: every
id, number and field name matches the source character for character.

## Done when

A person reading only the English lines aloud, one per breath, sounds like someone asking how to do it
right and not like someone filing a complaint; every number in a spoken line is a word; no line holds a
word the speaker would have to look up; and nothing in the text is a fact the person did not give.
