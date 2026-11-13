import type { Register } from 'claude-code'

// Refuses a question that only asks whether to go on with work the person already asked for ("Продолжать?",
// "Довести до конца?", "Continue with the remaining tasks?"). People answer it yes, and an open ask blocks the chat's
// turn until they come back [M59] [M67]. Shape, not keywords: the question sentence holds a go-on verb and nothing but
// filler (the rest, the next wave, до конца), every option is a bare yes or not-now, and no word around it (the question, an
// option's description, a header, a wrap_up recap) names a stake: money, prod, a push, a delete or overwrite, a failure, a
// step only the person can do (sign in, click). The question and the labels are tested against all of it; a description,
// header or recap only against the steps ahead (AHEAD), since a recap reports status ("fixed 12", "0 failed"). "Продолжить с миграцией схемы?" names its object and passes.
// AskUserQuestion and the desktop app's end-of-turn box (wrap_up `ask`). MAKARASTY_ASK_GUARD=off drops it.

export const MESSAGE =
  'Not asked: whether to go on with work the person already asked for is answered yes, always. Carry on and report at the end. ' +
  'Ask only what is theirs to decide (a push with its commits, a delete, a real choice between approaches) and name that decision.'
export const BOX = `${MESSAGE} Call wrap_up again without the ask.`

// A question that sends the person elsewhere by pointing "above" ("в чате по ссылке выше", "the link above") reaches
// them without that text when the inbox relays it, and they cannot find the chat among dozens. The question itself must
// name the place: the chat's title and account, or the path or command; the link goes in the text right above the call.
export const ELSEWHERE =
  'Not asked: the question points at a link or chat "above", which the person does not see when the dialog is relayed. ' +
  'Name the place in the question itself (the chat title and its account, or the exact path or command) and the exact action, ' +
  'put the chat link [title](#local_<id>) in the text right above the call, then ask again.'
const ABOVE = /(ссылк[аеиуой]*|чат[еау]?|окн[еоа]|link|chat|window)\s+(выше|сверху|above)|(выше|above)\s+(по ссылке|ссылк|link)|по ссылке (выше|сверху)|linked above/i
// A step in another chat (press its card, answer there, check there) is not a dialog: while a dialog is open the person
// cannot use the link above it, a link cannot go inside it, and opening the chat for them does not help (the dialog
// stays in this chat). It goes in the turn's last message: one line on what to do, the chat's link and its account.
export const OTHER_CHAT =
  'Not asked: a step in another chat is not a dialog, since the person cannot click a link while one is open. End the ' +
  'turn instead with one line on what to do there and the chat link [title](#local_<id>) with its account; their ' +
  '"done" comes as the next message.'
