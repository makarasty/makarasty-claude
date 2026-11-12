# Changelog

## makarasty-tools 1.19.33 — 2026-11-13

- **Every question is screened before it reaches the person:** ask-guard refuses an AskUserQuestion once unless
  it carries `metadata.screened` (one line: what the chat checked and why only the person can answer). The refusal
  sends the chat to check the project's CLAUDE.md and docs, what runs locally, the scripts and env it uses, earlier
  answers and the standing answers, itself or with a Haiku Explore agent; settled → it does the step; something not
  running that it cannot start → it asks the person to start it. A stake (push, merge, deploy, delete, money,
  sign-in) and the inbox chat's own relays skip the screen. On 95 real questions a screen would have settled 15%
  with no wrong call [M72]. `MAKARASTY_SCREEN=off` drops it.
- **A local commit of the chat's own files is not a question:** the session's working rules now say commit your own
  files when done; push, merge, release and delete stay asked. The inbox answers a commit question that still
  comes in with "commit your own files yourself" unless the person's profile says commits are asked.

## makarasty-tools 1.19.32 — 2026-11-13

- **No secret is asked for, and nothing the agent can run is handed to the person:** a fleet asked for a sandbox
  database password while a local proxy to that database was already up. ask-guard refuses an AskUserQuestion that
  asks for a password, token, secret, API key or an `*_PASS`/`*_TOKEN`/`*_SECRET`/`*_KEY` value, or asks the person to
  run something themselves; the refusal sends the agent to find the local way in (a proxy or tunnel, open ports,
  the env files and scripts the project uses) and do the step itself. The session's working rules carry one line of
  the same.

## makarasty-tools 1.19.31 — 2026-11-13

- **No commands inside a question:** a command cannot be copied out of the dialog. ask-guard refuses an
  AskUserQuestion whose question, option label or description holds a command line (a `&&`/`||` chain, `cd <path>`,
  or a known tool with a flag, path or script argument); the command goes in a code block right above the call, on
  Windows in a form Windows PowerShell 5.1 runs (`;` instead of `&&`, tagged powershell), and the question stays a
  short title. Same rule in the session's asking line and for items the inbox relays.

## makarasty-tools 1.19.30 — 2026-11-13

Every chat gets its answer: an extra question beats a lost one.
- **An answer is never lost mid-turn:** an inbox answer to a box written while the asking chat was in a turn was
  marked delivered and its prompt vanished. Now the chat delivers its own answers only between turns (turn state
  kept in `inbox/turns/<session>`, so a plugin reload mid-turn does not forget it), one per call, re-checked right
  before the submit; `delivered/<id>` is written only after a submit that did not throw, and a failed one is retried.
- **A re-ask after an answer is a new item:** a box asked again after its answer went out was suppressed as
  "queued", so the chat waited and the inbox was empty. Now only an answer still on its way holds a re-ask back.
- **`inbox.mjs scan`, run when a chat becomes the inbox:** reads the tail of every live chat's transcript on every
  account (one shared transcript tree) and files an item for each AskUserQuestion without a result or wrap_up ask
  without a later prompt that no item covers (questions over 24 h old skipped); answers to them are delivered as a
  prompt.

## makarasty-tools 1.19.29 — 2026-11-12

- **A question that sends the person elsewhere names the place:** ask-guard refuses an AskUserQuestion that points
  at a link, chat or window "above" without a link in the question itself; a relayed dialog shows only its own
  text, and the person could not find the chat. The session's asking line now says: name the chat (title and
  account) in the question, the link and the exact action right above it. The inbox adds the same for items it
  relays that point at yet another chat or app.
- **Live (11-12):** with a Claude window in front, a `start` the person asked for stayed queued and the inbox
  chat's timer retried it every minute; the same typed prompt a second time was refused.

## makarasty-tools 1.19.28 — 2026-11-12

- **Effort from the profile:** a line `Effort: <when medium, when high>` in profile.md overrides the plugin's effort
  defaults for spawned agents and sessions (the session text says so; README lists the key).
- **inbox SKILL:** point the person at another chat with its link; never open it in a split pane or a separate
  window unasked (a chat whose Browser pane must be on screen may get its own window and opens its pane itself).
- **Tests:** a commit question phrased as a continue ask ("Продолжаем: коммитим локально?") is never answered by
  the continue rule.

## makarasty-tools 1.19.27 — 2026-11-12

Phase 2 of the rebuild plan: the inbox starts chats on any account by itself, behind a gate and the person's words.
- **inbox `start` is gated, consented and journaled:** `--said "<his words>"` must match a prompt the person typed
  in the last 24 h (the hook keeps them in `inbox/said.jsonl`, 24 h, 200 entries; one typed prompt starts one chat;
  15+ characters and 3+ words); `--mode` only `default|plan|auto`; the profile's own bundled CLI makes the bootstrap
  turn [M71]; a journal per start (`inbox/starts/`) makes a retry continue instead of starting twice; a per-profile
  lock; the start waits (exit 4, queued) while any Claude window is in front or free memory is under 2 GiB, because
  the import raises that window then [M71]; the inbox chat's timer runs `start --drain` once a minute (one start per
  run, failed ones retried after 10 min, 3 attempts). `inbox.mjs status` shows queued starts and the ledger
  `coord/dispatch.jsonl`; `<config>/makarasty/dispatch.off` turns it all off. `--switches-window` is no longer needed.
- **Every finish of a reporting chat is a report:** a turn that ended with a plain reply (no wrap_up) wrote nothing,
  so a started tests session that hit a timeout went unreported while another session still ran. Now each such
  turn writes one; an error, a timeout or a last message that waits on the person wakes the inbox chat at once
  (at most once per chat per 10 min); a chat the inbox started is never folded away; turns the person typed in that
  chat write none.
- **inbox SKILL:** every finished child turn is reported at once (did, did not, what the person must do); a
  complaint about the coordinator becomes a rule in the tool; chat links before each ask; a project's task runs in
  that project's chat. README lists the profile lines the tools read and answers.md; PERF.md: check `claude auth
  status` before `claude -p` experiments.
- **Tests and fixtures carry no person's project or account names.**

## makarasty-tools 1.19.26 — 2026-11-12

Phase 1 of the rebuild plan (rebuild-plan.md in the coordinator's side-session notes).
- **inbox: continue questions answered from the standing rule:** an AskUserQuestion that only asks whether to keep
  going (short, the continue words, exactly one yes and one no option, not multi-select) is answered yes the moment
  it is filed, when profile.md or answers.md has a line `Continue questions … answered yes` or `Continue: yes`
  (negated lines do not count). Never when the question, header, an option, description or preview names a consent
  stem (commit, push, merge, deploy, release, delete, overwrite, ship, prod, send, pay, permission, new task and the
  Russian stems). The answer says it came from the rule, goes to `inbox/auto.jsonl`, and `inbox.mjs list` shows it
  once with «отмени <id>».
- **Standing answers in their own file:** `<config>/makarasty/answers.md` is injected as its own line (cap 4000), so
  the 2000-character profile cut no longer drops the newest answers; both files warn past 80% of their cap.
- **git-guard: the pipe exemption needs a real `pipefail` or `$PIPESTATUS`:** before, the word anywhere in the text
  (a comment, a commit message) let `git push | tail` through. Now `set … -o pipefail` / `shopt -so pipefail` must be
  a command before the pipe, or `$PIPESTATUS` must be expanded (double-quoted forms count).
- **inbox `start`: the flip-back target is read after the CLI turn,** not up to 180 s before it, so a chat the person
  switched to meanwhile is the one shown again. Live 11-12: the flip-back returned dev to its old chat in 2 s, but the
  dev window came to the front while a main window was in front (the gate in phase 2 handles that) [M71].
- **inbox SKILL:** finish reports say what the person can see now and where, and each item's status; commit asks of
  several chats go in one call, one question per chat.

## makarasty-tools 1.19.25 — 2026-11-12

- **inbox: `open` and `start` reach the operator's own window, never a fresh app:** a chat of `main` (no renamed app
  copy) went to the bare `claude://` handler, which has no `--user-data-dir`: it opened a separate signed-out app
  instance instead of his window. The link now goes to the exe of the window already running with that profile's
  `--user-data-dir` (read from the process list); with no such window, or a chat in no profile, the command refuses.
- **inbox: `start` needs `--switches-window`:** the resume import shows that account's window and switches it to the
  new chat (`setFocusedSession`); it replaced the chat the operator was dictating into. No import path in the app
  avoids it (the recovery import asks for a click, the index is read only at start) [M70], so `start` refuses unless
  the caller says that window is not in use. After the import `start` opens again the chat that window showed before
  (the highest `lastFocusedAt` of that profile), so the window flips to the new chat and straight back.

## makarasty-tools 1.19.24 — 2026-11-12

- **inbox: a new chat on another account with no click:** `inbox.mjs start <profile> <folder> <name> [--model m]
  [--effort e]` runs a one-word `claude -p` turn in the folder with a known session id and name, then hands
  `claude://resume?session=<id>` to that profile's app copy, which imports it as its own chat; the coordinator then
  sends the brief with `SendMessage` to that name and every turn from there runs on that account. Replaces "ask an idle
  chat there to offer a card, and the person clicks". `claude://code/new?q=&folder=` was tried first: it only fills
  the composer and waits for Send [M70]. Selftest in `inbox-selftest.mjs`.

## makarasty-tools 1.19.23 — 2026-11-12

- **inbox: a queue, not one question at a time:** the operator left with one question open and came back to that one
  only; items that came in meanwhile waited behind it (12 of the inbox chat's 38 dialogs that day had an item come in
  while open and still waiting when it closed) [M63]. A dialog of the inbox chat open 10 minutes when a new item
  comes in is closed by the plugin, its questions answered "[not answered yet ...]", and the inbox asks every open
  item anew: those first, then the new ones, oldest first, grouped by chat, up to 4 per call, each call opening with
  how many are open in how many chats and which call of how many it is. Under 10 minutes the dialog stays: the person
  may be reading it. Test in `tools/hooks/inbox.test.ts`.
- **inbox: standing answers are recorded, not guessed:** when the person says a question was answered before ("уже
  отвечал", "не переспрашивай"), the inbox appends `<topic>: <answer>` to `profile.md`, and later items on that topic
  are answered from it, named in the report with an undo ("отмени <id>"). No answer is guessed from past picks: of 61
  answers that day the only repeats were fleet-plan's two standing questions; fleet pace and commit answers changed
  from case to case [M63]. Never for a commit, push, merge, deploy, delete, money, someone else's data, new work or a
  choice between approaches. `tools/skills/inbox/SKILL.md`.

## makarasty-tools 1.19.22 — 2026-11-12

- **inbox: a long turn of the inbox chat no longer hides new questions:** its own dialog stayed open from 16:56 to
  17:55 UTC (one turn); three items came in meanwhile, one of them from another account (oxi-yapper, dev2), and none
  woke it, since no wake is sent mid-turn (1.19.15) and the watchdog stays quiet while the inbox chat is busy
  (1.19.14). The person answered the dialog and typed 9 s later, before the next 15 s tick, so he never saw them.
  The account played no part: the items were all in the one inbox folder. Now the inbox chat's turn end wakes it at
  once with what is still open (one wake at a time, so the tick cannot send it twice). Test in
  `tools/hooks/inbox-reports.test.ts` (it fails without the change).

## makarasty-tools 1.19.21 — 2026-11-12

Fixes from the review and red team of the day's work (two review rounds on the fixes).
- **ask-guard stops refusing real decisions.** A delete or remove in any form ("Удалю 4 папки… Продолжить?"),
  keep-or-discard ("Keep them?"), plan approval, a failure ("Tests failed: 3 of 40. Continue?"), a sign-in step, or a
  stake in an option's description, the header or the wrap_up recap now passes. Recap, header and descriptions are
  read for forward steps only (push, deploy, delete, prod, ...), so a status recap does not let a bare continue
  through. Cyrillic stems need a word start ("выпадающий", "сотрудник", "удалась" are not stakes).
- **guards.** PowerShell -Command after an unknown value option (`pwsh -SettingsFile s.json -Command "git stash"`)
  and bare `-e` (EncodedCommand) are read; `git add ./*`, `':/*'`, `'**'` are whole-tree; `export HUSKY=0;` or
  `$env:HUSKY=0;` before a hook-running git (also inside `bash -c`) is hooks-skipped. The delete grant is refused
  when a Claude shell has no session id.
- **inbox.** A hold chat files no box or card either; a `collecting` list untouched for 24 h no longer silences a
  chat. A card no longer hides that turn's prose question. Prose questions keep their subject ("Удалить
  config.json?") and are found before `**`, `»`, `)`. Unanswered items stay 7 days (answered ones go 24 h after the
  answer, an inbox answer only once delivered); an unseen finish report stays 7 days. A failed phone push is retried
  3 times, 5 min apart. `list` in another chat no longer takes the inbox over while the inbox chat is alive
  (`--take` does); tasks.json writes cannot collide.
- **hold.** "Carry to the next hold" works: `last` offers a released hold with not-done, partial or unseen items
  that was not carried yet (a `carried-to` marker survives the archive rename), skipping a live chat's hold while
  it still collects or fixes. `carry` writes the new-hold rules. The after-shot must differ from the before-shots;
  `judge: <agent> not-fixed` cannot be `done`.
- **cleanup.** A chat's own tool shell or the desktop app as an ancestor is "a Claude chat", never the operator's
  terminal; claude.exe is never a candidate; a crashed chat's record or reused pid no longer hides or keeps the
  wrong process; rows carry `created` / `pidCreated` and the skill re-scans before any kill.
- **selfreview** masks `scheme://user:pass@` passwords; developer.md says queued prompts are included.
  **blindtest** runs its Sonnet user at high effort.

## makarasty 1.18.6 — 2026-11-12

- **A hold survives a coordinator relaunch.** STATE.md records `hold: <dir>`; fleet-collect runs every `hold.mjs`
  call with `--dir` from it and spawns a fleet-design-eye judge per screen item before `done` (no look: `unseen`).
  A screen task owns `<hold dir>/img/NN-after.png` and saves it through its own `proof.mjs` receiver.
- **fleet-plan** reads profile.md itself (the session text is cut at 2000 characters) and replaces a `Fleet ...:`
  line instead of appending one; `cover` paths are quoted; the anecdote naming projects is gone.
- **operator-words.md** keeps the text the person typed when rejecting a tool call.

## makarasty-tools 1.19.20 — 2026-11-12

- **inbox: the coordinator's rules from 11-12 live in the skill.** A question already answered (here, in its chat,
  a profile standing answer, a decision for a set) is answered from that answer; a hold echo, a question to a chat's
  own reviewer or a recap ending in "?" is not the person's (`done`, one line, no answer). The asking chat's link
  goes right above each ask; a step only he can do names the exact action. A refused card start is proposed as a
  card here. Started sessions get model and effort by kind of work (this chat on the top model). "How long": a
  table chat | what is left | rough time, marked as an estimate. SKILL.md 12782 -> 13876 bytes.

## makarasty 1.18.5 — 2026-11-12

- **fleet-plan asks a standing question once:** Round 0b's two questions (another chat's code blocks the commit; a
  check that messages the operator if the chat dies) are the person's policy, not one run's. The darkkitty fleet
  asked them on 11-11 and he answered; the LifeLines fleet asked them again on 11-12 ("я уже отвечал на этот
  вопрос"). Now a question the profile answers (`Fleet foreign code: ...`, `Fleet crash watch: ...` in
  `profile.md`, which every session already gets) is not asked, its value is named in one line; a question asked
  says the answer is kept, and the answer is appended to `profile.md`. `commands/fleet-plan.md`.

## makarasty 1.18.4 — 2026-11-12

- **fleet-plan, fleet-collect: a hold list keeps its items through a run.** In five traced holds (151 items) 31-41%
  ended unfinished although every item had a task: tasks were narrower than his words, his screenshots never
  reached workers, and runs closed on a task count. fleet-plan now gives each task a `hold: NN` line, the verbatim
  quote and the `img/` paths, and does not start the run while `hold.mjs cover` lists an item with no task;
  fleet-collect ends such a run with the per-item table and one question for every unfinished number.

## makarasty-tools 1.19.19 — 2026-11-12

- **hold: closing table, done-means, look before done, repeats.** `table` prints his numbers with status and
  evidence (done rows as one line, `ask:` = every unfinished number, each goes into one fix/carry/leave question).
  `means NN` records what done means per item (`check` needs it on done/partial/unseen). A screen item is `done`
  only with `img/NN-after.<ext>` and `judge: <other agent>` in the evidence, else the new final status `unseen`.
  `scope NN n N` blocks `done` while n < N (breadth words: count first, ask on "N of N"). `add` marks a repeat
  (`back: <id>/NN`, same project and `where:` as an earlier done item). `cover <run dir>` backs fleet-plan.
  Selftest 101 checks; holds made before these rules (no `rules2` marker) keep the old check. Source of the numbers: the 5-session loss trace, 2026-11-12.

## makarasty-tools 1.19.18 — 2026-11-12

- **inbox: a started session's question is asked in the inbox:** 1.19.11 refused re-asking an AskUserQuestion of a
  session the inbox chat had started, assuming the app shows that dialog there; the operator did not see it, and
  answered it in its own chat unprompted. The app draws that dialog in the inbox chat only sometimes (seen once in
  the morning; at 12:38-12:39 not while the inbox chat was busy in a turn) [M63], so no rule may count on it: the
  inbox chat asks every item itself, ask, box and card alike, with the `inbox:<id>` flag, so its dialog closes when he
  answers in the asking chat and an answer here closes the asking chat's dialog; asking without the flag is still
  refused. Tests for a started session's ask, a box and a card in one dialog in `tools/hooks/inbox.test.ts`.
- **inbox: no box from a hold or from a "?" mid-reply:** a chat collecting complaints in hold mode files no box and
  no finish report until the codeword (one "«…counted» (?" became a box and woke the inbox per complaint). A
  question in prose counts only when the reply ends with it: a fleet coordinator's question to its own reviewer,
  followed by more text, was filed as a box for the operator.
- **inbox: several finishes of one chat read as such:** the Finished block says "N finishes of one chat" when it
  carries earlier recaps (two finishes of one chat were taken for a duplicate).

## makarasty-tools 1.19.17 — 2026-11-12

- **inbox: a box asked again is asked once:** in 46 items of 20 chats (2026-11-12) a chat asked its end-of-turn box
  again three times, the same decision in 80-100% the same words, and the person answered both copies. When a chat's
  new box shares 70% or more of its words with one it asked before: an earlier box still open is closed as
  superseded (its file stays, so the history does); one already answered from the inbox during this turn, whose
  answer is still queued for the chat, keeps the new box out of the inbox. Questions on other topics (50% at most
  that day, "run B" and "run C" exactly 50%) stay open; AskUserQuestion items and cards are untouched.
  `tools/hooks/inbox.ts`, tests in `tools/hooks/inbox-reports.test.ts`.

## makarasty-tools 1.19.16 — 2026-11-12

