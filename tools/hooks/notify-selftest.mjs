#!/usr/bin/env node
// notify-selftest.mjs - the notifier against a temporary config dir and a dry-run sink. No outside network,
// no tokens, about fifteen seconds (four of them the SessionStart time budget against a local server that
// never answers, three a local server that answers slowly, three the wait a Stop with a transcript makes).
// It feeds the hook the events Claude Code would, through the exact commands plugin.json runs, drives the
// wizard through a pipe, and asserts what reached the sink and what stayed on disk. The unslop switch and
// its SessionStart hook are checked at the end, then the context reminder.
//
//   node tools/hooks/notify-selftest.mjs         the compiled test
//   node tools/src/hooks/notify-selftest.mts     the same, the TypeScript run directly by node
//
// Both test the shipped tools/hooks/*.mjs, never tools/src/: the .mjs is what a plugin user runs.
// Exit 0 = every check passed. Exit 1 = at least one failed, and the failing check names what it expected.
//
// A plain runner, not node:test: the cases lean on the state the cases above them left (the marker, the
// sink, the config), in order, the way the sh version this replaces did.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
// Forward slashes everywhere: sh and node both take C:/x, and a backslash path pasted into a sh command
// line or a JSON payload would need escaping.
const fwd = (p) => p.split('\\').join('/');
// tools/hooks, from either tools/src/hooks/ (run by node directly) or tools/hooks/ (compiled).
const self = resolve(import.meta.dirname);
const here = fwd(basename(dirname(self)) === 'src' ? resolve(self, '..', '..', 'hooks') : self);
const n = `${here}/notify.mjs`;
const tmp = fwd(join(tmpdir(), `notify-selftest-${process.pid}`));
mkdirSync(`${tmp}/makarasty`, { recursive: true });
const sink = `${tmp}/sent`;
process.env.CLAUDE_CONFIG_DIR = tmp;
process.env.NOTIFY_DRY_RUN = sink;
process.env.CLAUDE_CODE_SESSION_ID = 's1';
const marker = `${tmp}/makarasty/notify/s1.json`;
const conf = `${tmp}/makarasty/notify.json`;
let pass = 0, fail = 0;
// Like sh's $(...): trailing newlines cut. An env value of undefined unsets the variable.
function run(file, args, o = {}) {
    const env = { ...process.env, ...o.env };
    for (const k of Object.keys(env))
        if (env[k] === undefined)
            delete env[k];
    const r = spawnSync(file, args, { input: o.input ?? '', env, cwd: o.cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
    const cut = (s) => (s ?? '').replace(/\n+$/, '');
    // No status means it never ran or a signal killed it: 128, so no "exits 1" check passes by accident.
    return { out: cut(r.stdout), err: cut(r.stderr || (r.error ? String(r.error) : '')), code: r.status ?? 128 };
}
const node = (args, o) => run(process.execPath, args, o);
const sh = (script, o) => run('sh', ['-c', script], o);
const both = (r) => [r.out, r.err].filter(Boolean).join('\n');
const read = (p) => { try {
    return readFileSync(p, 'utf8');
}
catch {
    return '';
} };
const exists = (p) => existsSync(p);
// Blocking, so a background server or hook keeps running while this process waits.
const sleep = (sec) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sec * 1000);
const ago = (p, sec) => { const t = Date.now() / 1000 - sec; utimesSync(p, t, t); };
function ok(name) { pass++; console.log(`  ok    ${name}`); }
function bad(name, got = '') { fail++; console.log(`  FAIL  ${name}`); if (got)
    console.log(`        got: ${got}`); }
function check(name, want, got) { if (got.includes(want))
    ok(name);
else
    bad(name, got.split('\n').join('|').slice(0, 200)); }
function code(name, want, got) { if (want === got)
    ok(name);
else
    bad(name, `exit ${got}, wanted ${want}`); }
const lines = () => read(sink).split('\n').filter((l) => l !== '').length;
function count(name, want) { const l = lines(); if (l === want)
    ok(name);
else
    bad(name, `${l} lines in the sink, wanted ${want}`); }
const last = () => read(sink).replace(/\n+$/, '').split('\n').pop() ?? '';
const hook = (payload, env) => node([n], { input: payload, env });
const section = (title) => console.log(`\n${title}`);
const plugin = JSON.parse(readFileSync(`${here}/../.claude-plugin/plugin.json`, 'utf8'));
const cmdOf = (ev, has) => {
    const c = (plugin.hooks[ev] ?? []).flatMap((g) => g.hooks.map((h) => h.command)).find((c) => c.includes(has));
    return c === undefined ? '' : c.split('${CLAUDE_PLUGIN_ROOT}').join(`${here}/..`);
};
const notifyCmd = cmdOf('Stop', 'notify.mjs');
const unslopCmd = cmdOf('SessionStart', 'unslop.txt');
const guard = (payload) => sh(notifyCmd, { input: payload });
// The guard with node swapped for an echo, to see whether it would start node.
const probeCmd = notifyCmd.replace(/exec node "[^"]*"/, 'echo NODE_STARTED');
const probe = (env) => sh(probeCmd, { input: '{}', env });
// A local http server in its own process (one here would sleep through every blocking spawnSync below);
// returns it and the port it wrote.
function server(script, portFile) {
    const srv = spawn(process.execPath, ['-e', script, portFile], { stdio: 'ignore' });
    for (let i = 0; i < 10; i++) {
        if (read(portFile))
            break;
        sleep(0.2);
    }
    return { srv, port: read(portFile) };
}
console.log(`notify selftest, dir ${tmp}`);
section('nothing armed');
let out = node([n, '--status']).out;
check('status says not armed', 'not armed', out);
check('and names the missing config', 'none configured', out);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}');
count('an unarmed Stop sends nothing', 0);
section('armed in the same turn as the work');
writeFileSync(conf, '{"ntfy":"https://ntfy.sh/selftest","excerpt":true}\n');
out = both(node([n, '--arm', 'the', 'build'], { cwd: tmp }));
check('arm reports the label', '"the build"', out);
check('and the channel', 'channels: ntfy', out);
out = hook('{"hook_event_name":"Notification","session_id":"s1","notification_type":"permission_prompt","message":"Claude needs your permission"}').out;
check('a permission prompt pings', 'needs you: Claude needs your permission', read(sink));
if (out === '')
    ok('and prints nothing to stdout, which a hook reserves for context');
