import type { EngineInterface, Register } from 'claude-code'
import { PUSH_AFTER_MS, clean, contextOf, continueAnswer,deliveryText, dueReports, excerptOf, explainPrompt, itemId, ownedBy, safe, toResult, type Answer, type Item, type Report } from '../skills/inbox/core.mjs'
import { find as secretIn } from './secret-guard.ts'
import { notePrompt } from './push-guard.ts'
import { PLUGIN_FRAME, ownWords } from './own-words.ts'

// The cross-chat inbox (skill /makarasty-tools:inbox, layout in skills/inbox/core.mjs). Off unless
// <config>/makarasty/inbox.on exists. In every chat it:
//   1. AskUserQuestion: writes the item, shows the dialog as before, and races it against the inbox; whichever answers
//      first wins. An inbox answer is returned as the tool's own result, so the model reads it as the dialog's [M63].
//   2. wrap_up with an `ask`, and an own_initiative session card: writes the item after the call; an inbox answer comes
//      back as a prompt this chat's timer submits once the chat is idle [M63].
//   3. Every 15 s (own items only): after 2 min unanswered, a plain explanation by a small model and one phone message.
//   4. A prompt the person types here closes this chat's open boxes; a started card closes its card item.
//   5. A chat switched on for finish reports (reports/on/<id>: every session the inbox chat starts, or `inbox.mjs report
//      on`) writes one report per working turn it ends: wrap_up called, or the turn died on an error. Not when the turn
//      left a question (its item carries the recap), not for a /loop tick. The inbox chat is woken about reports in
//      batches (core.mjs QUIET_MS / MAX_MS), with the next item wake, or when the person types there.
// Measured need: 608 asks a month, p90 wait 23 min, 24.5% answered in free text, 32 "unclear" complaints [M63].

type D = Pick<EngineInterface, 'env' | 'fs' | 'process' | 'plugin' | 'session' | 'clock' | 'model' | 'prompt'>

const TICK_MS = 15000
const WAIT_MS = 590000 // one waiter lives at most this long, then is started again: $.process.run refuses over 600000

// `$.env.get` takes a literal name. On Windows node's homedir() is USERPROFILE; Git Bash's HOME is a /c/... path.
async function claudeDir($: D): Promise<string | undefined> {
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  if (cfg) return cfg.replace(/[\\/]+$/, '')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? `${home.replace(/[\\/]+$/, '')}/.claude` : undefined
}

// The inbox's folder when it is on and this chat is not the inbox itself, else undefined.
async function active($: D): Promise<{ dir: string; root: string; session: string } | undefined> {
  const dir = await claudeDir($)
  if (!dir || !(await $.fs.exists(`${dir}/makarasty/inbox.on`))) return undefined
  const root = `${dir}/makarasty/inbox`, session = await $.session.id()
  const self = await $.fs.read(`${root}/self`).catch(() => '')
  return String(self).trim() === session ? undefined : { dir, root, session }
}

// The same folder when the inbox is on and this chat IS the inbox (the last chat that ran `inbox.mjs list`).
async function inboxSelf($: D): Promise<{ dir: string; root: string; session: string } | undefined> {
  const dir = await claudeDir($)
  if (!dir || !(await $.fs.exists(`${dir}/makarasty/inbox.on`))) return undefined
  const root = `${dir}/makarasty/inbox`, session = await $.session.id()
  const self = await $.fs.read(`${root}/self`).catch(() => '')
  return String(self).trim() === session ? { dir, root, session } : undefined
}

// Function declarations, not arrows: router.ts imports this file, and the engine follows `$` past an import only into
// a function declaration.
function cli($: D, dir: string, args: string[], timeoutMs = 20000) {
  return $.process.run(['node', `${$.plugin.root}/skills/inbox/inbox.mjs`, ...args], { timeoutMs, env: { CLAUDE_CONFIG_DIR: dir } })
}

// The person's standing rule that "continue?" questions are answered yes: the line of profile.md or answers.md that says so, or
// undefined. Narrow on purpose: "Continue questions: ... answered yes", or "Continue: yes"; a line with a negation is no rule.
async function continueRule($: D, dir: string): Promise<string | undefined> {
  for (const f of ['profile.md', 'answers.md']) {
    const text = String(await $.fs.read(`${dir}/makarasty/${f}`).catch(() => ''))
    // Sentence by sentence (a profile line often holds several): the rule and the negation are judged in the same sentence.
    for (const raw of text.split(/[.;!?\n]+/)) {
      const l = raw.replace(/^[\s\-*•>]+/, '').trim()
      if ((/\bcontinue questions?\b[^\n]*\banswered yes\b/i.test(l) || /^continue:\s*yes\b/i.test(l)) && !/never|не |нет|ask me|спрашивай/i.test(l)) return l
    }
  }
  return undefined
}

async function readJSON<T>($: D, path: string): Promise<T | undefined> {
  try { return JSON.parse(String(await $.fs.read(path)).replace(/^﻿/, '')) as T } catch { return undefined }
}

// Where an item or a report comes from: the chat (its first prompt), its folder, the desktop app's own id for it (a link
// opens it) and the account it runs under.
async function origin($: D, a: { session: string }, msgs: readonly { role: string; text: string }[]) {
  const first = msgs.map((m) => (m.role === 'user' ? clean(m.text) : '')).find(Boolean) ?? ''
  return {
    session: a.session, cwd: await $.session.cwd(), chat: `${first.slice(0, 70)}${first.length > 70 ? '…' : ''} (${a.session.slice(0, 8)})`,
    host: (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')) || undefined, account: (await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')) || undefined,
  }
}

