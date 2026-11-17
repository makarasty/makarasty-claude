// core.mjs - the inbox's pure part, shared by the hook (tools/hooks/inbox.ts, no Node there) and the CLI (inbox.mjs).
// No imports: the hooks module runs without Node, so nothing here may touch fs, path or process.
//
// Disk layout under <claude config dir>/makarasty/inbox/ (read by both sides):
//   items/<id>.json      one pending thing a chat waits on: an AskUserQuestion ("ask"), a wrap_up yes/no ("choice"),
//                        a session card ("card")
//   answers/<id>.json    the answer; created exclusively, so the first writer wins (the inbox, or the chat itself)
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
/**
 * Why an answer must not go into the asking chat as a message, or undefined. `typedAfter`: the person wrote in that chat after
 * the question; `archived`: the chat is archived; `muted`: the person muted it. A live dialog (an ask the chat still waits on in
 * its own window) is no message, so `prompt: false` drops the age rule for it.
 */
export function undeliverable(/** @type {Item} */ item, /** @type {{ now?: number, typedAfter?: boolean, archived?: boolean, muted?: boolean, prompt?: boolean }} */ o = {}) {
  if (o.muted) return 'the chat is muted'
  if (o.archived) return 'the chat is archived'
  if (o.typedAfter) return 'you wrote in that chat after the question'
  if (o.prompt !== false && (o.now ?? Date.now()) - item.at > STALE_MS) return `the question is ${ago((o.now ?? Date.now()) - item.at)} old`
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

// ---- Telegram (HTML parse_mode): the phone side of an item ----

/** Text for Telegram's HTML mode: only &, < and > are special there. Cut fields as plain text first, then escape. */
export const esc = (/** @type {string} */ s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const PHONE_KIND = { ask: 'вопрос', choice: 'да/нет', card: 'карточка' }
const agoRu = (/** @type {number} */ ms) => (ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))} мин` : `${Math.round(ms / 3600e3)} ч`)

/**
 * The phone message (notify.mjs ask), the owner's pick B3 (2026-11-17): the question first and bold, so a lock screen shows
 * it; "project · kind · age" small under it; a button per option and "❔ Подробнее", which makes the explanation only when
 * tapped. Buttons answer only where one tap is a whole answer: a one-question ask that is not multi-select, or a box's
 * actions. A card is started from the inbox chat (it needs a new session) and a multi-question ask needs every answer at
 * once: those say so, with only "Подробнее". `short` is the question cut for the one grey line an answered message becomes.
 */
export function phoneAsk(/** @type {Item} */ item, now = Date.now()) {
  const qs = item.questions ?? []
  const one = item.kind === 'ask' && qs.length === 1 && !qs[0].multiSelect
  const first = (item.kind === 'ask' ? qs[0]?.question : item.kind === 'choice' ? item.ask : `Запустить «${item.title}»?`) ?? ''
  const options = one ? (qs[0].options ?? []).map((o) => o.label) : item.kind === 'choice' ? (item.actions ?? []) : []
  const rest = item.kind === 'ask' && qs.length > 1 ? `\nещё ${qs.length - 1} в том же окне: ответ в инбоксе на компьютере` : item.kind === 'card' ? '\nзапуск из инбокса на компьютере' : ''
  const meta = `${project(item.cwd)} · ${PHONE_KIND[item.kind]} · ${agoRu(now - item.at)}`
  return { item: item.id, html: `<b>${esc(cut(first, 600))}</b>\n<i>${esc(meta)}${esc(rest)}</i>`, short: cut(first, 90), options, reply: one || item.kind === 'choice' }
}

/** The inline keyboard: options in one row when short (up to 3, 34 characters together), else one per row; "Подробнее" last. */
export function phoneKeyboard(/** @type {string[]} */ options, more = true) {
  const btn = (/** @type {string} */ text, /** @type {string} */ data) => ({ text: cut(text, 40), callback_data: data })
  const row = options.length <= 3 && options.join('').length <= 34
  const rows = row ? (options.length ? [options.map((o, i) => btn(o, `a${i}`))] : []) : options.map((o, i) => [btn(o, `a${i}`)])
  if (more) { if (row && rows.length) rows[0].push(btn('❔ Подробнее', 'm')); else rows.push([btn('❔ Подробнее', 'm')]) }
  return { inline_keyboard: rows }
}

/** What an answered message becomes: one grey line, no emoji, easy to scroll past and to read back later. */
export const collapsed = (/** @type {string} */ short, /** @type {string} */ outcome) => `<i>${esc(short)} — ${esc(cut(outcome, 200))}</i>`

/**
 * A model's Markdown answer as Telegram HTML: **bold**, `code`, ``` blocks, # headings as bold, - lists as •. Short: the first
 * paragraphs up to about `head` characters are shown, the rest folds into an expandable quote; the whole is kept under 3800.
 * Converted paragraph by paragraph, so a cut never lands inside a tag.
 */
