import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { PROFILE_MAX, afterCompact, asking, asksForHandoff, economy, findings, habits, levelFor, register, reminder } from './gates.ts'

const entry = { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false }
const DAY = 86400000
// The engine resolves a path before the bottom sees it (on Windows `/cfg` becomes `C:\cfg`): compare the plain form.
const plain = (p: string): string => p.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')

// The world beneath the gates: the notify folder, the engine's context size, the level file, a fleet record, and every
// node start recorded.
type World = {
  markers?: string[] | 'missing'
  tokens?: number
  level?: string
  fleet?: string
  fleetAge?: number
  runAge?: number // how long ago the run's own folder (or its tasks/claimed) was touched; default: long ago
  hold?: string
  holdIndex?: string
  holdAge?: number
  env?: Record<string, string>
  run?: 'hang' | 'fail'
  exists?: string
  profile?: string
}
function world(on: On, o: World = {}) {
  const writes: Record<string, string> = {}
  const lists: string[] = []
  const runs: { argv: readonly string[]; stdin?: string; timeoutMs?: number }[] = []
  let says = ''
  // The engine's own end of each classic chain: no settings hook, nothing to say.
  for (const ev of ['Stop', 'StopFailure', 'Notification', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'SubagentStart'] as const) on(`classic.${ev}`, async () => ({}))
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', ...o.env })
  mock.clock(on, { now: 10 * DAY })
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000000, ...(o.tokens === undefined ? {} : { tokens: o.tokens }) }, rateLimits: [] } }))
  on('fs.read', async (_$, e) => {
    if (plain(e.path) === '/cfg/makarasty/context/s1' && o.level !== undefined) return { value: o.level }
    if (plain(e.path) === '/cfg/makarasty/fleet-sessions/s1' && o.fleet !== undefined) return { value: `${o.fleet}\nmore` }
    if (plain(e.path) === '/cfg/makarasty/hold/s1.md' && o.hold !== undefined) return { value: o.hold }
    if (plain(e.path) === '/cfg/makarasty/hold/s1/index.md' && o.holdIndex !== undefined) return { value: o.holdIndex }
    if (plain(e.path) === '/cfg/makarasty/profile.md' && o.profile !== undefined) return { value: o.profile }
    return { deny: 'ENOENT' }
  })
  on('fs.stat', async (_$, e) => {
    if (plain(e.path) === '/cfg/makarasty/hold/s1.md' && o.hold !== undefined) return { value: { ...entry, mtimeMs: 10 * DAY - (o.holdAge ?? 1000) } }
    if (plain(e.path) === '/cfg/makarasty/hold/s1/index.md' && o.holdIndex !== undefined) return { value: { ...entry, mtimeMs: 10 * DAY - (o.holdAge ?? 1000) } }
    if (plain(e.path) === '/cfg/makarasty/fleet-sessions/s1') return { value: { ...entry, mtimeMs: 10 * DAY - (o.fleetAge ?? 1000) } }
    if (plain(e.path) === o.fleet) return { value: { ...entry, kind: 'dir' as const, mtimeMs: o.runAge === undefined ? 0 : 10 * DAY - o.runAge } }
    if (o.runAge !== undefined && plain(e.path) === `${o.fleet}/tasks/claimed`) return { value: { ...entry, kind: 'dir' as const, mtimeMs: 10 * DAY - o.runAge } }
    return { deny: 'ENOENT' }
  })
  // lists: every marker path asked about; a marker is notify/<name>.json for each name in o.markers.
  on('fs.exists', async (_$, e) => {
    const p = plain(e.path)
    if (p.includes('/makarasty/notify/')) { lists.push(p); return { value: Array.isArray(o.markers) && o.markers.some(n => p.endsWith(`/notify/${n}`)) } }
    return { value: p === o.exists }
  })
  on('fs.write', async (_$, e) => { writes[plain(e.path)] = e.text; return { value: undefined } })
  on('process.run', async (_$, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, timeoutMs: e.init?.timeoutMs })
    if (o.run === 'hang') return new Promise(() => {}) // never answers
    if (o.run === 'fail') return { deny: 'spawn node ENOENT' }
    return { value: { exitCode: 0, stdout: says, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { writes, lists, runs, say: (s: string) => { says = s }, events: () => runs.map(r => JSON.parse(r.stdin ?? '{}').hook_event_name) }
}
const prompt = (text = 'go on') => ({ prompt: text, session_id: 's1', transcript_path: '/t.jsonl' })

// ---- pure parts ----

test('levels: the threshold, then every step, once each; a drop re-arms', () => {
  expect(levelFor(699999, 700000, 150000, 0)).toBe(0)
  expect(levelFor(700000, 700000, 150000, 0)).toBe(700000)
  expect(levelFor(840000, 700000, 150000, 700000)).toBe(0)
  expect(levelFor(850000, 700000, 150000, 700000)).toBe(850000)
  expect(levelFor(1000000, 700000, 150000, 700000)).toBe(1000000)
  // after a /compact left 100k and the chat grew back to 720k, the old level 1000000 no longer holds it back
  expect(levelFor(720000, 700000, 150000, 1000000)).toBe(700000)
})

test('a prompt that asks for the handoff is recognised; one that only mentions it is not', () => {
  for (const p of ['/handoff', '/makarasty-tools:handoff now', 'do a handoff', 'сделай хенд-офф', 'handoff', 'handoff!',
    'хэндофф', 'Сделай хэндофф', 'хендоф', 'хэндоф', 'hand off', 'do a hand off', 'сделай хэнд-офф'])
    expect(asksForHandoff(p)).toBe(true)
  for (const p of ['fix the handoff reminder text in context.mjs', 'why does the handoff hook fire twice'])
    expect(asksForHandoff(p)).toBe(false)
})

test('the texts are the ones context.mjs printed', () => {
  expect(reminder(724400)).toMatch(/^This chat's context is at 724k tokens\. Answer the person's message as usual;/)
  expect(reminder(724400)).toMatch(/Do not offer or run a handoff unasked\.$/)
  expect(afterCompact('/x/t.jsonl')).toContain('still on disk, one JSON object per line: /x/t.jsonl.')
})

// ---- notify ----

test('nothing armed: no node is started on any notify event', async ($, on) => {
  const w = world(on, { markers: ['readme.txt'] })
  const s = { session_id: 's1' }
  await $.classic.UserPromptSubmit({ prompt: 'hi', ...s })
  await $.classic.Stop({ stop_hook_active: false, ...s })
  await $.classic.StopFailure({ error: 'rate_limit', ...s })
  await $.classic.Notification({ notification_type: 'permission_prompt', message: 'm', ...s })
  await $.classic.SessionStart({ source: 'resume', ...s })
  await $.classic.SessionEnd({ reason: 'clear', ...s })
  expect(w.runs).toEqual([])
  expect(w.lists[0]).toBe('/cfg/makarasty/notify/s1.json')
})

test("another chat's marker does not start node here: only this session's own marker arms it", async ($, on) => {
  const w = world(on, { markers: ['other.json'] })
  const s = { session_id: 's1' }
  await $.classic.UserPromptSubmit({ prompt: 'hi', ...s })
  await $.classic.Stop({ stop_hook_active: false, ...s })
  await $.classic.SessionStart({ source: 'resume', ...s })
  await $.classic.SessionEnd({ reason: 'clear', ...s })
  expect(w.runs).toEqual([])
})

test('a path-like session id never reaches the folder', async ($, on) => {
  const w = world(on, { markers: ['s1.json'] })
  await $.classic.Stop({ stop_hook_active: false, session_id: '../x' })
  expect(w.runs).toEqual([])
  expect(w.lists).toEqual([])
})

test('no notify folder at all is not armed and not an error', async ($, on) => {
  const w = world(on, { markers: 'missing' })
  await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: 's1' })
  expect(w.runs).toEqual([])
})

