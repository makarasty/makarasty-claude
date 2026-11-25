// core.mjs - the inbox's pure part, shared by the hook (tools/hooks/inbox.ts, no Node there) and the CLI (inbox.mjs).
// Imports only the notify words and layout (strings.mjs, render.mjs): the hooks module runs without Node, so nothing here may touch fs, path or process.
//
// Disk layout under <claude config dir>/makarasty/inbox/ (read by both sides):
//   items/<id>.json      one pending thing a chat waits on: an AskUserQuestion ("ask"), a wrap_up yes/no ("choice"),
//                        a session card ("card")
//   answers/<id>.json    the answer; created exclusively, so the first writer wins (the inbox, or the chat itself)
//   heard-answers/<id>.json  the person's own act behind an inbox answer, written by the hooks only (tools/hooks/consent.ts)
//   auto.jsonl           one line per question the hook answered by the person's standing "continue" rule (what `list` shows
//                        once, with auto-seen/<id>); the answer file's value names the rule, so the chat does not take it for his words
//   delivered/<id>       the chat took the answer (choice and card answers go back as a prompt)
//   pushed/<id>          the phone message for this item went out
//   self                 the session id of the chat that runs the inbox (its own asks and boxes never enter it)
//   beat                 the inbox chat's timer writes the time here every tick (the watchdog tells a busy turn from a
//                        dead timer by it); turn: "busy <ms>" or "idle <ms>", the inbox chat's main turn
//   reports/<id>.json    a finish report: a chat switched on for reports ended a working turn (never an item: it waits
//                        for nobody, so no item wake, push or watchdog sees it)
//   reports/on/<id>      the switch for one chat (its session id or its local_ app id); the inbox writes it for every
//                        session it starts, the person for any chat (`inbox.mjs report on`)
//   reports/announced/<id>, reports/seen/<id>   woken about it once; shown by `list` once
// The switch is the file <claude config dir>/makarasty/inbox.on.

import { t } from '../notify/strings.mjs'
import { phoneHtml } from '../notify/render.mjs'

/** @typedef {{ label: string, description?: string, preview?: string }} Option */
/** @typedef {{ question: string, header?: string, options?: Option[], multiSelect?: boolean }} Question */
/**
 * @typedef {{ id: string, kind: 'ask'|'choice'|'card', at: number, session: string, cwd: string, chat: string,
 *   questions?: Question[], ask?: string, actions?: string[], recap?: string,
 *   title?: string, brief?: string, background?: string, taskId?: string,
 *   context?: string, explain?: string, host?: string, account?: string, found?: string }} Item
 */
/** @typedef {{ id: string, at: number, by: 'inbox'|'chat', answers?: Record<string, string>, choice?: string, standing?: boolean }} Answer */

export const PUSH_AFTER_MS = 2 * 60 * 1000 // p50 wait is 3.0 min: most asks are answered in the chat before this
export const TTL_MS = { ask: 24 * 3600 * 1000, choice: 24 * 3600 * 1000, card: 7 * 24 * 3600 * 1000 } // cards expire in 7 d
export const UNANSWERED_TTL_MS = 7 * 24 * 3600 * 1000 // a question nobody answered survives the night and the weekend; TTL_MS is for answered ones

// File names: letters, digits, - and _ only, so no `:` or question text reaches a Windows path.
export const safe = (/** @type {string} */ s) => String(s).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)
/** The item id carries its chat, so a chat finds its own answers by prefix with one listing. */
export const itemId = (/** @type {string} */ session, /** @type {string} */ toolUseId) => `${safe(session)}~${safe(toolUseId)}`
export const ownedBy = (/** @type {string} */ id, /** @type {string} */ session) => id.startsWith(`${safe(session)}~`)