- **inbox: follow and mute a chat:** the coordinator takes in a chat the person names ("там запущен чат, хочу от него
  уведомления") or one it noticed: `inbox.mjs follow <app id | session id | piece of the title | project>` switches
  its finish reports on, on any account; `mute` switches them off (its questions still come); `followed` lists the
  followed chats, then those busy in the last 30 min that are not. A name several chats match lists them (15 newest)
  and switches nothing; a project with one chat active in the last 3 h picks it. On "что с задачами" the inbox offers
  the busy unfollowed chats in one multi-select question. Tests in `inbox-selftest.mjs`.

## makarasty-tools 1.19.15 — 2026-11-12

- **inbox: no wake for questions already answered:** the inbox chat was woken with "3 new items" after all three had
  been answered, and `list` said "nothing pending": the wake prompt was queued during its turn and entered after it,
  built from what was open before. The hook now sends no wake while the inbox chat's turn runs and builds it after
  the turn from what is still open. Test in `tools/hooks/inbox-reports.test.ts`.
- **inbox watchdog: no false alarm on an older plugin copy:** it fired three times while the inbox chat was busy
  ("its last tick never": that chat runs a copy from before the `turn` file). An item now also counts as being
  handled when the inbox chat's own transcript changed after it came in. Test in `inbox-selftest.mjs`.

## makarasty-tools 1.19.14 — 2026-11-12

- **inbox: finish reports:** a chat switched on for it leaves a report in the inbox when it ends a working turn
  (wrap_up called, or the turn died on an error): its recap and the final message cut to 2000 chars, a secret in it
  replaced by "open the chat". Switched on: every session the inbox chat starts (the plugin does it), a chat the
  coordinator `track`s by app id, and any chat by `/makarasty-tools:inbox report` (operator's choice, 2026-11-12:
  reports only from the coordinator's chats and the ones he switches on). A turn that left a question writes its item
  and no report; a `/loop` tick writes none. Reports never wake the inbox chat one by one: they go with the next item
  wake, with a prompt the person types there, or as one batch at 5 min quiet or 15 min from the first [M63]. `inbox.mjs
  list` shows them under "Finished" once, `reports` for 3 days, then they are swept. No phone message, no model call.
  `tools/hooks/inbox.ts`, `tools/skills/inbox/{core.mjs,inbox.mjs,SKILL.md}`; tests `tools/hooks/inbox-reports.test.ts`
  and `inbox-selftest.mjs`.
- **inbox watchdog: no false alarm in a long turn:** it exited with "the wake is broken" when an item waited 63 s
  while the inbox chat was inside a long turn, where no chat can be woken. The inbox chat now marks its turns busy and
  idle (`inbox/turn`) and its timer's last tick (`inbox/beat`); the watchdog waits while it is busy (up to 2 h) and
  names the last tick when it does call the wake broken.

## makarasty-tools 1.19.13 — 2026-11-12

- **culprit before rollback:** new errors after a tool update are no longer silenced by a rollback or a pin. The
  session finds the culprit first: wrong code (fix it), a gap in another checker (report it), or a bug in the new
  version (cite its issue or changelog, then pin with a comment linking it). Operator's rule, 2026-11-12, after a
  type checker update reported two new errors another checker did not. `habits` in `tools/hooks/gates.ts`, and the
  `update` skill's picks.

## makarasty-tools 1.19.12 — 2026-11-12

- **a step only the person can do is asked, not written:** restart an app and look, sign in, click in another app,
  check something by eye now goes in AskUserQuestion (or the end-of-turn ask) with the outcomes as options, never
  only in prose, where people skip it (operator, 2026-11-12). `asking` in `tools/hooks/gates.ts`; the inbox skill
  asks such a step the same way, from an item or its own report. The inbox still never re-asks a question of a
  session it started (1.19.11).

## makarasty-tools 1.19.11 — 2026-11-12

- **inbox: no second copy of a started session's question:** the inbox chat re-asked, reworded, AskUserQuestion
  items from sessions it had started itself (Vize, prompt-health, Value); the app already shows those sessions'
  dialogs in the inbox chat, so the person saw each question twice. `tools/hooks/inbox.ts` now refuses an inbox-chat
  dialog that names such an item in its flag, or whose words overlap it by half or more, with or without the
  flag, and says to answer it in its own dialog above. Which sessions it started comes from the app's own record
  (`spawnedFrom`), through the new `inbox.mjs children <app id>`. Test in `tools/hooks/inbox.test.ts`.

## makarasty-tools 1.19.10 — 2026-11-12

- **inbox: one question, one answer:** the inbox chat re-asked a chat's open AskUserQuestion in its own dialog
  without `metadata.source "inbox:<id>"`, so its dialog did not close when the person answered in the asking chat,
  and they answered the same question twice (item `f37427f1~toolu_01S3Tj1aZ3HdUmHSudiqDzxf`: filed 11:37:49Z, the
  inbox dialog opened 11:38:15Z, answered in the chat 11:38:22Z, answered again in the inbox 11:38:44Z). The hook
  (`tools/hooks/inbox.ts`) now refuses an inbox-chat AskUserQuestion without the flag while items from other chats
  are open, and names their ids; test in `tools/hooks/inbox.test.ts`.

## makarasty 1.18.3, makarasty-tools 1.19.9 — 2026-11-12

- **commits are asked:** a session asks one yes/no, with the files listed, before a commit too, not only before a
  push (operator's rule, 2026-11-12). `habits` in `tools/hooks/gates.ts` puts the commit first in its ask-first list;
  ask-guard's refusal text names a commit as the person's decision ("commit" was already a stake word, so a commit
  question is never refused as a "continue?"). Fleet: the pace answer sets when a commit is due, and every commit to
  the main checkout is still asked at its time, without holding the run (`docs/ONECHAT.md` "Commits",
  `commands/fleet-collect.md` landing, `commands/fleet-plan.md` Round 0). An explicit `/commit`, `/ship` or
  `/finish` request is the consent and is unchanged; worktree branch commits (opt-in) are unchanged.

## makarasty-tools 1.19.8 — 2026-11-12

- **cleanup:** `residents.mjs` finds long-running dev processes that a live parent hides from the orphan census:
  `tsc --watch`, `tsc --lsp`, vite and other dev servers, headless automation browsers, `heavy.mjs` wrappers. It
  names the owner chat by the parent chain and sorts CANDIDATE (owner chat ended or idle 120 min, no CPU in a 3 s
  sample, no connection on its port, 10 min old), ASK (a terminal's or an unknown owner) and KEEP. Read only, 6 s:
  `node tools/skills/cleanup/residents.mjs`, `--selftest`. The full `scan` lists CANDIDATE and ASK as
  `idle-residents` items with method none, so `apply` cannot end them; ending is the operator's yes, then
  `taskkill /PID` per pid. Numbers and what is not measured: [M69].

## makarasty-tools 1.19.7 — 2026-11-12

- **session rules:** the session-start text now carries the standing rules a person who runs many chats gives every
  session, so a new install gets them without a personal CLAUDE.md. `habits` (tools/hooks/gates.ts): say what you did
  not check; report what happened, why, what you did, what the person must do; "urgent" means the core change and one
  check, then the list of what was skipped; do without asking (scoped checks, the dev server after checking its port,
  fixing your own breakage) and ask first (push, merge, release, delete, sending off the machine, stopping the
  person's process, a real choice); edit and commit only your own files when chats share a checkout; an OOM means a
  narrower check, never a bigger heap or a dropped worker cap. `asking`: several questions in one AskUserQuestion,
  recommended first; a turn that ends waiting on the person ends with a message that stands alone. About 1 KB more per
  session start; no new measurement, so no new `[Mnn]`.
- **hold:** with no argument the codeword comes from the person's profile when it names one.
- budget-guard header no longer names one machine's RAM size.

## makarasty 1.18.2, makarasty-tools 1.19.6 — 2026-11-12

- **models:** every Sonnet spawn now runs at effort `high`, not `medium` (operator's default, 2026-11-12). The coder was
  already `high` [M51]; the rest moved: `fleet-lead` and `fleet-profiler` frontmatter, the finder or reader spawns in
  hold, review, redteam, handoff and ship, the lead line in `docs/ONECHAT.md`, and the session-start economy rule in
  `tools/hooks/gates.ts` (it now says every Sonnet spawn, coder or finder, never medium). Haiku stays at `medium`.
  Cost: more tokens per Sonnet finder call; no new measurement, so no new `[Mnn]`.

## makarasty-tools 1.19.5 — 2026-11-12

- **inbox:** the wake timer restarts when the plugin reloads (session.start, through router.ts) and at every turn
  end. Found live by the watchdog: after `claude plugin update` the inbox chat sat 67 s on a new item unwoken,
  because the reload dropped the timer and only a typed prompt started it again.

## makarasty-tools 1.19.4 — 2026-11-12

- **inbox:** `watchdog`, a background task the inbox chat keeps in its task list: silent while the wake works, it
  exits (and wakes the chat) when an item waits a minute unannounced or another chat became the inbox. The person
  sees the inbox alive instead of trusting it.

## makarasty-tools 1.19.3 — 2026-11-12

- **inbox:** `status` also says when an item last came in, when the inbox chat was last woken and when an answer
  last went out; `test` writes a check item from a pretend chat so the person sees the inbox chat wake by itself
  (measured live: woke after 8 s).

## makarasty-tools 1.19.2 — 2026-11-12

- **inbox:** the marker for an item answered in its own chat is English, `[answered in its own chat]`, in the hook,
  its test and the skill; this release also carries the prose-question capture and the inbox self-wake listed
  under 1.19.1, which landed after that version was installed.

## makarasty 1.18.1, makarasty-tools 1.19.1 — 2026-11-12

The rest of the author's own facts out of shipped text [M67].

- **inbox:** its explain prompt, rendered list, phone line and the answer it hands back are English; the plain
  explanation is written in the language the person writes in. Card buttons are in the person's language; the
  answers written back are "Started from the inbox" / "Declined".
- **inbox:** a reply that ends with a question asked only in prose becomes an inbox item at turn end
  (turn.complete; not for subagents, the inbox chat, or a turn that already asked formally).
- **proof:** `report --lang en` writes the page's fixed words in English (Russian stays the default).
- **hold:** with no codeword, `абрикос` for a person who writes Russian, `apricot` otherwise.
- **selfreview:** the self-tooling share reads the person's own repos from
  `<config>/makarasty/selfreview/self-projects.txt` (none: 0); a message typed while the assistant works
  (a `queued_command` attachment) now counts as a prompt.
- **fleet-init, PROTOCOL:** the 32 GB worker count is cited as [M68]; the sample FLEET.md is marked as one
  project's example.

## makarasty 1.18.0, makarasty-tools 1.19.0 — 2026-11-12

The operator's complaints of 11-11..12 as rules, each in the one place that owns it [M67].

- **How a question is asked, once for every chat.** makarasty-tools' session text gains one line: a question
  stands alone (what happened, why, what each option does), a list the person answers point by point is
  numbered, work already asked is finished without "continue?", a step only the person can do is one click or one
  command with its link, and a delete-or-keep question says what the thing is, what made it, its size, what breaks
  without it, and a recommendation. Off with `MAKARASTY_ECONOMY=off`, like the rest of that text.
- **ask-guard** (new hook): refuses an `AskUserQuestion` question or a `wrap_up` ask that only asks whether to go
  on, and names the question to drop from a mixed dialog. By shape, not keywords: the question sentence is a
  go-on verb plus filler ("the rest", "до конца"), every option a bare yes or not-now, and no stake around it
  (money, prod, push, delete, fix, relaunch, a new chat). A red team's 16 real decisions worded as "continue?"
  all pass. A narrow net: 0 refusals over 618 asks of 30 days, so the session line does the work.
  `MAKARASTY_ASK_GUARD=off` drops it.
- **profile.md:** a person's own facts (language, machine, channels, standing answers) go in
  `~/.claude/makarasty/profile.md`; the session hook hands it to every session when it exists (capped at 2,000
  characters). Shipped text no longer carries the author's: project names in inbox, "32 GB box" in budget-guard,
  `~/.claude/MACHINE.md` in redteam and the cleanup deep scan, "Reports are in Russian" in proof, "`LiveProjects`
  trusted" in fleet-init.
- **forge:** one mechanism for every case, a special case only once it repeats; owner facts go to the profile.
- **cleanup:** each pick also says what made it and the recommendation; the deep scan's scouts report "made by".
- **selfreview `developer`** (`developer.md`): a reusable analysis of any developer's history (theirs, or a copy
  via `CLAUDE_CONFIG_DIR`): `selfreview.mjs --prompts <dir>` writes the window's typed prompts per project (clones
  merged, secrets masked) with counts; Sonnet readers return totals and samples; an Opus judge keeps findings seen
  in two or more chats and sorts each into covered, failing (file and line), missing (mechanism), or a profile
  line; numbered report, then the chosen plugin changes by forge. The profile draft is written only line by line
  with the person's approval.
- **fleet-plan:** whether to go on with the run the operator launched is never asked.
- **inbox:** the inbox chat is woken by its own timer once per new item from another chat (English prompt), so
  questions reach it without being asked.

## makarasty 1.17.1 — 2026-11-12

- **A relaunched coordinator gets the operator's own words.** A blind test at three real relaunch points [M64]:
  the brief alone lost his wishes and bans; the brief plus `<run>/operator-words.md` (every operator message and
  AskUserQuestion answer from every coordinator's transcript, verbatim, written by `fleet.sh relaunch`, no model
  summary) scored 55-56 of 60 against 57-60 for the full context, 43-44 for the brief alone and 41-42 for
  compaction, with no confident errors. The chip prompt reads STATE.md AND operator-words.md; STATE.md gains
  "standing wishes and bans", "options he rejected", "decisions and why". Compaction in place stays the fallback
  [M60, M66].
- **The hand-back cap works.** The gate read a subagent's reply from its last assistant text, which is empty when
  the agent ends with SubagentHandback, so no reply was ever capped (0 of 17 in a probe run). It now reads the last
  handback message (also from the tail of transcripts over 4 MiB) at any depth, and asks for a shorter handback.
- **Reviewers write their verdict file on a pass too.** "Read-only" in fleet-reviewer made 3 of 7 depth-2
  reviewers with no defects refuse to write `reports/<id>.review.md`; the file is now its one allowed write.
  fleet-lead passes REVIEW_PROMPT verbatim, renames the round-1 review, and escalates when no verdict file appears.
- **fleet-analyze, one-chat runs:** the coordinator's subagents (any depth) are listed as workers by agent type and
  model; a coordinator is a session that ran `resume <run> --take-over` itself, and records repeated by forks count
  once.
- Slot-lead slowness traced [M65]: the probe's own pause, host load (Bash 5× slower in run B) and an Opus fix
  round; the lead layer itself was not slower. Slot leads stay opt-in.
- Selftest part g1's watch tests wait for the expected line instead of fixed sleeps (they failed about 1 run in 4
  under load).

## makarasty 1.17.0, makarasty-tools 1.18.0 — 2026-11-11

A polish pass over both plugins: an inventory of every tool against 30 days of transcripts (346 guard blocks,
usage per tool, trigger misses), a review per area (Opus) and three red teams (Windows shells, two chats at once,
edge inputs and cost), each finding reproduced before it was fixed. The README is rewritten for a new reader.

Guards (makarasty-tools):
- **False blocks gone.** kill-guard no longer reads `$(..)` or a backtick inside single quotes or a PowerShell
  here-string as a command (`git commit -m 'never \`pkill node\`'` was refused, and blocked a notes write);
  in PowerShell a backtick is an escape. git-guard's pipe check cuts PowerShell here-strings like heredocs, so an
  apostrophe in a commit message no longer un-pairs the quotes (a double-quoted `@"..."@` still runs `$(..)` and
  is still read). `git add -A --pathspec-from-file=<f>` is scoped and runs.
- **Wrappers read through.** Git Bash's `cmd //c`, `cmd /k` and a bare `powershell <command>` (and `-Com`) are
  unwrapped by git, delete, kill and budget guards, as `bash -c` already was.
- **Gaps closed.** `git add *`, `":(top)"`, a pathspec of excludes only (`git add -A ':!x'`), `git commit -m x .` /
  `-- .` / `:/` are whole-tree sweeps; `HUSKY=0`
  skips hooks like `--no-verify`; `Stop-Process -ProcessName`, `kill $(ps -C node ..)` kill by name; `pnpm`/`yarn`/
  `bun <bin>`, `npm x` and `npx -y vitest@latest` are heavy runs. secret-guard matches test folders below the
  project root only (a project under `C:/Users/dev/specs/` got the relaxed test rules everywhere).
- **The heredoc scan is linear.** 160 KB of `a<<b` openers took 17 s, past the hook budget, so the guard was
  skipped; now about 17 ms. budget-guard's header gives the measured listing cost (about 510 ms median, not 300).
  A loop that waits on the live run's PID and then starts the check is still refused: a bounded wait ends and
  starts the second run anyway.

Per-turn hooks:
- **An unarmed chat starts no node.** gates.ts took any notify marker on the machine as "armed", so while one chat
  waited for a phone message every other chat started `node notify.mjs` on each prompt, Stop and resume
  (250-1100 ms each). It now checks the chat's own marker.
- **The handoff reminder** recognises "хэндофф", "хендоф", "хэнд-офф" and "hand off" as the ask itself. The economy
  and after-compact texts say "the Grep tool", as the reads line does. The reads line names only the read tools the
  agent has. With no home folder variable nothing is written under the drive root.

notify, hold, proof, tune, unfinished, cleanup, prune, scrub (makarasty-tools):
- **Git Bash path conversion undone for text.** An argument that starts with `/` arrives as
  `C:/Program Files/Git/...`, quoted or not: a hold reason or evidence, `--where`, a notify label and a proof
  selector or block text were stored mangled. `tools/skills/lib/msys.mjs` undoes it (only under Git Bash, only
  that prefix); hold's SKILL.md puts free text in single quotes, since double quotes ran backticks and lost `$5`.
- **notify** reads only the last 8 MB of a transcript (a 587 MB one hit ERR_STRING_TOO_LONG, so a Stop another
  hook blocked went out as finished), and claims an undelivered message by a rename before resending it: two chats
  reopened at once sent every unsent message twice in 8 of 8 runs, now 0 of 8.
- **hold**: the index is written by temp file and rename; an empty item file left by a killed `add` no longer fails
  `check` forever; a title cut keeps whole emoji; `last` skips another live chat's hold; a paste naming thousands of
  image paths takes 0.4 s instead of 81 s. `last` also skips an open chat idle for hours.
- **proof** writes blocks.jsonl by temp file and rename and skips a torn line instead of failing every later call.
- **tune**'s lock holds pid, start and a time limit, so a dead scan's lock or a reused pid no longer blocks it.
- **unfinished**: the secret mask was quadratic (1 MB never returned, a 100 MB transcript took 88 s); it is anchored.
- **cleanup** never offers a folder holding a git checkout from its temp, scratch, downloads and videos rules (a
  worktree with uncommitted work in Temp, untouched three days, was offered as a safe delete); ids carry a hash of the path, so "Setup (1).exe" and "setup-1.exe" differ;
  the scratch rule covers the current `%TEMP%\claude\<hex>\<session>` layout with the live-session hold.
- **prune**: `restore` really detaches a tree whose branch name was taken meanwhile; a worktree holding git-ignored
  files other than build output (`.env`) is asked about with the files named, not trashed as clean; a live
  run's lock is not stolen after 10 minutes, and two runs taking over one dead lock cannot both win (tune too).
- **scrub** leaves `/rewind` checkpoints (`file-history`) alone, since masking them writes asterisks into your
  files on a rewind, skips installed skill docs, and with `--root` reads only that folder. Its secret patterns are
  linear: a 120 KB line of `a-` took 22 s, 400k-char runs of `sk-`, `eyJ` or `BEGIN` timed out; now 4-20 ms.
- **confirm** refuses an empty session id and reads only the last 16 MB of the transcript (a 629 MB one could
  never grant a delete). cleanup's `admin <id>` rejects an unknown id before its two-minute scan.
- **inbox**: coordinator verbs — pick the account for a project's task (live chats first, then most chats, else
  ask), list chats of every app profile, keep a list of handed-out work, night pause and morning resume by message
  (M63).
- **commit**: a file another chat also edited is committed only when every hunk is this chat's; git runs with
  `core.quotepath=false` so Cyrillic names print as themselves.

Fleet (makarasty):
- **`fleet-gate.mjs prove` records no false proof.** A `before` the shell could not start (exit 126 or 127) was
  taken as a failing reproduction; `check` now refuses it, and a `/usr/bin/...` that Git Bash turned into
  `C:/Program Files/Git/usr/bin/...` is recorded as typed.
- **The fleet gate hooks** treat a fleet record as live only while its run exists, is not FINISHED and the record,
  the run folder or its claimed/done queue changed in the last two days (50 of 61 records here pointed at gone
  runs, and each spawned a node per tool call); the
  SubagentStop reply check works on transcripts over 4 MiB. The coder and reviewer agents say the 3-line reply a
  dispatched worker owes.
- fleet-init: step 0 asks the operator to trust the project's parent and Claude's temp root once, so new run folders
  open without the trust dialog.

## makarasty-tools 1.17.3 — 2026-11-11

- **Inbox for every chat (`/makarasty-tools:inbox`), off until `inbox on`.** Every chat with makarasty-tools writes
  what it waits on to `~/.claude/makarasty/inbox/`: each AskUserQuestion, each end-of-turn box with a question, each
  own_initiative session card. The dialog still shows in the chat; whichever answers first wins, and an inbox answer
  goes back as the dialog's own result (the open dialog is closed). Box and card answers go back as a prompt the
  chat's own timer submits when it is idle. After 2 minutes unanswered the asking chat adds a plain explanation
  (a small model over its last messages) and sends one phone message through notify. The inbox chat lists
  everything explained, asks once, starts a chosen card itself. Hook `tools/hooks/inbox.ts`, script and pure core
  `tools/skills/inbox/`, tests `tools/hooks/inbox.test.ts` and `inbox-selftest.mjs`. Need and probes: M63.
  The inbox chat's own dialog closes by itself once every item in it was answered in its own chat. Known limit: a
  box whose yes starts a session cannot be answered from the inbox (the app takes a plugin prompt as an automated
  event); its chat needs the click. Each item carries a one-click link to its chat (`CLAUDE_CODE_HOST_SESSION_ID`); a
  chat under another account (another app profile) opens with `inbox.mjs open <id>`, which hands the quoted link to
  that profile's own app copy; the plain `claude://` link opens the default app, not that window.

## makarasty 1.16.0 — 2026-11-11

- **Slot leads, opt-in probe.** New agent `makarasty:fleet-lead` (Sonnet, medium; tools Agent, Bash, TaskStop):
  one per repo slot, it runs dispatch, a foreground coder, `coded`, a foreground reviewer, one fix round and
  `finish`, and returns one line (`DRAINED`, `RETIRED`, `WAITING`, `STOPPED` or `ESCALATE`). Every judgement
  escalates to the coordinator. On only with `leads: on` on the `pace:` line (`docs/ONECHAT.md`, "Opt-in: slot
  leads"); default off. Aim: the coordinator grows by a spawn and a line per task instead of 13.5-20K (M58).
  Probe results: `docs/MEASUREMENTS.md` M61.

## makarasty 1.15.0, makarasty-tools 1.16.0 — 2026-11-11

Built from transcript evidence (M57-M59), then a review, a red team replaying hold dictation and two more
review rounds.
- **hold keeps every word and every item.** One folder per session, one file per item with the operator's text
  verbatim (written with the Write tool and `hold.mjs add --from`, so a `HOLD` line, `$(...)`, quotes or a
  `/route` in a paste reach the file unchanged), screenshots copied out of Temp at once, and an ack line that
  shows what was stored: the heard word first, `?` on an uncertain one, `(+ to NN)` / `(= NN?)` instead of a
  silent merge. Nothing is asked while collecting; at the codeword one question round settles the `?` words and
  merges, unless the operator says to go at once. Each item ends `done | partial | not-done | merged | dropped`
  with evidence, and `hold.mjs check` refuses the report while any item is open. `carry` moves unfinished items
  into the next hold; a second hold in one session starts a fresh list. Evidence: 19 lists and ~12 sessions —
  acks the operator could not check, mis-heard words guessed, 3 of 19 lists with statuses, the same complaints
  three days running.
- **Reversible questions no longer stop the run.** An open AskUserQuestion blocks the coordinator turn (M59:
  p50 176 s, p90 1142 s, 15 relaunch asks ~4 h). A choice whose effects stay in tasks tagged `depends-on-ask`
  is filed with `fleet.sh ask-operator`, notified, and defaults to its recommendation after `ask_default_min` 10;
  a late answer lists the tasks built on the default. Deletes, outside actions, stopping processes, another
  chat's code, scale, pace, mission meaning and mockup choices are still asked.
- **Relaunch at DRAINED is a card, not a question:** nothing is in flight, so the click is the consent.
- **status.txt** on every watch tick (done/total, in flight, ETA, PAUSED or waiting-for-card since), and
  `eta:` in `fleet.sh status`. An optional pick-up check (a scheduled task every 15 min, consent at plan time,
  removed at the end) messages the operator when the coordinator has died or the card waits over an hour.
- **Disk:** `disk_floor_gb` 20 / `disk_clear_gb` 30 over the run, temp and home volumes; `next` holds new work
  below it and names the volume; workers list the scratch folders they make, and only those are offered for
  deletion, with the operator's yes.
- **Mockup rounds** keep the operator's words in `reports/<subject>.req.md` (`fleet.sh req-add`, must/nice,
  supersedes); a separate reviewer grades every variant against them; at most 3 variants.
- **Foreign code blocking the end commit:** a policy set at plan time (`foreign=wait|fix|leave`); `fix` only
  touches committed foreign code, never another chat's uncommitted file.
- The separate-chat machinery moved from fleet-plan and fleet-wait into `docs/CHATS.md`, out of what a one-chat
  coordinator loads.

## makarasty 1.14.0, makarasty-tools 1.15.5 — 2026-11-11

From a review, a four-angle red team and a design consult over 1.12-1.13, plus probes [M57].
- **The drain survives what goes wrong around it.** It arms by its own marker (`.draining` written before
  `.ctx-warned`), so a crash between the two, or a resumed coordinator with a new session id, re-arms it instead
  of skipping to the 800K ask. An operator "no" is `fleet.sh undrain <run>`; the drain comes back at the next
  step. `drain_cap_min` 60 (task p90 48 and 59 min [M57]): after it, with claims still open, the watch prints
  `DRAIN TIMED OUT` once and the operator is asked anyway; paused time does not count. A lost DRAINED line is
  repeated in every exit-13 answer.
- **A draining run can still finish.** `next` gives 13 only when it would hand a task out: an empty queue, or a
  last task another worker already holds, keeps its own answer, so slots write `.done` and the run lands. When
  the drain finds nothing in flight and nothing left, the watch says to land the run, not to relaunch. `dispatch`
  takes the same decision from `next`. A holder in its pane idle window is told to finish its claim; the wait
  loop also ends on `.retiring`.
- **One seat, one coordinator.** `resume --take-over` without coordinator-pending refuses (`SEAT TAKEN`) unless
  this session already holds the seat, and points a restarted coordinator to fleet-resume. The fresh coordinator
  detaches itself after the take-over; worker cards get the same one-minute recheck as the coordinator card;
  fleet-resume dismisses leftover cards. ONECHAT.md and RELAUNCH.md no longer tell a one-chat coordinator to ask
  at the first mark and stop its agents. The mark line drops the claim that reviews fall out of context (M49).
- **fleet-analyze reads every coordinator of a relaunched run** (found by the `--take-over` they ran, across
  worktree project dirs) and streams transcripts over 64 MB; hold-polish went from $21.9 to $254 [M57].
- **cleanup's `path-shadows` follows PATH order:** an empty file is listed only when no earlier PATH folder has
  the program; quoted PATH entries are read.

## makarasty 1.13.1, makarasty-tools 1.15.4 — 2026-11-11

- **A chat started from a clicked card detaches too.** Probed [M56]: the operator clicked an `own_initiative`
  card, the parent was woken on its turn end, and `detach_session` accepted it. The relaunch and handoff texts no
  longer name "placed from a card" as a reason detach is refused; only a shared worktree is.

## makarasty 1.13.0, makarasty-tools 1.15.3 — 2026-11-11

- **A relaunched coordinator no longer wakes the old one.** A session started with `start_session` stays linked:
  each turn it ends wakes the chat that started it. In run `2026-11-10-hold-polish` the 700K old coordinator relayed
  10 such wakes for 7.96M cache-read tokens [M56]. Now the old coordinator calls `detach_session` on the fresh
  coordinator and the worker chips right after they start; when detach is refused (a shared worktree, or a chat
  the operator placed) it says its last line and clears itself with `clear_session "self"`. It never archives
  itself while the fresh one shares its worktree, and never starts it with context `fork`. handoff detaches the
  same way.
- **Start rule from live probes [M56].** A turn a watch event began cannot start a session, an AskUserQuestion
  answer inside it included: the coordinator starts a card (`own_initiative`), keeps each card's `task_id` in
  `<run>/cards`, and as a fallback asks the operator to reply "запусти" in chat. On that reply it checks the run's
  own record (coordinator-pending gone, `fleet.sh contexts` listing the chip), not titles, dismisses cards nobody
  started and only then starts them, so a click plus a reply cannot start two coordinators.
- **Pause acks wait in one background shell loop.** 1.12.0's `notify_when_idle` never fires for desktop chats
  ("no idle subscription was made"). Worker chats are found on the unfiltered session list by title, since after
  a relaunch they were started by another chat.
- fleet-wait and fleet-resume allow the session tools they call; fleet-coder drops the browser tools nothing gave
  it a use for; MODELS.md says printed chips carry no model; `landed` clears the drain markers and `cards`;
  part g1 of the selftest runs from PowerShell (no `ls`); README explains `claude plugin test .` against `tools`.

## makarasty 1.12.0, makarasty-tools 1.15.2 — 2026-11-11

- **Sessions start with `mcp__ccd_session__start_session`.** The desktop app dropped `spawn_task`, which
  `relaunch`, `retire`, the planner's chip trailer, fleet-plan, fleet-resume, handoff and the docs still named.
  A `CHIP NN` block now carries `title:`, `background:` (was `tldr:`, at least 80 characters as the tool asks)
  and `prompt:`. `initiation "user_asked"` only on a turn the operator's own message began; a watch line, an
  AskUserQuestion answer inside a watch-started turn and every `retire` use `own_initiative`, a card the
  operator starts. handoff prefers `hand_off_to_session` for this chat's own unfinished task.
- **The run drains before a coordinator relaunch.** All four runs of 2026-11-04..10 relaunched at the 700K
  mark and stopped 2-3 subagents mid-task (a fresh coordinator cannot adopt them). Now the first crossing of
  the mark writes `<run>/.draining`: `next` and `dispatch` hand out nothing (exit 13, not a pause), a worker
  holding a claim still gets HOLDING, the watch prints `DRAINED` once when no claim is open, and only then is
  the operator asked. At the next step (800K) with claims still open the ask comes anyway. The mark itself is
  unchanged. Markers in docs/PROTOCOL.md.
- **STALL prints once per unchanged state.** The watch repeated it every 10 minutes while only operator
  checks were left.
- **Pause ack for separate chats** is one `SendMessage` with `notify_when_idle` per worker instead of a
  status read every 20 s.
- Selftest part e expected the old context-reminder wording; CLAUDE.md says why `claude plugin test .` fails
  `tools/hooks/gates.test.ts` (it runs under the root hooks module).

## makarasty-tools 1.15.1 — 2026-11-11

- **cleanup finds an empty file that hides a program.** An empty, extensionless `C:\Windows\System32\powershell`
  made every `powershell ...` an agent ran from the PowerShell tool open Windows' "How do you want to open this
  file?" dialog: PowerShell resolves the bare name to that file before `powershell.exe`. The new `path-shadows`
  rule (admin tier, type `shadows`) lists any 0-byte extensionless file in a PATH folder named like a program
  there, and `admin` writes its `del` into the elevated .bat. Non-empty ones (`nodejs\npm` for Git Bash) are left alone.

## makarasty 1.11.2 — 2026-11-11

- **An operator-only action is asked like any question, not through the next-step box.** 1.11.1 ended the
  coordinator's turn with `wrap_up` for it, which leaves a live run with nothing pending; it now follows the
  question rule in full: work in motion first, one push, one `AskUserQuestion`, recorded in `STATE.md` so a
  later wake does not push again.

## makarasty 1.11.1 — 2026-11-11

- **What only the operator can do reaches them like a question.** A coordinator that needs the Browser pane
  opened, a sign-in or a command run, or that spots a "your call" in a status list, now sends a push and ends
  the turn with the desktop app's next-step box (`wrap_up`, `blocked: true`) instead of a bold line among task
  ids that a person coming back hours later scrolls past.

## makarasty 1.11.0, makarasty-tools 1.15.0 — 2026-11-09

- **Deletes need the person's own answer, item by item.** After real incidents (38 items gone on "Да, всё", a
  worktree a live chat used trashed, trash emptied for good on "а это почистить?"), `cleanup apply`, `prune trash`
  and `prune empty` act only on ids granted by `tools/skills/lib/confirm.mjs`: the scan's numbered list, a
  selection read from this chat's transcript (a bare "да", a typo or a stray word is asked again), a restated block
  naming every item, its size, undoable or FOREVER, and what is left alone, then a second answer that is exactly
  the label per class. The grant is for this session, this repo or machine, 30 minutes, one use, checked inside the
  lock on the final pick. A compact summary or a subagent's record never counts as an answer.
- **One liveness rule for chats** (`tools/skills/lib/live.mjs`): pid with its start time, an ended marker the
  SessionEnd hook writes (not on `/clear`; removed on SessionStart), and the last transcript event, never the file
  mtime. On this machine 16 running chats read as 6 live and 10 idle, idle up to 76 h [M55]; idle still holds, and
  the hold now names the chat, its first prompt and its idle hours. `prune` reads event times, fleet `procs` and
  `chipTakenBy` honour the marker, and `procs` checks the start time on Windows.
- **`fleet.sh dispatch`** claims, saves `before.diff`, records a fix's before proof, writes the budget deadline and
  writes the worker's and reviewer's prompts to files: the Agent prompt is one line. `coded` releases implement
  and design tasks waiting by `after:` when the coder finishes; `rearm` gives a re-spawn a fresh deadline; `next`
  takes the longest task first. A coordinator paid about 9 k of context per spawn, not the 3-4 k estimated; dispatch
  plus 3-line reports take out an estimated 18% [M54].
- **Reports go to files.** A worker writes `reports/<id>.md` and replies in at most 3 lines and 400 characters; a
  SubagentStop hook sends a longer reply back once.
- **The watch speaks only when there is something to do in one chat:** no `task finished`, `.done` or STALL lines,
  and it prints `budget-elapsed-<id>` from the deadline file, so the per-task clock is gone. `docs/ONECHAT.md` opens
  with a 2 KB card instead of asking to be re-read whole.
- **A fleet worker's wait loop ends after 60 minutes.** A guard against every unbounded background wait loop was
  measured and not built: it would have refused 26% of background calls and caught none of the ones that hung [M55].

## makarasty-tools 1.14.3 — 2026-11-05

- **Shell guards cover the Monitor tool.** A Monitor `command` runs in the Bash shell, but git-, kill-, delete- and
  budget-guard matched only Bash and PowerShell, so `git reset --hard`, `taskkill /IM`, `rm -rf` or a second
  whole-suite run sent through Monitor went unchecked. They now check it as Bash. budget-guard does not ask a Monitor
  for a kill-after limit: its `timeout_ms` is one. loop-guard collapses whitespace in Monitor commands too.

## makarasty 1.10.4, makarasty-tools 1.14.2 — 2026-11-04

- **Kill hints work from Git Bash.** Git Bash rewrites `taskkill /PID` into `C:/Program Files/Git/PID`, so the
  advised command failed there. kill-guard, cleanup and fleet-wait now also give `taskkill //PID <n> //F`.

## makarasty-tools 1.14.1 — 2026-11-04

- **kill-guard refuses `taskkill /T`**, with or without `/PID`: a tree kill takes every child of the PID, other
  chats' processes included. Kill the one PID (`taskkill /PID n /F`), then each child you own by its PID.
- **budget-guard counts `--changed` as a heavy run** (`vitest --changed`, `--changed HEAD~1`, `npm test -- --changed`):
  vitest walks the import graph from the changed files and can run most of the suite. `--changed <file>` and
  `--related` stay scoped.

## makarasty 1.10.3, makarasty-tools 1.14.0 — 2026-11-04

- **handoff works again.** 1.13.0's git-guard refused the scratch-index snapshot (`GIT_INDEX_FILE="$i" git add -A`),
  so every handoff from the main checkout lost its patch. A sweep (`add -A`/`-u`/`.`) now passes under a scratch
  `GIT_INDEX_FILE`; not when the value is the real index (basename `index`), a `$(...)`/backtick/`${...}` expansion,
  or after `Remove-Item Env:GIT_INDEX_FILE`. `commit -a` and destructive rules still apply under it.
- **git-guard refuses `git commit --amend` without `--only` or your own paths** (`-- .` counts as all paths), so
  other sessions' staged files stay out. **And `git commit`/`git push` piped into `tail`, `head`, `tee` or
  `Select-Object`**: the pipe hides git's exit code, so a failed hook reads as success. `pipefail` passes.
- **New generated-guard:** Edit/Write of a compiled `.mjs`/`.js` listed in `src/build.sha256` is refused; edit the
  source and rebuild.
- **notify sends the status line only.** The last 500 characters of the reply go out only with
  `MAKARASTY_NOTIFY_EXCERPT=1` (or `"excerpt": true`), with URLs, tokens, keys and `key=value` secrets blanked, and
  never to public ntfy.sh.
- **The 700K reminder says save state and keep working**; a handoff is offered only when the person asked. Fleet
  retirement is unchanged.
- **Skills:** review and finish loop until a clean round or three rounds; finish does not push with a confirmed bug
  open. Every subagent spawn carries `effort`. prune, scrub, proof and tune spell the script path in every call
  (shell variables do not survive between calls). redteam attackers stay read-only. review's checks get a live-run
  check and a kill-after. commit and ship may run their own grep/awk secret scan. Trigger fixes: "закоммить только
  своё и запушь" (ship), "unpause the fleet" (fleet-pause), explain no longer claims "можно деплоить?".
- **Docs:** junction deletes match [M45] (`rm -rf`, `rd /s`, `Remove-Item -Recurse -Force` unlink; `git worktree
  remove` and a glob through the link empty the target) in cleanup, WORKTREES, CLAUDE.md and README; COMMANDS.md
  sizes measured.

## makarasty-tools 1.13.0 — 2026-11-04

- **New kill-guard: no kill by process name.** Refuses `taskkill /IM` (and `/FI` on anything but a PID), `pkill`,
  `killall`, `Stop-Process -Name`, `Get-Process <name> | Stop-Process` (also inside `ForEach-Object { }`),
  `Stop-Process -Id (Get-Process <name>).Id`, and `kill $(pgrep x)` or `ps | grep x | xargs kill`, through
  `sudo`/`timeout`/`env` wrappers, `cmd /c`, `bash -c`, `powershell -Command` and heredocs fed to a shell. A name
  matches every process of that name, other chats' dev servers included. By PID passes: `taskkill /PID n /T /F`,
  `Stop-Process -Id n`, `kill n`. `MAKARASTY_KILL_GUARD=off` turns it off.
- **git-guard refuses `git add -A`, `-u`, `--all`, `add .` and `commit -a` in a shared tree.** They stage or commit
  every chat's uncommitted files. Scoped forms (`add -A src/`, `add -n .`, `commit --dry-run -a`) pass. They run in
  a chat's own worktree (`.claude/worktrees`, temp dir, a root-level `wt*` folder such as `C:\wtmerge`) and in a folder
  the same line creates with `git init <path>` or `git clone`. Other discards stay refused in a `wt*` worktree.

## makarasty 1.10.2, makarasty-tools 1.12.0 — 2026-11-03

- **Findings are named, not dropped** [M53]. A new line goes to every main session (startup, clear, resume,
  compact) and, through SubagentStart, to every subagent: a defect noticed beyond the task goes in the reply, and the
  model asks before fixing it. In an A/B, a terse-reply rule from another plugin made Haiku name the extra bug in
  2/10 runs (bare 10/10). This line brought it back to 8/10, with no unasked fixes. `MAKARASTY_FINDINGS=off` drops it.
- **Working rules beside the economy text.** Four habits that cost hours in measured runs, until now only in fleet
  docs: Edit only after the Read tool [M25] [M31]; wait for the completion notice, never poll [M52]; ask only what is
  the person's to decide [M52]; call a fix done only after a check ran [M23]. `MAKARASTY_ECONOMY=off` drops them too.
- **git-guard lets `git worktree remove -h` and `--help` through** [M53]. A plugin-combination run found it refusing
  the help text in 34 of 37 runs that asked for it.
- **Kill-after limits are sized to the command** (`timeout <S>`, about twice its measured time) instead of a fixed
  `timeout 590`, in fleet-coder, fleet-reviewer, fleet-run, ONECHAT and GATE.
- **Wait for the event, not for a clock; ask only what is the operator's** [M52] (PROTOCOL, forge). handoff waits
  for completion notifications.
- **`tasks/queue-open` gets one line of content** in fleet-call, fleet-design and fleet-plan; `next` prints it.
- Challenge agents in cleanup, game and update are `Explore`. unslop's temp files are keyed by session id.
  The commit and ship triggers catch the typos "закомить" and "закомить и запуш". blindtest stops, and hold
  reports the visual check as not checked, without the makarasty plugin; README lists the tools that need it.
- Wording: fleet-triage 254 findings, fleet-collect "one other thing", fleet-plan "These rules", fleet-wait
  "(its step 3)", fleet.md drops "since 1.5.7".

## makarasty 1.10.1, makarasty-tools 1.11.0 — 2026-11-03

- **Handoff keeps what receivers kept losing** (from 10 real handoffs and their receiving chats). The chip prompt
  opens with the five-line readback (skipped by 9 of 9 receivers when it sat mid-prompt). Goal quotes every part of
  the request and keeps the person's bar for done; every open defect goes into Next. Source holds both session ids and
  the transcript path. State lists staged files with their owner and other live chats. Scratchpad files the next chat
  needs are copied beside the handoff; drafted text goes in verbatim. Agents still running report to a file before the
  chip; nothing writes to the file after it. The person section holds only what CLAUDE.md and memory do not.
- **Handoff patch skips untracked files over 1 MB** and lists them in `<name>.untracked-big.txt` (some patches
  reached 494 MB of PNGs).
- **Fixes from a prompt audit.** `unreached` examples in fleet-scenario, fleet-design-eye and fleet-profiler carry the
  `reason` key `find` requires; their `find` call uses a quoted heredoc, so an apostrophe no longer breaks it. ship
  points to `commit/SKILL.md`, not a missing `commit.md`. cleanup reads a live run from `coordinator` and `FINISHED`,
  not a nonexistent `watch.sh`. tune's `--arms` example uses priced model names. unslop's steps are renumbered; a
  fleet-plan sentence is finished.
- **Question rounds are `AskUserQuestion`** in fleet-plan, fleet-design and fleet-call, split into calls of four;
  fleet-plan's own 8b rule already said so.
- **cleanup unlinks every link before a recursive delete** (`find -type l -exec rm {} +`, then `rm -rf`): `rm -rf`
  follows a junction left in place as `rmdir /s` does.

## makarasty-tools 1.10.1 — 2026-11-02

- **Screenshots in the economy rules.** Routine ones at scale 0.5 in a subagent; one the person wants to see is shown. A soft rule.

## makarasty 1.10.0, makarasty-tools 1.10.0 — 2026-11-02

- **Reviewer on Opus, coder on Sonnet, by measurement [M51].** Default reviewer: Opus `medium`, `high` for a diff over
  about 400 changed lines or one touching security, auth, money or data deletion (Opus medium matched high on 10 real diffs, $0.30
  against $0.50; only high found the 3 bugs in a 550-line permissions diff; Sonnet alone gave 4 false findings against 1).
  Coder: Sonnet `high`, never `medium`, always followed by the Opus review; a rejected task gets its fix round on Opus;
  diagnosis, judgement and design go straight to Opus. Tables in `docs/MODELS.md` and `docs/ONECHAT.md`, spawn lines in
  `fleet-run`, `fleet-plan`.
- **The router no longer sends `Explore` to Haiku.** It fired on 4 of 70 spawns (an explicit `model` wins). Removed from
  `router.ts`, its test, `MODELS.md` and `README.md`.
- **Brief once.** A worker prompt carries the content of `RULES.md` once and says not to read it again (it was read 59 times in
  one run, a review prompt file 101).
- **Narrow agent types.** Commands name `fleet-coder`, `fleet-reviewer` and `Explore` instead of `general-purpose` (79k
  tokens at start against 46k and 40k); the `fleet-plan` cold read is now an `Explore`.
- **Shorter skill descriptions** for blindtest, craft, explain, scrub, selfreview, unfinished, update (no use in 30 days) and
  ship, commit, say, cleanup (longest); triggers kept.
- **Token economy rules in every session.** `gates.ts` hands a short rule set (narrowest agent, model and effort on every spawn, noisy work in subagents, grep and line ranges, scoped checks) to the main chat as SessionStart context on startup, clear, resume and compact; subagents get none. `MAKARASTY_ECONOMY=off` turns it off.
- **New skill `tune`: re-check which model and effort each role uses** when a new model ships. Three steps, the
  first two free scripts over this machine's transcripts and git (`tune.mjs usage`: tokens and $ by model, role,
  effort, project, context size; `quality`: per coder model, review findings, fix-needed share, rounds, $ per task,
  owner corrections per main-chat model), the third a blind paired review on real diffs picked by sealed markers
  (later-fixed, multi-round, controls), run only after the printed cost estimate is accepted. Models come from the
  transcripts, prices from the one `fleet-analyze` table, arms that mix model and effort are flagged. The result is a
  dated role table in `~/.claude/makarasty/tune/`, diffed against the previous run.

