#!/usr/bin/env node
// notify-selftest.mjs - the notifier against a temporary config dir and a dry-run sink. No outside network,
// no tokens, about fifteen seconds (four of them the SessionStart time budget against a local server that
// never answers, three a local server that answers slowly, three the wait a Stop with a transcript makes).
// It feeds the hook the events Claude Code would, through the exact commands plugin.json runs, drives the
// fake Telegram (a local server) for setup, ask, send --html, the retries and the finish's silence, and asserts what reached the sink and what stayed on disk. The unslop switch and
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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// Forward slashes everywhere: sh and node both take C:/x, and a backslash path pasted into a sh command
// line or a JSON payload would need escaping.
const fwd = (p: string): string => p.split('\\').join('/');

// tools/hooks, from either tools/src/hooks/ (run by node directly) or tools/hooks/ (compiled).
const self = resolve(import.meta.dirname);
const here = fwd(basename(dirname(self)) === 'src' ? resolve(self, '..', '..', 'hooks') : self);
const n = `${here}/notify.mjs`;
const tmp = fwd(join(tmpdir(), `notify-selftest-${process.pid}`));
mkdirSync(`${tmp}/makarasty`, { recursive: true });
// The words the person sees follow his profile; the cases below pin the Russian ones, and the last section drops it for English.
const profile = `${tmp}/makarasty/profile.md`;
writeFileSync(profile, 'Language: Russian, plain and short.');
const sink = `${tmp}/sent`;
process.env.CLAUDE_CONFIG_DIR = tmp;
process.env.NOTIFY_DRY_RUN = sink;
process.env.CLAUDE_CODE_SESSION_ID = 's1';
const marker = `${tmp}/makarasty/notify/s1.json`;
const conf = `${tmp}/makarasty/notify.json`;
// A made-up bot token and the config that connects it to chat 42; the Telegram calls go to a local fake or the sink.
const tok = '123456789:' + 'Zq8Lm3Vb7Nx2Wc5Rt9Yh4Js6';
const cfgWith = (extra = '') => `{"telegram":{"token":"${tok}","chat_id":"42"}${extra}}\n`;
const confExcerpt = cfgWith(',"excerpt":true'), confPlain = cfgWith();
let pass = 0, fail = 0;

type Env = Record<string, string | undefined>;
interface Opts { input?: string; env?: Env; cwd?: string }
interface Out { out: string; err: string; code: number }

// Like sh's $(...): trailing newlines cut. An env value of undefined unsets the variable.
function run(file: string, args: string[], o: Opts = {}): Out {
  const env: Env = { ...process.env, ...o.env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync(file, args, { input: o.input ?? '', env, cwd: o.cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  const cut = (s: string | null) => (s ?? '').replace(/\n+$/, '');
  // No status means it never ran or a signal killed it: 128, so no "exits 1" check passes by accident.
  return { out: cut(r.stdout), err: cut(r.stderr || (r.error ? String(r.error) : '')), code: r.status ?? 128 };
}
const node = (args: string[], o?: Opts) => run(process.execPath, args, o);
const sh = (script: string, o?: Opts) => run('sh', ['-c', script], o);
const both = (r: Out) => [r.out, r.err].filter(Boolean).join('\n');
const read = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const exists = (p: string) => existsSync(p);
// Blocking, so a background server or hook keeps running while this process waits.
const sleep = (sec: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sec * 1000);
const ago = (p: string, sec: number) => { const t = Date.now() / 1000 - sec; utimesSync(p, t, t); };

function ok(name: string) { pass++; console.log(`  ok    ${name}`); }
function bad(name: string, got = '') { fail++; console.log(`  FAIL  ${name}`); if (got) console.log(`        got: ${got}`); }
function check(name: string, want: string, got: string) { if (got.includes(want)) ok(name); else bad(name, got.split('\n').join('|').slice(0, 200)); }
function code(name: string, want: number, got: number) { if (want === got) ok(name); else bad(name, `exit ${got}, wanted ${want}`); }
const lines = () => read(sink).split('\n').filter((l) => l !== '').length;
function count(name: string, want: number) { const l = lines(); if (l === want) ok(name); else bad(name, `${l} lines in the sink, wanted ${want}`); }
const last = () => read(sink).replace(/\n+$/, '').split('\n').pop() ?? '';
const hook = (payload: string, env?: Env) => node([n], { input: payload, env });
const section = (title: string) => console.log(`\n${title}`);

// The exact commands plugin.json runs, read from it: <event> <a substring of the command>. A script plugin.json no
// longer runs by command (notify.mjs and context.mjs are started by the function hooks in gates.ts, which has its
// own tests in gates.test.ts) is run directly with node; '' for any other absent command.
interface PluginJson { hooks: Record<string, { hooks: { command: string }[] }[]> }
const plugin = JSON.parse(readFileSync(`${here}/../.claude-plugin/plugin.json`, 'utf8')) as PluginJson;
const cmdOf = (ev: string, has: string): string => {
  const c = (plugin.hooks?.[ev] ?? []).flatMap((g) => g.hooks.map((h) => h.command)).find((c) => c.includes(has));
  if (c === undefined) return /^(notify|context)\.mjs$/.test(has) ? `node "${here}/${has}"` : '';
  return c.split('${CLAUDE_PLUGIN_ROOT}').join(`${here}/..`);
};
const notifyCmd = cmdOf('Stop', 'notify.mjs');
const guard = (payload: string) => sh(notifyCmd, { input: payload });

// A local http server in its own process (one here would sleep through every blocking spawnSync below);
// returns it and the port it wrote.
function server(script: string, portFile: string) {
  const srv = spawn(process.execPath, ['-e', script, portFile], { stdio: 'ignore' });
  for (let i = 0; i < 10; i++) { if (read(portFile)) break; sleep(0.2); }
  return { srv, port: read(portFile) };
}

console.log(`notify selftest, dir ${tmp}`);
section('nothing armed');
let out = node([n, '--status']).out; check('status says not armed', 'not armed', out);
check('and names the missing config', 'channels: none', out);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}');
count('an unarmed Stop sends nothing', 0);

section('armed in the same turn as the work');
writeFileSync(conf, confExcerpt);
out = both(node([n, '--arm', 'the', 'build'], { cwd: tmp })); check('arm reports the label', '"the build"', out);
check('and the channel', 'channels: telegram', out);
out = hook('{"hook_event_name":"Notification","session_id":"s1","notification_type":"permission_prompt","message":"Claude needs your permission"}').out;
check('a permission prompt pings', '· ждёт тебя: Claude needs your permission', read(sink));
if (out === '') ok('and prints nothing to stdout, which a hook reserves for context'); else bad('hook stdout stays empty', out);
hook('{"hook_event_name":"Notification","session_id":"s1","notification_type":"permission_prompt","message":"again"}');
count('a second prompt inside five minutes does not', 1);
if (exists(marker)) ok('the marker survives a ping'); else bad('the marker survives a ping');
guard('{"hook_event_name":"Stop","session_id":"s1","cwd":"/x/proj","last_assistant_message":"All green.\\n12 tests pass."}');
check('Stop says finished with the project and label', `✅ <b>notify-selftest-${process.pid}</b> · the build · готово`, last());
check('and carries the tail of the last message', 'All green. 12 tests pass.', last());
if (exists(marker)) bad('Stop consumes the marker'); else ok('Stop consumes the marker');
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"once more"}');
count('the next Stop sends nothing', 2);

section('a question still finishes the arming');
node([n, '--arm']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Should I delete the old branch?"}');
check('a last message ending in ? says finished, with a question', 'готово, есть вопрос к тебе', last());
check('and carries the question', 'Should I delete the old branch?', last());
if (exists(marker)) bad('and consumes the marker: one message per arming'); else ok('and consumes the marker: one message per arming');
node([n, '--arm']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"All done. Want me to **push**?)`"}');
check('markdown after the ? still reads as a question', 'есть вопрос к тебе', last());
node([n, '--arm']);
const long = `start-of-reply ${'x'.repeat(600)} VERDICT: all green`;
hook(`{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"${long}"}`);
check('a plain finish sends', 'готово | <blockquote expandable>...', last());
check('with the END of a long message', 'VERDICT: all green', last());
if (last().includes('start-of-reply')) bad('and not its start'); else ok('and not its start');

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
check('with the label', 'later · готово', last());

section('delivery fails, the chat is reopened');
const nowhere = `${tmp}/no/such/dir/sink`;
node([n, '--arm', 'the', 'deploy']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"deployed"}', { NOTIFY_DRY_RUN: nowhere });
if (exists(marker)) ok('an undelivered message keeps the marker'); else bad('an undelivered message keeps the marker');
check('with the text written before the send', '"done"', read(marker));
hook('{"hook_event_name":"SessionStart","session_id":"s1","source":"startup"}');
count('a plain startup resends nothing', 6);
hook('{"hook_event_name":"SessionStart","session_id":"s1","source":"resume"}');
count('a resume resends it', 7);
check('and says when it had finished', 'не дошло вовремя', last());
if (exists(marker)) bad('and consumes the marker'); else ok('and consumes the marker');
node([n, '--arm', 'the', 'claim']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"claimed"}', { NOTIFY_DRY_RUN: nowhere });
ago(marker, 7200); // an unsent marker is old, and a rename keeps its mtime
const fresh = `${marker}.flushing-${Date.now()}`;
renameSync(marker, fresh);
node([n, '--arm', '--session', 's3', 'third']);
hook('{"hook_event_name":"Stop","session_id":"s3","last_assistant_message":"third done"}', { NOTIFY_DRY_RUN: nowhere });
hook('{"hook_event_name":"SessionStart","session_id":"s3","source":"resume"}');
count("another chat's flush sends its own message and leaves a marker claimed seconds ago alone", 8);
if (exists(fresh)) ok('the fresh claim stays with the chat sending it'); else bad('the fresh claim stays with the chat sending it');
const stale = `${marker}.flushing-${Date.now() - 120e3}`;
renameSync(fresh, stale);
node([n, '--arm', '--session', 's2', 'other']);
hook('{"hook_event_name":"Stop","session_id":"s2","last_assistant_message":"other done"}', { NOTIFY_DRY_RUN: nowhere });
hook('{"hook_event_name":"SessionStart","session_id":"s2","source":"resume"}');
count('a claim a killed hook left over a minute ago goes back and is sent with the next flush', 10);
if (exists(marker) || exists(stale) || exists(`${tmp}/makarasty/notify/s2.json`)) bad('and nothing is left of either'); else ok('and nothing is left of either');

section('the chat dies before it finishes');
node([n, '--arm', 'the', 'migration']);
hook('{"hook_event_name":"StopFailure","session_id":"s1","error":"rate_limit"}');
check('an API error is reported', 'упал на ошибке: rate_limit', last());
if (exists(marker)) ok('and the marker stays for the reopened chat'); else bad('and the marker stays for the reopened chat');
out = hook('{"hook_event_name":"SessionStart","session_id":"s1","source":"resume","seconds_since_last_response":5400}').out;
check('a resume before the finish tells the chat to check its work', 'check whether the task it was on is already complete', out);
check('and how long it was gone', '90 minutes', out);
count('and sends nothing itself', 11);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"The migration had already run; nothing left to do."}');
check('the finish after a reopen says so', 'чат перезапускался', last());

section('elapsed time, and the mark per kind');
const armedAgo = (min: number) => { const o = JSON.parse(read(marker)); o.armed = new Date(Date.now() - min * 60e3).toISOString(); writeFileSync(marker, JSON.stringify(o)); };
node([n, '--arm', 'long', 'job']); armedAgo(12);
hook('{"hook_event_name":"Notification","session_id":"s1","notification_type":"permission_prompt","message":"ok?"}');
check('a needs-you ping says how long the work has run', 'long job · ждёт тебя · 12 мин: ok?', last());
hook('{"hook_event_name":"StopFailure","session_id":"s1","error":"overloaded"}');
check('so does an error', 'упал на ошибке · 12 мин: overloaded', last());
armedAgo(75);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}');
check('and a finish, in hours past 59 minutes', 'long job · готово · 1 ч 15 мин', last());
node([n, '--arm', '--next', 'late']); armedAgo(30);
hook('{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"go"}');
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}');
if (/готово · \d/.test(last())) bad('a --next marker counts from the prompt, not from the arming', last()); else ok('a --next marker counts from the prompt, not from the arming');
node([n, '--arm', 'weekend']); armedAgo(70 * 60 + 12);
hook('{"hook_event_name":"SessionStart","session_id":"s1","source":"resume"}');
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}');
check('a reopened chat counts from the resume, not the closed time', 'weekend · готово', last());
if (/готово · \d/.test(last())) bad('and not from the arming', last()); else ok('and not from the arming');
// The mark leads the message: a lock screen shows what kind it is before a word is read.
const marks = ['✅ ', '⚠️ ', '❌ '];
const marked = (s: string) => marks.some((m) => s.startsWith(m));
node([n, '--arm', 'marks']);
hook('{"hook_event_name":"Notification","session_id":"s1","notification_type":"permission_prompt","message":"ok?"}');
const markWait = last();
hook('{"hook_event_name":"StopFailure","session_id":"s1","error":"overloaded"}');
const markFail = last();
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}');
const markDone = last();
if (markWait.startsWith('⚠️ ') && markWait.includes('marks · ждёт тебя')) ok('needs you starts with the warning mark'); else bad('needs you starts with the warning mark', markWait);
if (markFail.startsWith('❌ ') && markFail.includes('marks · упал на ошибке')) ok('an error starts with the cross'); else bad('an error starts with the cross', markFail);
if (markDone.startsWith('✅ ') && markDone.includes('marks · готово')) ok('a finish starts with the check mark'); else bad('a finish starts with the check mark', markDone);
node([n, '--disarm']);

