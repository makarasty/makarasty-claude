import type { Register } from 'claude-code'

// Refuses a question that only asks whether to go on with work the person already asked for ("Продолжать?",
// "Довести до конца?", "Continue with the remaining tasks?"). People answer it yes, and an open ask blocks the chat's
// turn until they come back [M59] [M67]. Shape, not keywords: the question sentence holds a go-on verb and nothing but
// filler (the rest, the next wave, до конца), every option is a bare yes or not-now, and no word around it (the question, an
// option's description, a header, a wrap_up recap) names a stake: money, prod, a push, a delete or overwrite, a failure, a
// step only the person can do (sign in, click). The question and the labels are tested against all of it; a description,
// header or recap only against the steps ahead (AHEAD), since a recap reports status ("fixed 12", "0 failed"). "Продолжить с миграцией схемы?" names its object and passes.
// AskUserQuestion and the desktop app's end-of-turn box (wrap_up `ask`). MAKARASTY_ASK_GUARD=off drops it.
// Before an AskUserQuestion reaches the person (MAKARASTY_SCREEN=off drops these three): an option that puts off a check
// is refused, a question about how the product or code should behave needs metadata.investigated, and any other question
// without an ask-first act needs metadata.screened.

export const MESSAGE =
  'Not asked: whether to go on with work the person already asked for is answered yes, always. Carry on and report at the end. ' +
  'Ask only what is theirs to decide (a push with its commits, a delete, a real choice between approaches) and name that decision.'
export const BOX = `${MESSAGE} Call wrap_up again without the ask.`
// Every other refusal sends the chat to fix or check something first; this tail keeps the question alive [M85].
export const NOT_DROPPED = ' The refusal does not drop the question: fix it and ask again in this turn, or put it in your reply as one plain line (what you need from the person, your pick); if a check settles it, one line on what you decided.'

// A question that sends the person elsewhere by pointing "above" ("в чате по ссылке выше", "the link above") reaches
// them without that text when the inbox relays it, and they cannot find the chat among dozens. The question itself must
// name the place: the chat's title and account, or the path or command; the link goes in the text right above the call.
export const ELSEWHERE =
  'Not asked: the question points at a link or chat "above", which the person does not see when the dialog is relayed. ' +
  'Name the place in the question itself (the chat title and its account, or the exact path or command) and the exact action, ' +
  'put the chat link [title](#local_<id>) in the text right above the call, then ask again.' + NOT_DROPPED
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
  'tagged powershell), and keep the question a short title ("Запустил? Что вышло?"), then ask again.' + NOT_DROPPED
// Up to eight command-like words (or quoted strings) between the tool and its flag or path: an unbounded gap read prose
// ("12 процессов node из C:\Program Files", "Python в 17 чатах ... -X") as a command [M85].
const TOOLS = '(?:npm|npx|pnpm|yarn|bun|bunx|node|deno|git|gh|python3?|pip|uv|cargo|dotnet|docker|claude|powershell|pwsh|cmd|bash|sh|curl|wget|winget|choco|scoop)'
const CMD = new RegExp(`&&|\\|\\||(?:^|[\\s\`(«"'])cd\\s+["']?(?:[A-Za-z]:[\\\\/]|[~./\\\\])|(?:^|[\\s\`(«"'])${TOOLS}\\s+(?:(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s,;а-яё"']+)\\s+){0,8}?(?:-{1,2}[A-Za-z]|[A-Za-z]:[\\\\/]|\\.{0,2}[\\\\/]\\S|\\S+\\.(?:m?[jt]s|json|ps1|sh|py)\\b)`, 'i')
export function holdsCommand(questions: readonly Q[]): boolean {
  if (!Array.isArray(questions)) return false
  return questions.some((q) => [str(q?.question), ...(Array.isArray(q?.options) ? q.options : []).flatMap((o) => [str(o?.label), str(o?.description)])].some((t) => CMD.test(t)))
}

// Asking the person for a secret, or to run by hand what the agent could run here, stalls the chat on a question it
// should have answered itself: a sandbox password was asked while a local proxy to that database was already up.
export const SELF =
  'Not asked: the question asks the person for a password, token or secret, or to run something themselves. No secret is ' +
  'asked in chat, ever. First find how this machine already reaches it (a local proxy or tunnel, open ports, the env files ' +
  "and scripts the project uses, its docs), do the step yourself, and ask only for a decision that stays the person's." + NOT_DROPPED
