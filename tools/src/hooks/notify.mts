#!/usr/bin/env node
// notify.mjs - Telegram messages from Claude Code chats: one when a chat the person walked away from ends its turn,
// and the inbox's questions with buttons that answer them from the phone.
//
// A chat cannot tell whether a person is watching it, and a Stop hook fires at the end of every turn
// either way. So the person arms it: `--arm` writes a marker for one session, the hook sends exactly one
// message the next time that session ends a turn, and the marker goes. A session nobody armed sends
// nothing, ever.
//
//   node notify.mjs                        hook mode: the event on stdin; never blocks, never exits non-zero
//   node notify.mjs setup                  connects the person's own Telegram bot. Needs no typing: it opens BotFather,
//                                          puts the bot's username on the clipboard, picks the token up from the
//                                          clipboard once the person taps it in Telegram (a line pasted on stdin works
//                                          too), opens the new bot, and binds the chat that presses Start with a one-time
//                                          code. A chat may run it in the background: the token never reaches its output.
//   node notify.mjs --arm [--next] [--session <id>] [label]
//                                          arm this session (CLAUDE_CODE_SESSION_ID) or another one.
//                                          --next: fire at the end of the NEXT turn, not the one arming it
//   node notify.mjs --disarm [--session <id>]
//   node notify.mjs --status               armed or not, and whether Telegram is connected
//   node notify.mjs --test                 send a test line
//   node notify.mjs send <text>            send one message now, plain words (fleet.sh landed uses this)
//   node notify.mjs send --html [--reply-to <message id>]   HTML on stdin (the headless inbox's answer)
//   node notify.mjs file <path> [--as photo|video|voice|audio|animation|document] [--caption <text>] [--reply-to <id>]
//   node notify.mjs screenshot [--caption <text>]   the whole desktop as a photo (Windows)
//   node notify.mjs typing [action]        the "typing..." line for about 5 s (sendChatAction)
//   node notify.mjs ask                    stdin {item, html, short, options?, reply?, keyboard?} from the inbox (core.mjs
//                                          phoneAsk): sends it and keeps the ask in telegram/asks/<message id>.json.
//                                          The taps, replies and the person's own messages are read by the hook engine
//                                          (tools/hooks/telegram.ts), not here: an idle poll there starts no process.
//
// The channel lives in ~/.claude/makarasty/notify.json (CLAUDE_CONFIG_DIR honoured), outside every repository:
//   { "telegram": { "token": "123456:ABC...", "chat_id": "42" }, "excerpt": true }
// A token that does not look like a bot token is left out with a line that names the key and never the value: the
// value is a secret, and the line can land in a chat. For the same reason every error text has its URLs and bot
// tokens blanked before it is printed or stored. Only the bound chat_id is ever answered: a tap or a reply from
// anyone else who finds the bot does nothing.
//
// Every message is Telegram HTML: fields are escaped, a finish rings silently, a question, needs-you and error ring.
// What leaves the machine: the status line ("<project> · <label> · готово · 12 мин"), and for an inbox ask the
// question and its options (the explanation only when he taps "Подробнее"). Not the chat's transcript. The excerpt - the last 500 characters of the chat's final
// message - can carry code, data or secrets the chat printed, so it is opt-in: MAKARASTY_NOTIFY_EXCERPT=1 in the
// environment, or "excerpt": true in notify.json ("excerpt": false wins over the variable). When on, the
// message first passes through redactExcerpt(), which blanks: URLs; Telegram bot tokens; Discord webhooks;
// sk-/sk-ant-, sk_live_/sk_test_, gh*_ and github_pat_ keys; AKIA/ASIA ids; xox* tokens; AIza keys; JWTs
// (eyJ...eyJ); ntfy topics; PRIVATE KEY blocks; and the value after api_key / secret / token / password
// followed by : or =, when the value is quoted or is 8+ characters with no space and a digit (prose such as
// "the token: refresh now rotates" is left alone). Anything else a chat printed still goes out.
//
// What the hook does with an armed session:
//   Stop          send "<project>: <label> finished" plus the end of the last message, then disarm.
//                 A last message that ends in a question says "finished, with a question for you", and
//                 the excerpt under it ends with that question. It still disarms: an earlier version kept
//                 the marker for "the real finish", and a reply like "All done. Anything else?" then kept
//                 it for good with no finish ever sent. One message per arming, always.
//                 Not a finish, so the marker stays:
//                   - background_tasks or session_crons in the event are not empty: the chat started a
//                     background job or a loop that will wake it, and that later turn is the finish. One
//                     "paused" message goes out the first time, so a job that never ends (a dev server)
//                     does not leave the person waiting on silence. A later Stop whose jobs were all
//                     there at the pause is the finish: nothing new is left to wake the chat;
//                   - another plugin's Stop hook blocked this Stop (see blockedBy below): nothing is sent.
//   StopFailure   the turn died on an API error: say so, keep the marker for the resumed chat. One per
//                 five minutes, like Notification, so a chat failing in a retry loop does not spam.
//   Notification  permission_prompt and the other "needs a person" kinds: one ping per five minutes,
//                 marker kept, because the work is not done.
//   Finished, error and needs-you texts say how long the work has run ("finished after 12 min"; under a
//                 minute, nothing), and start with a mark a lock screen shows at a glance: ✅, ⚠️, ❌.
//   A --next marker ignores Stop, StopFailure and Notification until the next prompt makes it live.
//   SessionStart  source resume only. A message that was written but never delivered is sent now, and
//                 a chat reopened before it finished is told, in context, to check whether the work is
//                 already complete before it does anything else. Not for a --next marker: that chat has
//                 not started the work yet.
//   UserPromptSubmit   turns a --next marker into a live one, on a prompt a person sent. A task
//                 notification, a /loop or cron wakeup (source system, loop_wakeup, schedule_wakeup,
//                 poll_event) is the chat working on, not the turn the person asked about. "sdk" counts as
//                 a person: the desktop app drives the chat through the SDK, so typed prompts arrive as sdk.
//   SessionEnd    reason clear only: the person typed /clear, so they are at the screen and the old
//                 conversation will not finish on its own; its marker goes. Every other end keeps it. An
//                 armed chat that is closed (or whose app crashed) still owes its finish on resume, and an
//                 undelivered finish still goes out at the next resume or when setup saves the channel.
//
// Cost: the function hook in gates.ts only starts node when this session has a marker, so a session nobody armed
// never pays a node start. A marker is removed on delivery; one older than seven days is pruned by every hook run
// and every --arm.
//
// A marker is written to a temp file and renamed into place, and after a send the hook re-reads it and
// touches it only if it is still the same arming: a re-arm or disarm made while a slow send was running
// is newer, and wins.
//
// A finish that could not be delivered - no channel yet, network down - stays on disk as the marker, and
// goes out at the next chance: the chat reopening, or setup saving the channel.
//
// Network: a transient failure (network, 5xx, 429) is retried while the hook's time budget lasts - 15 s,
// under the 20 s hook timeout, and 4 s at SessionStart, which the chat waits on.
//
// Test seams: NOTIFY_DRY_RUN=<file> appends what would be sent to that file instead of sending; NOTIFY_TELEGRAM_API
// replaces https://api.telegram.org for a 127.0.0.1/localhost URL only; NOTIFY_CLIPBOARD=<file> is read as the clipboard;
// NOTIFY_NO_OPEN=1 opens no Telegram link.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, readdirSync, statSync, renameSync, openSync, readSync, fstatSync, closeSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

