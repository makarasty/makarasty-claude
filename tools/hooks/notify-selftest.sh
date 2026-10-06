#!/bin/sh
# notify-selftest.sh - the notifier against a temporary config dir and a dry-run sink. No outside network,
# no tokens, about fifteen seconds (four of them the SessionStart time budget against a local server that
# never answers, three a local server that answers slowly, three the wait a Stop with a transcript makes). It feeds the hook the events Claude Code would, through the exact commands plugin.json runs,
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
echo "a question still finishes the arming"
node "$n" --arm >/dev/null
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Should I delete the old branch?"}'
check "a last message ending in ? says finished, with a question" "finished, with a question for you" "$(tail -1 "$sink")"
check "and carries the question" "Should I delete the old branch?" "$(tail -1 "$sink")"
[ -e "$marker" ] && bad "and consumes the marker: one message per arming" || ok "and consumes the marker: one message per arming"
node "$n" --arm >/dev/null
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"All done. Want me to **push**?)`"}'
check "markdown after the ? still reads as a question" "with a question for you" "$(tail -1 "$sink")"
node "$n" --arm >/dev/null
long="start-of-reply $(printf 'x%.0s' $(seq 1 600)) VERDICT: all green"
hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"s1\",\"last_assistant_message\":\"$long\"}"
check "a plain finish sends" "finished | ..." "$(tail -1 "$sink")"
check "with the END of a long message" "VERDICT: all green" "$(tail -1 "$sink")"
case "$(tail -1 "$sink")" in *start-of-reply*) bad "and not its start";; *) ok "and not its start";; esac

echo
echo "armed for the next turn"
node "$n" --arm --next later >/dev/null
check "status says next turn" "for the next turn" "$(node "$n" --status)"
hook '{"hook_event_name":"Notification","session_id":"s1","notification_type":"permission_prompt","message":"arming turn"}'
hook '{"hook_event_name":"StopFailure","session_id":"s1","error":"overloaded"}'
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"armed"}'
count "the arming turn's prompt, error and Stop send nothing" 5
hook '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"go"}'
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"went"}'
count "the next turn's Stop sends" 6
check "with the label" "later finished" "$(tail -1 "$sink")"

echo
echo "delivery fails, the chat is reopened"
node "$n" --arm the deploy >/dev/null
NOTIFY_DRY_RUN="$tmp/no/such/dir/sink" hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"deployed"}' 2>/dev/null
[ -e "$marker" ] && ok "an undelivered message keeps the marker" || bad "an undelivered message keeps the marker"
check "with the text written before the send" '"done"' "$(cat "$marker" 2>/dev/null)"
hook '{"hook_event_name":"SessionStart","session_id":"s1","source":"startup"}'
count "a plain startup resends nothing" 6
hook '{"hook_event_name":"SessionStart","session_id":"s1","source":"resume"}'
count "a resume resends it" 7
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
count "and sends nothing itself" 8
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
for u in https://www.ntfy.sh/selftest https://ntfy.sh:443/selftest https://ntfy.sh./selftest https://NTFY.SH/selftest; do
  printf '{"ntfy":"%s"}\n' "$u" > "$conf"
  node "$n" --arm the secret >/dev/null
  hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"API_KEY=abc123"}'
  case "$(tail -1 "$sink")" in *API_KEY*) bad "nor does $u, the same server";; *) ok "nor does $u, the same server";; esac
done

echo
echo "config values that are not URLs"
printf '{"webhook":"hooks.slack.com/services/T0/B0/SECRETSECRET","discord":{"url":42},"telegram":{"token":["x"]},"ntfy":"https://ntfy.sh/selftest","excerpt":true}\n' > "$conf"
out=$(node "$n" --test 2>&1); rc=$?
code "values of the wrong type do not crash it" 0 "$rc"
check "a webhook with no scheme is named" "the webhook value is not an http(s) URL" "$out"
case "$out" in *SECRETSECRET*) bad "and its value is never printed" "$out";; *) ok "and its value is never printed";; esac
check "the good channel still sends" "sent to dry-run" "$out"
printf '{"ntfy":{"url":"https://ntfy.example.com/SECRETTOPIC"},"discord":{"url":42},"telegram":{"token":["x"]}}\n' > "$conf"
out=$(node "$n" --status 2>&1)
check "a channel written as an object, not a string, is named" "the ntfy value is not a string" "$out"
check "and so is a discord url that is not a string" "the discord url value is not a string" "$out"
check "and a telegram token that is not a string" "the telegram token value is not a string" "$out"
case "$out" in *SECRETTOPIC*) bad "with no value printed" "$out";; *) ok "with no value printed";; esac