section('direct sends');
node([n, 'send', 'fleet 2026-09-08-x FINISHED: 3 findings']);
check('send posts the text as given', 'fleet 2026-09-08-x FINISHED: 3 findings', last());
if (marked(last())) bad('and adds no mark of its own', last()); else ok('and adds no mark of its own');
out = node([n, '--test']).out; check('test reports the channel', 'sent to dry-run', out);
out = node([n, '--disarm', '--session', 'other']).out; check('disarm on a session that was never armed is quiet', 'disarmed', out);
let r = node([n, '--arm'], { env: { CLAUDE_CODE_SESSION_ID: '' } });
code('arming with no session id refuses', 1, r.code);
check('and says how to name one', '--session', both(r));
r = node([n, '--disarm', '--session', '../notify']);
code('a session id that is a path is refused', 1, r.code);
if (exists(conf)) ok('and the config it pointed at survives'); else bad('and the config it pointed at survives');

section('the excerpt');
writeFileSync(conf, confPlain);
node([n, '--arm', 'the', 'secret']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"API_KEY=abc123"}');
check('the head still goes out', 'the secret · готово', last());
if (last().includes('API_KEY')) bad('the excerpt is off by default'); else ok('the excerpt is off by default');
node([n, '--arm', 'the', 'secret']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Build green, 12 tests pass."}', { MAKARASTY_NOTIFY_EXCERPT: '1' });
check('MAKARASTY_NOTIFY_EXCERPT=1 turns the excerpt on', 'Build green, 12 tests pass.', last());
// Each secret is built from pieces, so this file passes the secret scan; the body is 40 characters of a made-up value.
const body = 'Zq8Lm3Vb7Nx2Wc5Rt9Yh4Js6Dg0Fa1Pe8Uo3Ik2';
const secrets: [string, string][] = [
  ['a URL', 'https://x.example/hook?t=9'], ['a Telegram bot token', '123456789:' + body.slice(0, 35)],
  ['a Discord webhook', 'discord' + '.com/api/webhooks/123456789012/' + body], ['an sk-ant key', 'sk-' + 'ant-api03-' + body],
  ['an sk key', 'sk-' + body], ['a Stripe key', 'sk_' + 'live_' + body.slice(0, 24)], ['a GitHub token', 'gh' + 'p_' + body],
  ['a fine-grained GitHub token', 'github_' + 'pat_' + body.slice(0, 30)], ['an AWS key id', 'AK' + 'IA' + 'ZQ8LM3VB7NX2WC5R'],
  ['a Slack token', 'xox' + 'b-123456789012-' + body.slice(0, 12)], ['a Google key', 'AI' + 'za' + body.slice(0, 35)],
  ['a JWT', 'ey' + 'Jhbgcioijiuzi1nirt.ey' + 'Jzdwiioiixmjmindu4otailn0'], ['an ntfy topic', 'ntfy' + '.sh/' + body.slice(0, 12)],
  ['api_key=', 'API_KEY=abc123def456'],
];
for (const [what, v] of secrets) {
  node([n, '--arm', 'the', 'secret']);
  hook(`{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"before ${v} after"}`, { MAKARASTY_NOTIFY_EXCERPT: '1' });
  const got = last();
  if (got.includes(v.slice(-12)) || !got.includes('before') || !got.includes('after')) bad(`${what} in the excerpt is blanked`, got.slice(0, 200)); else ok(`${what} in the excerpt is blanked`);
}
// A quoted value is blanked whole; the JSON payload carries the quotes escaped.
node([n, '--arm', 'the', 'secret']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"before password: \\"hunter2hunter2\\" after"}', { MAKARASTY_NOTIFY_EXCERPT: '1' });
if (last().includes('hunter2') || !last().includes('before password: &lt;redacted&gt; after')) bad('a quoted password value is blanked', last().slice(0, 200)); else ok('a quoted password value is blanked');
// Prose that names a secret is not code: it goes out as written.
for (const prose of ['The secret: nothing leaked; password = hashed with bcrypt', 'Fixed the token: refresh now rotates', 'csrfToken: the header']) {
  node([n, '--arm', 'the', 'secret']);
  hook(`{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"${prose}"}`, { MAKARASTY_NOTIFY_EXCERPT: '1' });
  check(`prose "${prose.slice(0, 24)}..." is not blanked`, prose, last());
}
node([n, '--arm', 'the', 'secret']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"key\\n-----BEGIN ' + 'RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEAu1SU1LfVLPHCoz\\n-----END ' + 'RSA PRIVATE KEY-----\\ndone"}', { MAKARASTY_NOTIFY_EXCERPT: '1' });
if (last().includes('MIIEow') || !last().includes('done')) bad('a PRIVATE KEY block in the excerpt is blanked', last().slice(0, 200)); else ok('a PRIVATE KEY block in the excerpt is blanked');

section('config values of the wrong type');
writeFileSync(conf, '{"telegram":{"token":["x"],"chat_id":"42"},"excerpt":true}\n');
r = node([n, '--test']); out = both(r);
code('a token that is not a string does not crash it', 0, r.code);
check('it is named', 'the telegram token is not a string', out);
check('and the dry run still sends', 'sent to dry-run', out);
writeFileSync(conf, '{"telegram":{"token":987654321012,"chat_id":"42"}}\n');
out = both(node([n, '--status']));
check('a number as the token is named too', 'the telegram token is not a string', out);
if (out.includes('987654321012')) bad('and its value is never printed', out); else ok('and its value is never printed');
writeFileSync(conf, '{"telegram":{"token":"SECRETSECRET-not-a-bot-token","chat_id":"42"}}\n');
out = both(node([n, '--status']));
check('a token that is not a bot token is named', 'does not look like a bot token', out);
if (out.includes('SECRETSECRET')) bad('and its value is never printed', out); else ok('and its value is never printed');
check('and the channel is left out', 'channels: none', out);
writeFileSync(conf, `{"telegram":{"token":"${tok}"}}\n`);
check('a token with no chat is not connected', 'channels: none', both(node([n, '--status'])));
writeFileSync(conf, confPlain);
check('a token with its chat is', 'channels: telegram', both(node([n, '--status'])));

section('a marker file Windows holds for a moment (EPERM on rename or read)');
// notify.mjs loaded in a child process with node:fs's renameSync and readFileSync swapped for ones that
// fail with EPERM a set number of times, the way a second writer or an antivirus scan makes them fail.
// The child reads the module source from stdin: it is longer than a Windows command line takes.
function flaky(file: string, renameFails: number, readFails: number): string {
  const src = readFileSync(n, 'utf8').replace(/^main\(\)\.then.*$/m, '').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(n).href)) // the module runs from a data: URL, which has no directory of its own
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
  return both(node(['--input-type=module', '-e', 'const { readFileSync } = await import("node:fs"); await import("data:text/javascript," + encodeURIComponent(readFileSync(0, "utf8")));'],
    { input: mod, env: { RENAME_FAILS: String(renameFails), READ_FAILS: String(readFails) } }));
}
const fl = `${tmp}/flaky`; mkdirSync(fl, { recursive: true });
out = flaky(`${fl}/a.json`, 3, 1);
check('a rename refused three times lands on a retry, and a read refused once is retried', '{"armed":"x"}', out);
out = flaky(`${fl}/b.json`, 99, 0);
check('a rename refused for good falls back to writing in place', '{"armed":"x"}', out);
const left = readdirSync(fl).sort().join(' ');
if (left === 'a.json b.json') ok('and no temp file is left behind'); else bad('and no temp file is left behind', left);
out = flaky(`${fl}/c.json`, 0, 2);
check('a read refused twice reads as not armed, not as a crash', 'null', out);