else
    bad('hook stdout stays empty', out);
hook('{"hook_event_name":"Notification","session_id":"s1","notification_type":"permission_prompt","message":"again"}');
count('a second prompt inside five minutes does not', 1);
if (exists(marker))
    ok('the marker survives a ping');
else
    bad('the marker survives a ping');
guard('{"hook_event_name":"Stop","session_id":"s1","cwd":"/x/proj","last_assistant_message":"All green.\\n12 tests pass."}');
check('Stop says finished with the project and label', `notify-selftest-${process.pid}: the build finished`, last());
check('and carries the tail of the last message', 'All green. 12 tests pass.', last());
if (exists(marker))
    bad('Stop consumes the marker');
else
    ok('Stop consumes the marker');
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"once more"}');
count('the next Stop sends nothing', 2);
section('a question still finishes the arming');
node([n, '--arm']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Should I delete the old branch?"}');
check('a last message ending in ? says finished, with a question', 'finished, with a question for you', last());
check('and carries the question', 'Should I delete the old branch?', last());
if (exists(marker))
    bad('and consumes the marker: one message per arming');
else
    ok('and consumes the marker: one message per arming');
node([n, '--arm']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"All done. Want me to **push**?)`"}');
check('markdown after the ? still reads as a question', 'with a question for you', last());
node([n, '--arm']);
const long = `start-of-reply ${'x'.repeat(600)} VERDICT: all green`;
hook(`{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"${long}"}`);
check('a plain finish sends', 'finished | ...', last());
check('with the END of a long message', 'VERDICT: all green', last());
if (last().includes('start-of-reply'))
    bad('and not its start');
else
    ok('and not its start');
section('armed for the next turn');
node([n, '--arm', '--next', 'later']);
check('status says next turn', 'for the next turn', node([n, '--status']).out);
hook('{"hook_event_name":"Notification","session_id":"s1","notification_type":"permission_prompt","message":"arming turn"}');
hook('{"hook_event_name":"StopFailure","session_id":"s1","error":"overloaded"}');
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"armed"}');
count("the arming turn's prompt, error and Stop send nothing", 5);
hook('{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"go"}');
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"went"}');
count("the next turn's Stop sends", 6);
check('with the label', 'later finished', last());
section('delivery fails, the chat is reopened');
const nowhere = `${tmp}/no/such/dir/sink`;
node([n, '--arm', 'the', 'deploy']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"deployed"}', { NOTIFY_DRY_RUN: nowhere });
if (exists(marker))
    ok('an undelivered message keeps the marker');