test('armed: the payload reaches notify.mjs as the command hook got it, on stdin', async ($, on) => {
  const w = world(on, { markers: ['s1.json'] })
  await $.classic.UserPromptSubmit({ prompt: 'go', session_id: 's1' })
  expect(w.runs).toHaveLength(1)
  expect(w.runs[0]!.argv[0]).toBe('node')
  expect(w.runs[0]!.argv[1]).toMatch(/[\\/]hooks[\\/]notify\.mjs$/)
  expect(JSON.parse(w.runs[0]!.stdin!)).toMatchObject({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go' })
  expect(w.runs[0]!.timeoutMs).toBe(5000)
})

test('Stop, StopFailure and the needs-you Notifications start it; other notifications do not', async ($, on) => {
  const w = world(on, { markers: ['s1.json'] })
  await $.classic.Stop({ stop_hook_active: false, session_id: 's1' })
  await $.classic.StopFailure({ error: 'rate_limit', session_id: 's1' })
  await $.classic.Notification({ notification_type: 'permission_prompt', message: 'm', session_id: 's1' })
  await $.classic.Notification({ notification_type: 'idle_prompt', message: 'm', session_id: 's1' })
  await $.classic.Notification({ notification_type: 'agent_needs_input', message: 'm', session_id: 's1' })
  await $.classic.Notification({ notification_type: 'elicitation_dialog', message: 'm', session_id: 's1' })
  await $.classic.Notification({ notification_type: 'elicitation_url_dialog', message: 'm', session_id: 's1' })
  expect(w.events()).toEqual(['Stop', 'StopFailure', 'Notification', 'Notification', 'Notification', 'Notification'])
  expect(w.runs.every(r => r.timeoutMs === 20000)).toBe(true)
})

test('a Stop does not wait for notify.mjs', async ($, on) => {
  const w = world(on, { markers: ['s1.json'], run: 'hang' })
  await $.classic.Stop({ stop_hook_active: false, session_id: 's1' })
  expect(w.runs).toHaveLength(1)
})

test('a notify.mjs that cannot run does not fail the turn', async ($, on) => {
  const w = world(on, { markers: ['s1.json'], run: 'fail' })
  await $.classic.StopFailure({ error: 'rate_limit', session_id: 's1' })
  await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: 's1' })
  expect(w.runs).toHaveLength(2)
})

