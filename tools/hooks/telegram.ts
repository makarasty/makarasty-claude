import type { EngineInterface } from 'claude-code'
import { explainPrompt, isTelegramPrompt, STALE_MS, TG_PROMPT, telegramWords, type Item } from '../skills/inbox/core.mjs'
import { collapsed, esc, explainHtml, helpHtml, note, phoneKeyboard, statusHtml } from '../skills/notify/render.mjs'
import { STRINGS, langOf, t } from '../skills/notify/strings.mjs'
import { writeHeard } from './consent.ts'

// The Telegram side of notify, read inside the hook engine: `$.http.fetch`, so polling starts no process. Every chat with
// the inbox on runs a 1 s timer here (startTelegram, from inbox.ts), its own: the inbox timer can be busy for a minute
// (an explanation, a push), and a tap waited minutes behind it (2026-11-17). One chat leads: it holds a long poll
// (getUpdates timeout 20), so a tap arrives within a second, and renews its lease before each one; another chat takes
// over once the lease is 30 s old (the leader closed or crashed). Where the engine cannot hold a long request, short
// polls every 2 s. The person's taps answer inbox items, "❔ Подробнее" writes the explanation on demand, a message he
// writes goes to the headless inbox turn (`inbox.mjs telegram`), never into a chat; only /start and the debug /status are
// answered here with no model. Layout under <config>/makarasty/telegram/:
//   polled          "<ms> <session>": the lease; the writer reads it back and polls only if it is still his
//   offset, lastok  getUpdates offset; when a poll last worked (a gap over 23 h is told: Telegram keeps updates 24 h)
//   seen.json       the last 300 update ids, written before an update's effects, so a second poller skips them
//   log.json        the last 100 handled updates: when the poll returned, how long handling took (the latency record)
//   asks/<msg>.json an open ask on the phone (notify.mjs ask writes it): item, html, short, options, reply, at
//   inbound/<update>.json  a message for the headless inbox: text, message_id, at, about (an ask's item), taken, done (ms)
// Design and edge cases: docs/TELEGRAM.md.

type D = Pick<EngineInterface, 'env' | 'fs' | 'http' | 'process' | 'plugin' | 'session' | 'clock' | 'model'>
// multi: a multi-select question (taps tick `sel`, "Done" sends); later: one of several, with a "Later" button.
type Ask = { item: string; html: string; short: string; options: string[]; reply: boolean; at: number; more?: boolean; closed?: number; q?: string; of?: number; multi?: boolean; sel?: number[]; later?: boolean }
type Msg = { message_id: number; chat: { id: number; type?: string }; from?: { id: number }; text?: string; caption?: string; reply_to_message?: { message_id: number }; forward_origin?: unknown; voice?: unknown; photo?: unknown; document?: unknown; sticker?: unknown; video?: unknown }
type Update = { update_id: number; message?: Msg; callback_query?: { id: string; from: { id: number }; data?: string; message?: Msg } }
export type Inbound = { id: number; text: string; message_id: number; at: number; about?: { item: string; short: string; answered?: boolean }; taken?: number; done?: number }

// The "Later" answer in every language: a pick that is one of these is no answer of his (inbox.ts phonePicks reads it too).
export const LATER: string[] = Object.values(STRINGS).map((s) => s.laterAnswer)
const LEASE_MS = 30000, LONG_S = 20, SHORT_MS = 2000, HUNG_MS = 60000, ALIVE_MS = 60000
const API = 'https://api.telegram.org'

async function configDir($: D): Promise<string | undefined> {
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  if (cfg) return cfg.replace(/[\\/]+$/, '')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? `${home.replace(/[\\/]+$/, '')}/.claude` : undefined
}
async function readJSON<T>($: D, p: string): Promise<T | undefined> {
  try { return JSON.parse(String(await $.fs.read(p)).replace(/^﻿/, '')) as T } catch { return undefined }
}
// The language of every word sent to the person: the Language: line of his profile, read at most once a minute.
let langAt = -Infinity, langIs = 'en'
async function lang($: D, dir: string): Promise<string> {
  const now = await $.clock.now()
  if (now - langAt < 60000) return langIs
  langIs = langOf(String(await $.fs.read(`${dir}/makarasty/profile.md`).catch(() => '')))
  langAt = now
  return langIs
}
// The bound chat, or undefined: a token with no chat bound at setup answers nobody.
export async function bot($: D, dir: string): Promise<{ token: string; me: string } | undefined> {
  const c = await readJSON<{ telegram?: { token?: unknown; chat_id?: unknown } }>($, `${dir}/makarasty/notify.json`)
  const token = c?.telegram?.token, me = c?.telegram?.chat_id
  return typeof token === 'string' && /^\d+:[\w-]{20,}$/.test(token) && (typeof me === 'string' || typeof me === 'number') && String(me) ? { token, me: String(me) } : undefined
}