section('not a finish yet');
writeFileSync(conf, confExcerpt);
node([n, '--arm', 'the', 'job']);
let b = lines();
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Started it in the background.","background_tasks":[{"id":"b1","status":"running"}],"session_crons":[]}');
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Looping.","background_tasks":[],"session_crons":[{"id":"c1"}]}');
count('a Stop with a background job or a loop sends one pause message, not a finish', b + 1);
check('which says paused and how many jobs', 'the job · пауза: ещё идут фоновые задачи (1)', last());
if (exists(marker)) ok('and keeps the marker for the turn they wake'); else bad('and keeps the marker for the turn they wake');
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Build done, server still up.","background_tasks":[{"id":"b1","status":"running"}],"session_crons":[{"id":"c1"}]}');
check('a later Stop with only the jobs seen at the pause is the finish', 'the job · готово', last());
if (exists(marker)) bad('and consumes the marker'); else ok('and consumes the marker');
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
if (exists(marker)) ok('and keeps the marker'); else bad('and keeps the marker');
appendFileSync(wt, '{"type":"assistant","message":{"content":[{"type":"text","text":"Released task-1. Done."}]}}\n');
hook(`{"hook_event_name":"Stop","session_id":"s1","stop_hook_active":true,"transcript_path":"${wt}","last_assistant_message":"Released task-1. Done."}`);
count('the Stop that really ends that turn sends', b + 1);
node([n, '--arm', 'the', 'job']);
const b2 = lines();
const big = `${tmp}/big.jsonl`, filler = `{"type":"progress","data":"${'x'.repeat(1000)}"}\n`;
writeFileSync(big, '{"type":"user","message":{"role":"user","content":"take task 1"}}\n' + filler.repeat(10 * 1024) + [
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Stopping here."}]}}',
  '{"type":"user","message":{"role":"user","content":"Stop hook feedback:\\n[guard]: You still hold task-1"}}',
].join('\n') + '\n');
hook(`{"hook_event_name":"Stop","session_id":"s1","stop_hook_active":false,"transcript_path":"${big}","last_assistant_message":"Stopping here."}`);
count('a blocked Stop at the end of a 10 MB transcript is still seen (only the tail is read)', b2);
node([n, '--disarm']);
out = node([n, '--arm', 'C:/Program Files/Git/deploy', 'на', 'прод'], { env: { MSYSTEM: 'MINGW64', EXEPATH: 'C:\\Program Files\\Git\\bin' } }).out;
check('a /label Git Bash turned into a Program Files path is stored as typed', '"/deploy на прод"', out);
node([n, '--disarm']);
node([n, '--arm', '--next', 'later']);
out = hook('{"hook_event_name":"SessionStart","session_id":"s1","source":"resume"}').out;
if (out === '') ok('a resume does not tell a --next chat to check work it has not started'); else bad('a resume does not tell a --next chat to check work', out);
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
if (read(`${tmp}/makarasty/notify/s9.json`).includes('cwd')) bad('--session stores no cwd of the arming chat'); else ok('--session stores no cwd of the arming chat');
hook('{"hook_event_name":"Stop","session_id":"s9","cwd":"/x/theirproj","last_assistant_message":"done"}');
check("and the finish names that chat's project", '<b>theirproj</b> · their build · готово', last());