## makarasty-tools 1.9.1 — 2026-11-02

- **`git-guard` closes five bypasses.** A heredoc took the rest of its opening line with its body, so
  `git commit -F - <<'EOF' && git push --force` ran unchecked; now only the body goes. A heredoc piped into a
  shell (`cat <<EOF | bash`) and a here-string to a shell (`bash <<< "git stash"`) are read as code. A
  substitution as the subcommand (`git $(echo stash)`, backticks, `git st$(echo ash)`, `$(echo git) stash`) is
  refused like a variable, and `git -C $(pwd) stash` no longer drops the subcommand. The PowerShell here-string
  strip no longer runs for Bash, where `echo a@' '; git stash; echo '@'` hid the stash.

## makarasty-tools 1.9.0 — 2026-10-28

- **`cleanup` scans the whole disk.** A by-hand cleanup of the owner's PC took nine Haiku scouts and an Opus
  judge, freed about 33 GB, and the judge overruled the scouts on 13 of 14 disputed calls (a 1.3 MB cache
  reported as 1.26 GB, a pinned browser build, a deliberate fallback runtime). The places it found are now a
  catalog, `rules.json`, read by a script, `machine.mjs`: a read-only `scan` in about a minute, then `apply`
  on the ids picked, which looks again first. Four tiers: safe (caches, scratch of ended chats, old app
  versions beside the one in use), close-app (held while the app runs), admin (a `.bat` the owner runs
  elevated, each step explained) and owner (games, programs, big files, never a default pick). Old versions
  are kept by what runs or what a pointer names, not by name sort. A live chat holds its folder and its
  scratch, checked per path at the moment of acting. Personal files go to the Recycle Bin only when they fit
  its free room, and count as recycled only when the bin grew by them; games open their own uninstaller.
  Every outcome is measured after the act and logged in `~/.claude/makarasty/cleanup-log.jsonl`. A
  machine's own places go in `~/.claude/makarasty/cleanup-rules.json`; `deep` runs the scouts and a judge
  for new ones. Windows only for now: the Windows rules carry `os`, and the few without it (build output,
  loose files, transcripts) are only listed or deleted elsewhere.

## makarasty 1.9.0, makarasty-tools 1.8.0 — 2026-10-26

Read from 6,017 prompts typed by hand across 1,485 chats on three accounts (2026-06-10 to 2026-10-26),
cloned chats merged. The commands below own instructions that were being retyped every task; each was
attacked by its own red team before release.

makarasty-tools:

- **`redteam` (new).** "Подними красную команду, поспорь с ней, исправь" appeared in 41 chats, all in
  October, with no command behind it. Three to five read-only Sonnet attackers, each with an angle picked
  for the target (a plan, an export, a tool, a change), every finding with its evidence; effort and time
  are not findings. An Opus judge confirms, refutes or marks each unclear. `--fix` edits only this chat's
  files, re-checks each fix with the attacker that found it, and stops after three rounds.
- **`finish` (new).** The sentence that ended most tasks, "ревью, красная команда, по кругу, закоммить от
  меня, запушь только своё": review `--loop`, redteam `--fix` and a review of its fixes, the narrow tests
  once, then `ship mine`. It works on the list of files this chat changed, asks before pushing commits it
  did not make, and commits nothing after a failing test.
- **`blindtest` (new), with the makarasty agent `fleet-naive-user`.** "Проверь тупым агентом" in 9+ chats.
  First-time-user agents with no access to the code or the page source try plain-language tasks on the
  live screen. Only a place users on two different models both hit counts; quotes are checked against the
  page. Fixes rename and move before they remove or add; `--fix` applies only renames and moves. The
  touched tasks re-run with fresh users plus one control task; a task that got worse, or a screen that
  grew with no gain, is reverted.
- **`forge` (new).** How to build a skill, command, hook, agent or plugin for a strong model: find the
  failure first, pick the lightest mechanism, the description as trigger, calm wording with the reason
  beside the rule, near-zero running cost, then prove it. `ab.mjs` runs prompts with and without the tool
  (or without one line) in empty folders with no user plugins, CLAUDE.md or memory, and scores the replies.
- **`craft` (new).** Refactor, DRY and test rules where a strong model still slips: pin behaviour with a
  characterization test, extract on the third copy, inline a wrong abstraction back, and keep only tests
  seen failing once.
- **`hold`** keeps its list in `makarasty/hold/<session>.md`, so a compaction, a handoff or a cloned chat
  loses nothing; items go in through a quoted heredoc (a pasted selector holding `$(...)` ran in the
  red-team probe). On the codeword it asks once: unclear items, the route (fix here or a fleet), cheap
  improvements. The handoff reminder now really waits while the file reads `collecting` (a PowerShell BOM
  included); before, that was only a promise in the skill text.

