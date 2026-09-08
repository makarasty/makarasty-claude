#!/bin/sh
# notify-selftest.sh - the notifier against a temporary config dir and a dry-run sink. No network, no
# tokens, about a second. It feeds the hook the events Claude Code would, drives the wizard through a
# pipe, and asserts what reached the sink and what stayed on disk.
#
#   sh tools/hooks/notify-selftest.sh
#
# Exit 0 = every check passed. Exit 1 = at least one failed, and the failing check names what it expected.

set -u
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
n="$here/notify.mjs"
tmp=${TMPDIR:-/tmp}/notify-selftest-$$
mkdir -p "$tmp/makarasty"
sink="$tmp/sent"
export CLAUDE_CONFIG_DIR="$tmp" NOTIFY_DRY_RUN="$sink" CLAUDE_CODE_SESSION_ID=s1
marker="$tmp/makarasty/notify/s1.json"
conf="$tmp/makarasty/notify.json"
pass=0; fail=0

ok()   { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; [ -n "${2:-}" ] && printf '        got: %s\n' "$2"; }
check(){ case "$3" in *"$2"*) ok "$1";; *) bad "$1" "$(printf '%s' "$3" | tr '\n' '|' | cut -c1-200)";; esac; }
code() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "exit $3, wanted $2"; }
lines(){ [ -e "$sink" ] && grep -c . "$sink" || echo 0; }
count(){ [ "$(lines)" = "$2" ] && ok "$1" || bad "$1" "$(lines) lines in the sink, wanted $2"; }
hook() { printf '%s' "$1" | node "$n"; }
# The exact command plugin.json runs: node only when a marker exists at all.
guard(){ printf '%s' "$1" | sh -c '[ -n "$(ls "$CLAUDE_CONFIG_DIR/makarasty/notify/"*.json "$HOME/.claude/makarasty/notify/"*.json 2>/dev/null)" ] && node "$0" || true' "$n"; }

echo "notify selftest, dir $tmp"
echo
echo "nothing armed"
out=$(node "$n" --status); check "status says not armed" "not armed" "$out"
check "and names the missing config" "none configured" "$out"
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}'
count "an unarmed Stop sends nothing" 0

echo
echo "armed in the same turn as the work"
printf '{"ntfy":"https://ntfy.sh/selftest"}\n' > "$conf"
out=$(cd "$tmp" && node "$n" --arm the build 2>&1); check "arm reports the label" '"the build"' "$out"
check "and the channel" "channels: ntfy" "$out"
hook '{"hook_event_name":"Notification","session_id":"s1","notification_type":"permission_prompt","message":"Claude needs your permission"}'
check "a permission prompt pings" "needs you: Claude needs your permission" "$(cat "$sink")"
hook '{"hook_event_name":"Notification","session_id":"s1","notification_type":"permission_prompt","message":"again"}'
count "a second prompt inside five minutes does not" 1
[ -e "$marker" ] && ok "the marker survives a ping" || bad "the marker survives a ping"
guard '{"hook_event_name":"Stop","session_id":"s1","cwd":"/x/proj","last_assistant_message":"All green.\n12 tests pass."}'
check "Stop says finished with the project and label" "notify-selftest-$$: the build finished" "$(tail -1 "$sink")"
check "and carries the tail of the last message" "All green. 12 tests pass." "$(tail -1 "$sink")"
[ -e "$marker" ] && bad "Stop consumes the marker" || ok "Stop consumes the marker"
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"once more"}'
count "the next Stop sends nothing" 2

echo
echo "a question is reported as waiting"
node "$n" --arm >/dev/null
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Should I delete the old branch?"}'
check "a last message ending in ? is waiting for an answer" "is waiting for your answer" "$(tail -1 "$sink")"

echo
echo "armed for the next turn"
node "$n" --arm --next later >/dev/null
check "status says next turn" "for the next turn" "$(node "$n" --status)"
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"armed"}'
count "the arming turn's Stop sends nothing" 3
hook '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"go"}'
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"went"}'
count "the next turn's Stop sends" 4
check "with the label" "later finished" "$(tail -1 "$sink")"

echo
echo "delivery fails, the chat is reopened"
node "$n" --arm the deploy >/dev/null
NOTIFY_DRY_RUN="$tmp/no/such/dir/sink" hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"deployed"}' 2>/dev/null
[ -e "$marker" ] && ok "an undelivered message keeps the marker" || bad "an undelivered message keeps the marker"
check "with the text written before the send" '"done"' "$(cat "$marker" 2>/dev/null)"
hook '{"hook_event_name":"SessionStart","session_id":"s1","source":"startup"}'
count "a plain startup resends nothing" 4
hook '{"hook_event_name":"SessionStart","session_id":"s1","source":"resume"}'
count "a resume resends it" 5
check "and says when it had finished" "could not be delivered at the time" "$(tail -1 "$sink")"
[ -e "$marker" ] && bad "and consumes the marker" || ok "and consumes the marker"