section('a slow send, and error text that carries a secret');
const s2 = server('require("http").createServer((q, r) => { q.resume(); setTimeout(() => { r.writeHead(400, { "content-type": "application/json" }); r.end(JSON.stringify({ ok: false, description: "no such hook https://hooks.example/T0/SECRETSECRET 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ" })); }, 1500); }).listen(0, "127.0.0.1", function () { require("fs").writeFileSync(process.argv[1], String(this.address().port)); })', `${tmp}/port2`);
writeFileSync(conf, confPlain);
node([n, '--arm', 'first']);
const errText = hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}', { NOTIFY_DRY_RUN: '', NOTIFY_TELEGRAM_API: `http://127.0.0.1:${s2.port}` }).err;
check('a failed send says what failed', 'telegram failed: 400 no such hook <url> <token>', errText);
if (/SECRETSECRET|ABCDEFGHIJ/.test(errText + read(marker))) bad('with no URL or token in the error or the marker'); else ok('with no URL or token in the error or the marker');
node([n, '--arm', 'first']);
// Its stdin is a file, not a pipe: a pipe write would wait for the event loop the blocking sleep holds.
writeFileSync(`${tmp}/slow-in`, '{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}');
const slowIn = openSync(`${tmp}/slow-in`, 'r');
const slow = spawn(process.execPath, [n], { env: { ...process.env, NOTIFY_DRY_RUN: '', NOTIFY_TELEGRAM_API: `http://127.0.0.1:${s2.port}` }, stdio: [slowIn, 'ignore', 'ignore'] });
const slowDone = new Promise((res) => slow.on('close', res));
sleep(0.7); node([n, '--arm', 'second']); await slowDone; closeSync(slowIn);
check('a re-arm during a slow send survives it', '"label": "second"', read(marker));
if (read(marker).includes('unsent')) bad("and takes none of the old send's state", read(marker)); else ok("and takes none of the old send's state");
s2.srv.kill();
node([n, '--disarm']);

section('the SessionStart time budget, against a local server that never answers');
const s1 = server('require("http").createServer(() => {}).listen(0, "127.0.0.1", function () { require("fs").writeFileSync(process.argv[1], String(this.address().port)); })', `${tmp}/port`);
writeFileSync(conf, confPlain);
node([n, '--arm', 'the', 'hang']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"hung"}', { NOTIFY_DRY_RUN: nowhere });
const start = Date.now();
hook('{"hook_event_name":"SessionStart","session_id":"s1","source":"resume"}', { NOTIFY_DRY_RUN: '', NOTIFY_TELEGRAM_API: `http://127.0.0.1:${s1.port}` });
const ms = Date.now() - start, took = Math.round(ms / 1000);
s1.srv.kill();
// The limit on the exact time, not the rounded one, so 7.4 s cannot round down into a pass.
if (ms <= 7000) ok(`a resume gives up after about four seconds (took ${took}s, hook timeout 10)`); else bad('a resume gives up after about four seconds', `took ${took}s`);
if (exists(marker)) ok('and the undelivered finish stays on disk: no time was left to ask whether it arrived'); else bad('and the undelivered finish stays on disk: no time was left to ask whether it arrived');
node([n, '--disarm']);
writeFileSync(conf, confExcerpt);

section('a send whose outcome is unknown is never sent twice');
// A Telegram look-alike: answers each method from its plan (a status per request, then 200) and logs every request.
let mocks = 0;
function mock(plan: Record<string, number[]>) {
  const log = `${tmp}/reqs-${++mocks}`;
  const script = `const fs = require("fs"), plan = ${JSON.stringify(plan)};
require("http").createServer((q, r) => { q.resume(); q.on("end", () => {
  const m = q.url.split("/").pop(); fs.appendFileSync(${JSON.stringify(log)}, m + "\\n");
  const st = (plan[m] || []).shift() || 200;
  if (st === -1) return; // never answers
  if (st === -2) return q.socket.destroy(); // the connection drops
  r.writeHead(st, { "content-type": "application/json" });
  r.end(JSON.stringify(st === 200 ? { ok: true, result: m === "getMe" ? { username: "x_bot" } : m === "getUpdates" ? [] : { message_id: 7 } } : { ok: false, description: st === 429 ? "Too Many Requests" : "Gateway Timeout", parameters: { retry_after: 1 } }));
}); }).listen(0, "127.0.0.1", function () { fs.writeFileSync(process.argv[1], String(this.address().port)); })`;
  const s = server(script, `${tmp}/mock-port-${mocks}`);
  return { ...s, env: { NOTIFY_DRY_RUN: '', NOTIFY_TELEGRAM_API: `http://127.0.0.1:${s.port}` }, reqs: () => read(log).split('\n').filter(Boolean) };
}
writeFileSync(conf, confPlain);
const doc = `${tmp}/report.txt`; writeFileSync(doc, 'hello');
const unconfirmedLine = 'notify: telegram did not confirm (504 Gateway Timeout): it may have arrived, so it is not sent again';
let mk = mock({ sendMessage: [504] });
r = node([n, 'send', 'hi'], { env: mk.env });
code('a send answered 504 exits 0', 0, r.code);
check('and says it did not confirm', unconfirmedLine, r.err);
check('after one request only', 'sendMessage', mk.reqs().join(','));
if (mk.reqs().filter((x) => x.startsWith('send')).length === 1) ok('and not a second one (the old retry would make two)'); else bad('and not a second one', mk.reqs().join(','));
mk.srv.kill();
mk = mock({ sendDocument: [504] });
r = node([n, 'file', doc, '--caption', 'x'], { env: mk.env });
code('a file answered 504 exits 0', 0, r.code);
check('and says it did not confirm', 'notify: telegram did not confirm (Gateway Timeout): it may have arrived, so it is not sent again', r.err);
if (mk.reqs().filter((x) => x.startsWith('send')).length === 1) ok('after one request only'); else bad('after one request only', mk.reqs().join(','));
mk.srv.kill();
mk = mock({ sendMessage: [400] });
r = node([n, 'send', 'hi'], { env: mk.env });
code('a clear 4xx is still a failure', 1, r.code);
check('and says failed', 'telegram failed: 400', r.err);
mk.srv.kill();
mk = mock({ sendMessage: [429] });
r = node([n, 'send', 'hi'], { env: mk.env });
code('a 429 is retried and the send lands', 0, r.code);
if (mk.reqs().length === 2 && !r.err) ok('with two requests and no complaint'); else bad('with two requests and no complaint', `${mk.reqs().join(',')} ${r.err}`);
mk.srv.kill();
mk = mock({ sendMessage: [504] });
node([n, '--arm', 'unsure']);
r = hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}', mk.env);
check('a finish answered 504 says it did not confirm', 'did not confirm', r.err);
if (exists(marker)) bad('and the marker is gone: no later flush sends it again', read(marker)); else ok('and the marker is gone: no later flush sends it again');
if (mk.reqs().filter((x) => x.startsWith('send')).length === 1) ok('after one request only'); else bad('after one request only', mk.reqs().join(','));
mk.srv.kill();
// A request that hangs says nothing by itself: getMe decides whether Telegram was reachable (the send may have arrived) or the
// network is out (it never left, so the finish stays for a later try).
mk = mock({ sendMessage: [-1, -1, -1], getMe: [-1, -1, -1] });
node([n, '--arm', 'dead']);
r = hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}', mk.env);
check('a send that hangs with Telegram unreachable is a failure', 'telegram failed', r.err);
if (r.err.includes('did not confirm')) bad('and not unconfirmed', r.err); else ok('and not unconfirmed');
check('and the finish stays on disk to be sent later', '"unsent"', read(marker));
if (mk.reqs().filter((x) => x === 'sendMessage').length === 1) ok('after one sendMessage: an ambiguous send is not repeated'); else bad('after one sendMessage', mk.reqs().join(','));
mk.srv.kill();
mk = mock({ sendMessage: [-1] });
r = node([n, 'send', 'hi'], { env: mk.env });
check('a send that hangs with Telegram reachable did not confirm', 'did not confirm', r.err);
code('and exits 0', 0, r.code);
if (mk.reqs().filter((x) => x === 'sendMessage').length === 1) ok('after one sendMessage only'); else bad('after one sendMessage only', mk.reqs().join(','));
mk.srv.kill();
mk = mock({ sendMessage: [504] });
r = node([n, 'ask'], { env: mk.env, input: '{"item":"i1","html":"Q?","short":"Q"}' });
code('an ask answered 504 fails, so the inbox sends it again', 1, r.code);
check('and says why', 'no message id', r.err);
mk.srv.kill();
// Two finishes in one flush: each is judged on its own probe. The first one's send and probe both fail (it stays), the network is
// back for the second one (504, then getMe answers: it may have arrived, so it goes).
mk = mock({ sendMessage: [-2, 504], getMe: [-2] });
const mDir = `${tmp}/makarasty/notify`;
const finish = (armed: string) => JSON.stringify({ armed, label: armed, done: '2026-11-18T10:00:00.000Z', text: armed, excerpt: '', unsent: [{ name: 'telegram', error: 'x' }] });
writeFileSync(`${mDir}/other.json`, finish('other')); writeFileSync(marker, finish('mine'));
hook('{"hook_event_name":"SessionStart","session_id":"s1","source":"resume"}', mk.env);
if (exists(`${mDir}/other.json`)) ok('the first finish, whose probe failed, stays'); else bad('the first finish, whose probe failed, stays');
if (exists(marker)) bad('the second finish, whose probe answered, is dropped', read(marker)); else ok('the second finish, whose probe answered, is dropped');
check('with one probe each', 'sendMessage,getMe,sendMessage,getMe', mk.reqs().join(','));
rmSync(`${mDir}/other.json`, { force: true });
mk.srv.kill();
mk = mock({}); mk.srv.kill(); sleep(0.5);
node([n, '--arm', 'refused']);
r = hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}', mk.env);
check('a refused connection never sent: the finish stays on disk', '"unsent"', read(marker));
// The idempotent calls keep retrying: setup's getMe answers 502 once, then the bot is found.
mk = mock({ getMe: [502] });
const setupRun = spawn(process.execPath, [n, 'setup'], { env: { ...process.env, ...mk.env, NOTIFY_CLIPBOARD: `${tmp}/clip`, NOTIFY_NO_OPEN: '1' }, stdio: 'ignore' });
for (let i = 0; i < 20 && !read(`${tmp}/clip`).includes('_bot'); i++) sleep(0.5); // setup puts a bot name on the clipboard, then waits for the token
writeFileSync(`${tmp}/clip`, `${tok}Qw7Er5Ty3Ui`); // setup wants 30+ characters after the colon
for (let i = 0; i < 30 && mk.reqs().filter((x) => x === 'getMe').length < 2; i++) sleep(0.5);
setupRun.kill(); mk.srv.kill();
if (mk.reqs().filter((x) => x === 'getMe').length === 2) ok('a getMe answered 502 is retried'); else bad('a getMe answered 502 is retried', mk.reqs().join(','));
node([n, '--disarm']);

