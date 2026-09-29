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
//     "telegram": { "token": "123456:ABC...", "chat_id": "42" },   chat_id may be left out: the first
//                                                                  person to message the bot fills it in
//     "discord":  { "url": "https://discord.com/api/webhooks/...", "everyone": true },
//     "ntfy":     "https://ntfy.sh/<an-unguessable-topic>",
//     "webhook":  "https://hooks.slack.com/services/...",          any URL that takes POST {"text": "..."}
//     "excerpt":  true                                              see below
//   }
// Every key is optional; every configured one gets every message. A plain string under "discord" is
// read as the URL with no mention.
//
// The excerpt - the last 500 characters of the chat's final message - can carry code, data or secrets the
// chat printed. It goes to every channel except the public ntfy.sh server, where it is off unless
// "excerpt": true. "excerpt": false turns it off everywhere.
//
// What the hook does with an armed session:
//   Stop          send "<project>: <label> finished" plus the end of the last message, then disarm.
//                 A last message ending in a question is reported as waiting for an answer instead, and
//                 the marker stays: the work is not done, and the real finish still gets its message.
//   StopFailure   the turn died on an API error: say so, keep the marker for the resumed chat.
//   Notification  permission_prompt and the other "needs a person" kinds: one ping per five minutes,
//                 marker kept, because the work is not done.
//   A --next marker ignores Stop, StopFailure and Notification until the next prompt makes it live.
//   SessionStart  source resume only. A message that was written but never delivered is sent now, and
//                 a chat reopened before it finished is told, in context, to check whether the work is
//                 already complete before it does anything else.
//   UserPromptSubmit   turns a --next marker into a live one.
//
// Cost: the hook command in plugin.json only starts node when a marker file exists in this config dir, so
// a session nobody armed pays one shell glob per event and never a node start. A marker is removed on delivery; one
// older than seven days is pruned at the next --arm, so a chat that died unreopened cannot keep that
// guard open for good.
//
// A finish that could not be delivered - no channel yet, network down - stays on disk as the marker, and
// goes out at the next chance: the chat reopening, or the setup wizard saving a channel.
//
// Network: a transient failure (network, 5xx, 429) is retried while the hook's time budget lasts - 15 s,
// under the 20 s hook timeout, and 4 s at SessionStart, which the chat waits on.
//
// NOTIFY_DRY_RUN=<file> appends what would be sent to that file instead of sending. The self-test uses it.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
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

const readJSON = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const writeJSON = (file, o) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(o, null, 2) + '\n', { mode: 0o600 }); };

// One shape on disk whatever the wizard or a hand wrote.
function normalise(o) {
  const c = {};
  if (o.telegram?.token?.trim()) c.telegram = { token: o.telegram.token.trim(), ...(o.telegram.chat_id ? { chat_id: String(o.telegram.chat_id) } : {}) };
  const d = typeof o.discord === 'string' ? { url: o.discord, everyone: false } : o.discord;
  if (d?.url?.trim()) c.discord = { url: d.url.trim(), everyone: d.everyone !== false };
  let t = o.ntfy ? String(o.ntfy).trim() : '';
  if (t && !/^https?:\/\//.test(t)) t = 'https://ntfy.sh/' + t;
  if (t) c.ntfy = t;
  if (o.webhook?.trim()) c.webhook = o.webhook.trim();
  if (typeof o.excerpt === 'boolean') c.excerpt = o.excerpt;
  return c;
}
const config = () => normalise(readJSON(configFile) || {});
const CHANNELS = ['telegram', 'discord', 'ntfy', 'webhook'];
const channels = (cfg) => CHANNELS.filter((k) => cfg[k]);
const withExcerpt = (cfg, name) => cfg.excerpt ?? !(name === 'ntfy' && /^https?:\/\/ntfy\.sh\//i.test(cfg.ntfy));

// Every request shares one deadline, so retries can never outlast the hook's own timeout.
let deadline = Infinity;
const left = () => deadline - Date.now();

// A transient failure (network, 5xx, 429) is retried up to twice; any other 4xx is the config's fault.
async function post(url, body, headers) {
  for (let i = 0; ; i++) {
    const ms = Math.min(6000, left());
    try {
      if (ms < 500) throw Object.assign(new Error('out of time'), { final: true });
      const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(ms) });
      if (r.ok) return r;
      const text = (await r.text()).slice(0, 200);
      let why = text; try { why = JSON.parse(text).description || text; } catch { /* not JSON */ }
      throw Object.assign(new Error(`${r.status} ${why}`), { final: r.status < 500 && r.status !== 429 });
    } catch (e) {
      if (e.final || i >= 2 || left() < 1500) throw e;
      await sleep(1000);
    }
  }
}

