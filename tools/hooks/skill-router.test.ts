import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HINT, OFF_HINT, type SkillStats, skillStatsText, frontmatter, hintFor, newest, pick, plainAction, sawListing, system, worth } from './skill-router.ts'
declare const setTimeout: (f: (v?: unknown) => void, ms: number) => unknown // the test runtime has it
const SKILLS = [{ name: 'makarasty-tools:commit', description: 'Commits this chat as you.' }, { name: 'makarasty:fleet-wait', description: 'Waits for a fleet.' }]

test('frontmatter: a quoted or plain description; a skill only the person starts is marked', () => {
  expect(frontmatter('---\ndescription: "One \\"commit\\". commit / закоммить"\n---\nbody')).toEqual({ description: 'One "commit". commit / закоммить', manual: false })
  expect(frontmatter('﻿---\r\ndescription: Plain words\r\ndisable-model-invocation: true\r\n---\r\n')).toEqual({ description: 'Plain words', manual: true })
  expect(frontmatter('no frontmatter')).toEqual({ manual: false })
  expect(frontmatter('---\ndescription:\nargument-hint: x\n---\n').description).toBeUndefined()
  expect(frontmatter('---\ndescription: >-\n  folded\n---\n').description).toBeUndefined()
})

test('pick: the first full name, or a short name alone; none anywhere, prose or an unknown name is no skill', () => {
  expect(pick('makarasty-tools:commit', SKILLS)?.name).toBe('makarasty-tools:commit')
  expect(pick(' `Fleet-Wait`\n', SKILLS)?.name).toBe('makarasty:fleet-wait')
  expect(pick('makarasty:fleet-wait, not makarasty-tools:commit', SKILLS)?.name).toBe('makarasty:fleet-wait')
  for (const r of ['none', 'None.', '', undefined, 'makarasty-tools:ship', 'Answer: none (it asks about commit)', 'no skill, I would commit by hand', 'committing'])
    expect([r, pick(r, SKILLS)]).toEqual([r, undefined])
  // "selfreview" must not read as review: names are matched whole.
  expect(pick('selfreview', [{ name: 'x:review', description: '' }, { name: 'x:selfreview', description: '' }])?.name).toBe('x:selfreview')
})

test('worth: the person\'s own short prompt, pastes left out; a slash command, a wrapper, a peer, another session\'s message or a long brief is not routed', () => {
  expect(worth('закоммить', 'composer')).toBe(true)
  expect(worth('commit this', 'sdk')).toBe(true)
  expect(worth('<pasted_content id="1">git log\n</pasted_content id="1"> закоммить это', 'composer')).toBe(true)
  for (const [t, o] of [['/commit', 'composer'], ['<task-notification>x', 'composer'], ['ok', 'composer'], ['commit this', 'peer'], ['x'.repeat(4001), 'composer'],
    ['Another Claude session sent a message: commit and push', 'composer'], ['The makarasty-tools plugin sent a message: push', 'composer'], [`run the brief ${'x'.repeat(1000)}`, 'sdk'],
    ['Base directory for this skill: /p/skills/ship\n\nShip does three things: commit, merge, push', 'composer'], ['<system-reminder>x</system-reminder>\nAnother Claude session sent a message: commit and push', 'composer'],
    ['<command-message>inbox</command-message>\n<command-name>/makarasty-tools:inbox</command-name>\n<command-args>подготовь shop к деплою</command-args>', 'composer']] as const)
    expect([t.slice(0, 30), o, worth(t, o)]).toEqual([t.slice(0, 30), o, false])
})

test('fleet off in this project: a fleet hint says how to turn it on; a tools hint, or fleet on or unknown, is the plain hint', () => {
  const wait = SKILLS[1]!, commit = SKILLS[0]!
  expect(sawListing('- makarasty-tools:commit: x\n- makarasty:fleet-wait: y', true)).toBe(true)
  expect(sawListing('- makarasty-tools:commit: x', true)).toBe(false)
  expect(sawListing('- makarasty-tools:commit: x', false)).toBeUndefined() // a later delta without fleet changes nothing
  expect(hintFor(wait, false, false)).toBe(OFF_HINT(wait, false))
  expect(OFF_HINT(wait, false)).toContain('"makarasty@makarasty": true')
  expect(hintFor(wait, false, true)).toBe(HINT(wait, false))
  expect(hintFor(wait, false, undefined)).toBe(HINT(wait, false))
  expect(hintFor(commit, true, false)).toBe(HINT(commit, true))
})