const cut = (/** @type {string} */ s, /** @type {number} */ n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const project = (/** @type {string} */ cwd) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd

/** Where the chat stands, for the item: the last few messages, newest last, each cut short. */
export function contextOf(/** @type {{ role: string, text: string }[]} */ messages, n = 6, each = 700) {
  return messages.map((m) => ({ role: m.role, text: clean(m.text ?? '') })).filter((m) => m.text).slice(-n).map((m) => `${m.role}: ${cut(m.text, each)}`).join('\n\n')
}

/** A message's own words: the engine's <system-reminder> blocks (session notes, hook text) taken out. */
export function clean(/** @type {string} */ text) {
  return text.replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The prompt a small model gets to explain the item to an operator who sees it cold. */
export function explainPrompt(/** @type {Item} */ item) {
  return [
    'You help a person who runs many agent chats at once. One chat waits for their answer, and they see the question',
    'with no context. Explain it in plain words, in the language the person writes in (their messages below), short',
    '(up to 6 lines, no headings):',
    '1) what is happening in this chat and why it asks;',
    '2) what each option leads to (one line per option);',
    '3) which option the chat itself recommends, if it said so.',
    'Add nothing the text does not say. Keep paths, commands and numbers exact.',
    '',
    `Project: ${project(item.cwd)}`,
    `Waiting for an answer:\n${body(item)}`,
    '',
    `The chat's last messages:\n${item.context || '(none)'}`,
  ].join('\n')
}

/** The thing itself, as plain lines: the questions with their options, the box's question, or the card. */
export function body(/** @type {Item} */ item) {
  if (item.kind === 'ask') {
    return (item.questions ?? []).map((q, i) => [
      `${i + 1}. ${q.question}${q.multiSelect ? ' (several allowed)' : ''}`,
      ...(q.options ?? []).map((o) => `   - ${o.label}${o.description ? `: ${o.description}` : ''}`),
    ].join('\n')).join('\n')
  }
  if (item.kind === 'choice') return [`${item.ask}`, ...(item.actions ?? []).map((a) => `   - ${a}`), item.recap ? `Turn recap: ${item.recap}` : ''].filter(Boolean).join('\n')
  return [`Session card "${item.title}"${item.taskId ? ` (${item.taskId})` : ''}`, `What it will do: ${cut(item.brief ?? '', 600)}`].join('\n')
}

const ago = (/** @type {number} */ ms) => (ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))} min` : `${Math.round(ms / 3600e3)} h`)
const KIND = { ask: 'question', choice: 'end-of-turn yes/no', card: 'session card' }

/** A one-click way to the chat: a sidebar link when it runs under the inbox's own account, else the app link to try in
 *  that account's window (the sidebar of one account does not list another's chats). */
export function link(/** @type {Item} */ item, /** @type {string | undefined} */ account) {
  if (!item.host) return ''
  const label = item.chat.replace(/[[\]]/g, '')
  if (!item.account || !account || item.account === account) return `Open the chat: [${label}](#${item.host})`
  return `Chat on another account: open it with \`inbox.mjs open ${item.id}\` (in that account's window)`
}

/** Where a question comes from, as every inbox question must start: "<project> · <chat title, short>". The hook refuses an
 *  inbox dialog whose question does not start with it (the owner could not tell which chat asked, 2026-11-13). */
export function sourceTag(/** @type {{ cwd: string, chat: string }} */ item) {
  const title = String(item.chat ?? '').replace(/\s*\([^()]{1,12}\)\s*$/, '').replace(/[[\]]/g, '').trim() // the "(1a2b3c4d)" session suffix
  const short = title.length > 40 ? `${title.slice(0, 40).replace(/\s+\S*$/, '')}…` : title
  return short ? `${project(item.cwd)} · ${short}` : project(item.cwd)
}
const squash = (/** @type {string} */ s) => s.toLowerCase().replace(/[\s…]+/g, ' ').trim()
/** Whether a question the inbox chat asks names its source: it starts with the tag (case and spaces aside). */
export const namesSource = (/** @type {string} */ question, /** @type {{ cwd: string, chat: string }} */ item) => squash(question).startsWith(squash(sourceTag(item)))

