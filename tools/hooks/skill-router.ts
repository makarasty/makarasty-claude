import type { EngineInterface, Register } from 'claude-code'
import { PLUGIN_FRAME, ownWords } from './own-words.ts'
import { configDir } from './consent.ts'

// The skill router: a plugin skill the model forgets to call is a skill nobody gets. With 74 skills listed, Sonnet
// called the right makarasty skill on 64% of plain requests and the misses were almost all "called none" [M80].
// So each prompt the person sends is also read by the small model against this plugin's skill descriptions, in
// parallel with the main model, so no prompt waits for it. When it names a skill and the main model has not called
// one, the main model's first look-around call (a read, a search, a shell command), or the end of a turn that made no
// call at all, is sent back once with the hint as a fact; the main model, which sees the whole conversation, decides.
// MAKARASTY_SKILL_ROUTER=off drops it.

type D = Pick<EngineInterface, 'env' | 'fs' | 'model' | 'plugin' | 'clock' | 'session' | 'store'>
export type Skill = { name: string; description: string }

// One skill file's frontmatter: its description, unless the skill is only for the person to start.
export function frontmatter(text: string): { description?: string; manual: boolean } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text).replace(/^﻿/, ''))
  if (!m) return { manual: false }
  const d = /^description:[ \t]*(.*)$/m.exec(m[1]!)?.[1]?.trim()
  // A block scalar (`>-`, `|`) is not read: no skill here writes one, and its first line alone would mislead.
  const description = !d || /^[>|]/.test(d) ? undefined : /^["'].*["']$/.test(d) ? d.slice(1, -1).replace(/\\"/g, '"') : d
  return { description, manual: /^disable-model-invocation:\s*true\s*$/m.test(m[1]!) }
}

// The newest of the version folders the plugin cache keeps side by side (a folder's mtime reads 0 here).
export function newest(names: readonly string[]): string | undefined {
  const key = (v: string) => v.split(/[.-]/).map((p) => p.padStart(8, '0')).join('.')
  return [...names].filter((v) => /^\d+\.\d+/.test(v)).sort((a, b) => (key(a) < key(b) ? 1 : -1))[0]
}

// This plugin's skills, and the fleet plugin's commands beside it: the repo layout (tools/ under the repo) or the
// plugin cache (<market>/makarasty-tools/<ver> beside <market>/makarasty/<ver>).
export async function catalog($: D): Promise<Skill[]> {
  const root = $.plugin.root.replace(/\\/g, '/')
  const out: Skill[] = []
  const add = async (name: string, file: string) => {
    const f = frontmatter(String(await $.fs.read(file).catch(() => '')))
    if (f.description && !f.manual) out.push({ name, description: f.description })
  }
  for (const d of await $.fs.list(`${root}/skills`).catch(() => [])) if (d.kind === 'dir') await add(`makarasty-tools:${d.name}`, `${root}/skills/${d.name}/SKILL.md`)
  let commands = `${root}/../commands`
  if (!(await $.fs.exists(commands).catch(() => false))) {
    const ver = newest((await $.fs.list(`${root}/../../makarasty`).catch(() => [])).filter((v) => v.kind === 'dir').map((v) => v.name))
    commands = ver ? `${root}/../../makarasty/${ver}/commands` : ''
  }
  if (commands) for (const f of await $.fs.list(commands).catch(() => [])) if (f.kind === 'file' && f.name.endsWith('.md')) await add(`makarasty:${f.name.slice(0, -3)}`, `${commands}/${f.name}`)
  return out
}

export const system = (skills: readonly Skill[]) =>
  'You route one user message of a Claude Code chat to at most one skill. Answer with one skill name from the list, ' +
  'exactly as written, or the word none. Name a skill only when the message asks for that skill\'s job to be done now; a ' +
  'question about the topic, a quoted or pasted text, ordinary coding work or a reply to an earlier question is none. ' +
  'The chat\'s last words may come first, marked Chat asked: when the message is a short answer to what the chat asked ' +
  '(yes, ok, "push it", "created it, push") it is a reply, so none, however much it sounds like a skill\'s job.\n\nSkills:\n' +
  skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')