// One Bot API call. A 429 waits what Telegram asks (up to 5 s); an HTML message Telegram cannot parse goes once as plain text.
async function call<T = unknown>($: D, token: string, method: string, body: Record<string, unknown>): Promise<T | undefined> {
  for (let i = 0; i < 2; i++) {
    const r = await $.http.fetch(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    let o: { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } } = {}
    try { o = JSON.parse(r.text) } catch { /* not JSON */ }
    if (o.ok) return o.result
    if (r.status === 429 && i === 0) { await $.clock.sleep(Math.min(5, o.parameters?.retry_after ?? 1) * 1000); continue }
    if (r.status === 400 && /parse entities/i.test(o.description ?? '') && body.parse_mode && i === 0) {
      body = { ...body, parse_mode: undefined, text: typeof body.text === 'string' ? body.text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : body.text }
      continue
    }
    throw Object.assign(new Error(`${r.status} ${o.description ?? ''}`.trim()), { status: r.status })
  }
  return undefined
}

// Every chat's own 1 s timer comes here; the lease decides who polls.
let timer: { cancel: () => void } | undefined
export function startTelegram($: D): void {
  timer ??= $.clock.every(1000, () => { void telegramTick($).catch(() => undefined) })
}
// The phone-only ask stops its poll once no question of its chat is open (inbox.ts phoneTick).
export function stopTelegram(): void { timer?.cancel(); timer = undefined }
let pausedUntil = 0
// One poll at a time in this chat: a slow tap ("Подробнее" waits up to 60 s on the model) must not let the timer start a
// second poll beside it. A poll stuck past a minute (a request the engine never ends) is given up, and long polls with it.
let polling = 0
let longOk = true, longRetry = 0
export async function telegramTick($: D): Promise<void> {
  const now = await $.clock.now()
  if (polling && now - polling < HUNG_MS) return
  if (polling) { longOk = false; longRetry = now + 600000 }
  polling = now
  try { await pollOnce($, now) } finally { polling = 0 }
}
// With no bot set up, the 1 s timer looks again only every 30 s: one file read, not one a second.
let unset = -Infinity
async function pollOnce($: D, now: number): Promise<void> {
  if (now < pausedUntil || now - unset < 30000) return
  const dir = await configDir($)
  if (!dir) return
  const b = await bot($, dir)
  if (!b) { unset = now; return }
  const tg = `${dir}/makarasty/telegram`
  const session = await $.session.id()
  const [lastS, who] = String(await $.fs.read(`${tg}/polled`).catch(() => '0')).split(' ')
  const last = Number(lastS) || 0
  if (who !== session && now - last < LEASE_MS) return // another chat leads and is alive
  if (!longOk && now >= longRetry) longOk = true
  if (who === session && !longOk && now - last < SHORT_MS) return
  const claim = `${now} ${session}`
  await $.fs.write(`${tg}/polled`, claim)
  if (String(await $.fs.read(`${tg}/polled`).catch(() => '')) !== claim) return // another chat claimed it at the same moment
  const offset = Number(String(await $.fs.read(`${tg}/offset`).catch(() => ''))) || Number(String(await $.fs.read(`${tg}/offset.bak`).catch(() => ''))) || 0
  const long = longOk
  let ups: Update[] | undefined
  try { ups = await call<Update[]>($, b.token, 'getUpdates', { offset, timeout: long ? LONG_S : 0, allowed_updates: ['message', 'callback_query'] }) }
  catch (e) {
    const st = (e as { status?: number }).status ?? 0
    // A revoked token (401) or a bot the person blocked (403): wait 10 min, never a loop of failures.
    if ([401, 403, 404].includes(st)) pausedUntil = now + 600000
    // 409: another getUpdates is open (a chat on an older version): let the lease lapse to it, try again later.
    else if (st === 409) await $.fs.write(`${tg}/polled`, `${now} other`).catch(() => undefined)
    // No HTTP status: the request itself failed; a long one may be what the engine cannot hold, so short polls for 10 min.
    else if (!st && long) { longOk = false; longRetry = now + 600000 }
    return
  }
  const got = await $.clock.now()
  // A chat that took the lease while this long poll waited (it found the lease stale): its batch, not this one's.
  if (String(await $.fs.read(`${tg}/polled`).catch(() => '')).split(' ')[1] !== session) return
  const lastOk = Number(String(await $.fs.read(`${tg}/lastok`).catch(() => '0'))) || 0
  await $.fs.write(`${tg}/lastok`, String(got))
  if (lastOk && got - lastOk > 23 * 3600e3) await send($, b, note(t(await lang($, dir), 'offline', { h: Math.round((got - lastOk) / 3600e3) })), { disable_notification: true }).catch(() => undefined)
  // $.fs has no delete: the last 300 update ids in one file, read again before each update and written before its effects.
  for (const u of ups ?? []) {
    const seen = ((await readJSON<number[]>($, `${tg}/seen.json`)) ?? []).filter((x) => typeof x === 'number')
    if (seen.includes(u.update_id)) continue
    seen.push(u.update_id)
    await $.fs.write(`${tg}/seen.json`, JSON.stringify(seen.slice(-300)))
    const start = await $.clock.now()
    let kind = 'other'
    try { kind = await handle($, dir, b, u, start) } catch { kind = 'error' } // one bad update never blocks the rest
    await $.fs.write(`${tg}/offset`, String(u.update_id + 1))
    await $.fs.write(`${tg}/offset.bak`, String(u.update_id + 1))
    // The latency record: with a long poll, `got` is within a second of the tap; `ms` is the handling (answer, edit).
    const log = ((await readJSON<object[]>($, `${tg}/log.json`)) ?? []).slice(-99)
    await $.fs.write(`${tg}/log.json`, JSON.stringify([...log, { at: got, update: u.update_id, kind, poll: long ? 'long' : 'short', ms: (await $.clock.now()) - start }]))
  }
  await sweep($, dir, b, await $.clock.now()).catch(() => undefined)
}