// A secret is asked when a verb asks for one anywhere ("введите пароль", "можешь прислать токен"), or when the ask sentence
// or an option names one in the singular ("Пароль от базы?", "Скину пароль"). The question's other sentences and plurals do
// not count: 22 of 23 refusals matched "токенов" of a usage figure, a leak being described or "чат сам запустил" [M85].
// Words are bounded (no "ключевые", "primary_key"); an env name counts only in capitals, so it is matched without the i flag.
const SECRET_WORD = '(?:парол[ьяюе]?(?![а-яё])|password|passwd|токен(?:а|ом|у|ы)?(?![а-яё])|token|секрет(?:а|ом|у|ы)?(?![а-яё])|secret|api[-_ ]?key|(?:stripe|access|private|ssh|signing|license) key|ключ(?:а|ом|у|и)?(?![а-яё])|pin\\b|пин-код|credential|учётн[а-я]* данн|учетн[а-я]* данн)'
const ENV = '\\b[A-Z][A-Z0-9_]*_(?:PASS|PASSWORD|TOKEN|SECRET|KEY)\\b'
const GIVE = '(?:(?:дай|пришли|скинь|кинь|введи|вставь|вбей|напиши|подскажи|сообщи|скажи|продиктуй|отправь|укажи|назови|передай|выдай|предоставь)(?:те)?|дашь|дадите|пришлёшь|пришлешь|пришлёте|пришлете|скинешь|скинете|напишешь|подскажешь|введёшь|введешь|сообщишь|скажешь|передашь|отправишь|укажешь|назовёшь|назовешь|выдашь|вставишь|поделись|поделитесь|прислать|ввести|вставить|скинуть|назвать|написать|подсказать|send|give|paste|share|provide|enter|supply|tell me|what(?:\'s|’s| is| are)(?: the| your))'
// The gap stops at a sentence end (". ") but not at a dot inside ".env" or "v2.1".
const GAP = '(?:[^?!.\\n]|\\.(?=\\S)){0,60}'
const SECRET = new RegExp(`(?<![a-zа-яё])${GIVE}(?![a-zа-яё])${GAP}${SECRET_WORD}`, 'i')
const GIVE_SPAN = new RegExp(`(?<![a-zа-яё])${GIVE}(?![a-zа-яё])(${GAP}\\S*)`, 'gi')
const ENV_RE = new RegExp(ENV)
const asksEnv = (t: string): boolean => [...t.matchAll(GIVE_SPAN)].some((m) => ENV_RE.test(m[1] ?? ''))
// A bare ask for a key or PIN ("Ключ от Stedi?", "Your Stripe key?").
const BARE_KEY = /(?<![a-zа-яё])(?:ключ|key|pin|пин)(?:а|ом|у)?\s+(?:от|для|к|to|for)\s+\S+\?\s*$|^\s*(?:your\s+)?\S+\s+key\?\s*$/i
const NEED = new RegExp(`(?<![a-zа-яё])(?:нужен|нужна|нужны|need)\\s+(?:(?:мне|нам|твой|твоя|ваш|ваша|the|your)\\s+)?${SECRET_WORD}`, 'i')
// Named in the ask or an option, singular, and not as a feature ("восстановление пароля", "secret manager", "хранить токен").
const NAMED = /(?<![a-zа-яё])(?<!(?:ли|без|сброс|сброса|сбросить|сбрось|восстановление|восстановления|показать|хранить|храним|ротировать|reset|forgot|show|store|rotate|hash) )(парол[ьяю](?![а-яё])|password(?![\s-]+(?:reset|rules|policy|length|manager|hash|field|based))|passwd|токен(?:а|ом|у)?(?![а-яё])|token(?![a-z]| (?:refresh|budget|limit|count|usage))|секрет(?:а|ом|у)?(?![а-яё])|secret(?![a-z]| (?:manager|field|store))|api[-_ ]?key|(?:stripe|access|private|ssh|signing|license) key|ключ(?:а|ом|у)? (?:от|для|к)\s|пин-код|credential|учётн[а-я]* данн|учетн[а-я]* данн)/i
const RUN = '(?:запусти|выполни|прогони|подними|перезапусти)(?:те)?(?![а-яё])|(?:запустишь|выполнишь|прогонишь|поднимешь|перезапустишь)|(?:можешь|сможешь|можете|сможете)\\s+(?:[а-яё]+\\s+)?(?:запустить|выполнить|прогнать|поднять|перезапустить)|\\b(?:re)?(?:run|start)\\b|\\b(?:execute|launch|running)\\b'
const BY = '(?<![а-яё])сам(?![а-яё])|самостоятельно|вручную|у себя|yourself|by hand|manually|on your (?:machine|side)'
const BYHAND = new RegExp(`(?:${RUN})[^?!\\n]{0,60}(?:${BY})|(?:${BY})[^?!\\n]{0,30}(?:${RUN})|(?:можешь|сможешь|можете|сможете)\\s+(?:${BY})\\s+(?:запустить|выполнить|прогнать|поднять|перезапустить)`, 'i')
export function asksSelf(questions: readonly Q[]): boolean {
  if (!Array.isArray(questions)) return false
  return questions.some((q) => {
    const labels = (Array.isArray(q?.options) ? q.options : []).map((o) => str(o?.label))
    const t = [str(q?.question), ...labels].join('\n')
    return SECRET.test(t) || asksEnv(t) || NEED.test(t) || BYHAND.test(t) || [lastSentence(str(q?.question)), ...labels].some((s) => NAMED.test(s) || ENV_RE.test(s) || BARE_KEY.test(s))
  })
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
  'password). Otherwise ask again with metadata {"source": "screened: <one line: what you checked and why only the person can answer>"}.' + NOT_DROPPED
export function screened(meta: unknown): boolean {
  const m = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {}
  // Chats put it in metadata.source, the only field the tool's schema shows: 24 of 42 screen and behaviour refusals carried a bare
  // "screened" or "investigated" there [M85]. A bare word still does not pass; the detail does.
  return (typeof m.screened === 'string' && m.screened.trim().length >= 20) || /^screened\s*:\s*\S.{18,}/is.test(str(m.source).trim()) || /^inbox(:|$)/.test(str(m.source))
}
// The screen is skipped only when every question's own ask (its last sentence) or an option label proposes an act that
// stays the person's, matched at a word start. Matched anywhere, evidence did it: "коммит 2026-11-05" in a description,
// "force" inside TWILIO_SIGNATURE_ENFORCE; 139 of 205 questions that were the agent's to check skipped the screen [M76].
const ACT = /(?<![a-zа-яё0-9_])(push|пуш|запуш|merge|мерж|смерж|влить|влей|депло|задепло|deploy|релиз|release|tag\b|delet|удал(?!ос|ас|ся)|убра|убер|сотр(?!удн)|стере(?!о)|стёр|стерл|очист|почист|корзин|wipe|eras|overwrit|перезапи|reset|сброс|revert|rollback|откат|force|оплат|pay\b|payment|купи|purchase|денег|деньг|money|\$|€|₽|prod\b|прод[еуа]?(?![а-яё])|продакшен|sign in|log in|войди|залогин|restart|перезапус|kill|pid\b|send|email|письм|отправ)/i
// "Отправить разработчику" is a route the agent offers beside a product choice, not a send the question is about.
const LABEL_ACT = new RegExp(ACT.source.replace('|send|email|письм|отправ', ''), 'i')
const stakedOne = (q: Q): boolean => ACT.test(lastSentence(str(q?.question))) || (Array.isArray(q?.options) ? q.options : []).some((o) => LABEL_ACT.test(str(o?.label)))
export function staked(questions: readonly Q[]): boolean {
  if (!Array.isArray(questions) || !questions.length) return false
  return questions.every(stakedOne)
}

// How the product or code should behave is not asked on a name or a grep: "сначала Reactivate" rested on a wrapper's name
// while the rule it wrapped allowed only Disenrolled, and "запрещать везде" broke working pages [M76]. Such a question
// carries what an investigation found; the hook message is fresh at call time, where a rule from session start is 300k tokens back.
export const BEHAVIOUR =
  'Not asked yet: this asks how the product or code should behave. First run one read-only investigation (an Explore agent, ' +
  'Sonnet high): every caller of the code each option changes (menus, other apps, API, crons); `git log -S`/`-L` for each ' +
  'side (who, when, why); real usage (a read-only count, or "не посчитано: <why>"); what each option breaks for a user. ' +
  'Open every function a claim rests on: a name is not a check. Put what you found in the question in 3-5 plain lines, mark ' +
  'anything unchecked "не проверено", then ask again with metadata {"source": "investigated: callers: ...; history: ...; usage: ..."}.' + NOT_DROPPED
// Not "что делать / что делаем": a plain decision (a Spotify update, the weekend plan, HTML reports) asks it too, 8 of 8 hits [M85].
const BEHAVES = /(?<![a-zа-яё])(как (должн|правильно|делать|сделать|быть|забирать|тестировать|закрываем|растягивать|встаёт|встает)|должн|должен|что верно|чем чинить|насколько|как задумано|так задумано|это дефект|запрещ|запрет|разреш|ограничива|скрыва|скрыть|оставля|хранить|should|behav|allow|refuse|block)/i
// A stake question is the person's whatever it asks; the gate is for the rest.
export function behaviour(questions: readonly Q[]): boolean {
  if (!Array.isArray(questions)) return false
  return questions.some((q) => !stakedOne(q) && BEHAVES.test([lastSentence(str(q?.question)), ...(Array.isArray(q?.options) ? q.options : []).map((o) => str(o?.label))].join('\n')))
}
export function investigated(meta: unknown): boolean {
  const m = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {}
  const src = /^\s*investigated\s*:([\s\S]*)$/i.exec(str(m.source))
  const t = [str(m.investigated), src ? src[1]! : ''].sort((a, b) => b.length - a.length)[0]!
  return t.trim().length >= 80 && /(caller|вызыва|вызов|кто зов|callers|menu|меню)/i.test(t) && /(git|histor|истори|коммит|commit)/i.test(t) && /(usage|count|посчит|prod|прод|used|использ)/i.test(t)
}

// An option that holds the check ("Сначала я смотрю логи", "Запретить, сначала посчитать") asks the person to approve work
// the agent could do now; the question then rests on what it has not looked at.
export const DEFERRED =
  'Not asked yet: an option puts off a check ("сначала посмотрю / посчитаю"). That check is part of the question: do it now, ' +
  'then ask again with its result in the question text.' + NOT_DROPPED
// The agent's own voice ("сначала я смотрю", "сначала посчитать"); an option in the person's voice ("сначала посмотрю превью") is theirs.
const DEFERS = /сначала,?\s+(я\s+(смотр|посмотр|провер|гляну|сверю|посчита|изуч|разбер|выясн)|посчитать|проверить,? (ошибк|есть ли|сколько)|посмотреть,? (логи|есть ли|сколько))|first,?\s+i('ll| will)?\s+(check|look|verify|count)/i
export function defers(questions: readonly Q[]): boolean {
  if (!Array.isArray(questions)) return false
  return questions.some((q) => (Array.isArray(q?.options) ? q.options : []).some((o) => DEFERS.test(`${str(o?.label)}\n${str(o?.description)}`)))
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

// A refused ask still needs the person, or one line saying the chat settled it. Of 75 chains of refused asks 11-06..11-20,
// 3 lost a question outright (6 in all, 4 of them one dialog its chat forgot while the investigation the refusal asked for
// ran) [M85]. `ledger` (registered right after loop-guard, so it sees every guard's refusal) notes each refused dialog or
// end-of-turn ask by call id, prompt count and session; a later passing ask, or a question line the chat writes after the
// refused call, covers it. The rest goes back to the chat from the plugin's one Stop hook (gates.ts), at most once a turn.
type Msg = { role: string; text: string; toolUses?: readonly { tool_use_id?: string }[] }
type Refusal = { question: string; why: string; id: string; turn: number; session: string }
export type Ledger = { refused: Refusal[]; sentBack: boolean }
export const freshLedger = (): Ledger => ({ refused: [], sentBack: false })
const ledgerNow = freshLedger()
// Five-letter stems, so a re-ask in other word forms ("сессий" / "сессии") still matches; numbers stay whole (PR 41 / PR 42).
// The inbox's "<project> · <chat title>: " tag is dropped first: every question it relays from one chat carries it.
const core = (s: string): string => s.replace(/^[^:?\n]{2,80} · [^:?\n]{2,120}:\s+/, '')
const stems = (s: string): string[] => [...new Set(words(core(s)).filter((w) => w.length > 3 || (/^\d+$/.test(w) && w.length > 1)).map((w) => w.slice(0, 5)))]
// Whether a question was asked is decided only by what reaches the person as a question: a passing ask, or a written line
// with "?". Narration, status and decision lines never clear one, however many of its words they reuse ("Закоммитил в
// makarasty-claude (master)"); a wrong reminder costs one continuation, a wrong clear loses the question [M85].
// A shown ask is judged against the shorter side (a re-ask often cuts a long question to a line) but needs four shared
// stems (all of a shorter question's), so "Какой вариант лучше?" covers no long question.
export const COVER = 0.5
export function covers(text: string, question: string): boolean {
  const q = stems(question)
  if (!q.length) return words(question).length > 0 && ` ${words(text).join(' ')} `.includes(` ${words(question).join(' ')} `)
  const t = new Set(stems(text))
  const hits = q.filter((w) => t.has(w)).length
  return hits >= Math.min(q.length, 4) && hits / Math.max(Math.min(q.length, t.size), Math.min(q.length, 4)) >= COVER
}
export function saidIn(text: string, question: string): boolean {
  return text.split(/\n+/).some((line) => line.includes('?') && covers(line, question))
}
// A re-worded retry (an earlier call) replaces its earlier wording when most stems are shared. At 0.75 the replay's real
// retries stayed as duplicates (up to 6 lines for 3 questions); below 0.6 short look-alikes merge ("...сообщений?" / "...отчётов?").
export const RETRY = 0.6
const same = (a: string, b: string): boolean => {
  const x = new Set(stems(a)), y = stems(b)
  const both = y.filter((w) => x.has(w)).length
  return both > 0 && both / (x.size + y.length - both) >= RETRY
}
export function noteRefusal(st: Ledger, questions: readonly string[], deny: string, id = '', turn = 0, session = ''): void {
  const why = deny.replace(/^Not asked( yet)?: /, '').split(/(?<=[.!?])\s/)[0]!.slice(0, 160)
  // A re-worded retry (an earlier call, most stems shared) replaces its earlier wording; one dialog's questions never
  // replace each other, and two questions that only share a prefix ("5056_life_lines-app · Флит отчётов: ...") both stay.
  const fresh = questions.filter((q) => q.trim())
  st.refused = st.refused.filter((r) => !fresh.some((q) => same(q, r.question)))
  for (const question of fresh) st.refused.push({ question, why, id, turn, session })
}
// Each shown question on its own as well as the whole (the options' text would outweigh a re-ask cut to one line); a recap
// is a line the person reads, not a question, so it is judged as one.
export function notePassed(st: Ledger, asks: readonly string[], said = ''): void {
  st.refused = st.refused.filter((r) => !asks.some((t) => covers(t, r.question)) && !(said && saidIn(said, r.question)))
}
// At a Stop: this turn's refusals that nothing after their call covered. A refusal from an earlier prompt (an aborted or
// failed turn) or another conversation (/clear) is dropped: the person was there or the turn is gone. The ledger empties.
export function leftAtStop(st: Ledger, msgs: readonly Msg[], last = '', turn = 0, session = ''): Refusal[] {
  const at = (id: string): number => (id ? msgs.findIndex((m) => m.toolUses?.some((u) => u.tool_use_id === id)) : -1)
  const left = st.refused.filter((r) => {
    if (r.turn !== turn || r.session !== session) return false
    const i = at(r.id)
    const after = i >= 0 ? msgs.slice(i + 1).filter((m) => m.role === 'assistant').map((m) => m.text).join('\n') : ''
    return !saidIn(`${after}\n${last}`, r.question)
  })
  st.refused = []
  return left
}
export function reminder(left: readonly Refusal[]): string {
  const one = left.length === 1
  return `Not finished: ${one ? 'a question' : `${left.length} questions`} this turn tried to ask the person ${one ? 'was' : 'were'} refused by a guard and never reached them:\n` +
    left.map((r, i) => `${i + 1}. «${r.question.length > 300 ? `${r.question.slice(0, 300)}…` : r.question}» (refused: ${r.why})`).join('\n') +
    '\nFor each: ask it again now, fixed the way the refusal said, or write it in your last message as one plain numbered line ' +
    '(what you need from the person, the options, your pick). If you settled it yourself, one line on what you decided and why.'
}
type Session = { session: { messages(): Promise<readonly Msg[]>; turns(): Promise<number>; id(): Promise<string> } }
async function where($: Session): Promise<[number, string]> {
  return [await $.session.turns().catch(() => -1), await $.session.id().catch(() => '')]
}
// Once a turn: a Stop that comes back after this hook's own block (stop_hook_active) ends the turn whatever is left, so a chat
// that keeps re-wording into new refusals cannot loop. gates.ts calls askStopSeen on every Stop, before the checks that may
// send the turn back first, so the mark never outlives its turn and a Stop sent back by another check still gets this one.
export function askStopSeen(e: { stop_hook_active?: boolean }): void {
  if (!e.stop_hook_active) ledgerNow.sentBack = false
}
export async function askStop($: { env: { get(k: string): Promise<string | undefined> } } & Session, e: { last_assistant_message?: string }): Promise<string | undefined> {
  if (!ledgerNow.refused.length) return undefined
  if (ledgerNow.sentBack || (await $.env.get('MAKARASTY_ASK_GUARD')) === 'off') { ledgerNow.refused = []; return undefined }
  const [turn, session] = await where($)
  const left = leftAtStop(ledgerNow, await $.session.messages().catch(() => []), e.last_assistant_message ?? '', turn, session)
  if (!left.length) return undefined
  ledgerNow.sentBack = true
  return reminder(left)
}
const askTexts = (qs: readonly Q[]): string[] => [...qs.map((q) => str(q?.question)), qs.map((q) => [str(q?.question), ...(Array.isArray(q?.options) ? q.options : []).map((o) => `${str(o?.label)} ${str(o?.description)}`)].join('\n')).join('\n')]
// Everything after next(e): a throw there must not run the dialog twice, so nothing here may throw.
async function record($: Session, r: { deny?: string; isError?: boolean }, id: unknown, refused: () => string[], shown: () => string[], said = ''): Promise<void> {
  try {
    if (r.deny === undefined) { if (!r.isError) notePassed(ledgerNow, shown(), said); return }
    const [turn, session] = await where($)
    noteRefusal(ledgerNow, refused(), r.deny, str(id), turn, session)
  } catch { /* the ledger is advice: a failure leaves the call's own result alone */ }
}
export const ledger: Register = (on) => {
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const r = await next(e)
    const i = e as unknown as { agentId?: unknown; tool_use_id?: unknown; questions?: unknown }
    if (i.agentId) return r
    const qs = (Array.isArray(i.questions) ? i.questions : []) as readonly Q[]
    await record($, r, i.tool_use_id, () => { const cont = new Set(continueQuestions(qs)); return qs.filter((_, n) => !cont.has(n + 1)).map((q) => str(q?.question)) }, () => askTexts(qs))
    return r
  })
  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const r = await next(e)
    const i = e as unknown as { agentId?: unknown; tool_use_id?: unknown; recap?: unknown; ask?: unknown; actions?: unknown }
    if (i.agentId) return r
    const acts = (Array.isArray(i.actions) ? i.actions : []) as { label?: unknown; action?: unknown }[]
    await record($, r, i.tool_use_id, () => (continueBox(str(i.ask), acts, str(i.recap)) ? [] : [str(i.ask)]), () => (str(i.ask).trim() ? [str(i.ask)] : []), str(i.recap))
    return r
  })
}

export const register: Register = (on) => {
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.tool !== 'AskUserQuestion' || (await $.env.get('MAKARASTY_ASK_GUARD')) === 'off') return next(e)
    if (pointsAbove(e.questions as readonly Q[])) return { deny: ELSEWHERE }
    if (sendsToChat(e.questions as readonly Q[])) return { deny: OTHER_CHAT }
    if (holdsCommand(e.questions as readonly Q[])) return { deny: COMMAND }
    if (asksSelf(e.questions as readonly Q[])) return { deny: SELF }
    const meta = (e as { metadata?: unknown }).metadata
    if ((await $.env.get('MAKARASTY_SCREEN')) !== 'off' && !continueQuestions(e.questions as readonly Q[]).length && !/^inbox(:|$)/.test(str((meta as { source?: unknown } | undefined)?.source))) {
      if (defers(e.questions as readonly Q[])) return { deny: DEFERRED }
      if (behaviour(e.questions as readonly Q[]) && !investigated(meta)) return { deny: BEHAVIOUR }
      if (!staked(e.questions as readonly Q[]) && !screened(meta) && !investigated(meta)) return { deny: SCREEN }
    }
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