// The owner's rule (2026-11-13): an answer goes into a chat as a new message only while that chat still waits for it.
export const STALE_MS = 12 * 3600 * 1000
// A card older than this whose chat has been idle as long is work that went on another way (2026-11-18: weekend cards 40-110 h old were asked again).
export const CARD_IDLE_MS = 24 * 3600 * 1000
/**
 * Why an answer must not go into the asking chat as a message, or undefined. `typedAfter`: the person wrote in that chat after
 * the question; `archived`: the chat is archived; `muted`: the person muted it. A live dialog (an ask the chat still waits on in
 * its own window) is no message, so `prompt: false` drops the age rule for it. `started`: a session already runs the card's
 * work (named here); `pushed`: the remote branch that holds a push box's commit; `later`: the chat began a new turn since, so
 * its box is gone; `idle`: ms since the chat's last activity.
 */
export function undeliverable(/** @type {Item} */ item, /** @type {{ now?: number, typedAfter?: boolean, archived?: boolean, muted?: boolean, prompt?: boolean, started?: string, pushed?: string, later?: boolean, idle?: number }} */ o = {}) {
  const now = o.now ?? Date.now()
  if (o.muted) return 'the chat is muted'
  if (o.archived) return 'the chat is archived'
  if (o.started) return `started already as a session (${o.started})`
  if (o.pushed) return `the commit is already on ${o.pushed}`
  if (o.typedAfter) return `you wrote in that chat after the ${item.kind === 'card' ? 'card' : 'question'}`
  if (o.later) return 'the chat went on to a new turn since'
  if (o.prompt !== false && now - item.at > STALE_MS) return `the question is ${ago(now - item.at)} old`
  if (item.kind === 'card' && (o.idle ?? 0) > CARD_IDLE_MS && now - item.at > CARD_IDLE_MS) return `the card is from ${ago(now - item.at)} ago and its chat idle for ${ago(o.idle ?? 0)}`
  return undefined
}

/** One item as the inbox chat shows it: where from, how long it waits, the plain explanation, the thing itself. */
export function render(/** @type {Item} */ item, now = Date.now(), /** @type {string | undefined} */ account = undefined) {
  return [
    `### ${project(item.cwd)} — ${KIND[item.kind]}, waiting ${ago(now - item.at)}`,
    `id: ${item.id}`,
    `Chat: ${item.chat}`,
    `Start each question with: ${sourceTag(item)}: `,
    link(item, account),
    `Folder: ${item.cwd}`,
    item.explain ? `Plainly: ${item.explain}` : `Context: ${cut(item.context ?? '(none)', 900)}`,
    body(item),
  ].filter(Boolean).join('\n')
}

// ---- Telegram: the phone side of an item. The decisions are here; the words are notify/strings.mjs, the layout notify/render.mjs ----

const age = (/** @type {string} */ lang, /** @type {number} */ ms) => (ms < 3600e3 ? t(lang, 'ageMin', { n: Math.max(1, Math.round(ms / 60e3)) }) : t(lang, 'ageH', { n: Math.round(ms / 3600e3) }))

/**
 * The phone message (notify.mjs ask): which question, which options, whether a tap or a reply is a whole answer. Buttons
 * answer only where one tap is a whole answer: a one-question ask that is not multi-select, or a box's actions. A card is
 * started from the inbox chat (it needs a new session) and a multi-question ask needs every answer at once: those say so,
 * with only the details button. `message` is the channel-neutral text, `html` its Telegram rendering; `short` is the question
 * cut for the one grey line an answered message becomes. `lang` is the person's (strings.mjs langOf), en when not given.
 */
export function phoneAsk(/** @type {Item} */ item, now = Date.now(), /** @type {string | undefined} */ lang = undefined) {
  const qs = item.questions ?? []
  const one = item.kind === 'ask' && qs.length === 1 && !qs[0].multiSelect
  const first = (item.kind === 'ask' ? qs[0]?.question : item.kind === 'choice' ? item.ask : t(lang, 'cardQuestion', { title: item.title ?? '' })) ?? ''
  const options = one ? (qs[0].options ?? []).map((o) => o.label) : item.kind === 'choice' ? (item.actions ?? []) : []
  const note = item.kind === 'ask' && qs.length > 1 ? t(lang, 'moreQuestions', { n: qs.length - 1 }) : item.kind === 'card' ? t(lang, 'cardNote') : ''
  const kind = t(lang, { ask: 'kindAsk', choice: 'kindChoice', card: 'kindCard' }[item.kind])
  const message = { question: first, meta: `${project(item.cwd)} · ${kind} · ${age(lang ?? 'en', now - item.at)}`, note }
  return { item: item.id, html: phoneHtml(message), message, short: cut(first, 90), options, reply: one || item.kind === 'choice' }
}