else
    bad('an undelivered message keeps the marker');
check('with the text written before the send', '"done"', read(marker));
hook('{"hook_event_name":"SessionStart","session_id":"s1","source":"startup"}');
count('a plain startup resends nothing', 6);
hook('{"hook_event_name":"SessionStart","session_id":"s1","source":"resume"}');
count('a resume resends it', 7);
check('and says when it had finished', 'could not be delivered at the time', last());
if (exists(marker))
    bad('and consumes the marker');
else
    ok('and consumes the marker');
section('the chat dies before it finishes');
node([n, '--arm', 'the', 'migration']);
hook('{"hook_event_name":"StopFailure","session_id":"s1","error":"rate_limit"}');
check('an API error is reported', 'stopped on an error: rate_limit', last());
if (exists(marker))
    ok('and the marker stays for the reopened chat');
else
    bad('and the marker stays for the reopened chat');
out = hook('{"hook_event_name":"SessionStart","session_id":"s1","source":"resume","seconds_since_last_response":5400}').out;
check('a resume before the finish tells the chat to check its work', 'check whether the task it was on is already complete', out);
check('and how long it was gone', '90 minutes', out);
count('and sends nothing itself', 8);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"The migration had already run; nothing left to do."}');
check('the finish after a reopen says so', 'reopened after an interruption', last());
section('direct sends');
node([n, 'send', 'fleet 2026-09-08-x FINISHED: 3 findings']);
check('send posts the text as given', 'fleet 2026-09-08-x FINISHED: 3 findings', last());
out = node([n, '--test']).out;
check('test reports the channel', 'sent to dry-run', out);
out = node([n, '--disarm', '--session', 'other']).out;
check('disarm on a session that was never armed is quiet', 'disarmed', out);
let r = node([n, '--arm'], { env: { CLAUDE_CODE_SESSION_ID: '' } });
code('arming with no session id refuses', 1, r.code);
check('and says how to name one', '--session', both(r));
r = node([n, '--disarm', '--session', '../notify']);
code('a session id that is a path is refused', 1, r.code);
if (exists(conf))
    ok('and the config it pointed at survives');
else
    bad('and the config it pointed at survives');
section('the excerpt on the public ntfy server');
writeFileSync(conf, '{"ntfy":"https://ntfy.sh/selftest"}\n');
node([n, '--arm', 'the', 'secret']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"API_KEY=abc123"}');
check('the head still goes out', 'the secret finished', last());
if (last().includes('API_KEY'))
    bad('but ntfy.sh gets no excerpt by default');
else
    ok('but ntfy.sh gets no excerpt by default');
for (const u of ['https://www.ntfy.sh/selftest', 'https://ntfy.sh:443/selftest', 'https://ntfy.sh./selftest', 'https://NTFY.SH/selftest']) {
    writeFileSync(conf, `{"ntfy":"${u}"}\n`);
    node([n, '--arm', 'the', 'secret']);
    hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"API_KEY=abc123"}');
    if (last().includes('API_KEY'))
        bad(`nor does ${u}, the same server`);
    else
        ok(`nor does ${u}, the same server`);
}
section('config values that are not URLs');
writeFileSync(conf, '{"webhook":"hooks.slack.com/services/T0/B0/SECRETSECRET","discord":{"url":42},"telegram":{"token":["x"]},"ntfy":"https://ntfy.sh/selftest","excerpt":true}\n');
r = node([n, '--test']);
out = both(r);
code('values of the wrong type do not crash it', 0, r.code);
check('a webhook with no scheme is named', 'the webhook value is not an http(s) URL', out);
if (out.includes('SECRETSECRET'))
    bad('and its value is never printed', out);
else
    ok('and its value is never printed');