// Whether node starts at all is the arming test in gates.ts (tests in gates.test.ts: no marker, a marker, another config
// dir, ~/.claude when CLAUDE_CONFIG_DIR is unset). What is left here is what notify.mjs itself does.
section('markers: pruning and /clear');
rmSync(`${tmp}/makarasty/notify`, { recursive: true, force: true });
mkdirSync(`${tmp}/makarasty/notify`, { recursive: true });
const old = `${tmp}/makarasty/notify/dead.json`; writeFileSync(old, '{"armed":"2026-01-01T00:00:00Z"}');
ago(old, 8 * 86400);
node([n, '--arm']);
if (exists(old)) bad('arm prunes a marker older than seven days'); else ok('arm prunes a marker older than seven days');
writeFileSync(old, '{"armed":"2026-01-01T00:00:00Z"}');
ago(old, 8 * 86400);
hook('{"hook_event_name":"Stop","session_id":"nobody","last_assistant_message":"x"}');
if (exists(old)) bad('and so does any hook run'); else ok('and so does any hook run');
node([n, '--arm']);
hook('{"hook_event_name":"SessionEnd","session_id":"s1","reason":"prompt_input_exit"}');
if (exists(marker)) ok('closing an armed chat keeps its marker for the resume'); else bad('closing an armed chat keeps its marker for the resume');
hook('{"hook_event_name":"SessionEnd","session_id":"s1","reason":"clear"}');
if (exists(marker)) bad('/clear drops it'); else ok('/clear drops it');
node([n, '--disarm']);

// A fake Telegram in its own process. It logs every call to <portFile>.log, answers getMe, hands out message ids from
// 101, and returns the JSON array in <portFile>.updates once for getUpdates (then []).
interface Call { method: string; url: string; body: Record<string, any> }
const tgScript = `const http = require("http"), fs = require("fs");
const pf = process.argv[1]; let id = 100;
http.createServer((q, r) => {
  let b = ""; q.on("data", (d) => b += d);
  q.on("end", () => {
    const method = q.url.split("/").pop();
    fs.appendFileSync(pf + ".log", JSON.stringify({ url: q.url, method, body: !b ? {} : b[0] === "{" ? JSON.parse(b) : { form: b.slice(0, 2000) } }) + "\\n");
    let result = true;
    if (method === "getMe") result = { username: "claude_test_bot" };
    else if (/^send(Message|Photo|Video|Voice|Audio|Document|Animation)$/.test(method)) result = { message_id: ++id };
    else if (method === "getUpdates") { try { result = JSON.parse(fs.readFileSync(pf + ".updates", "utf8")); fs.unlinkSync(pf + ".updates"); } catch { result = []; } }
    r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ ok: true, result }));
  });
}).listen(0, "127.0.0.1", function () { fs.writeFileSync(pf, String(this.address().port)); });`;

section('setup, against a fake Telegram');
const tg = server(tgScript, `${tmp}/porttg`);
const api = `http://127.0.0.1:${tg.port}`;
const tgLog = () => read(`${tmp}/porttg.log`).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call);
const calls = (method: string) => tgLog().filter((c) => c.method === method);
const resetLog = () => rmSync(`${tmp}/porttg.log`, { force: true });
const updatesFile = `${tmp}/porttg.updates`;
// Async, so the setup child's events keep flowing while this waits.
const until = async (cond: () => boolean, sec = 10) => { for (let i = 0; i < sec * 20 && !cond(); i++) await new Promise((res) => setTimeout(res, 50)); return cond(); };
rmSync(conf, { force: true });
node([n, '--arm', 'the', 'report']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"report written"}', { NOTIFY_DRY_RUN: nowhere });
const clip = `${tmp}/clipboard`, setupLog = `${tmp}/setup.out`, botTok = '987654321:' + body.slice(0, 36);
const setupFd = openSync(setupLog, 'w');
const setupProc = spawn(process.execPath, [n, 'setup'], { env: { ...process.env, NOTIFY_DRY_RUN: '', NOTIFY_TELEGRAM_API: api, NOTIFY_CLIPBOARD: clip, NOTIFY_NO_OPEN: '1' }, stdio: ['ignore', setupFd, setupFd] });
const setupDone = new Promise<number>((res) => setupProc.on('close', (c) => res(c ?? 128)));
if (await until(() => /^claude_[0-9a-f]{6}_bot$/.test(read(clip).trim()))) ok('setup puts a bot username on the clipboard'); else bad('setup puts a bot username on the clipboard', read(clip));
writeFileSync(clip, botTok); // what tapping the token in BotFather copies
await until(() => /\?start=[0-9a-f]+\)/.test(read(setupLog)));
const startCode = /\?start=([0-9a-f]+)\)/.exec(read(setupLog))?.[1] ?? '';
if (startCode) ok('it picks the token up and prints a Start link with a one-time code'); else bad('it prints a Start link with a code', read(setupLog));
if (calls('getMe')[0]?.url.includes(`/bot${botTok}/`)) ok('getMe was asked with the token from the clipboard'); else bad('getMe was asked with the clipboard token', JSON.stringify(calls('getMe')));
// A stranger's Start with the wrong code comes first; only the one with this code binds.
writeFileSync(updatesFile, JSON.stringify([
  { update_id: 1, message: { message_id: 1, chat: { id: 99 }, from: { id: 99 }, text: '/start 000000000000' } },
  { update_id: 2, message: { message_id: 2, chat: { id: 42 }, from: { id: 42 }, text: `/start ${startCode}` } },
]));
const setupExit = await Promise.race([setupDone, new Promise<number>((res) => setTimeout(() => { setupProc.kill(); res(-1); }, 20000))]);
closeSync(setupFd);
code('setup ends well', 0, setupExit);
const saved = JSON.parse(read(conf) || '{}');
if (saved.telegram?.chat_id === '42' && saved.telegram?.token === botTok) ok('the chat that sent the code is saved, not the stranger'); else bad('the chat that sent the code is saved', read(conf));
const sentTexts = calls('sendMessage').map((c) => `${c.body.chat_id} ${c.body.text}`).join('|');
check('a test message went to that chat', '42 ⚠️ <b>Claude Code на ', sentTexts);
check('and says it is connected', 'подключён.</b>', sentTexts);
check('and the finish that was waiting went out', 'the report · готово', sentTexts);
const connectMsg = calls('sendMessage').find((c) => String(c.body.text).includes('подключён'))?.body ?? {};
const waitingFinish = calls('sendMessage').find((c) => String(c.body.text).includes('the report · готово'))?.body ?? {};
if (connectMsg.disable_notification === undefined && connectMsg.parse_mode === 'HTML') ok('the connect message rings and is HTML'); else bad('the connect message rings and is HTML', JSON.stringify(connectMsg));
if (waitingFinish.disable_notification === true) ok('a finish goes out silently'); else bad('a finish goes out silently', JSON.stringify(waitingFinish));
if (calls('deleteMyCommands').length === 1 && !calls('setMyCommands').length) ok('setup removes the bot menu: plain text only'); else bad('setup removes the bot menu: plain text only');
if (exists(marker)) bad('and its marker is gone'); else ok('and its marker is gone');
if (read(clip).includes(botTok)) bad('the token is not left on the clipboard'); else ok('the token is not left on the clipboard');
if (read(setupLog).includes(botTok)) bad('and never printed'); else ok('and never printed');

