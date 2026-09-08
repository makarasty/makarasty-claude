# Call: the facts first, then the script, then the call itself

A call run prepares a person to hold a conversation in a language they do not speak well - a vendor's
support desk, a partner's engineer, an interviewer - about a system they know well. The fleet digs every
fact the conversation could need out of the project and writes each one down with its evidence; the top
model turns those facts into a page the person reads aloud, one sentence per line, the gist in their own
language beside every line; and during the call a fresh chat answers from the same facts, in both
languages, in one turn.

The premise is the plugin's: a number said aloud to a vendor that nobody measured is a blind pane. The
reference is the Contoso script of 2026-08-21, whose first version proposed in every item and was
rewritten the same day around asking how it is meant to work. What the interpreting research adds is
narrow and worth having: numbers are the words most often dropped or mangled when a person speaks under
load, and a pre-verified list of them on screen is the largest accuracy gain measured (Desmet et al.,
56.5 to 86.5 percent), which is why the script carries a numbers table and the gate refuses a digit in a
spoken line.

## The run on disk

```
.fleet/<run-id>/
  call/
    CALL.md            who is on the line, the two languages, the answers to bring home, the reserved topics
    facts/<source>.md  one file per facts task, one fact per heading, evidence on every one
    facts/live.md      what the live chat dug up during the call, in the same shape
    script.html        the page the speaker reads from
    log.md             what they answered, filled during the call
    letter.md          the follow-up, written from the log when the call ends
  tasks/...            the queue, as PULL.md lays it out
```

## Stages

| stage | tasks | lane | after | model | budget | writes |
|---|---|---|---|---|---|---|
| facts | one per source | repo | - | opus | 25 | `call/facts/<source>.md` |
| script | one | repo | every facts task | the design model | 45 | `call/script.html`, `call/CALL.md` |

Split by **source**, the `research` axis: this subsystem's code, the vendor's documents held in the
repository, the stored responses or the database for measurements, the previous call's notes, the letters
exchanged. Splitting by question makes every worker read everything. A source that lives behind the
running application is a pane task only when the operator says a pane is worth it; a query tool named in
`FLEET.md` is the repo lane.

Isolation: none. A facts task writes one new file and edits nothing; the script task writes two. There is
nothing to merge.

The facts model is Opus rather than the Sonnet `MODELS.md` gives a clear spec, because the spec here is
not clear: "every number about this topic, and what each depends on" is the kind of task a weaker model
finishes early and quietly. A wrong number on a call costs the call, and a tier costs cents.

The script model is the design model: copy meant to be read aloud is copy meant to be seen, and a script
from a weaker model is one the speaker rewrites at the table.

## A fact

One per heading, in the source's file, with an id that is unique across the run: `F`, the task's number,
a dash, a counter.

```markdown
## F02-7 · Northwind refuses about a third of our second checks with error 43
- what: 35 of 109 second checks to Northwind's three entities came back ErrorCode 43 "Invalid/Missing Account ID"; zero such errors at any other carrier
- how known: measured
- evidence: select count(*) ... where carrier like 'NORTHWIND%' and error_code = 43, direct-account traffic 2026-07-24 to 2026-08-12
- when: 2026-08-12
- depends on: the organisation account ID we send, the same one to every carrier
- say: About one Northwind check in three comes back with error forty three. No other carrier gives us this error.
```

`how known` is one of four words, and the script treats each differently:

- **measured** - a query or a command this task ran, over a named window. Spoken as a number.
- **read** - a file and a line, or a page of the vendor's own document. Spoken as a fact, with the
  document named when it is theirs.
- **told** - a person said it: the previous call, a letter, a ticket. Spoken as "your letter says", never
  as ours.
- **guess** - nobody checked. Never spoken. It goes to the script's traps with the reason.

`evidence` and `when` are required on every fact and the gate refuses one without them. A facts worker
that cannot find the evidence for something the mission asserts writes it down as a guess rather than
leaving it out: the guess is what the speaker must not say, and it reaches the traps section only if it
was written.

A facts task also files a finding, through `fleet.sh find`, for every claim in the mission text, the
previous call's notes or the letters that its facts refute - "the letter says five templates; the source
has six" - with the fact's evidence as the finding's. Those are a call run's findings: collection ranks
them, and the script's traps are written from them.

## The script