check('the good channel still sends', 'sent to dry-run', out);
writeFileSync(conf, '{"ntfy":{"url":"https://ntfy.example.com/SECRETTOPIC"},"discord":{"url":42},"telegram":{"token":["x"]}}\n');
out = both(node([n, '--status']));
check('a channel written as an object, not a string, is named', 'the ntfy value is not a string', out);
check('and so is a discord url that is not a string', 'the discord url value is not a string', out);
check('and a telegram token that is not a string', 'the telegram token value is not a string', out);
if (out.includes('SECRETTOPIC'))
    bad('with no value printed', out);
else
    ok('with no value printed');
section('a marker file Windows holds for a moment (EPERM on rename or read)');
// notify.mjs loaded in a child process with node:fs's renameSync and readFileSync swapped for ones that
// fail with EPERM a set number of times, the way a second writer or an antivirus scan makes them fail.
// The child reads the module source from stdin: it is longer than a Windows command line takes.
function flaky(file, renameFails, readFails) {
    const src = readFileSync(n, 'utf8').replace(/^main\(\)\.then.*$/m, '')
        .replace(/^import \{[^}]*\} from .node:fs.;$/m, (l) => l.replace(/\breadFileSync\b/, 'readFileSync as realRead').replace(/\brenameSync\b/, 'renameSync as realRename'));
    const m = JSON.stringify(file);
    const harness = `let rf = +process.env.RENAME_FAILS, rd = +process.env.READ_FAILS;
const eperm = () => Object.assign(new Error("busy"), { code: "EPERM" });
const renameSync = (a, b) => { if (rf-- > 0) throw eperm(); return realRename(a, b); };
const readFileSync = (f, e) => { if (f === ${m} && rd-- > 0) throw eperm(); return realRead(f, e); };
`;
    const mod = src.replace(/^(import [^\n]*\n)+/m, (i) => i + harness) + `
writeJSON(${m}, { armed: "x" });
console.log(JSON.stringify(readJSON(${m})));`;
    return both(node(['--input-type=module', '-e', 'const { readFileSync } = await import("node:fs"); await import("data:text/javascript," + encodeURIComponent(readFileSync(0, "utf8")));'], { input: mod, env: { RENAME_FAILS: String(renameFails), READ_FAILS: String(readFails) } }));
}
const fl = `${tmp}/flaky`;
mkdirSync(fl, { recursive: true });
out = flaky(`${fl}/a.json`, 3, 1);
check('a rename refused three times lands on a retry, and a read refused once is retried', '{"armed":"x"}', out);
out = flaky(`${fl}/b.json`, 99, 0);
check('a rename refused for good falls back to writing in place', '{"armed":"x"}', out);
const left = readdirSync(fl).sort().join(' ');
if (left === 'a.json b.json')
    ok('and no temp file is left behind');
else
    bad('and no temp file is left behind', left);
out = flaky(`${fl}/c.json`, 0, 2);
check('a read refused twice reads as not armed, not as a crash', 'null', out);
section('not a finish yet');
writeFileSync(conf, '{"ntfy":"https://ntfy.sh/selftest","excerpt":true}\n');
node([n, '--arm', 'the', 'job']);
let b = lines();
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Started it in the background.","background_tasks":[{"id":"b1","status":"running"}],"session_crons":[]}');
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Looping.","background_tasks":[],"session_crons":[{"id":"c1"}]}');
count('a Stop with a background job or a loop sends one pause message, not a finish', b + 1);
check('which says paused and how many jobs', 'the job paused: 1 background job still running', last());
if (exists(marker))
    ok('and keeps the marker for the turn they wake');
else
    bad('and keeps the marker for the turn they wake');
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Build done, server still up.","background_tasks":[{"id":"b1","status":"running"}],"session_crons":[{"id":"c1"}]}');
check('a later Stop with only the jobs seen at the pause is the finish', 'the job finished', last());
if (exists(marker))
    bad('and consumes the marker');
else
    ok('and consumes the marker');