echo
echo "a marker file Windows holds for a moment (EPERM on rename or read)"
# notify.mjs loaded in one process with node:fs's renameSync and readFileSync swapped for ones that fail
# with EPERM a set number of times, the way a second writer or an antivirus scan makes them fail.
flaky(){ node --input-type=module -e '
const { readFileSync } = await import("node:fs");
const [file, marker] = process.argv.slice(1);
const src = readFileSync(file, "utf8").replace(/^main\(\)\.then.*$/m, "")
  .replace(/^import \{[^}]*\} from .node:fs.;$/m, (l) => l.replace(/\breadFileSync\b/, "readFileSync as realRead").replace(/\brenameSync\b/, "renameSync as realRename"));
const harness = `let rf = +process.env.RENAME_FAILS, rd = +process.env.READ_FAILS;
const eperm = () => Object.assign(new Error("busy"), { code: "EPERM" });
const renameSync = (a, b) => { if (rf-- > 0) throw eperm(); return realRename(a, b); };
const readFileSync = (f, e) => { if (f === ${JSON.stringify(marker)} && rd-- > 0) throw eperm(); return realRead(f, e); };
`;
await import("data:text/javascript," + encodeURIComponent(src.replace(/^(import [^\n]*\n)+/m, (i) => i + harness) + `
writeJSON(${JSON.stringify(marker)}, { armed: "x" });
console.log(JSON.stringify(readJSON(${JSON.stringify(marker)})));`));' "$(cygpath -m "$n" 2>/dev/null || echo "$n")" "$(cygpath -m "$1" 2>/dev/null || echo "$1")"; }
fl="$tmp/flaky"; mkdir -p "$fl"
out=$(RENAME_FAILS=3 READ_FAILS=1 flaky "$fl/a.json" 2>&1)
check "a rename refused three times lands on a retry, and a read refused once is retried" '{"armed":"x"}' "$out"
out=$(RENAME_FAILS=99 READ_FAILS=0 flaky "$fl/b.json" 2>&1)
check "a rename refused for good falls back to writing in place" '{"armed":"x"}' "$out"
[ "$(ls "$fl" | tr '\n' ' ')" = "a.json b.json " ] && ok "and no temp file is left behind" || bad "and no temp file is left behind" "$(ls "$fl")"
out=$(RENAME_FAILS=0 READ_FAILS=2 flaky "$fl/c.json" 2>&1)
check "a read refused twice reads as not armed, not as a crash" 'null' "$out"

echo
echo "not a finish yet"
printf '{"ntfy":"https://ntfy.sh/selftest","excerpt":true}\n' > "$conf"
node "$n" --arm the job >/dev/null
b=$(lines)
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Started it in the background.","background_tasks":[{"id":"b1","status":"running"}],"session_crons":[]}'
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Looping.","background_tasks":[],"session_crons":[{"id":"c1"}]}'
count "a Stop with a background job or a loop sends one pause message, not a finish" "$((b + 1))"
check "which says paused and how many jobs" "the job paused: 1 background job still running" "$(tail -1 "$sink")"
[ -e "$marker" ] && ok "and keeps the marker for the turn they wake" || bad "and keeps the marker for the turn they wake"
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Build done, server still up.","background_tasks":[{"id":"b1","status":"running"}],"session_crons":[{"id":"c1"}]}'
check "a later Stop with only the jobs seen at the pause is the finish" "the job finished" "$(tail -1 "$sink")"
[ -e "$marker" ] && bad "and consumes the marker" || ok "and consumes the marker"
node "$n" --arm the job >/dev/null
b=$(lines)
wt="$tmp/w.jsonl"; wp=$(cygpath -m "$wt" 2>/dev/null || echo "$wt")
printf '%s\n' '{"type":"user","message":{"role":"user","content":"take task 1"}}' \
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Stopping here."}]}}' \
  '{"type":"user","message":{"role":"user","content":"Stop hook feedback:\n[guard]: You still hold task-1"}}' > "$wt"
hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"s1\",\"stop_hook_active\":false,\"transcript_path\":\"$wp\",\"last_assistant_message\":\"Stopping here.\"}"
count "a Stop that another plugin's hook blocked sends nothing" "$b"
[ -e "$marker" ] && ok "and keeps the marker" || bad "and keeps the marker"
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Released task-1. Done."}]}}' >> "$wt"
hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"s1\",\"stop_hook_active\":true,\"transcript_path\":\"$wp\",\"last_assistant_message\":\"Released task-1. Done.\"}"
count "the Stop that really ends that turn sends" $((b + 1))
node "$n" --arm --next later >/dev/null
out=$(hook '{"hook_event_name":"SessionStart","session_id":"s1","source":"resume"}')
[ -z "$out" ] && ok "a resume does not tell a --next chat to check work it has not started" || bad "a resume does not tell a --next chat to check work" "$out"
hook '{"hook_event_name":"UserPromptSubmit","session_id":"s1","source":"system","prompt":"<task-notification>done</task-notification>"}'
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"The background job finished."}'
count "a task notification does not make a --next marker live" $((b + 1))
hook '{"hook_event_name":"UserPromptSubmit","session_id":"s1","source":"sdk","prompt":"go"}'
hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"went"}'
count "a prompt typed in the desktop app (source sdk) does" $((b + 2))
node "$n" --arm >/dev/null
hook '{"hook_event_name":"StopFailure","session_id":"s1","error":"overloaded"}'
hook '{"hook_event_name":"StopFailure","session_id":"s1","error":"overloaded"}'
count "a second API error inside five minutes sends nothing" $((b + 3))
node "$n" --disarm >/dev/null

echo
echo "arming another chat"
(cd "$tmp" && node "$n" --arm --session s9 their build >/dev/null)
case "$(cat "$tmp/makarasty/notify/s9.json")" in *cwd*) bad "--session stores no cwd of the arming chat";; *) ok "--session stores no cwd of the arming chat";; esac
hook '{"hook_event_name":"Stop","session_id":"s9","cwd":"/x/theirproj","last_assistant_message":"done"}'
check "and the finish names that chat's project" "theirproj: their build finished" "$(tail -1 "$sink")"