// Function declarations, not arrows, wherever `$` is passed: the engine follows `$` only into a declaration.
function send($: D, b: { token: string; me: string }, html: string, extra: Record<string, unknown> = {}) {
  return call<{ message_id: number }>($, b.token, 'sendMessage', { chat_id: b.me, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra })
}
const replyTo = (id: number) => ({ reply_parameters: { message_id: id, allow_sending_without_reply: true } })

// Returns what it was, for the log. A stranger, a group, a forwarded text: nothing, not even a reply.
async function handle($: D, dir: string, b: { token: string; me: string }, u: Update, now: number): Promise<string> {
  const tg = `${dir}/makarasty/telegram`
  const L = await lang($, dir)
  const cq = u.callback_query
  if (cq) {
    const ack = (text: string) => call($, b.token, 'answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => undefined)
    if (String(cq.from.id) !== b.me) { await ack(''); return 'stranger' }
    const msg = cq.message?.message_id ?? 0
    const a = await openAsk($, `${tg}/asks/${msg}.json`)
    if (!a) { await ack(t(L, 'ackClosed')); await call($, b.token, 'editMessageReplyMarkup', { chat_id: b.me, message_id: msg, reply_markup: { inline_keyboard: [] } }).catch(() => undefined); return 'tap-closed' }
    if (cq.data === 'm') { await ack(t(L, 'ackExplain')); await explain($, dir, b, msg, a); return 'more' }
    // Answered in the app meanwhile: say so at once, and the message collapses with it (a tick included).
    if (await $.fs.exists(`${dir}/makarasty/inbox/answers/${a.item}.json`)) {
      await ack(t(L, 'ackAnsweredApp'))
      await call($, b.token, 'editMessageText', { chat_id: b.me, message_id: msg, text: collapsed(a.short, t(L, 'outAnsweredApp')), parse_mode: 'HTML' }).catch(() => undefined)
      await close($, `${tg}/asks/${msg}.json`, a)
      return 'tap-answered'
    }
    const i = Number(/^a?(\d+)$/.exec(cq.data ?? '')?.[1] ?? NaN)
    if (a.multi && a.options[i] !== undefined) {
      // A multi-select question: the tap ticks or unticks; nothing is answered until "Done".
      const was = a.sel ?? [], ticked = { ...a, sel: was.includes(i) ? was.filter((x) => x !== i) : [...was, i].sort((x, y) => x - y) }
      await $.fs.write(`${tg}/asks/${msg}.json`, JSON.stringify(ticked))
      await ack('')
      await call($, b.token, 'editMessageReplyMarkup', { chat_id: b.me, message_id: msg, reply_markup: keyboardOf(ticked, !a.more, L) }).catch(() => undefined)
      return 'tick'
    }
    const later = cq.data === 's' && !!a.later
    const pick = later ? t(L, 'laterAnswer') : cq.data === 'd' && a.multi ? (a.sel ?? []).map((x) => a.options[x]).filter(Boolean).join(', ') || t(L, 'noneSelected') : a.options[i]
    if (pick === undefined) { await ack(t(L, 'ackClosed')); return 'tap-closed' }
    await ack(t(L, later ? 'ackLater' : 'ackTaken'))
    await answer($, dir, b, msg, a, pick, undefined, later ? t(L, 'outLater') : pick)
    return later ? 'later' : 'tap'
  }
  const m = u.message
  if (!m || m.chat.type !== 'private' || String(m.chat.id) !== b.me || String(m.from?.id) !== b.me || m.forward_origin) return 'ignored'
  const text = (m.text ?? m.caption ?? '').trim()
  if (!text) { await send($, b, esc(t(L, 'textOnly')), replyTo(m.message_id)).catch(() => undefined); return 'no-text' }
  const extra = !m.text && (m.photo || m.document || m.video) ? t(L, 'pictureNote') : ''
  // Plain text only (owner, 2026-11-17): /start says so; /status is a debug view, in no menu. Anything else, a
  // task in Obsidian or an "idea" included, is the inbox model's to do.
  const command = /^\/(\w+)(?:@\w+)?\s*$/.exec(text)
  if (command && ['start', 'help'].includes(command[1]!)) { await send($, b, helpHtml(L)).catch(() => undefined); return 'help' }
  if (command?.[1] === 'status') { await send($, b, await status($, dir, now, L)).catch(() => undefined); return 'status' }
  // A reply to an ask: a question about it goes to the inbox; anything else is the answer, where a free answer fits.
  const about = m.reply_to_message ? await openAsk($, `${tg}/asks/${m.reply_to_message.message_id}.json`) : undefined
  if (about && m.reply_to_message && !/[?？]\s*$/.test(text) && about.reply) { await answer($, dir, b, m.reply_to_message.message_id, about, text, m.message_id); return 'reply' }
  // Not a reply, while questions wait on the phone: he often just writes the answer as his next message (owner, 2026-11-27:
  // the question stayed up after he had answered it that way). The questions it answers are answered with his words.
  let routedTo: Ask | undefined
  if (!m.reply_to_message && !text.startsWith('/') && !/[?？]\s*$/.test(text)) {
    const routed = await routePlain($, tg, `${dir}/makarasty/inbox`, text, now, t(L, 'hidden'))
    // Questions of two different chats: a "да" could be either's push, so none is answered and he picks by Reply.
    if (new Set(routed.hits.map((h) => h.a.item)).size > 1) { await send($, b, note(t(L, 'whichQuestion')), replyTo(m.message_id)).catch(() => undefined); return 'plain-ambiguous' }
    for (const h of routed.hits) await answer($, dir, b, h.msg, h.a, h.pick, m.message_id)
    if (routed.hits.length && !routed.more) {
      await call($, b.token, 'setMessageReaction', { chat_id: b.me, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] }).catch(() => undefined)
      return 'plain-answer'
    }
    // It also asks for something: the inbox does that part, told the answer already went to that chat.
    routedTo = routed.hits[0]?.a
  }
  const told = routedTo ?? about
  const inbound: Inbound = { id: u.update_id, text: text + extra, message_id: m.message_id, at: now, ...(told ? { about: { item: told.item, short: told.short, ...(routedTo ? { answered: true } : {}) } } : {}) }
  await $.fs.write(`${tg}/inbound/${u.update_id}.json`, JSON.stringify(inbound))
  await call($, b.token, 'setMessageReaction', { chat_id: b.me, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: '👀' }] }).catch(() => undefined)
  // Always the headless inbox (a small Sonnet session), never a chat: a working Opus chat paid a whole turn per message and
  // was interrupted by it (2026-11-18: messages landed in five different working chats in two days).
  // A run still busy with an earlier message answers this one after it: say so now rather than leave him guessing.
  const busy = Number(String(await $.fs.read(`${tg}/headless.lock`).catch(() => '0'))) || 0
  if (now - busy < 8 * 60000) await send($, b, note(t(L, 'queued')), { ...replyTo(m.message_id), disable_notification: true }).catch(() => undefined)
  void $.process.run(['node', `${$.plugin.root}/skills/inbox/inbox.mjs`, 'telegram'], { timeoutMs: 400000, env: { CLAUDE_CONFIG_DIR: dir } }).catch(() => undefined)
  return 'inbound'
}