node([n, '--arm', 'the', 'job']);
b = lines();
const wt = `${tmp}/w.jsonl`;
writeFileSync(wt, [
    '{"type":"user","message":{"role":"user","content":"take task 1"}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Stopping here."}]}}',
    '{"type":"user","message":{"role":"user","content":"Stop hook feedback:\\n[guard]: You still hold task-1"}}',
].join('\n') + '\n');
hook(`{"hook_event_name":"Stop","session_id":"s1","stop_hook_active":false,"transcript_path":"${wt}","last_assistant_message":"Stopping here."}`);
count("a Stop that another plugin's hook blocked sends nothing", b);
if (exists(marker))
    ok('and keeps the marker');
else
    bad('and keeps the marker');
appendFileSync(wt, '{"type":"assistant","message":{"content":[{"type":"text","text":"Released task-1. Done."}]}}\n');
hook(`{"hook_event_name":"Stop","session_id":"s1","stop_hook_active":true,"transcript_path":"${wt}","last_assistant_message":"Released task-1. Done."}`);
count('the Stop that really ends that turn sends', b + 1);
node([n, '--arm', '--next', 'later']);
out = hook('{"hook_event_name":"SessionStart","session_id":"s1","source":"resume"}').out;
if (out === '')
    ok('a resume does not tell a --next chat to check work it has not started');
else
    bad('a resume does not tell a --next chat to check work', out);
hook('{"hook_event_name":"UserPromptSubmit","session_id":"s1","source":"system","prompt":"<task-notification>done</task-notification>"}');
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"The background job finished."}');
count('a task notification does not make a --next marker live', b + 1);
hook('{"hook_event_name":"UserPromptSubmit","session_id":"s1","source":"sdk","prompt":"go"}');
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"went"}');
count('a prompt typed in the desktop app (source sdk) does', b + 2);
node([n, '--arm']);
hook('{"hook_event_name":"StopFailure","session_id":"s1","error":"overloaded"}');
hook('{"hook_event_name":"StopFailure","session_id":"s1","error":"overloaded"}');
count('a second API error inside five minutes sends nothing', b + 3);
node([n, '--disarm']);
section('arming another chat');
node([n, '--arm', '--session', 's9', 'their', 'build'], { cwd: tmp });
if (read(`${tmp}/makarasty/notify/s9.json`).includes('cwd'))
    bad('--session stores no cwd of the arming chat');
else
    ok('--session stores no cwd of the arming chat');
hook('{"hook_event_name":"Stop","session_id":"s9","cwd":"/x/theirproj","last_assistant_message":"done"}');
check("and the finish names that chat's project", 'theirproj: their build finished', last());
section('a slow send, and error text that carries a secret');
const s2 = server('require("http").createServer((q, r) => { q.resume(); setTimeout(() => { r.writeHead(400); r.end("no such hook https://hooks.example/T0/SECRETSECRET 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ"); }, 1500); }).listen(0, "127.0.0.1", function () { require("fs").writeFileSync(process.argv[1], String(this.address().port)); })', `${tmp}/port2`);
writeFileSync(conf, `{"ntfy":"http://127.0.0.1:${s2.port}/t"}\n`);
node([n, '--arm', 'first']);
const errText = hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}', { NOTIFY_DRY_RUN: '' }).err;
check('a failed send says what failed', 'ntfy failed: 400 no such hook <url> <token>', errText);
if (/SECRETSECRET|ABCDEFGHIJ/.test(errText + read(marker)))
    bad('with no URL or token in the error or the marker');
else
    ok('with no URL or token in the error or the marker');
node([n, '--arm', 'first']);
// Its stdin is a file, not a pipe: a pipe write would wait for the event loop the blocking sleep holds.
writeFileSync(`${tmp}/slow-in`, '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}');
const slowIn = openSync(`${tmp}/slow-in`, 'r');
const slow = spawn(process.execPath, [n], { env: { ...process.env, NOTIFY_DRY_RUN: '' }, stdio: [slowIn, 'ignore', 'ignore'] });
const slowDone = new Promise((res) => slow.on('close', res));
sleep(0.7);
node([n, '--arm', 'second']);
await slowDone;
closeSync(slowIn);
check('a re-arm during a slow send survives it', '"label": "second"', read(marker));
if (read(marker).includes('unsent'))
    bad("and takes none of the old send's state", read(marker));
else
    ok("and takes none of the old send's state");