echo
echo "a slow send, and error text that carries a secret"
node -e 'require("http").createServer((q, r) => { q.resume(); setTimeout(() => { r.writeHead(400); r.end("no such hook https://hooks.example/T0/SECRETSECRET 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ"); }, 1500); }).listen(0, "127.0.0.1", function () { require("fs").writeFileSync(process.argv[1], String(this.address().port)); })' "$tmp/port2" &
srv2=$!
for i in 1 2 3 4 5 6 7 8 9 10; do [ -s "$tmp/port2" ] && break; sleep 0.2; done
printf '{"ntfy":"http://127.0.0.1:%s/t"}\n' "$(cat "$tmp/port2")" > "$conf"
node "$n" --arm first >/dev/null
NOTIFY_DRY_RUN= hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}' 2>"$tmp/err"
check "a failed send says what failed" "ntfy failed: 400 no such hook <url> <token>" "$(cat "$tmp/err")"
case "$(cat "$tmp/err" "$marker")" in *SECRETSECRET*|*ABCDEFGHIJ*) bad "with no URL or token in the error or the marker";; *) ok "with no URL or token in the error or the marker";; esac
node "$n" --arm first >/dev/null
( NOTIFY_DRY_RUN= hook '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}' 2>/dev/null ) & sp=$!
sleep 0.7; node "$n" --arm second >/dev/null; wait "$sp"
check "a re-arm during a slow send survives it" '"label": "second"' "$(cat "$marker")"
case "$(cat "$marker")" in *unsent*) bad "and takes none of the old send's state" "$(cat "$marker")";; *) ok "and takes none of the old send's state";; esac
kill "$srv2" 2>/dev/null
node "$n" --disarm >/dev/null

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
printf '{"armed":"2026-01-01T00:00:00Z"}' > "$old"
node -e 'const t=Date.now()/1000-8*86400;require("fs").utimesSync(process.argv[1],t,t)' "$old"
hook '{"hook_event_name":"Stop","session_id":"nobody","last_assistant_message":"x"}'
[ -e "$old" ] && bad "and so does any hook run" || ok "and so does any hook run"
end_cmd=$(cmd_of SessionEnd notify.mjs 2>/dev/null)
[ -n "$end_cmd" ] && [ "$end_cmd" = "$notify_cmd" ] && ok "SessionEnd runs the same guarded command" || bad "SessionEnd runs the same guarded command" "$end_cmd"
node "$n" --arm >/dev/null
printf '{"hook_event_name":"SessionEnd","session_id":"s1","reason":"prompt_input_exit"}' | sh -c "$end_cmd"
[ -e "$marker" ] && ok "closing an armed chat keeps its marker for the resume" || bad "closing an armed chat keeps its marker for the resume"
printf '{"hook_event_name":"SessionEnd","session_id":"s1","reason":"clear"}' | sh -c "$end_cmd"
[ -e "$marker" ] && bad "/clear drops it" || ok "/clear drops it"
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
out=$(node "$here/unslop.mjs" --help 2>&1 >/dev/null); rc=$?
code "an unknown argument exits 1" 1 "$rc"
check "with usage on stderr" "usage: node unslop.mjs" "$out"
[ -e "$tmp/makarasty/unslop.on" ] && bad "and leaves the switch alone" || ok "and leaves the switch alone"
[ "$(wc -l < "$here/unslop.txt")" -le 30 ] && ok "the injected rules stay within 30 lines" || bad "the injected rules stay within 30 lines" "$(wc -l < "$here/unslop.txt") lines"