async function status($: D, dir: string, now: number, L: string): Promise<string> {
  const root = `${dir}/makarasty/inbox`
  const open: Item[] = []
  for (const f of await $.fs.list(`${root}/items`).catch(() => [])) {
    if (!f.name.endsWith('.json') || (await $.fs.exists(`${root}/answers/${f.name}`))) continue
    const it = await readJSON<Item>($, `${root}/items/${f.name}`)
    if (it && now - it.at < STALE_MS) open.push(it)
  }
  const beat = Number(String(await $.fs.read(`${root}/beat`).catch(() => '0'))) || 0
  const q = (it: Item) => (it.kind === 'ask' ? it.questions?.[0]?.question : it.kind === 'choice' ? it.ask : t(L, 'statusCard', { title: it.title ?? '' })) ?? ''
  const proj = (cwd: string) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? cwd
  const items = open.sort((x, y) => x.at - y.at).slice(0, 8).map((it) => ({ question: redact(q(it), t(L, 'hidden')).slice(0, 80), where: proj(it.cwd), age: t(L, 'ageMin', { n: Math.max(1, Math.round((now - it.at) / 60000)) }) }))
  return statusHtml(L, open.length, items, now - beat < ALIVE_MS)
}

// A plain message while questions wait: a small model says which of the open ones it answers (at most the latest eight).
// A line naming one of the question's options exactly answers with that option; any other line answers with his whole
// message, so the answer on record is always his own words or his option, never the model's. `more`: the message also
// asks for something else (or answers nothing), so it goes on to the inbox as well. A failed call answers nothing.
async function routePlain($: D, tg: string, root: string, text: string, now: number, hidden: string): Promise<{ hits: { msg: number; a: Ask; pick: string }[]; more: boolean }> {
  const open: { msg: number; a: Ask }[] = []
  for (const f of await $.fs.list(`${tg}/asks`).catch(() => [])) {
    if (!/^\d+\.json$/.test(f.name)) continue
    const a = await openAsk($, `${tg}/asks/${f.name}`)
    if (!a?.reply || now - a.at > STALE_MS || (await $.fs.exists(`${root}/answers/${a.item}.json`)) || !(await $.fs.exists(`${root}/items/${a.item}.json`))) continue
    open.push({ msg: Number(f.name.slice(0, -5)), a })
  }
  if (!open.length) return { hits: [], more: true }
  open.sort((x, y) => x.msg - y.msg).splice(0, Math.max(0, open.length - 8))
  const plain = (h: string) => h.split('\n').slice(0, 2).join(' · ').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  const prompt = [
    'Questions are waiting on the person\'s phone, numbered (question · project · position):',
    ...open.map((o, n) => `#${n + 1} ${redact(plain(o.a.html), hidden)}${o.a.options.length ? ` (options: ${o.a.options.map((x) => JSON.stringify(x)).join(' | ')})` : ''}`),
    'Then he wrote this message, not as a reply to any of them:', '<<<', text, '>>>',
    'Which of the questions does his message answer? Write one line "ANSWER <number>" for each question it clearly answers. ' +
    'Write NONE when it answers none of them (a new request, a question, a remark about something else), and NONE when you are not sure ' +
    'which question he means. Add a last line MORE when the message also asks for something beyond these answers. Nothing else.',
  ].join('\n')
  const r = await $.model.complete({ model: 'haiku', prompt, maxTokens: 200, timeoutMs: 30000 }).catch(() => undefined)
  if (!r?.isAnswered) return { hits: [], more: true }
  const hits: { msg: number; a: Ask; pick: string }[] = []
  // The answer is his message as he wrote it; an option only when the whole message is that option ("sqlite" → "SQLite"):
  // "Да, но сначала бэкап" must reach the chat whole, not as "Да".
  const norm = (s: string) => s.toLowerCase().replace(/[\s"'«».!]+/g, ' ').trim()
  for (const line of r.text.split('\n')) {
    const o = open[Number(/^\s*ANSWER\s+#?(\d+)\s*$/i.exec(line)?.[1] ?? 0) - 1]
    if (!o || hits.some((h) => h.msg === o.msg)) continue
    hits.push({ ...o, pick: (!o.a.multi && o.a.options.find((x) => norm(x) === norm(text))) || text })
  }
  return { hits, more: !hits.length || /^\s*MORE\s*$/m.test(r.text) }
}

// The keyboard of an open ask as it stands: ticks of a multi-select, "Later" of one question of several.
function keyboardOf(a: Ask, more: boolean, L: string) { return phoneKeyboard(a.options, more, L, { multi: a.multi, sel: a.sel, later: a.later }) }

// The tap or reply answers the item through `inbox.mjs answer`, as the inbox chat would; the message then collapses.
// `label`: what the collapsed line shows when it is not the pick itself ("later" for the long "Later" answer).
async function answer($: D, dir: string, b: { token: string; me: string }, msg: number, a: Ask, pick: string, replyId?: number, label = pick): Promise<void> {
  const L = await lang($, dir)
  // His tap or reply, on record before the answer file (consent.ts Heard): handle() checked it came from his Telegram id.
  const it = await readJSON<Item>($, `${dir}/makarasty/inbox/items/${a.item}.json`)
  const question = (it?.kind === 'choice' ? it.ask : it?.questions?.[0]?.question) ?? a.short
  let stdin = pick, pairs = [{ question, answer: pick }]
  if (a.q) {
    // One of several questions, one message each: the item is answered once every one of them has his pick.
    const p = `${dir}/makarasty/telegram/partial/${a.item}.json`
    const got = { ...((await readJSON<Record<string, string>>($, p)) ?? {}), [a.q]: pick }
    await $.fs.write(p, JSON.stringify(got))
    // Every one "Later": nothing to go on with, so nothing is sent and the dialog waits on the computer as it was.
    const allLater = Object.values(got).every((v) => LATER.includes(v))
    if (Object.keys(got).length < (a.of ?? 1) || allLater) {
      await call($, b.token, 'editMessageText', { chat_id: b.me, message_id: msg, text: collapsed(a.short, label), parse_mode: 'HTML' }).catch(() => undefined)
      await close($, `${dir}/makarasty/telegram/asks/${msg}.json`, a)
      return
    }
    stdin = JSON.stringify(got)
    pairs = Object.entries(got).map(([q, v]) => ({ question: q, answer: v }))
  }
  await writeHeard($, `${dir}/makarasty/inbox`, a.item, { at: await $.clock.now(), via: 'phone', pairs }).catch(() => undefined)
  const r = await $.process.run(['node', `${$.plugin.root}/skills/inbox/inbox.mjs`, 'answer', a.item], { stdin, timeoutMs: 20000, env: { CLAUDE_CONFIG_DIR: dir } }).catch(() => undefined)
  const line = `${r?.stdout ?? ''}\n${r?.stderr ?? ''}`.trim().split('\n').filter(Boolean).pop()?.replace(/^inbox: /, '') ?? t(L, 'outFailed')
  const sent = r?.exitCode === 0 && !/NOT SENT/.test(line)
  const outcome = sent ? label : /already answered/.test(line) ? t(L, 'outAlready', { pick: label }) : t(L, 'outNotSent', { pick: label, why: line.replace(/^answered \S+, NOT SENT to the chat: /, '') })
  await call($, b.token, 'editMessageText', { chat_id: b.me, message_id: msg, text: collapsed(a.short, outcome), parse_mode: 'HTML' }).catch(() => undefined)
  if (replyId && !sent) await send($, b, esc(outcome), replyTo(replyId)).catch(() => undefined)
  await close($, `${dir}/makarasty/telegram/asks/${msg}.json`, a)
}

// "❔ Подробнее": the explanation the inbox already made, or a small model's now; the buttons stay, without this one.
async function explain($: D, dir: string, b: { token: string; me: string }, msg: number, a: Ask): Promise<void> {
  const L = await lang($, dir)
  const file = `${dir}/makarasty/inbox/items/${a.item}.json`
  const it = await readJSON<Item>($, file)
  let text = it?.explain
  if (it && !text) {
    const r = await $.model.complete({ model: 'haiku', prompt: explainPrompt(it), maxTokens: 600, timeoutMs: 60000 }).catch(() => undefined)
    text = r?.isAnswered ? r.text.trim() : undefined
    const cur = text ? await readJSON<Item>($, file) : undefined
    if (cur && text) await $.fs.write(file, JSON.stringify({ ...cur, explain: text }))
  }
  const body = explainHtml(L, a.html, text ? redact(text, t(L, 'hidden')).slice(0, 1500) : undefined)
  await call($, b.token, 'editMessageText', { chat_id: b.me, message_id: msg, text: body, parse_mode: 'HTML', reply_markup: keyboardOf(a, false, L) }).catch(() => undefined)
  await $.fs.write(`${dir}/makarasty/telegram/asks/${msg}.json`, JSON.stringify({ ...a, html: body, more: true }))
}

// An ask answered on the computer, gone, or past the inbox's 12 h: collapsed, so no tap lands on a closed item.
async function sweep($: D, dir: string, b: { token: string; me: string }, now: number): Promise<void> {
  const tg = `${dir}/makarasty/telegram`, root = `${dir}/makarasty/inbox`, L = await lang($, dir)
  for (const f of await $.fs.list(`${tg}/asks`).catch(() => [])) {
    if (!/^\d+\.json$/.test(f.name)) continue
    const a = await openAsk($, `${tg}/asks/${f.name}`)
    if (!a) continue
    const why = (await $.fs.exists(`${root}/answers/${a.item}.json`)) ? t(L, 'outAnsweredPc') : !(await $.fs.exists(`${root}/items/${a.item}.json`)) ? t(L, 'outClosed') : now - a.at > STALE_MS ? t(L, 'outStale') : ''
    if (!why) continue
    await call($, b.token, 'editMessageText', { chat_id: b.me, message_id: Number(f.name.slice(0, -5)), text: collapsed(a.short, why), parse_mode: 'HTML' }).catch(() => undefined)
    await close($, `${tg}/asks/${f.name}`, a)
  }
}

// $.fs has no delete: a closed ask keeps its file with `closed`, and notify.mjs ask prunes closed files after two days.
async function openAsk($: D, p: string): Promise<Ask | undefined> { const a = await readJSON<Ask>($, p); return a && !a.closed ? a : undefined }
async function close($: D, p: string, a: Ask): Promise<void> { await $.fs.write(p, JSON.stringify({ ...a, closed: await $.clock.now() })).catch(() => undefined) }

export { TG_PROMPT, isTelegramPrompt, telegramWords }

// The secret shapes notify.mjs blanks in an excerpt, for what the engine sends (an explanation, an inbox answer).
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b\d{5,}:[\w-]{20,}/g, /(?<![A-Za-z0-9])sk-(?:ant-)?[\w-]{20,}/g, /sk_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{22,}/g, /(?:AKIA|ASIA)[0-9A-Z]{16}/g, /xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /AIza[\w-]{35}/g, /eyJ[\w-]{10,}\.eyJ[\w.-]*/g, /glpat-[\w-]{20,}/g, /npm_[A-Za-z0-9]{36}/g, /SG\.[\w-]{22}\.[\w-]{43}/g,
  /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/gi,
]
export const redact = (s: string, mask: string): string => SECRETS.reduce((text, re) => text.replace(re, mask), s)
  .replace(/(["']?(?:api[_-]?key|secret|token|password|bearer)["']?)([ \t]*[:=]?[ \t]*)("[^"\n]+"|'[^'\n]+'|\S+)/gi,
    (all, k: string, sep: string, v: string) => (sep.trim() || /^bearer/i.test(k)) && (/^["']/.test(v) || (v.length >= 8 && /\d/.test(v))) ? `${k}${sep}${mask}` : all)