test('newest: the highest version folder, by number, not by name or time', () => {
  expect(newest(['1.9.0', '1.18.16', '1.18.2', 'temp'])).toBe('1.18.16')
  expect(newest([])).toBeUndefined()
})

function world(on: On, reply: string | undefined, env: Record<string, string> = {}, hold = false, said: readonly { role: 'user' | 'assistant'; text: string }[] = [], gate?: Promise<void>) {
  const ran: string[] = []
  const asked: string[] = []
  const prompts: string[] = []
  on('session.messages', () => ({ value: said.map((m) => ({ ...m, toolUses: [] })) as never }))
  on('tool.call', async (_$, e) => { ran.push(e.tool); return { result: 'ok' } })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', MAKARASTY_SCREEN: 'off', ...env })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: false }))
  // The engine may hand a path on with the drive and backslashes of Windows.
  const at = (e: unknown) => (e as { path: string }).path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
  on('fs.list', (_$, e) => ({ value: at(e).endsWith('/skills') ? [{ name: 'commit', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }, { name: 'tune', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] : [] }) as never)
  on('fs.read', (_$, e) => {
    const p = at(e)
    if (p.endsWith('/skills/commit/SKILL.md')) return { value: '---\ndescription: "Commits this chat as you. commit / закоммить"\n---\n' } as never
    if (p.endsWith('/skills/tune/SKILL.md')) return { value: '---\ndescription: Tunes models.\ndisable-model-invocation: true\n---\n' } as never
    if (hold && p === '/cfg/makarasty/hold/s1/index.md') return { value: 'collecting\n- a' } as never
    return { deny: 'ENOENT' }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 999_000, isLink: false } }) as never)
  const store = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: store.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', (_$, e) => { const x = e as unknown as { key: string; value: unknown }; store.set(x.key, x.value); return { value: undefined } as never })
  on('model.complete', async (_$, e) => {
    await gate
    asked.push(JSON.stringify((e as { system?: unknown }).system ?? ''))
    prompts.push(String((e as { prompt?: string }).prompt ?? ''))
    return { value: reply === undefined ? { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } : { isAnswered: true, text: reply, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } as never
  })
  return { ran, asked, prompts, clock, store }
}
const typed = (text: string) => ({ text, origin: { kind: 'composer' } }) as never
const glob = { tool: 'Glob', pattern: '**/*' } as never

test('a named skill sends the first tool call back once with the hint; the call after it runs', async ($, on) => {
  const w = world(on, 'makarasty-tools:commit')
  await $.prompt.submit(typed('ну короче закоммить всё'))
  expect(await $.tool.call(glob)).toEqual({ deny: HINT({ name: 'makarasty-tools:commit', description: 'Commits this chat as you. commit / закоммить' }, false) })
  expect(await $.tool.call(glob)).toEqual({ result: 'ok' })
  expect(w.ran).toEqual(['Glob'])
  // Only skills the model may start are in the router's list.
  expect(w.asked[0]).toContain('makarasty-tools:commit')
  expect(w.asked[0]).not.toContain('makarasty-tools:tune')
})

test('a Skill call first: the model\'s own pick stands, nothing is sent back', async ($, on) => {
  const w = world(on, 'makarasty-tools:commit')
  await $.prompt.submit(typed('закоммить'))
  expect(await $.tool.call({ tool: 'Skill', skill: 'makarasty-tools:ship' } as never)).toEqual({ result: 'ok' })
  expect(await $.tool.call(glob)).toEqual({ result: 'ok' })
  expect(w.ran).toEqual(['Skill', 'Glob'])
})

test('the small model answering none lets every call run', async ($, on) => {
  const w = world(on, 'none')
  await $.prompt.submit(typed('what does git commit --amend do?'))
  expect(await $.tool.call(glob)).toEqual({ result: 'ok' })
  expect(w.ran).toEqual(['Glob'])
})

test('a failed small model lets every call run', async ($, on) => {
  const w = world(on, undefined)
  await $.prompt.submit(typed('закоммить'))
  expect(await $.tool.call(glob)).toEqual({ result: 'ok' })
  expect(w.ran).toEqual(['Glob'])
})

test('MAKARASTY_SKILL_ROUTER=off asks no model', async ($, on) => {
  const w = world(on, 'makarasty-tools:commit', { MAKARASTY_SKILL_ROUTER: 'off' })
  await $.prompt.submit(typed('закоммить'))
  expect(await $.tool.call(glob)).toEqual({ result: 'ok' })
  expect(w.asked).toEqual([])
})