// The skill the reply names: the first full name in it, or a reply that is a short name alone; "none" anywhere is none.
export function pick(reply: string | undefined, skills: readonly Skill[]): Skill | undefined {
  const t = String(reply ?? '').trim().toLowerCase().replace(/[`*"'.]/g, '')
  if (!t || /\bnone\b/.test(t)) return undefined
  const at = skills.map((s) => ({ s, i: t.indexOf(s.name.toLowerCase()) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i)[0]
  return at?.s ?? skills.find((s) => s.name.split(':')[1] === t)
}

// A prompt worth routing: the person's own words, short enough to be a request, not a slash command, a wrapper or
// another session's message. A headless prompt is mostly a machine brief: only a short one is routed.
const SKILL_BODY = /^\s*Base directory for this skill:/
export function worth(text: string, origin: string | undefined): boolean {
  // A slash command already chose its skill; ownWords would hand on its arguments as if typed. A skill's own body (the
  // app submits it as a prompt) and another session's message behind a system-reminder block are not typed either.
  if (PLUGIN_FRAME.test(text) || PLUGIN_FRAME.test(ownWords(text)) || SKILL_BODY.test(text) || /^\s*<command-(name|message)/i.test(text)) return false
  const t = ownWords(text).trim()
  const max = origin === 'sdk' ? 1000 : 4000
  return (origin === undefined || ['composer', 'bridge', 'sdk'].includes(origin)) && t.length >= 3 && t.length <= max && !/^[/<]/.test(t)
}

export const HINT = (s: Skill, end: boolean) =>
  `Automatic hint from the makarasty-tools skill router (a small model, may be wrong): the person's last message may ask for ` +
  `the skill ${s.name}: ${s.description}\nIf they ask for that to be done now, invoke it with the Skill tool first. If not (a ` +
  `question about the topic, other work), ignore this hint${end ? ' and end the turn as it is' : ' and make this call again'}.`

// The fleet plugin is turned on per project, so in most projects its skills are not loaded. A request for one there gets
// how to turn it on, not a skill the chat cannot call.
export const OFF_HINT = (s: Skill, end: boolean) =>
  `Automatic hint from the makarasty-tools skill router (a small model, may be wrong): the person's last message may ask for ` +
  `the fleet skill ${s.name} (${s.description}), but the fleet plugin is not on in this project, so it cannot run here. If ` +
  `they ask for it, tell them in one line: to turn it on here, add "makarasty@makarasty": true under "enabledPlugins" in ` +
  `.claude/settings.local.json at the project root, then restart the chat or type /reload-plugins; offer to add the line. ` +
  `If not, ignore this hint${end ? ' and end the turn as it is' : ' and make this call again'}.`

// Whether this chat's skill listing carries the fleet's skills: undefined until the first listing is seen.
let fleetListed: boolean | undefined
export const hintFor = (s: Skill, end: boolean, fleet = fleetListed) => (/^makarasty:/.test(s.name) && fleet === false ? OFF_HINT : HINT)(s, end)
export function sawListing(text: string, first: boolean): boolean | undefined {
  const found = /^- makarasty:fleet-/m.test(String(text))
  return first || found ? found : undefined
}

// The calls a hint may send back: they only look around (or run a shell command the skill may want to run its own
// way), so a call sent back loses nothing. A Write, an Edit or a brief is never sent back.
const LOOK = /^(Read|Grep|Glob|ToolSearch|Bash|PowerShell|ListAgents)$/
const FIRST_CALLS = 3
// A hint older than this is for a message the chat has long since moved past.
const HINT_TTL_MS = 60000
const ASKED_CHARS = 600

// The held call already is the action a skill would end with: one git push, commit or pull (a `cd dir &&` before it and
// `-C dir` allowed), judged by the command's first line so a commit message in a heredoc does not hide it.
export function plainAction(tool: string, command: unknown): boolean {
  if (!/^(Bash|PowerShell)$/.test(tool)) return false
  const first = String(command ?? '').split('\n')[0]!.replace(/^\s*cd\s+\S+\s*&&\s*/, '')
  return /^\s*git(?:\s+-C\s+\S+)?\s+(?:push|commit|pull)\b/.test(first) && !/&&|\|\||;|\|/.test(first.replace(/(["'])(?:(?!\1).)*\1/g, ''))
}

// The chat's last words before this message: the question the message may be answering.
async function lastAsked($: Pick<D, 'session'>): Promise<string> {
  const msgs = await $.session.messages().catch(() => [])
  const text = String([...msgs].reverse().find((m) => m.role === 'assistant' && String(m.text ?? '').trim())?.text ?? '').trim()
  return text.length > ASKED_CHARS ? text.slice(-ASKED_CHARS) : text
}

// The hold command is collecting (its list file starts with `collecting`): the person dictates one item per message and
// wants no answer but a short note, so nothing is routed. A list untouched for a day no longer counts. `dir` is the
// makarasty state folder (<config>/makarasty).
export async function holding($: Pick<D, 'fs' | 'clock'>, dir: string, sid: string): Promise<boolean> {
  // The list is hold/<session>/index.md (skills/hold/hold.mjs) or the older single file hold/<session>.md.
  for (const f of [`${dir}/hold/${sid}/index.md`, `${dir}/hold/${sid}.md`]) {
    try {
      // PowerShell 5.1 writes a BOM
      if ((await $.fs.read(f)).replace(/^﻿/, '').startsWith('collecting') && (await $.clock.now()) - (await $.fs.stat(f)).mtimeMs < 86400000) return true
    } catch { /* no such list */ }
  }
  return false
}

let skills: { at: number; list: Promise<Skill[]> } | undefined
// calls: main-loop calls this turn; settled: the one wait is over, so calls after it count toward FIRST_CALLS (calls
// sent in parallel with the first one never do).
// lateWait: a wait for the answer ran out, so an answer that comes after it is counted as late.
type Turn = { at: number; hint?: Promise<Skill | undefined>; got?: Skill | null; done: boolean; calls: number; waited: boolean; settled: boolean; after: number; lateWait?: boolean }
const ENDED: Turn = { at: 0, done: true, calls: 0, waited: false, settled: false, after: 0 }

// What the small model did, kept per day (the last 7 days) under one store key, shown by /router. named: a skill was
// hinted; none: the model said no skill; failed: an error, a 429, a timeout or an empty reply; late: answered, but after
// the one wait had run out (so no hint was sent). ms and answered give the average time of the calls that were answered.
export type Counts = { named: number; none: number; failed: number; late: number; answered: number; ms: number }
export type SkillStats = Record<string, Counts>
const STATS_KEY = 'skillStats'
const STATS_DAYS = 7
let writes = Promise.resolve()

export function tally($: Pick<D, 'store' | 'clock'>, outcome: 'named' | 'none' | 'failed' | 'late', ms?: number): Promise<void> {
  // Concurrent prompts would each read the old record and overwrite each other: one writer at a time.
  writes = writes.then(async () => {
    const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
    const all = ((await $.store.get(STATS_KEY)) as SkillStats | undefined) ?? {}
    const c = (all[day] ??= { named: 0, none: 0, failed: 0, late: 0, answered: 0, ms: 0 })
    c[outcome]++
    if (ms !== undefined) { c.answered++; c.ms += ms }
    for (const d of Object.keys(all).sort().slice(0, -STATS_DAYS)) delete all[d]
    await $.store.set(STATS_KEY, all)
  }).catch(() => {})
  return writes
}

// The /router lines for the skill router: today and the days kept.
export async function skillStatsText($: Pick<D, 'store' | 'clock'>): Promise<string> {
  const all = ((await $.store.get(STATS_KEY).catch(() => undefined)) as SkillStats | undefined) ?? {}
  const days = Object.keys(all).sort().reverse()
  if (!days.length) return 'Skill router: no call to the small model yet.'
  return 'Skill router (small model calls per day):\n' + days.map((d) => {
    const c = all[d]!
    return `${d}: named ${c.named}, none ${c.none}, failed ${c.failed}, late ${c.late}; answered ${c.answered}, avg ${c.answered ? Math.round(c.ms / c.answered) : 0} ms`
  }).join('\n')
}
let turn: Turn = { ...ENDED }

function late($: Pick<D, 'clock'>, ms: number): Promise<'late'> {
  return $.clock.sleep(ms).then(() => 'late' as const, () => 'late' as const)
}

// Called from the module's one prompt.submit hook (inbox.ts): starts the small model and returns at once. A prompt
// delivered into a running turn leaves that turn's hint alone.
export async function noteSkillPrompt($: D, e: { text: string; origin?: { kind: string }; turnId?: string }): Promise<void> {
  if (e.turnId) return
  turn = { ...ENDED }
  if ((await $.env.get('MAKARASTY_SKILL_ROUTER')) === 'off' || !worth(e.text, e.origin?.kind)) return
  const cfg = await configDir($)
  if (cfg && (await holding($, `${cfg}/makarasty`, await $.session.id()).catch(() => false))) return
  const now = await $.clock.now()
  // Read again after ten minutes, so an updated or added skill is seen; an empty read is never kept.
  if (!skills || now - skills.at > 600000) skills = { at: now, list: catalog($) }
  const held = skills
  const t: Turn = { ...ENDED, at: now, done: false }
  t.hint = held.list.then(async (list) => {
    if (!list.length) { if (skills === held) skills = undefined; return undefined }
    const asked = await lastAsked($)
    const began = await $.clock.now()
    const r = await $.model.complete({ model: 'haiku', system: [{ text: system(list), cache: true }], prompt: `${asked ? `Chat asked:\n<<<ASKED\n${asked}\nASKED>>>\n` : ''}Message:\n<<<MSG\n${ownWords(e.text)}\nMSG>>>`, maxTokens: 40, effort: 'low', timeoutMs: 8000 })
    // The count is written in the background: the hint must not wait for the store.
    if (!r.isAnswered) { void tally($, 'failed'); return undefined }
    const s = pick(r.text, list)
    void tally($, t.lateWait ? 'late' : s ? 'named' : 'none', (await $.clock.now()) - began)
    return s
  }).catch(() => { void tally($, 'failed'); return undefined })
  void t.hint.then((s) => { t.got = s ?? null })
  turn = t
}

// The end of a turn. One plugin gets one unmatched Stop hook, and gates.ts owns it, so it calls this on every Stop,
// first, so the turn's state ends even when another check sends the turn back. Only a turn that made no call at all
// gets the hint: a turn that worked without the skill is not made to say more.
export async function skillStop($: Pick<D, 'clock'>, e: { stop_hook_active?: boolean }): Promise<string | undefined> {
  const t = turn
  turn = { ...ENDED }
  if (e.stop_hook_active || t.done || t.calls || !t.hint || (await $.clock.now()) - t.at > HINT_TTL_MS) return undefined
  const s = await Promise.race([t.hint, late($, 3000)])
  if (s === 'late') t.lateWait = true
  return s && s !== 'late' ? hintFor(s, true) : undefined
}

export const register: Register = (on) => {
  // A matcher of every name: the module's one unmatched tool.call hook is loop-guard's.
  on('tool.call', { tool: /./ }, async ($, e, next) => {
    const t = turn
    if (t.done || !t.hint || e.agentId) return next(e)
    // The model picked a skill itself: it has the conversation, so its pick stands.
    if (e.tool === 'Skill') { t.done = true; return next(e) }
    // A hint for a message the chat has moved past (a long think, a slow model) is dropped, and so is one once a call that
    // does the work has run: the chat is already acting on the message.
    if ((await $.clock.now()) - t.at > HINT_TTL_MS) { t.done = true; return next(e) }
    t.calls++
    if (!LOOK.test(e.tool)) { if (!/plan|todo/i.test(e.tool)) t.done = true; return next(e) }
    if (plainAction(e.tool, (e as unknown as { command?: unknown }).command)) { t.done = true; return next(e) }
    // Wait once, on the first look-around call; later calls read the answer only if it has come.
    let s: Skill | undefined | null | 'late' = t.got
    if (s === undefined && !t.waited) { t.waited = true; s = await Promise.race([t.hint, late($, 1500)]); t.settled = true; if (s === 'late') t.lateWait = true }
    if (t.done) return next(e) // a Skill call in the same batch ran while this one waited
    if (s === undefined || s === 'late') { if (t.settled && ++t.after >= FIRST_CALLS) t.done = true; return next(e) }
    t.done = true
    return s ? { deny: hintFor(s, false) } : next(e)
  }).catch(($, e, next) => next(e))

  // Read, never changed: a later listing may carry only new skills, so only the first one may say "no fleet".
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) fleetListed = sawListing(String(r.text ?? e.text ?? ''), fleetListed === undefined) ?? fleetListed
    return r
  }).catch(($, e, next) => next(e))
}