const IN_CHAT = /(в|во|из)\s+(том\s+|другом\s+|соседнем\s+)?чат[еау]?\s*[«"'“(\[]|(in|from)\s+(the\s+|that\s+|another\s+)?chat\s*[«"'“(\[]|карточк[уиае]\s+(в|во)\s+(чат|другом)|the card in/i
export function sendsToChat(questions: readonly Q[]): boolean {
  if (!Array.isArray(questions)) return false
  return questions.some((q) => IN_CHAT.test(str(q?.question)))
}
// A command inside the dialog cannot be copied from it, and a `&&` chain fails in Windows PowerShell 5.1. A command
// line: a known tool with an argument that is a flag, a path or a chain, `cd <path>`, or a `&&` / `||` chain.
export const COMMAND =
  'Not asked: the question or an option holds a command, which cannot be copied from the dialog. Put the command in a ' +
  'code block in the text right above the call (on Windows in a form Windows PowerShell 5.1 runs: `;` instead of `&&`, ' +
  'tagged powershell), and keep the question a short title ("Запустил? Что вышло?"), then ask again.'
const TOOLS = '(?:npm|npx|pnpm|yarn|bun|bunx|node|deno|git|gh|python3?|pip|uv|cargo|go|dotnet|docker|claude|powershell|pwsh|cmd|bash|sh|curl|wget)'
const CMD = new RegExp(`&&|\\|\\||(?:^|[\\s\`(])cd\\s+["']?(?:[A-Za-z]:[\\\\/]|[~./\\\\])|(?:^|[\\s\`(])${TOOLS}\\s+(?:\\S+\\s+)*?(?:-{1,2}[A-Za-z]|[A-Za-z]:[\\\\/]|\\.{0,2}[\\\\/]\\S|\\S+\\.(?:m?[jt]s|json|ps1|sh|py)\\b)`, 'i')
export function holdsCommand(questions: readonly Q[]): boolean {
  if (!Array.isArray(questions)) return false
  return questions.some((q) => [str(q?.question), ...(Array.isArray(q?.options) ? q.options : []).flatMap((o) => [str(o?.label), str(o?.description)])].some((t) => CMD.test(t)))
}

// Asking the person for a secret, or to run by hand what the agent could run here, stalls the chat on a question it
// should have answered itself: a sandbox password was asked while a local proxy to that database was already up.
export const SELF =
  'Not asked: the question asks the person for a password, token or secret, or to run something themselves. No secret is ' +
  'asked in chat, ever. First find how this machine already reaches it (a local proxy or tunnel, open ports, the env files ' +
  "and scripts the project uses, its docs), do the step yourself, and ask only for a decision that stays the person's."
const SECRET = /(парол|password|passwd|\bpass(word)?\b|токен|token|секрет|secret|api[ -]?key|ключ(а|ом)? (api|доступа)|credential|учётн[а-я]* данн|учетн[а-я]* данн|\b[A-Z][A-Z0-9]*_(PASS|PASSWORD|TOKEN|SECRET|KEY)\b)/i
const BYHAND = /(запусти|выполни|прогони|run|execute|start)[^?.!\n]{0,40}(сам(?![а-я])|самостоятельно|вручную|у себя|yourself|by hand|manually|on your (machine|side))|(сам(?![а-я])|вручную|yourself|manually)[^?.!\n]{0,20}(запусти|выполни|прогони|run|execute)/i
export function asksSelf(questions: readonly Q[]): boolean {
  if (!Array.isArray(questions)) return false
  return questions.some((q) => { const t = [str(q?.question), ...(Array.isArray(q?.options) ? q.options : []).map((o) => str(o?.label))].join('\n'); return SECRET.test(t) || BYHAND.test(t) })
}

// The screen: a question reaches the person only after the asking chat checked it could not answer it itself. Of 95
// questions answered 11-11..11-12, 15% were the agent's own to settle (a duplicate, its reviewer's question, a
// "continue?", a standing answer, log noise), none of them one the person then answered his own way [M72]. A stake
// (push, merge, deploy, delete, money, sign-in) skips the screen; it is always his. The inbox chat relays screened items.
export const SCREEN =
  'Screen this question first; it reaches the person only if nobody else can answer it. Check yourself (or with a Haiku ' +
  'Explore agent given this question and the project folder): the project CLAUDE.md and docs, what runs locally (ports, ' +
  'proxies, processes), the scripts and env it uses, earlier answers in this chat and the standing answers. If that settles ' +
  'it, do the step and do not ask. If something must be started that you cannot start, ask the person to start it (never a ' +
  'password). Otherwise ask again with metadata {"screened": "<one line: what you checked and why only the person can answer>"}.'
export function screened(meta: unknown): boolean {
  const m = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {}
  return (typeof m.screened === 'string' && m.screened.trim().length >= 20) || /^inbox(:|$)/.test(str(m.source))
}
export function staked(questions: readonly Q[]): boolean {
  if (!Array.isArray(questions)) return false
  return questions.some((q) => STAKE.test([str(q?.question), str(q?.header), ...(Array.isArray(q?.options) ? q.options : []).flatMap((o) => [str(o?.label), str(o?.description)])].join('\n')))
}

export function pointsAbove(questions: readonly Q[]): boolean {
  if (!Array.isArray(questions)) return false
  return questions.some((q) => { const t = str(q?.question); return ABOVE.test(t) && !/#local_[0-9a-f-]{8,}|https?:\/\/|claude:\/\//i.test(t) })
}

// Lower-case words, ё read as е; "keep going/on" is a go-on verb, a bare "keep" (keep them?) is a decision. Explicit letter ranges: without the `u` flag `\w` and `\b` do not see Cyrillic.
const words = (s: string): string[] => s.toLowerCase().replace(/ё/g, 'е').replace(/\bkeep (going|on)\b/g, 'continue').split(/[^a-zа-я0-9]+/).filter(Boolean)
const set = (s: string): Set<string> => new Set(s.split(' '))

// The go-on verbs: the question needs one.
const GO = /^(продолж|довест|довед|довод|додел|дожат|дожм|возобнов|приступ|continu|proceed|carry|finish|resume|ahead$|дальше$)/
// Words that add nothing to "go on?": who, the rest of the work, the next wave.
const FILL = set('я мы мне нам ли ну так и а с со до к конца конец все это эту этот эти тут здесь сейчас по плану их его ее ' +
  'хочешь хотите чтобы можно нужно надо мне ' +
  'i we me you should shall can may want would like do to the a an with on go going it this that these them all everything ' +
  'rest remaining up now ahead here next of and')
const FILL_STEM = /^(работ|задач|пункт|шаг|волн|следующ|остальн|оставш|начат|част|flow|task|item|step|wave|round|batch|part|work|thing)/
const YESW = set('да ага ок ok okay yes yep yeah sure давай конечно хорошо please go ahead do it')
const NOW = set('нет no не сейчас надо стоп stop пауза pause позже потом later not now хватит enough подожди wait hold off ' +
  'остановись остановиться here здесь end')
const NOTE = set('recommended рекомендую рекомендуется рекомендовано')
// A stake anywhere in the question, its context or an option: it stays the person's however it is worded.
const STAKE = /(\bpush|пуш|merge|мерж|смерж|деплой|deploy|релиз|release|\btag\b|delet|\bremove|\bwipe|\beras|\boverwrit|(?<![а-я])(удал(?!ос|ас|ся)|убер|убра|сотр(?!удн)|стере(?!о)|стёр|стерл|очист|очищ|сброс|сброш|откат|откач|перезапи|снес|закоммич|задепло)|почист|почищ|подчист|подчищ|деплою|\brevert|\brollback|\broll back|\bdrop\b|\brm\b|reset|force|оплат|\bpay\b|payment|купи|purchase|\$|€|₽|credit|кредит|cost|стоит|потрат|spend|prod\b|прод(?![а-яё])|продакшен|облак|cloud|нов[а-я]* (чат|сесси|координатор)|new (chat|session|coordinator)|handoff|хенд|relaunch|перезапус|перезагруз|restart|reboot|другом (чате|аккаунте)|another (chat|account)|ceiling|\blimit|лимит|budget|бюджет|overnight|на ночь|ночью|чиним|почин|\bfix|исправ|kill|убить|убей|install|установ|send|отправ|email|письм|commit|коммит|migrat|миграц|(?<!\b0 |\bno |\bzero |\bбез |\bнет )(\bfail|\berror|ошибк)|\bbroke\b|\bbroken|(?<![а-я])(упал|пада|слома|войди|залогин|нажми)|\bsign in\b|\blog in\b|\bclick)/i
// What a context (header, option description, wrap_up recap) may name to keep the ask: a step ahead. Status words
// ("fixed 12", "nothing committed", "0 failed") are what a recap reports, so they are not here.
const AHEAD = /(\bpush|пуш|merge|мерж|деплой|deploy|релиз|release|delet|почист|почищ|подчист|подчищ|деплою|\brevert|\brollback|\broll back|(?<![а-я])(очист|очищ|сброс|сброш|откат|откач)|\bremove|\bwipe|\boverwrit|(?<![а-я])удал(?!ос|ас|ся)|\bpay\b|payment|money|оплат|деньги|prod\b|прод(?![а-яё])|продакшен|\bsign in\b|войди|restart|relaunch|перезапус|нов[а-я]* (чат|сесси)|new (chat|session)|\bsend|email|отправ)/i

const filler = (w: string): boolean => FILL.has(w) || FILL_STEM.test(w) || /^\d+$/.test(w)

// The question sentence: from the sentence end before the last "?" (". " with a space, so "app.ts" stays whole) to it.
function lastSentence(s: string): string {
  const q = s.lastIndexOf('?')
  if (q < 0) return s
  let i = q - 1
  while (i >= 0 && !('.!?\n'.includes(s[i]!) && (s[i] === '\n' || /\s/.test(s[i + 1] ?? ' ')))) i--
  return s.slice(i + 1, q + 1)
}

// An option that is only a yes ("Да, доводи (Recommended)") or only a not-now ("Нет, стоп"); null when it says more.
function reply(label: string): 'yes' | 'no' | null {
  const w = words(label).filter((x) => !NOTE.has(x))
  if (!w.length) return null
  const kind = YESW.has(w[0]!) || GO.test(w[0]!) ? 'yes' : NOW.has(w[0]!) ? 'no' : null
  return kind && w.every((x) => YESW.has(x) || NOW.has(x) || GO.test(x) || filler(x)) ? kind : null
}

// True when the question asks only whether to keep going (see the top of the file).
export function onlyContinue(question: string, options: readonly string[], context = ''): boolean {
  if (typeof question !== 'string' || !Array.isArray(options) || question.length > 4000) return false
  const ask = words(lastSentence(question))
  if (ask.length > 25 || !ask.some((w) => GO.test(w)) || !ask.every((w) => GO.test(w) || filler(w))) return false
  if (STAKE.test(question) || AHEAD.test(str(context)) || options.some((o) => typeof o !== 'string' || STAKE.test(o))) return false
  const kinds = options.map(reply)
  return kinds.includes('yes') && kinds.every((k) => k !== null)
}

type Q = { question?: unknown; header?: unknown; options?: readonly { label?: unknown; description?: unknown }[] }
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// The 1-based numbers of the continue-only questions in an AskUserQuestion input. Labels are judged as replies; the
// header and the option descriptions only carry a stake ("Удалит 4 папки").
export function continueQuestions(questions: readonly Q[]): number[] {
  if (!Array.isArray(questions)) return []
  return questions.flatMap((q, i) => {
    const opts = Array.isArray(q?.options) ? q.options : []
    return onlyContinue(str(q?.question), opts.map((o) => str(o?.label)), [str(q?.header), ...opts.map((o) => str(o?.description))].join(' ')) ? [i + 1] : []
  })
}

// wrap_up: an ask whose buttons are all replies (an app action such as commit or create_pr is a real step).
export function continueBox(ask: string, actions: readonly { label?: unknown; action?: unknown }[], recap = ''): boolean {
  if (typeof ask !== 'string' || !ask.trim() || !Array.isArray(actions) || actions.some((a) => str(a?.action))) return false
  // A box with no buttons, or a bare "Продолжить?", is the same yes/no question.
  return onlyContinue(ask, actions.length ? actions.map((a) => str(a?.label)) : ['Да', 'Нет'], recap)
}

export const register: Register = (on) => {
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.tool !== 'AskUserQuestion' || (await $.env.get('MAKARASTY_ASK_GUARD')) === 'off') return next(e)
    if (pointsAbove(e.questions as readonly Q[])) return { deny: ELSEWHERE }
    if (sendsToChat(e.questions as readonly Q[])) return { deny: OTHER_CHAT }
    if (holdsCommand(e.questions as readonly Q[])) return { deny: COMMAND }
    if (asksSelf(e.questions as readonly Q[])) return { deny: SELF }
    if ((await $.env.get('MAKARASTY_SCREEN')) !== 'off' && !staked(e.questions as readonly Q[]) && !screened((e as { metadata?: unknown }).metadata) && !continueQuestions(e.questions as readonly Q[]).length) return { deny: SCREEN }
    const n = continueQuestions(e.questions as readonly Q[])
    if (!n.length) return next(e)
    if (n.length === e.questions.length) return { deny: MESSAGE }
    return { deny: `${MESSAGE} Ask the other questions again without question ${n.join(', ')}.` }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const i = e as unknown as { recap?: unknown; ask?: unknown; actions?: { label?: unknown; action?: unknown }[] }
    if ((await $.env.get('MAKARASTY_ASK_GUARD')) === 'off' || !continueBox(str(i.ask), Array.isArray(i.actions) ? i.actions : [], str(i.recap))) return next(e)
    return { deny: BOX }
  }).catch(($, e, next) => next(e))
}
