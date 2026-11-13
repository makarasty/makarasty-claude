import type { Register } from 'claude-code'
import { gitSubs } from './git-guard.ts'
import { PLUGIN_FRAME, ownWords } from './own-words.ts'

// A push leaves this machine: it runs only on the person's own word in this turn (2026-11-12, asked "block git push
// without my word in the turn?": «Да, хук»; three pushes nobody asked for on 11-10; docs/COMPLAINTS.md C13). His word:
//  - a prompt he typed (composer or the phone bridge) with a sentence that tells a push («запушь», «пушим», "push
//    it"): not a question, not negated in that sentence («пушить не надо», "don't push"), not a word about the guard;
//  - a "yes" he typed right after this chat's end-of-turn ask that named a push;
//  - his yes to an AskUserQuestion of this turn whose question names a push, or the same answer the inbox plugin
//    delivers as a prompt when the dialog died.
// A brief, another session's message, a paste, an app reminder or a standing answer is not his word. Typed during a
// turn, "stop, don't push" withdraws it. `--dry-run`/`-n` is no push. MAKARASTY_PUSH_GUARD=off drops it.
// shortcut: a push inside a script (`npm run release`), an alias from ~/.gitconfig or a GUI client is not seen; this
// stops a chat's own unasked `git push`, not a determined bypass.

export const MESSAGE =
  'Blocked by makarasty-tools push-guard: a push needs the person\'s own word in this turn, and none came (a brief, a ' +
  'plugin message or a standing answer does not count). Ask with AskUserQuestion: the branch, the remote and the ' +
  'commits it sends, options "Да, пушь" / "Нет". His yes (or a typed «запушь») lets the push run. MAKARASTY_PUSH_GUARD=off turns this off.'

// The verb, not the noun or a name: пушь/пушим/запушь/запушить/пуш, push (not push-guard, pushed, Пушкин, push notifications).
// An order to the chat, not «пушу сам» (he pushes himself) or «залей файл».
const PUSH = /(?<![a-zа-яё])(за)?пуш(ь|и|им|ить|ни|нуть|ай|ьте|ите)?(?![a-zа-яё-])|(?<![a-z-])push(?![a-z-])(?!\s+notification)/i
// A negation, a put-off or a condition in the same clause («пушить будем завтра», «да, но сначала diff», "push it after review"): not now.
// («закоммить, потом запушь» is an order of steps in this turn, not a put-off.)
const NEG = /(?<![a-zа-яё])(не|нет|без|нельзя|никогда|рано|пока не|завтра|позже|но|сначала|только|no|not|never|without|don['’]?t|do not|no need|later|tomorrow|but|first|only)(?![a-zа-яё])/i
const YES = /^\s*(да|ага|ок|ok|okay|yes|yep|давай|конечно|го|пушь|пуш|запушь|push|sure)(?![a-zа-яё])/i

// Clauses: «закоммить и запушь, без лишних вопросов» keeps its push; «закоммить, пушить не надо» does not.
const sentences = (t: string): string[] => t.split(/(?<=[.!?\n;,])\s*/)
// A sentence that tells a push: has the verb, is not a question, holds no negation.
const tells = (s: string): boolean => PUSH.test(s) && !/\?\s*$/.test(s.trim()) && !NEG.test(s)
export const asksPush = (text: string): boolean => sentences(ownWords(text)).some(tells)
const withdraws = (text: string): boolean => sentences(ownWords(text)).some((s) => PUSH.test(s) && NEG.test(s) && !/\?\s*$/.test(s.trim()))
const yes = (answer: string): boolean => YES.test(answer) && !NEG.test(answer)
// A question that offers a push («Пушим 3 коммита?»), not one that offers to hold it («Закоммитить локально, не пушить?»).
// Judged per clause, so «Пушим 3 коммита? Другой чат не активен.» still offers it; «Пушу 3 коммита?» is the chat speaking.
const pushQ = (q: string): boolean => sentences(q).some((s) => (PUSH.test(s) || /(?<![a-zа-яё])(за)?пушу(?![a-zа-яё])/i.test(s)) && !NEG.test(s))

// The pairs of an inbox-delivered answer (core.mjs deliveryText), read only after its fixed lead.
export function deliveredYes(text: string): boolean {
  const lead = /^The person answered your (question from the inbox \(makarasty-tools inbox\), in place of the dialog here: |end-of-turn question )/.exec(text)
  if (!lead) return false
  const body = text.slice(lead[0].length)
  if (lead[1]!.startsWith('end-of-turn')) { const m = /^"([^"]*)" from the inbox \(makarasty-tools inbox\): "([^"]*)"/.exec(body); return !!m && pushQ(m[1]!) && yes(m[2]!) }
  return [...body.matchAll(/"([^"]*)": "([^"]*)"/g)].some((m) => pushQ(m[1]!) && yes(m[2]!))
}

export function pushes(cmd: string, tool: string): boolean {
  if (!/\bgit\b|\$/i.test(cmd)) return false
  if (/\bgit\b[^;&|\n]*\s-c\s*["']?alias\.\S+=["']?!?(git\s+)?push\b/i.test(cmd)) return true // `git -c alias.p=push p`
  // A dry run: --dry-run, or -n in a cluster of push's own short flags (not `-onoop`, a push option).
  return gitSubs(cmd, tool).some(({ sub }) => (/^push(\s|$)/.test(sub) && !/\s(--dry-run|-[fuqvd46]*n[fuqvd46]*)(\s|$)/.test(sub.split(/\s--(\s|$)/)[0]!)) ||
    /^(subtree\s+push|send-pack)(\s|$)/.test(sub) || /^config\s.*\balias\.\S+\s+["']?!?(git[\s\u0002]+)?push\b/.test(sub)) // the lexer joins a quoted word with \u0002
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
  state.ok = typed ? asksPush(e.text) || (pushQ(state.lastAsk) && yes(ownWords(e.text)))
    : e.origin?.kind === 'plugin' && e.origin.name === 'makarasty-tools' && deliveredYes(e.text)
  state.lastAsk = '' // a box's yes counts only as the very next turn's prompt
}

export const register: Register = (on) => {
  state = { ok: false, lastAsk: '' }

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
    for (const [q, a] of Object.entries(answers)) if (pushQ(q) && typeof a === 'string' && yes(a)) state.ok = true
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^(Bash|PowerShell|Monitor|mcp__terminal__run_in_terminal)$/ }, async ($, e, next) => {
    const command = String((e as unknown as { command?: unknown }).command ?? '')
    if (state.ok || !pushes(command, e.tool === 'PowerShell' ? 'PowerShell' : 'Bash') || (await $.env.get('MAKARASTY_PUSH_GUARD')) === 'off') return next(e)
    return { deny: MESSAGE }
  }).catch(($, e, next) => next(e))
}
