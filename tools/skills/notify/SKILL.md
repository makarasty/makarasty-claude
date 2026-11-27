---
description: "Sends a Telegram message when this chat, another chat or a fleet run finishes; set up, test or turn off. notify me when done, ping me / напиши когда закончишь, подключи телеграм, пингани, выключи уведомления."
argument-hint: [what the person is waiting for] | setup | test | status | off | --session <id>
---

The chat cannot tell whether the person is still at the screen, so it never decides on its own to message
them. The person arms it once, and the hook sends exactly one message when the turn they are waiting for
ends. Arming is a marker on disk keyed by session id; a session with no marker never starts node.

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/notify.mjs" --arm <label>        # this chat, at the end of this turn
node "${CLAUDE_PLUGIN_ROOT}/hooks/notify.mjs" --arm --next <label> # this chat, at the end of the NEXT turn
node "${CLAUDE_PLUGIN_ROOT}/hooks/notify.mjs" --arm --session <id> <label>   # another chat
node "${CLAUDE_PLUGIN_ROOT}/hooks/notify.mjs" --status | --test | --disarm
```

Arguments map one to one, only when the whole argument is that one word: `status` runs `--status`, `test`
runs `--test`, `off` runs `--disarm`, `setup` connects Telegram (below). Anything longer is the label, even
when it starts with one of them ("test suite", "off-site backup"). Asked in words to switch it off ("выключи
уведомления", "stop pinging me"), run `--disarm`.

The label is the person's words and may hold an apostrophe or a `$`. Put it in single quotes, and write each
apostrophe inside it as `'\''`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/notify.mjs" --arm 'Mike'\''s deploy'
```

## Arm first, then do the work

The label is what the person is waiting for, in their words, a few words long: "the migration", "тесты
на бэке". It is the first thing they read on a lock screen.

**When the message that asks to be told also carries the work** ("run the suite and ping me when it is
done"), arm plainly, then do the work. The turn ends when the work does, and the message goes out on that.

**When the message only asks to be told**, and the work comes in the next message, arm with `--next`. A
plain arm would fire the moment this turn ends, which is now, with nothing done.

**When the person names another chat**, find its session id and arm with `--session`. A session-listing
tool, when the host offers one, gives the id beside the title. Arming a chat that has already finished
waits for its next turn, so say so. The message names that chat's project, not this one's.

**When `--arm` prints `channels: none yet`**, connect Telegram as below, then go on with the work. The
marker is already armed: a finish that happens first is delivered the moment Telegram is connected.

## Connecting Telegram: you run it, the person taps

Run setup yourself, in the background (it waits up to 15 minutes for the taps), and tell the person in
their language, as a numbered list, only this:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/notify.mjs" setup
```

1. Telegram opens at BotFather: press Start and send `/newbot`.
2. Paste (Ctrl+V) twice: it asks for a name, then a username, and the username is already on the clipboard.
3. Tap the token in its answer: that copies it, and setup picks it up by itself.
4. Telegram opens the new bot: press Start. A test message arrives.

Setup prints the username it put on the clipboard; give it to them too, in case the clipboard was
overwritten. No Telegram on this computer: they do steps 1-4 on the phone and paste the token into the
terminal running setup instead (then it must run in a terminal they can type into, so give them the command
in a `bash` block for the app's Run button). When setup ends, read its last line and report it in one line.

**Never ask the person to paste a token into the chat, and never print it or write it into a project file.**
Setup reads it from the clipboard, checks it with Telegram, clears the clipboard and saves it to
`${CLAUDE_CONFIG_DIR:-~/.claude}/makarasty/notify.json`; its output never holds the token. The Start link
carries a one-time code, so only the person's own chat is bound, and the bot ignores taps and replies from
anyone else. One setup serves every account that shares this config dir. `test` checks it at any time.

## What the person gets

- **finished** - one message, once: `✅ <project>: <label> finished after 12 min`. The last 500 characters of
  the chat's final message go under it only when `MAKARASTY_NOTIFY_EXCERPT=1` is set or `notify.json` holds
  `"excerpt": true`; secrets of known shapes are blanked first, other text goes as written. A last message
  ending in a question says `finished, with a question for you`.
- **needs you** (`⚠️`) - a permission prompt or a question dialog is up. One per five minutes, marker kept.
- **stopped on an error** (`❌`) - the turn died on the API. One per five minutes, marker kept for the
  reopened chat.
- **paused** - the turn left a background job or a loop that will wake the chat: one line, and the finish
  comes on the later turn. A turn another plugin's Stop hook blocked sends nothing.
- **could not be delivered at the time** - the finish was saved and goes out at the next chance: the chat
  reopening, or setup connecting Telegram.
- **inbox questions** - a question nobody answered comes to Telegram: after 2 minutes in a chat the inbox watches;
  in any other chat, the inbox on or off, after 5 minutes (`MAKARASTY_PHONE_ASK=<minutes>` changes it, `off` turns it
  off; a dialog and a wrap_up box, with no timer or poll while none is open). The
  question bold, "project · kind · age" under it, a button per option and "❔ Подробнее" (a plain explanation,
  written only when tapped). A tap, a reply, or a plain next message that answers it does; a message ending in "?"
  asks the inbox about it. Several questions come one message each, with "⏭ Later" on each; a multi-select one ticks,
  then "✅ Done". The message then collapses to one grey line "question — answer"; answered on the computer, it
  collapses too.

All messages are Telegram HTML in Russian; a finish rings silently, everything that needs the person rings.
Nothing is sent for routine steps (an edit, an agent starting or ending).

## What the person can write to the bot

His messages are read by the hook engine of any running chat (no process at idle). Everything is plain text: the
only command is `/start` (`/status` is a debug view). A message goes to the inbox chat, or to a headless inbox turn
on Sonnet when no inbox chat runs, which does what he asks and replies; it can send a file, picture, video or voice
note and a desktop screenshot:

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/notify.mjs" file <path> [--as photo|video|voice|audio|animation|document] [--caption "..."]
node "${CLAUDE_PLUGIN_ROOT}/hooks/notify.mjs" screenshot [--caption "..."]
```

If a send prints `did not confirm`, the message may have arrived: never send it again, whatever the exit code.

His taps and messages count as his word, like typing. Details and edge cases: `docs/TELEGRAM.md` in the plugin
repository.

What leaves the machine for Telegram: these lines, the inbox question with its options, the explanation he asks
for, the inbox's answers to him, and the files and screenshots he asks for. Never a chat's transcript.

`/clear` drops this chat's marker: the person is at the screen. Closing the chat, or a crash, keeps it.

**A chat reopened before it finished** gets a line in its context at start, from the hook: check whether the
task is already complete before doing anything else. If it is, say so in one line and end the turn; the
message goes out on that. That line is the only thing the hook ever puts in a chat.

## Done when

The marker is armed for the right session with a label in the person's words, the reply says so in one
line, and the work goes on. For `setup`: it ran in the background, the person got the four steps, and its
last line was reported. For `test`, `status` and `off`, the script's own line.
