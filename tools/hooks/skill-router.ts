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

type D = Pick<EngineInterface, 'env' | 'fs' | 'model' | 'plugin' | 'clock' | 'session'>
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
  'question about the topic, a quoted or pasted text, ordinary coding work or a reply to an earlier question is none.\n\nSkills:\n' +
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
export function worth(text: string, origin: string | undefined): boolean {
  // A slash command already chose its skill; ownWords would hand on its arguments as if typed.
  if (PLUGIN_FRAME.test(text) || /^\s*<command-(name|message)/i.test(text)) return false
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
type Turn = { hint?: Promise<Skill | undefined>; got?: Skill | null; done: boolean; calls: number; waited: boolean; settled: boolean; after: number }
const ENDED: Turn = { done: true, calls: 0, waited: false, settled: false, after: 0 }
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
  const t: Turn = { ...ENDED, done: false }
  t.hint = held.list.then(async (list) => {
    if (!list.length) { if (skills === held) skills = undefined; return undefined }
    const r = await $.model.complete({ model: 'haiku', system: [{ text: system(list), cache: true }], prompt: `Message:\n<<<MSG\n${ownWords(e.text)}\nMSG>>>`, maxTokens: 40, effort: 'low', timeoutMs: 8000 })
    return r.isAnswered ? pick(r.text, list) : undefined
  }).catch(() => undefined)
  void t.hint.then((s) => { t.got = s ?? null })
  turn = t
}

// The end of a turn. One plugin gets one unmatched Stop hook, and gates.ts owns it, so it calls this on every Stop,
// first, so the turn's state ends even when another check sends the turn back. Only a turn that made no call at all
// gets the hint: a turn that worked without the skill is not made to say more.
export async function skillStop($: Pick<D, 'clock'>, e: { stop_hook_active?: boolean }): Promise<string | undefined> {
  const t = turn
  turn = { ...ENDED }
  if (e.stop_hook_active || t.done || t.calls || !t.hint) return undefined
  const s = await Promise.race([t.hint, late($, 3000)])
  return s && s !== 'late' ? hintFor(s, true) : undefined
}

export const register: Register = (on) => {
  // A matcher of every name: the module's one unmatched tool.call hook is loop-guard's.
  on('tool.call', { tool: /./ }, async ($, e, next) => {
    const t = turn
    if (t.done || !t.hint || e.agentId) return next(e)
    // The model picked a skill itself: it has the conversation, so its pick stands.
    if (e.tool === 'Skill') { t.done = true; return next(e) }
    t.calls++
    if (!LOOK.test(e.tool)) return next(e)
    // Wait once, on the first look-around call; later calls read the answer only if it has come.
    let s: Skill | undefined | null | 'late' = t.got
    if (s === undefined && !t.waited) { t.waited = true; s = await Promise.race([t.hint, late($, 1500)]); t.settled = true }
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