/** The phone messages for an item: one, or for a dialog of several questions one per question, each with its own
 *  buttons (owner, 2026-11-18: "where are the answer options?"); `q`/`of` let the poller gather the answers into one. */
export function phoneAsks(/** @type {Item} */ item, now = Date.now(), /** @type {string | undefined} */ lang = undefined) {
  const qs = item.questions ?? []
  if (item.kind !== 'ask' || qs.length < 2) return [phoneAsk(item, now, lang)]
  return qs.map((q, i) => {
    const message = { question: q.question, meta: `${project(item.cwd)} · ${i + 1}/${qs.length} · ${age(lang ?? 'en', now - item.at)}`, note: '' }
    return { item: item.id, html: phoneHtml(message), message, short: cut(q.question, 90), options: (q.options ?? []).map((o) => o.label), reply: true, q: q.question, of: qs.length }
  })
}

/** What an AskUserQuestion hook returns for an inbox answer: the tool's own result shape, so the model reads it as the dialog's. */
export function toResult(/** @type {Item} */ item, /** @type {Answer} */ answer) {
  return { questions: item.questions ?? [], answers: answer.answers ?? {} }
}

/** The prompt a chat gets for a choice or card answered in the inbox: the whole question and the operator's pick, never a bare "yes". */
export function deliveryText(/** @type {Item} */ item, /** @type {Answer} */ answer) {
  const pick = answer.choice ?? Object.values(answer.answers ?? {}).join('; ')
  // Question and answer as JSON strings: a quote inside either cannot end it early for the guards that read the pair
  // (tools/hooks/consent.ts deliveredPairs).
  const j = (/** @type {string} */ s) => JSON.stringify(String(s))
  if (item.kind === 'ask') { // found by `scan`: the dialog has no waiter in its chat, so the answer goes back as a prompt
    return `The person answered your question from the inbox (makarasty-tools inbox), in place of the dialog here: ${(item.questions ?? []).map((q) => `${j(q.question)}: ${j(answer.answers?.[q.question] ?? '')}`).join('; ')}. ` +
      'It is their own answer, picked in their inbox chat instead of the dialog here.'
  }
  if (item.kind === 'card') {
    return `The person answered your session card "${item.title}"${item.taskId ? ` (task_id ${item.taskId})` : ''} from the inbox (makarasty-tools inbox): "${pick}". ` +
      'It is their own answer, picked in their inbox chat instead of the button here. ' +
      'The inbox starts the card they chose itself, so withdraw yours (dismiss_task) and do not offer it again.'
  }
  return `The person answered your end-of-turn question ${j(item.ask ?? '')} from the inbox (makarasty-tools inbox): ${j(pick)}. ` +
    'It is their own answer, picked in their inbox chat instead of the button here.'
}

/** An answer for an ask item: a {question: answer} map; a single-question item also takes a bare string. */
export function normalizeAnswer(/** @type {Item} */ item, /** @type {unknown} */ raw) {
  if (item.kind !== 'ask') return { choice: String(typeof raw === 'object' && raw && 'choice' in raw ? /** @type {{choice: unknown}} */ (raw).choice : raw) }
  const qs = item.questions ?? []
  if (typeof raw === 'string') {
    if (qs.length !== 1) throw new Error(`this item has ${qs.length} questions: answer with a JSON map {"<question>": "<answer>"}`)
    return { answers: { [qs[0].question]: raw } }
  }
  const map = /** @type {Record<string, unknown>} */ (raw ?? {})
  const missing = qs.filter((q) => typeof map[q.question] !== 'string').map((q) => q.question)
  if (missing.length) throw new Error(`no answer for: ${missing.join(' | ')}`)
  return { answers: Object.fromEntries(qs.map((q) => [q.question, String(map[q.question])])) }
}