interface Config {
  telegram?: { token: string; chat_id?: string };
  excerpt?: boolean;
}
// notify.json as a hand may have written it: every value can be any JSON.
interface RawConfig {
  telegram?: { token?: unknown; chat_id?: unknown };
  excerpt?: unknown;
}
interface Failure { name: string; error: string }
// unconfirmed: a send whose outcome is unknown (a 5xx, a timeout, a broken connection): it may have arrived, so nothing
// sends it again. Neither sent nor failed.
interface Result { sent: string[]; failed: Failure[]; message_id?: number; unconfirmed?: string[] }
interface Marker {
  armed: string;
  label: string;
  cwd?: string;
  pending?: boolean;
  paused?: string;
  pausedJobs?: string[];
  resumed?: string;
  text?: string;
  excerpt?: string;
  done?: string;
  unsent?: Failure[];
  failed?: string;
  waited?: string;
  started?: string;
}
interface HookEvent {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
  source?: string;
  background_tasks?: { id?: unknown }[];
  session_crons?: { id?: unknown }[];
  transcript_path?: string;
  last_assistant_message?: string;
  error?: string;
  notification_type?: string;
  message?: string;
  seconds_since_last_response?: number;
  reason?: string;
}
interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number };
  text?: string;
  reply_to_message?: { message_id: number };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: { id: number }; data?: string; message?: TgMessage };
}
// One open inbox ask on the phone, by its Telegram message id.
interface Ask { item: string; text: string; options: string[]; reply: boolean; at: string }

const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const dir = join(home, 'makarasty');
// Every word the person sees comes from skills/notify/strings.mjs, in the language of his profile (profile.md, its
// Language: line). Imported at run time by path, so tsc here needs no declaration for it; if the file is missing the
// keys themselves show, which is a visible defect rather than a lost message.
type Tr = (key: string, vars?: Record<string, string | number>) => string;
let tr: Tr = (key) => key;
async function loadStrings() {
  try {
    const m = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'notify', 'strings.mjs')).href) as { langOf: (profile: string) => string; t: (lang: string, key: string, vars?: Record<string, string | number>) => string };
    let profile = ''; try { profile = readFileSync(join(dir, 'profile.md'), 'utf8'); } catch { /* no profile: English */ }
    const lang = m.langOf(profile);
    tr = (key, vars) => m.t(lang, key, vars);
  } catch { /* strings.mjs missing */ }
}
const configFile = join(dir, 'notify.json');
const markerDir = join(dir, 'notify');
const markerFile = (session: string) => join(markerDir, `${session}.json`);
const validSession = (s: unknown): s is string => typeof s === 'string' && /^[\w-]+$/.test(s); // a path would reach the config file
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The test seam is honoured only for a local server: a repository's env must not send the token elsewhere.
const API = () => { const u = process.env.NOTIFY_TELEGRAM_API; return u && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u) ? u.replace(/\/+$/, '') : 'https://api.telegram.org'; };
// Telegram's HTML mode: only &, < and > are special. Fields are cut as plain text before this, never after.
const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Windows refuses a rename over a file another process has open, or one an antivirus is scanning, with
// EPERM, EBUSY or EACCES, and a read in that instant fails the same way. Both are momentary: wait 20 ms and
// try again. A missing file is not one of them and still reads as null, "not armed".
const busy = (e: unknown) => ['EPERM', 'EBUSY', 'EACCES'].includes((e as { code: string })?.code);
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readJSON = <T,>(file: string): T | null => {
  for (let i = 0; ; i++) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (!busy(e) || i >= 1) return null; pause(20); }
  }
};
// Temp file and rename: a reader never sees half a file, and a *.json listing never sees the temp.
// A rename still refused after five tries falls back to writing the file in place: a marker that might be
// read half-written for a moment beats a throw that loses the finish.
const writeJSON = (file: string, o: unknown) => {
  mkdirSync(join(file, '..'), { recursive: true });
  const body = JSON.stringify(o, null, 2) + '\n';
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  for (let i = 0; i < 5; i++) {
    try { renameSync(tmp, file); return; } catch (e) { if (!busy(e)) throw e; pause(20); }
  }
  writeFileSync(file, body, { mode: 0o600 });
  rmSync(tmp, { force: true });
};

