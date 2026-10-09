#!/usr/bin/env node
// notify.mjs - one message to the operator's phone when a chat they walked away from ends its turn.
//
// A chat cannot tell whether a person is watching it, and a Stop hook fires at the end of every turn
// either way. So the person arms it: `--arm` writes a marker for one session, the hook sends exactly one
// message the next time that session ends a turn, and the marker goes. A session nobody armed sends
// nothing, ever.
//
//   node notify.mjs                        hook mode: the event on stdin; never blocks, never exits non-zero
//   node notify.mjs setup                  a wizard in the terminal: pick a channel, paste the one value it
//                                          needs, a test message must arrive, then it is saved. The token
//                                          never passes through a chat, and no browser tab is opened.
//   node notify.mjs --arm [--next] [--session <id>] [label]
//                                          arm this session (CLAUDE_CODE_SESSION_ID) or another one.
//                                          --next: fire at the end of the NEXT turn, not the one arming it
//   node notify.mjs --disarm [--session <id>]
//   node notify.mjs --status               armed or not, and which channels are configured
//   node notify.mjs --test                 send a test line to every configured channel
//   node notify.mjs send <text>            send one message now (fleet.sh landed uses this)
//
// Channels live in ~/.claude/makarasty/notify.json (CLAUDE_CONFIG_DIR honoured), outside every repository.
// The setup wizard writes it; by hand it is:
//   {
//     "telegram": { "token": "123456:ABC...", "chat_id": "42" },   chat_id may be left out: whoever
//                                                                  messaged the bot last fills it in (the
//                                                                  wizard names that person and asks first)
//     "discord":  { "url": "https://discord.com/api/webhooks/...", "everyone": true },
//     "ntfy":     "https://ntfy.sh/<an-unguessable-topic>",
//     "webhook":  "https://hooks.slack.com/services/...",          any URL that takes POST {"text": "..."}
//     "excerpt":  true                                              see below
//   }
// Every key is optional; every configured one gets every message. A plain string under "discord" is
// read as the URL with no mention. A value that is not a string, or not an http(s) URL, is left out with
// a line that names the key and never the value: the value is a secret, and the line can land in a chat.
// For the same reason every error text has its URLs and bot tokens blanked before it is printed or stored.
//
// The excerpt - the last 500 characters of the chat's final message - can carry code, data or secrets the
// chat printed. It goes to every channel except the public ntfy.sh server (www.ntfy.sh, ntfy.sh:443 and
// ntfy.sh. are the same server), where it is off unless "excerpt": true. "excerpt": false turns it off
// everywhere.
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
//                 undelivered finish still goes out at the next resume or when the wizard saves a channel.
//
// Cost: the hook command in plugin.json only starts node when a marker file exists in this config dir, so
// a session nobody armed pays one shell glob per event and never a node start. A marker is removed on
// delivery; one older than seven days is pruned by every hook run and every --arm, so a chat that died
// unreopened cannot keep that guard open for every session for good.
//
// A marker is written to a temp file and renamed into place, and after a send the hook re-reads it and
// touches it only if it is still the same arming: a re-arm or disarm made while a slow send was running
// is newer, and wins.
//
// A finish that could not be delivered - no channel yet, network down - stays on disk as the marker, and
// goes out at the next chance: the chat reopening, or the setup wizard saving a channel.
//
// Network: a transient failure (network, 5xx, 429) is retried while the hook's time budget lasts - 15 s,
// under the 20 s hook timeout, and 4 s at SessionStart, which the chat waits on.
//
// NOTIFY_DRY_RUN=<file> appends what would be sent to that file instead of sending. The self-test uses it.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const dir = join(home, 'makarasty');
const configFile = join(dir, 'notify.json');
const markerDir = join(dir, 'notify');
const markerFile = (session) => join(markerDir, `${session}.json`);
const validSession = (s) => typeof s === 'string' && /^[\w-]+$/.test(s); // a path would reach the config file
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Windows refuses a rename over a file another process has open, or one an antivirus is scanning, with
// EPERM, EBUSY or EACCES, and a read in that instant fails the same way. Both are momentary: wait 20 ms and
// try again. A missing file is not one of them and still reads as null, "not armed".
const busy = (e) => ['EPERM', 'EBUSY', 'EACCES'].includes(e?.code);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readJSON = (file) => {
    for (let i = 0;; i++) {
        try {
            return JSON.parse(readFileSync(file, 'utf8'));
        }
        catch (e) {
            if (!busy(e) || i >= 1)
                return null;
            pause(20);
        }
    }
};
// Temp file and rename: a reader never sees half a file, and the guard's *.json glob never sees the temp.
// A rename still refused after five tries falls back to writing the file in place: a marker that might be
// read half-written for a moment beats a throw that loses the finish.
const writeJSON = (file, o) => {
    mkdirSync(join(file, '..'), { recursive: true });
    const body = JSON.stringify(o, null, 2) + '\n';
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    for (let i = 0; i < 5; i++) {
        try {
            renameSync(tmp, file);
            return;
        }
        catch (e) {
            if (!busy(e))
                throw e;
            pause(20);
        }
    }
    writeFileSync(file, body, { mode: 0o600 });
    rmSync(tmp, { force: true });
};
// Error text can carry the request URL (fetch's "Failed to parse URL from <url>") and so a webhook token,
// a topic or a bot token. It is printed where a chat reads it and stored in the marker, so it passes here.
const redact = (s) => String(s).replace(/https?:\/\/\S+/gi, '<url>').replace(/\b\d{5,}:[\w-]{20,}/g, '<token>');
// One shape on disk whatever the wizard or a hand wrote. A bad value is dropped with a line naming the key.
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const isURL = (s) => { try {
    return /^https?:$/.test(new URL(s).protocol);
}
catch {
    return false;
} };
function normalise(o, warn = (m) => console.error(`notify: ${m}`)) {
    const c = {};
    const url = (key, v) => { if (!v || isURL(v))
        return v; warn(`the ${key} value is not an http(s) URL, so it is left out`); return ''; };
    // Present but not a string ({"ntfy": {"url": ...}}) is a mistake to name, not a channel to drop quietly.
    const text = (key, v) => { if (v === undefined || v === null || typeof v === 'string')
        return str(v); warn(`the ${key} value is not a string, so it is left out`); return ''; };
    const token = text('telegram token', o.telegram?.token);
    const chat = o.telegram?.chat_id;
    if (token && !/^\d+:[\w-]+$/.test(token))
        warn('the telegram token does not look like a bot token (digits:letters), so it is left out');
    else if (token)
        c.telegram = { token, ...(typeof chat === 'number' || str(chat) ? { chat_id: String(chat).trim() } : {}) };
    const d = typeof o.discord === 'string' ? { url: o.discord, everyone: false } : o.discord;
    if (d !== undefined && d !== null && typeof d !== 'object')
        warn('the discord value is not a string or an object, so it is left out');
    const du = url('discord', text('discord url', d?.url));
    if (du)
        c.discord = { url: du, everyone: d.everyone !== false };
    // A bare word is a topic on the public server; anything with a dot, slash or colon is a host someone typed
    // without the scheme.
    let t = text('ntfy', o.ntfy);
    if (t && !/^https?:\/\//i.test(t))
        t = (/[./:]/.test(t) ? 'https://' : 'https://ntfy.sh/') + t;
    t = url('ntfy', t);
    if (t)
        c.ntfy = t;
    const w = url('webhook', text('webhook', o.webhook));
    if (w)
        c.webhook = w;
    if (typeof o.excerpt === 'boolean')
        c.excerpt = o.excerpt;
    return c;
}
const config = () => normalise(readJSON(configFile) || {});
const CHANNELS = ['telegram', 'discord', 'ntfy', 'webhook'];
const channels = (cfg) => CHANNELS.filter((k) => cfg[k]);
// By host, not by string prefix: www.ntfy.sh, ntfy.sh:443, ntfy.sh. and NTFY.SH are all the public server.
const publicNtfy = (u) => { try {
    return new URL(u).hostname.replace(/\.$/, '').replace(/^www\./, '') === 'ntfy.sh';
}
catch {
    return true;
} };
const withExcerpt = (cfg, name) => cfg.excerpt ?? !(name === 'ntfy' && publicNtfy(cfg.ntfy));
// Every request shares one deadline, so retries can never outlast the hook's own timeout.
let deadline = Infinity;
const left = () => deadline - Date.now();
// A transient failure (network, 5xx, 429) is retried up to twice; any other 4xx is the config's fault.
async function post(url, body, headers) {
    for (let i = 0;; i++) {
        const ms = Math.min(6000, left());
        try {
            if (ms < 500)
                throw Object.assign(new Error('out of time'), { final: true });
            const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(ms) });
            if (r.ok)
                return r;
            const text = (await r.text()).slice(0, 200);
            let why = text;
            try {
                why = JSON.parse(text).description || text;
            }
            catch { /* not JSON */ }
            throw Object.assign(new Error(`${r.status} ${why}`), { final: r.status < 500 && r.status !== 429 });
        }
        catch (e) {
            if (e.final || i >= 2 || left() < 1500)
                throw e;
            await sleep(1000);
        }
    }
}
async function telegram(token, method, body) {
    const r = await post(`https://api.telegram.org/bot${token}/${method}`, JSON.stringify(body || {}), { 'content-type': 'application/json' });
    const o = await r.json();
    if (!o.ok)
        throw new Error(o.description || `${r.status}`);
    return o.result;
}
// The chat of whoever messaged the bot last, with a name for the wizard to show: a bot anyone can find may
// have heard from someone else first.
async function telegramChat(token) {
    for (const u of (await telegram(token, 'getUpdates')).reverse()) {
        const up = u.message ?? u.my_chat_member;
        if (up?.chat?.id === undefined)
            continue;
        const f = up.from || {};
        const name = up.chat.title || [f.first_name, f.last_name].filter(Boolean).join(' ') || 'someone';
        return { id: String(up.chat.id), name: f.username ? `${name} (@${f.username})` : name };
    }
    throw new Error('the bot has not heard from you yet: open it in Telegram, press Start, then try again');
}
// Returns { sent: [names], failed: [{ name, error }] }. Partial delivery counts as delivered. A Telegram
// chat_id learnt on the way is written into cfg, and into the file when cfg came from it. The excerpt goes
// under the text on the channels withExcerpt allows.
async function sendWith(cfg, text, persist, excerpt = '') {
    const full = (name) => (excerpt && withExcerpt(cfg, name) ? `${text}\n${excerpt}` : text);
    const dry = process.env.NOTIFY_DRY_RUN;
    if (dry) {
        const names = channels(cfg);
        const line = excerpt && (!names.length || names.some((n) => withExcerpt(cfg, n))) ? `${text}\n${excerpt}` : text;
        try {
            appendFileSync(dry, line.replace(/\n/g, ' | ') + '\n');
            return { sent: ['dry-run'], failed: [] };
        }
        catch (e) {
            return { sent: [], failed: [{ name: 'dry-run', error: e.message }] };
        }
    }
    if (typeof fetch !== 'function')
        return { sent: [], failed: [{ name: 'node', error: 'node 18 or newer is needed' }] };
    const json = { 'content-type': 'application/json' };
    const jobs = {
        telegram: async () => {
            const t = cfg.telegram;
            if (!t.chat_id) {
                t.chat_id = (await telegramChat(t.token)).id;
                if (persist)
                    writeJSON(configFile, cfg);
            }
            await telegram(t.token, 'sendMessage', { chat_id: t.chat_id, text: full('telegram').slice(0, 4000), disable_web_page_preview: true });
        },
        discord: () => post(cfg.discord.url, JSON.stringify({
            content: (cfg.discord.everyone ? '@everyone ' : '') + full('discord').slice(0, 1900),
            allowed_mentions: { parse: cfg.discord.everyone ? ['everyone'] : [] },
        }), json),
        ntfy: () => post(cfg.ntfy, full('ntfy').slice(0, 4000), { Title: 'Claude Code', 'content-type': 'text/plain; charset=utf-8' }),
        webhook: () => post(cfg.webhook, JSON.stringify({ text: full('webhook').slice(0, 4000) }), json),
    };
    const names = channels(cfg);
    const results = await Promise.allSettled(names.map((n) => jobs[n]()));
    const out = { sent: [], failed: [] };
    results.forEach((r, i) => (r.status === 'fulfilled' ? out.sent.push(names[i]) : out.failed.push({ name: names[i], error: redact(r.reason?.message || r.reason) })));
    if (!names.length)
        out.failed.push({ name: 'config', error: `no channel yet: run "notify.mjs setup" in a terminal (${configFile})` });
    return out;
}
const send = (text, excerpt) => sendWith(config(), text, true, excerpt);
// Finishes that were written but never delivered, sent now. The wizard saving a channel and a reopened
// chat both call this. A marker whose send is still running (done written, no unsent yet) is another
// hook's job: it is skipped for a minute, after which its hook is past its 20 s timeout and dead. own is
// the reopened chat's own marker, which no other hook can be sending.
async function flushUnsent(cfg, own) {
    let files = [];
    try {
        files = readdirSync(markerDir).filter((f) => f.endsWith('.json'));
    }
    catch {
        return 0;
    }
    let n = 0;
    for (const f of files) {
        const file = join(markerDir, f);
        const m = readJSON(file);
        if (!m?.done)
            continue;
        if (file !== own && !m.unsent && Date.now() - Date.parse(m.done) < 60e3)
            continue;
        const r = await sendWith(cfg, `${m.text}\n(finished at ${m.done}; this could not be delivered at the time)`, false, m.excerpt);
        if (!r.sent.length)
            continue;
        n++;
        if (still(file, m))
            rmSync(file, { force: true });
    }
    return n;
}
// The marker as it is on disk now, if it is still the arming this process read. A send can take seconds,
// and a re-arm or a disarm made meanwhile is newer than what this process holds, so it must win.
const still = (file, m) => { const cur = readJSON(file); return cur && cur.armed === m.armed ? cur : null; };
const recent = (ts) => !!ts && Date.now() - Date.parse(ts) < 5 * 60 * 1000;
// A marker older than seven days belongs to a chat that died unreopened. Left alone it keeps the shell guard
// in plugin.json open, and node starting, on every hook of every session.
function prune() {
    let files = [];
    try {
        files = readdirSync(markerDir);
    }
    catch {
        return;
    }
    for (const f of files) {
        const p = join(markerDir, f);
        try {
            if (Date.now() - statSync(p).mtimeMs > 7 * 86400e3)
                rmSync(p, { force: true });
        }
        catch { /* gone meanwhile */ }
    }
}
// The END of the message: that is where a reply puts its verdict.
const tail = (s, n = 500) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? '...' + t.slice(-n) : t; };
const textOf = (c) => (Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : typeof c === 'string' ? c : '');
const transcript = (file) => { try {
    return readFileSync(file, 'utf8').split('\n');
}
catch {
    return [];
} };
// The transcript is the fallback when the event carries no last_assistant_message. It is written
// asynchronously, so it may lag; the field is preferred.
function lastFromTranscript(file) {
    if (!file)
        return '';
    const lines = transcript(file);
    for (let i = lines.length - 1; i >= 0; i--) {
        let o;
        try {
            o = JSON.parse(lines[i]);
        }
        catch {
            continue;
        }
        if (o.type !== 'assistant')
            continue;
        const text = textOf(o.message?.content);
        if (text.trim())
            return text;
    }
    return '';
}
// Another plugin's Stop hook can block this Stop with exit 2 (fleet-guard: "you still hold a task") while
// this async hook runs beside it, and nothing in this event says so. stop_hook_active does not help: it is
// true on the Stop AFTER a block, which is the turn's real end, and false on the one being blocked. What
// does show it is the transcript: Claude Code writes the block as a user line "Stop hook feedback: ..."
// and the turn goes on. So the caller waits a moment, and this reads back from the end: a feedback line
// reached before this turn's own last message means the turn was blocked, and its real end is a later Stop.
// A real prompt from the person, or the start of the file, ends the search. ponytail: finds this turn's
// message by its text and trusts the transcript to be written within the wait; if it ever lags past that
// after an earlier block in the same turn, the finish reads as blocked and is not sent.
function blockedBy(file, last) {
    if (!file || !last)
        return false;
    const lines = transcript(file);
    for (let i = lines.length - 1; i >= 0; i--) {
        let o;
        try {
            o = JSON.parse(lines[i]);
        }
        catch {
            continue;
        }
        const c = o.message?.content;
        const t = textOf(c).trim();
        if (o.type === 'assistant' && t && last.includes(t))
            return false;
        if (o.type !== 'user')
            continue;
        if (/^Stop hook feedback:/.test(t))
            return true;
        if (!o.isMeta && !(Array.isArray(c) && c.some((b) => b?.type === 'tool_result')))
            return false; // a prompt: an older turn
    }
    return false;
}
// quiet: hook mode, where stdout is context the chat reads; there failures go to stderr and success is silent.
function report(r, quiet) {
    if (r.sent.length && !quiet)
        console.log(`notify: sent to ${r.sent.join(', ')}`);
    for (const f of r.failed)
        console.error(`notify: ${f.name} failed: ${f.error}`);
    return r.sent.length ? 0 : 1;
}
async function hook() {
    let p = {};
    try {
        const raw = readFileSync(0, 'utf8');
        p = raw ? JSON.parse(raw) : {};
    }
    catch {
        return;
    }
    const session = p.session_id;
    if (!validSession(session))
        return;
    prune();
    const file = markerFile(session);
    let m = readJSON(file);
    if (!m)
        return;
    deadline = Date.now() + (p.hook_event_name === 'SessionStart' ? 4000 : 15000);
    const who = `${basename(m.cwd || p.cwd || process.cwd())}${m.label ? ': ' + m.label : ''}`;
    switch (p.hook_event_name) {
        case 'UserPromptSubmit':
            if (m.pending && /^(user|sdk)?$/.test(p.source || '')) {
                delete m.pending;
                writeJSON(file, m);
            }
            return;
        case 'Stop': {
            if (m.pending)
                return;
            // Paused, not finished: a background job or a loop will wake the chat, and that turn is the finish.
            // The person hears about the pause once, so a job that never ends (a dev server) is not silence.
            // A later Stop whose jobs were all already there at the pause is the finish: the chat has had its
            // turn since, and nothing new is left to wake it.
            const ids = [...(p.background_tasks || []), ...(p.session_crons || [])].map((j) => String(j?.id ?? JSON.stringify(j)));
            if (ids.length && !(m.paused && ids.every((id) => m.pausedJobs?.includes(id)))) {
                if (m.paused) {
                    m.pausedJobs = [...new Set([...m.pausedJobs, ...ids])];
                    writeJSON(file, m);
                    return;
                }
                m.paused = now();
                m.pausedJobs = ids;
                writeJSON(file, m);
                await send(`${who} paused: ${ids.length} background job${ids.length > 1 ? 's' : ''} still running`, '');
                return;
            }
            if (p.transcript_path) {
                await sleep(1500);
                m = still(file, m);
                if (!m)
                    return;
            }
            const last = (p.last_assistant_message || lastFromTranscript(p.transcript_path) || '').trim();
            if (blockedBy(p.transcript_path, last))
                return;
            // A trailing question still finishes the arming: see the header. Markdown or a bracket after the
            // question mark does not hide it.
            const question = /[?？][^\p{L}\p{N}]*$/u.test(last);
            const note = m.resumed ? ' (the chat had been reopened after an interruption)' : '';
            m.text = `${who} finished${question ? ', with a question for you' : ''}${note}`;
            m.excerpt = tail(last);
            m.done = now();
            writeJSON(file, m); // durable before the network: a message that never arrives loses nothing
            const r = await send(m.text, m.excerpt);
            const cur = still(file, m);
            if (!r.sent.length) {
                if (cur) {
                    cur.unsent = r.failed;
                    writeJSON(file, cur);
                }
                report(r, true);
                return;
            }
            if (cur)
                rmSync(file, { force: true });
            return;
        }
        case 'StopFailure':
            if (m.pending || recent(m.failed))
                return;
            m.failed = now();
            writeJSON(file, m);
            report(await send(`${who} stopped on an error: ${p.error || 'unknown'}. Reopen the chat to continue.`), true);
            return;
        case 'Notification': {
            if (m.pending)
                return;
            if (!/^(permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog)$/.test(p.notification_type || ''))
                return;
            if (recent(m.waited))
                return;
            m.waited = now();
            writeJSON(file, m);
            report(await send(`${who} needs you: ${p.message || p.notification_type}`), true);
            return;
        }
        case 'SessionStart': {
            if (p.source !== 'resume')
                return;
            if (m.done) {
                await flushUnsent(config(), file);
                return;
            }
            if (m.pending)
                return; // the work has not started: nothing to check
            m.resumed = now();
            writeJSON(file, m);
            const ago = p.seconds_since_last_response ? ` ${Math.round(p.seconds_since_last_response / 60)} minutes after its last response` : '';
            console.log(`A phone notification is armed for this chat (${who}), and the chat was reopened${ago} before it finished. ` +
                'Before anything else, check whether the task it was on is already complete. If it is, say so in one line and end the turn: ' +
                'the notification fires on that and tells the person the work was done before the restart. If it is not, continue the task; ' +
                'the notification fires when it ends.');
            return;
        }
        case 'SessionEnd':
            if (p.reason === 'clear')
                rmSync(file, { force: true });
            return;
        default:
    }
}
// ---- setup: a wizard in the terminal, so a token goes keyboard -> this process -> file and nowhere else ----
// No browser tab: one node process for as long as the person is typing, then nothing.
const STEPS = {
    telegram: [
        'Open @BotFather in Telegram (https://t.me/BotFather) and send /newbot.',
        'Answer its two questions: a name, then a username ending in "bot".',
        'Copy the token it gives you. It looks like 123456789:ABC...',
    ],
    discord: [
        'Make a private server for yourself, or pick a channel nobody else reads.',
        'Channel settings (the gear) > Integrations > Webhooks > New Webhook > Copy Webhook URL.',
    ],
    ntfy: [
        'Install the ntfy app: Android https://play.google.com/store/apps/details?id=io.heckel.ntfy',
        '                      iPhone  https://apps.apple.com/app/ntfy/id1625396347',
        'In the app press + and subscribe to the topic below. The topic is your password: keep it to yourself.',
    ],
};
async function setup() {
    // Lines are queued rather than asked for one at a time, so a pipe that delivers every answer at once
    // (the self-test) and a person typing them get the same treatment. readline's own question() drops a
    // line that arrives while no question is pending.
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const queue = [];
    let waiter = null;
    let ended = false;
    rl.on('line', (l) => { if (waiter) {
        const w = waiter;
        waiter = null;
        w(l);
    }
    else
        queue.push(l); });
    rl.on('close', () => { ended = true; if (waiter) {
        const w = waiter;
        waiter = null;
        w(null);
    } });
    const ask = async (q, def = '') => {
        process.stdout.write(`${q}${def ? ` [${def}]` : ''}: `);
        const a = queue.length ? queue.shift() : ended ? null : await new Promise((r) => { waiter = r; });
        if (a === null)
            throw new Error('no input');
        return a.trim() || def;
    };
    const say = (...l) => console.log(l.join('\n'));
    const warn = (m) => say(`  ${m}`);
    const cfg = config();
    const test = `test from Claude Code on ${hostname()}: this channel works`;
    try {
        say('', 'Claude Code notifications - setup', channels(cfg).length ? `configured now: ${channels(cfg).join(', ')}` : '', '');
        for (;;) {
            const pick = await ask('Which channel? 1 Telegram, 2 Discord, 3 ntfy (no account, quickest)', '1');
            const ch = { 1: 'telegram', 2: 'discord', 3: 'ntfy' }[pick];
            if (!ch)
                continue;
            say('', ...STEPS[ch].map((l, i) => `  ${i + 1}. ${l}`), '');
            let one;
            if (ch === 'telegram') {
                const token = await ask('Paste the token');
                let me;
                try {
                    me = await telegram(token, 'getMe');
                }
                catch (e) {
                    say(`  that token was refused: ${redact(e.message)}`, '');
                    continue;
                }
                say(`  Your bot is @${me.username}. Open https://t.me/${me.username} and press Start.`);
                await ask('Press Enter once you have pressed Start');
                // The chat is whoever wrote to the bot last, and a bot can be found by anyone: name them, ask first.
                let chat;
                try {
                    chat = await telegramChat(token);
                }
                catch (e) {
                    say(`  ${redact(e.message)}`, '');
                    continue;
                }
                if (!/^y/i.test(await ask(`Messages will go to ${chat.name}. Is that you? y/n`, 'y'))) {
                    say('  Then press Start (or send any message) to the bot from your own account, and pick Telegram again.', '');
                    continue;
                }
                one = normalise({ telegram: { token, chat_id: chat.id } }, warn);
            }
            else if (ch === 'discord') {
                const url = await ask('Paste the webhook URL');
                if (!url) {
                    say('  nothing entered', '');
                    continue;
                }
                const buzz = await ask('Mention @everyone so the phone buzzes? y/n (yes on a private server)', 'y');
                one = normalise({ discord: { url, everyone: /^y/i.test(buzz) } }, warn);
            }
            else {
                const topic = 'claude-' + randomBytes(8).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'x');
                say(`  topic: ${topic}`);
                one = normalise({ ntfy: await ask('Press Enter once subscribed, or type a topic of your own', topic) }, warn);
            }
            if (!channels(one).length) {
                say('  not saved: pick the channel again', '');
                continue;
            }
            const r = await sendWith(one, test, false);
            if (!r.sent.length) {
                say(`  not delivered: ${r.failed.map((x) => x.error).join('; ')}`, '  Fix that and pick the channel again.', '');
                continue;
            }
            Object.assign(cfg, one);
            writeJSON(configFile, cfg);
            say(`  delivered - check your phone. Saved ${ch} to ${configFile}`, '');
            const flushed = await flushUnsent(cfg);
            if (flushed)
                say(`  and ${flushed} message(s) that were waiting for a channel went out now`, '');
            if (!/^y/i.test(await ask('Add another channel? y/n', 'n')))
                break;
        }
        say('', `done: ${channels(cfg).join(', ') || 'no channel'}. Any chat can now be told "ping me when this is done".`);
        rl.close();
        return 0;
    }
    catch (e) {
        rl.close();
        if (e.message !== 'no input')
            throw e;
        say('', 'notify: setup needs a terminal to type into. Run it there:', `  node "${process.argv[1]}" setup`);
        return 1;
    }
}
async function main() {
    const args = process.argv.slice(2);
    const take = (flag) => { const i = args.indexOf(flag); if (i < 0)
        return null; const v = args[i + 1]; args.splice(i, 2); return v; };
    const has = (flag) => { const i = args.indexOf(flag); if (i < 0)
        return false; args.splice(i, 1); return true; };
    const cmd = args[0];
    if (!cmd) {
        await hook();
        return 0;
    }
    if (cmd === 'send')
        return report(await send(args.slice(1).join(' ')));
    if (cmd === '--test')
        return report(await send(`test from Claude Code on ${hostname()}: this channel works`));
    if (cmd === 'setup')
        return setup();
    const list = channels(config());
    const other = take('--session');
    const session = other || process.env.CLAUDE_CODE_SESSION_ID;
    if (!session) {
        console.error('notify: no session id. Run this inside the chat, or pass --session <id>.');
        return 1;
    }
    if (!validSession(session)) {
        console.error(`notify: "${session}" is not a session id (letters, digits, - and _ only)`);
        return 1;
    }
    const file = markerFile(session);
    if (cmd === '--status') {
        const m = readJSON(file);
        console.log(m ? `notify: armed${m.pending ? ' for the next turn' : ''} (${m.label || 'no label'}, since ${m.armed})` : 'notify: not armed for this chat');
        console.log(list.length ? `channels: ${list.join(', ')}` : `channels: none configured yet - run "notify.mjs setup" in a terminal (${configFile})`);
        return 0;
    }
    if (cmd === '--disarm') {
        rmSync(file, { force: true });
        console.log('notify: disarmed');
        return 0;
    }
    if (cmd === '--arm') {
        has('--arm');
        prune();
        const next = has('--next');
        const label = args.join(' ').trim();
        // This process runs in the ARMING chat's directory. For another chat that is the wrong project, so the
        // cwd is left out and the hook takes the one in that chat's own events.
        writeJSON(file, { armed: now(), label, ...(other ? {} : { cwd: process.cwd() }), ...(next ? { pending: true } : {}) });
        console.log(`notify: armed${next ? ' for the end of the next turn' : ''}${label ? ` - "${label}"` : ''}`);
        if (list.length)
            console.log(`channels: ${list.join(', ')}`);
        else
            console.log('channels: none yet. The person runs "notify.mjs setup" in a terminal; the marker waits, and a finish that happens before that is delivered when a channel is saved.');
        return 0;
    }
    console.error(`notify: unknown argument ${cmd}`);
    return 2;
}
main().then((code) => process.exit(code || 0), (e) => { console.error(`notify: ${redact(e.message)}`); process.exit(process.argv[2] ? 1 : 0); });