section('ask, against the same fake');
writeFileSync(conf, confPlain);
const askDir = `${tmp}/makarasty/telegram/asks`, inboundDir = `${tmp}/makarasty/telegram/inbound`;
const liveTg = { NOTIFY_DRY_RUN: '', NOTIFY_TELEGRAM_API: api };
// What the inbox makes (core.mjs phoneAsk, phoneKeyboard): the HTML, the short line, the options and the keyboard.
const kbd = { inline_keyboard: [[{ text: 'Да', callback_data: 'a0' }, { text: 'Нет', callback_data: 'a1' }, { text: '❔ Подробнее', callback_data: 'm' }]] };
const askIn = { item: 'i1', html: '<b>Запушить ветку?</b>\n<i>proj · да/нет · 3 мин</i>', short: 'Запушить ветку?', options: ['Да', 'Нет'], reply: true, keyboard: kbd };
resetLog();
const a1 = node([n, 'ask'], { input: JSON.stringify(askIn), env: liveTg });
code('ask exits 0', 0, a1.code);
check('and prints the message id', 'asked, message', a1.out);
const askId = /message (\d+)/.exec(a1.out)?.[1] ?? '';
const sm = calls('sendMessage')[0]?.body ?? {};
if (sm.text === askIn.html && sm.parse_mode === 'HTML' && sm.chat_id === '42') ok('the question goes out as the inbox made it, HTML, to the bound chat'); else bad('the question goes out as the inbox made it', JSON.stringify(sm));
if (JSON.stringify(sm.reply_markup) === JSON.stringify(kbd)) ok('with its keyboard as given'); else bad('with its keyboard as given', JSON.stringify(sm.reply_markup));
if (sm.disable_notification === undefined) ok('and a question rings'); else bad('and a question rings', JSON.stringify(sm));
const saved1 = JSON.parse(read(`${askDir}/${askId}.json`) || '{}');
if (saved1.item === 'i1' && saved1.short === askIn.short && saved1.html === askIn.html && String(saved1.options) === 'Да,Нет' && saved1.reply === true && typeof saved1.at === 'number') ok('the ask is saved under its message id for the hook engine'); else bad('the ask is saved under its message id', JSON.stringify(saved1));
if (saved1.multi === undefined && saved1.later === undefined) ok('a plain ask saves no multi-select or "Later" flag'); else bad('a plain ask saves no multi-select or "Later" flag', JSON.stringify(saved1));
const a1b = node([n, 'ask'], { input: JSON.stringify({ ...askIn, item: 'i1b', q: 'Q', of: 2, multi: true, later: true }), env: liveTg });
const saved1b = JSON.parse(read(`${askDir}/${/message (\d+)/.exec(a1b.out)?.[1]}.json`) || '{}');
if (saved1b.multi === true && saved1b.later === true && saved1b.of === 2) ok('one of several, multi-select: both flags are saved for the poller'); else bad('multi-select and "Later" flags are saved', JSON.stringify(saved1b));

// A question can carry what a chat printed: no secret leaves, in the message or in the saved copy.
resetLog();
const leak = 'sk-' + body;
const a2 = node([n, 'ask'], { input: JSON.stringify({ item: 'i2', html: `<b>Ключ ${leak} верен?</b>`, short: 'Ключ?', options: [], reply: false }), env: liveTg });
const sm2 = String(calls('sendMessage')[0]?.body.text ?? '');
if (!sm2.includes(leak.slice(-12)) && sm2.includes('[скрыто]')) ok('a secret in the question is blanked before it is sent'); else bad('a secret in the question is blanked', sm2);
if (read(`${askDir}/${/message (\d+)/.exec(a2.out)?.[1]}.json`).includes(leak.slice(-12))) bad('and in the saved ask'); else ok('and in the saved ask');
resetLog();
r = node([n, 'ask'], { input: 'not json', env: liveTg });
code('ask with input that is not JSON exits 2', 2, r.code);
r = node([n, 'ask'], { input: JSON.stringify({ item: 'x' }), env: liveTg });
code('ask with no html exits 2', 2, r.code);
if (calls('sendMessage').length === 0) ok('and sends nothing'); else bad('and sends nothing');
r = node([n, 'ask'], { input: JSON.stringify({ ...askIn, item: 'dry' }) });
if (r.code === 0 && !exists(`${askDir}/0.json`)) ok('a dry run saves no ask (it has no message id)'); else bad('a dry run saves no ask', both(r));

// The engine cannot delete: the asks it closed and the messages it answered are pruned here after two days.
mkdirSync(inboundDir, { recursive: true });
const day = 86400e3;
writeFileSync(`${askDir}/900.json`, JSON.stringify({ item: 'a', closed: Date.now() - 3 * day }));
writeFileSync(`${askDir}/901.json`, JSON.stringify({ item: 'b', closed: Date.now() - 3600e3 }));
writeFileSync(`${askDir}/902.json`, JSON.stringify({ item: 'c', at: Date.now() - 3 * day }));
writeFileSync(`${inboundDir}/5.json`, JSON.stringify({ id: 5, done: Date.now() - 3 * day }));
writeFileSync(`${inboundDir}/6.json`, JSON.stringify({ id: 6, done: Date.now() - 3600e3 }));
writeFileSync(`${inboundDir}/7.json`, JSON.stringify({ id: 7, taken: Date.now() - 3 * day }));
node([n, 'ask'], { input: JSON.stringify({ ...askIn, item: 'i3' }), env: liveTg });
if (!exists(`${askDir}/900.json`) && !exists(`${inboundDir}/5.json`)) ok('a closed ask and an answered message older than two days are pruned'); else bad('old closed asks and answered messages are pruned');
if (exists(`${askDir}/901.json`) && exists(`${askDir}/902.json`) && exists(`${inboundDir}/6.json`) && exists(`${inboundDir}/7.json`)) ok('a fresh closed one, an open one and an unanswered message stay'); else bad('fresh, open and unanswered files stay');

section('send --html and plain send, against the same fake');
resetLog();
r = node([n, 'send', '--html', '--reply-to', '77'], { input: `<b>ответ</b>\n<i>строка</i> ${tok}`, env: liveTg });
code('send --html exits 0', 0, r.code);
const sh1 = calls('sendMessage')[0]?.body ?? {};
if (String(sh1.text).startsWith('<b>ответ</b>\n<i>строка</i>') && sh1.parse_mode === 'HTML') ok('the HTML on stdin goes out as it is'); else bad('the HTML on stdin goes out as it is', JSON.stringify(sh1));
if (sh1.reply_parameters?.message_id === 77) ok('as a reply to that message'); else bad('as a reply to that message', JSON.stringify(sh1.reply_parameters));
if (String(sh1.text).includes(tok.slice(-12)) || !String(sh1.text).includes('[скрыто]')) bad('a bot token in it is blanked', String(sh1.text)); else ok('a bot token in it is blanked');
resetLog();
node([n, 'send', 'a < b & c'], { env: liveTg });
check('plain send escapes what Telegram HTML reads as markup', 'a &lt; b &amp; c', String(calls('sendMessage')[0]?.body.text));