- **`unfinished` (new).** "Прочитай историю других чатов, что не закрыто" in 84 chats. A script reads this
  project's recent transcripts on every Desktop account (about a second for a week of the main project),
  merges cloned chats, masks pasted secrets, and prints a card per chat: last asks, last reply with its
  closing question, files edited and which are still uncommitted (worktrees included), open todos. The
  model then checks each "done" against the repository and groups the chats: open, done but uncommitted,
  waiting on the person, live.
- **`proof` (new).** Before and after shots of UI changes for an HTML report of numbered blocks, so the
  answer can be "блок 3 переделай". The pane renders the page to PNG (html-to-image, pinned by checksum) and
  posts it to a local receiver that needs a per-run token; the images reach the disk and never the model's
  context.
- **`prune` (new).** Merged local branches and clean stale worktrees go to an undoable trash inside the
  repo's own git dir: a trash ref first, then the branch ref; a worktree is renamed, never copied, and
  locked so git keeps its metadata. `restore` brings either back. Nothing empties the trash on its own: `empty`
  takes ids, `--older <age>` or `--all`, and unlinks every junction inside before it deletes. Remotes are never touched. It refuses a worktree with untracked,
  assume-unchanged or nested work, and a gone folder whose commit exists nowhere else.
- **`scrub` (new).** Secrets pasted into chats stay in the transcripts as plain text. A dry run counts them
  by kind and place without printing a value; `--apply` replaces each with asterisks of the same length,
  skips files a live chat may be writing, checks that every changed JSON line still parses, swaps the file
  in by rename and keeps its date. A key that reached a transcript was also sent to the model provider, so
  it still needs revoking.
- **`selfreview` (new).** This period against the one before, from the owner's own transcripts in about
  12 seconds: strict corrections, chats over 700k, cloned chats, skills never called, repeated instructions.
- **The handoff reminder** keeps 700k and every 150k [M49], and now says a handoff is for a change of phase:
  the first prompts of a continuation chat drew more corrections than chats that kept going past 700k.
- **Polish from an audit of every skill:** cleanup no longer suggests `git worktree remove` (the git guard
  refuses it) and hands stale worktrees to prune on a yes; `ship mine` skips reading the other chats;
  finish does not stop on review's leftover questions; commit does not ask about the default branch inside
  finish; unslop drops two rules its session text already carries; cleanup, update and game call their
  one-agent check "Challenge", so "красная команда" means one thing; shorter descriptions for blindtest,
  redteam, review, cleanup and hold.

makarasty:

- **`fleet-naive-user` (new agent)** for `blindtest`: screenshots and clicks only, no script, no page text.
- **The ledger check** counts citations in `tools/` too, where the tools' rules live.

## makarasty 1.8.0, makarasty-tools 1.7.0 — 2026-10-20

Ideas from outside, each written in our own words and code, then attacked by red-team rounds until the
false blocks stopped.

makarasty:

- **An implement or design task with a `test:` line needs a recorded passing run** before `finish` writes
  its done marker: `prove <run> <id> after -- '<test line>'`. The recorded command must be the test line
  (a `timeout N`, `cd X &&` or `VAR=x` prefix is fine), and a path under `owns:` that changed after the
  pass sends the coder back. `FLEET_UNTESTED=1` plus an `untested <id>: <why>` note closes a task whose test
  could not run, never one whose test failed. Gated on runs of `RUN_FORMAT` 2; a run already in flight
  (format 1) is not. `docs/GATE.md`, "test".
- **`file` warns about overlapping `owns:`** with no `after:` path between the two tasks (globs cut to their
  directory, `..` and absolute paths normalised, case-folded on Windows), and about a fix, root, implement or
  design task with no `owns:`. A note, never a refusal; at most five lines.
- **A scoped re-review after a fix round:** the reviewer gets the defect list, the fix diff and the task
  file, and answers ADDRESSED or NOT ADDRESSED per defect. Balanced pace is now one review, one fix round,
  one re-review; Fastest finish skips it.
- **The reviewer also looks for** an unrequested change, a test that cannot fail, and a `repro:` that does
  not assert the finding's symptom.
- **A fleet-coder ends with `DONE`, `DONE_WITH_CONCERNS: …` or `BLOCKED: …`.** After three failed attempts
  on a fix (an edit followed by a failing run) it stops; `BLOCKED: repro invalid` goes to the operator.
- **A cold read before launch:** one small agent reads only `RULES.md` and two or three tasks and returns
  the questions it would still need answered; they are answered in the files, not in chat.
- **Rulings I made:** each judgement call the coordinator makes is a `ruling:` line in `STATE.md`, and the
  collect summary lists them for the operator to overturn.

makarasty-tools:

- **Delete guard (new).** Refuses recursive deletes of the project, any folder that holds it, home and its
  non-cache folders, a drive root, the temp folder itself and the project's own `.git` (and `.git/objects`,
  `refs`, `HEAD`), in Bash, cmd and PowerShell, through wrappers, `bash -c`, `find -exec` and `npx rimraf`.
  It refuses only what the line shows: an unresolved variable or a pipeline into `xargs` or `Remove-Item`
  runs, and so does any other folder. Claude Code already refuses `rm -rf .` and `..`; the guard's real cases
  are `.git`, `find . -delete`, `cmd /c rd /s /q .`, `rm -rf "$PWD"` and `cd .. && rm -rf <project>`, which
  Claude Code runs [M45]. No link walk: rm, rd and PowerShell 5.1 unlink a junction and leave its target. A
  guard error lets the command through. `MAKARASTY_DELETE_GUARD=off`.
- **Budget guard (new).** Refuses a whole-suite test run or whole-project typecheck while another is live on
  the machine, and a heavy background run without `timeout N`. Scoped runs always pass; a run older than an
  hour counts as hung and is named, not counted. `MAKARASTY_BUDGET_GUARD=off`.
- **Loop guard (new).** After three identical failures, or a failing A,B,A,B, the result carries one note to
  stop retrying. Never refuses. `MAKARASTY_LOOP_GUARD=off`.
- **Secret guard (new).** Refuses a Write or Edit that puts a live-looking token into a project file; `.env`,
  `.env.local`, files outside the project, fake-marked values and tokens the file already held pass. Zero
  hits on the git-tracked files of the owner's repos [M46]. `MAKARASTY_SECRET_GUARD=off`.
- **antislop (new command).** `/makarasty-tools:antislop on|off|status|audit` runs a pinned copy of
  the antislop rules v3.2.21 (MIT) for UI work only: a six-line pointer at session start when on,
  `gate-hard.md` and `ui.md` read before the first UI edit, a short PASS/FAIL gate at the end.
  `scripts/sync-antislop.mjs --check | --apply <tag>` pulls a new release, checks its SHA and R-ID count, and
  writes nothing on a mismatch. On two briefs it removed emoji, sparkle icons, invented numbers and contrast
  failures at 1.3 times the cost of no rules [M47]. Its own MCP server, mode question and always-loaded core
  are not used.
- **Git guard:** quoted and abbreviated flags (`"--hard"`, `--har`), path checkouts (`src/`, `:/`,
  `--ours`), remote ref deletes, `--mirror`, `--prune`, `branch -f`/`-C`, `--autostash`, `reflog delete`,
  `gc --prune=now`, `-c alias.*`, `--attr-source`, and hook or signing skips (`--no-verify`, `commit -n`,
  `-c core.hooksPath=`, `GIT_CONFIG_*`, `--no-gpg-sign`) are refused. False blocks found by two red-team
  rounds of about 1,400 commands are fixed: glued messages (`-m"init"`), `branch -M main`,
  `checkout -qb`, `$DOTNET restore`, `$MAKE clean -f`, relative `core.hooksPath .husky`.
  In a chat's own `.claude/worktrees/` worktree or a temp clone, discards run: 43 of 51 historical denials
  were there [M46]. The denial no longer suggests `git show HEAD:f > f`, which discarded the same way.
- **unslop:** measured against no rules on Sonnet, replies were half as long (0.49 ± 0.19) with fewer tells
  and the facts kept [M44]; a rule set that stays under the old size and asks for shorter replies, a separate catalog for
  rewrites ("not X but Y", chat residue, bold-label bullets, English dash rationing, Russian hard bans), and
  `hooks/unslop-scan.mjs`: tells with line and column, density, and `--before <a> <b>` as a fact lock that
  lists lost numbers, versions, URLs, paths, code and negations.
- **commit / ship scan the staged diff for secrets** and print only `file:line` and four characters.
- **review** fetches a PR without `gh` (`git fetch <remote> pull/<n>/head`), diffs against the PR's real
  base, reads the history of a deleted guard before judging it, and hunts silent failures.
- **notify:** ntfy priority and tags per event, and "finished after 12 min", counted from a resume.
- **cleanup** knows headless browsers, MCP servers and stream-json `claude` left by ended chats, and keeps
  what a live chat, terminal or IDE owns. **game** measures FPS and 1% lows with PresentMon before and after.
- **Skill descriptions are shorter:** always-on cost ~2,242 to ~1,905 tokens, every trigger phrase kept;
  6 of 6 trigger prompts still route [M44].
- **No process on an ordinary prompt:** the notify check and the context reminder are function hooks
  (`hooks/gates.ts`) that read a folder and the session's token count in about 1 ms. A three-prompt session
  started 0 hook processes where it started 9 (one Stop hook exited 1 every session); time per prompt was the
  same within noise [M48]. node starts only when a notification is armed, or once per session before the
  first token count exists.

## makarasty 1.7.0, makarasty-tools 1.6.2 — 2026-10-19

A fleet runs in one chat by default. The coordinator claims each task and spawns one fresh background
subagent for it; separate worker chats and worktrees are opt-ins. `docs/ONECHAT.md` is the loop.

- **One chat, one subagent per task.** `fleet.sh chips <run> <NN-MM> <lane> --agents` registers slots
  (`SLOT NN lane <lane>`) instead of chips; the coordinator calls `next`/`finish`/`drained` for a slot and
  the subagent only `find` and `beat`. A fresh subagent starts at 40-75 k against 92-107 k for a chat
  worker and re-reads no earlier task; estimated 14-20 % cheaper than the chat-plus-subagent hybrid of
  2026-10-14, 2-3x cheaper than inline chat workers [M43]. An estimate: measure the first one-chat run with
  `/makarasty:fleet-analyze`.
- **The hooks see subagents.** A subagent shares its coordinator's session id, so pause, the memory guard
  and the contract hook let every worker subagent through. They now key it as chip `agent-<agent_id>`;
  the coordinator itself is never held. `paused <run> NN` acks a slot.
- **No worktrees by default.** Code tasks carry `owns:`; overlapping tasks are ordered with `after:`.
  Workers never commit; one Haiku `[mech]` agent commits with explicit paths, once at the end by default.
- **Round 0 of every plan is one form of at most four questions** (scale, speed or quality, economy,
  isolation and commits), each with a recommended answer, asked at once, `fast` included. The answers
  become a `pace:` line that sets the tiers and review rounds. Width stays measured, never asked.
- **The coordinator's model decides, cheaper ones do the rest:** commits, `STATE.md` and log reading on
  Haiku, merges (worktree opt-in) on Sonnet. `docs/MODELS.md`, "Pace".
- **One chat has one live browser tab** [M42]: a background tab drew 0-2 frames a second while the
  foreground one drew 272-300. In one chat the pane lane is 1; more than one live check at once is the
  separate-chats opt-in.
- **The frame gate is read twice, always,** and the second reading is believed at any value: the first
  reading of a freshly opened background tab was 268 fps, the next ones 1-3.
- **`git-guard` closes its holes:** `2>&1`, `> file`, `$(...)`, backticks, subshells and `bash -c` /
  `sh -c` / `eval` no longer hide `git stash` or `reset --hard`; `git worktree remove`, `push --force`
  (not `--force-with-lease`) and `branch -D` are refused. A pipe into a shell and aliases are still
  not seen.
- **A shared checkout without losing anyone's work:** a fix or root task records its `prove ... before`
  at the claim, before the coder edits; `before.diff` is saved at the claim; each finished task writes its
  file list to `tasks/claimed/<id>/files`; the end commit is `git commit --only -- <paths>` from those
  lists minus `dirty-at-start`, so the operator's staged work stays out; reviews also read untracked files.
  Verify and pane tasks run `after:` their wave's code tasks. A resumed chat re-takes the coordinator seat
  with `chips ... --agents`. While paused, the coordinator writes `STATE.md` itself.
- **An end-to-end one-chat run passed** on a scratch project: a real fix proven before and after, a new
  function, a verify task, real background subagents as workers and reviewers, one `commit --only` at the
  end, and the operator's staged and unstaged changes untouched. Its 14 doc gaps are closed: `RULES.md` is
  defined, `landed` follows `merge`, porcelain lines are stripped to paths, an empty `owns:` never becomes
  an empty pathspec, and which slot takes a verify task is stated.
- **STALL is information in one chat;** only the task's own clock stops a subagent. The watch counts no
  heartbeats, so a STALL after ten quiet minutes would have stopped healthy long tasks.
- **A rejected cheap-tier task is re-run once a tier up,** then asked of the operator.
- The contract hook blocks in one chat (it could not write its marker without `chips/`); the verify
  exemption holds only while every open claim is a verify or pane claim; `after: [a, b]` is accepted; `prove` is
  quiet about an ignored run directory; every self-test part has a kill-after limit
  (`FLEET_SELFTEST_TIMEOUT_MS`, 10 minutes), reported as a failure; `width` says the pane lane is 1 in one
  chat.
- **`git-guard` takes the rules it lacked** (`filter-branch`, `reflog expire`, `update-ref -d`,
  `read-tree --reset`, `rm -f`, `gc --prune=now`), sees a quoted or full-path git binary, and refuses a
  subcommand held in a variable rather than guessing.
- **A fix or root that cannot be proven is handed back, never finished:** `fleet.sh handback` on a slot
  releases the claim and re-files it as `<id>-r<k>`, carrying its `before` and moving every `after:` to the
  new id; a second failure goes to the operator. A root ruled a coincidence closes with `FLEET_REFUTED=1`
  and a `refuted <id>: <reason>` line in the slot's notes; a fix still needs a `before` that passed.
- **`fleet-gate check` counts only what the task owns:** another task's edit in the shared checkout no
  longer passes for this task's change, and `owns:` is read relative to the folder holding `.fleet`, so a
  project below the git top proves. Root tasks from `cluster` get `owns:` before the first claim.
- **Clocks stop with their subagents** on pause and relaunch, so a resumed run never meets an old clock.
  The watch is read through Monitor where the host has it. `fleet-profiler` reads the frame gate twice and
  files through `find`. The memory hook reads `needs:` the way `next` does.
- `git-guard` also refuses `git apply -R` (not with `--cached`, `--check` or `--stat`), `-qf`-style
  combined flags, `find -exec` and `submodule foreach` wrappers, shell keywords and brace blocks
  (`for ...; do git checkout -- ...`, PowerShell `{ git stash }`), `cmd /c` and `pwsh -Command` with an
  unquoted command, and `timeout`/`nice`/`sudo -u` wrappers; it lets `--force-create`, `rm --cached`,
  `stash create` and non-git commands with a variable head through.
- **Every command that can hang carries a kill-after limit** (`timeout 590 <cmd>`, about twice its normal
  time) in `fleet-coder`, `fleet-reviewer`, `fleet-run` and the one-chat spawn prompt, and a hit limit is
  reported, never retried: the task clock stops a hung subagent, not necessarily the test run it started.
  Per shell: Bash `timeout 590 <cmd>` (exit 124) under the tool's own 600000 ms; PowerShell the tool's own
  `timeout` parameter, never `timeout` (timeout.exe); macOS without coreutils `gtimeout`; past 600000 ms,
  which both shell tools stop at, a background run plus `TaskStop`.
- **The memory guard sees a runner behind a wrapper:** `timeout 600 npm test`, `timeout -k 10 600 npm test`,
  `gtimeout`, `nice -n N`, `time`, `env X=1` before a test or typecheck run no longer escape the RAM gate.
  Nor do `time -p` (its `-p` was read as a project scope), `timeout --signal KILL 600`, `env -u X`, a shell
  `-c`/`/c`/`-Command` body or a PowerShell `{ }` block. That flag counts only after a shell's name, and
  quoted text naming a runner runs none, so `rg -c "npm test"`, `grep -E "jest|vitest"` and
  `gh pr create --body "fix; npm test"` pass without spending the once-per-session warning.
- **A cluster root's `repro:` joins its members with ` || `**, not ` && `: its proof is of the seam fix
  (`before` fails while every member reproduces, `after` passes once one is resolved); a member that still
  needs its own change is proved by its own task.
- **`fixqueue` leaves a `repro:` with a backslash empty** (`node sub\x.mjs`, `.\gradlew.bat test`): `prove`
  runs it in bash, which read `sub\x` as `subx` and falsely reproduced. Write repros with forward slashes.
- **`prove` single-quotes each word of a multi-word command under bash/sh** (`'` as `'\''`): the double
  quotes it used let `price $5` and backticks expand.
- **The router never routes `fleet-reviewer`:** it is the independent check, so a tag on it is ignored.
- **`node scripts/fleet-selftest.mjs --jobs N`** (or `FLEET_SELFTEST_JOBS`), default 3, and it prints free
  memory and the live node count before it starts: as many parts as CPUs fought the verify budget when
  several sessions ran it.
- Fixes: the gate's Stop branch blocks with a reason when the guard printed none; `pauses.log` writes
  "resumed" before `PAUSED` goes; a reason with a newline no longer splits a log line; one helper writes
  `fleet-sessions/<sid>`; `docs/LANES.md` states the repo-lane cap the code applies; `.fleet/` is ignored;
  README lists `fleet-coder` and `fleet-reviewer`; `fleet-coder` reads with Read and Grep.
- **Fix tasks carry a runnable `repro:` in their frontmatter.** `fixqueue` writes a one-line command finding's `repro` there (empty for steps or prose, which the coordinator turns into a command before `prove before`); `cluster` gives a root its members' commands as `(a) || (b)`. PROTOCOL documents `repro:` and `test:`.
- **Below the git top, the end commit runs at the top:** `files` and `dirty-at-start` hold top-relative paths, so the `[mech]` commit runs `git -C "$(git rev-parse --show-toplevel)" add`/`commit --only`, and crash attribution prefixes `owns:` with `git rev-parse --show-prefix`.
- **On Windows `prove` runs a reproduction in bash, not cmd.exe:** `$SHELL` when it names a file, else Git for Windows' `bash.exe`, so `CI=1 node ...`, `./x.sh` and single quotes no longer fail as "not recognized" and pass for a red `before`; the line reaches bash through the environment, so `\\` is no longer collapsed to `\`. `repro:` is left empty for a line with a ` #` comment (it swallowed a root's later members) or a JS expression like `performance.getEntriesByType(...)`.

## Unreleased (folded into 1.7.0)

The self-tests are strict TypeScript, and the fleet's runs in a quarter of the time.

- **`node scripts/fleet-selftest.mjs`** replaces `sh scripts/fleet-selftest.sh`. The 3,737-line sh file,
  every case leaning on the state the cases above it left, is nine parts in `scripts/selftest/`, each
  building its own state, run at once on `node:test` (one process per part, three at once by default, `--jobs N`).
  The check names are the sh version's, one for one. 1,148 checks in 71-75 s on a 16-thread Windows box,
  against 1,128 in about 4.5 minutes; `--keep` still keeps the temporary directories.
- **`node tools/hooks/notify-selftest.mjs`** replaces `sh tools/hooks/notify-selftest.sh`: the same 137
  checks, 16.5 s.
- **The browser probes are TypeScript** (`src/probes/*.ts`, compiled to the same pasteable
  `scripts/design-probe.js` and `scripts/visual-probe.js`). On a test page with every defect they look
  for, the old and new probes return byte-identical JSON.
- The build-parity checks now cover the probes' tsconfig too, and the build manifest the self-test files.
  `scripts/fleet.sh` stays sh: it is the entry a worker calls.

Fewer tokens per task, from one live run measured end to end [M41].

- **Two lean subagent types, `fleet-coder` and `fleet-reviewer`.** Workers spawned `general-purpose` for
  fixes and reviews, which starts at 77-78 k tokens against about 40 k, and every turn re-reads the start.
  The reviewer is told not to edit. The router routes `fleet-coder` on a tag and never `fleet-reviewer`.
- **DELEGATE is a step of the task loop,** to `fleet-coder`, with the measured growth (a median 54 k per
  inline task, not 20-30 k): 6 of 11 workers ignored it and 55 % of what they re-read was earlier tasks.
- **A coordinator files what does not depend on an answer before it asks:** one ask held 110 minutes and
  7 workers ran dry.
- **`pause` and `resume` write `pauses.log`, and `fleet-analyze` counts that window as paused**, not as an
  outage. It also prints the carry-over share and the subagent start context, each beside its target.

## makarasty 1.6.2, makarasty-tools 1.6.1 — 2026-10-12

A chat that is not in a fleet pays nothing for the plugins.

- **The fleet hooks are one function hook** (`hooks/gate.ts`, on `tool.call` and `classic.Stop`). The three
  command hooks ran bash and node on every shell, edit, browser and subagent call of every chat, fleet or
  not, and bailed: 0.1-0.2 s a call idle, more on a loaded box [M40]. The gate checks
  `fleet-sessions/<session>` inside the engine and only a fleet chat reaches `fleet-memory.mjs`,
  `fleet-contract.mjs` and `fleet-guard.mjs`, with the same stdin and the same exit 2. Outside a fleet: 0.048 s
  a Bash call against 0.047 s with no plugin. A hook that cannot start lets the call through, as before.
  Needs Claude Code with function hooks (tested on 2.1.293 and 2.1.294); an older one runs no fleet hook.
- **A git guard** (`makarasty-tools`, `tools/hooks/git-guard.ts`): a shell call that would throw away
  uncommitted work is refused with the reason, in-engine, with no process per call. `MAKARASTY_GIT_GUARD=off`.
- **One line sends reads to the tools** (`tools/hooks/reads.ts`, on `prompt.compose`): 84 K of 115 K shell
  calls in four weeks were reads, each 0.1-1 s of harness against 0.02-0.07 s for Read or Grep [M40].
  `MAKARASTY_READS=off`.
- The tools plugin's three function hooks load from one module, `tools/hooks/index.ts`: the engine takes one per plugin.

## makarasty 1.6.1, makarasty-tools 1.6.0 — 2026-10-12

Cheaper runs without a weaker result: three weeks of the operator's transcripts were measured against the
account's own usage log first [M39], and only the levers that moved money were kept.

- **A model router** (`makarasty-tools`, `tools/hooks/router.ts`, a function hook on `agent.spawn`). A
  built-in `general-purpose` subagent spawned by Opus or Fable with no `model` runs on Sonnet when its description starts
  with `[exec]`, on Haiku with `[mech]`, and `Explore` runs on Haiku. Untagged work keeps the parent's
  model: a keyword guess was measured and dropped, because on a replay Sonnet lost one port of three on
  shell edge cases that its own tests missed. `/router` shows the counts, `MAKARASTY_ROUTER=off` turns it off.
  Function hooks are early access: tested on Claude Code 2.1.293.
- **Merge and `STATE.md` agents name Sonnet.** A merge on Opus cost $8.29 and 62 calls, on Sonnet $1.69
  and 28. Reviews keep their tier: moving them is exactly the loss of quality this release refuses.