test("SessionStart resume hands notify.mjs's note to the chat; other sources and unarmed say nothing", async ($, on) => {
  const w = world(on, { markers: ['s1.json'] })
  w.say('A phone notification is armed for this chat.\n')
  const r = await $.classic.SessionStart({ source: 'resume', session_id: 's1' })
  expect(r.additionalContext).toEqual(['A phone notification is armed for this chat.', economy, habits, asking, findings])
  const n = w.runs.length
  expect((await $.classic.SessionStart({ source: 'startup', session_id: 's1' })).additionalContext).toEqual([economy, habits, asking, findings])
  expect(w.runs.length).toBe(n)
  w.say('')
  expect((await $.classic.SessionStart({ source: 'resume', session_id: 's1' })).additionalContext).toEqual([economy, habits, asking, findings])
})

test('SessionEnd runs it for /clear only', async ($, on) => {
  const w = world(on, { markers: ['s1.json'] })
  await $.classic.SessionEnd({ reason: 'prompt_input_exit', session_id: 's1' })
  expect(w.runs).toEqual([])
  await $.classic.SessionEnd({ reason: 'clear', session_id: 's1' })
  expect(w.runs).toHaveLength(1)
  expect(w.runs[0]!.timeoutMs).toBe(5000)
})

test('SessionEnd writes the ended marker except for /clear, which still reaches notify', async ($, on) => {
  const w = world(on, { markers: ['s1.json', 's2.json'] })
  await $.classic.SessionEnd({ reason: 'prompt_input_exit', session_id: 's1' })
  expect(w.writes['/cfg/makarasty/ended/s1']).toBe(new Date(10 * DAY).toISOString())
  expect(w.runs).toEqual([])
  await $.classic.SessionEnd({ reason: 'clear', session_id: 's2' })
  expect(w.writes['/cfg/makarasty/ended/s2']).toBeUndefined() // /clear: the process lives on under the old id
  expect(w.runs).toHaveLength(1)
})