section('file and typing, against the same fake');
resetLog();
const png = `${tmp}/кот.png`, ogg = `${tmp}/voice.ogg`, mp3 = `${tmp}/song.mp3`;
for (const p of [png, ogg, mp3]) writeFileSync(p, 'not really media');
code('file <png> exits 0', 0, node([n, 'file', png, '--caption', `котик ${tok}`, '--reply-to', '55'], { env: liveTg }).code);
const ph = String(calls('sendPhoto')[0]?.body.form ?? '');
if (ph.includes('name="photo"; filename="кот.png"') && ph.includes('котик') && ph.includes('"message_id":55')) ok('a picture goes as a photo with its name, caption and reply'); else bad('a picture goes as a photo with its name, caption and reply', ph.slice(0, 300));
if (ph.includes(tok.slice(-12))) bad('a token in the caption is blanked', ph.slice(0, 300)); else ok('a token in the caption is blanked');
node([n, 'file', ogg], { env: liveTg }); node([n, 'file', mp3, '--as', 'voice'], { env: liveTg });
if (calls('sendVoice').length === 2 && !calls('sendAudio').length) ok('an .ogg, and an .mp3 with --as voice, go as voice notes'); else bad('voice notes', JSON.stringify(tgLog().map((x) => x.method)));
r = node([n, 'file', `${tmp}/nope.png`], { env: liveTg });
if (r.code === 1 && r.err.includes('no such file')) ok('a missing file exits 1 and says so'); else bad('a missing file exits 1 and says so', both(r));
r = node([n, 'file', png, '--as', 'sticker'], { env: liveTg });
if (r.code === 1 && r.err.includes('--as sticker')) ok('an unknown --as is refused'); else bad('an unknown --as is refused', both(r));
resetLog();
code('typing exits 0', 0, node([n, 'typing'], { env: liveTg }).code);
if (calls('sendChatAction')[0]?.body.action === 'typing' && calls('sendChatAction')[0]?.body.chat_id === '42') ok('typing sends the typing action to the bound chat'); else bad('typing', JSON.stringify(tgLog()));

section('finishes are silent, the rest ring');
resetLog();
writeFileSync(conf, confPlain);
node([n, '--arm', 'quiet'], { cwd: tmp });
hook('{"hook_event_name":"Notification","session_id":"s1","notification_type":"permission_prompt","message":"ok?"}', liveTg);
hook('{"hook_event_name":"StopFailure","session_id":"s1","error":"overloaded"}', liveTg);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"done"}', liveTg);
const [mWait, mFail, mDone] = calls('sendMessage').map((c) => c.body);
if (mWait && mFail && mDone) ok('a needs-you, an error and a finish each went out'); else bad('three messages went out', JSON.stringify(calls('sendMessage')));
if (mDone?.disable_notification === true && mDone.text.startsWith('✅ ')) ok('a done message carries disable_notification'); else bad('a done message carries disable_notification', JSON.stringify(mDone));
if (mWait?.disable_notification === undefined && mWait.text.startsWith('⚠️ ')) ok('a wait message does not'); else bad('a wait message does not', JSON.stringify(mWait));
if (mFail?.disable_notification === undefined && mFail.text.startsWith('❌ ')) ok('nor does an error'); else bad('nor does an error', JSON.stringify(mFail));

section('the Bot API override, a 429 and Telegram HTML it cannot parse');
// A server that answers from <portFile>.script (a JSON array of {status, body}, the last repeated) and logs each call.
const scripted = `const http = require("http"), fs = require("fs");
const pf = process.argv[1]; let i = 0;
http.createServer((q, r) => {
  let b = ""; q.on("data", (d) => b += d);
  q.on("end", () => {
    const sc = JSON.parse(fs.readFileSync(pf + ".script", "utf8")), x = sc[Math.min(i++, sc.length - 1)];
    fs.appendFileSync(pf + ".log", JSON.stringify({ method: q.url.split("/").pop(), body: b ? JSON.parse(b) : {} }) + "\\n");
    r.writeHead(x.status, { "content-type": "application/json" }); r.end(JSON.stringify(x.body));
  });
}).listen(0, "127.0.0.1", function () { fs.writeFileSync(pf, String(this.address().port)); });`;
const okBody = { ok: true, result: { message_id: 5 } };
const withScript = (name: string, script: object[]) => {
  writeFileSync(`${tmp}/${name}.script`, JSON.stringify(script));
  const s = server(scripted, `${tmp}/${name}`);
  return { ...s, api: `http://127.0.0.1:${s.port}`, log: () => read(`${tmp}/${name}.log`).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call) };
};
// A 429 asks to wait: one retry after retry_after, then it goes through.
const s429 = withScript('s429', [{ status: 429, body: { ok: false, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } } }, { status: 200, body: okBody }]);
const t0 = Date.now();
r = node([n, 'send', 'hello'], { env: { NOTIFY_DRY_RUN: '', NOTIFY_TELEGRAM_API: s429.api } });
const waited = Date.now() - t0;
s429.srv.kill();
if (r.code === 0 && s429.log().length === 2) ok('a 429 with retry_after is retried and then sent'); else bad('a 429 with retry_after is retried and then sent', `${both(r)} ${s429.log().length} calls`);
if (waited >= 900) ok('after the wait Telegram asked for'); else bad('after the wait Telegram asked for', `${waited} ms`);
// Text Telegram cannot parse as HTML goes once more as plain words, tags gone and entities back.
const sBad = withScript('sbad', [{ status: 400, body: { ok: false, description: "Bad Request: can't parse entities: Unsupported start tag" } }, { status: 200, body: okBody }]);
r = node([n, 'send', 'a < b & c'], { env: { NOTIFY_DRY_RUN: '', NOTIFY_TELEGRAM_API: sBad.api } });
const [first, second] = sBad.log().map((c) => c.body);
sBad.srv.kill();
if (r.code === 0 && first?.parse_mode === 'HTML' && first.text === 'a &lt; b &amp; c') ok('an HTML parse error: the first try is HTML'); else bad('an HTML parse error: the first try is HTML', JSON.stringify(first));
if (second && second.parse_mode === undefined && second.text === 'a < b & c') ok('and the second is plain text, unescaped'); else bad('and the second is plain text, unescaped', JSON.stringify(second));
// Any other 400 is the config's fault: one try.
const s400 = withScript('s400', [{ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }]);
r = node([n, 'send', 'x'], { env: { NOTIFY_DRY_RUN: '', NOTIFY_TELEGRAM_API: s400.api } });
s400.srv.kill();
if (r.code === 1 && s400.log().length === 1) ok('another 400 is not retried'); else bad('another 400 is not retried', `${both(r)} ${s400.log().length} calls`);
// The override is for a local server only: a repository's env must not send the bot token elsewhere. The request is caught by
// a fetch stand-in preloaded into node, so none leaves the machine whichever way the check goes.
const spy = `${tmp}/spy.cjs`, spyLog = `${tmp}/spy.log`;
writeFileSync(spy, `globalThis.fetch = async (url) => { require("fs").appendFileSync(${JSON.stringify(spyLog)}, String(url) + "\\n"); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }); };`);
const via = (apiUrl: string) => { rmSync(spyLog, { force: true }); node(['-r', spy, n, 'send', 'x'], { env: { NOTIFY_DRY_RUN: '', NOTIFY_TELEGRAM_API: apiUrl } }); return read(spyLog).trim(); };
for (const bad1 of ['https://evil.example', 'http://evil.example:8080', 'http://127.0.0.1.evil.example', 'http://localhost.evil.example', 'http://user@evil.example', 'http://10.0.0.5:1234', 'ftp://127.0.0.1']) {
  const url = via(bad1);
  if (url.startsWith(`https://api.telegram.org/bot${tok}/`)) ok(`the override ${bad1} is ignored`); else bad(`the override ${bad1} is ignored`, url);
}
for (const good of ['http://127.0.0.1:9', 'http://localhost:9']) {
  const url = via(good);
  if (url.startsWith(`${good}/bot${tok}/`)) ok(`the override ${good} is honoured`); else bad(`the override ${good} is honoured`, url);
}
tg.srv.kill();