- `docs/MODELS.md`: Haiku 5.5 in the roster, and the router. `docs/MEASUREMENTS.md` M39: where the plan went
  (cache reads 75 %, subagents 59 %, long contexts) and which proposals were measured and dropped as too
  small: fewer coordinator wakes, batched reviews, quieter replies, trimming the style plugins.

## makarasty 1.6.0, makarasty-tools 1.5.8 — 2026-10-09

The plugin is TypeScript now, and fleet.sh answers in a tenth of the time.

- **fleet.sh runs in node.** Its 39 commands moved from 3,000 lines of POSIX sh to `src/scripts/fleet.mts`
  and `src/scripts/fleet/*.mts`, compiled to `scripts/fleet.mjs`; `fleet.sh` is a thin entry every command,
  skill and worker still calls the same way. On Git Bash a fork costs about 25 ms and the sh forked for
  nearly every line: on a 62-task run `next` went from 3-8 s to 0.1-0.6 s, `status` from 5-12 s to 0.13 s,
  and the self-test from about four minutes to 96 s [M37]. Each command was compared with the old sh on
  50-160 cases, stdout, stderr, exit code and every file written; the differences that remain are listed
  below and every one makes the answer more correct.
- **Every script and hook is strict TypeScript** (`src/`, `tools/src/`), compiled to the `.mjs` files that
  ship and run: node never runs `.ts`, since type stripping is paid on every start and the hooks start on
  every tool call. The port of the existing `.mjs` files was proven to change types only: the old and the
  new go through one printer and give the same JavaScript. `npm install --prefix src` once, then
  `npm run build --prefix src`; the self-test fails on a stale `.mjs`, and type-checks the sources where
  that install was done.
- **Node.js 20.11 or newer is required.** Without node fleet.sh refuses every command and says why, where
  it used to run some of them with half their answers missing; an older node is not checked for, and fails.
- **The watch loop** no longer forks a `grep` per file every ten seconds, and `ctx` names a background
  command's output past `runaway_log_gb` (1 GB) once: closed chats had left 5 GB of them.
- Differences from the sh, deliberate: a `budget:` with a leading zero is decimal, in `next` and in the
  `clock` it arms (the sh read it as octal and died on 08 after making the claim); `status` no longer stops early for a worker with a model wish and
  no record yet; a reader that closes early (`| head`) ends a command quietly with 141; paths read from run
  files in POSIX spelling (`/c/...`, `/tmp/...`) reach git and the filesystem converted, as the shell did.
- **Defects the port found in the old sh, fixed**, each with a self-test case:
  - `finish` let `kind:fix` (no space) past the proof gate, and without its task file ended with exit 2 and
    no message; `beat` and `finish` counted an owner line `achip 07` as chip 07's claim.
  - The pane broker: a host name was matched as a pattern (`0.` could serve host 02's walk); a `null`
    result crashed `pane-serve`; `pane-next` claimed directories it could never serve, handed out dotfile
    walks `pane-status` never counted, and split a walk name with a space in two; one unreadable result
    dropped every lease after it from the median.
  - A calibration value like `1.2.3` passed as a number and reached the frame gate as NaN, passing every walk.
  - `handback` dropped `after:t-a` (no space) instead of renaming it.
  - `recover --release` released a claim whose owner named no chip, missed a chip file written with CRLF,
    and glued a FINISHED with no final newline onto the next line; a dependent named twice was released twice.
  - `width` turned an `operator_reserve_gb` of 0 into 2 and printed `NaN` for a census with no figure;
    `stranded` skipped a marker's last line when it had no newline; `clean` named the tree it ran from as STRAY.
  - Git Bash rewrote any argument starting with `/` for node, so a pause reason `/fix the login` arrived
    as `C:/Program Files/Git/fix the login`. fleet.sh turns that off; node converts the paths itself.
  - A `finish` landing while `handback`, `sweep --release` or `recover --release` worked on the same claim
    got the task done and filed again; one claim's close is now serialised, and the releaser re-reads the
    done marker under the lock.
  - `clean --remove` deleted, and `handback` left uncommitted without a word, work the repository's config
    hides from `git status`: untracked files under `status.showUntrackedFiles=no`, edits to files marked
    assume-unchanged or skip-worktree. `clean` also emptied a tree a chat was still standing in and then
    said nothing had changed; it now leaves such a tree and says it is in use.
  - `file` took `after:` values no task can have (`[a, b]`, quoted lists, a `# comment`), the task itself,
    or a cycle, each of which holds the task for ever; `status` names a cycle written past `file`. A
    miscased `Needs:` was reported as missing; a quoted `task-id:` was refused.
  - `handback` of a chip never offered (`2` for `02`) wrote a `2.retired` that `landed` counted as a worker.
  - A claim left with no owner line (a `next` that died after its mkdir) could never be swept.
  - The watch re-announced everything an older watch had marked seen, which stored paths another way.
- **The pane gate is 10 frames a second, not 60** [M38]. A selected pane on a loaded machine read 28-37
  and the worker asked the operator to focus the chat or use split view, which changes nothing. Under 10
  on two readings a second apart is blind; 10 to 59 is a busy machine: the worker carries on, reports the
  number, and asks nobody. `pane-serve` and the design stamp gate on the same number.
- **Found by the port's own review rounds**, each with a self-test case: a lock (`.closing`, `.chip-NN`)
  left by a command killed mid-way, or by one whose reader closed the pipe, refused the retry for minutes
  with a false CLAIM LOST or BUSY; the holder's pid is in the lock now. `handback` would not commit a tree
  registered through a junction. A fleet.sh copied away from `scripts/` exits 2 and says why. A
  closed reader no longer stops a command half way: the output goes, the work finishes, the exit is 141.
  A handback killed mid-way is finished by the next one, and `finish` will not close a claim it already
  filed again. Two `file` calls for one id at once file it once. A `# comment` after an `after:` id or
  list item is a comment. `finish` called twice by its chip says BUSY or DONE, never CLAIM LOST.
  Killed at any point and run again, the commands that change a run finish what the first call began:
  handback writes task files whole, sweep and recover leave a half-handed-back claim to handback and
  release the dependents an earlier release left, retire and relaunch give the same chip number, and a
  relaunch run again after it resumed the fleet does not pause it again, a retire of an idle worker is
  completed, `finish` writes its marker with the branch in one step, `worktree --create` makes a
  half-created tree again rather than handing it out, `clean` names a half-removed one, and `fixqueue`
  puts its queue in place whole. `cleared` removes the top-level operator line however it is cased.
  `merge` keeps two chips' findings apart when both chose the same `id`, a served pane walk is no longer
  handed to a replacement as an unanswered question, and `sweep` releases a walk claimed with no owner.
  `merge` no longer reads `clusters.jsonl` back as a chip's findings; `fleet-gate.mjs asks` lists the
  decisions taken without asking even when no question was filed, and `decide` refuses a run directory
  that does not exist; `fleet-retro` reads the transcripts under `CLAUDE_CONFIG_DIR`.
- **An answer reaches only its own question**: `answer` refuses an id with no question in `ask/` (it used
  to write it anyway, and the next `ask` that took that number read the stale answer as its reply), and
  `ask` skips a number an answer already holds; an id with a path in it (`../ask/05-1`) is refused instead
  of written over the question. `handback` of a pane host puts its walk back to pending, and a retiring
  host is retired only once it has served the walk it holds and takes no new one meanwhile. A host that
  cannot serve a walk (a blind pane, its subagent gone) gives it back with `pane-serve ... --release`
  instead of holding it to the lease, and `drained` no longer finishes a host with a walk unserved.
  `recover` names a dead host's walk as held and `--release` puts it back to pending (unless another
  session of that chip can still be resumed); `retire` no longer
  takes a host waiting on a model switch for idle while its walk runs; and every handback (relaunch,
  recover, retire) writes the questions and walks its chip still waits on into `.retired` as `unanswered:`.
- **Hook commands quote the run path**: the commands the memory and contract hooks print broke on a
  project path with a space.
- **The contract gate guards both ends of a name**: a YAML key (`server.port:`) was never protected, since
  the colon after it counted as part of a longer name; a prefix (`/status` -> `/v1/status`, `cache.ttl` ->
  `app.cache.ttl`) and an event's dotted suffix (`order.created.v2`) went through; a decision or a question
  about a longer name (`/api/users/:id`) let a shorter one (`/api/users`) go; and moving a route within a
  CRLF file was blocked as its removal. A name ending a sentence (`Moving /api/x.`) is still that name,
  while `/api/x.{format}` is another; a route inside a full URL and an event after a namespace
  (`topic:order.created`) are still counted. Still not gated: an edit made through Bash (`sed -i`), and
  environment variables, which `surface` does not list.
- **The memory hook knows the usual spellings of a whole run**: `npm run typecheck`, `pnpm typecheck`,
  `npm t`, `tsc -p .` (to tsc a root `-p` is the whole project), `tsc --noEmit 2>&1 | tail` and a run given
  `--config ./vitest.config.ts` (a config file is no scope) all went through on a full machine. A package
  (`tsc -p packages/a/tsconfig.json`) or a workspace (`npm test -w a`) is a scope, while jest's `-w 2`
  after `--` is not; a runner's name inside a commit message (`git commit -m "fix; npm t"`) runs nothing,
  while one inside `bash -c "..."` or `echo "$(npm test)"` still counts (a `git commit -m "$(cat <<'EOF'`
  message does not); and a `test:watch` script is a watcher, not a run.
- **`CLAUDE_CONFIG_DIR` is honoured for the plugin's own install**: the installed version (the watch's
  WORKER PLUGIN line, `retire`'s older-plugin check) and the scripts found beside an install were read from
  `~/.claude` whatever the config dir, so a host with another config dir compared workers against another
  install's version. Without `CLAUDE_CONFIG_DIR`, every fleet script and hook now takes the OS home as the
  host does: the CLI used Git Bash's `$HOME` and the hooks `USERPROFILE`, so a pause marker could land
  where the guard hook never looked. `recover` finds transcripts under the same directory. The shell
  snippets in the docs still say `$HOME`, which is the same folder unless HOME was set by hand.
- **The gate's root task starts where its members do**: `cluster --queue` copies the `base:` its members
  share into the root task; without it the root was cut from whatever branch the main checkout stood on.
- **Findings in Russian stay apart**: `merge` kept only ASCII letters of `observed` for its dedupe key, so
  every all-Cyrillic finding of one area collapsed into one backlog row and one fix task. TORN LINES names
  the line an editor shows (blank lines were dropped before numbering), `summary` totals count a chip file
  with no last newline as its row does, and `fleet-retro --dir <path> <run>` takes the run, not the path.
  `summary` has one row per worker, a pane host or a retired worker with no findings file included (their
  tasks were in the totals and missing from the rows), a row counts findings as the totals do (an
  `unreached` line is none), and `find` takes a short `file:line` (`a.txt:1`, `a.ts:10:5`, `a.ts#L10`) as
  evidence, as the protocol says.
- **The fix gate no longer counts the reproduction's own output as the fix**: `prove` records the content
  of the whole checkout (a git tree id, through a copy of the index) just before and just after its
  command, and `check` wants a path that differs between the red run's end and the green run's start AND
  was changed between runs. A log, snapshot or coverage file the command writes no longer passes as a fix
  (nor a flaky second `after`), nor does a fix reverted before the green run or a commit of nothing new; a
  fix in a file the command also rewrites (a formatter) still proves. `prove` run from a subdirectory sees
  the whole checkout, a run directory below the top (`app/.fleet`) is left out like `.fleet`, two proves on
  one claim at once are refused (a killed prove's lock is taken over by its pid), records from two gate
  versions are refused rather than compared, a green on a commit that does not grow from the red one's is
  refused, a file git cannot read (held open by another process) is named and left out instead of losing
  the whole tree, PROVEN names the paths that changed between runs, the refusal names what the gate cannot
  see (ignored files, the inside of a submodule), and `prove` outside a git checkout refuses. `fleet-load` reads `-w` from the program node runs (past node's own
  flags and `npx`/`pnpm exec`), not from any word in the line: `tsc -w` and `vitest -w` are watchers, while
  jest's `-w 2` (--maxWorkers) is a whole suite again, so the memory hook's one-full-run refusal sees it,
  and neither a `jest` folder in the path nor pnpm's own `-w` decides it.
- **Task ids and chip ids stay names**: `cleared ../../x` rewrote a file outside the run; it and `file` now
  refuse such ids, and `file` also refuses ids no git branch can carry (`a..b`, `c.`, `x.lock`). Every
  worker command refuses a chip id that is not a plain name (`drained <run> ../esc` wrote `esc.done`
  beside the run).
- **Trees and canvases**: `unlink` works on a tree that lost its `.git` (it asked the main checkout and
  refused, though `clean` told the operator to run it); `worktree` refuses a chip id that is a path
  (`../FINISHED` wrote the run's landed marker); `fleet-canvas plain` on `Cart.DC.html` no longer writes over
  the artboard, and `stamp` writes a `$'` in a title as text instead of copying the page into the block.
- **The watch announces a worker blind a second time**: `.waiting` was announced once per run, so a pane
  worker that went blind again sat unseen; and the stall report now lists the markers. It no longer calls
  the run complete while a retire's replacement has not started (the count of workers was refreshed once a
  minute, after the old worker's `.retired` had already landed) or while the run is paused, which is where
  a relaunch stands after handing its workers back and before their replacements exist.
- **A pane worker can take its one repo task again** while its browser subagent runs, as docs/LANES.md
  has said all along: `next` had refused any second claim since 1.5.x. Exit 2 HOLDING is documented, and
  `drained` refuses the same way instead of writing `.done` over an open claim, and names a task a
  finished chip still claims instead of sending the worker back to `next`. A chip clicked twice no longer
  runs two sessions on one task: the second live session as that chip is refused as CHIP TAKEN, and when
  both sessions' first calls overlapped, the one that registered first keeps the chip (each used to refuse
  the other for good, leaving any claim it had made open). relaunch
  offers no worker whose replacement has started, never takes a number a brief file holds, and says when
  a chip it prints was offered before; `recover` counts a retired chip as landed, and `recover --release`
  retires every dead queue chip (holding a claim or not, `.waiting` left or not), so the watch does not
  wait on it, and points a dead brief worker at the relaunch that re-offers its brief; a pause no longer
  lets the next sweep take a pane walk in progress, and counts its host as holding work; `handback` of such a
  chip still commits its tree. A session record left by a killed chat does not hold its chip (its pid
  must be alive, started after boot, and on Windows the very process that wrote it), and the
  coordinator is never refused as CHIP TAKEN.
- **The self-test proves the shipped `.mjs` without the compiler too**: the build records a hash of every
  source and output in `src/build.sha256`, and a source edited without a rebuild fails the run. Cases
  that stayed green with the behaviour broken were fixed: a hook's exit code is read from the start of its
  output (the "0 " in "30 s from now" passed for it), payloads reach node as typed (Git Bash had rewritten
  "/api/..." and "HOME=/x" into paths), and checks that only looked for an absent word now also look for
  what must be there.

## makarasty 1.5.14, makarasty-tools 1.5.7 — 2026-10-08

Fewer clicks and questions per worker, and nothing left running after a chat closes.

- **A queue worker past its context mark is replaced unasked, without a pause.** The watch names
  `fleet.sh retire NN`; the coordinator runs it and offers the replacement chip, with the same lane and
  model wish. The worker finishes its task and leaves at its next claim: `handback` commits its tree, its
  unanswered questions are written into `.retired`, and a hook now lets a retired worker close its tabs and
  preview servers. A second `retire` offers nothing again, the chip number is taken atomically, a lane with
  nothing left gets no replacement, an unclicked replacement is named after ten minutes, and a worker on an
  older plugin or a brief worker still goes through the one relaunch ask.
- **Leaks from closed chats are found and ended.** `fleet-load --leftovers` now names a shell a Claude Code
  chat started whose parent is gone, at least ten minutes old, with what runs under it (wake loops, `find`,
  polling scripts), and `--kill` ends it, children first; the watch prints a `LEFTOVER` line once per process
  and the coordinator kills unasked. A tree that serves something - a dev server, an `http.server`, any pid
  holding a listening port - is never ended unasked: it comes as `LEFTOVER, ASK THE OPERATOR`. The watch
  ends itself before its monitor's timeout and when the coordinator's chat is gone; a worker's pause,
  memory and queue wake loops end when their chat's session record is gone [M35].
- **Effort.** `chips` refuses `--effort max`; `docs/MODELS.md` holds the operator's policy: `high` by
  default, `medium` for plain work, `xhigh` for the hardest lanes, ultracode for one task that needs more.
- **Faster workers, same evidence.** A worker batches every read that does not depend on the last one into
  one turn, splits a task with three or more independent items across subagents, and hands each subagent the
  files, ranges and test command it already found: 87-89% of a measured run's turns made one tool call,
  nearly half of them a single read at 3.6-5.0 s of model time each, and a delegated subagent took a median
  4.5 minutes to its first edit [M36].
- **A paused worker woken by the app's "The app was quit while you were working" re-arms its wake loop and
  ends with one line**, without gating its pane or asking the operator anything; the coordinator reads the
  same message as a restart and wakes its workers (`fleet-resume`, step 0).
- **Upgrading mid-run no longer relaunches the whole fleet.** `next` stamps the plugin version each worker
  claims on. A worker keeps the `fleet.sh` path it resolved at its start, so after `claude plugin update` and a
  restart `WORKER PLUGIN` has the coordinator message it to invoke `fleet-run` again, and only a worker that
  then claims on the old version (`STILL ON`) goes to the relaunch ask; the restart wake message does the same.
  `retire` and the `WORKER CONTEXT` line send a worker older than 1.5.14 to the relaunch ask, `relaunch`
  never reuses a replacement that `retire` marked `none` or that already started, versions compare without
  `sort -V`, and `--leftovers` also knows zsh shells.
- `next` skips the memory census when free memory is plainly above the line (0.8 s per claim), and workers
  read with the `Read` and `Grep` tools where offered: 0.02 s against 0.5-0.9 s for a Bash read [M36].
- **`/makarasty:fleet-analyze <run-id>`** answers "how did the fleet work", "why so slow", "where did the
  tokens go" in under a second, from the run directory and the transcripts, with no model turns spent on
  parsing: task time split into model, tests, tools, browser, operator waits and outages; one-tool turns,
  read streaks, re-reads; subagents and their time to first edit; cache rewrites after idle; tokens and a
  list-price cost per worker, parent and subagents; the slowest tasks; recommendations tied to the numbers.
  It is the plugin's first TypeScript script: `node` runs it directly from 22.18, `tsc -p scripts` checks it,
  and the selftest runs both.
- **Three new tools.** `/makarasty-tools:game <game>` reads the hardware, disks, drivers and the game's install,
  proposes changes each with a source and an undo, has a red team try to disprove them, and reports what
  survived in a few plain lines. `/makarasty-tools:update` does the same for what is out of date: apps,
  runtimes, Claude Code and its plugins, other agent CLIs, drivers. Both apply only the items the operator
  says yes to, into standard install paths, record them in `~/.claude/makarasty/upkeep.json`, and leave
  Windows system settings and drivers to the operator with exact steps. `/makarasty-tools:cleanup` finds what
  the machine carries for nobody - processes ended chats left running, runaway background logs and scratch
  folders of ended sessions (20 GB on the machine it was tried on), stale worktrees, caches - ends processes
  on a yes and gives the commands for files; "почисти за собой" stops only what the current chat started.
- The watch counts chips that started after it was armed, and counts a chip once however many markers it has;
  collection treats a retired chip as finished.

## makarasty 1.5.13 — 2026-10-08

The coordinator now sets each worker's model, and a restart no longer reads as a running fleet.

- **The coordinator switches workers' models.** The desktop app's `set_session_model` and
  `set_session_effort` change another session from its next turn. `fleet.sh chips ... --model <id>
  --effort <level>` records what each worker should run; `whoami` exits 10 when the session runs something
  else, the worker ends its turn, the watch prints `WORKER MODEL NN`, and the coordinator switches it and
  messages it on; the watch repeats the line every ten minutes while the worker waits. The same mismatch
  twice means the switch did not take: the worker goes on and the coordinator is told once, so a declined
  card cannot loop. `chips` takes only a full model id, keeps a wish across a re-offer, and drops it with
  `--model none`; `next` hands nothing to a worker with a switch pending. On 2026-10-08 four chips started
  on Sonnet because `/model` had been flipped just before the click [M35]. `docs/MODELS.md`, "Switching a
  worker", is the one place this is written down.
- **A pane worker keeps its pane open for the whole run.** The memory hook, `next` on a full machine and
  `drained` told it to close the pane; closing the last tab closes it, and only the operator can put it
  back on screen. On 2026-10-08 worker 05 closed it twice and sat blind for 58 minutes waiting for the
  operator. Memory now comes back by swapping the heavy tab for an empty one.
- **Back from a restart, the coordinator wakes every worker by message before it re-arms the watch.** Claim
  files survive a restart and make a stopped run look alive. `fleet-resume` step 0 messages every worker
  the app still lists, with its own wording for a brief worker, and keeps `claude -r` for the ones it does
  not. An expiry of the watch is not a restart and wakes nobody; a paused or landed run is not woken.
- `next` hands out nothing once the run has landed (exit 9) and sends a brief worker back to its brief, so a
  late message cannot start a task after collection or end a brief early.

## makarasty 1.5.12 — 2026-10-06

The second red-team round on 1.5.10 and 1.5.11, plus one rule from the live run.

- **Every question to the operator is an `AskUserQuestion`**, with a push notification first, never a line
  in the coordinator's reply, and it stays under open questions in `STATE.md` until answered: a question
  typed into the chat scrolled away between two merges.
- A `cleared` task wakes the worker waiting on exit 7 (`tasks/cleared/`), and exit 7, `drained` and `landed`
  say when a task waits on the operator; `operator: none`, `N/A` or `done` in any case owe nothing.
- `--leftovers --kill` ends only an orphaned test run or typecheck whose tree used no CPU over a five-second
  second look, by the pids it checked; a reused pid no longer loops the walk.
- The watch's stall block shows the operator, bottleneck and wait-for-ever sections; `stranded` reads branch
  names that a tag shadows; `file` refuses a frontmatter with no closing `---` and names the lane it read; an
  unreadable plugin version is said to be unreadable rather than older or newer.

## makarasty 1.5.11, makarasty-tools 1.5.6 — 2026-10-06

Worker 20 of the 2026-10-05 build stopped at 420 K of a million-token window, calling it "the coordinator's
400K retire threshold". There was no such threshold: eighteen hours earlier a coordinator had broadcast
"workers 01-05 and 11-13 retire, your context is past 400K", and every worker reads the whole broadcast.

- **A worker never stops for context on its own** below 850 K; a reminder's number or a broadcast order
  naming other chips is not its own. The coordinator's watch asks the operator at 700 K, and a relaunch
  reaches the worker as "retired".
- **`fleet.sh broadcast` stamps each entry with its time** and warns when one carries a retire order;
  `fleet-plan` keeps orders for named chips out of the broadcast and has the coordinator tell a worker that
  stopped early to carry on.
- **The general handoff reminder first fires at 700 K** (makarasty-tools 1.5.6), not 600 K: below that is
  ordinary context on a large project, and 700 K is where the operator draws the yellow line.

## makarasty 1.5.10, makarasty-tools 1.5.5 — 2026-10-06

What the rest of the 2026-10-05 build showed, read from its run directory and its 24 chats: 200 of 234
tasks done in 20.9 hours, seven coordinators in a row, and a third of the tasks fix tasks.

- **No handoff reminder in a fleet chat, and 600 K elsewhere.** Three of the six coordinator handoffs came
  from the old 300 K mark (700 K since 1.5.9); the general 400 K reminder made one coordinator offer a
  handoff twelve times, workers offered too, and one coordinator handed off at 448 K unasked. `fleet.sh`
  now records every coordinator and worker session in `makarasty/fleet-sessions/`, and the reminder says
  nothing there. A record whose run has `FINISHED`, is gone, or was not rewritten for two days (the watch
  rewrites the coordinator's every minute) is dropped and the reminder comes back; `landed` removes the
  run's records. Everywhere else it first fires at 600 K, not 400 K (`MAKARASTY_HANDOFF_AT` still moves
  it): on 1M-context models it came too often.
- **Waiting on the operator is a state, and `status` names what the queue waits on.** A task with
  `operator: <what>` is asked at launch, held by `next` until `fleet.sh cleared <run> <id>`, and listed
  under `== waiting on the operator`; `== bottlenecks` lists a task free to start that holds three or more
  open tasks behind it, and `== waits for ever` an `after:` naming nothing filed or done. Every remaining
  plan task had sat about two hours behind one permissions task, closing 8 and then 4 tasks an hour.
- **`fleet.sh file <run> <id>`** files one task from stdin: refused, with the reason, when it is not UTF-8,
  has no frontmatter, names a lane other than pane, repo or verify, disagrees with its `task-id:`, or reuses
  an id; a byte order mark is dropped, and an `after:` naming nothing filed yet is noted. `status` runs the
  same checks over task files written by hand. A hand-made filing script had lost two tasks behind a failed
  `&&` and broken a third with cp1252.
- **`fleet.sh stranded <run>`** lists done tasks whose branch holds commits the integration branch lacks,
  `STRANDED` when they came after the branch was merged: certain from the tip `finish` now records, read
  from the merge commit's message for older markers, and a marker with no branch line is matched by task
  id. `landed` repeats those, or says the check could not run. Three such commits had needed a recovery
  task; on the live run it found three more.
- **Old workers are found and replaced without being asked.** `whoami` records the plugin version; `status`
  says `OTHER PLUGIN` (older or newer) or `never ran whoami`, the watch prints `WORKER PLUGIN NN` for a worker
  on an older makarasty than the installed one, and the coordinator puts it in the one relaunch ask and
  offers the fresh chips. `pause` names holders whose hooks cannot hold them. 137 of 200 done markers had
  come from 1.5.2 workers, and the operator had to ask the coordinator to look.
- **`fleet.sh procs <run> [--kill]`** (`fleet-load.mjs --leftovers`) lists test runs and typechecks whose
  chat or shell is gone, and kills only those that sit idle (no CPU over a five-second second look); an orphaned dev server, watcher or emulator is listed and
  left to the operator. A worker stops every run, server and background shell it started before `finish`.
  The build's machine ran out of memory with leftovers nobody owned.
- **`status` starts with `== now`**, the machine's clock, and `STATE.md` entries are stamped from it: one
  coordinator wrote "~13:00" on a snapshot taken at 11:10.
- A worker's own review before `finish` checks `answers/00-broadcast.md`'s recurring misses one by one.
- `fleet-plan`'s relaunch procedure moved to `docs/RELAUNCH.md`, keeping the command under 500 lines.

## makarasty 1.5.9, makarasty-tools 1.5.4 — 2026-10-06

A pause that stops a fleet, and a relaunch in place of a chain of handoff chips. On the 2026-10-05 build the
operator said "pause" and the workers kept "wrapping up" for a long time; the coordinator then handed off by
chip at 300 K, and the next one again, each hop losing what lived only in its context.

- **`/makarasty:fleet-pause <run> [off] [reason]`** and `fleet.sh pause|resume|paused`. A worker gets 30 s
  (`pause_grace_seconds`) from its first call after the pause to finish the step in hand, commit work in
  progress and stop its subagents and background shells; then the hooks refuse everything but git,
  `fleet.sh` and the wake loop. New subagents are refused from the first second, a subagent's own calls
  after the grace. `next`/`drained` exit 8 while paused; the abort clock stands still; `status` and the watch
  name workers with no ack yet and, past 150 s, the ones still working.
- **`fleet.sh contexts`** lists the context of the coordinator and of every worker; the watch prints
  `WORKER CONTEXT` lines as well as `COORDINATOR CONTEXT`.
- **Context marks moved up** at the operator's word: the coordinator asks at 700 K and again at 800 K,
  workers at 700 K (`coordinator_handoff_k`, `worker_relaunch_k`); auto-compaction starts a little past 900 K.
  The coordinator hands reviews, merges, conflict resolution, `STATE.md` updates and every large read to
  subagents and keeps verdicts and decisions.
- **`fleet.sh relaunch`**, after one ask to the operator: pause, wait for acks, hand back the replaced
  workers' tasks (`<id>-r<n>` with `continue-from:`, `continued-from-chip:`, `handback-of:`; a dirty tree is
  committed as `wip: handed back`, a fix task's proof is carried over), retire them (exit 9; held by the hooks
  even after resume), then, once `STATE.md` is current, print the fresh worker chips and one coordinator chip
  (`resume --take-over`). `--keep-coordinator` replaces only workers and resumes at once.