s2.srv.kill();
node([n, '--disarm']);
section('the SessionStart time budget, against a local server that never answers');
const s1 = server('require("http").createServer(() => {}).listen(0, "127.0.0.1", function () { require("fs").writeFileSync(process.argv[1], String(this.address().port)); })', `${tmp}/port`);
writeFileSync(conf, `{"ntfy":"http://127.0.0.1:${s1.port}/t"}\n`);
node([n, '--arm', 'the', 'hang']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"hung"}', { NOTIFY_DRY_RUN: nowhere });
const start = Date.now();
hook('{"hook_event_name":"SessionStart","session_id":"s1","source":"resume"}', { NOTIFY_DRY_RUN: '' });
const ms = Date.now() - start, took = Math.round(ms / 1000);
s1.srv.kill();
// The limit on the exact time, not the rounded one, so 7.4 s cannot round down into a pass.
if (ms <= 7000)
    ok(`a resume gives up after about four seconds (took ${took}s, hook timeout 10)`);
else
    bad('a resume gives up after about four seconds', `took ${took}s`);
if (exists(marker))
    ok('and the undelivered finish stays on disk');
else
    bad('and the undelivered finish stays on disk');
node([n, '--disarm']);
writeFileSync(conf, '{"ntfy":"https://ntfy.sh/selftest","excerpt":true}\n');
section('the guard in plugin.json');
rmSync(`${tmp}/makarasty/notify`, { recursive: true, force: true });
out = probe({ HOME: `${tmp}/nohome` }).out;
if (out === '')
    ok('with no marker anywhere, node is not started');
else
    bad('with no marker anywhere, node is not started', out);
node([n, '--arm']);
check('with a marker, it is', 'NODE_STARTED', probe({ HOME: `${tmp}/nohome` }).out);
out = probe({ CLAUDE_CONFIG_DIR: `${tmp}/other`, HOME: `${tmp}/nohome` }).out;
if (out === '')
    ok('a marker in another config dir does not start node here');
else
    bad('a marker in another config dir does not start node here', out);
mkdirSync(`${tmp}/h/.claude/makarasty/notify`, { recursive: true });
writeFileSync(`${tmp}/h/.claude/makarasty/notify/x.json`, '');
out = sh(probeCmd, { env: { CLAUDE_CONFIG_DIR: undefined, HOME: `${tmp}/h` } }).out;
check('with CLAUDE_CONFIG_DIR unset it looks in ~/.claude', 'NODE_STARTED', out);
node([n, '--disarm']);
const old = `${tmp}/makarasty/notify/dead.json`;
writeFileSync(old, '{"armed":"2026-01-01T00:00:00Z"}');
ago(old, 8 * 86400);
node([n, '--arm']);
if (exists(old))
    bad('arm prunes a marker older than seven days');
else
    ok('arm prunes a marker older than seven days');
writeFileSync(old, '{"armed":"2026-01-01T00:00:00Z"}');
ago(old, 8 * 86400);
hook('{"hook_event_name":"Stop","session_id":"nobody","last_assistant_message":"x"}');
if (exists(old))
    bad('and so does any hook run');
else
    ok('and so does any hook run');
const endCmd = cmdOf('SessionEnd', 'notify.mjs');
if (endCmd !== '' && endCmd === notifyCmd)
    ok('SessionEnd runs the same guarded command');
else
    bad('SessionEnd runs the same guarded command', endCmd);
node([n, '--arm']);
sh(endCmd, { input: '{"hook_event_name":"SessionEnd","session_id":"s1","reason":"prompt_input_exit"}' });
if (exists(marker))
    ok('closing an armed chat keeps its marker for the resume');
else
    bad('closing an armed chat keeps its marker for the resume');
sh(endCmd, { input: '{"hook_event_name":"SessionEnd","session_id":"s1","reason":"clear"}' });
if (exists(marker))
    bad('/clear drops it');
else
    ok('/clear drops it');