// The in-engine start hook (hooks/modes.ts) on the temporary config dir and the plugin root: the context a SessionStart adds.
async function modesContext(root: string, cfgDir: string): Promise<string[]> {
    const { register } = await import(pathToFileURL(`${root}/hooks/modes.ts`).href);
    const handlers: ((...a: unknown[]) => Promise<{ additionalContext?: string[] }>)[] = [];
    register((ev: string, matcher: { source?: string }, fn: never) => { if (ev === 'classic.SessionStart' && matcher.source === 'startup') handlers.push(fn); }, {});
    const $ = {
        env: { get: async (n: string) => (n === 'CLAUDE_CONFIG_DIR' ? cfgDir : undefined) },
        fs: { exists: async (p: string) => existsSync(p), read: async (p: string) => readFileSync(p, 'utf8') },
        plugin: { root: resolve(root) },
    };
    return (await handlers[0]!($, { source: 'startup' }, async () => ({}))).additionalContext ?? [];
}
section('unslop');
const unslop = `${here}/unslop.mjs`;
out = node([unslop, '--status']).out; check('off by default', 'unslop: off', out);
out = (await modesContext(`${here}/..`, tmp)).join('\n'); if (out === '') ok('and the in-engine SessionStart hook injects nothing'); else bad('and the in-engine SessionStart hook injects nothing', out);
out = node([unslop, '--enable']).out; check('enable prints the rules for this session', 'UNSLOP MODE ON', out);
if (exists(`${tmp}/makarasty/unslop.on`)) ok('in the config dir the hook reads'); else bad('in the config dir the hook reads');
out = (await modesContext(`${here}/..`, tmp)).join('\n'); check('the in-engine hook injects the same rules, the exact text of unslop.txt', 'UNSLOP MODE ON', out); if (out.trim() === read(`${here}/unslop.txt`).trim()) ok('and nothing else'); else bad('and nothing else', out);
node([unslop, '--disable']);
out = (await modesContext(`${here}/..`, tmp)).join('\n'); if (out === '') ok('disable stops it'); else bad('disable stops it', out);
r = node([unslop, '--help']);
code('an unknown argument exits 1', 1, r.code);
check('with usage on stderr', 'usage: node unslop.mjs', r.err);
if (exists(`${tmp}/makarasty/unslop.on`)) bad('and leaves the switch alone'); else ok('and leaves the switch alone');
const ruleLines = read(`${here}/unslop.txt`).split('\n').length - 1;
if (ruleLines <= 30) ok('the injected rules stay within 30 lines'); else bad('the injected rules stay within 30 lines', `${ruleLines} lines`);

section('context reminder');
const ctxCmd = cmdOf('UserPromptSubmit', 'context.mjs');
const tr = `${tmp}/t.jsonl`;
const turn = (side: boolean, input: number, cached: number) => appendFileSync(tr, `{"type":"assistant","isSidechain":${side},"message":{"usage":{"input_tokens":${input},"cache_read_input_tokens":${cached},"cache_creation_input_tokens":0}}}\n`);
// MAKARASTY_HANDOFF_AT: the caller's, else this process's, else 400000 (the sh ${MAKARASTY_HANDOFF_AT-400000}).
const ctx = (prompt = 'go on', at?: string) => sh(ctxCmd, {
  input: `{"session_id":"c1","transcript_path":"${tr}","prompt":"${prompt}"}`,
  env: { MAKARASTY_HANDOFF_AT: at ?? process.env.MAKARASTY_HANDOFF_AT ?? '400000' },
}).out;
const pad = (bytes: number) => appendFileSync(tr, `{"type":"user","pad":"${'x'.repeat(bytes)}"}\n`);
const c0 = () => sh(ctxCmd, { input: `{"session_id":"c0","transcript_path":"${tr}","prompt":"go on"}`, env: { MAKARASTY_HANDOFF_AT: undefined } }).out;
turn(false, 10, 660000);
out = c0();
if (out === '') ok('by default silent at 660k'); else bad('by default silent at 660k', out);
turn(false, 10, 710000);
out = c0();
check('and first fires at 700k', 'context is at 710k', out);
writeFileSync(tr, '');
turn(false, 10, 100000);
out = ctx(); if (out === '') ok('silent under the threshold'); else bad('silent under the threshold', out);
turn(false, 10, 420000); turn(true, 10, 900000);
out = ctx(); check('fires past it, reading the main chain only', 'context is at 420k', out);
out = ctx(); if (out === '') ok('once per level'); else bad('once per level', out);
turn(false, 10, 520000);
out = ctx(); if (out === '') ok('silent inside the same step'); else bad('silent inside the same step', out);
turn(false, 10, 560000);
out = ctx(); check('again one step higher', '560k', out);
turn(false, 10, 90000);
ctx(); turn(false, 10, 410000);
out = ctx(); check('a compact re-arms it', '410k', out);
appendFileSync(tr, '{"type":"system","subtype":"compact_boundary","compactMetadata":{"preTokens":720000,"postTokens":15000}}\n');
out = ctx(); if (out === '' && !exists(`${tmp}/makarasty/context/c1`)) ok('a compact boundary after the last turn reads as the compacted size'); else bad('compact boundary read', out);
turn(false, 10, 720000);
out = ctx('go on', '0'); if (out === '') ok('0 turns it off'); else bad('0 turns it off', out);
const fsess = `${tmp}/makarasty/fleet-sessions`, frun = `${tmp}/frun`;
mkdirSync(fsess, { recursive: true }); mkdirSync(frun, { recursive: true }); writeFileSync(`${fsess}/c1`, `${frun}\n`);
out = ctx(); if (out === '') ok('silent in a session fleet.sh recorded as a fleet chat'); else bad('silent in a session fleet.sh recorded as a fleet chat', out);
writeFileSync(`${frun}/FINISHED`, ''); rmSync(`${tmp}/makarasty/context/c1`, { force: true });
out = ctx(); check('but not once that run has FINISHED', 'context is at 720k', out);
if (!exists(`${fsess}/c1`)) ok('and the stale record is deleted'); else bad('and the stale record is deleted');
writeFileSync(`${fsess}/c1`, '/no/such/run\n'); rmSync(`${tmp}/makarasty/context/c1`, { force: true });
out = ctx(); check('nor when its run directory is gone', 'context is at 720k', out);
writeFileSync(`${fsess}/c1`, `${frun}\n`); rmSync(`${frun}/FINISHED`, { force: true }); rmSync(`${tmp}/makarasty/context/c1`, { force: true });
ago(`${fsess}/c1`, 3 * 86400);
out = ctx(); check('nor when its record was not rewritten for two days', 'context is at 720k', out);
rmSync(`${tmp}/makarasty/context/c1`, { force: true });
out = ctx('/makarasty-tools:handoff') + ctx('сделай хенд-офф') + ctx('хенд-офф');
if (out === '') ok('silent when the prompt asks for the handoff'); else bad('silent when the prompt asks for the handoff', out);
out = ctx('fix the handoff reminder text in context.mjs'); check('a prompt that only mentions it still fires, the level unused', '720k', out);
turn(false, 10, 870000); pad(2200000);
out = ctx(); check('a reading behind a 2 MB line is still found', '870k', out);
turn(false, 10, 90000); pad(17000000);
out = ctx(); if (out === '' && exists(`${tmp}/makarasty/context/c1`)) ok('no reading in the last 16 MB keeps the marker'); else bad('no reading in the last 16 MB keeps the marker', out);
r = sh(ctxCmd, { input: 'not json' }); out = `${r.out}\nexit ${r.code}`; check('bad input exits 0', 'exit 0', out);
const compactCmd = cmdOf('SessionStart', 'context.mjs');
out = sh(compactCmd, { input: '{"hook_event_name":"SessionStart","source":"compact","session_id":"c1","transcript_path":"/x/t.jsonl"}' }).out;
check('after a compact it names the full transcript', 'still on disk, one JSON object per line: /x/t.jsonl', out);
out = node([`${here}/context.mjs`], { input: '{"hook_event_name":"SessionStart","source":"resume","session_id":"c1","transcript_path":"/x/t.jsonl"}' }).out;
if (out === '') ok('and says nothing on a plain resume'); else bad('and says nothing on a plain resume', out);

section('language: no profile says it in English, Language: Russian in Russian');
rmSync(profile, { force: true });
writeFileSync(conf, confExcerpt);
node([n, '--arm', 'lang']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Ship it?"}');
check('with no profile a finish with a question is English', '· done, with a question for you', last());
if (/готово|вопрос/.test(last())) bad('and has no Russian in it', last()); else ok('and has no Russian in it');
node([n, '--arm', 'lang']);
hook('{"hook_event_name":"StopFailure","session_id":"s1","error":"overloaded"}');
check('an error is English too', 'failed on an error: overloaded. Open the chat to continue.', last());
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"ok"}');
r = node([n, '--test']);
check('--test is English', 'check from', read(sink));
writeFileSync(conf, '{}');
check('the setup hint is English', 'ask any chat "set up notifications"', both(node([n, '--status'])));
writeFileSync(conf, confExcerpt);
writeFileSync(profile, 'Язык: русский');
node([n, '--arm', 'lang']);
hook('{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"ok"}');
check('a profile that says Язык: русский gets Russian', '· готово', last());
check('and the setup hint keeps the phrase to type', '"настрой уведомления"', (writeFileSync(conf, '{}'), both(node([n, '--status']))));
rmSync(profile, { force: true });

console.log('');
rmSync(tmp, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