- `/makarasty-tools:handoff` and the context reminder send a fleet coordinator to the relaunch instead.
- Every worker-side call that names its chip registers the session, so a worker on an assigned brief is
  held by the pause too and counted by `pause`, `status` and `relaunch` until its `.done`; a line refused for
  its shell syntax (a backtick or `$(` in a note) says so, and a line refused for its commands does not.
- Checked by three rounds of a Sonnet red team, the last an end-to-end run of pause, relaunch, take-over,
  a handed-back fix task and landing; self-test 702 checks.

## makarasty 1.5.8, makarasty-tools 1.5.3 — 2026-10-05

Everything else the 2026-10-05 build run got wrong, measured on that run while it was live.

- **The whole queue at launch, every lane's chips at launch.** `fleet-plan` files every wave up front and
  holds the order with `after:`; filing one wave at a time idled about a third of worker time and left
  Opus-only tasks unclaimed for nineteen minutes. `fleet.sh chips` records what it offered in `offered/`
  and ends with `STILL WITHOUT A WORKER` for any lane that has ready work and no chip; `status` repeats it.
- **Lanes are pane, repo and verify, never a model.** `chips` refuses any other lane, and `status` names a
  `needs:` that no worker can ever claim. An `opus` lane had left four idle Opus workers unable to take a
  waiting task. `model:` in a task is now documented as a wish: the operator's chip decides what runs.
- **What each worker really runs.** `fleet.sh whoami` records model and effort at the first claim and
  `status` lists every offered worker with it. The plan said Sonnet for 81 of 125 tasks; all seven
  workers were Opus.
- **The coordinator stops being the bottleneck.** `fleet-plan` 8b: review finished tasks through a
  subagent and read only its verdict, keep `STATE.md` current, hand off at a mark. The watch records
  whoever arms it as the coordinator and `fleet.sh ctx` prints `COORDINATOR CONTEXT <n>K` once per mark
  from that session's own transcript (`coordinator_handoff_k`, 300 K). That coordinator had reached 510 K
  at thirty percent of its plan.
- **Budgets from measurement.** `status` prints the median work time against the median budget once
  three tasks are done, and says `BUDGETS TOO LOOSE` when no abort clock could ever fire (four minutes of
  work against budgets of 45 to 150).
- **One commit, one review, before a code task is finished.** `fleet-run` step 5: the worker commits on
  `fleet/<chip>/<task-id>`, a subagent at the task's `verdict-model` (its own tier when the task has none)
  reviews that branch against its base, the worker fixes what shows an input, lists the rest as unreached,
  and finishes. `fleet.sh finish <run> <chip> <task-id> [branch]` writes `branch <name>` into the done
  marker so the coordinator knows what to merge (a second `finish` without a branch keeps that line, and a
  branch that does not resolve is warned about). Twelve of the first 33 tasks came back as fix tasks.
  `fleet-plan` 8b: a worker-reviewed task gets a short verdict review, not a second full one.
- **`fleet.sh worktree <run> <chip> --create [base]`** (the worker passes the `base:` of its first task) makes the worker's tree under
  `.claude/worktrees/`, excludes that directory locally, links every `node_modules` up to three levels
  deep (monorepo `apps/web/node_modules` included; it warns when a link fails), and registers it. The base
  defaults to the main checkout's current branch; a tree whose directory was deleted is pruned and made
  again, not "reused". Chips had opened in the main checkout and a coordinator hand-wrote trees at
  `C:/wtRM01..05`, which nothing could register or clean. `clean` now removes a detached tree whose commit
  a branch already holds, and no longer prints `branch -d HEAD`.
- **Screens are checked where they can be seen.** A build worker's pane shows the main checkout, not its
  worktree; `fleet-run` says so, and `fleet-plan` files screen checks as `needs: pane` tasks against the
  integration checkout, now defined (the worktree where the coordinator merges, with its own dev server),
  each carrying `origin: <url>`. A worker that must see its own screens, a design task, serves its own
  tree on a free port. A look a build worker cannot take is filed as `ask/<chip>-<n>.md`, which the watch
  surfaces; a line in its notes was read by nobody.
- **A chip is an offer, and a rule that names fleets does not cancel it.** The 1.5.7 fix for the coordinator that offered
  paste lines was itself beaten by the project rule it was written against: "unless a project rule
  names fleets" let a "never a fleet worker" rule win. `fleet-plan` and the `fleet.sh chips` trailer now
  say a chip is declined with one click, so every one is offered, and a rule that seems to forbid them is
  quoted to the operator in the same turn. `fleet-run`: a project rule about the tree wins over the protocol
  and one about channels loses to it; a rule that forbids a tree-side protocol step is obeyed, filed in
  `ask/` naming both rules, and the worker takes the next task. "No commit without asking" is overridden for
  the worker's own task branch only. Near its context limit a worker finishes or hands the task back,
  never a chip.
- **`chips` is strict.** It refuses an empty, reversed or non-numeric range, a worker number below 1, and a number already offered
  under a different lane, records `brief` for a brief worker, and prints the browser-pane sentence only for
  lane `pane`. `lane_gaps` ignores a chip whose worker already wrote `.done` or `.blocked`; `drained`
  refuses to finish (exit 5) while a ready task has a `needs:` no worker can claim, and `next` says so too.
  `status` exits 0 whenever it printed its report.
- **Every worker command takes the run's absolute path.** `fleet-run` defines one `$r` and uses it in every
  command and in the wake loop; a relative `.fleet/<run>` that does not exist under the cwd resolves
  against the main checkout in `fleet.sh`, and the hooks print an absolute run path from a worktree.
  `fleet-run` also tests for a worktree with absolute `git rev-parse` paths, unlinks the registered path
  (not `$(pwd)`), and defers pushing to the project's rules.
- **The watch is fixed where it was wrong.** A service URL is no longer a regex: `http://[::1]:5173` is
  removed from the down list and reports `SERVICE BACK`. The loop builds `svc` from one fixed `FLEET.md`
  line, `- Services: <url> (start: <how>|operator); ...`, which `fleet-init` writes, and `start:` decides
  whether the coordinator restarts a service or tells the operator; only a URL before an item's
  `(start: ...)` is probed, and an empty list prints `WATCH: no '- Services:' line in FLEET.md, services are
  not being checked` (`fleet-init` converts an old-format line). From a worktree it finds the run and
  `FLEET.md` in the main checkout; where neither exists it prints `NO RUN DIR` and exits, and its stall
  report ends with the lanes that have work and no worker.
  Tasks may carry `origin:` and `verdict-model:`, documented in `PROTOCOL.md`.
- **A handoff into a run under way does not re-offer chips.** `handoff`: read `STATE.md`, re-arm
  `fleet-wait`, resume only if the worker chats are gone, and name `opus` for a fleet coordinator. The
  outgoing coordinator refreshes `STATE.md` and stops its own watch (`TaskStop`) before it offers the chip:
  two watches share `.watch-seen`, and the old one swallowed the events. `STATE.md` now holds what a
  re-arm needs (plan path, run dir, worker count, chips by lane, integration checkout and URL, extra
  watched URLs, queue-open, merges, reviews, fix tasks, decisions, pane check tasks); the handoff names
  `fleet-plan`'s command file as the fallback for a chat that started before the plugin update.
- **A task builds on what it waits for.** `after:` waits for the done marker, not for the coordinator's
  merge, so a code task now carries `base: <integration branch>` (`PROTOCOL.md`), its branch is cut from
  that, and the worker merges each predecessor's `branch <name>` (from the done marker) into it when it is
  not in the base yet. A `needs: pane` check task first confirms the build branch is in the integration
  checkout and otherwise files an `ask/` and takes another task.
- **`fleet-login [origin]`** logs in at the origin it is given (a task's `origin:` or the worker's own
  served URL) instead of `FLEET.md`'s; a refusal from the app's auth or CORS allow-list on a new port is an
  `ask/`. A `design` task is `needs: pane` and serves its own worktree from a background dev server on a
  free port, `preview_start` by url.
- **A fix is proved in its own tree.** `prove` hashes the cwd and `--create` leaves it in the main
  checkout, so `fleet-run` runs both calls and the scoped tests with `cd` into the worktree; before and after
  were the same tree and `finish` said NOT PROVEN. `FLEET_REFUTED` is never the way past that.
- **A task's `model:` is met by a spawn.** A worker below a task's tier delegates the task to one `Agent` at
  that tier; `fleet-design` and `fleet-call` name the model for every chip, and the coordinator tells the
  operator in the turn `status` shows a gap. An assigned brief that writes code records `branch
  fleet/<chip>/brief` in its notes, `unlink` now comes before `drained` writes `.done`, and `PULL.md`'s code
  blocks use the absolute `$r`.
- Budgets in `fleet-plan` and `PULL.md` now give a stated default for a first wave and say the run's own
  median replaces it. Every behaviour change above has a self-test check.
- **`clean` in the middle of a run.** A task branch merged into another local branch (the integration
  branch, before the owner lands it) counts as held, so its tree can be removed; the worker's merged
  `fleet/<chip>/*` task branches go with it by the safe `branch -d`. A tree unlinked before `drained` gets
  its links back from `worktree --create`. `chips` reports a `needs:` that is no lane as a task to fix, not
  a chip to offer. A pane check whose build is not merged yet is handed back with `finish` and re-filed by
  the coordinator, since a claim is never released. `fleet-plan` converts an old-format services line in
  `FLEET.md` before arming the watch, and makes the integration checkout with `worktree --create`.
- Checked by three rounds of a three-reviewer red team, each finding fixed and re-tested by the next round.
  Self-test: 423 checks.

## makarasty 1.5.7, makarasty-tools 1.5.2 — 2026-10-05

A coordinator that reached its run by handoff offered its workers as paste lines, not chips. It had never
loaded `fleet-plan` - the harness blocked it - so the chip rules were not in its context, and a project
memory rule written about chip hygiene ("chips only for one real defect, never a fleet worker") decided
instead. When the operator asked, it offered four chips titled `Fleet worker 02: ...`, which no
`fleet <run-id> NN` lookup finds, pointing at a cached `fleet-run` two versions old.

- **`fleet.sh chips <run-dir> <NN>[-<NN>] [lane]`** prints each worker's `spawn_task` title and prompt:
  the `fleet <run-id> NN` title, the run's absolute path, and the path of the `fleet-run` actually
  installed. `fleet-plan`, `fleet-resume`, `fleet-design` and `fleet-call` take chips from it rather than
  retyping a template. Six self-test checks.
- **`fleet-plan` no longer carries `disable-model-invocation`.** A chat told "launch the fleet", or made a
  coordinator by handoff, can now load it. It writes files and offers chips; nothing is spent until the
  operator clicks one. A plan that already exists skips the interview.
- **Project rules and the protocol, split in writing** (`fleet-plan`, `fleet-run`): the project decides what
  workers build and touch; the fleet decides how they launch, ask and hand work back, unless a project rule
  names fleets. A rule that forbids a protocol step outright goes to `ask/`, not into a silent choice.
- **The watch checks the services.** `fleet-wait`'s loop takes the run's service URLs from `FLEET.md` and
  prints `SERVICE DOWN` once when one refuses connections, `SERVICE BACK` when it returns; the coordinator
  restarts it or tells the operator in that turn. The functions emulator died twice during one run and
  nobody in the fleet noticed.
- **A blind pane is asked about, by anyone.** `BROWSER.md`: the coordinator too asks the operator to open
  its pane in the same turn, with a push notification, rather than recording the check as a debt.
  `fleet-plan`: screen checks in a build go to `needs: pane` tasks, not to the coordinator.
- **`handoff`**: when the next chat is to run a fleet, its first step is `/makarasty:fleet-plan` or
  `fleet.sh chips`, not a launch rebuilt from the docs.

## makarasty 1.5.5 — 2026-10-04

- **`fleet-retro.mjs` counts a turn once.** The host writes one transcript line per content block and
  repeats the message's usage on each line. The script counted lines, so turns, output and cache reads came
  out 1.5 to 1.9 times high. On one nine-worker run: 3,276 turns became 2,099 and
  1,027 M cache reads became 688 M. Tool-call counts, lanes, pane minutes and minutes after done were right
  and have not changed.
- **`docs/RUNS.md`**: a selection of real runs from two projects, a private web app and the public
  Essentials plugin, each with its setup, results, failures and approximate cost at API list prices,
  counted once per message, and checked by a red-team pass against the run directories. The README's
  cost section is now a summary of it.
- **Corrections to the ledger.** M02 said the first eight-worker run filed 94 findings nobody could have
  observed; its own analysis shows the gate caught all eight blind panes and the findings came after a
  live reading. The README's 311 M cached and 8.3 M non-cached for that run were per-line counts; per
  message they are 163.8 M and 4.21 M, also fixed in `MODELS.md`. M24, M30 and the pull-run appendix carry
  a recount note. `SWEEPS.md` and M10 no longer carry details specific to the private project.

## makarasty 1.5.4, makarasty-tools 1.5.1 — 2026-10-02

The first public release. No rule, threshold, command or exit code changed.

- **README rewritten** for a reader who has never seen the plugin: what each plugin does, install,
  requirements, a quick start, the commands, how a fleet works, what it may delete, the known limits.
  The release-by-release history that lived in it is here.
- **A style pass over every document, command, agent brief and skill.** Filler, decorative repetition and
  sentences that took two reads were rewritten; two checking passes compared every hunk with the previous
  text and restored six places where a rewording had changed a claim.
- **Examples from a real project replaced** with neutral ones: a shipping carrier instead of the original
  vendor, `Acme` as the canvas title, a generic home path in `docs/SAFETY.md`. The self-test and the
  `script-speaks-only-facts` eval use the new example and test the same thing.
- **Manifests** have shorter descriptions and carry `homepage`, `repository`, `license` and `keywords`.

## makarasty-tools 1.5.0, makarasty 1.5.3 — 2026-10-02

Read from 6,793 prompts typed by hand across 1,411 chats (2026-06-28 to 2026-10-01). The commands below
replace instructions that were being retyped, and the hook answers the limit that actually binds: over
2026-09, 208 of 533 chats passed 400k tokens of context and 94 passed 600k, the size at which a chat stops
being worked in.

- **`/makarasty-tools:handoff`.** "Hand this to another chat, offer it as a chip" was typed in 64 chats and
  "read the other chat's history" in 97. The command writes a handoff file outside the repository, offers
  the next chat as a chip whose prompt carries this chat's id, so the next chat can read this one with
  `list_events` or ask it with `SendMessage`, and stops. `from <chat>` is the receiving half: read the
  other chat, check its "done" against the repository, continue. A handoff skill from a skill pack was
  invoked 9 times; it saved a document and stopped there.
- **A context hook.** `tools/hooks/context.mjs` reads the last main-chain usage from the transcript tail on
  each prompt and, at 400k and every 150k above, tells the chat to offer a handoff in one line. A
  `/compact` re-arms it. About 50 ms per prompt, the cost of a node start, measured equal to a shell start
  on this machine.
- **`/makarasty-tools:hold`**, the codeword mode: "молчи, пока не скажу абрикос" appeared in about 30
  chats. Items are collected one line each, then fixed grouped by shared component.
- **`/makarasty-tools:explain`**: "простым языком на русском" in 187 chats, and "too long, too formal" as
  the most repeated correction. A fixed answer shape, with each claim checked before it is said.
- **`review --loop`** fixes and re-reviews until a round finds nothing, at most three rounds, and accepts a
  directory. On a split review the finders run on Sonnet and the verify pass judges: "Sonnet agents for review, Opus checks their
  findings" was retyped in dozens of chats.
- **`ship` reads the other chats in the checkout first**: a file a still-running chat is editing stays out
  of every commit, and `mine` commits only this chat's files. It follows the repository's own update-log
  format and reads the last two entries. "Учти параллельную работу" was retyped in about 34 chats.
- **`fleet-login`** triggers on "залогинься", and takes credentials from the runbook, never from the chat:
  a password typed into a prompt stays in that chat's transcript on disk.

Then a red team: six Sonnet agents, two reading Anthropic's skill, hook and plugin docs and open-source
analogs, four running the commands against throwaway repositories, transcripts and a dry-run notifier.
About 90 findings; the ones that held were fixed, each fix re-checked by a second Sonnet pass.

- **`commit` committed another chat's staged file.** A bare `git commit` takes the whole index, which
  parallel chats share. It now commits by path (`git commit -F - -- <paths>`), checks attribution only on
  the commit it just made, amends only that commit while unpushed (`--amend --only`), and stops on a merge,
  rebase or detached HEAD instead of committing into it. `allowed-tools` is `Bash(git:*)`, not all of Bash.
