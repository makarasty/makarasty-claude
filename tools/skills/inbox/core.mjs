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
 *   context?: string, explain?: string, host?: string, account?: string }} Item
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

/** One item as the inbox chat shows it: where from, how long it waits, the plain explanation, the thing itself. */
export function render(/** @type {Item} */ item, now = Date.now(), /** @type {string | undefined} */ account = undefined) {
  return [
    `### ${project(item.cwd)} — ${KIND[item.kind]}, waiting ${ago(now - item.at)}`,
    `id: ${item.id}`,
    `Chat: ${item.chat}`,
    link(item, account),
    `Folder: ${item.cwd}`,
    item.explain ? `Plainly: ${item.explain}` : `Context: ${cut(item.context ?? '(none)', 900)}`,
    body(item),
  ].filter(Boolean).join('\n')
}

/** The phone line: project, kind, the first question. One line, under ~300 chars. */
export function pushText(/** @type {Item} */ item) {
  const first = item.kind === 'ask' ? item.questions?.[0]?.question : item.kind === 'choice' ? item.ask : `start "${item.title}"?`
  return cut(`${project(item.cwd)}: ${KIND[item.kind]} — ${first ?? ''}. Answer: /makarasty-tools:inbox`, 300)
}

/** What an AskUserQuestion hook returns for an inbox answer: the tool's own result shape, so the model reads it as the dialog's. */
export function toResult(/** @type {Item} */ item, /** @type {Answer} */ answer) {
  return { questions: item.questions ?? [], answers: answer.answers ?? {} }
}

/** The prompt a chat gets for a choice or card answered in the inbox: the whole question and the operator's pick, never a bare "yes". */
export function deliveryText(/** @type {Item} */ item, /** @type {Answer} */ answer) {
  const pick = answer.choice ?? Object.values(answer.answers ?? {}).join('; ')
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
      r.recap ? `Recap: ${r.recap}` : '',
      r.excerpt ? `Last message:\n${r.excerpt}` : '',
    ]),
    ...earlier.slice(0, 4).map((r) => `Earlier, ${ago(now - r.at)} ago: ${cut(r.recap || r.excerpt || '', 300)}`),
    earlier.length > 4 ? `${earlier.length - 4} earlier reports more: inbox.mjs reports` : '',
  ].filter(Boolean).join('\n') }).join('\n\n')
}