echo
echo "context reminder"
ctx_cmd=$(cmd_of UserPromptSubmit context.mjs)
tr="$tmp/t.jsonl"
turn(){ printf '{"type":"assistant","isSidechain":%s,"message":{"usage":{"input_tokens":%s,"cache_read_input_tokens":%s,"cache_creation_input_tokens":0}}}\n' "$1" "$2" "$3" >> "$tr"; }
ctx(){ printf '{"session_id":"c1","transcript_path":"%s","prompt":"%s"}' "$(cygpath -m "$tr" 2>/dev/null || echo "$tr")" "${1:-go on}" | MAKARASTY_HANDOFF_AT=${MAKARASTY_HANDOFF_AT-400000} sh -c "$ctx_cmd"; }
pad(){ { printf '{"type":"user","pad":"'; head -c "$1" /dev/zero | tr '\0' x; printf '"}\n'; } >> "$tr"; }
turn false 10 660000
out=$(printf '{"session_id":"c0","transcript_path":"%s","prompt":"go on"}' "$(cygpath -m "$tr" 2>/dev/null || echo "$tr")" | env -u MAKARASTY_HANDOFF_AT sh -c "$ctx_cmd")
[ -z "$out" ] && ok "by default silent at 660k" || bad "by default silent at 660k" "$out"
turn false 10 710000
out=$(printf '{"session_id":"c0","transcript_path":"%s","prompt":"go on"}' "$(cygpath -m "$tr" 2>/dev/null || echo "$tr")" | env -u MAKARASTY_HANDOFF_AT sh -c "$ctx_cmd")
check "and first fires at 700k" "context is at 710k" "$out"
: > "$tr"
turn false 10 100000
out=$(ctx); [ -z "$out" ] && ok "silent under the threshold" || bad "silent under the threshold" "$out"
turn false 10 420000; turn true 10 900000
out=$(ctx); check "fires past it, reading the main chain only" "context is at 420k" "$out"
out=$(ctx); [ -z "$out" ] && ok "once per level" || bad "once per level" "$out"
turn false 10 520000
out=$(ctx); [ -z "$out" ] && ok "silent inside the same step" || bad "silent inside the same step" "$out"
turn false 10 560000
out=$(ctx); check "again one step higher" "560k" "$out"
turn false 10 90000
out=$(ctx); turn false 10 410000
out=$(ctx); check "a compact re-arms it" "410k" "$out"
printf '{"type":"system","subtype":"compact_boundary","compactMetadata":{"preTokens":720000,"postTokens":15000}}\n' >> "$tr"
out=$(ctx); [ -z "$out" ] && [ ! -e "$tmp/makarasty/context/c1" ] && ok "a compact boundary after the last turn reads as the compacted size" || bad "compact boundary read" "$out"
turn false 10 720000
out=$(MAKARASTY_HANDOFF_AT=0 ctx); [ -z "$out" ] && ok "0 turns it off" || bad "0 turns it off" "$out"
mkdir -p "$tmp/makarasty/fleet-sessions" "$tmp/frun"; echo "$(cygpath -m "$tmp/frun" 2>/dev/null || echo "$tmp/frun")" > "$tmp/makarasty/fleet-sessions/c1"
out=$(ctx); [ -z "$out" ] && ok "silent in a session fleet.sh recorded as a fleet chat" || bad "silent in a session fleet.sh recorded as a fleet chat" "$out"
: > "$tmp/frun/FINISHED"; rm -f "$tmp/makarasty/context/c1"
out=$(ctx); check "but not once that run has FINISHED" "context is at 720k" "$out"
[ ! -e "$tmp/makarasty/fleet-sessions/c1" ] && ok "and the stale record is deleted" || bad "and the stale record is deleted"
echo /no/such/run > "$tmp/makarasty/fleet-sessions/c1"; rm -f "$tmp/makarasty/context/c1"
out=$(ctx); check "nor when its run directory is gone" "context is at 720k" "$out"
echo "$(cygpath -m "$tmp/frun" 2>/dev/null || echo "$tmp/frun")" > "$tmp/makarasty/fleet-sessions/c1"; rm -f "$tmp/frun/FINISHED" "$tmp/makarasty/context/c1"
node -e 'const t=Date.now()/1000-3*86400;require("fs").utimesSync(process.argv[1],t,t)' "$tmp/makarasty/fleet-sessions/c1"
out=$(ctx); check "nor when its record was not rewritten for two days" "context is at 720k" "$out"
rm -f "$tmp/makarasty/context/c1"
out=$(ctx '/makarasty-tools:handoff'; ctx 'сделай хенд-офф'; ctx 'хенд-офф'); [ -z "$out" ] && ok "silent when the prompt asks for the handoff" || bad "silent when the prompt asks for the handoff" "$out"
out=$(ctx 'fix the handoff reminder text in context.mjs'); check "a prompt that only mentions it still fires, the level unused" "720k" "$out"
turn false 10 870000; pad 2200000
out=$(ctx); check "a reading behind a 2 MB line is still found" "870k" "$out"
turn false 10 90000; pad 17000000
out=$(ctx); [ -z "$out" ] && [ -e "$tmp/makarasty/context/c1" ] && ok "no reading in the last 16 MB keeps the marker" || bad "no reading in the last 16 MB keeps the marker" "$out"
out=$(printf 'not json' | sh -c "$ctx_cmd"; echo "exit $?"); check "bad input exits 0" "exit 0" "$out"
compact_cmd=$(cmd_of SessionStart context.mjs)
out=$(printf '{"hook_event_name":"SessionStart","source":"compact","session_id":"c1","transcript_path":"/x/t.jsonl"}' | sh -c "$compact_cmd")
check "after a compact it names the full transcript" "still on disk, one JSON object per line: /x/t.jsonl" "$out"
out=$(printf '{"hook_event_name":"SessionStart","source":"resume","session_id":"c1","transcript_path":"/x/t.jsonl"}' | node "$here/context.mjs")
[ -z "$out" ] && ok "and says nothing on a plain resume" || bad "and says nothing on a plain resume" "$out"

echo
rm -rf "$tmp"
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