/** Anything the person must decide himself: a commit, push, merge, deploy, release, tag, a delete or overwrite, money, a send, a permission, a prod step, a new feature or task. Stems, matched anywhere in a word: over-refusing only leaves the question to the person. */
export const CONSENT = /коммит|пуш|мерж|деплой|релиз|тег|удал|стер|перезапис|выкат|прод(?!олж)|оплат|плат|деньг|отправ|письм|разреш|чист|сброс|снос|снест|откат|нов(ая|ую|ой) задач|фич|clean|purge|reset|revert|rollback|commit|push|merge|deploy|release|tag|delet|remov|drop|wipe|overwrit|ship|prod|send|email|pay|money|permission|feature|new task/i
const CONTINUE = /продолж|дальше|доводи|до конца|continue|keep going|go on|proceed/i
const NO = /(?<![\p{L}])(нет|не|no|don'?t|stop|стоп|пауза|pause)(?![\p{L}])|остановить|остановись/iu
const YES = /(?<![\p{L}])(да|yes)(?![\p{L}])|продолж|continue|доводи/iu

const GO_WORD = /^(продолж|доводи|довест|довед|дальше$|continue|proceed)/
const FILLER = new Set('до конца keep going go с со по на ли мы работу работой задачу задачей это этим the with on it this work task план планом'.split(' '))
/**
 * The whitelist: a question that is nothing but "continue" plus at most two words naming the work ("Продолжить с миграцией
 * схемы?"). No second clause, no other verb (Russian infinitives: ть|ти|чь|ться|тись), more than 2 words left means a real question.
 * A banned-word list (CONSENT) can never be complete; this is the shape that decides, CONSENT stays as a second net.
 */
export function continueShape(/** @type {string} */ question) {
  const q = question.trim().toLowerCase()
  if (/ и | а | затем | потом | then | and |[,;:—-]/.test(q)) return false
  const rest = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !GO_WORD.test(w) && !FILLER.has(w))
  return rest.length <= 2 && !rest.some((w) => /[а-яё]/.test(w) && /(ть|ти|чь|ться|тись)$/.test(w))
}

/**
 * The answers map for an ask item whose every question is only "continue?" (work already under way), or undefined.
 * Per question: short (60 chars), matches the continue words, and exactly two options, one yes-like and one no-like
 * ("Продолжить через REST" / "через GraphQL" is a choice between approaches, not this). Undefined when the question, header,
 * any label, description or preview touches CONSENT, or a question is multiSelect.
 * Regex stems over Russian and English, miss other languages; the standing rule gates it, so a miss only leaves the question to the person.
 */
export function continueAnswer(/** @type {Item} */ item) {
  const qs = item.kind === 'ask' ? item.questions ?? [] : []
  if (!qs.length) return undefined
  const answers = /** @type {Record<string, string>} */ ({})
  for (const q of qs) {
    const opts = q.options ?? []
    const text = [q.question, q.header, ...opts.flatMap((o) => [o.label, o.description, o.preview])].filter(Boolean).join(' | ')
    if (q.multiSelect || q.question.trim().length > 60 || !CONTINUE.test(q.question) || !continueShape(q.question) || CONSENT.test(text) || opts.length !== 2) return undefined
    const yes = opts.filter((o) => YES.test(o.label) && !NO.test(o.label)), no = opts.filter((o) => NO.test(o.label))
    if (yes.length !== 1 || no.length !== 1) return undefined
    answers[q.question] = yes[0].label
  }
  return answers
}

export const expired = (/** @type {Item} */ item, now = Date.now(), answered = false) => now - item.at > (answered ? TTL_MS[item.kind] : Math.max(TTL_MS[item.kind], UNANSWERED_TTL_MS))

/**
 * @typedef {{ id: string, at: number, session: string, cwd: string, chat: string, recap?: string, excerpt?: string,
 *   error?: boolean, urgent?: boolean, started?: boolean, host?: string, account?: string }} Report
 */

