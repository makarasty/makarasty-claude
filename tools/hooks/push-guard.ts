import type { Register } from 'claude-code'
import { gitSubs } from './git-guard.ts'
import { PLUGIN_FRAME, ownWords } from './own-words.ts'
import { isTelegramPrompt, telegramWords } from './telegram.ts'
import { deliveredPairs, inboxAnswer, type Heard } from './consent.ts'
import { itemId } from '../skills/inbox/core.mjs'

// A push leaves this machine: it runs only on the person's own word in this turn (2026-11-12, asked "block git push
// without my word in the turn?": «Да, хук»; three pushes nobody asked for on 11-10; docs/COMPLAINTS.md C13). His word:
//  - a prompt he typed (composer or the phone bridge) with a sentence that tells a push («запушь», «пушим», "push
//    it"): not a question, not negated in that sentence («пушить не надо», "don't push"), not a word about the guard;
//  - a "yes" he typed right after this chat's end-of-turn ask that named a push;
//  - his yes to an AskUserQuestion of this turn whose question names a push;
//  - his answer to this chat's push question given in the inbox chat or on the phone, as a dialog result or as the
//    prompt that starts this turn, only beside the hook's record of his act (consent.ts Heard), never on its text alone.
// A brief, another session's message, a paste, an app reminder or a standing answer is not his word. Typed during a
// turn, "stop, don't push" withdraws it. `--dry-run`/`-n` is no push. MAKARASTY_PUSH_GUARD=off drops it.
// 2026-11-16 «можешь спокойно сам пушить»: a plain push of a named branch runs without his word; only main/master,
// force, delete, tags, mirror, any other flag, or a push with no branch named (it may be main) still needs it.
// shortcut: a push inside a script (`npm run release`), an alias from ~/.gitconfig or a GUI client is not seen; this
// stops a chat's own unasked `git push`, not a determined bypass.

export const MESSAGE =
  'Blocked by makarasty-tools push-guard: this push (to main/master, --force-with-lease, deleting, tags, an unusual flag, or no branch ' +
  'named) needs the person\'s own word in this turn, and none came (his answer in the inbox or on the phone counts; a brief, ' +
  'another chat\'s message, a standing answer or a plugin message the inbox has no record of his answer for does not). A plain `git push <remote> <branch>` of a work branch needs no word. Ask with AskUserQuestion: the branch, the remote and the ' +
  'commits it sends, options "Да, пушь" / "Нет". His yes (or a typed «запушь») lets the push run. MAKARASTY_PUSH_GUARD=off turns this off.'