export function mdToTg(/** @type {string} */ md, head = 700) {
  const inline = (/** @type {string} */ s) => esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<i>$2</i>')
  const para = (/** @type {string} */ p) => {
    if (/^```/.test(p)) return `<pre>${esc(p.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, ''))}</pre>`
    return p.split('\n').map((l) => {
      const h = /^#{1,6}\s+(.*)$/.exec(l)
      if (h) return `<b>${inline(h[1])}</b>`
      const li = /^\s*[-*+]\s+(.*)$/.exec(l)
      return li ? `• ${inline(li[1])}` : inline(l)
    }).join('\n')
  }
  // A fenced block is one paragraph whatever blank lines it holds.
  const paras = String(md).trim().replace(/\r\n/g, '\n').split(/(```[\s\S]*?(?:```|$))/).flatMap((part) => (part.startsWith('```') ? [part] : part.split(/\n{2,}/))).map((p) => p.trim()).filter(Boolean)
  const shown = [], folded = []
  let n = 0
  for (const p of paras) { if (n + p.length <= head || !shown.length) shown.push(p); else folded.push(p); n += p.length }
  // A first paragraph too long even alone (tags and escapes grow it) is cut until it fits, never dropped: an empty text
  // is refused by Telegram and the answer would be lost.
  const fit = (/** @type {string[]} */ ps, /** @type {number} */ max) => {
    const out = []; let len = 0
    for (const p of ps) {
      let h = para(cut(p, max))
      for (let n = max; !out.length && h.length > max && n > 50; n = Math.floor(n * 0.7)) h = para(cut(p, n))
      if (len + h.length > max) break
      out.push(h); len += h.length + 2
    }
    return out.join('\n\n')
  }
  const top = fit(shown, 2000) || esc(cut(String(md).trim(), 1500))
  const rest = folded.length ? fit(folded, 3700 - top.length) : ''
  return rest ? `${top}\n<blockquote expandable>${rest}</blockquote>` : top
}

/** What an AskUserQuestion hook returns for an inbox answer: the tool's own result shape, so the model reads it as the dialog's. */
export function toResult(/** @type {Item} */ item, /** @type {Answer} */ answer) {
  return { questions: item.questions ?? [], answers: answer.answers ?? {} }
}

/** The prompt a chat gets for a choice or card answered in the inbox: the whole question and the operator's pick, never a bare "yes". */
export function deliveryText(/** @type {Item} */ item, /** @type {Answer} */ answer) {
  const pick = answer.choice ?? Object.values(answer.answers ?? {}).join('; ')
  if (item.kind === 'ask') { // found by `scan`: the dialog has no waiter in its chat, so the answer goes back as a prompt
    return `The person answered your question from the inbox (makarasty-tools inbox), in place of the dialog here: ${(item.questions ?? []).map((q) => `"${q.question}": "${answer.answers?.[q.question] ?? ''}"`).join('; ')}. ` +
      'It is their own answer, picked in their inbox chat instead of the dialog here.'
  }
  if (item.kind === 'card') {
    return `The person answered your session card "${item.title}"${item.taskId ? ` (task_id ${item.taskId})` : ''} from the inbox (makarasty-tools inbox): "${pick}". ` +
      'It is their own answer, picked in their inbox chat instead of the button here. ' +
      'The inbox starts the card they chose itself, so withdraw yours (dismiss_task) and do not offer it again.'
  }
  return `The person answered your end-of-turn question "${item.ask}" from the inbox (makarasty-tools inbox): "${pick}". ` +
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
 * shortcut: regex stems over Russian and English, misses other languages; the standing rule gates it, so a miss only leaves the question to the person.
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
export function inboundPrompt(/** @type {{ text: string, about?: { item: string, short: string } }[]} */ ms) {
  const one = (/** @type {{ text: string, about?: { item: string, short: string } }} */ m) =>
    `${m.about ? `(a reply to the phone question "${m.about.short}", inbox item ${m.about.item})\n` : ''}> ${m.text.replace(/\n/g, '\n> ')}`
  return `${TG_PROMPT} The person wrote from Telegram${ms.length > 1 ? ` (${ms.length} messages)` : ''}. His own words:\n${ms.map(one).join('\n')}\n` +
    'Do what he asks, with the makarasty-tools inbox skill where it needs it. Your final message is sent to his Telegram as is: ' +
    'his language, short (up to 5 lines; Markdown bold, code and lists render), the answer first. He is on the phone, not at ' +
    'this screen: ask no AskUserQuestion; a decision you need from him is your last line, and he answers it by replying.'
}
/** Whether a prompt is such a prompt: it must START with the head (the app may put its own plugin frame first). Merely
 *  containing "[Telegram]" is not enough: a chat's question quoted in a wake or a delivered answer could carry it. */
export const isTelegramPrompt = (/** @type {string} */ text) => /^\s*(?:The makarasty-tools plugin sent a message:\s*)?\[Telegram\] The person wrote from Telegram/.test(text)
/** His own words in such a prompt: the quoted lines only. */
export const telegramWords = (/** @type {string} */ prompt) => prompt.split('\n').filter((l) => l.startsWith('> ')).map((l) => l.slice(2)).join('\n')