test('without CLAUDE_CONFIG_DIR it looks in ~/.claude, USERPROFILE first, then HOME', async ($, on) => {
  const w = world(on, { markers: 'missing', env: { CLAUDE_CONFIG_DIR: '', USERPROFILE: 'C:/Users/me', HOME: '/c/Users/me' } })
  await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: 's1' })
  expect(w.lists).toEqual(['/Users/me/.claude/makarasty/notify/s1.json', '/c/Users/me/.claude/makarasty/notify/s1.json'])
})

test('with CLAUDE_CONFIG_DIR set, only that folder is looked at, not the home one', async ($, on) => {
  const w = world(on, { markers: 'missing', env: { CLAUDE_CONFIG_DIR: '/other', USERPROFILE: 'C:/Users/me', HOME: '/c/Users/me' } })
  await $.classic.UserPromptSubmit({ prompt: 'hi', session_id: 's1' })
  expect(w.lists).toEqual(['/other/makarasty/notify/s1.json'])
  expect(w.runs).toEqual([])
})

test('with no config dir, USERPROFILE and HOME, nothing is written under the drive root', async ($, on) => {
  const w = world(on, { markers: 'missing', tokens: 800000, env: { CLAUDE_CONFIG_DIR: '', USERPROFILE: '', HOME: '' } })
  await $.classic.SessionEnd({ reason: 'prompt_input_exit', session_id: 's1' })
  await $.classic.SessionStart({ source: 'startup', session_id: 's1' })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toBeUndefined()
  expect(w.writes).toEqual({})
})

// ---- handoff reminder ----

test('under the threshold with no level on disk: nothing is written, no node, no reminder', async ($, on) => {
  const w = world(on, { tokens: 300000 })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toBeUndefined()
  expect(w.writes).toEqual({})
  expect(w.runs).toEqual([])
})

test('past the threshold: one reminder and the level is kept', async ($, on) => {
  const w = world(on, { tokens: 724400 })
  const r = await $.classic.UserPromptSubmit(prompt())
  expect(r.additionalContext).toEqual([reminder(724400)])
  expect(w.writes).toEqual({ '/cfg/makarasty/context/s1': '700000' })
  expect(w.runs).toEqual([])
})

test('the same level on disk: no second reminder', async ($, on) => {
  const w = world(on, { tokens: 724400, level: '700000' })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toBeUndefined()
  expect(w.writes).toEqual({})
})

test('a /compact that drops it under the threshold clears the level', async ($, on) => {
  const w = world(on, { tokens: 120000, level: '850000' })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toBeUndefined()
  expect(w.writes).toEqual({ '/cfg/makarasty/context/s1': '0' })
})

test('MAKARASTY_HANDOFF_AT and _STEP are honoured', async ($, on) => {
  const w = world(on, { tokens: 450000, env: { MAKARASTY_HANDOFF_AT: '400000', MAKARASTY_HANDOFF_STEP: '100000' } })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toEqual([reminder(450000)])
  expect(w.writes['/cfg/makarasty/context/s1']).toBe('400000')
})

test('MAKARASTY_HANDOFF_AT=0 turns it off', async ($, on) => {
  const w = world(on, { tokens: 900000, env: { MAKARASTY_HANDOFF_AT: '0' } })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toBeUndefined()
  expect(w.writes).toEqual({})
})

test('a prompt asking for the handoff gets no reminder and leaves the level', async ($, on) => {
  const w = world(on, { tokens: 800000 })
  expect((await $.classic.UserPromptSubmit(prompt('/makarasty-tools:handoff'))).additionalContext).toBeUndefined()
  expect(w.writes).toEqual({})
})

test('a live fleet session gets none', async ($, on) => {
  const w = world(on, { tokens: 800000, fleet: '/runs/r1' })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toBeUndefined()
  expect(w.writes).toEqual({})
})

test('an old record with a run folder touched in the last two days still exempts: a long run outlives its record', async ($, on) => {
  const w = world(on, { tokens: 800000, fleet: '/runs/r1', fleetAge: 3 * DAY, runAge: 1000 })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toBeUndefined()
  expect(w.writes['/cfg/makarasty/context/s1']).toBeUndefined()
})

test('a fleet record not rewritten for two days does not exempt', async ($, on) => {
  const w = world(on, { tokens: 800000, fleet: '/runs/r1', fleetAge: 3 * DAY })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toEqual([reminder(800000)])
  expect(w.writes['/cfg/makarasty/context/s1']).toBe('700000')
})