// A path into the folder, not the word: a grep or a commit message that names it runs.
const HEARD = /heard[-_]?answers["']?[\\/]/i
export const HEARD_MESSAGE =
  'Blocked by makarasty-tools push-guard: heard-answers is the inbox\'s record of the person\'s own answers, written only by ' +
  'the plugin at the moment he answers. A chat does not read around it or write it. To get his word, ask him (AskUserQuestion).'

// The verb, not the noun or a name: пушь/пушим/запушь/запушить/пуш, push (not push-guard, pushed, Пушкин, push notifications).
// An order to the chat, not «пушу сам» (he pushes himself) or «залей файл».
const PUSH = /(?<![a-zа-яё])(за)?пуш(ь|и|им|ить|ни|нуть|ай|ьте|ите)?(?![a-zа-яё-])|(?<![a-z-])push(?![a-z-])(?!\s+notification)/i
// A negation, a put-off or a condition in the same clause («пушить будем завтра», «да, но сначала diff», "push it after review"): not now.
// («закоммить, потом запушь» is an order of steps in this turn, not a put-off.)
const NEG = /(?<![a-zа-яё])(не|нет|без|нельзя|никогда|рано|пока не|завтра|позже|но|сначала|только|no|not|never|without|don['’]?t|do not|no need|later|tomorrow|but|first|only)(?![a-zа-яё])/i
const YES = /^\s*(да|ага|угу|ок|ok|okay|yes|yep|yeah|давай|конечно|го|пушь|пуш|пушим|запушь|push|sure|делай|сделай|подтверждаю|ладно|\+)(?![a-zа-яё])/i

// Clauses: «закоммить и запушь, без лишних вопросов» keeps its push; «закоммить, пушить не надо» does not.
const sentences = (t: string): string[] => t.split(/(?<=[.!?\n;,])\s*/)
// A sentence that tells a push: has the verb, is not a question, holds no negation.
const tells = (s: string): boolean => PUSH.test(s) && !/\?\s*$/.test(s.trim()) && !NEG.test(s)
export const asksPush = (text: string): boolean => sentences(ownWords(text)).some(tells)
const withdraws = (text: string): boolean => sentences(ownWords(text)).some((s) => PUSH.test(s) && NEG.test(s) && !/\?\s*$/.test(s.trim()))
// A yes, or an answer that itself tells the push ("Пушим", "запушь сейчас", typed as the dialog's own answer).
const yes = (answer: string): boolean => (YES.test(answer) && !NEG.test(answer)) || tells(answer)
// A question that offers a push («Пушим 3 коммита?»), not one that offers to hold it («Закоммитить локально, не пушить?»).
// Judged per clause, so «Пушим 3 коммита? Другой чат не активен.» still offers it; «Пушу 3 коммита?» is the chat speaking.
const pushQ = (q: string): boolean => sentences(q).some((s) => (PUSH.test(s) || /(?<![a-zа-яё])(за)?пушу(?![a-zа-яё])/i.test(s)) && !NEG.test(s))

// The text of an inbox-delivered answer says yes to a push (framed by the app or not: consent.ts reads it). Text alone
// grants nothing: heardYes must hold for the same question.
export function deliveredYes(text: string): boolean {
  return deliveredPairs(text).some((p) => pushQ(p.question) && yes(p.answer))
}
// His answer on record (consent.ts Heard) says yes to this chat's push `question`. A typed one must tell the push itself
// («да, пушь»): a bare «да» typed in the inbox chat may answer something else the inbox showed him.
export function heardYes(question: string, heard: Heard | undefined): boolean {
  return !!heard && heard.pairs.some((p) => tells(p.answer) || (pushQ(question) && pushQ(p.question) && (heard.via === 'typed' ? asksPush(p.answer) : yes(p.answer))))
}

export function pushes(cmd: string, tool: string): boolean {
  if (!/\bgit\b|\$/i.test(cmd)) return false
  if (/\bgit\b[^;&|\n]*\s-c\s*["']?alias\.\S+=["']?!?(git\s+)?push\b/i.test(cmd)) return true // `git -c alias.p=push p`
  // A dry run: --dry-run, or -n in a cluster of push's own short flags (not `-onoop`, a push option).
  return gitSubs(cmd, tool).some(({ sub }) => (/^push(\s|$)/.test(sub) && !/\s(--dry-run|-[fuqvd46]*n[fuqvd46]*)(\s|$)/.test(sub.split(/\s--(\s|$)/)[0]!)) ||
    /^(subtree\s+push|send-pack)(\s|$)/.test(sub) || /^config\s.*\balias\.\S+\s+["']?!?(git[\s\u0002]+)?push\b/.test(sub)) // the lexer joins a quoted word with \u0002
}

// A push that needs no word: every push in the line is `push [-u|-q|-v] <remote> <branch>...`, no branch is main,
// master, HEAD, a tag, forced (+) or deleted (:), and no alias is in play.
const PLAIN_FLAG = /^(-u|--set-upstream|-q|--quiet|-v|--verbose)$/
const plainRef = (r: string): boolean => /^[\w./@:-]+$/.test(r) && !/^[:+]|^refs\/tags\/|(^|:)(refs\/heads\/)?(main|master|HEAD)$/.test(r)
export function plainPush(cmd: string, tool: string): boolean {
  if (/alias\./i.test(cmd)) return false
  const subs = gitSubs(cmd, tool).map(({ sub }) => sub).filter((s) => /^(push|subtree\s+push|send-pack)(\s|$)/.test(s))
  return subs.length > 0 && subs.every((s) => {
    const words = s.split(/\s+/).slice(1)
    const args = words.filter((w) => !w.startsWith('-'))
    return /^push\s/.test(s) && words.every((w) => !w.startsWith('-') || PLAIN_FLAG.test(w)) && args.length >= 2 && args.slice(1).every(plainRef)
  })
}

// ok: his word for a push in this turn; lastAsk: this chat's last end-of-turn ask. Fresh on every module load (a reload
// forgets a word: one more question, never a push).
let state = { ok: false, lastAsk: '' }

// Called from the plugin's one prompt.submit hook (inbox.ts: the engine takes one per module without a matcher).
export function notePrompt(e: { text: string; turnId?: unknown; origin?: { kind?: string; name?: string } }): void {
  const typed = (e.origin?.kind === 'composer' || e.origin?.kind === 'bridge') && !PLUGIN_FRAME.test(ownWords(e.text))
  if (e.turnId) { // typed into a running turn: his word, or his "stop, don't push", counts at once
    if (typed && withdraws(e.text)) state.ok = false
    else if (typed && asksPush(e.text)) state.ok = true
    return
  }
  // His message from Telegram, submitted by this plugin, is his word too (owner, 2026-11-17): only its quoted lines are read.
  // A delivered inbox answer is judged at turn.start, on its record (noteTurnStart).
  const fromUs = e.origin?.kind === 'plugin' && e.origin.name === 'makarasty-tools'
  state.ok = typed ? asksPush(e.text) || (pushQ(state.lastAsk) && yes(ownWords(e.text)))
    : fromUs && isTelegramPrompt(e.text) && asksPush(telegramWords(e.text))
  state.lastAsk = '' // a box's yes counts only as the very next turn's prompt
  noted = true
}

// Called from the plugin's one turn.start hook (inbox.ts), which every turn reaches. A prompt this plugin submits skips
// the hook that submitted it, so notePrompt may not have seen this turn's prompt: then nothing of the last turn carries
// over. `inboxYes`: this turn's prompt is the inbox's delivery of his recorded yes to this chat's push question.
let noted = false
export function noteTurnStart(inboxYes: boolean): void {
  if (!noted) state = { ok: false, lastAsk: '' }
  if (inboxYes) state.ok = true
  noted = false
}

export const register: Register = (on) => {
  state = { ok: false, lastAsk: '' }
  noted = false

  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const r = await next(e)
    const ask = (e as unknown as { ask?: unknown }).ask
    if (!('deny' in (r as object))) state.lastAsk = typeof ask === 'string' ? ask : ''
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const r = await next(e)
    // Only the result the dialog (or the inbox, core.mjs toResult) returns: the input's answers are the model's own text.
    if ('deny' in (r as object)) return r
    const answers = (r as { result?: { answers?: Record<string, unknown> } })?.result?.answers ?? {}
    // The option he picked may say the push itself («Да, пушь») under a question worded without the verb («Отправить на
    // GitHub?»): refused twice that way on 2026-11-20.
    const hits = Object.entries(answers).filter(([q, a]) => typeof a === 'string' && ((pushQ(q) && yes(a)) || tells(a))).map(([q]) => q)
    if (!hits.length) return r
    // Answered from the inbox (its answer file): the result is the inbox's, so his act must be on record too.
    const toolUseId = (e as unknown as { tool_use_id?: string }).tool_use_id
    const from = toolUseId ? await inboxAnswer($, itemId(await $.session.id(), toolUseId)).catch(() => ({ byInbox: false })) : { byInbox: false }
    if (!from.byInbox || hits.some((q) => heardYes(q, (from as { heard?: Heard }).heard))) state.ok = true
    return r
  }).catch(($, e, next) => next(e))

  // The record of his answers (consent.ts Heard) is written by this plugin's hooks only: a chat that writes it itself forges his word.
  on('tool.call', { tool: /^(Write|Edit|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
    const p = e as unknown as { file_path?: unknown; notebook_path?: unknown }
    return HEARD.test(String(p.file_path ?? p.notebook_path ?? '')) ? { deny: HEARD_MESSAGE } : next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^(Bash|PowerShell|Monitor|mcp__terminal__run_in_terminal)$/ }, async ($, e, next) => {
    const command = String((e as unknown as { command?: unknown }).command ?? '')
    if (HEARD.test(command)) return { deny: HEARD_MESSAGE }
    const tool = e.tool === 'PowerShell' ? 'PowerShell' : 'Bash'
    if (state.ok || !pushes(command, tool) || plainPush(command, tool) || (await $.env.get('MAKARASTY_PUSH_GUARD')) === 'off') return next(e)
    return { deny: MESSAGE }
  }).catch(($, e, next) => next(e))
}
