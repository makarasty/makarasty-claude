#!/bin/sh
# notify-selftest.sh - the notifier against a temporary config dir and a dry-run sink. No outside network,
# no tokens, about six seconds (four of them the SessionStart time budget against a local server that never
# answers). It feeds the hook the events Claude Code would, through the exact commands plugin.json runs,
# drives the wizard through a pipe, and asserts what reached the sink and what stayed on disk. The unslop
# switch and its SessionStart hook are checked at the end.
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
# The exact commands plugin.json runs, read from it: <event> <a substring of the command>.
cmd_of(){ node -e 'const [f, ev, has, root] = process.argv.slice(1);
  const c = require(f).hooks[ev].flatMap((g) => g.hooks.map((h) => h.command)).find((c) => c.includes(has));
  process.stdout.write(c.split("${CLAUDE_PLUGIN_ROOT}").join(root));' "$here/../.claude-plugin/plugin.json" "$1" "$2" "$here/.."; }
notify_cmd=$(cmd_of Stop notify.mjs)
unslop_cmd=$(cmd_of SessionStart unslop.txt)
guard(){ printf '%s' "$1" | sh -c "$notify_cmd"; }
# The guard with node swapped for an echo, to see whether it would start node.
probe(){ printf '{}' | sh -c "$(printf '%s' "$notify_cmd" | sed 's/exec node "[^"]*"/echo NODE_STARTED/')"; }

echo "notify selftest, dir $tmp"
echo
echo "nothing armed"
out=$(node "$n" --status); check "status says not armed" "not armed" "$out"
check "and names the missing config" "none configured" "$out"
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}'
count "an unarmed Stop sends nothing" 0

echo
echo "armed in the same turn as the work"
printf '{"ntfy":"https://ntfy.sh/selftest","excerpt":true}\n' > "$conf"
out=$(cd "$tmp" && node "$n" --arm the build 2>&1); check "arm reports the label" '"the build"' "$out"
check "and the channel" "channels: ntfy" "$out"
out=$(hook '{"hook_event_name":"Notification","session_id":"s1","notification_type":"permission_prompt","message":"Claude needs your permission"}')
check "a permission prompt pings" "needs you: Claude needs your permission" "$(cat "$sink")"
[ -z "$out" ] && ok "and prints nothing to stdout, which a hook reserves for context" || bad "hook stdout stays empty" "$out"
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
[ -e "$marker" ] && ok "and the marker stays for the real finish" || bad "and the marker stays for the real finish"
long="start-of-reply $(printf 'x%.0s' $(seq 1 600)) VERDICT: all green"
hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"s1\",\"last_assistant_message\":\"$long\"}"
check "the answered chat's finish still sends" "finished | ..." "$(tail -1 "$sink")"
check "with the END of a long message" "VERDICT: all green" "$(tail -1 "$sink")"
case "$(tail -1 "$sink")" in *start-of-reply*) bad "and not its start";; *) ok "and not its start";; esac

echo
echo "armed for the next turn"
node "$n" --arm --next later >/dev/null
check "status says next turn" "for the next turn" "$(node "$n" --status)"
hook '{"hook_event_name":"Notification","session_id":"s1","notification_type":"permission_prompt","message":"arming turn"}'
hook '{"hook_event_name":"StopFailure","session_id":"s1","error":"overloaded"}'
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"armed"}'
count "the arming turn's prompt, error and Stop send nothing" 4
hook '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"go"}'
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"went"}'
count "the next turn's Stop sends" 5
check "with the label" "later finished" "$(tail -1 "$sink")"

echo
echo "delivery fails, the chat is reopened"
node "$n" --arm the deploy >/dev/null
NOTIFY_DRY_RUN="$tmp/no/such/dir/sink" hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"deployed"}' 2>/dev/null
[ -e "$marker" ] && ok "an undelivered message keeps the marker" || bad "an undelivered message keeps the marker"
check "with the text written before the send" '"done"' "$(cat "$marker" 2>/dev/null)"
hook '{"hook_event_name":"SessionStart","session_id":"s1","source":"startup"}'
count "a plain startup resends nothing" 5
hook '{"hook_event_name":"SessionStart","session_id":"s1","source":"resume"}'
count "a resume resends it" 6
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
count "and sends nothing itself" 7
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
out=$(node "$n" --disarm --session ../notify 2>&1); rc=$?
code "a session id that is a path is refused" 1 "$rc"
[ -e "$conf" ] && ok "and the config it pointed at survives" || bad "and the config it pointed at survives"