test('a text-only turn gets the hint once at its end; a turn that made a call, or one sent back already, does not', async ($, on) => {
  world(on, 'makarasty-tools:commit')
  on('classic.Stop', async () => ({}))
  const stop = async (active: boolean) => (await $.classic.Stop({ stop_hook_active: active, last_assistant_message: 'Вот как закоммитить.' } as never)).block
  await $.prompt.submit(typed('закоммить'))
  expect(String(await stop(false))).toContain('end the turn as it is')
  expect(await stop(false)).toBeUndefined()
  await $.prompt.submit(typed('закоммить'))
  expect(await stop(true)).toBeUndefined()
  await $.prompt.submit(typed('закоммить'))
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' } as never)
  expect(await stop(false)).toBeUndefined()
})

test('a plan update keeps the hint for the look-around call after it; a Write or Edit is never sent back and ends the hint', async ($, on) => {
  const w = world(on, 'makarasty-tools:commit')
  await $.prompt.submit(typed('закоммить'))
  expect(await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [] } as never)).toEqual({ result: 'ok' })
  expect(await $.tool.call(glob)).toEqual({ deny: expect.stringContaining('makarasty-tools:commit') })
  await $.prompt.submit(typed('закоммить'))
  // A new source file may carry pace.ts's reuse note; this test is about the hint, so only the result is checked.
  expect(await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' } as never)).toMatchObject({ result: 'ok' })
  expect(await $.tool.call(glob)).toEqual({ result: 'ok' })
  expect(w.ran).toEqual(['mcp__ccd_turn__update_plan', 'Write', 'Glob'])
})

test('three look-around calls sent together keep the hint for the one that waited', async ($, on) => {
  world(on, 'makarasty-tools:commit')
  await $.prompt.submit(typed('закоммить'))
  const all = await Promise.all([$.tool.call(glob), $.tool.call(glob), $.tool.call(glob)])
  expect(all.filter((r) => 'deny' in (r as object)).length).toBe(1)
})

test('while a hold is collecting, no prompt is routed', async ($, on) => {
  const w = world(on, 'makarasty-tools:commit', {}, true)
  await $.prompt.submit(typed('и ещё закоммить надо бы'))
  expect(await $.tool.call(glob)).toEqual({ result: 'ok' })
  expect(w.asked).toEqual([])
})

test('a prompt delivered into a running turn keeps that turn\'s hint', async ($, on) => {
  world(on, 'makarasty-tools:commit')
  await $.prompt.submit(typed('закоммить'))
  await $.prompt.submit({ text: 'и ещё одно', origin: { kind: 'composer' }, turnId: 't1' } as never)
  expect(await $.tool.call(glob)).toEqual({ deny: expect.stringContaining('makarasty-tools:commit') })
})

test('the classifier sees the chat\'s last question, cut to its last 600 characters, and its prompt says a short reply to it is none', async ($, on) => {
  const long = 'x'.repeat(900) + ' Запушить master в origin?'
  const w = world(on, 'none', {}, false, [{ role: 'user', text: 'старое' }, { role: 'assistant', text: 'ранний ответ' }, { role: 'user', text: 'сделай' }, { role: 'assistant', text: long }])
  await $.prompt.submit(typed('Да, пушь'))
  await $.tool.call(glob)
  expect(w.prompts[0]).toBe(`Chat asked:\n<<<ASKED\n${long.slice(-600)}\nASKED>>>\nMessage:\n<<<MSG\nДа, пушь\nMSG>>>`)
  expect(system(SKILLS)).toContain('short answer to what the chat asked')
  expect(w.asked[0]).toContain('short answer to what the chat asked')
})

test('with no earlier assistant message the prompt carries the message alone', async ($, on) => {
  const w = world(on, 'none', {}, false, [{ role: 'user', text: 'привет' }])
  await $.prompt.submit(typed('закоммить'))
  await $.tool.call(glob)
  expect(w.prompts[0]).toBe('Message:\n<<<MSG\nзакоммить\nMSG>>>')
})

test('plainAction: one git push, commit or pull, with a cd or -C before it; a chain, another git verb or another tool is not', () => {
  for (const c of ['git push origin master', 'cd /c/p && git push origin master', 'git -C /c/p commit -m "a; b && c"', 'git commit -m "$(cat <<\'EOF\'\nfix\nEOF\n)"', 'git pull --ff-only'])
    expect([c, plainAction('Bash', c)]).toEqual([c, true])
  for (const c of ['git add -A && git commit -m x', 'git push; rm x', 'git log --oneline', 'git status | head', 'echo git push', 'git push || true', undefined])
    expect([c, plainAction('Bash', c)]).toEqual([c, false])
  expect(plainAction('PowerShell', 'git push')).toBe(true)
  expect(plainAction('Read', 'git push')).toBe(false)
})