node([n, '--disarm']);
section('the wizard');
rmSync(conf, { force: true });
node([n, '--arm', 'the', 'report']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"report written"}', { NOTIFY_DRY_RUN: nowhere });
r = node([n, 'setup']);
out = both(r);
code('with nothing to type into, setup refuses', 1, r.code);
check('and prints the command for a terminal', 'setup needs a terminal', out);
r = node([n, 'setup'], { input: '3\n\nn\n' });
out = both(r);
code('ntfy: three Enters and it is saved', 0, r.code);
check('the wizard generated a topic', 'topic: claude-', out);
check('and the test message was delivered', 'delivered - check your phone', out);
check('and the finish that was waiting went out', '1 message(s) that were waiting', out);
check('the finish reached the sink', 'the report finished', last());
if (exists(marker))
    bad('and its marker is gone');
else
    ok('and its marker is gone');
check('the topic was saved as a full ntfy URL', '"ntfy": "https://ntfy.sh/claude-', read(conf));
r = node([n, 'setup'], { input: '2\nhttps://discord.com/api/webhooks/1/x\n\ny\n9\n2\n \n3\n\nn\n' });
out = both(r);
check('discord: the URL and the default mention', 'Saved discord', out);
check('a wrong menu pick is asked again', 'Add another channel', out);
check('an empty URL is refused', 'nothing entered', out);
check('both channels are kept', '"everyone": true', read(conf));
check('and the earlier one survives', '"ntfy"', read(conf));
check('the closing line names them', 'done: discord, ntfy', out);
section('unslop');
const unslop = `${here}/unslop.mjs`;
out = node([unslop, '--status']).out;
check('off by default', 'unslop: off', out);
out = sh(unslopCmd).out;
if (out === '')
    ok('and the SessionStart hook injects nothing');
else
    bad('and the SessionStart hook injects nothing', out);
out = node([unslop, '--enable']).out;
check('enable prints the rules for this session', 'UNSLOP MODE ON', out);
if (exists(`${tmp}/makarasty/unslop.on`))
    ok('in the config dir the hook reads');
else
    bad('in the config dir the hook reads');
out = sh(unslopCmd).out;
check('the hook injects the same rules', 'UNSLOP MODE ON', out);
node([unslop, '--disable']);
out = sh(unslopCmd).out;
if (out === '')
    ok('disable stops it');
else
    bad('disable stops it', out);
r = node([unslop, '--help']);
code('an unknown argument exits 1', 1, r.code);
check('with usage on stderr', 'usage: node unslop.mjs', r.err);
if (exists(`${tmp}/makarasty/unslop.on`))
    bad('and leaves the switch alone');
else
    ok('and leaves the switch alone');
const ruleLines = read(`${here}/unslop.txt`).split('\n').length - 1;
if (ruleLines <= 30)
    ok('the injected rules stay within 30 lines');
else
    bad('the injected rules stay within 30 lines', `${ruleLines} lines`);
section('context reminder');
const ctxCmd = cmdOf('UserPromptSubmit', 'context.mjs');
const tr = `${tmp}/t.jsonl`;
const turn = (side, input, cached) => appendFileSync(tr, `{"type":"assistant","isSidechain":${side},"message":{"usage":{"input_tokens":${input},"cache_read_input_tokens":${cached},"cache_creation_input_tokens":0}}}\n`);
// MAKARASTY_HANDOFF_AT: the caller's, else this process's, else 400000 (the sh ${MAKARASTY_HANDOFF_AT-400000}).
const ctx = (prompt = 'go on', at) => sh(ctxCmd, {
    input: `{"session_id":"c1","transcript_path":"${tr}","prompt":"${prompt}"}`,
    env: { MAKARASTY_HANDOFF_AT: at ?? process.env.MAKARASTY_HANDOFF_AT ?? '400000' },
}).out;
const pad = (bytes) => appendFileSync(tr, `{"type":"user","pad":"${'x'.repeat(bytes)}"}\n`);
const c0 = () => sh(ctxCmd, { input: `{"session_id":"c0","transcript_path":"${tr}","prompt":"go on"}`, env: { MAKARASTY_HANDOFF_AT: undefined } }).out;
turn(false, 10, 660000);
out = c0();
if (out === '')
    ok('by default silent at 660k');
else
    bad('by default silent at 660k', out);
turn(false, 10, 710000);
out = c0();
check('and first fires at 700k', 'context is at 710k', out);
writeFileSync(tr, '');
turn(false, 10, 100000);
out = ctx();
if (out === '')
    ok('silent under the threshold');