async function telegram(token, method, body) {
  const r = await post(`https://api.telegram.org/bot${token}/${method}`, JSON.stringify(body || {}), { 'content-type': 'application/json' });
  const o = await r.json();
  if (!o.ok) throw new Error(o.description || `${r.status}`);
  return o.result;
}

async function telegramChat(token) {
  for (const u of (await telegram(token, 'getUpdates')).reverse()) {
    const id = u.message?.chat?.id ?? u.my_chat_member?.chat?.id;
    if (id !== undefined) return String(id);
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
    try { appendFileSync(dry, line.replace(/\n/g, ' | ') + '\n'); return { sent: ['dry-run'], failed: [] }; }
    catch (e) { return { sent: [], failed: [{ name: 'dry-run', error: e.message }] }; }
  }
  if (typeof fetch !== 'function') return { sent: [], failed: [{ name: 'node', error: 'node 18 or newer is needed' }] };
  const json = { 'content-type': 'application/json' };
  const jobs = {
    telegram: async () => {
      const t = cfg.telegram;
      if (!t.chat_id) { t.chat_id = await telegramChat(t.token); if (persist) writeJSON(configFile, cfg); }
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
  results.forEach((r, i) => (r.status === 'fulfilled' ? out.sent.push(names[i]) : out.failed.push({ name: names[i], error: String(r.reason?.message || r.reason) })));
  if (!names.length) out.failed.push({ name: 'config', error: `no channel yet: run "notify.mjs setup" in a terminal (${configFile})` });
  return out;
}
const send = (text, excerpt) => sendWith(config(), text, true, excerpt);

// Finishes that were written but never delivered, sent now. The wizard saving a channel and a reopened
// chat both call this.
async function flushUnsent(cfg) {
  let files = []; try { files = readdirSync(markerDir).filter((f) => f.endsWith('.json')); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    const file = join(markerDir, f);
    const m = readJSON(file);
    if (!m?.done) continue;
    const r = await sendWith(cfg, `${m.text}\n(${m.question ? 'asked' : 'finished'} at ${m.done}; this could not be delivered at the time)`, false, m.excerpt);
    if (!r.sent.length) continue;
    n++;
    // A question that finally went out leaves the chat armed for its real finish.
    if (m.question) { clearDone(m); writeJSON(file, m); } else rmSync(file, { force: true });
  }
  return n;
}

// The END of the message: that is where a reply puts its verdict.
const tail = (s, n = 500) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? '...' + t.slice(-n) : t; };
const clearDone = (m) => { for (const k of ['text', 'excerpt', 'done', 'question', 'unsent']) delete m[k]; };

// The transcript is the fallback when the event carries no last_assistant_message. It is written
// asynchronously, so it may lag; the field is preferred.
function lastFromTranscript(file) {
  if (!file) return '';
  let lines; try { lines = readFileSync(file, 'utf8').split('\n'); } catch { return ''; }
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.type !== 'assistant') continue;
    const c = o.message?.content;
    const text = Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : typeof c === 'string' ? c : '';
    if (text.trim()) return text;
  }
  return '';
}

// quiet: hook mode, where stdout is context the chat reads; there failures go to stderr and success is silent.
function report(r, quiet) {
  if (r.sent.length && !quiet) console.log(`notify: sent to ${r.sent.join(', ')}`);
  for (const f of r.failed) console.error(`notify: ${f.name} failed: ${f.error}`);
  return r.sent.length ? 0 : 1;
}