test('the held call is the plain git action: it runs, nothing is sent back, and the hint is spent', async ($, on) => {
  const w = world(on, 'makarasty-tools:commit')
  await $.prompt.submit(typed('закоммить и запушь'))
  expect(await $.tool.call({ tool: 'Bash', command: 'git push origin master' } as never)).toEqual({ result: 'ok' })
  expect(await $.tool.call(glob)).toEqual({ result: 'ok' })
  expect(w.ran).toEqual(['Bash', 'Glob'])
  await $.prompt.submit(typed('закоммить'))
  expect(await $.tool.call({ tool: 'Bash', command: 'git log --oneline' } as never)).toEqual({ deny: expect.stringContaining('makarasty-tools:commit') })
})

test('a hint older than 60 s is dropped at the first call and at the end of the turn; a fresh one is not', async ($, on) => {
  const { clock } = world(on, 'makarasty-tools:commit')
  on('classic.Stop', async () => ({}))
  await $.prompt.submit(typed('закоммить'))
  await clock.advance(61_000)
  expect(await $.tool.call(glob)).toEqual({ result: 'ok' })
  await $.prompt.submit(typed('закоммить'))
  await clock.advance(61_000)
  expect(await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'x' } as never)).toEqual({})
  await $.prompt.submit(typed('закоммить'))
  await clock.advance(30_000)
  expect(await $.tool.call(glob)).toEqual({ deny: expect.stringContaining('makarasty-tools:commit') })
})

const today = '1970-01-01'
const counts = (w: { store: Map<string, unknown> }) => (w.store.get('skillStats') as SkillStats | undefined)?.[today]

test('stats: a named call counts named, with its time', async ($, on) => {
  const w = world(on, 'makarasty-tools:commit')
  await $.prompt.submit(typed('закоммить'))
  await $.tool.call(glob)
  expect(counts(w)).toMatchObject({ named: 1, none: 0, failed: 0, late: 0, answered: 1 })
})

test('stats: the small model saying none counts none', async ($, on) => {
  const w = world(on, 'none')
  await $.prompt.submit(typed('what does git commit --amend do?'))
  await $.tool.call(glob)
  expect(counts(w)).toMatchObject({ named: 0, none: 1, failed: 0, late: 0, answered: 1 })
})

test('stats: a failed call counts failed and is not timed', async ($, on) => {
  const w = world(on, undefined)
  await $.prompt.submit(typed('закоммить'))
  await $.tool.call(glob)
  expect(counts(w)).toMatchObject({ named: 0, none: 0, failed: 1, late: 0, answered: 0, ms: 0 })
})

test('stats: an answer that comes after the wait counts late, not named, and sends nothing back', async ($, on) => {
  let release!: () => void
  const w = world(on, 'makarasty-tools:commit', {}, false, [], new Promise<void>((r) => { release = r }))
  await $.prompt.submit(typed('закоммить'))
  const call = $.tool.call(glob)
  await w.clock.advance(1500)
  expect(await call).toEqual({ result: 'ok' })
  release()
  for (let i = 0; i < 200 && !counts(w)?.late; i++) await new Promise((r) => setTimeout(r, 5))
  expect(counts(w)).toMatchObject({ named: 0, none: 0, failed: 0, late: 1, answered: 1 })
})

test('stats: only the last 7 days are kept, and skillStatsText names every outcome and the average', async ($, on) => {
  const w = world(on, 'none')
  const day = (n: number) => `1970-01-${String(n).padStart(2, '0')}`
  const rec: SkillStats = {}
  for (let n = 2; n <= 9; n++) rec[day(n)] = { named: 1, none: 2, failed: 3, late: 4, answered: 2, ms: 300 }
  w.store.set('skillStats', rec)
  await $.prompt.submit(typed('what does git commit --amend do?'))
  await $.tool.call(glob)
  expect(Object.keys(w.store.get('skillStats') as SkillStats).sort()).toEqual([3, 4, 5, 6, 7, 8, 9].map(day))
  const text = await skillStatsText({ store: { get: async (k: string) => w.store.get(k) }, clock: { now: async () => 0 } } as never)
  expect(text).toContain(`${day(9)}: named 1, none 2, failed 3, late 4; answered 2, avg 150 ms`)
})