else
    bad('silent under the threshold', out);
turn(false, 10, 420000);
turn(true, 10, 900000);
out = ctx();
check('fires past it, reading the main chain only', 'context is at 420k', out);
out = ctx();
if (out === '')
    ok('once per level');
else
    bad('once per level', out);
turn(false, 10, 520000);
out = ctx();
if (out === '')
    ok('silent inside the same step');
else
    bad('silent inside the same step', out);
turn(false, 10, 560000);
out = ctx();
check('again one step higher', '560k', out);
turn(false, 10, 90000);
ctx();
turn(false, 10, 410000);
out = ctx();
check('a compact re-arms it', '410k', out);
appendFileSync(tr, '{"type":"system","subtype":"compact_boundary","compactMetadata":{"preTokens":720000,"postTokens":15000}}\n');
out = ctx();
if (out === '' && !exists(`${tmp}/makarasty/context/c1`))
    ok('a compact boundary after the last turn reads as the compacted size');
else
    bad('compact boundary read', out);
turn(false, 10, 720000);
out = ctx('go on', '0');
if (out === '')
    ok('0 turns it off');
else
    bad('0 turns it off', out);
const fsess = `${tmp}/makarasty/fleet-sessions`, frun = `${tmp}/frun`;
mkdirSync(fsess, { recursive: true });
mkdirSync(frun, { recursive: true });
writeFileSync(`${fsess}/c1`, `${frun}\n`);
out = ctx();
if (out === '')
    ok('silent in a session fleet.sh recorded as a fleet chat');
else
    bad('silent in a session fleet.sh recorded as a fleet chat', out);
writeFileSync(`${frun}/FINISHED`, '');
rmSync(`${tmp}/makarasty/context/c1`, { force: true });
out = ctx();
check('but not once that run has FINISHED', 'context is at 720k', out);
if (!exists(`${fsess}/c1`))
    ok('and the stale record is deleted');
else
    bad('and the stale record is deleted');
writeFileSync(`${fsess}/c1`, '/no/such/run\n');
rmSync(`${tmp}/makarasty/context/c1`, { force: true });
out = ctx();
check('nor when its run directory is gone', 'context is at 720k', out);
writeFileSync(`${fsess}/c1`, `${frun}\n`);
rmSync(`${frun}/FINISHED`, { force: true });
rmSync(`${tmp}/makarasty/context/c1`, { force: true });
ago(`${fsess}/c1`, 3 * 86400);
out = ctx();
check('nor when its record was not rewritten for two days', 'context is at 720k', out);
rmSync(`${tmp}/makarasty/context/c1`, { force: true });
out = ctx('/makarasty-tools:handoff') + ctx('сделай хенд-офф') + ctx('хенд-офф');
if (out === '')
    ok('silent when the prompt asks for the handoff');
else
    bad('silent when the prompt asks for the handoff', out);
out = ctx('fix the handoff reminder text in context.mjs');
check('a prompt that only mentions it still fires, the level unused', '720k', out);
turn(false, 10, 870000);
pad(2200000);
out = ctx();
check('a reading behind a 2 MB line is still found', '870k', out);
turn(false, 10, 90000);
pad(17000000);
out = ctx();
if (out === '' && exists(`${tmp}/makarasty/context/c1`))
    ok('no reading in the last 16 MB keeps the marker');
else
    bad('no reading in the last 16 MB keeps the marker', out);
r = sh(ctxCmd, { input: 'not json' });
out = `${r.out}\nexit ${r.code}`;
check('bad input exits 0', 'exit 0', out);
const compactCmd = cmdOf('SessionStart', 'context.mjs');
out = sh(compactCmd, { input: '{"hook_event_name":"SessionStart","source":"compact","session_id":"c1","transcript_path":"/x/t.jsonl"}' }).out;
check('after a compact it names the full transcript', 'still on disk, one JSON object per line: /x/t.jsonl', out);
out = node([`${here}/context.mjs`], { input: '{"hook_event_name":"SessionStart","source":"resume","session_id":"c1","transcript_path":"/x/t.jsonl"}' }).out;
if (out === '')
    ok('and says nothing on a plain resume');
else
    bad('and says nothing on a plain resume', out);
console.log('');
rmSync(tmp, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