- **`ship` could push straight to a protected main and loop on the rejection.** A push rejection is now
  read: fetch-first pulls, a protected branch or GH006 stops and says to open a PR, no remote finishes
  locally. `all` previews each branch with `git merge-tree` (squash-merged branches are skipped, other
  authors' branches asked about), a merge with more than ten conflicts or a contradiction is aborted
  before asking, so a half-merge never sits in a shared checkout. `tag -f`, `stash`, `reset --hard`,
  `clean` and `worktree remove` are named as off limits, with the reason.
- **A handoff chip opens in a fresh worktree** with none of the uncommitted work. The new chat moves to
  the original checkout with `change_directory`; where it cannot, a binary patch of tracked and untracked
  changes, written through a temporary index so the real one is untouched, is applied on a branch at the
  recorded commit. A compacted source chat is read up to its summary instead of paging forever; the file
  name carries the session id; the file is grepped for secrets before the chip.
- **The context hook** reads back in 2 MB chunks up to 16 MB, so a screenshot in the last turn no longer
  hides the reading, and stays silent without spending its level when the prompt is itself a handoff.
- **`notify`**: a turn that leaves a background job or loop running is not "finished"; `--next` no longer
  goes live on a task notification; the public-ntfy guard parses the host (`www.ntfy.sh`, `:443` leaked the
  excerpt); bad URLs in the config are rejected without echoing them and error text is redacted; markers
  are written by rename; stale markers are pruned on every run and `SessionEnd clear` drops this chat's.
  130 selftest checks; 24 of them fail against the previous `notify.mjs`.
- **`review`** reads a branch or PR target from that ref, not the working tree; with no target, `--fix`
  and `--loop` edit only this chat's files; the loop fixes `bug` and `risk [high]` only; a written list of
  what is not a finding; finders get a brief, not the chat history; read-only `allowed-tools` again.
- **`say`** has a live mode (one to three lines, gist after) and a written mode that keeps digits and ids
  as they are; the sample no longer carries real-looking codes a model could copy.
- **`unslop`** has Russian triggers and a Russian tic list, applies to replies for people only, and gives
  way on length to a terse mode instead of fighting it.
- **The nine commands are skills now**, `tools/skills/<name>/SKILL.md`, the layout Anthropic's plugin
  reference recommends for new work; `commands/` is its older format. Names and invocation are unchanged.
- **`commit` and `ship` start with the repository's state already in the prompt**: `git status`, the
  branches, the remote and the recent log are injected with `!` lines when the skill loads, so the first
  look costs no tool calls. Measured on this machine with a probe skill under `claude -p`: the injected
  status reached the model on Windows.
- **After a `/compact` the chat is told where the full conversation still is.** A `SessionStart` hook with
  source `compact` names the transcript file, so a detail the summary dropped is searched for instead of
  guessed or asked again.
- **A chat that pauses on a background job now says so once** ("paused: 1 background job still running"),
  so a job that never ends, a dev server, no longer means silence. A later turn whose jobs were all there at
  the pause is the finish.
- **`hold`** handles stop, remove and edit by number, and counts the codeword only alone or at the end of
  a message; **`explain`** reports only this chat's work and drops the generic triggers.

## 1.5.0 — 2026-09-10

A run finds well and decides badly. Seventeen runs on one application and six on another say the first
half plainly: 7 findings of 2,851 carried neither a `file:line` nor a number, so the evidence contract
holds where it was put. The second half is three failures that all have one shape — a rule that lives in
prose while nothing on the path enforces it.

- **A fix now arrives with a reproduction that was run.** "A fix arrives with a reproduction that failed
  before it and passes after" has been in `MISSIONS.md` since the fix kind existed, and one fix run landed
  164 changes with nothing checking. `fleet-gate.mjs prove` runs the command rather than recording a claim
  about it, before the change and after, and writes the exit code, the commit and a digest of the working
  tree into the claim. `fleet.sh finish` refuses a `fix` or `root` task unless the first failed, the second
  passed, the command was the same one, and **the tree moved between them** — a dead build daemon on a real
  run returned `BUILD SUCCESSFUL, 0 failures` over a tree whose fix had been reverted, and only a forced
  rebuild found it. A `before` that passes is reported as a refutation, which is the cheapest good news a
  fix run gets: roughly 15 findings in every 100 end that way.
- **A cause several findings share is ruled on once, before any of them is patched.** The fix queue splits
  by file cluster so no two workers open one file, which is also why a shared seam never gets fixed: it
  belongs to somebody else. Measured on one project, a duplicated guard was named for consolidation in
  three separate run documents across three runs and deferred every time as "out of scope per the brief",
  while three modules had the same handle-discarding timer patched three times under a note saying a fourth
  would turn three patches into one helper. `fleet-gate.mjs cluster` writes a `kind: root` task per
  candidate shared cause and gates its members behind it on `after:`, the ordering the queue already
  enforces. The root is the one task in a fix queue allowed to edit files another task names, because
  everything reaching its seam is held while it runs. Refuting a candidate is a complete result and
  releases the members to be fixed on their own evidence.
- **Two ceilings, both from a real backlog, both in `calibration.json`.** Replayed against a 436-finding
  audit, the first shape produced one candidate 51 findings wide because they all touched a 5,000-line
  command file: gating fifty-one tasks behind one worker serialises a run and returns nothing the file
  split does not already give, so a candidate over six members is reported as a hotspot and gates nothing.
  A token more than 15% of a run mentions is the project's vocabulary — without that cut, `forEach` and
  `playerData` came out as candidate causes. Identifiers are read from the mechanism rather than from the
  whole finding for the same reason, and one file cited at two depths (`Timer.java` and
  `.../arc/util/Timer.java`) is one file. After both: 42 roots over 128 of 219 fix tasks, sized two to six.
- **An edit that drops a name something outside the repository reads is refused.** Three changes shipped
  from one project's runs with no question asked: two endpoints moved behind session authentication, so
  unauthenticated monitoring nobody in the run could see began getting 401; a history clear moved onto an
  event that also fires on a console `load`, so a restart plus an autosave load truncated history that had
  survived it; a detector deleted rather than repaired, whose rewritten config comment forced six servers
  to rewrite their configuration on next boot. All three were reasoned through carefully. The same runs asked
  86 questions and got 85 answers, so the operator was there throughout, and the gap was not taste. `hooks/fleet-contract.mjs` runs on `PreToolUse` and blocks an edit that removes a token listed in
  `.fleet/contract-surface.txt`, offering two ways past, both one line: file the `ask/`, or record the
  decision. `decisions.jsonl` is read out at landing. It is timid like `fleet-guard`: no fleet, no chip, or
  no surface file and it exits 0, and it raises a given name once per session, ever.
- **`fleet-gate.mjs surface`** generates that file from the tracked sources — routes, exported names,
  configuration keys, event names — and `fleet-init` now runs it and tells the operator to trim and commit
  it. The ignore rule for `.fleet/` changed shape with it: `.fleet/*` plus a negation, because git does not
  descend into an excluded directory and `.fleet/` on its own leaves the negation silently dead.
- **`fleet-gate.mjs asks`** prints every open question as one round with the recommendation its worker
  filed, and the decisions taken without asking underneath. What costs the operator is not the count but a
  question arriving alone in a chat they are not sitting in.

### Fourteen defects in `fleet.sh`, and what they had in common

Most of them were a guard that had never once fired, or one that fired on the wrong thing. The self-test
went from 167 cases to 282; 32 of the new ones fail against the old script.

- **One extra key turned the finding gate off.** An auxiliary line (`created`, `state_changed`) ran no
  checks at all and the `else` after it held every requirement, so
  `{"created":"note","severity":"blocker","area":"","observed":"","evidence":"","what":"x"}` was filed and
  exited 0 — an evidence-free blocker with the retired field name, straight into the backlog, because the
  merge routes on `severity` alone. Auxiliary lines have their own shape now: no `severity`, `created`
  needs `where`, `state_changed` needs `when`, and `what` is refused on every shape.
- **`unlink` refused itself, and so did worktree registration.** Both are documented as being run from
  inside the worktree, and the path guard treated a path containing the shell's working directory as
  unsafe — a path contains itself. That guard is the [M32] step, the one that stops `git worktree remove`
  from following a `node_modules` junction and emptying the main checkout, measured seven times out of
  seven. It had never succeeded once: across every run on this machine, worktrees registered came to zero.
  The predicate is right for a command that deletes a tree and wrong for two that do not, so those two now
  drop that term and `clean` keeps it. The self-test previously called `unlink` with an explicit path from
  the main checkout, which is why the documented path was the untested one.
- **The abort clock could never exit early**, for exactly the workers it guards. Its exit conditions were
  relative paths under `.fleet/`, and a worker that writes code sits in a git worktree where `.fleet/` is
  gitignored and therefore absent — so every clock ran its full term, up to twice the budget, and then woke
  a session that had finished hours before. Paths are absolute now, `.blocked` counts as an ending, and
  `<run>/FINISHED` is checked first and every round, so **one `landed` call ends every clock still armed
  anywhere on the machine**. The poll `drained` prints carries the same escape, which leaves nothing this
  plugin arms that a landing does not reach.
- **`landed` counted one chip twice.** A chip that wrote both `.blocked` and `.done` closed a two-worker
  run on its own, wrote `FINISHED`, and paged the operator's phone on that count.
- **The `verify` lane was claimable by nobody.** It is defined in `LANES.md`, `next` filtered on an exact
  match, and chips are only ever told `pane` or `repo` — so a verify task sat in the queue and `landed`
  then refused the run over a claim nobody could make. A repo worker takes it when no other verify task is
  held, and `next` says so. Stated in the code as what it is: a width, not a lock.
- **Without node, `sweep` reported health for a dead fleet.** The age helper returned empty, every claim
  read as zero minutes old, and the one instrument for a dead worker printed `no abandoned claims`.
  `recover --release` was worse: an empty quiet time sent every live chip down the resume branch. Those
  three refuse now rather than answer wrongly.
- **A pane walk that failed validation was unclaimable forever.** The claim directory stood, `pane-next`
  skipped it for every host, and the requester polled a result that was never coming; nothing swept
  `pane/running/`. A walk has no heartbeat, so it gets a lease instead — `pane_walk_lease_minutes`, a
  chosen 30, in `calibration.json`.
- **Releasing a task deadlocked its wave.** Every task whose `after:` named the released one waited on a
  done marker nobody would write. `--release` cascades now, transitively, skipping anything a worker holds.
- **`summary`'s rows and its totals read different globs**, so a run with a chip id like `cid-03` printed
  rows full of findings above a total of zero — and paged that zero to the phone.
- **A refused finding still created the chip's file**, so a worker whose first finding was rejected read
  afterwards as a chip that had found nothing rather than one that had never filed.
- Plus: `$run` unquoted in the two command strings printed for an operator to background, so a project path
  with a space armed a clock on the wrong directory; a `|| echo "  none"` that could never fire, because
  the pipeline's status was `sed`'s; and `cal` spawning an `ls` and a fresh `node` per constant lookup on
  the hottest path in the protocol. The calibration file is read once at startup now: `next` went from
  ~438 ms to ~320 ms per call, and `clock`, which is almost nothing but constant lookups, from 238 ms to
  146 ms.

### The two halves of the merge that could not disagree

`fleet-merge.mjs` refused to finish "if the sightings do not add up to the input or if a blocker present in
the input is absent from the output", and `fleet-collect.md` cited a 254-finding run as proof. The
sightings half was summed from the groups that had just been built out of the input, so it was `n === n`;
a merge sabotaged to write one row fewer than it grouped still reported every finding accounted for. It now
reads `backlog.jsonl` and `skipped.jsonl` back off disk, matches them to the chip files by finding id,
re-lists the directory so a `*.jsonl` it never opened fails the run, and removes what it generated when the
check fails, since `landed` gates on that file existing.

Three more, all of them silent:

- One worker's `skip_reason` took another worker's independently reproduced blocker out of the backlog with
  it, because the group's fate was read off whichever same-severity sighting loaded first. A group is
  skipped only when every sighting in it was, the strongest evidence is now the head, and skip reasons
  travel on the merged row.
- A chip id that was not a bare number — the register has held `cid-03` since 2026-09-03 — had every
  finding it filed dropped by the merge, which read only `NN.jsonl` while `fleet.sh find` writes for any
  chip string and prints `FILED`. Every `*.jsonl` is read now, and the files read and the files skipped are
  both named in the output.
- `fleet-retro.mjs` matched a session to a run by plain substring on its first message, so
  `2026-09-08-full-audit` collected every session of `fix-2026-09-08-full-audit`, and chip numbers that
  collide across runs were charged against the wrong completion marker. That is where a "1,935 minutes of
  session life after done" figure came from. The run id must match whole, the run's own register decides
  membership, and a session that cannot be attributed is left out and counted rather than guessed at.

### The reading path, halved

Every line on a mandatory path is paid on every run by every session, and the path had grown until
`fleet-run.md` demanded the pane be opened "before anything else you would read" with 1,381 lines mandated
above that paragraph.

| Path | Before | After |
|---|---|---|
| Worker, before its first task | 1,305 | 458 |
| Worker, pull mode, before its first claim | 1,715 | 868 |
| Worker, pane branch, whole run | 2,776 | 2,011 |
| Planner, before it can write a brief | 1,398 | 834 |
| Planner, pull mode with panes, whole run | 2,850 | 1,783 |

Pointers name a section rather than a file, `PROTOCOL.md`'s finding schema waits until findings are
written, `WORKTREES.md` until the tree is removed, and `BROWSER.md` until past the gate — with the gate
expression itself inlined, since that one line is what is needed first. The nine-line plugin-directory
preamble that stood at the top of nine command files is four lines now. Raw totals are flat; the path is
not.

Eight contradictions went with it, each one rule stated two incompatible ways: findings through
`fleet.sh find` or appended by hand (the gate wins everywhere — a hand-written line passes no check); who
writes `.done` (`drained` in pull mode, by hand only on an assigned brief, where there is no queue to
drain); three mutually exclusive end-of-turn states in one file; the pane ceiling as ten, five and two,
which are three different things and are now named as such; what the finding gate actually refuses,
rewritten from the code; a `while true` watch held up as a cautionary tale two files from the `while true`
watch this plugin supplies; a brief spec carrying a field only tasks use and missing two the queue parses;
and `fanout:`, kept with "no script reads this field" said out loud.

### Models: the knob that turned out to exist

`MODELS.md` said per-stage reasoning effort was "a knob that does not exist" and told planners to treat
effort as a session-wide dial. The first half is still true of the `Agent` tool's parameters; the
conclusion drawn from it was wrong. A subagent definition takes both `model:` and `effort:`, and effort is
the one nothing overrides per call — so `fleet-scenario` (sonnet/high), `fleet-profiler` (sonnet/medium),
`fleet-triage` (haiku/medium) and `fleet-design-eye` (opus/high) now carry their tier and their effort,
each with a sentence saying why. The model resolution order, both environment variables and
`modelSettings.<id>.effortLevel` are written down, along with the one thing that is not settled: the
documentation says a session started from a chip takes the dispatch default rather than the spawning
session's model, and this plugin's operator reports the opposite in practice. That is recorded as an open
question with the experiment that settles it, rather than answered from either side.

### What actually blinds a pane, and what a pane actually costs

Two measurements on 2026-09-10, both of which overturned a rule this plugin had been enforcing.

**[M33] The screen has nothing to do with it.** A sampler left in a page for 463 seconds, recording frames
per second while the operator moved the pane through six states by hand. A pane fully covered by another
window composites at 300 frames a second. So does one on a second monitor with a corner showing, and so
does one pushed entirely past the edge of the desktop at `screenX` 5032. Two things stop it: another tab
being selected in its window, and that window being minimised. The ceiling of five panes, justified by how
many tile readably on a display, was measuring the wrong constraint - panes nobody is watching can be
parked off the desktop and go on working, and the ergonomics section that offered that as a risky trick
now offers it as the answer.

Three signals that look like they could replace the frame gate, and cannot. `innerWidth` held its real
value through 142 consecutive seconds of zero frames. `document.visibilityState` reported `visible` on a
pane delivering nothing, immediately after a screenshot was taken of it. And `tabs_context` answered
`The Browser pane is currently displayed` while the page inside it drew zero frames at a width of 949 px.
The host's flag sees whether the pane has a place in the layout, which is a different question.

Two behaviours nothing had named. **The first second after a tab is selected delivers zero frames**, at
both transitions, so a gate fired the instant an operator says they have opened the pane reads blind and
sends the worker back to ask for a pane that is already open - read zero, wait a second, read again.
And a **minimised window emits stray seconds of 2 to 4 frames**, which is the mechanism behind the
existing rule that a reading between 1 and 59 is blind: a `frames > 0` check would have passed that worker.

The same two pane states also split `setInterval`, and it fails worse than silence. With the pane not laid out it ticked
3 times in a minute. With the pane laid out but not compositing it ticked **142 times in 142 seconds**,
one per second, exactly on time, while the page drew nothing. `PERF.md` told workers to sample with it;
now it tells them to put the frame gate beside every series it produces.

**[M34] A pane is one renderer per tab and about 113 MB, and then whatever the page weighs.** Closing and
reopening reproduced that to within a megabyte. Then 150,000 DOM nodes went into one tab: that renderer
went **132 MB to 2,061 MB**, free memory 14.9 GB to 12.0, commit 33.5 GB to 36.3 against 31.2 physical.
A reload gave none of it back - only closing the tab did. [M21] measured +344 MB per pane in August and
concluded that RAM does not cap a fleet; the number was right and the conclusion was about a light page,
so that entry is now marked superseded rather than corrected.

### Memory discipline, in three refusals

The operator's machine dies of this, and the rules against it were prose - in `LANES.md`, in `MODELS.md`,
and in the operator's own `CLAUDE.md` - which this project measures at approximately zero compliance. They
are refusals now, at the three places the cost is visible.

- **`fleet.sh next` reads the machine before every claim.** Below `memory_floor_gb` it hands out nothing:
  exit 6, `MACHINE TIGHT`, and the loop to background while waiting. It refuses the task and never the
  worker, because a session that stops because it was refused is a dead chat and nothing restarts one
  [M03]. It releases only above `memory_clear_gb`, and the gap between the two is hysteresis: with one
  threshold every held worker claims again on the same reading, together, which is the moment the box dies
  rather than the moment it recovers. `fleet.sh status` names who is held, since a worker waiting on memory
  holds no claim and would otherwise appear nowhere.
- **A `PreToolUse` hook refuses a full test suite or a full typecheck** from a worker that does not hold
  the verify lane, when the machine is tight or one is already running. It names the scoped form and the
  verify lane in the refusal, and it raises itself once per session, ever. The verify lane exists for
  exactly this and, until this release, could not be claimed by anybody at all.
- **The same hook refuses a browser call on a full machine** and tells the worker to close its pane, since
  a reload returns nothing and only closing the tab does [M34].

`fleet-load.mjs` gains `--clear <GB>`, which exits 0 when there is room and is what a held worker waits on,
and its `tight` reading moves into the census where callers can read it rather than being computed inside
the human-readable table.

**And the census was broken.** `JSON.parse` was refusing the whole 200 kB process list because one command
line on this machine carried a bell character - an agent's own arguments, four of them - so the census
threw and every caller fell back to a default. `fleet.sh width` falls back to a flat cap of six, which
means the memory term had been silently absent from lane sizing on any machine running a process with a
control character in its arguments. Control characters are stripped before the parse now, and a parse that
still fails says so instead of returning an empty list. Fixing it was what made the rest of this section
possible: every refusal above reads that census.

### Seams, for cutting rather than porting

`PORTING.md` gains a table of the four optional halves — call, design and canvas, worktrees, browser and
panes — with what dangles when each is removed. Call is clean: four files and one mission section. Design
leaks two conditional lines into core. Worktrees take the path gate with them, which is reason enough to
keep both. The browser half cannot be cut by deleting files, and does not need to be: every pane document
is behind a branch pointer, so a paneless project pays only for prose sitting on a shelf, not for turns in a run.


## 1.4.0 — 2026-09-08

Worktrees get a lifecycle. A run that writes code left one worktree and one branch per worker on the disk
with nothing in the plugin saying who removes them, so every agent improvised the removal - and on Windows
improvisation looks like `rmdir /S` on screen, which is the moment an operator stops trusting the run.

- **Measured first, and the obvious command turned out to be the unsafe one [M32].** A worktree carrying a
  `node_modules` junction into the main checkout, then `git worktree remove`: **the main checkout's
  `node_modules` was emptied, eight runs out of eight**, exit code 0 every time, with a remote and
  without. `--force` behaves the same, and a junction one level down is followed exactly as one at the
  top. Unlinking first left the main checkout intact. The recursive delete walks into the reparse point; it
  does not know a link from a directory. The rule is therefore not "avoid `rmdir /S`" but **unlink every
  reparse point before anything recursive touches the tree** - `git worktree remove`, `ExitWorktree`,
  `rm -rf` and `rmdir /S` alike.
- **`fleet.sh clean <run-dir>`** is the only path in the plugin that removes a worktree, and it is a dry
  run unless given `--remove`. It acts only on worktrees the run registered, only under
  `.claude/worktrees/`, never on the main checkout and never on a locked tree. It **keeps** any tree with
  uncommitted changes, with commits neither in the main checkout's branch nor on the branch's upstream, or
  on a detached HEAD; it unlinks reparse points at any depth first; it removes without `--force`; and it
  deletes a branch only with `git branch -d`. Everything skipped is printed with its reason, and the
  ignored files that would go with a tree are listed before it goes. There is deliberately no flag that
  deletes a tree holding work.
- **`fleet.sh worktree <run-dir> <chip>`** registers a code worker's tree at its first claim. Registration
  scopes cleanup to this run: the machine runs several runs at once, and a blanket sweep of
  `.claude/worktrees/` would take a live run's tree. A run that registered nothing is reported and left
  alone. **`fleet.sh unlink <worktree-path>`** gives a worker the unlink as a command rather than as a
  sentence in a document, gated by the same path rule.
- **A path gate, because a path goes wrong at its end.** An empty variable, a `dirname` too many, a prefix
  stripped twice: each turns a path into its own parent. `unsafe_path()` refuses anything relative, a
  network path, one holding `..` or a `.` segment, one shallower than `min_path_segments`
  (calibration, 4), one not inside `.claude/worktrees/` **with something after it**, and one that contains
  the shell's own working directory. It runs at registration as well as at cleanup, so a tree that could
  never be cleaned is caught while somebody can still move it, and `clean` prints the `git worktree move`
  line. A worktree the gate refuses is reported as a `STRAY` and never touched. Run against a real project
  it found eleven worktrees at the root of drive C.
- **A review round at the top tier found a blocker and three majors in the above, all fixed and all now
  under test.** A worktree on a detached HEAD was removed and its commits left unreachable. A detached main
  checkout made `merge-base` compare a branch against itself, so every tree read as merged. The branch was
  taken from the registration rather than from the worktree, so a worker that switched branches had the
  wrong one checked. And the unlink ran before git could refuse, so a locked tree lost its links and was
  reported as untouched. The same round found the cwd guard was **inert on Windows** - `pwd` prints
  `/c/...` where git prints `C:/...`, so the comparison never matched - which is the plugin's own
  failure mode, a guard that looks like protection and is not.
- **`docs/SAFETY.md`**: the closed list of what an unattended fleet may delete, which slip each guard
  catches, and **where the guards stop**: a worker's own exit is not gated, an
  agent's own shell is not gated, and the measurement is one machine. It also states what the evidence for
  writing the reason above the rule does and does not support. The ordering has a controlled ablation
  behind it for text a model **generates** (Wei et al.; Turpin et al. on rationalising a pre-committed
  answer) and is not established at all for a document a model reads, where the one measured effect on
  constraint-following is that reasoning first makes it **worse**. The convention is kept and is not asked
  to carry the safety.
- **`docs/WORKTREES.md`** carries the procedure and the measurement; the README states the closed list. No
  `git reset --hard`, no `git clean`, no `git checkout --` anywhere in the plugin.
- Twenty-three self-test checks over the path gate, registration, the dry run, the work-holding guard, the
  detached-HEAD case, stray reporting, the `unlink` command, and two real junctions - one at the top level
  and one nested - each asserting the target survives.
- **Not done, written down:** the junction measurement is one machine and one git version; the unlink-first
  arm is one run per method, re-asserted by the self-test rather than by repetition; `clean` has not yet
  run against a real multi-worker code run.
- **The commands were audited against the published frontmatter spec, and two contradictions came out of
  it.** `README.md` and `commands/fleet.md` listed `fleet-run` among the commands only the operator may
  start, while its frontmatter correctly allows model invocation - and it has to, because the operator
  starts a worker by clicking a chip and the model in that new session is what invokes `fleet-run` there.
  Acting on the prose would have broken every worker. Separately, `fleet-redesign` told the model to run
  `/makarasty:fleet-design` when the canvas was missing, which the harness blocks: that command carries
  `disable-model-invocation`. It now prints the line for the operator instead. `docs/COMMANDS.md` records
  the invocation contract, the checklist before adding a command, and the field most easily misread:
  `allowed-tools` is a one-turn permission **pre-approval**, not a restriction, and it cannot separate
  `fleet.sh clean --remove` from the safe helper calls that share its prefix - which is why the protection
  lives in the dry-run default and the path gate instead.

## 1.3.0 — 2026-09-08

A tenth kind, for the conversation rather than the code: a person who knows the system and not the
language, on a call with a vendor, a partner or an interviewer, reading from a page the fleet wrote and
asking a fresh chat mid-call. Same premise as the rest - a number said aloud that nobody measured is a
blind pane - so the gate is on the facts.

- **`kind: call`.** Two stages gated by `after:`: facts (repo, one task per source, Opus) and the
  script (repo, one task, the design model). A fact is a heading with `evidence`, `when` and one of
  four words for how it is known - measured, read, told, guess - and a guess is never spoken: it goes to
  the traps. The findings of a call run are the claims the facts refuted, which is what the previous
  letter or the previous call got wrong. `docs/CALL.md` holds the fact shape, the page, the register
  and the live contract.
- **`scripts/fleet-call.mjs check`** refuses a page citing a fact no file defines, a fact with nothing
  behind it, a page that cites nothing, a missing `CALL.md`, and a digit inside a line meant to be read
  aloud; `--stale <days>` lists the measured facts older than the window, for the footer's "re-measure
  before the call". Twelve self-test checks.
- **`templates/call-script.html`**: the styles and fixed sections of the earlier vendor-call page, so the script task
  fills a page rather than designing one. What the interpreting research added to the page: a numbers
  table, because numbers are the words dropped first under load (Desmet et al., 56.5 to 86.5 percent
  with numbers on screen), and the five repair lines air traffic control keeps - say again, confirm,
  correction, standby, unable - so a lost speaker has something to say.
- **`/makarasty:fleet-call <who and what about>`**: `fleet-plan` with the kind and the stages fixed,
  one interview round (counterpart, the two languages, the source list, the answers to bring home, the
  reserved topics, where the page goes), repo chips only, and the page in the operator's chat when the
  run lands. **`/makarasty:fleet-call live <run-id>`** in a fresh chat is the call itself: every reply
  is two blocks - the read language with a source tag, the speak language below, one sentence per line,
  numbers as words - and a question the facts do not answer gets the dig notice in both languages
  first, then the dig in the same turn, then the answer with its tag. `unslop` on throughout; no
  subagent, because the speaker is on a call.
- **`fleet.sh landed` gates on `backlog.jsonl` existing, not on it being non-empty**, which is what
  `fleet-merge.mjs` documented all along: a merge that found nothing writes an empty file, and a call
  run whose facts refuted nothing, or a canvas run without a compare stage, could not land before.
- A sixth eval case, `script-speaks-only-facts`, scores a script worker that speaks a number no fact
  carries or leaves a guess out of the traps. Unrun, like the other five.
- **`makarasty-tools` 1.2.0: `/makarasty-tools:notify`**, one message to the phone when a chat you walked
  away from ends its turn. Arming is a marker per session id, so a chat nobody armed never sends; the
  Stop hook sends once, the tail of the last reply under the verdict, and disarms. A last reply ending in
  a question reads "waiting for your answer"; `StopFailure` reads "stopped on an error" and keeps the
  marker; a permission prompt reads "needs you", once per five minutes. A chat reopened after a crash
  gets one line in context from the `SessionStart` hook - check whether the work is already done before
  doing anything - and a finish written to disk but never delivered is resent on reopening with no model
  turn spent, or the moment the wizard saves a channel. Telegram, Discord, ntfy and a plain webhook, read from
  `~/.claude/makarasty/notify.json`; Discord is POST only, so a GET webhook does not exist, and it is
  sent with `@everyone` by default because a webhook message without a mention does not buzz a phone.
  **`notify.mjs setup`** is a wizard in the terminal, not a browser tab: which channel, the steps for
  that one, the single value it needs, a test message that must arrive before anything is saved, the
  bot's name looked up from the token so the person knows what to open and press Start in, a topic
  generated for ntfy. The token goes keyboard to file and never through a chat. **The hook commands in
  `plugin.json` start node only when a marker file exists at all** - one `ls` per event otherwise, in
  every session - and a marker older than seven days is pruned at the next arm, so a chat that died
  unreopened cannot hold that guard open. Sends retry twice on a network failure and not on a 4xx.
  `fleet.sh landed` posts a run's headline through the same script, once, the first time it writes
  `FINISHED`; the `FLEET.md` webhook line is retired in favour of that file.
  `tools/hooks/notify-selftest.sh`: 52 checks over the hook, the guard and the wizard, with a dry-run
  sink and no network. Measured on the development machine: a node start is 32 MB and about 50 ms, the
  hook with a marker peaks at 39 MB for that long, and the guard alone is about a millisecond. Not measured yet: whether the desktop app's queued-message path makes `--next`
  unnecessary, and the wizard against a real Telegram bot.
- **Not done, written down:** no fleet has prepared a real call yet; the vendor-call page this is
  modelled on was written by hand in one chat.

## 1.2.0 — 2026-09-03

The design half: three mission kinds, one agent, two scripts, one document and two planner commands, all
built on the same premise as the rest - a screenshot is not evidence, and an artboard drawn from memory is
a blind pane.

- **`kind: critique`.** One screen per task, pane lane, one `fleet-design-eye` spawn. Two probes run
  before any picture: `visual-probe.js` for collisions and clipping, and the new `design-probe.js` for
  siblings off their row, gaps that do not repeat, controls of two heights on one line, values outside the
  page's own scale, text under 4.5:1, targets under 24 px, images at the wrong ratio, boxes drawn around
  nothing, lines over 90 characters - plus the page's scale and its landmarks. The screenshot is zoomed to
  a candidate and confirms or refutes it. Verified on `scripts/fixtures/design-probe.html`: nine planted
  defects found, zero of ten look-alikes reported, one extra candidate [M29]. Geometric findings carry
  `rects` (`a` the subject, `b` the box it is measured against), and `fixqueue` routes a finding with
  `rects` or a `probe` field to a `kind: design` task, because the design model owns the screen it repairs.
- **`kind: canvas`.** The application's screens as `<Screen>.dc.html` artboards under `design/canvas/`,
  assembled into the Claude Design canvas the harness's `design` skill carries. Stages gated by `after:`:
  recon (a pane measures the screen with the design probe), the primitives sheet, the screens (repo, from
  source and recon), an optional compare (a pane measures the artboard's plain render against the screen),
  assemble. `scripts/fleet-canvas.mjs` is the gate and the assembly: `stamp` writes the provenance block,
  `check` refuses an artboard that names a source file that does not exist or claims a measurement through
  a blind pane, `layout` writes `canvas.json` with the editor's gaps and a cover, keeping every position an
  operator moved, `plain` renders a static artboard standalone, `seed` drives the design skill's helper and
  its check. Ran end to end on a fixture project. Isolation is `none`: one new file per task, no source
  edits.
- **`kind: redesign`.** Proposals as `<Screen>.Proposed.dc.html` on a `Proposed` page beside the captured
  screen, loading and empty states as sibling artboards, the design model end to end, and two to four
  direction sketches on their own page first when the operator has not chosen one. An approved proposal is
  the specification a `design` mission implements; `docs/DESIGN.md` closes that loop.
- **`/makarasty:fleet-design` and `/makarasty:fleet-redesign`**: `fleet-plan` with the kind, the axis and
  the stages fixed. Both end with the planner publishing the seeded page through the `design` skill's own
  publish step, because the runtime pin and the capability rule move with the harness and are not copied
  here.
- **`FLEET.md` gains three optional lines**: `Canvas:`, `Canvas viewport:`, `Design tokens:`. The token
  file feeds `window.__fleetScale`, and off-scale becomes off-token.
- **Measured while building it, and guarded:** Git Bash on Windows rewrites a `/cases` argument into a
  path under its own install, so `stamp` refuses a route that does not start with `/` and names
  `MSYS_NO_PATHCONV=1`. The probe's first draft counted a 13 px padding once per side and voted it onto
  the page's scale; it counts once per element now.
- Self-test: twenty-four checks over the probes, the canvas gate, the layout, the plain render and the
  seed. The seed check drives the real helper when the design skill has been extracted on the machine and
  otherwise asserts the refusal names the reason. A fifth eval case, `artboard-carries-provenance`, scores a worker
  that claims a measurement it never made.
- **Not done, written down:** no fleet has captured a real application yet; the compare tolerance is a
  starting number; the probe was verified in one browser; publishing is the planner's manual step.
- **Docs stop selling a terse-reply plugin as a saving.** `fleet-run`, `docs/MODELS.md` and `docs/PULL.md` told a
  worker to switch it on from the first message; M24, measured in the same release, puts chat prose at 5%
  of what a worker emits and output at 0.3% of what moves. The three paragraphs now say what the plugin
  is worth, and name a minimal-code plugin as the one that works on the layer a writing kind actually spends on.
- **Two ledger entries from the 2026-09-04 fix run, added 2026-09-05, and the rule each produced.** [M30]
  Every one of four paneless workers grew its context by 20-30 k per task, stood at 970-992 k around its
  thirtieth claim and was compacted by the harness: 2,414 M cached reads, 471 k per turn, the dearest run
  in the ledger, and zero subagent spawns over 184 claims with `fanout: 3` in every task's reach.
  `fleet.sh next` now prints `DELEGATE` once a chip has finished `delegate_past_tasks` tasks (calibration,
  3), and `fleet-retro.mjs` prints context per turn, peak context and compactions per worker, tells a pane
  worker from a repo one by whether it ever called a browser tool rather than by a phrase in its prompt,
  and reads a chip id that is not a number. [M31] The shell reads that keep refusing `Edit` come from the
  harness's own auto-mode instruction to use `cat` and `sed`; the rule is now "edit with what you read
  with", not "Read first".
- **A stopped run is still collected.** The 2026-09-04 run ended on the operator's word, was merged and
  pushed by hand, and never saw `merge` or `landed`: 180 findings in four files and no backlog, for the
  third time in this ledger. `PULL.md` says how to stop a run and that collection still follows.
- **`makarasty-tools` 1.1.0: `/makarasty-tools:say`**, the spoken register: lines a person who is not a
  native speaker reads aloud to a vendor or its support. One sentence per line, numbers as words, "what
  we do, what we get, the question" in place of a proposal, and the exit "maybe we do it wrong".
  Distilled from a vendor call script of 2026-08-21 and the two corrections that produced it. `unslop`
  gains one cut, the word the reader would have to look up, and points at `say` for the spoken case.


## 1.1.1 — 2026-09-02

An adversarial read of 1.1.0 by a second model, verified against the tree and the two crashed runs.

- **`recover` no longer treats its own blindness as a fact about the workers.** It reads the host's
  `CLAUDE_CONFIG_DIR` (`CLAUDE_PROJECTS_DIR` still overrides), says so when the transcript directory holds
  nothing, and **refuses `--release` in that state** — releasing on no evidence would free the claims of
  workers that are alive. That machine wants `sweep --release`, which asks the heartbeat question instead.
- **A live session is no longer offered for reopening.** A transcript written to inside the hook's claim
  window prints as `LIVE?` with no command: reopening a running session puts a second writer on its file.
  On the real `2026-09-01-recon-all` run the old behaviour printed a `claude -r` line for a chip whose
  transcript was four minutes old.
- **The printed line is now the command the operator needs**: the directory that session was started in,
  read from the transcript (a worktree worker's is not the planner's), and a first instruction telling the
  worker to write its heartbeat before continuing. A session reopened with no prompt sits there until
  somebody types into it, and that is also the cheapest answer to "nothing confirms a resume happened" —
  the heartbeat is the confirmation, and `status` sees it move.
- **LANDED lines carry their session id.** A finished worker is the one whose context a follow-up run wants
  most; "leave it alone" was advice about this run only.
- **`after: <task-id>` in a task's frontmatter, honoured by `next`.** A gated task is not handed out until
  its dependency's done marker exists, and the worker is told `QUEUE WAITING` rather than `QUEUE DRAINED`
  so it polls instead of writing `.done` and ending its session. This is what makes the `design` kind's
  three waves a mechanism rather than a paragraph. Which paths a screen task may not touch is still prose.

## 1.1.0 — 2026-09-02

Three runs on 2026-09-01 (12, 13 and 6 workers; 1,500, 256 and 43 backlog rows) and a restart in the
middle of them are what this release answers.

- **A run survives the machine dying.** `fleet.sh recover` and `/makarasty:fleet-resume` read the chip
  register, the standing claims and the session transcripts under `~/.claude/projects/`, then print which
  chips can be reopened with `claude -r` (context intact), which have to be respawned, and which claims are
  free to release. Measured 2026-09-01: after a restart, the 26 worker sessions of two runs were absent
  from `ListAgents` and from the app's session list, archived rows included, so the revive message — the
  only recovery this plugin had — could not reach anything. `recover` releases nothing on its own, keeps
  the claims of chips that can come back, and reports a claim whose chip never registered a session id as
  UNKNOWN rather than sweeping it: registration needs `CLAUDE_CODE_SESSION_ID`, and its absence is not
  evidence of death.

- **`kind: design`**, the sixth mission kind. One screen per worker, and the design model owns the screen
  end to end - reading the code, the markup, the copy, driving the browser, the verification. No cheaper
  model touches the markup afterwards, and where a design model is not warranted the builder is the strong
  general model rather than a cheap one. Three waves: recon, then ONE task owning the shared primitives,
  then the screens. It exists because of what the split produced: every visual defect a six-worker sweep
  found on 2026-09-01 lived in a state or a moment nobody designed - a skeleton drawing fewer rows than the
  first page returns, a header that loads at a different height, a filter bar opening 60-130 ms into a
  navigation ON THE OUTGOING page and pushing it down 70.9 px, a ghost shorter than the number it stands
  for, size utilities discarded by an icon font. The design model had designed the loaded screen; the
  loading state, the transition and the cascade went to somebody who had never held the design.

- **What a run costs, measured and written down as rules** - `docs/PULL.md` "Worker economy", ledger
  entries M24-M28. Across 7 runs and 57 worker sessions: 19,535 turns, output 20.4 M tokens (thinking
  5.7 M), cache **read 6,421 M**; average context 330 k per turn, peak 882 k. The bill is turns multiplied
  by context and nothing else is close, output being 0.3% of the tokens that moved. Chat prose is 5% of
  what the models emit by characters, so compressing narration is not the lever it was assumed to be.

- **A correction, from a second machine.** The first draft of M25 generalised one day's latency into a
  rule: "the shell is two orders of magnitude slower than the file tools". Re-measured over 899 sessions
  and 261,308 calls, `Bash` p50 is 173 ms rather than that day's 1,892 ms, `Grep` beats shell grep only
  2x, `Edit` beats in-place `sed` 1.2x, and **`Glob` is three times slower than `find`**. What survives is
  a precondition, not a speed argument: the harness refuses an `Edit` to a file that was never `Read`, and
  187 edits across that corpus failed exactly there. M28 records the larger finding the same data turned
  up - a session mode in which every permission-gated call carries a fixed extra 1.5-2 s (gated p50 2,081
  ms against 102 ms, p10 unmoved), worth 16.55 h of a 211 h tool wall and 22% of the heaviest day.

- **A fourth eval case, `reopens-before-releasing`**: a crashed run where two chips look identical from
  the run directory and only one session can be reopened. It scores a planner that replaces a worker whose
  context was recoverable, or releases a claim that can still come back. Unrun, like the other three.

- **`fleet-retro.mjs` reports those costs per run**: average context per turn, shell against file-tool
  calls, reads done through the shell, `Edit` calls refused for an unread file, and calls that failed on a
  rate limit rather than on the command.

## 1.0.0 — 2026-08-31

First release. The version numbers before this one were development markers in an unpublished manifest,
never installed by anyone but the author. Nothing was released, so nothing was ever upgraded; this is
version one.

What it is: a plugin for running one mission across several Claude Code sessions at once. Each worker
holds its own context, claims one task at a time from a queue on disk, gates whether it can actually see
what it is inspecting, and reports by writing files. Nothing messages anything.

### What this release is built on

Four measured runs over six days against one large Vue and Node application, the last two on 2026-08-31:
an audit run (14 workers, 54 tasks, 246 findings, 32 blockers) and the fix run that followed it (8
workers, 32 tasks, 741 files changed, 83 commits, every cited commit verified present on the branch).

### The rules that came from those runs

- **The frame gate.** A browser pane that is not displayed stops compositing while still navigating and
  still returning plausible DOM, so a blind worker reports fiction with full confidence. Every browser path
  measures a one-second `requestAnimationFrame` count first. Before the gate: 8 of 8 workers blind and 94
  confident fabrications. After: 22 of 22 workers across two runs saw what they claimed to see.
- **The finding schema is a gate, not a request.** `fleet.sh find` refuses a finding with no evidence, a
  severity outside the four, or the retired field name. 246 of 246 findings in the audit run carry the
  stamps only that path writes.
- **Lanes.** A fleet queues for whatever the machine has one of: `pane` for the browser, `verify` for the
  test suite, `repo` for work that only reads files. `next` takes the lane as an argument and refuses to
  hand a paneless worker a browser task. The lanes are capped separately - the pane lane by the operator's
  display, the repo lane by the machine - because capping file work at the width of a monitor is how a run
  ends up eight browsers wide and two files wide.
- **Pending work mirrors unwritten obligations, in both directions.** A session runs only while something
  invokes it, so a worker with an obligation arms a clock; a worker with none must have nothing armed.
  Across the two runs 87 clocks were armed and none stopped, which cost 1,090 minutes and 282 model turns
  of session life after the workers' own completion markers. A clock now watches the disk that closes its
  obligation and exits on its own, so there is nothing left to remember.
- **A run ends visibly.** A generated banner from disk, the session renamed so the sidebar shows it
  finished, one notification for the whole run, and a `FINISHED` file that survives every missed
  notification.
- **Two panes, not ten.** Seven panes carried 104 minutes of browser driving in a 153-minute run; two
  carried three minutes in the run after it. The display fits five; the work has needed two.

### Rules that stopped being rules

Three of them were deleted rather than restated, because the measurement said asking harder would not
work:

- **The abort clock disarms itself.** `fleet.sh clock` prints a loop that watches for its own task's done
  marker and exits when it appears. The previous shape asked the worker to stop it: asked 87 times across
  two runs, obeyed zero times.
- **`drained` ends the worker.** It writes the marker, prints the banner generated from disk, and prints
  the exact session title to set. Four prose rules became one call.
- **`fleet.sh width` sizes the repo lane** from the ready queue and free memory, so the formula has one
  spelling instead of one per doc that quotes it.

The rule behind all three: a requirement belongs in a script when the script sits on a path the worker
already walks, in a hook when only the harness can see it, and in prose only when neither can - and prose
costs are paid on every read by every worker.

### What a stranger has to be able to do

- [`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md) is a fifteen-minute first run for somebody who has never used
  this: prove the machine can run it in one second, set a project up, plan, click two chips, read the
  banner. It names what to do when each of the five common failures appears.
- The README says **what the version number covers** and what is explicitly calibration rather than
  contract, and carries a troubleshooting section for the four failures that are not in this plugin: a
  stale plugin cache, a run directory inside a sync client, CRLF line endings on Windows, and Git Bash
  not being found.
- **The three side commands moved to their own plugin**, `makarasty-tools`, from the same marketplace.
  They travel with a fleet and have nothing to do with its contract, so they version apart from it.

### Measurements live in one place now

`docs/MEASUREMENTS.md` holds 23 entries: what was run, what was counted, how, and which rule it produced.
Rules carry the number and cite the entry (`[M04]`), so a reader deciding whether to remove a rule sees the
cost of removing it without paying for the story on every read. The self-test fails on a citation with no
entry and on an entry nothing cites.

`calibration.json` holds every constant a script or a planner reads — lane widths, the frame-gate
threshold, the budget multiplier, the fan-out width — with the measurement each came from. A number that a
script reads cannot go stale the way a number retyped into prose does.

### Hardened against what other people's runs already hit

Read from the issue trackers of comparable orchestrators and from classic file-queue designs:

- **`fleet.sh sweep`** names claims nobody is advancing and, with `--release`, hands them back. Atomic
  claiming prevents two workers taking one task and does nothing about a worker that died holding one.
- **A `Stop` hook** refuses, once, to let a worker end its turn on a claim it took in the last ten minutes
  and never touched again — the signature of the failure that cost one run 516 minutes, and the one thing
  here that no script can see. A worker that has written a heartbeat, or whose claim is older than that
  window, is left alone: that case belongs to the planner's stall report and `fleet.sh sweep`.
- **Portability**: one locale pinned, temp files with explicit templates, no `date -r` on a file (it means
  two different things on GNU and BSD), `.gitattributes` pinning shell scripts to LF so a Windows clone
  cannot produce a CRLF shebang.
- **A run directory on a sync client is documented as unsupported** rather than left to fail strangely.

### What ships

The fleet plugin: seven commands (`fleet`, `fleet-init`, `fleet-plan`, `fleet-run`, `fleet-login`,
`fleet-wait`, `fleet-collect`), three agents, the reference documents under `docs/`, and the scripts —
the queue bookkeeping and schema gate (`fleet.sh`), the reconciling merge (`fleet-merge.mjs`), the
self-test that runs the whole protocol against a temporary directory in about a second
(`fleet-selftest.sh`), a machine census (`fleet-load.mjs`), a post-run forensics reader
(`fleet-retro.mjs`), and the geometry probe (`visual-probe.js`).

The `makarasty-tools` plugin: `commit`, `review`, `unslop`, and the hook that carries the humanised reply
mode between prompts.

### Known limits, written down rather than fixed

- Every number here was measured on **one machine** (Windows 11, 31.2 GB, 16 cores), by **one operator**,
  against **one application**. They are real measurements and a weak sample.
- The **pane broker** (`docs/BROKER.md`) has never run live. Its mechanics carry self-test assertions and
  nothing else.
- The **published install path is untested**: this release was developed and installed from a local
  directory marketplace.
- **Portability is half exercised.** `docs/PORTING.md` names eleven host assumptions and only Windows has
  run a fleet. The scripts are better tested than that: the self-test passes under `dash` as well as
  `bash`, so the POSIX claim is checked rather than asserted — but a real run on macOS or Linux has not
  happened.
- The self-test covers **mechanics only**. Whether a worker asks for its pane in the first minute, renames
  its session, or splits its own work sensibly is asked for in prose and enforced by nothing — and this
  plugin's own measurements include two cases of a prose rule being routed around. Where that mattered
  most, the rule was moved into a script instead; where it could not be, it is named here.
- `fleet-retro.mjs` reads the host's transcript layout directly and will break if that layout changes.
- The **eval suite in `evals/` has never been run**: `claude plugin eval` is in early access and was
  refused on the account this release was built on. Three cases are written against its documented shape,
  and they are the plugin's only test of whether a worker reading these documents does what they ask.