echo
echo "the excerpt on the public ntfy server"
printf '{"ntfy":"https://ntfy.sh/selftest"}\n' > "$conf"
node "$n" --arm the secret >/dev/null
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"API_KEY=abc123"}'
check "the head still goes out" "the secret finished" "$(tail -1 "$sink")"
case "$(tail -1 "$sink")" in *API_KEY*) bad "but ntfy.sh gets no excerpt by default";; *) ok "but ntfy.sh gets no excerpt by default";; esac

echo
echo "the SessionStart time budget, against a local server that never answers"
port_file="$tmp/port"
node -e 'require("http").createServer(() => {}).listen(0, "127.0.0.1", function () { require("fs").writeFileSync(process.argv[1], String(this.address().port)); })' "$port_file" &
srv=$!
for i in 1 2 3 4 5 6 7 8 9 10; do [ -s "$port_file" ] && break; sleep 0.2; done
printf '{"ntfy":"http://127.0.0.1:%s/t"}\n' "$(cat "$port_file")" > "$conf"
node "$n" --arm the hang >/dev/null
NOTIFY_DRY_RUN="$tmp/no/such/dir/sink" hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"hung"}' 2>/dev/null
start=$(date +%s)
NOTIFY_DRY_RUN= hook '{"hook_event_name":"SessionStart","session_id":"s1","source":"resume"}' 2>/dev/null
took=$(( $(date +%s) - start ))
kill "$srv" 2>/dev/null
[ "$took" -le 7 ] && ok "a resume gives up after about four seconds (took ${took}s, hook timeout 10)" || bad "a resume gives up after about four seconds" "took ${took}s"
[ -e "$marker" ] && ok "and the undelivered finish stays on disk" || bad "and the undelivered finish stays on disk"
node "$n" --disarm >/dev/null
printf '{"ntfy":"https://ntfy.sh/selftest","excerpt":true}\n' > "$conf"

echo
echo "the guard in plugin.json"
rm -rf "$tmp/makarasty/notify"
out=$(HOME="$tmp/nohome" probe)
[ -z "$out" ] && ok "with no marker anywhere, node is not started" || bad "with no marker anywhere, node is not started" "$out"
node "$n" --arm >/dev/null
check "with a marker, it is" "NODE_STARTED" "$(HOME="$tmp/nohome" probe)"
out=$(CLAUDE_CONFIG_DIR="$tmp/other" HOME="$tmp/nohome" probe)
[ -z "$out" ] && ok "a marker in another config dir does not start node here" || bad "a marker in another config dir does not start node here" "$out"
mkdir -p "$tmp/h/.claude/makarasty/notify" && : > "$tmp/h/.claude/makarasty/notify/x.json"
out=$(env -u CLAUDE_CONFIG_DIR HOME="$tmp/h" sh -c "$(printf '%s' "$notify_cmd" | sed 's/exec node "[^"]*"/echo NODE_STARTED/')" </dev/null)
check "with CLAUDE_CONFIG_DIR unset it looks in ~/.claude" "NODE_STARTED" "$out"
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
check "the closing line names them" "done: discord, ntfy" "$out"

echo
echo "unslop"
out=$(node "$here/unslop.mjs" --status); check "off by default" "unslop: off" "$out"
out=$(sh -c "$unslop_cmd" </dev/null); [ -z "$out" ] && ok "and the SessionStart hook injects nothing" || bad "and the SessionStart hook injects nothing" "$out"
out=$(node "$here/unslop.mjs" --enable); check "enable prints the rules for this session" "UNSLOP MODE ON" "$out"
[ -e "$tmp/makarasty/unslop.on" ] && ok "in the config dir the hook reads" || bad "in the config dir the hook reads"
out=$(sh -c "$unslop_cmd" </dev/null); check "the hook injects the same rules" "UNSLOP MODE ON" "$out"
node "$here/unslop.mjs" --disable >/dev/null
out=$(sh -c "$unslop_cmd" </dev/null); [ -z "$out" ] && ok "disable stops it" || bad "disable stops it" "$out"

echo
rm -rf "$tmp"
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