// Error text can carry the request URL (fetch's "Failed to parse URL from <url>") and so a bot token. It is printed
// where a chat reads it and stored in the marker, so it passes here.
// `[^\s<]`, not `\S`: in an HTML message a match must stop at the next tag.
const redact = (s: unknown) => String(s).replace(/https?:\/\/[^\s<]+/gi, '<url>').replace(/\b\d{5,}:[\w-]{20,}/g, '<token>');
// The excerpt is free text: redact() plus the token shapes of the commit skill's secret scan and `key: value` pairs.
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/gi,
  /(?<![A-Za-z0-9])sk-(?:ant-)?[\w-]{20,}/g,
  /sk_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[\w]{22,}/g,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /AIza[\w-]{35}/g,
  /eyJ[\w-]{10,}\.eyJ[\w.-]*/g,
  /ntfy\.sh\/[\w-]{8,}/gi,
];
const redactExcerpt = (s: string) => SECRET_SHAPES.reduce((t, re) => t.replace(re, '<redacted>'), redact(s))
  .replace(/(api[_-]?key|secret|token|password)([ \t]*[:=][ \t]*)("[^"\n]+"|'[^'\n]+'|[^\s<]+)/gi,
    (all, k: string, sep: string, v: string) => (/^["']/.test(v) || (v.length >= 8 && /\d/.test(v)) ? `${k}${sep}<redacted>` : all));

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const TOKEN = /^\d+:[\w-]{20,}$/;
function normalise(o: RawConfig, warn = (m: string) => console.error(`notify: ${m}`)): Config {
  const c: Config = {};
  const t = o.telegram?.token;
  if (t !== undefined && t !== null && typeof t !== 'string') warn('the telegram token is not a string, so it is left out');
  const token = str(t), chat = o.telegram?.chat_id;
  if (token && !TOKEN.test(token)) warn('the telegram token does not look like a bot token (digits:letters), so it is left out');
  else if (token) c.telegram = { token, ...(typeof chat === 'number' || str(chat) ? { chat_id: String(chat).trim() } : {}) };
  if (typeof o.excerpt === 'boolean') c.excerpt = o.excerpt;
  return c;
}
const config = () => normalise(readJSON<RawConfig>(configFile) || {});
// Connected means a token and the chat bound at setup. A token alone answers nobody: whoever wrote to the bot last
// could be a stranger who found it.
const connected = (cfg: Config) => !!cfg.telegram?.chat_id;
const withExcerpt = (cfg: Config) => cfg.excerpt ?? process.env.MAKARASTY_NOTIFY_EXCERPT === '1';
const setupHint = () => tr('setupHint');
// Where the phone's open asks live; the hook engine (tools/hooks/telegram.ts) reads them and the taps.
const tgDir = join(dir, 'telegram');

// Every request shares one deadline, so retries can never outlast the hook's own timeout.
let deadline = Infinity;
const left = () => deadline - Date.now();

// Errors raised before a request was made: no route, no connection, no trusted certificate.
const NEVER_SENT = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT)$/;
const neverSent = (e: unknown) => NEVER_SENT.test((e as { cause?: { code?: string } }).cause?.code ?? '');
// After an outcome that may be a delivery (a 5xx, a timeout, a broken socket) a send is not repeated in this run; a getMe
// probe only decides what becomes of it. An answer: Telegram is reachable, so it may have arrived (unconfirmed, dropped).
// No answer, or no time left to ask: it failed, and the finish stays on disk for a later run.
async function settle(e: Error, url: string): Promise<Error> {
  const ms = Math.min(3000, left());
  if (ms < 500) return e;
  try { await fetch(url.replace(/[^/]+$/, 'getMe'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(ms) }); }
  catch { return e; }
  return Object.assign(e, { unconfirmed: true });
}
// The result of a send that failed: unconfirmed when it may have arrived, else failed.
const lost = (e: unknown, name: string): Result => {
  const error = redact((e as Error)?.message || e);
  return (e as { unconfirmed?: boolean }).unconfirmed ? { sent: [], failed: [], unconfirmed: [error] } : { sent: [], failed: [{ name, error }] };
};

// A transient failure (network, 5xx, 429) is retried up to twice; any other 4xx is the config's fault. A send (once) is
// retried only when it surely did not arrive (a 429, a connection never made): a second try after anything else would be a
// second message (owner, 2026-11-18).
async function post(url: string, body: string, headers: Record<string, string>, ms0 = 6000, once = false): Promise<Response> {
  for (let i = 0; ; i++) {
    const ms = Math.min(ms0, left());
    try {
      if (ms < 500) throw Object.assign(new Error('out of time'), { final: true });
      const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(ms) });
      if (r.ok) return r;
      const text = (await r.text()).slice(0, 300);
      let why = text, wait = 1; try { const o = JSON.parse(text); why = o.description || text; wait = Math.min(10, Number(o.parameters?.retry_after) || 1); } catch { /* not JSON */ }
      throw Object.assign(new Error(`${r.status} ${why}`), { final: r.status < 500 && r.status !== 429, wait, status: r.status });
    } catch (e) {
      const x = e as { final?: boolean; status?: number };
      if (!x.final && once && x.status !== 429 && !neverSent(e)) throw Object.assign(await settle(e as Error, url), { final: true });
      if (x.final || i >= 2 || left() < 1500) throw e;
      await sleep(((e as { wait?: number }).wait ?? 1) * 1000);
    }
  }
}

async function telegram<T = unknown>(token: string, method: string, body?: object, ms = 6000): Promise<T> {
  const once = /^send(?!ChatAction)/.test(method); // a chat action repeats harmlessly
  const r = await post(`${API()}/bot${token}/${method}`, JSON.stringify(body || {}), { 'content-type': 'application/json' }, ms, once);
  const o = await r.json().catch((e: Error) => { throw once ? Object.assign(e, { unconfirmed: true }) : e; }) as { ok: boolean; description?: string; result: T };
  if (!o.ok) throw new Error(o.description || `${r.status}`);
  return o.result;
}

// ✅ ⚠️ ❌: what kind of message it is, before a word of it is read on a lock screen.
type Kind = 'done' | 'wait' | 'fail';
const MARK: Record<Kind, string> = { done: '✅ ', wait: '⚠️ ', fail: '❌ ' };

