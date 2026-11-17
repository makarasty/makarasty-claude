import type { Register } from 'claude-code'

// Where a finding goes, and where a brief item goes. A line that names a defect or a skipped check and stops there
// ("я её не трогал", "не проверял") under a "всё закрыто" recap is the drop the person found most: the TaskNotesStream
// failure sat 7 days, a possible PHI leak was named and left [M76]. The rules agreed only on "name it", so naming became the end.
// Now each such line carries its destination in the same line: fixed, asked, recorded in a findings file, or handed to a
// chat, card or person. The end of a main turn (Stop) and of a subagent (SubagentStop) is refused once when a line has
// none. MAKARASTY_ROUTES=off drops it.

// A finding or a skipped item, read per line (a header line with its list as one). A plain "не проверено: X" about the
// work just done is the honest caveat the person asked for and needs no route: over 14 days of final replies that
// wider net hit 12% of turns, mostly such caveats [M76].
const MARK = /(?<![a-zа-яё])(не (трогал|трогала|разбирал|разбирала|разбирались|чинил|чинила|исправлял|исправлено|исправлен[аоы]?|починен[аоы]?|сделан[аоы]?|доделан[аоы]?|делал)|не стал (чинить|трогать|исправлять)|not (touched|fixed|covered|done|addressed)|(are|is|were|was)n['’]t (covered|touched|fixed|done)|(are|is|were) not (covered|done)|left out|did not (fix|touch|cover|address|read|review|look at)|didn['’]t (fix|touch|cover|address|read|review|look at)|left (alone|as is|for later|untouched)|оставил (на потом|как есть)|недодел|вне (задачи|рамок)|за рамками|beyond the task|out of scope|outside the task)/i
// A destination in the same line: fixed or done here, asked, recorded, handed on, or blocked by something named.
const ROUTE = /(исправил|исправлено (здесь|сейчас|в этом)|починил|fixed (it|now|here)|спрашиваю|вопрос (ниже|выше|в конце|в рамке|в окне)|в вопросе|ask(ed|ing)? (you|him|the person)|записал|записано|recorded|findings|(завёл|завел|повесил|создал|предложил|предлагаю|поставил|added|filed|opened|proposed) [^.\n]{0,20}(карточк|чип|задач|card|chip|task|issue)|карточк[ау] «|\bcard\b «|чип(ом)? «|\bchip\b|жду (выбор|решени)|передал|передано|handed|hand(ed)? (it )?to|#local_|сесси[яюи]|session|в (чат|чате) [«"]|задач[ауи] (на|в|для)|issue #?\d|тикет|ticket|next step|следующ(ий|им) шаг|займусь|чуж(ой|ого|ие|их)|друг(ого|ой|их) чат|another chat|other chats?|другой сессии|жду (тво|ваш|ответ)|waiting for (you|your)|нет доступа|no access|нельзя|cannot|can['’]t|не могу|запрещ|denied|blocked|отказ|причина:|because|потому что|так как)/i
// A status line, not a finding: "push не делал", "ничего не закоммичено".
const STATUS = /(push|пуш|коммит|commit|закоммич)[^.\n]{0,25}(не (делал|делался|сделан|было)|not (done|made))|(не (делал|сделан[оаы]?)|not done)[^.\n]{0,25}(push|пуш|коммит|commit|закоммич)/i
// "не трогал" alone is mostly a reassurance ("localStorage не трогали", "их правки не трогал"); it is a finding when the
// same item names a defect.
const TOUCH = /(?<![a-zа-яё])(не (трогал|трогала|трогали)|did not touch|didn['’]t touch|left (alone|untouched))/i
const DEFECT = /(ошибк|дефект|баг|bug|пада|пала|fails?\b|failing|сломан|broken|не работа|doesn['’]t work|нашёл|нашла|найден|нашлось|странн|утечк|leak|мига|flaky|нестабил|контраст|regress|crash)/i
const DONE =/(готово|сделано|сделал|закрыт[ыо]?|выполнен|всё|все \d+|done|fixed|complete|finished|ready)/i

export const MAIN =
  'Not finished: these lines name a finding, a skipped item or an unchecked claim with no destination. Give each one its ' +
  'destination in the same line: fixed now (your own files, a few minutes, nothing on the ask-first list), asked (the ' +
  "turn's one question), recorded (a line in the project's open-findings file, docs/FINDINGS-OPEN.md if the project has " +
  "one, else ~/.claude/makarasty/findings/<project>.md, which unfinished reads), or handed (which chat, card or person). " +
  'A check of a minute is run, not named. Lines:'
export const SUB =
  'Not finished: your report names an item you did not do or check, with no reason that stops you. An item of your ' +
  'brief is done now; one you truly cannot do here is named with what blocks it (no access, another chat\'s file, a ' +
  'decision only the person makes). Lines:'

export function unrouted(text: string): string[] {
  if (typeof text !== 'string' || text.length > 200000) return []
  // A line ending in ":" heads the list under it: they are one item.
  const blocks: string[] = []
  for (const l of text.split(/\n|(?<=[.!?])\s+(?=[A-ZА-ЯЁ*`-])/).map((x) => x.trim())) {
    const prev = blocks[blocks.length - 1]
    if (prev !== undefined && /:\**$/.test(prev.split('\n')[0]!) && /^([-*•]|\d+[.)])\s/.test(l)) blocks[blocks.length - 1] = `${prev}\n${l}`
    else if (l) blocks.push(l)
  }
  const finding = (l: string): boolean => {
    if (!MARK.test(l) || ROUTE.test(l) || STATUS.test(l)) return false
    const marks = l.match(new RegExp(MARK.source, 'gi')) ?? []
    return !marks.every((m) => TOUCH.test(m)) || DEFECT.test(l)
  }
  return blocks.filter(finding).slice(0, 6)
}
export function claimsDone(text: string): boolean { return DONE.test(text) }

// A brief that lists several items with no "done when" lets its closing line narrow the scope: two of three tools were
// never reviewed and the hand-back called that a choice [M76].
export const BRIEF =
  'Not sent: this brief lists several items and has no "Done when" that covers every one. Add one line, "Done when: ' +
  '<each item by name, with what proves it>"; put the person\'s special interest first, never as the closing line, then send again.'
const ITEM = /^\s*(\d+[.)]|[-*•]|\([a-z0-9]\))\s+\S/gm
const DONE_WHEN = /(done when|done-when|готово,? когда|сделано,? когда|критери[йи] готовности|acceptance)/i
// "If it is a product call, ask the owner" licensed the Schedule call question on a grep [M76].
export const LICENSE =
  'Not sent: this brief lets the subagent ask the person on a product or behaviour call with no investigation first. Write ' +
  '"after the investigation pass (every caller, git history, real usage, what each option breaks)" into that line, then send again.'
const ASK_LICENSE = /(?<![a-zа-яё])(if|when|если|когда)[^.\n]{0,80}(product|продукт|behaviou?r|поведени|design|choice|выбор|call\b|решени)[^.\n]{0,60}(ask|спроси|задай вопрос)/i
const INVESTIGATE = /(investigat|расслед|callers|вызыва|git (log|history)|истори)/i
export function briefLicensesAsk(prompt: string): boolean {
  return typeof prompt === 'string' && prompt.length < 100000 && ASK_LICENSE.test(prompt) && !INVESTIGATE.test(prompt)
}
export function briefLacksDone(prompt: string): boolean {
  if (typeof prompt !== 'string' || prompt.length > 100000) return false
  return (prompt.match(ITEM) ?? []).length >= 3 && !DONE_WHEN.test(prompt)
}

let turn = { asked: false, recorded: false, recap: '' }

const lines = (l: string[]) => l.map((x, i) => `\n${i + 1}. ${x.slice(0, 200)}`).join('')

// The end of a main turn. One plugin gets one unmatched Stop hook, and gates.ts owns it, so it calls this.
export async function stopBlock($: { env: { get(k: string): Promise<string | undefined> } }, e: { stop_hook_active?: boolean; last_assistant_message?: string }): Promise<string | undefined> {
  const t = turn
  turn = { asked: false, recorded: false, recap: '' }
  if (e.stop_hook_active || t.asked || t.recorded || (await $.env.get('MAKARASTY_ROUTES')) === 'off') return undefined
  const text = `${t.recap}\n${e.last_assistant_message ?? ''}`
  const bad = unrouted(text)
  return bad.length && claimsDone(text) ? MAIN + lines(bad) : undefined
}

export const register: Register = (on) => {
  turn = { asked: false, recorded: false, recap: '' }

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const r = await next(e)
    if (!('deny' in (r as object))) turn.asked = true
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^(Write|Edit|MultiEdit)$/ }, async ($, e, next) => {
    const r = await next(e)
    if (!('deny' in (r as object)) && /findings/i.test(String((e as unknown as { file_path?: unknown }).file_path ?? ''))) turn.recorded = true
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const i = e as unknown as { recap?: unknown; ask?: unknown }
    const r = await next(e)
    if (!('deny' in (r as object))) { turn.recap = String(i.recap ?? ''); if (String(i.ask ?? '').trim()) turn.asked = true }
    return r
  }).catch(($, e, next) => next(e))

  // A subagent brief, or a session brief (start_session's prompt and background). A fleet agent works from its task file,
  // which carries its own done criteria (docs/PROTOCOL.md).
  on('tool.call', { tool: /^(Agent|Task|mcp__ccd_session__start_session)$/ }, async ($, e, next) => {
    const i = e as unknown as { prompt?: unknown; background?: unknown; subagent_type?: unknown }
    const prompt = `${String(i.prompt ?? '')}
${String(i.background ?? '')}`
    if (!((await $.env.get('MAKARASTY_ROUTES')) === 'off')) {
      if (!/^makarasty:fleet-/.test(String(i.subagent_type ?? '')) && briefLacksDone(prompt)) return { deny: BRIEF }
      if (briefLicensesAsk(prompt)) return { deny: LICENSE }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    const out = await next(e)
    if (e.stop_hook_active || (out as { block?: unknown }).block || ((await $.env.get('MAKARASTY_ROUTES')) === 'off')) return out
    const bad = unrouted(String(e.last_assistant_message ?? ''))
    return bad.length ? { ...out, block: SUB + lines(bad) } : out
  })
}
