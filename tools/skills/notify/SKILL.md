---
description: Send one message to the person's phone when this chat, another chat, or a fleet run finishes, through Telegram, Discord, ntfy or a webhook. Use when asked to notify, ping, message or write when something is done, in any language ("напиши когда закончишь", "уведоми в телеграм", "скинь в телеграм когда закончишь", "скинь в дискорд когда будет готово", "пингани"), to set up or test the channels, to ask whether a notification is armed, or to switch it off ("выключи уведомления").
argument-hint: [what the person is waiting for] | setup | test | status | off | --session <id>
---

The chat cannot tell whether the person is still at the screen, so it never decides on its own to message
them. The person arms it once, and the hook sends exactly one message when the turn they are waiting for
ends. Arming is a marker on disk keyed by session id. The hook runs in every session where this plugin
is installed; while no marker exists in this Claude config dir it is one shell glob, and node never starts.

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/notify.mjs" --arm <label>        # this chat, at the end of this turn
node "${CLAUDE_PLUGIN_ROOT}/hooks/notify.mjs" --arm --next <label> # this chat, at the end of the NEXT turn
node "${CLAUDE_PLUGIN_ROOT}/hooks/notify.mjs" --arm --session <id> <label>   # another chat
node "${CLAUDE_PLUGIN_ROOT}/hooks/notify.mjs" --status | --test | --disarm
```

Arguments map one to one, only when the whole argument is that one word: `status` runs `--status`, `test`
runs `--test`, `off` runs `--disarm`, `setup` is the wizard below. Anything longer is the label, even when
it starts with one of them ("test suite", "off-site backup"). Asked in words to switch it off ("выключи
уведомления", "stop pinging me"), run `--disarm`.

The label is the person's words and may hold an apostrophe or a `$`. Put it in single quotes, and write each
apostrophe inside it as `'\''` (close the quote, an escaped apostrophe, open it again):

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

**When `--arm` prints `channels: none yet`**, the person has never set a channel up. Give them the setup
command below in its own `bash` block, so the app shows a Run button, tell them in one line what it will
ask, and go on with the work. The marker is already armed: a finish that happens before they finish the
wizard is delivered the moment a channel is saved. Do not run the wizard yourself; it needs a person
typing, and from a tool it only prints that line.

```bash
node "${CLAUDE_PLUGIN_ROOT}/hooks/notify.mjs" setup
```

Then answer in one line - armed, for what, to which channels - and go on with the work. Do not explain how
the hook works; the person asked to be told when the work ends.

## The wizard, in the person's language

It runs in the terminal, asks one thing at a time, and no browser tab is opened. It asks which channel,
prints the steps for that one, takes the single value it needs, sends a test message that must arrive on
the phone, and saves. Tell them only the card they asked for:

- **Telegram.** Open @BotFather, send `/newbot`, answer its two questions, paste the token when asked.
  The wizard names the new bot: open it, press Start, press Enter. A test message arrives. Saved.
- **Discord.** A private server, or a channel nobody else reads. Channel settings, Integrations, Webhooks,
  New Webhook, Copy Webhook URL, paste it. It mentions @everyone by default so the phone buzzes; on a
  shared channel answer `n` and set that channel to "All Messages" instead.
- **ntfy** - no account. Install the app (the wizard prints both store links), press +, type the topic
  the wizard shows, press Enter. The topic is the password; the wizard made one nobody can guess.

The Telegram card has one more step: the wizard names whoever last wrote to the bot and asks whether that is
them, because a bot anyone can find may have heard from a stranger first.

A webhook (Slack or anything else that takes a POST of `{"text": "..."}`) is not in the wizard. The person
adds `"webhook": "https://..."` to `notify.json` by hand, then runs `test`. A value there that is not an
http(s) URL is skipped with a line naming the key, never the value.

**Never ask the person to paste a token or a webhook URL into the chat, and never write one into a project
file.** The wizard exists so the secret goes from their keyboard to
`${CLAUDE_CONFIG_DIR:-~/.claude}/makarasty/notify.json` and nowhere else. Each config dir, so each account, has its own channels. `test`, afterwards
or at any time, checks that every saved channel still works.

## What the person gets

One message, once, in the form `<project>: <label> finished`, with the last 500 characters of the chat's
final message under it, so the lock screen shows the verdict and not just "task done". The public ntfy.sh
server gets no excerpt unless `notify.json` holds `"excerpt": true`; `"excerpt": false` turns it off on
every channel. Say so when the work handles data that should not leave the machine.

A last message that ends in a question is sent as `finished, with a question for you`, the question at the
end of the excerpt, and the marker goes like any other: one arming, one message. If the person answers and
wants the next finish too, they ask again.

A turn that ends with a background job or a loop still due to wake the chat is not the finish: the marker
waits for the turn the job wakes, and the first such pause sends one `paused: N background jobs still
running` line, so a job that never ends (a dev server) is not silence. A later turn whose jobs were all
already running at the pause is the finish. A turn another plugin's Stop hook
blocked (a fleet worker that still holds a task) is not the finish either, and sends nothing; its real end
is.

Three other messages exist besides that pause, and each reports a state, not progress:

- **needs you** - a permission prompt or a question dialog is up. One ping per five minutes, and the
  marker stays: the work is not done.
- **stopped on an error** - the turn died on the API (rate limit, overload). One per five minutes, and the
  marker stays for the reopened chat.
- **could not be delivered at the time** - the finish was written to disk and the send failed, or no
  channel existed yet. It goes out at the next chance: the chat reopening, or the wizard saving a channel.
  No model turn is spent on it.

A `--next` marker sends none of these during the turn that armed it, and only a prompt the person sends
starts its turn: a background task's notification or a loop waking the chat does not.

`/clear` drops this chat's marker: the person is at the screen. Closing the chat, or a crash, keeps it.

**A chat reopened before it finished** (the app crashed, the machine restarted) gets a line in its context
at start, from the hook: check whether the task is already complete before doing anything else. If it is,
say so in one line and end the turn - the message goes out on that and says the chat had been reopened.
If it is not, continue; the message fires when it ends. That line is the only thing the hook ever puts in
a chat.

The host's own `PushNotification` reaches the phone through Remote Control when that is connected, and it
is skipped while the person is at the terminal. This command is for a person who wants a message where
their messages already are, with nothing else connected. The two do not conflict.

## Done when

The marker is armed for the right session with a label in the person's words, the reply says so in one
line, and the work goes on. For `setup`, the reply is the command in a `bash` block and the card they
need, in their language. For `test`, `status` and `off`, the script's own line.