// `before` runs once the id is known and before the item file is written (an answer written there is never seen as open).
async function newItem($: D, a: { root: string; session: string }, toolUseId: string | undefined, fields: Pick<Item, 'kind'> & Partial<Item>, before?: (id: string) => Promise<void>): Promise<Item> {
  const now = await $.clock.now()
  const msgs = await $.session.messages().catch(() => [])
  const item = { id: itemId(a.session, toolUseId ?? String(now)), at: now, ...(await origin($, a, msgs)), context: contextOf(msgs), ...fields }
  await before?.(item.id)
  await $.fs.write(`${a.root}/items/${item.id}.json`, JSON.stringify(item))
  return item
}

// The timer starts with the chat's first prompt or watched tool call: session.start is router.ts's (one unmatched hook per
// event and module). shortcut: a chat restarted with a delivered-to-it answer waiting gets it after its next prompt.
// Ask items this process has a live dialog and waiter for; an answered ask not in it is a dead dialog (chat restarted, plugin reloaded).
const waited = new Set<string>()
let timer: ReturnType<D['clock']['every']> | undefined
// This main turn's wrap_up recap (set once the call went through, cleared when the turn starts and ends) and where the
// turn's prompt came from. shortcut: a plugin reload between the wrap_up and the turn's end loses the mark, so that one
// finish is not reported; upgrade to a file if reports are seen missing.
let wrapRecap: string | undefined
let turnOrigin: string | undefined
// The main turn is running. The inbox chat sends no wake then: a prompt queued mid-turn enters only after it, by when
// the person has often answered its items (2026-11-12: "3 new items" woke it, all three answered, list "nothing pending").
let inTurn = false
// Called from router.ts's session.start too (one unmatched hook per event and module): it runs again when the plugin
// reloads (an update), which drops this timer, so the inbox chat is not left without its wake.
export async function startInboxTimer($: D): Promise<void> {
  if (!timer && ((await active($).catch(() => undefined)) || (await inboxSelf($).catch(() => undefined)))) startTimer($)
}
function startTimer($: D): void {
  if (timer) return
  let busy = false
  timer = $.clock.every(TICK_MS, () => {
    if (busy) return
    busy = true
    void tick($).catch(() => undefined).finally(() => { busy = false })
  })
}