// Finish reports wake the inbox chat in batches: once 5 min passed with no new one, or 15 min after the first, whichever
// comes first. Measured over 132 finishes in 39 chats (gaps p50 162 s, bunched): 1/5 min woke 1.4 reports at a time,
// 5/15 min 2.5 at about 3 wakes an active hour, 10/30 min left a report unseen past the person's p90 answer gap of 23 min [M63].
export const QUIET_MS = 5 * 60 * 1000
export const MAX_MS = 15 * 60 * 1000
export const REPORT_TTL_MS = 3 * 24 * 3600 * 1000
export const UNSEEN_REPORT_TTL_MS = 7 * 24 * 3600 * 1000 // a report the person never saw is kept longer

/** Whether the waiting reports (not woken about yet) are due for one wake. An urgent one (a chat the inbox started, a turn
 *  that died on an error, a last message that waits on the person) is due at once: only the rest wait for the batch. */
export function dueReports(/** @type {Report[]} */ waiting, now = Date.now()) {
  if (!waiting.length) return false
  if (waiting.some((r) => r.urgent)) return true
  const ats = waiting.map((r) => r.at)
  return now - Math.max(...ats) >= QUIET_MS || now - Math.min(...ats) >= MAX_MS
}

/** The final message, cut to 2000 chars: its start (what was asked and done) and its end (findings, what is left). */
export function excerptOf(/** @type {string} */ answer) {
  const t = answer.trim()
  return t.length > 2000 ? `${t.slice(0, 600)}\n[…]\n${t.slice(-1400)}` : t
}

/** Whether most words of the shorter text (4+ letters) are in the other: the same thing said twice. */
export function overlaps(/** @type {string} */ a, /** @type {string} */ b, min = 0.7) {
  const words = (/** @type {string} */ s) => new Set((s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]{3,}/gu) ?? []).map((w) => w.replace(/[._-]+$/, '')))
  const [x, y] = [words(a), words(b)]
  const small = x.size < y.size ? x : y, big = small === x ? y : x
  if (small.size < 3) return false
  let n = 0
  for (const w of small) if (big.has(w)) n++
  return n / small.size >= min
}
/** Whether the text `a` says nothing beyond `b`: most of a's own words (4+ letters) are in b. A recap that adds a finding is not. */
export function covered(/** @type {string} */ a, /** @type {string} */ b, min = 0.8) {
  const words = (/** @type {string} */ s) => new Set((s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]{3,}/gu) ?? []).map((w) => w.replace(/[._-]+$/, '')))
  const [x, y] = [words(a), words(b)]
  if (!x.size) return true
  let n = 0
  for (const w of x) if (y.has(w)) n++
  return n / x.size >= min
}
// The same line twice in a row (two finishes with one recap) is shown once; the "N min ago" prefix aside.
const uniq = (/** @type {string[]} */ lines) => lines.filter((l, i) => !lines.slice(0, i).some((p) => p.replace(/^[^:]*: /, '') === l.replace(/^[^:]*: /, '')))

/** Reports grouped by chat, newest chat first: the newest report in full, up to 4 earlier recaps a line each. */
export function renderReports(/** @type {Report[]} */ reports, now = Date.now(), /** @type {string | undefined} */ account = undefined) {
  /** @type {Map<string, Report[]>} */
  const by = new Map()
  for (const r of [...reports].sort((a, b) => b.at - a.at)) by.set(r.session, [...(by.get(r.session) ?? []), r])
  return [...by.values()].map(([last, ...all]) => {
    // An urgent finish, or one of a chat the inbox started, is not folded into a line at once: the newest three of them are
    // shown whole, as the newest one is; the rest are a line each.
    const kept = all.filter((r) => r.urgent || r.started).slice(0, 3)
    const earlier = all.filter((r) => !kept.includes(r))
    const whole = [last, ...kept]
    return [
    `### ${project(last.cwd)} — finished ${ago(now - last.at)} ago${all.length ? `, ${all.length + 1} finishes of one chat` : ''}${last.error ? ', ended on an error' : ''}`,
    `Chat: ${last.chat}`,
    link(/** @type {Item} */ (/** @type {unknown} */ (last)), account),
    ...whole.flatMap((r, i) => [
      i ? `Earlier finish, ${ago(now - r.at)} ago${r.error ? ' (ended on an error)' : ''}:` : '',
      // The recap usually restates the last message: shown once, not twice.
      // A started chat ends with its summary as the last message (STARTED_BRIEF): its recap would say it twice.
      r.recap && !(r.excerpt && (r.started || covered(r.recap, r.excerpt))) ? `Recap: ${r.recap}` : '',
      r.excerpt ? `Last message:\n${r.excerpt}` : '',
    ]),
    ...uniq(earlier.slice(0, 4).map((r) => `Earlier, ${ago(now - r.at)} ago: ${cut(r.recap || r.excerpt || '', 300)}`)),
    earlier.length > 4 ? `${earlier.length - 4} earlier reports more: inbox.mjs reports` : '',
  ].filter(Boolean).join('\n') }).join('\n\n')
}