// One message to the bound chat, `html` already escaped. A finish is silent (owner, 2026-11-17: only what needs him
// rings); a question, a needs-you and an error ring. The excerpt folds into an expandable quote. extra goes into
// sendMessage as is (an ask's buttons, a reply).
async function sendWith(cfg: Config, html: string, excerpt = '', kind?: Kind, extra: object = {}): Promise<Result> {
  const body = (kind ? MARK[kind] : '') + html + (excerpt && withExcerpt(cfg) ? `\n<blockquote expandable>${esc(cut(excerpt, 3000))}</blockquote>` : '');
  extra = { ...(kind === 'done' ? { disable_notification: true } : {}), ...extra };
  const dry = process.env.NOTIFY_DRY_RUN;
  if (dry) {
    try { appendFileSync(dry, body.replace(/\n/g, ' | ') + '\n'); return { sent: ['dry-run'], failed: [], message_id: 0 }; }
    catch (e) { return { sent: [], failed: [{ name: 'dry-run', error: (e as Error).message }] }; }
  }
  if (!connected(cfg)) return { sent: [], failed: [{ name: 'config', error: `${setupHint()} (${configFile})` }] };
  if (typeof fetch !== 'function') return { sent: [], failed: [{ name: 'node', error: 'node 18 or newer is needed' }] };
  try {
    const msg = { chat_id: cfg.telegram!.chat_id, text: body, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra };
    let m: { message_id: number };
    try { m = await telegram<{ message_id: number }>(cfg.telegram!.token, 'sendMessage', msg); }
    catch (e) {
      // HTML Telegram cannot parse (a cut in the wrong place, a stray tag): the same words once as plain text.
      if (!/parse entities/i.test((e as Error).message)) throw e;
      m = await telegram<{ message_id: number }>(cfg.telegram!.token, 'sendMessage', { ...msg, parse_mode: undefined, text: body.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') });
    }
    return { sent: ['telegram'], failed: [], message_id: m.message_id };
  } catch (e) {
    return lost(e, 'telegram');
  }
}
const send = (html: string, excerpt?: string, kind?: Kind) => sendWith(config(), html, excerpt, kind);

// A file to the bound chat, the method picked by extension unless `as` names one. Telegram takes a voice note as OGG/Opus,
// MP3 or M4A, a photo up to 10 MB (larger goes as a document), any file up to 50 MB.
const AS: Record<string, string> = { png: 'photo', jpg: 'photo', jpeg: 'photo', webp: 'photo', mp4: 'video', mov: 'video', webm: 'video', gif: 'animation', ogg: 'voice', oga: 'voice', opus: 'voice', mp3: 'audio', m4a: 'audio', wav: 'audio', flac: 'audio' };
const METHOD: Record<string, string> = { photo: 'sendPhoto', video: 'sendVideo', animation: 'sendAnimation', voice: 'sendVoice', audio: 'sendAudio', document: 'sendDocument' };
async function sendFile(cfg: Config, path: string, as0: string | null, caption: string, replyTo: number): Promise<Result> {
  const failed = (error: string): Result => ({ sent: [], failed: [{ name: 'file', error }] });
  if (as0 && !METHOD[as0]) return failed(`--as ${as0}: one of ${Object.keys(METHOD).join(', ')}`);
  let size = 0; try { size = statSync(path).size; } catch { return failed(`no such file: ${path}`); }
  if (size > 50 * 1048576) return failed(`${Math.round(size / 1048576)} MB: a bot sends 50 MB at most`);
  let as = as0 ?? AS[(/\.(\w+)$/.exec(path)?.[1] ?? '').toLowerCase()] ?? 'document';
  if (as === 'photo' && size > 10 * 1048576) as = 'document';
  const capt = cut(redactExcerpt(caption).replace(/<(redacted|url|token)>/g, tr('hidden')), 1000);
  const dry = process.env.NOTIFY_DRY_RUN;
  if (dry) {
    try { appendFileSync(dry, `[${as}] ${basename(path)}${capt ? ` | ${capt.replace(/\n/g, ' | ')}` : ''}\n`); return { sent: ['dry-run'], failed: [] }; }
    catch (e) { return { sent: [], failed: [{ name: 'dry-run', error: (e as Error).message }] }; }
  }
  if (!connected(cfg)) return { sent: [], failed: [{ name: 'config', error: `${setupHint()} (${configFile})` }] };
  const once = async (kind: string) => {
    const form = new FormData();
    form.set('chat_id', cfg.telegram!.chat_id);
    form.set(kind, new Blob([readFileSync(path)]), basename(path));
    if (capt) form.set('caption', capt);
    if (replyTo) form.set('reply_parameters', JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
    const sendUrl = `${API()}/bot${cfg.telegram!.token}/${METHOD[kind]}`;
    let r: Response;
    try { r = await fetch(sendUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(180000) }); }
    catch (e) { throw neverSent(e) ? e : await settle(e as Error, sendUrl); }
    const o = await r.json().catch(() => null) as { ok: boolean; description?: string; result?: { message_id: number } } | null;
    if (!o?.ok) { const err = new Error(o?.description || `${r.status}`); throw r.ok || r.status >= 500 ? await settle(err, sendUrl) : err; }
    return o.result!.message_id;
  };
  try {
    let id: number;
    // A photo Telegram refuses (too wide, too tall, odd format) still arrives, as a file.
    try { id = await once(as); } catch (e) { if (as !== 'photo' || !/PHOTO|IMAGE|dimension/i.test((e as Error).message)) throw e; id = await once('document'); }
    return { sent: ['telegram'], failed: [], message_id: id };
  } catch (e) {
    return lost(e, 'telegram');
  }
}

// The whole desktop (every monitor), DPI-aware so a scaled screen is not cropped, as a PNG in the temp folder.
function screenshot(): string {
  const out = join(process.env.TEMP || process.env.TMP || homedir(), `screen-${Date.now()}.png`);
  const ps = [
    "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();' -Name U -Namespace W",
    '[void][W.U]::SetProcessDPIAware()',
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$i = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($i)',
    '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $i.Size)',
    `$i.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 30000, windowsHide: true });
  return out;
}

// Finishes that were written but never delivered, sent now. Setup saving the channel and a reopened
// chat both call this. A marker whose send is still running (done written, no unsent yet) is another
// hook's job: it is skipped for a minute, after which its hook is past its 20 s timeout and dead. own is
// the reopened chat's own marker, which no other hook can be sending. Two chats reopened at once both flush:
// each marker is claimed by a rename first, so only one of them sends it (8 of 8 runs sent everything twice
// before). A claim left by a killed hook goes back after a minute; the claim time is in its name, since a
// rename keeps the marker's old mtime.
async function flushUnsent(cfg: Config, own?: string) {
  let all: string[] = []; try { all = readdirSync(markerDir); } catch { return 0; }
  for (const f of all) {
    const c = /^(.*\.json)\.flushing-(\d+)$/.exec(f);
    if (!c || Date.now() - Number(c[2]) < 60e3) continue;
    try { if (!existsSync(join(markerDir, c[1]!))) renameSync(join(markerDir, f), join(markerDir, c[1]!)); else rmSync(join(markerDir, f), { force: true }); } catch { /* taken meanwhile */ }
  }
  const putBack = (claim: string, file: string) => { try { if (!existsSync(file)) renameSync(claim, file); else rmSync(claim, { force: true }); } catch { /* gone meanwhile */ } };
  let files: string[] = []; try { files = readdirSync(markerDir).filter((f) => f.endsWith('.json')); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    const file = join(markerDir, f);
    const m = readJSON<Marker>(file);
    if (!m?.done) continue;
    if (file !== own && !m.unsent && Date.now() - Date.parse(m.done) < 60e3) continue;
    const claim = `${file}.flushing-${Date.now()}`;
    try { renameSync(file, claim); } catch { continue; } // another chat claimed it
    if (readJSON<Marker>(claim)?.armed !== m.armed) { putBack(claim, file); continue; } // re-armed meanwhile
    const r = await sendWith(cfg, `${m.text}\n<i>${esc(tr('late', { time: m.done.slice(11, 16) }))}</i>`, m.excerpt, 'done');
    if (r.sent.length) { n++; rmSync(claim, { force: true }); }
    else if (r.unconfirmed) { rmSync(claim, { force: true }); report(r, true); } // may have arrived: never sent twice
    else putBack(claim, file); // a newer arming that took the name wins; this finish then stays undelivered
  }
  return n;
}

// The marker as it is on disk now, if it is still the arming this process read. A send can take seconds,
// and a re-arm or a disarm made meanwhile is newer than what this process holds, so it must win.
const still = (file: string, m: Marker) => { const cur = readJSON<Marker>(file); return cur && cur.armed === m.armed ? cur : null; };
// " after 12 min" since the work began: the resume of a reopened chat (the closed time is not work), else the
// prompt that made a --next marker live, else the arming. Under a minute it says nothing.
function elapsed(m: Marker) {
  const min = Math.round((Date.now() - Date.parse(m.resumed || m.started || m.armed)) / 60e3);
  return min < 1 ? '' : ` · ${min >= 60 ? tr('elapsedHM', { h: Math.floor(min / 60), m: min % 60 }) : tr('elapsedM', { m: min })}`;
}
const recent = (ts: string | undefined) => !!ts && Date.now() - Date.parse(ts) < 5 * 60 * 1000;

// A marker older than seven days belongs to a chat that died unreopened. Left alone it keeps the guard in gates.ts
// open, and node starting, on every hook of that session.
function prune() {
  let files: string[] = []; try { files = readdirSync(markerDir); } catch { return; }
  for (const f of files) {
    const p = join(markerDir, f);
    try { if (Date.now() - statSync(p).mtimeMs > 7 * 86400e3) rmSync(p, { force: true }); } catch { /* gone meanwhile */ }
  }
}

// The END of the message: that is where a reply puts its verdict.
const tail = (s: string, n = 500) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? '...' + t.slice(-n) : t; };
const textOf = (c: unknown): string => (Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : typeof c === 'string' ? c : '');
// Only the last 8 MB: both readers walk back from the end, and a whole 600 MB transcript does not fit a
// string (ERR_STRING_TOO_LONG) and took 17 s of the hook's 20. The first, cut line fails JSON.parse and is skipped.
const TAIL = 8 * 1024 * 1024;
const transcript = (file: string) => {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size, n = Math.min(size, TAIL), buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8').split('\n');
  } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
};

// The transcript is the fallback when the event carries no last_assistant_message. It is written
// asynchronously, so it may lag; the field is preferred.
function lastFromTranscript(file: string | undefined) {
  if (!file) return '';
  const lines = transcript(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.type !== 'assistant') continue;
    const text = textOf(o.message?.content);
    if (text.trim()) return text;
  }
  return '';
}

// Another plugin's Stop hook can block this Stop with exit 2 (fleet-guard: "you still hold a task") while
// this async hook runs beside it, and nothing in this event says so. stop_hook_active does not help: it is
// true on the Stop AFTER a block, which is the turn's real end, and false on the one being blocked. What
// does show it is the transcript: Claude Code writes the block as a user line "Stop hook feedback: ..."
// and the turn goes on. So the caller waits a moment, and this reads back from the end: a feedback line
// reached before this turn's own last message means the turn was blocked, and its real end is a later Stop.
// A real prompt from the person, or the start of the file, ends the search. It finds this turn's message by its
// text and trusts the transcript to be written within the wait; if it ever lags past that after an earlier block
// in the same turn, the finish reads as blocked and is not sent.
function blockedBy(file: string | undefined, last: string) {
  if (!file || !last) return false;
  const lines = transcript(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    const c = o.message?.content;
    const t = textOf(c).trim();
    if (o.type === 'assistant' && t && last.includes(t)) return false;
    if (o.type !== 'user') continue;
    if (/^Stop hook feedback:/.test(t)) return true;
    if (!o.isMeta && !(Array.isArray(c) && c.some((b) => b?.type === 'tool_result'))) return false; // a prompt: an older turn
  }
  return false;
}

// quiet: hook mode, where stdout is context the chat reads; there failures go to stderr and success is silent.
function report(r: Result, quiet?: boolean) {
  if (r.sent.length && !quiet) console.log(`notify: sent to ${r.sent.join(', ')}`);
  for (const f of r.failed) console.error(`notify: ${f.name} failed: ${f.error}`);
  for (const u of r.unconfirmed ?? []) console.error(`notify: telegram did not confirm (${u}): it may have arrived, so it is not sent again`);
  return r.sent.length || r.unconfirmed?.length ? 0 : 1;
}

async function hook() {
  let p: HookEvent = {};
  try { const raw = readFileSync(0, 'utf8'); p = raw ? JSON.parse(raw) : {}; } catch { return; }
  const session = p.session_id;
  if (!validSession(session)) return;
  prune();
  const file = markerFile(session);
  let m = readJSON<Marker>(file);
  if (!m) return;
  deadline = Date.now() + (p.hook_event_name === 'SessionStart' ? 4000 : 15000);
  // "<b>project</b> · label", escaped: every line below is HTML.
  const who = `<b>${esc(basename(m.cwd || p.cwd || process.cwd()))}</b>${m.label ? ` · ${esc(cut(m.label, 120))}` : ''}`;

  switch (p.hook_event_name) {
    case 'UserPromptSubmit':
      if (m.pending && /^(user|sdk)?$/.test(p.source || '')) { delete m.pending; m.started = now(); writeJSON(file, m); }
      return;
    case 'Stop': {
      if (m.pending) return;
      // Paused, not finished: a background job or a loop will wake the chat, and that turn is the finish.
      // The person hears about the pause once, so a job that never ends (a dev server) is not silence.
      // A later Stop whose jobs were all already there at the pause is the finish: the chat has had its
      // turn since, and nothing new is left to wake it.
      const ids = [...(p.background_tasks || []), ...(p.session_crons || [])].map((j) => String(j?.id ?? JSON.stringify(j)));
      if (ids.length && !(m.paused && ids.every((id) => m!.pausedJobs?.includes(id)))) {
        if (m.paused) { m.pausedJobs = [...new Set([...m.pausedJobs!, ...ids])]; writeJSON(file, m); return; }
        m.paused = now();
        m.pausedJobs = ids;
        writeJSON(file, m);
        await send(`${who} · ${esc(tr('paused', { n: ids.length }))}`, '', 'done');
        return;
      }
      if (p.transcript_path) { await sleep(1500); m = still(file, m); if (!m) return; }
      const last = (p.last_assistant_message || lastFromTranscript(p.transcript_path) || '').trim();
      if (blockedBy(p.transcript_path, last)) return;
      // A trailing question still finishes the arming: see the header. Markdown or a bracket after the
      // question mark does not hide it.
      const question = /[?？][^\p{L}\p{N}]*$/u.test(last);
      const note = m.resumed ? ` · ${esc(tr('resumed'))}` : '';
      m.text = `${who} · ${esc(tr(question ? 'doneQ' : 'done'))}${elapsed(m)}${note}`;
      m.excerpt = tail(redactExcerpt(last));
      m.done = now();
      writeJSON(file, m); // durable before the network: a message that never arrives loses nothing
      const r = await send(m.text, m.excerpt, 'done');
      const cur = still(file, m);
      if (!r.sent.length && !r.unconfirmed) { if (cur) { cur.unsent = r.failed; writeJSON(file, cur); } report(r, true); return; }
      if (r.unconfirmed) report(r, true);
      if (cur) rmSync(file, { force: true });
      return;
    }
    case 'StopFailure':
      if (m.pending || recent(m.failed)) return;
      m.failed = now(); writeJSON(file, m);
      report(await send(`${who} · ${tr('failed', { elapsed: elapsed(m), error: esc(cut(redactExcerpt(p.error || tr('unknown')), 300)) })}`, undefined, 'fail'), true);
      return;
    case 'Notification': {
      if (m.pending) return;
      if (!/^(permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog)$/.test(p.notification_type || '')) return;
      if (recent(m.waited)) return;
      m.waited = now(); writeJSON(file, m);
      report(await send(`${who} · ${tr('waiting', { elapsed: elapsed(m), message: esc(cut(redactExcerpt(p.message || p.notification_type || ''), 300)) })}`, undefined, 'wait'), true);
      return;
    }
    case 'SessionStart': {
      if (p.source !== 'resume') return;
      if (m.done) { await flushUnsent(config(), file); return; }
      if (m.pending) return; // the work has not started: nothing to check
      m.resumed = now(); writeJSON(file, m);
      const ago = p.seconds_since_last_response ? ` ${Math.round(p.seconds_since_last_response / 60)} minutes after its last response` : '';
      console.log(`A phone notification is armed for this chat (${who}), and the chat was reopened${ago} before it finished. ` +
        'Before anything else, check whether the task it was on is already complete. If it is, say so in one line and end the turn: ' +
        'the notification fires on that and tells the person the work was done before the restart. If it is not, continue the task; ' +
        'the notification fires when it ends.');
      return;
    }
    case 'SessionEnd':
      if (p.reason === 'clear') rmSync(file, { force: true });
      return;
    default:
  }
}

// ---- the inbox's questions on the phone ----
// The message is made by the inbox (core.mjs phoneAsk, phoneKeyboard); this sends it and keeps the ask on disk for the
// hook engine, which reads the taps (tools/hooks/telegram.ts). The engine cannot delete a file, so the asks it closed and
// the inbound messages it answered are pruned here, two days on.

interface AskIn { item: string; html: string; short: string; options?: string[]; reply?: boolean; keyboard?: object; q?: string; of?: number }
async function ask() {
  let a: Partial<AskIn>;
  const usage = 'notify: ask wants {item, html, short, options?, reply?, keyboard?} on stdin';
  try { a = JSON.parse(readFileSync(0, 'utf8')); } catch { console.error(usage); return 2; }
  if (typeof a.item !== 'string' || !a.item || typeof a.html !== 'string' || typeof a.short !== 'string') { console.error(usage); return 2; }
  // The question can carry what a chat printed: the same secret shapes as an excerpt stay out of Telegram.
  // The short line (an answered message collapses to it) and the button labels too; options stay as they are, since a
  // tap answers with the chat's own label.
  const clean = (s: string) => redactExcerpt(s).replace(/<(redacted|url|token)>/g, tr('hidden'));
  const html = clean(a.html), short = clean(a.short);
  const keyboard = a.keyboard ? JSON.parse(JSON.stringify(a.keyboard), (k, v) => (k === 'text' && typeof v === 'string' ? clean(v) : v)) : undefined;
  let r = await sendWith(config(), html, '', undefined, keyboard ? { reply_markup: keyboard } : {});
  // An unconfirmed ask is a failed one: with no message id there is no ask record, and a tap on a question with no record
  // is answered "closed". The inbox pushes it again; a repeated question beats one that cannot be answered.
  if (r.unconfirmed) r = { sent: [], failed: [{ name: 'telegram', error: `${r.unconfirmed.join('; ')} (no message id, so the ask is sent again)` }] };
  if (!r.sent.length) return report(r);
  if (r.message_id) writeJSON(join(tgDir, 'asks', `${r.message_id}.json`), { item: a.item, html, short, options: (a.options ?? []).map(String), reply: !!a.reply, at: Date.now(), ...(typeof a.q === 'string' && Number(a.of) > 1 ? { q: a.q, of: Number(a.of) } : {}) });
  prunePhone();
  console.log(`notify: asked, message ${r.message_id}`);
  return 0;
}
function prunePhone() {
  for (const sub of ['asks', 'inbound']) {
    let files: string[] = []; try { files = readdirSync(join(tgDir, sub)); } catch { continue; }
    for (const f of files) {
      const o = readJSON<{ closed?: number; done?: number }>(join(tgDir, sub, f));
      const at = o?.closed ?? o?.done;
      if (at && Date.now() - at > 2 * 86400e3) rmSync(join(tgDir, sub, f), { force: true });
    }
  }
}

// ---- setup: the person's own bot, with taps in Telegram and no typing ----

// The clipboard as text, or '' where it cannot be read. Windows' Get-Clipboard, macOS pbpaste, else wl-paste or xclip.
function clipboard(): string {
  const f = process.env.NOTIFY_CLIPBOARD;
  if (f) { try { return readFileSync(f, 'utf8'); } catch { return ''; } }
  const tries: [string, string[]][] = process.platform === 'win32' ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw']]]
    : process.platform === 'darwin' ? [['pbpaste', []]] : [['wl-paste', ['-n']], ['xclip', ['-o', '-selection', 'clipboard']]];
  for (const [cmd, args] of tries) { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }); } catch { /* next */ } }
  return '';
}
function setClipboard(text: string) {
  const f = process.env.NOTIFY_CLIPBOARD;
  if (f) { writeFileSync(f, text); return true; }
  const tries: [string, string[]][] = process.platform === 'win32' ? [['clip.exe', []]] : process.platform === 'darwin' ? [['pbcopy', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]];
  for (const [cmd, args] of tries) { try { execFileSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 }); return true; } catch { /* next */ } }
  return false;
}
// tg:// opens the Telegram app straight away. explorer.exe, not `cmd /c start`: cmd would split the link at its &.
// With no Telegram app nothing opens, and the https link printed beside it is the way.
function openLink(tg: string) {
  if (process.env.NOTIFY_NO_OPEN === '1') return;
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { spawn(cmd, [tg], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => { /* the printed link stays */ }).unref(); } catch { /* the printed link stays */ }
}

async function setup() {
  const say = (...l: string[]) => console.log(l.join('\n'));
  // A line typed or pasted into the terminal counts as well as the clipboard. With no stdin (a chat running this in the
  // background) the clipboard is the only way in.
  const lines: string[] = [];
  if (process.stdin.isTTY) process.stdin.setEncoding('utf8').on('data', (d: string) => lines.push(...d.split(/\r?\n/)));
  const limit = Date.now() + 15 * 60e3;
  const waitFor = async <T,>(get: () => Promise<T | undefined> | T | undefined, every = 1500): Promise<T | undefined> => {
    while (Date.now() < limit) { const v = await get(); if (v !== undefined) return v; await sleep(every); }
    return undefined;
  };
  const done = (code: number) => { process.stdin.pause(); return code; };

  const cfg = config();
  const found = (s: string) => (s.match(/\b\d{6,}:[\w-]{30,}\b/) || [])[0];
  // A person who made the bot first and copied its token before asking for setup keeps it: no BotFather round, and the
  // clipboard is not overwritten with a name.
  if (!found(clipboard())) {
    const user = `claude_${randomBytes(3).toString('hex')}_bot`;
    setClipboard(user);
    say('', 'Telegram notifications - setup', '',
      `  1. Telegram opens at @BotFather. Press Start (or Menu > /newbot) and send /newbot.`,
      `  2. It asks for a name, then a username. Paste the same text both times (Ctrl+V): ${user}`,
      `     It is on the clipboard already. If BotFather says the username is taken, add a digit before "_bot".`,
      `  3. Tap the token in BotFather's answer to copy it. This picks it up on its own.`,
      `     No Telegram on this computer? Open https://t.me/BotFather on the phone and paste the token here.`, '');
    openLink('tg://resolve?domain=BotFather');
  } else say('', 'Telegram notifications - setup', '', '  a bot token is on the clipboard: using it', '');

  let me: { username: string } | undefined, token = '';
  await waitFor(async () => {
    const t = found(lines.splice(0).join(' ')) || found(clipboard());
    if (!t) return undefined;
    try { me = await telegram<{ username: string }>(t, 'getMe'); token = t; return true; }
    catch (e) { say(`  that token was refused: ${redact((e as Error).message)}`); return undefined; }
  });
  if (!me) { say('', 'notify: no bot token arrived within 15 minutes; nothing was saved. Run setup again when ready.'); return done(1); }
  setClipboard(''); // the token does not stay where any app can read it

  // The one-time code in the Start link binds the chat that opened it, not whoever wrote to the bot last.
  const code = randomBytes(6).toString('hex');
  say(`  4. Your bot is @${me.username}. Telegram opens it now: press Start.`, `     (or open https://t.me/${me.username}?start=${code})`, '');
  openLink(`tg://resolve?domain=${me.username}&start=${code}`);
  // The chats' and the watcher's poll (telegram.ts) wait while the lease is fresh; a lease dated past the 15 min wait keeps
  // them off this bot, so none of them takes the Start as an unknown message.
  const lease = join(dir, 'telegram', 'polled');
  const hold = (until: number) => { try { mkdirSync(dirname(lease), { recursive: true }); writeFileSync(lease, `${until} setup`); } catch { /* the poll may then take the Start; setup times out */ } };
  hold(Date.now() + 16 * 60e3);
  let offset = 0;
  const chat = await waitFor(async () => {
    let ups: TgUpdate[] = [];
    try { ups = await telegram<TgUpdate[]>(token, 'getUpdates', { offset, timeout: 20, allowed_updates: ['message'] }, 25000); } catch { return undefined; }
    for (const u of ups) {
      offset = u.update_id + 1;
      if (u.message?.text?.trim() === `/start ${code}`) return String(u.message.chat.id);
    }
    return undefined;
  }, 200);
  if (!chat) { hold(0); say('', `notify: Start was not pressed within 15 minutes; nothing was saved. Run setup again.`); return done(1); }
  // Confirm the updates read here, so the first poll does not see the Start again.
  await telegram(token, 'getUpdates', { offset, timeout: 0 }).catch(() => undefined);
  hold(0);

  const one: Config = { ...cfg, telegram: { token, chat_id: chat } };
  const r = await sendWith(one, `<b>${esc(tr('connectedTitle', { host: hostname() }))}</b>\n${esc(tr('connectedBody'))}`, '', 'wait');
  if (!r.sent.length) { say(`  not delivered: ${[...r.failed.map((x) => x.error), ...(r.unconfirmed ?? [])].join('; ')}`, '  Nothing was saved. Run setup again.'); return done(1); }
  writeJSON(configFile, one);
  // The menu beside the message box; a failure costs only the menu.
  // No command menu (owner, 2026-11-17: everything is plain text); an older setup's menu is removed.
  await telegram(token, 'deleteMyCommands', {}).catch(() => undefined);
  say(`  connected: a test message is in Telegram now. Saved to ${configFile}`);
  const flushed = await flushUnsent(one);
  if (flushed) say(`  and ${flushed} message(s) that were waiting went out now`);
  return done(0);
}

async function main() {
  const args = process.argv.slice(2);
  const take = (flag: string) => { const i = args.indexOf(flag); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const has = (flag: string) => { const i = args.indexOf(flag); if (i < 0) return false; args.splice(i, 1); return true; };
  const cmd = args[0];
  await loadStrings();
  if (!cmd) { await hook(); return 0; }

  if (cmd === 'send') {
    // send <text>: plain words, escaped. send --html [--reply-to <id>]: HTML on stdin (the headless inbox's answer).
    if (args[1] === '--html') {
      const to = args[2] === '--reply-to' ? Number(args[3]) : 0;
      const html = redactExcerpt(readFileSync(0, 'utf8')).replace(/<(redacted|url|token)>/g, tr('hidden'));
      return report(await sendWith(config(), html, '', undefined, to ? { reply_parameters: { message_id: to, allow_sending_without_reply: true } } : {}));
    }
    return report(await send(esc(args.slice(1).join(' '))));
  }
  if (cmd === 'file' || cmd === 'screenshot') {
    const as = take('--as'), caption = take('--caption') ?? '', to = Number(take('--reply-to')) || 0;
    let path = args[1];
    if (cmd === 'screenshot') {
      if (process.platform !== 'win32') { console.error('notify: screenshot is Windows only'); return 1; }
      try { path = screenshot(); } catch (e) { console.error(`notify: screenshot failed: ${(e as Error).message.split('\n')[0]}`); return 1; }
    }
    if (!path) { console.error('notify: usage: file <path> [--as photo|video|voice|audio|animation|document] [--caption <text>] [--reply-to <id>]'); return 2; }
    const r = await sendFile(config(), path, as, caption, to);
    if (cmd === 'screenshot') rmSync(path, { force: true });
    return report(r);
  }
  if (cmd === 'typing') {
    // The "typing..." line on the phone lasts about 5 s: the headless inbox repeats it while it works.
    const cfg = config(), action = args[1] || 'typing';
    if (process.env.NOTIFY_DRY_RUN || !connected(cfg)) return 0;
    await telegram(cfg.telegram!.token, 'sendChatAction', { chat_id: cfg.telegram!.chat_id, action }, 4000).catch(() => undefined);
    return 0;
  }
  if (cmd === '--test') return report(await send(`<i>${esc(tr('testLine', { host: hostname() }))}</i>`));
  if (cmd === 'setup') return setup();
  if (cmd === 'ask') return ask();

  const on = connected(config());
  const other = take('--session');
  const session = other || process.env.CLAUDE_CODE_SESSION_ID;
  if (!session) { console.error('notify: no session id. Run this inside the chat, or pass --session <id>.'); return 1; }
  if (!validSession(session)) { console.error(`notify: "${session}" is not a session id (letters, digits, - and _ only)`); return 1; }
  const file = markerFile(session);

  if (cmd === '--status') {
    const m = readJSON<Marker>(file);
    console.log(m ? `notify: armed${m.pending ? ' for the next turn' : ''} (${m.label || 'no label'}, since ${m.armed})` : 'notify: not armed for this chat');
    console.log(on ? 'channels: telegram' : `channels: none - ${setupHint()}`);
    return 0;
  }
  if (cmd === '--disarm') { rmSync(file, { force: true }); console.log('notify: disarmed'); return 0; }
  if (cmd === '--arm') {
    has('--arm');
    prune();
    const next = has('--next');
    // Git Bash rewrites a label that starts with / (`/deploy` -> `C:/Program Files/Git/deploy`), quoted or not.
    const gitRoot = process.env.MSYSTEM ? (process.env.EXEPATH || process.env.SHELL || '').replaceAll('\\', '/').replace(/\/(usr\/)?bin(\/[^/]*\.exe)?$/i, '') : '';
    const raw = args.join(' ').trim();
    const label = gitRoot && raw.toLowerCase().startsWith(`${gitRoot.toLowerCase()}/`) ? raw.slice(gitRoot.length) : raw;
    // This process runs in the ARMING chat's directory. For another chat that is the wrong project, so the
    // cwd is left out and the hook takes the one in that chat's own events.
    writeJSON(file, { armed: now(), label, ...(other ? {} : { cwd: process.cwd() }), ...(next ? { pending: true } : {}) });
    console.log(`notify: armed${next ? ' for the end of the next turn' : ''}${label ? ` - "${label}"` : ''}`);
    if (on) console.log('channels: telegram');
    else console.log('channels: none yet. Run "notify.mjs setup" (a chat can run it in the background); the marker waits, and a finish that happens before that is delivered when Telegram is connected.');
    return 0;
  }
  console.error(`notify: unknown argument ${cmd}`); return 2;
}

main().then((code) => process.exit(code || 0), (e) => { console.error(`notify: ${redact(e.message)}`); process.exit(process.argv[2] ? 1 : 0); });