One page, `call/script.html`, built on `templates/call-script.html` in this plugin. The styles are the
Contoso page's and the structure is fixed, so the script task fills sections rather than designing a
page. The sections, in reading order:

1. **How to run it** - the rules of the register, stated for the speaker in the read language, and the
   repair lines: the fixed sentences to say when lost. Air traffic control keeps five and a meeting needs
   the same five: say again ("Sorry, can you say that again?"), confirm ("Let me check I understood. You
   said ..."), correction ("Correction. The right number is ..."), standby ("One moment, I am checking."),
   unable ("I cannot answer that now. I will write to you today."). A speaker who has these does not
   freeze.
2. **Numbers aloud** - a table of every number the cited facts carry: what it is, how it looks, how to
   say it. Numbers are the words most often dropped under load, so every one is pre-written.
3. **Opening** - the first forty seconds: who is on the line, and the frame ("nothing is broken, I want to
   know how to do it right").
4. **Questions in blocks by tempo** - hot (what stops work now), warm, cool, calm. Each question is one
   `<article class="q" data-facts="F02-7 F02-8">`: the heading, why it is asked, the gist in the read
   language, a `.facts` block with the exact digits and identifiers, the `.say` block in three stages -
   what we do, what we get, the question - then the sharper follow-ups for a vague answer, how the speaker
   will recognise a good answer, and the trap for this question when there is one.
5. **If they ask us** - a table: what they might ask, the gist, the line to say. An interview is mostly
   this table, with the questions section reduced to what the candidate asks at the end.
6. **Closing** - the answers to bring home, and the lines that end the call: read back, in writing, a
   ticket number, who is on the email.
7. **Traps** - every guess and every refuted claim: what not to say and why, in the read language.
8. **Answer log** - one row per question, filled during the call.
9. **Footer** - the window the facts were measured over, and the measured facts older than it, to
   re-measure before the call.

Every number in a spoken line is a word; the digits stay in the `.facts` block beside it, which is where
the speaker looks when asked for the exact figure.

`data-facts` is the provenance. A question that cites no fact is a question written from memory, and the
gate refuses the page.

## The register

The speaker is good at the system and not at conversation, and the speak language is not their first.
Every line has to be sayable at first sight.

- **One line, one sentence, one idea, under fifteen words.** A blank line where the speaker pauses. The
  read language first, one or two sentences, so the speaker knows what the point is; then the lines to
  say.
- **We do this, we get this, how should it work.** A point that reports a problem takes those three steps
  and only those. Not "please add the field": the person on the line cannot add a field, and asking them
  to is how a call ends with nothing. "How should we handle this? What do your other customers do?" is a
  question a support desk can answer.
- **Leave them the exit.** A hard question closes with "Maybe we send it wrong, or read the wrong field.
  Please tell me." People answer that; they defend against an accusation.
- **Ask, then stop.** After the line with the question, the next line is theirs.
- **Plain words, one meaning each.** Say, get, send, wrong, works; never state, receive, transmit,
  incorrect, functions. No idiom, no phrasal verb where a plain verb exists ("start" over "kick off"). If
  the speaker would look a word up, it is the wrong word. The Contoso speaker stopped on `verbatim`,
  `canonical`, `envelope`.
- **Numbers as words, with a pause before and after.** "about eight hundred", "one in three", "error forty
  three". A request number in threes: "two seven three - one four three - five six eight". A code digit
  by digit: "zero zero one one two". A date by name: "August first". The exact figure stays in digits in
  the facts block beside the line.
- **Every answer in writing.** After an oral answer: "Can you send that to me in writing?"
- **Argue only with their own identifiers.** A request number, a ticket, a field name from their
  document. Never "it does not work".
- **Money stays off unless they raise it.** Then listen, write it down, name no figure of ours.
- **Keep every fact.** Numbers, codes, field names, ids, dates and every negation survive the
  simplification. A number rounded for speech says so ("about"), and the exact one stays beside it.

`/makarasty-tools:say` carries the same register for a single reply written by hand; this page is where
a fleet's script is held to it.

## The gate

```bash
node scripts/fleet-call.mjs check .fleet/<run-id>              # exit 0 clean, 1 refused
node scripts/fleet-call.mjs check .fleet/<run-id> --stale 14   # also list measured facts older than 14 days
```

Refuses: a fact with no `evidence`, no `when`, or a `how known` outside the four; a fact id defined
twice; a `data-facts` id no facts file defines; a page with no `data-facts` at all; a missing `CALL.md`;
and a digit inside a spoken line - a `<p>` in a `.say` block, an `<li class="en">`, a
`<td class="say-cell">`. Reports facts by `how known`, the cited and the uncited, and with `--stale` the
measured facts older than that many days, which the footer lists for re-measuring. The script task runs
it before `finish`; a refused page is a task not finished.

## Live

`/makarasty:fleet-call live <run-id>` in a fresh chat, when the call starts. Fresh, because the planner's
context holds the whole run and every turn there pays for it; the live chat holds the facts and nothing
else, which is what makes a reply one turn.

### Setup

Read `call/CALL.md`, every `call/facts/*.md`, and `call/log.md` if it exists. Nothing else - not the
script, not the project's source. Turn on `/makarasty-tools:unslop on` when that plugin is installed, and
hold its rules either way: no opening, no summary, no hedge stacked on hedge. Then say, in both
languages, that you are ready, and name the answers to bring home.

### The reply

Every reply is two blocks and nothing else. No heading, no bullet, no "here is what to say", no third
block. The AISA study of non-native speakers using a live assistant found that three suggestions and
words above the speaker's level raised their workload and their error rate; one candidate, simpler than
the speaker would write themselves, is the shape.

```
<read language> What they most likely asked, in one sentence, when the paste was unclear. The answer in
one or two sentences. Then the source in brackets.

<speak language> The lines to say. One sentence per line. Numbers as words. Four lines at most, unless
the operator asks for more.
```

The source tag closes the top block, always, and it is one of:

- `[F02-7, замер 12.08]` - a fact, with its `when` if it was measured.
- `[из кода: src/x.ts:120]` - dug during the call.
- `[в фактах нет, это догадка]` - and the bottom block says so aloud: "I am not sure. I will check and
  write to you today."
- `[в фактах нет, проверяю]` - the dig notice, below.

A reply without a tag is the failure this mode exists to prevent: an answer that sounds as sure as a
measured one and is not.

### Hearing

The paste is what the speaker heard, and it may be half a sentence, a mix of two languages, or a
transcription with the wrong words in it. Take it as it comes; asking the speaker to retype it costs them
the call. The top block starts with the most likely reading. When two readings compete, name both in one
line and make the bottom block the clarifying question: "Sorry, do you mean the carrier list, or the
second check?" A guess at what they meant, answered confidently, sends the speaker down the wrong
question.

### Digging

The facts answer most questions, and a reply from them is one turn. When the facts have nothing:

1. Say so in the top block, with what it will take: "в фактах нет; один поиск по коду, полминуты", or
   "нужно посчитать по базе, минуты три".
2. Give the holding line in the bottom block: "Give me a minute, I will pull that up now."
3. Dig in the same turn: `rg`, a query, a file read. No subagent - a spawn costs sixteen seconds before
   it reads anything (`MODELS.md`), and the speaker is on a call.
4. Reply with the answer and the tag `[из кода: ...]`, and append what was found to `call/facts/live.md`
   as a fact in the shape above, so the next question does not dig for it again.

A dig longer than a few minutes is the operator's call: say the estimate, give the holding line, and
stop. They say "копай", or they move on.

### Logging

"Они ответили: ..." appends a row to `call/log.md`: the question id, what they said, who, and by when in
writing. The reply is one line in the read language saying it was logged - or, when the answer
contradicts a fact, the fact's id and the line to say: "Our data shows something different. Can you look
at request two seven three - one four three - five six eight on your side?"

### Reserved

`CALL.md` names the topics that stay off - money, customer data, whatever the operator reserved. A
question on one of them gets the deflection line the script carries, and nothing else in the bottom
block.

### After the call

"Закончили" or "the call is over": write `call/letter.md` - the follow-up in the speak language, from
the log, one paragraph per question with its request numbers, the request for written answers and a
ticket number, and the read-language gist above each paragraph - then say which of the answers to bring
home landed and which did not. The letter is a draft for the operator to send; nothing in this mode sends
anything.

## What this costs

A facts task is a repo task on Opus: the source it reads and one file out. The script task is the top
tier once, for a page that passes through the model as output. The live chat is the cheap part by
design: a small context and one turn per question, and the whole point of the facts stage is that the
expensive reading was done before anyone was on the line.