export const register: Register = (on) => {
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.tool !== 'AskUserQuestion') return next(e)
    const source = e.metadata?.source ?? ''
    const flagged = source.startsWith('inbox:') ? source.slice(6).split(',').filter(Boolean) : []
    const me = await inboxSelf($).catch(() => undefined)
    if (me) {
      const deny = await inboxChatDeny($, me, source)
      if (deny) return { deny }
    }
    if (source === 'inbox' || source.startsWith('inbox:')) return inboxAsk($, e, next, flagged)
    const a = await active($)
    if (!a) return next(e)
    startTimer($)
    const questions = e.questions.map((q) => ({ ...q, options: [...q.options] }))
    // A "continue?" for work already under way, and the person said continue questions are answered yes: answered at once.
    // The value says who answered, so the asking chat does not take it for the person's own words; auto.jsonl is what `list` shows him.
    const standing = continueAnswer({ kind: 'ask', questions } as Item)
    const rule = standing ? await continueRule($, a.dir) : undefined
    const got: { auto?: Answer } = {} // set in the callback: a bare `let` is narrowed to undefined after it
    const item = await newItem($, a, e.tool_use_id, { kind: 'ask', questions }, async (id) => {
      if (!standing || !rule || (await $.fs.exists(`${a.root}/answers/${id}.json`))) return
      const by = (label: string) => `${label} [answered by the person's standing rule: "${rule}"]`
      got.auto = { id, at: await $.clock.now(), by: 'inbox', answers: Object.fromEntries(Object.entries(standing).map(([q, l]) => [q, by(l)])), standing: true }
      await $.fs.write(`${a.root}/answers/${id}.json`, JSON.stringify(got.auto))
    })
    const auto = got.auto
    if (auto && standing && rule) {
      // shortcut: read-and-rewrite (no append in $.fs); two chats auto-answering within milliseconds can lose a line.
      const old = String(await $.fs.read(`${a.root}/auto.jsonl`).catch(() => ''))
      const lines = Object.entries(standing).map(([question, label]) => JSON.stringify({ at: auto.at, id: item.id, chat: item.chat, question, label, rule }))
      await $.fs.write(`${a.root}/auto.jsonl`, `${old}${old && !old.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`).catch(() => undefined)
      await $.fs.write(`${a.root}/delivered/${item.id}`, String(await $.clock.now())).catch(() => undefined) // returned here, not to be delivered again
      return { result: toResult(item, auto) }
    }
    let settled = false
    waited.add(item.id)
    try {
    const dialog = next(e).then((r) => { settled = true; return { r } }, (err: unknown) => { settled = true; return { err } })
    const inbox = (async (): Promise<Answer | undefined> => {
      while (!settled) {
        const r = await cli($, a.dir, ['wait', item.id, String(WAIT_MS - 10000)], WAIT_MS).catch(() => undefined)
        if (r?.exitCode === 0) return JSON.parse(r.stdout) as Answer
        if (!r || r.exitCode !== 3) return undefined // the waiter cannot run: the dialog alone answers, as without the inbox
      }
      return undefined
    })()
    const won = await Promise.race([dialog.then((d) => ({ d })), inbox.then((ans) => ({ ans }))])
    if ('ans' in won && won.ans && won.ans.by === 'inbox') {
      await $.fs.write(`${a.root}/delivered/${item.id}`, String(await $.clock.now())).catch(() => undefined) // the chat has it: the tick must not send it again
      return { result: toResult(item, won.ans) }
    }
    const d = 'd' in won ? won.d : await dialog
    // Answered here (or Esc): the item leaves the inbox; the waiter sees the answer file and exits.
    await cli($, a.dir, ['done', item.id]).catch(() => undefined)
    // An inbox answer that landed as the dialog closed is not the chat's answer: mark it taken so the tick does not deliver it.
    if (await $.fs.exists(`${a.root}/answers/${item.id}.json`)) await $.fs.write(`${a.root}/delivered/${item.id}`, String(await $.clock.now())).catch(() => undefined)
    if ('err' in d) throw d.err
    return d.r
    } finally { waited.delete(item.id) }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const r = await next(e)
    const input = e as unknown as { ask?: string; recap?: string; actions?: { label?: string; action?: string }[]; tool_use_id?: string; agentId?: string }
    if (!r.isError && !r.deny && !input.agentId) wrapRecap = String(input.recap ?? '').trim()
    if (!input.ask?.trim() || r.isError || r.deny) return r
    const a = await active($)
    if (a) startTimer($)
    if (a && !(await holding($, a).catch(() => false)) && (await reasked($, a, input.ask).catch(() => 'new')) === 'new') await newItem($, a, input.tool_use_id, { kind: 'choice', ask: input.ask, recap: input.recap, actions: (input.actions ?? []).map((x) => x.label ?? x.action ?? '').filter(Boolean) }).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__ccd_session__start_session' }, async ($, e, next) => {
    const r = await next(e)
    const input = e as unknown as { initiation?: string; title?: string; prompt?: string; background?: string; tool_use_id?: string }
    const text = r.text ?? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? ''))
    const taskId = /task_id:\s*(task_\w+)/.exec(text)?.[1]
    // A session the inbox chat starts reports its finishes here (the operator's rule: reports from the coordinator's chats).
    const started = !r.isError && !r.deny && input.initiation !== 'own_initiative' ? /local_[0-9a-f]{8}-[0-9a-f-]{27}/.exec(text)?.[0] : undefined
    const me = started ? await inboxSelf($).catch(() => undefined) : undefined
    if (me && started) await $.fs.write(`${me.root}/reports/on/${started}`, `started ${await $.clock.now()}`).catch(() => undefined)
    if (input.initiation !== 'own_initiative' || !taskId || r.isError || r.deny) return r
    const a = await active($)
    if (a) startTimer($)
    if (a && !(await holding($, a).catch(() => false))) await newItem($, a, input.tool_use_id, { kind: 'card', title: input.title, brief: input.prompt, background: input.background, taskId }).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    wrapRecap = undefined // a subagent's run raises no turn.start: this is the main loop's
    inTurn = true
    await markTurn($, 'busy').catch(() => undefined)
    const me = await inboxSelf($).catch(() => undefined)
    if (me) await $.fs.write(`${me.root}/turn`, `busy ${await $.clock.now()}`).catch(() => undefined) // the watchdog reads it
    return next(e)
  }).catch(($, e, next) => next(e))

  // A turn that ends with a question in prose only: it becomes a box item, unless the turn already asked formally.
  // A working turn of a chat switched on for reports, with no question left: one finish report.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const recap = e.agentId ? undefined : wrapRecap
    const origin = e.agentId ? undefined : turnOrigin
    if (!e.agentId) { wrapRecap = undefined; turnOrigin = undefined; inTurn = false }
    await startInboxTimer($).catch(() => undefined)
    if (e.agentId) return r
    const me = await inboxSelf($).catch(() => undefined)
    if (me) {
      await $.fs.write(`${me.root}/turn`, `idle ${await $.clock.now()}`).catch(() => undefined)
      // At once, not at the next tick: items that came in while this turn ran (2026-11-12: a dialog here stayed open an
      // hour, three items arrived, and the person typed his next prompt 9 s after it closed, before any tick) [M63].
      void wakeOnce($, me).catch(() => undefined)
      return r
    }
    turnCompleted = true
    const mine = await markTurn($, 'idle').catch(() => undefined)
    if (mine) void deliverOnce($, mine).catch(() => undefined) // answers that came in while this turn ran
    if (e.isAborted || (e.reason !== 'answer' && e.reason !== 'error')) return r
    const a = await active($).catch(() => undefined)
    if (!a || (await holding($, a).catch(() => false))) return r
    const q = e.reason === 'answer' ? proseQuestion(e.answer ?? '') : undefined
    // Every working turn of an enrolled chat: a plain reply with no wrap_up is a finish too (2026-11-12: a started tests session's second finish, a 6 min timeout, wrote nothing).
    // Not a turn the person typed (he is in that chat and sees it), not a /loop tick, and not a one-word reply with no recap.
    const quiet = e.reason !== 'error' && !recap && (e.answer ?? '').trim().split(/\s+/).filter(Boolean).length < 2
    const reports = origin !== 'scheduled-trigger' && origin !== 'composer' && origin !== 'bridge' && !quiet && (await enrolled($, a))
    if (!q && !reports) return r
    const since = (await $.clock.now()) - (e.durationMs ?? 0) - 1000
    const asked = (await openItems($, a)).some((it) => it.at >= since && it.kind !== 'card') // a card is no question and no finish
    if (q && !asked) {
      startTimer($)
      const tail = (e.answer ?? '').trim()
      if ((await reasked($, a, q).catch(() => 'new')) === 'new') await newItem($, a, `turn-${e.turnId}`, { kind: 'choice', ask: q, recap: tail.length > 700 ? `…${tail.slice(-700)}` : tail, actions: [] }).catch(() => undefined)
    } else if (reports && !asked) {
      const started = await startedBy($, a)
      await finishReport($, a, e, recap, started || e.reason === 'error' || waitsOnPerson(e.answer ?? ''), started).catch(() => undefined)
    }
    return r
  }).catch(($, e, next) => next(e))

  // The person answered here, or a card was started by a click: close those items so the inbox stops showing them.
  on('prompt.submit', async ($, e, next) => {
    notePrompt(e) // push-guard's turn word: the engine takes one prompt.submit hook per module, and this is it
    if (!timer && ((await active($).catch(() => undefined)) || (await inboxSelf($).catch(() => undefined)))) startTimer($)
    if (!e.turnId) turnOrigin = e.origin?.kind // a prompt that starts a turn (one delivered into a running turn does not)
    const started = /started your suggested background task (task_\w+)/.exec(e.text)?.[1]
    const typed = e.origin?.kind === 'composer' || e.origin?.kind === 'bridge'
    if (typed) await capture($, e.text).catch(() => undefined)
    if (typed) {
      // The person writes to the inbox chat: the finish reports waiting for their batch go with this prompt.
      const me = await inboxSelf($).catch(() => undefined)
      const waiting = me ? await waitingReports($, me).catch(() => []) : []
      if (me && waiting.length) {
        for (const w of waiting) await $.fs.write(`${me.root}/reports/announced/${w.id}`, '').catch(() => undefined)
        return next({ ...e, context: [...(e.context ?? []), `Inbox: ${finishedLine(waiting)} Show them with the makarasty-tools inbox skill (inbox.mjs list) along with what the person asks.`] })
      }
    }
    if (!started && !typed) return next(e)
    const a = await active($).catch(() => undefined)
    if (a) {
      const own = await openItems($, a)
      for (const it of own) if ((typed && it.kind === 'choice') || (started && it.kind === 'card' && it.taskId === started)) await cli($, a.dir, ['done', it.id]).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

}

// The inbox chat's own dialog (metadata.source `inbox:<id>,<id>`): when the person answers every one of those items in
// its own chat first, the dialog here closes by itself instead of hanging on a question nobody waits for any more.
export const ANSWERED_THERE = '[answered in its own chat]'
// The queue: a dialog here that has waited REFRESH_MS when a new item comes in is closed and asked again with every open
// item, so a person who comes back sees all of them at once, not the one asked before he left (2026-11-12: 12 of the
// inbox chat's 38 dialogs had an item come in while open and still waiting when it closed; one stayed open 59 min) [M63].
export const REFRESH_MS = 10 * 60 * 1000
export const NOT_YET = '[not answered yet: more items came in while this dialog waited; ask again with every open item, these first]'
let openDialog: { since: number; refresh: () => void } | undefined
async function inboxAsk($: D, e: { questions: readonly { question: string }[] }, next: (e: never) => Promise<unknown>, ids: string[]): Promise<never> {
  const dir = await claudeDir($)
  if (!ids.length || !dir) return next(e as never) as never
  const refreshed = new Promise<true>(async (r) => { openDialog = { since: await $.clock.now(), refresh: () => r(true) } })
  try { return await inboxDialog($, e, next, ids, dir, refreshed) } finally { openDialog = undefined }
}
async function inboxDialog($: D, e: { questions: readonly { question: string }[] }, next: (e: never) => Promise<unknown>, ids: string[], dir: string, refreshed: Promise<true>): Promise<never> {
  let settled = false
  const dialog = next(e as never).then((r) => { settled = true; return { r } }, (err: unknown) => { settled = true; return { err } })
  const there = (async (): Promise<boolean> => {
    while (!settled) {
      const r = await cli($, dir, ['wait', ids.join(','), String(WAIT_MS - 10000)], WAIT_MS).catch(() => undefined)
      if (r?.exitCode === 0) return true
      if (!r || r.exitCode !== 3) return false
    }
    return false
  })()
  const won = await Promise.race([dialog.then((d) => ({ d })), there.then((t) => ({ t })), refreshed.then((f) => ({ f }))])
  if ('f' in won) { settled = true; return { result: { questions: e.questions, answers: Object.fromEntries(e.questions.map((q) => [q.question, NOT_YET])) } } as never }
  if ('t' in won && won.t) return { result: { questions: e.questions, answers: Object.fromEntries(e.questions.map((q) => [q.question, ANSWERED_THERE])) } } as never
  const d = 'd' in won ? won.d : await dialog
  if ('err' in d) throw d.err
  return d.r as never
}

// The inbox chat asked a chat's question without the inbox flag, so its dialog stayed open after the person answered in
// the asking chat, and they answered twice (2026-11-12): refused here, not left to SKILL.md. A question of a session the
// inbox chat started is asked here like any other (1.19.11 refused it, assuming the app shows that session's dialog in
// this chat; the operator did not see it there and answered it in its own chat unprompted).
async function inboxChatDeny($: D, me: { dir: string; root: string; session: string }, source: string): Promise<string | undefined> {
  if (source) return undefined
  const open = await openItems($, me, false)
  if (!open.length) return undefined
  const ids = open.map((it) => it.id)
  return `This chat is the inbox and ${ids.length} item${ids.length > 1 ? 's' : ''} from other chats ${ids.length > 1 ? 'are' : 'is'} open (${ids.join(', ')}). If this dialog asks any of them, call AskUserQuestion again with metadata {"source": "inbox:<the ids it asks, comma-separated>"}, so it closes by itself once the person answers in the asking chat. A question of this chat's own: metadata {"source": "inbox"}.`
}

// The inbox chat rewords a question when it asks it, so compare words, not text: at least half of the shorter side's
// words of 4+ letters appear in the other. shortcut: word overlap, misses a full paraphrase; upgrade if one slips by.
export function sameQuestion(a: string, b: string, min = 0.5): boolean {
  const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]{3,}/gu) ?? []).map((w) => w.replace(/[._-]+$/, '')))
  const [x, y] = [words(a), words(b)]
  const small = x.size < y.size ? x : y, big = small === x ? y : x
  if (small.size < 3) return false
  let n = 0
  for (const w of small) if (big.has(w)) n++
  return n / small.size >= min
}