// ---- the person's Telegram messages as a prompt for the inbox (the inbox chat, or a headless inbox turn) ----
export const TG_PROMPT = '[Telegram]'
/** His own words go in quoted lines and nothing else does: they count as his word (owner, 2026-11-17), and push-guard and
 *  the start consent read only those lines (telegramWords). */
export function inboundPrompt(/** @type {{ text: string, about?: { item: string, short: string } }[]} */ ms, /** @type {string | undefined} */ root = undefined) {
  const one = (/** @type {{ text: string, about?: { item: string, short: string } }} */ m) =>
    `${m.about ? `(a reply to the phone question "${m.about.short}", inbox item ${m.about.item})\n` : ''}> ${m.text.replace(/\n/g, '\n> ')}`
  const n = root && `node "${root}/hooks/notify.mjs"`
  return `${TG_PROMPT} The person wrote from Telegram${ms.length > 1 ? ` (${ms.length} messages)` : ''}. His own words:\n${ms.map(one).join('\n')}\n` +
    'This is full remote control of his computer by plain text: do what he asks, with the makarasty-tools inbox skill where ' +
    'it needs it. Answer within a minute or two: he waits, and the next message waits behind this turn. Anything longer (a ' +
    'video, code, a build, research) runs as a job in the right project folder, with the model and effort he names: ' +
    `\`node "${root ?? '<plugin>'}/skills/inbox/inbox.mjs" job <folder> "<short name>" --said "<his message, exact>" [--model m] [--effort e]\`; ` +
    'it works on its own and sends him the result itself, so you reply at once that it started. Never a background agent ' +
    'or a background command here: this turn\'s process ends with it and they would die. ' +
    (n ? `To send him a file, picture, video or voice note: \`${n} file <path> [--caption "..."]\` (type by extension; a voice ` +
      `note is .ogg/.mp3/.m4a with \`--as voice\`). The desktop: \`${n} screenshot\`. Something from the internet: download it ` +
      'to %TEMP% first, then send the file. A voice note: make the audio on this machine (Windows speech, or the video ' +
      'skill\'s local TTS) and convert it with ffmpeg. ' : '') +
    'A task or note in Obsidian: the vault path is in %APPDATA%\\obsidian\\obsidian.json; read the vault\'s CLAUDE.md first ' +
    'and follow it. Your final message is sent to his Telegram as is: ' +
    'his language, short (up to 5 lines; Markdown bold, code and lists render), the answer first. He is on the phone, not at ' +
    'this screen: ask no AskUserQuestion; a decision you need from him is your last line, and he answers it by replying.'
}
/** Whether a prompt is such a prompt: it must START with the head (the app may put its own plugin frame first). Merely
 *  containing "[Telegram]" is not enough: a chat's question quoted in a wake or a delivered answer could carry it. */
export const isTelegramPrompt = (/** @type {string} */ text) => /^\s*(?:The makarasty-tools plugin sent a message:\s*)?\[Telegram\] The person wrote from Telegram/.test(text)
/** His own words in such a prompt: the quoted lines only. */
export const telegramWords = (/** @type {string} */ prompt) => prompt.split('\n').filter((l) => l.startsWith('> ')).map((l) => l.slice(2)).join('\n')