test('a collecting hold gets none and leaves the level, so the reminder comes after the codeword', async ($, on) => {
  const w = world(on, { tokens: 800000, hold: 'collecting абрикос\n1. отступ\n' })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toBeUndefined()
  expect(w.writes).toEqual({})
})

test('a hold list PowerShell wrote, with a BOM, still counts as collecting', async ($, on) => {
  const w = world(on, { tokens: 800000, hold: '\uFEFFcollecting абрикос\n' })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toBeUndefined()
  expect(w.writes).toEqual({})
})

test('a collecting hold in the folder layout (hold/<session>/index.md) gets none either', async ($, on) => {
  const w = world(on, { tokens: 800000, holdIndex: 'collecting абрикос\n01 | open | отступ | \n' })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toBeUndefined()
  expect(w.writes).toEqual({})
})

test('a released folder-layout hold does not exempt', async ($, on) => {
  const w = world(on, { tokens: 800000, holdIndex: 'released абрикос\n01 | done | отступ | \n' })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toEqual([reminder(800000)])
  expect(w.writes['/cfg/makarasty/context/s1']).toBe('700000')
})

test('a released hold list does not exempt', async ($, on) => {
  const w = world(on, { tokens: 800000, hold: 'released абрикос\n1. отступ\n' })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toEqual([reminder(800000)])
  expect(w.writes['/cfg/makarasty/context/s1']).toBe('700000')
})

test('a hold list untouched for a day does not exempt', async ($, on) => {
  const w = world(on, { tokens: 800000, hold: 'collecting абрикос\n', holdAge: 2 * DAY })
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toEqual([reminder(800000)])
  expect(w.writes['/cfg/makarasty/context/s1']).toBe('700000')
})