// The hold command is collecting in this chat (its list starts with `collecting`, as gates.ts reads it): each turn only
// files a complaint, so its reply is neither a question for the person nor a finish (2026-11-12: a hold chat's
// "«123 patients counted» (?" filed as a box and woke the inbox per complaint).
async function holding($: D, a: { dir: string; session: string }): Promise<boolean> {
  for (const f of [`${a.dir}/makarasty/hold/${a.session}/index.md`, `${a.dir}/makarasty/hold/${a.session}.md`]) {
    const t = await $.fs.read(f).catch(() => '')
    if (!t) continue
    if (!/^\s*collecting\b/.test(String(t))) return false
    const m = await $.fs.stat(f).then((s) => s.mtimeMs, () => undefined) // as gates.ts: a list untouched for a day is stale
    return m === undefined || (await $.clock.now()) - m < 86400000
  }
  return false
}

// A chat the inbox chat started (reports/on/<id> holds "started ..." when `start` or a start_session child wrote it, not a
// timestamp alone as `report on` and `follow` leave): its finishes are urgent (the person asked to hear of each at once) and
// never folded into an earlier one when shown. The per-chat limit (urgentRecently) keeps a chat that finishes on every
// notification, a fleet coordinator, from waking more than once in 10 min.
async function startedBy($: D, a: { root: string; session: string }): Promise<boolean> {
  for (const id of [a.session, await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')]) {
    if (id && String(await $.fs.read(`${a.root}/reports/on/${safe(id)}`).catch(() => '')).startsWith('started')) return true
  }
  return false
}

// A last message that waits on the person: it ends in a question, or names a step only he can do. shortcut: a few
// phrases in English and Russian over the last 500 chars; upgrade if a waiting finish is seen going to the batch.
const HIS_STEP = /(?<!\p{L})(you need to|you must|your turn|please run|run (this|it) (yourself|in your)|waiting for you|need(s)? your|нужно (тебе|вам|от тебя)|тебе нужно|твой ход|ваш ход|жду (тебя|твоего|вас)|запусти(те)? (сам|у себя)|сделай(те)? сам)/iu
// Said of nobody's duty: "nothing you need to do", "if you must", «если тебе нужно», «ничего делать не нужно».
const NOT_HIS_STEP = /(?<!\p{L})(nothing|no need|not need|don't need|do not need|if|unless|when|whether|ничего|не нужно|не надо|если|когда)(?!\p{L})/iu
function waitsOnPerson(answer: string): boolean {
  return proseQuestion(answer) !== undefined || answer.slice(-500).split(/[.;!?\n]+/).some((sentence) => HIS_STEP.test(sentence) && !NOT_HIS_STEP.test(sentence))
}

// One urgent wake per chat per 10 min: its later urgent reports in the window wait for the batch.
const URGENT_EVERY_MS = 10 * 60 * 1000
async function urgentRecently($: D, a: { root: string; session: string }, now: number): Promise<boolean> {
  for (const f of await $.fs.list(`${a.root}/reports`).catch(() => [])) {
    if (!f.name.endsWith('.json') || !ownedBy(f.name, a.session)) continue
    const r = await readJSON<Report>($, `${a.root}/reports/${f.name}`)
    if (r?.urgent && now - r.at < URGENT_EVERY_MS) return true
  }
  return false
}

// Switched on for finish reports: by this chat's session id or its app id (the inbox knows the app id of what it starts).
async function enrolled($: D, a: { root: string; session: string }): Promise<boolean> {
  if (await $.fs.exists(`${a.root}/reports/on/${safe(a.session)}`)) return true
  const host = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  return !!host && (await $.fs.exists(`${a.root}/reports/on/${safe(host)}`))
}

// One file per finish, written once: the wrap_up recap and the final message cut short. A reply that holds a secret is
// not copied: the report says to open the chat.
async function finishReport($: D, a: { root: string; session: string }, e: { answer?: string; turnId: string; reason: string }, recap: string | undefined, urgent: boolean, started: boolean): Promise<void> {
  const answer = e.answer ?? ''
  const now = await $.clock.now()
  if (urgent && (await urgentRecently($, a, now).catch(() => false))) urgent = false
  const hit = secretIn(`${recap ?? ''}\n${answer}`)
  const rep: Report = {
    id: itemId(a.session, `turn-${e.turnId}`), at: now, ...(await origin($, a, await $.session.messages().catch(() => []))),
    ...(hit ? { excerpt: `[a ${hit.kind} in the reply: open the chat]` } : { recap: recap || undefined, excerpt: excerptOf(answer) || undefined }),
    ...(e.reason === 'error' ? { error: true } : {}), ...(urgent ? { urgent: true } : {}), ...(started ? { started: true } : {}),
  }
  await $.fs.write(`${a.root}/reports/${rep.id}.json`, JSON.stringify(rep))
}

// Reports from other chats the inbox chat was not woken about and has not shown yet.
async function waitingReports($: D, me: { root: string; session: string }): Promise<Report[]> {
  const names = async (d: string) => new Set((await $.fs.list(d).catch(() => [])).map((f) => f.name))
  const [told, seen] = [await names(`${me.root}/reports/announced`), await names(`${me.root}/reports/seen`)]
  const out: Report[] = []
  for (const f of await $.fs.list(`${me.root}/reports`).catch(() => [])) {
    const id = f.name.slice(0, -5)
    if (!f.name.endsWith('.json') || ownedBy(id, me.session) || told.has(id) || seen.has(id)) continue
    const r = await readJSON<Report>($, `${me.root}/reports/${f.name}`)
    if (r) out.push(r)
  }
  return out
}

function finishedLine(reports: Report[]): string {
  const projects = [...new Set(reports.map((r) => r.cwd.split(/[\\/]/).filter(Boolean).pop()))].join(', ')
  const chats = new Set(reports.map((r) => r.session)).size
  return `${chats} chat${chats > 1 ? 's' : ''} finished work (${reports.length} finish report${reports.length > 1 ? 's' : ''}: ${projects}).`
}

// A box this chat asks again, its words 70% or more those of one it asked before (2026-11-12, 46 items of 20 chats:
// 3 such re-asks, and the person answered twice each time; different questions of one chat overlapped 50% at most):
// - its earlier box still open: that one is closed as superseded (kept on disk, so the history stays), 'new';
// - its earlier box answered from the inbox and that answer not yet delivered (it waits for the turn's end): the answer is
//   delivered, so the new one is not filed, 'queued';
// - answered and delivered: the chat has read it and asks anew, so the new box is always filed, 'new'.
// Only boxes: an AskUserQuestion item lives as long as its dialog, a card until it is started or declined.
export const SAME_ASK = 0.7
async function reasked($: D, a: { dir: string; root: string; session: string }, ask: string): Promise<'new' | 'queued'> {
  const names = await $.fs.list(`${a.root}/items`).catch(() => [])
  let queued = false
  for (const f of names) {
    if (!f.name.endsWith('.json') || !ownedBy(f.name, a.session)) continue
    const it = await readJSON<Item>($, `${a.root}/items/${f.name}`)
    if (!it || it.kind !== 'choice' || !it.ask || !sameQuestion(ask, it.ask, SAME_ASK)) continue
    const ans = await readJSON<Answer>($, `${a.root}/answers/${it.id}.json`)
    if (!ans) await cli($, a.dir, ['done', it.id, '[superseded: the chat asked it again]']).catch(() => undefined)
    else if (ans.by === 'inbox' && !(await $.fs.exists(`${a.root}/delivered/${it.id}`))) queued = true
  }
  return queued ? 'queued' : 'new'
}

// Unanswered items of this chat (mine) or of every other chat (!mine).
async function openItems($: D, a: { root: string; session: string }, mine = true): Promise<Item[]> {
  const names = await $.fs.list(`${a.root}/items`).catch(() => [])
  const out: Item[] = []
  for (const f of names) {
    if (!f.name.endsWith('.json') || ownedBy(f.name, a.session) !== mine) continue
    const id = f.name.slice(0, -5)
    if (await $.fs.exists(`${a.root}/answers/${id}.json`)) continue
    const it = await readJSON<Item>($, `${a.root}/items/${f.name}`)
    if (it) out.push(it)
  }
  return out
}

// A question asked only in prose at the end of a reply ("Удалить лог?", "нашёл ещё X, сделать?"): the reply's last
// sentence, when it ends with "?", code left out. A "?" earlier in the reply is not one: 2026-11-12 a fleet coordinator's
// question to its own reviewer, followed by more text, and a hold chat's «…counted» (?" were filed as boxes.
export function proseQuestion(answer: string): string | undefined {
  // Trailing markdown, quotes, brackets and emoji after the "?" do not hide it; a "." inside a word ("config.json") is no
  // sentence end: only [.!?] followed by whitespace is.
  const text = answer.replace(/```[\s\S]*?```/g, ' ').trim().replace(/[\s*_~`"'»”’)\]}>‍️\p{Extended_Pictographic}]+$/u, '')
  if (!text.endsWith('?')) return undefined
  let start = 0
  for (const m of text.slice(0, -1).matchAll(/[.!?]\s|\n/g)) start = m.index + m[0].length
  const q = text.slice(start).replace(/^[\s*_\-\d.)]+/, '').trim()
  return q && /\p{L}{2,}/u.test(q) && q.length > 3 ? q.slice(0, 400) : undefined
}

// One wake at a time: the tick and a turn's end may both call it, and two would announce and submit the same items.
let waking: Promise<void> | undefined
function wakeOnce($: D, me: { root: string; session: string }): Promise<void> {
  waking ??= wake($, me).finally(() => { waking = undefined })
  return waking
}

// The inbox chat itself: wake it once per new item from another chat, so nothing waits for the person to ask. The
// prompt is English on purpose: the inbox chat answers him in his own language, and the plugin serves other people too.
async function wake($: D, me: { root: string; session: string }): Promise<void> {
  const now = await $.clock.now()
  if (inTurn && !(openDialog && now - openDialog.since >= REFRESH_MS)) return // built when it is sent, from what is still open then
  const fresh: Item[] = []
  for (const f of await $.fs.list(`${me.root}/items`).catch(() => [])) {
    if (!f.name.endsWith('.json')) continue
    const id = f.name.slice(0, -5)
    if (ownedBy(id, me.session) || (await $.fs.exists(`${me.root}/answers/${id}.json`)) || (await $.fs.exists(`${me.root}/announced/${id}`))) continue
    const it = await readJSON<Item>($, `${me.root}/items/${f.name}`)
    if (it) fresh.push(it)
  }
  if (inTurn) {
    // Its dialog has waited long enough: the new items join it in one ask, in this same turn (no prompt to queue).
    if (!fresh.length || !openDialog) return
    for (const it of fresh) await $.fs.write(`${me.root}/announced/${it.id}`, '')
    return openDialog.refresh()
  }
  // Finish reports never wake one by one: they go with an item's wake, or as one batch once due (core.mjs dueReports).
  const reports = await waitingReports($, me)
  if (!fresh.length && !dueReports(reports, now)) return
  for (const it of fresh) await $.fs.write(`${me.root}/announced/${it.id}`, '')
  for (const r of reports) await $.fs.write(`${me.root}/reports/announced/${r.id}`, '')
  if (!fresh.length) return void (await $.prompt.submit({ text: `Inbox: ${finishedLine(reports)} Show them now with the makarasty-tools inbox skill (inbox.mjs list).` }))
  const lines = fresh.map((it) => `- ${it.cwd.split(/[\\/]/).filter(Boolean).pop()}: ${it.kind === 'ask' ? it.questions?.[0]?.question : it.kind === 'choice' ? it.ask : `card "${it.title}"`}`)
  await $.prompt.submit({ text: `Inbox: ${fresh.length} new item${fresh.length > 1 ? 's' : ''} waiting for the person:\n${lines.join('\n')}${reports.length ? `\nAlso: ${finishedLine(reports)}` : ''}\nReview them now with the makarasty-tools inbox skill.` })
}

// What the person types in a chat where the inbox is on (the inbox chat too: it is where he asks for a start) goes to said.jsonl, the inbox chat's source for who he is and what he
// answered. Only his own typing: not what the plugin submits and not a message from another session.
export const SAID_KEEP_MS = 86400000
const SAID_MAX = 200
// The plugin's own prompts and other sessions' messages, read on his words (a paste or reminder that quotes them is gone by then).
const NOT_SAID = /^\s*(Inbox: \d|The person answered your|<cross-session-message|Another Claude session sent a message)/
async function capture($: D, raw: string): Promise<void> {
  const text = ownWords(raw) // app reminders and pastes are not his word, so never a start's consent
  if (!text.trim() || NOT_SAID.test(text) || PLUGIN_FRAME.test(text)) return
  const a = (await active($)) ?? (await inboxSelf($))
  if (!a) return
  const now = await $.clock.now()
  // shortcut: read-and-rewrite (no append in $.fs); two chats typing within milliseconds can lose a line.
  const old = String(await $.fs.read(`${a.root}/said.jsonl`).catch(() => '')).split(/\r?\n/).filter((l) => {
    try { return now - (JSON.parse(l) as { at: number }).at < SAID_KEEP_MS } catch { return false }
  })
  old.push(JSON.stringify({ at: now, session: a.session, text: text.slice(0, 4000) }))
  await $.fs.write(`${a.root}/said.jsonl`, `${old.slice(-SAID_MAX).join('\n')}\n`)
}

// Chats started for the person leave a journal in starts/; the inbox chat's timer finishes the queued ones (`start --drain`),
// at most once a minute and never two at once.
const DRAIN_EVERY_MS = 60000
const RETRY_AFTER_MS = 600000 // a failed start is tried again (attempts < 3) once its journal is this old
let lastDrain: number | undefined
let draining = false
async function drainStarts($: D, me: { dir: string; root: string }): Promise<void> {
  if (draining) return
  const now = await $.clock.now()
  if (lastDrain !== undefined && now - lastDrain < DRAIN_EVERY_MS) return
  let queued = false
  for (const f of await $.fs.list(`${me.root}/starts`).catch(() => [])) {
    if (!f.name.endsWith('.json')) continue
    const j = await readJSON<{ state?: string; attempts?: number; updated?: number | string }>($, `${me.root}/starts/${f.name}`)
    const upd = Number(j?.updated) || Date.parse(String(j?.updated ?? '')) || 0
    if (j?.state === 'queued' || j?.state === 'cli-done' || (j?.state === 'failed' && (j.attempts ?? 0) < 3 && now - upd > RETRY_AFTER_MS)) { queued = true; break }
  }
  if (!queued) return
  draining = true
  lastDrain = now
  try { await cli($, me.dir, ['start', '--drain'], 300000) } finally { draining = false }
}

// The inbox's answers to this chat's boxes and cards, entered as prompts. Not while this chat is in a turn (2026-11-12: one sent
// mid-turn never reached it, and was marked delivered): they go at the turn's end or the next idle tick, and delivered/<id>
// is written only after a submit that did not throw, so a failed one is tried again at the next tick. One run at a time.
let delivering: Promise<void> | undefined
function deliverOnce($: D, a: { root: string; session: string }): Promise<void> {
  delivering ??= deliverAnswers($, a).finally(() => { delivering = undefined })
  return delivering
}

// The chat's turn state is on disk (<root>/turns/<session>: "busy <ms>" from turn.start, "idle <ms>" from turn.complete), so a
// plugin reload in the middle of a turn does not lose it. No file yet: busy until this module has seen a turn end, or for 30 min.
const BUSY_MAX_MS = 3 * 3600000 // a "busy" older than this is a chat that died, not a turn
const UNKNOWN_BUSY_MS = 30 * 60000
let turnCompleted = false
let firstSeen: number | undefined
async function markTurn($: D, state: 'busy' | 'idle'): Promise<{ root: string; session: string } | undefined> {
  const a = await active($)
  if (a) await $.fs.write(`${a.root}/turns/${safe(a.session)}`, `${state} ${await $.clock.now()}`)
  return a
}
async function chatBusy($: D, a: { root: string; session: string }): Promise<boolean> {
  if (inTurn) return true
  const now = await $.clock.now()
  const m = /^(busy|idle) (\d+)/.exec(String(await $.fs.read(`${a.root}/turns/${safe(a.session)}`).catch(() => '')).trim())
  if (m) return m[1] === 'busy' && now - Number(m[2]) < BUSY_MAX_MS
  firstSeen ??= now
  return !turnCompleted && now - firstSeen < UNKNOWN_BUSY_MS
}

// Exit 0: this chat's transcript (<config>/projects/*/<session>.jsonl), streamed whole, holds a tool_result for the tool use; 1: it does not; 2: no readable transcript.
const TOOL_RESULT_SEEN = "const fs=require('fs'),p=require('path'),rl=require('readline'),[d,s,t]=process.argv.slice(1);let f;try{for(const x of fs.readdirSync(d+'/projects')){const c=p.join(d,'projects',x,s+'.jsonl');if(fs.existsSync(c)){f=c;break}}}catch{}if(!f)process.exit(2);const n='\"tool_use_id\":\"'+t+'\"',i=fs.createReadStream(f);i.on('error',()=>process.exit(2));const r=rl.createInterface({input:i});r.on('line',l=>{if(l.includes(n))process.exit(0)});r.on('close',()=>process.exit(1))"

// One answer per call (the next goes when its turn ends or at a later idle tick), and the turn state is read again just
// before the submit.
async function deliverAnswers($: D, a: { root: string; session: string }): Promise<void> {
  for (const f of await $.fs.list(`${a.root}/answers`).catch(() => [])) {
    if (!f.name.endsWith('.json') || !ownedBy(f.name, a.session)) continue
    const id = f.name.slice(0, -5)
    if (await $.fs.exists(`${a.root}/delivered/${id}`)) continue
    const [ans, it] = [await readJSON<Answer>($, `${a.root}/answers/${f.name}`), await readJSON<Item>($, `${a.root}/items/${id}.json`)]
    if (!ans || !it || ans.by !== 'inbox' || (it.kind === 'ask' && it.found !== 'scan' && waited.has(id))) continue // a live dialog's answer goes back through its own hook
    if (it.kind === 'ask' && it.found !== 'scan') {
      // A dead dialog only if the chat never got the answer: older waiter paths wrote no delivered/<id>, so look for the dialog's tool_result.
      if ((await $.clock.now()) - (Number(ans.at) || 0) > 86400000) continue
      if (/^\d+$/.test(id.slice(id.indexOf('~') + 1))) continue // a time-based id (the dialog had no tool use id) cannot be looked up: uncertain, skip
      const seen = await $.process.run(['node', '-e', TOOL_RESULT_SEEN, a.dir, a.session, id.slice(id.indexOf('~') + 1)], { timeoutMs: 60000 }).catch(() => undefined)
      if (seen?.exitCode === 0) await $.fs.write(`${a.root}/delivered/${id}`, String(await $.clock.now())).catch(() => undefined)
      if (seen?.exitCode !== 1) continue // seen, or the transcript cannot be read: never deliver on uncertainty
    }
    if (await chatBusy($, a)) return
    try { await $.prompt.submit({ text: deliveryText(it, ans) }) } catch { return }
    await $.fs.write(`${a.root}/delivered/${id}`, String(await $.clock.now())).catch(() => undefined)
    return
  }
}

export async function tick($: D): Promise<void> {
  const me = await inboxSelf($)
  if (me) {
    await $.fs.write(`${me.root}/beat`, String(await $.clock.now())).catch(() => undefined) // the watchdog's sign the timer runs
    void drainStarts($, me).catch(() => undefined) // not awaited: it can run minutes, and the beat and the wake must not wait for it
    return wakeOnce($, me)
  }
  const a = await active($)
  if (!a) return
  const now = await $.clock.now()
  await deliverOnce($, a).catch(() => undefined)
  for (const it of await openItems($, a)) {
    if (now - it.at < PUSH_AFTER_MS) continue
    // pushed/<id> is empty once pushed, or {fails, at} after a failed try (inbox.mjs push: 3 tries, 5 min apart)
    if (await $.fs.exists(`${a.root}/pushed/${it.id}`)) {
      const m = await readJSON<{ fails: number; at: number }>($, `${a.root}/pushed/${it.id}`)
      if (!m || m.fails >= 3 || now - m.at < 300000) continue
    }
    if (!it.explain) {
      const r = await $.model.complete({ model: 'haiku', prompt: explainPrompt(it), maxTokens: 600, timeoutMs: 60000 }).catch(() => undefined)
      if (r?.isAnswered && r.text.trim()) await $.fs.write(`${a.root}/items/${it.id}.json`, JSON.stringify({ ...it, explain: r.text.trim() }))
    }
    await cli($, a.dir, ['push', it.id]).catch(() => undefined)
  }
}
