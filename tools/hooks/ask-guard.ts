import type { Register } from 'claude-code'

// Refuses a question that only asks whether to go on with work the person already asked for ("Продолжать?",
// "Довести до конца?", "Continue with the remaining tasks?"). People answer it yes, and an open ask blocks the chat's
// turn until they come back [M59] [M67]. Shape, not keywords: the question sentence holds a go-on verb and nothing but
// filler (the rest, the next wave, до конца), every option is a bare yes or not-now, and no word around it names a
// stake (money, prod, a push, a delete, a relaunch). "Продолжить с миграцией схемы?" names its object and passes.
// AskUserQuestion and the desktop app's end-of-turn box (wrap_up `ask`). MAKARASTY_ASK_GUARD=off drops it.

export const MESSAGE =
  'Not asked: whether to go on with work the person already asked for is answered yes, always. Carry on and report at the end. ' +
  'Ask only what is theirs to decide (a commit or a push with its files, a delete, a real choice between approaches) and name that decision.'
export const BOX = `${MESSAGE} Call wrap_up again without the ask.`

// Lower-case words, ё read as е. Explicit letter ranges: without the `u` flag `\w` and `\b` do not see Cyrillic.
const words = (s: string): string[] => s.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter(Boolean)
const set = (s: string): Set<string> => new Set(s.split(' '))

// The go-on verbs: the question needs one.
const GO = /^(продолж|довест|довед|довод|додел|дожат|дожм|возобнов|приступ|continu|proceed|carry|finish|keep|resume|ahead$|дальше$)/
// Words that add nothing to "go on?": who, the rest of the work, the next wave.
const FILL = set('я мы мне нам ли ну так и а с со до к конца конец все это эту этот эти тут здесь сейчас по плану их его ее ' +
  'хочешь хотите чтобы можно нужно надо мне ' +
  'i we me you should shall can may want would like do to the a an with on go going it this that these them all everything ' +
  'rest remaining up plan now ahead here next of and')
const FILL_STEM = /^(работ|задач|пункт|шаг|волн|следующ|остальн|оставш|начат|част|flow|task|item|step|wave|round|batch|part|work|thing)/
const YESW = set('да ага ок ok okay yes yep yeah sure давай конечно хорошо please go ahead do it')
const NOW = set('нет no не сейчас надо стоп stop пауза pause позже потом later not now хватит enough подожди wait hold off ' +
  'остановись остановиться here здесь end')
const NOTE = set('recommended рекомендую рекомендуется рекомендовано')
// A stake anywhere in the question, its context or an option: it stays the person's however it is worded.
const STAKE = /(\bpush|пуш|merge|мерж|смерж|деплой|deploy|релиз|release|\btag\b|delet|удали|удален|удаля|снест|снос|\bdrop\b|\brm\b|reset|force|оплат|\bpay\b|payment|купи|purchase|\$|€|₽|credit|кредит|cost|стоит|потрат|spend|prod\b|прод(?![а-яё])|продакшен|облак|cloud|нов[а-я]* (чат|сесси|координатор)|new (chat|session|coordinator)|handoff|хенд|relaunch|перезапус|перезагруз|restart|reboot|другом (чате|аккаунте)|another (chat|account)|ceiling|\blimit|лимит|budget|бюджет|overnight|на ночь|ночью|чиним|почин|\bfix|исправ|kill|убить|убей|install|установ|send|отправ|email|письм|commit|коммит|migrat|миграц)/i

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
export function onlyContinue(question: string, options: readonly string[]): boolean {
  if (typeof question !== 'string' || !Array.isArray(options) || question.length > 4000) return false
  const ask = words(lastSentence(question))
  if (ask.length > 25 || !ask.some((w) => GO.test(w)) || !ask.every((w) => GO.test(w) || filler(w))) return false
  if (STAKE.test(question) || options.some((o) => typeof o !== 'string' || STAKE.test(o))) return false
  const kinds = options.map(reply)
  return kinds.includes('yes') && kinds.every((k) => k !== null)
}

type Q = { question?: unknown; options?: readonly { label?: unknown }[] }
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// The 1-based numbers of the continue-only questions in an AskUserQuestion input.
export function continueQuestions(questions: readonly Q[]): number[] {
  if (!Array.isArray(questions)) return []
  return questions.flatMap((q, i) => (onlyContinue(str(q?.question), (Array.isArray(q?.options) ? q.options : []).map((o) => str(o?.label))) ? [i + 1] : []))
}

// wrap_up: an ask whose buttons are all replies (an app action such as commit or create_pr is a real step).
export function continueBox(ask: string, actions: readonly { label?: unknown; action?: unknown }[]): boolean {
  if (typeof ask !== 'string' || !ask.trim() || !Array.isArray(actions) || actions.some((a) => str(a?.action))) return false
  // A box with no buttons, or a bare "Продолжить?", is the same yes/no question.
  return onlyContinue(ask, actions.length ? actions.map((a) => str(a?.label)) : ['Да', 'Нет'])
}

export const register: Register = (on) => {
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.tool !== 'AskUserQuestion' || (await $.env.get('MAKARASTY_ASK_GUARD')) === 'off') return next(e)
    const n = continueQuestions(e.questions as readonly Q[])
    if (!n.length) return next(e)
    if (n.length === e.questions.length) return { deny: MESSAGE }
    return { deny: `${MESSAGE} Ask the other questions again without question ${n.join(', ')}.` }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const i = e as unknown as { ask?: unknown; actions?: { label?: unknown; action?: unknown }[] }
    if ((await $.env.get('MAKARASTY_ASK_GUARD')) === 'off' || !continueBox(str(i.ask), Array.isArray(i.actions) ? i.actions : [])) return next(e)
    return { deny: BOX }
  }).catch(($, e, next) => next(e))
}