echo
echo "the chat dies before it finishes"
node "$n" --arm the migration >/dev/null
hook '{"hook_event_name":"StopFailure","session_id":"s1","error":"rate_limit"}'
check "an API error is reported" "stopped on an error: rate_limit" "$(tail -1 "$sink")"
[ -e "$marker" ] && ok "and the marker stays for the reopened chat" || bad "and the marker stays for the reopened chat"
out=$(hook '{"hook_event_name":"SessionStart","session_id":"s1","source":"resume","seconds_since_last_response":5400}')
check "a resume before the finish tells the chat to check its work" "check whether the task it was on is already complete" "$out"
check "and how long it was gone" "90 minutes" "$out"
count "and sends nothing itself" 6
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"The migration had already run; nothing left to do."}'
check "the finish after a reopen says so" "reopened after an interruption" "$(tail -1 "$sink")"

echo
echo "direct sends"
node "$n" send "fleet 2026-09-08-x FINISHED: 3 findings" >/dev/null
check "send posts the text as given" "fleet 2026-09-08-x FINISHED: 3 findings" "$(tail -1 "$sink")"
out=$(node "$n" --test); check "test reports the channel" "sent to dry-run" "$out"
out=$(node "$n" --disarm --session other); check "disarm on a session that was never armed is quiet" "disarmed" "$out"
out=$(CLAUDE_CODE_SESSION_ID= node "$n" --arm 2>&1); rc=$?
code "arming with no session id refuses" 1 "$rc"
check "and says how to name one" "--session" "$out"

echo
echo "the guard in plugin.json"
rm -rf "$tmp/makarasty/notify"
out=$(printf '{"hook_event_name":"Stop","session_id":"s1"}' | HOME="$tmp/nohome" sh -c '[ -n "$(ls "$CLAUDE_CONFIG_DIR/makarasty/notify/"*.json "$HOME/.claude/makarasty/notify/"*.json 2>/dev/null)" ] && echo NODE_STARTED || true')
[ -z "$out" ] && ok "with no marker anywhere, node is not started" || bad "with no marker anywhere, node is not started" "$out"
node "$n" --arm >/dev/null
out=$(printf '{"hook_event_name":"Stop","session_id":"s1"}' | HOME="$tmp/nohome" sh -c '[ -n "$(ls "$CLAUDE_CONFIG_DIR/makarasty/notify/"*.json "$HOME/.claude/makarasty/notify/"*.json 2>/dev/null)" ] && echo NODE_STARTED || true')
check "with a marker, it is" "NODE_STARTED" "$out"
node "$n" --disarm >/dev/null
old="$tmp/makarasty/notify/dead.json"; printf '{"armed":"2026-01-01T00:00:00Z"}' > "$old"
node -e 'const t=Date.now()/1000-8*86400;require("fs").utimesSync(process.argv[1],t,t)' "$old"
node "$n" --arm >/dev/null
[ -e "$old" ] && bad "arm prunes a marker older than seven days" || ok "arm prunes a marker older than seven days"
node "$n" --disarm >/dev/null

echo
echo "the wizard"
rm -f "$conf"
node "$n" --arm the report >/dev/null
NOTIFY_DRY_RUN="$tmp/no/such/dir/sink" hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"report written"}' 2>/dev/null
out=$(node "$n" setup </dev/null 2>&1); rc=$?
code "with nothing to type into, setup refuses" 1 "$rc"
check "and prints the command for a terminal" "setup needs a terminal" "$out"
out=$(printf '3\n\nn\n' | node "$n" setup 2>&1); rc=$?
code "ntfy: three Enters and it is saved" 0 "$rc"
check "the wizard generated a topic" "topic: claude-" "$out"
check "and the test message was delivered" "delivered - check your phone" "$out"
check "and the finish that was waiting went out" "1 message(s) that were waiting" "$out"
check "the finish reached the sink" "the report finished" "$(tail -1 "$sink")"
[ -e "$marker" ] && bad "and its marker is gone" || ok "and its marker is gone"
check "the topic was saved as a full ntfy URL" '"ntfy": "https://ntfy.sh/claude-' "$(cat "$conf")"
out=$(printf '2\nhttps://discord.com/api/webhooks/1/x\n\ny\n9\n2\n \n3\n\nn\n' | node "$n" setup 2>&1); rc=$?
check "discord: the URL and the default mention" "Saved discord" "$out"
check "a wrong menu pick is asked again" "Add another channel" "$out"
check "an empty URL is refused" "nothing entered" "$out"
check "both channels are kept" '"everyone": true' "$(cat "$conf")"
check "and the earlier one survives" '"ntfy"' "$(cat "$conf")"
check "the closing line names them" "done: ntfy, discord" "$out"

echo
rm -rf "$tmp"
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