async function hook() {
  let p = {};
  try { const raw = readFileSync(0, 'utf8'); p = raw ? JSON.parse(raw) : {}; } catch { return; }
  const session = p.session_id;
  if (!validSession(session)) return;
  const file = markerFile(session);
  const m = readJSON(file);
  if (!m) return;
  deadline = Date.now() + (p.hook_event_name === 'SessionStart' ? 4000 : 15000);
  const who = `${basename(m.cwd || p.cwd || process.cwd())}${m.label ? ': ' + m.label : ''}`;

  switch (p.hook_event_name) {
    case 'UserPromptSubmit':
      if (m.pending) { delete m.pending; writeJSON(file, m); }
      return;
    case 'Stop': {
      if (m.pending) return;
      const last = (p.last_assistant_message || lastFromTranscript(p.transcript_path) || '').trim();
      const question = /\?\s*$/.test(last);
      const head = question ? `${who} is waiting for your answer` : `${who} finished`;
      const note = m.resumed ? ' (the chat had been reopened after an interruption)' : '';
      m.text = `${head}${note}`;
      m.excerpt = tail(last);
      m.done = now();
      if (question) m.question = true; else delete m.question;
      writeJSON(file, m); // durable before the network: a message that never arrives loses nothing
      const r = await send(m.text, m.excerpt);
      if (!r.sent.length) { m.unsent = r.failed; writeJSON(file, m); report(r, true); return; }
      if (!question) { rmSync(file, { force: true }); return; }
      clearDone(m); m.asked = now(); writeJSON(file, m); // a question is not the finish: stay armed
      return;
    }
    case 'StopFailure':
      if (m.pending) return;
      m.failed = now(); writeJSON(file, m);
      report(await send(`${who} stopped on an error: ${p.error || 'unknown'}. Reopen the chat to continue.`), true);
      return;
    case 'Notification': {
      if (m.pending) return;
      if (!/^(permission_prompt|agent_needs_input|elicitation_dialog|elicitation_url_dialog)$/.test(p.notification_type || '')) return;
      if (m.waited && Date.now() - Date.parse(m.waited) < 5 * 60 * 1000) return;
      m.waited = now(); writeJSON(file, m);
      report(await send(`${who} needs you: ${p.message || p.notification_type}`), true);
      return;
    }
    case 'SessionStart': {
      if (p.source !== 'resume') return;
      if (m.done) { await flushUnsent(config()); return; }
      m.resumed = now(); writeJSON(file, m);
      const ago = p.seconds_since_last_response ? ` ${Math.round(p.seconds_since_last_response / 60)} minutes after its last response` : '';
      console.log(`A phone notification is armed for this chat (${who}), and the chat was reopened${ago} before it finished. ` +
        'Before anything else, check whether the task it was on is already complete. If it is, say so in one line and end the turn: ' +
        'the notification fires on that and tells the person the work was done before the restart. If it is not, continue the task; ' +
        'the notification fires when it ends.');
      return;
    }
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
  const queue = []; let waiter = null; let ended = false;
  rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else queue.push(l); });
  rl.on('close', () => { ended = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
  const ask = async (q, def = '') => {
    process.stdout.write(`${q}${def ? ` [${def}]` : ''}: `);
    const a = queue.length ? queue.shift() : ended ? null : await new Promise((r) => { waiter = r; });
    if (a === null) throw new Error('no input');
    return a.trim() || def;
  };
  const say = (...l) => console.log(l.join('\n'));
  const cfg = config();
  const test = `test from Claude Code on ${hostname()}: this channel works`;
  try {
    say('', 'Claude Code notifications - setup', channels(cfg).length ? `configured now: ${channels(cfg).join(', ')}` : '', '');
    for (;;) {
      const pick = await ask('Which channel? 1 Telegram, 2 Discord, 3 ntfy (no account, quickest)', '1');
      const ch = { 1: 'telegram', 2: 'discord', 3: 'ntfy' }[pick];
      if (!ch) continue;
      say('', ...STEPS[ch].map((l, i) => `  ${i + 1}. ${l}`), '');
      let one;
      if (ch === 'telegram') {
        const token = await ask('Paste the token');
        let me; try { me = await telegram(token, 'getMe'); } catch (e) { say(`  that token was refused: ${e.message}`, ''); continue; }
        say(`  Your bot is @${me.username}. Open https://t.me/${me.username} and press Start.`);
        await ask('Press Enter once you have pressed Start');
        one = normalise({ telegram: { token } });
      } else if (ch === 'discord') {
        const url = await ask('Paste the webhook URL');
        if (!url) { say('  nothing entered', ''); continue; }
        const buzz = await ask('Mention @everyone so the phone buzzes? y/n (yes on a private server)', 'y');
        one = normalise({ discord: { url, everyone: /^y/i.test(buzz) } });
      } else {
        const topic = 'claude-' + randomBytes(8).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'x');
        say(`  topic: ${topic}`);
        one = normalise({ ntfy: await ask('Press Enter once subscribed, or type a topic of your own', topic) });
      }
      if (!channels(one).length) { say('  nothing entered', ''); continue; }
      const r = await sendWith(one, test, false);
      if (!r.sent.length) { say(`  not delivered: ${r.failed.map((x) => x.error).join('; ')}`, '  Fix that and pick the channel again.', ''); continue; }
      Object.assign(cfg, one);
      writeJSON(configFile, cfg);
      say(`  delivered - check your phone. Saved ${ch} to ${configFile}`, '');
      const flushed = await flushUnsent(cfg);
      if (flushed) say(`  and ${flushed} message(s) that were waiting for a channel went out now`, '');
      if (!/^y/i.test(await ask('Add another channel? y/n', 'n'))) break;
    }
    say('', `done: ${channels(cfg).join(', ') || 'no channel'}. Any chat can now be told "ping me when this is done".`);
    rl.close();
    return 0;
  } catch (e) {
    rl.close();
    if (e.message !== 'no input') throw e;
    say('', 'notify: setup needs a terminal to type into. Run it there:', `  node "${process.argv[1]}" setup`);
    return 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const take = (flag) => { const i = args.indexOf(flag); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const has = (flag) => { const i = args.indexOf(flag); if (i < 0) return false; args.splice(i, 1); return true; };
  const cmd = args[0];
  if (!cmd) { await hook(); return 0; }

  if (cmd === 'send') return report(await send(args.slice(1).join(' ')));
  if (cmd === '--test') return report(await send(`test from Claude Code on ${hostname()}: this channel works`));
  if (cmd === 'setup') return setup();

  const list = channels(config());
  const session = take('--session') || process.env.CLAUDE_CODE_SESSION_ID;
  if (!session) { console.error('notify: no session id. Run this inside the chat, or pass --session <id>.'); return 1; }
  if (!validSession(session)) { console.error(`notify: "${session}" is not a session id (letters, digits, - and _ only)`); return 1; }
  const file = markerFile(session);

  if (cmd === '--status') {
    const m = readJSON(file);
    console.log(m ? `notify: armed${m.pending ? ' for the next turn' : ''} (${m.label || 'no label'}, since ${m.armed})` : 'notify: not armed for this chat');
    console.log(list.length ? `channels: ${list.join(', ')}` : `channels: none configured yet - run "notify.mjs setup" in a terminal (${configFile})`);
    return 0;
  }
  if (cmd === '--disarm') { rmSync(file, { force: true }); console.log('notify: disarmed'); return 0; }
  if (cmd === '--arm') {
    has('--arm');
    try { for (const f of readdirSync(markerDir)) { const p = join(markerDir, f); if (Date.now() - statSync(p).mtimeMs > 7 * 86400e3) rmSync(p, { force: true }); } } catch { /* nothing armed anywhere */ }
    const next = has('--next');
    const label = args.join(' ').trim();
    writeJSON(file, { armed: now(), label, cwd: process.cwd(), ...(next ? { pending: true } : {}) });
    console.log(`notify: armed${next ? ' for the end of the next turn' : ''}${label ? ` - "${label}"` : ''}`);
    if (list.length) console.log(`channels: ${list.join(', ')}`);
    else console.log('channels: none yet. The person runs "notify.mjs setup" in a terminal; the marker waits, and a finish that happens before that is delivered when a channel is saved.');
    return 0;
  }
  console.error(`notify: unknown argument ${cmd}`); return 2;
}

main().then((code) => process.exit(code || 0), (e) => { console.error(`notify: ${e.message}`); process.exit(process.argv[2] ? 1 : 0); });