test('no reading yet (fresh, resumed or compacted window): context.mjs answers from the transcript', async ($, on) => {
  const w = world(on, {})
  w.say(`${reminder(910000)}\n`)
  const r = await $.classic.UserPromptSubmit(prompt())
  expect(r.additionalContext).toEqual([reminder(910000)])
  expect(w.runs[0]!.argv[1]).toMatch(/[\\/]hooks[\\/]context\.mjs$/)
  expect(JSON.parse(w.runs[0]!.stdin!)).toMatchObject({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go on' })
})

test('and when context.mjs has nothing to say, neither do the gates', async ($, on) => {
  world(on, {})
  expect((await $.classic.UserPromptSubmit(prompt())).additionalContext).toBeUndefined()
})

test('missing ids or transcript: silent, like context.mjs', async ($, on) => {
  const w = world(on, { tokens: 800000 })
  expect((await $.classic.UserPromptSubmit({ prompt: 'x', session_id: '', transcript_path: '' })).additionalContext).toBeUndefined()
  expect(w.writes).toEqual({})
})

test('SessionStart compact names the transcript; other sources do not', async ($, on) => {
  world(on, {})
  expect((await $.classic.SessionStart({ source: 'compact', transcript_path: '/x/t.jsonl' })).additionalContext).toEqual([afterCompact('/x/t.jsonl'), economy, habits, asking, findings])
  expect((await $.classic.SessionStart({ source: 'startup', transcript_path: '/x/t.jsonl' })).additionalContext).toEqual([economy, habits, asking, findings])
})

test('token economy: once on startup, clear, resume and compact; MAKARASTY_ECONOMY=off says nothing', async ($, on) => {
  world(on, {})
  for (const source of ['startup', 'clear', 'resume', 'compact'] as const) {
    const ctx = (await $.classic.SessionStart({ source, transcript_path: '/x/t.jsonl' })).additionalContext ?? []
    expect(ctx.filter(c => c === economy)).toHaveLength(1)
  }
  expect(economy.length).toBeLessThan(700)
  expect(habits.length).toBeLessThan(1450)
})

test('habits: names each standing rule, under its budget', () => {
  for (const w of [/what you did not check/, /what happened, why, what you did, what the person must do/, /urgent: the core change and one check/, /never a second/, /Ask first, listing the files: a commit, push, merge, release, delete/, /edit and commit only your own files/, /never raise --max-old-space-size/, /find the culprit before any rollback or pin/]) expect(habits).toMatch(w)
})

test('MAKARASTY_ECONOMY=off and MAKARASTY_FINDINGS=off drop their texts and leave the compact note', async ($, on) => {
  world(on, { env: { MAKARASTY_ECONOMY: 'off', MAKARASTY_FINDINGS: 'off' } })
  expect((await $.classic.SessionStart({ source: 'startup' })).additionalContext).toBeUndefined()
  expect((await $.classic.SessionStart({ source: 'resume' })).additionalContext).toBeUndefined()
  expect((await $.classic.SessionStart({ source: 'compact', transcript_path: '/x/t.jsonl' })).additionalContext).toEqual([afterCompact('/x/t.jsonl')])
})

test('asking: one line names each rule the person asked for, under its budget', () => {
  for (const w of [/stands alone/, /Number every list/, /continue\?/, /one click or one command/, /what made it, its size, what breaks without it, and your recommendation/, /one ask \(AskUserQuestion\), the recommended option first/, /message that stands alone/, /with the outcomes as options, never only in prose/]) expect(asking).toMatch(w)
  expect(asking.length).toBeLessThan(1050)
})

test('profile.md: added after the rules when present, BOM dropped, capped', async ($, on) => {
  world(on, { profile: '﻿Language: Russian.\nMachine: 32 GB.' + 'x'.repeat(5000) })
  const ctx = (await $.classic.SessionStart({ source: 'startup' })).additionalContext ?? []
  expect(ctx.slice(0, 4)).toEqual([economy, habits, asking, findings])
  expect(ctx[4]).toMatch(/^The person's profile \(\/cfg\/makarasty\/profile\.md.*: Language: Russian\.\nMachine: 32 GB\.x+ \[cut at 2000 characters: the rest of the file is not read\]$/)
  expect(ctx[4]!.length).toBeLessThan(PROFILE_MAX + 200)
})

test('profile.md alone survives MAKARASTY_ECONOMY=off and _FINDINGS=off', async ($, on) => {
  world(on, { env: { MAKARASTY_ECONOMY: 'off', MAKARASTY_FINDINGS: 'off' }, profile: 'Answer in German.' })
  expect((await $.classic.SessionStart({ source: 'startup' })).additionalContext).toEqual([expect.stringMatching(/Answer in German\.$/)])
})

test('an empty profile.md adds nothing', async ($, on) => {
  world(on, { profile: '  \n' })
  expect((await $.classic.SessionStart({ source: 'startup' })).additionalContext).toEqual([economy, habits, asking, findings])
})

test('findings: every subagent gets the line', async ($, on) => {
  world(on, {})
  expect((await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })).additionalContext).toEqual([findings])
  expect(findings.length).toBeLessThan(300)
})

test('MAKARASTY_FINDINGS=off: no line in subagents, economy alone in a main session', async ($, on) => {
  world(on, { env: { MAKARASTY_FINDINGS: 'off' } })
  expect((await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })).additionalContext).toBeUndefined()
  expect((await $.classic.SessionStart({ source: 'startup' })).additionalContext).toEqual([economy, habits, asking])
})

test('an armed chat past the threshold gets both: notify runs and the reminder is returned', async ($, on) => {
  const w = world(on, { markers: ['s1.json'], tokens: 724400 })
  const r = await $.classic.UserPromptSubmit(prompt())
  expect(w.events()).toEqual(['UserPromptSubmit'])
  expect(r.additionalContext).toEqual([reminder(724400)])
})

test('SessionStart of any source removes the ended marker of a session that comes back', async ($, on) => {
  const w = world(on, { markers: 'missing', exists: '/cfg/makarasty/ended/s1' })
  await $.classic.SessionStart({ source: 'resume', session_id: 's1' })
  expect(w.runs.map(r => plain(String(r.argv.at(-1))))).toEqual(['/cfg/makarasty/ended/s1'])
  await $.classic.SessionStart({ source: 'startup', session_id: 's2' })
  expect(w.runs).toHaveLength(1)
})
