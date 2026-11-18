import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { HINT, frontmatter, newest, pick, worth } from './skill-router.ts'

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
    ['<command-message>inbox</command-message>\n<command-name>/makarasty-tools:inbox</command-name>\n<command-args>подготовь shop к деплою</command-args>', 'composer']] as const)
    expect([t.slice(0, 30), o, worth(t, o)]).toEqual([t.slice(0, 30), o, false])
})

test('newest: the highest version folder, by number, not by name or time', () => {
  expect(newest(['1.9.0', '1.18.16', '1.18.2', 'temp'])).toBe('1.18.16')
  expect(newest([])).toBeUndefined()
})

function world(on: On, reply: string | undefined, env: Record<string, string> = {}, hold = false) {
  const ran: string[] = []
  const asked: string[] = []
  on('tool.call', async (_$, e) => { ran.push(e.tool); return { result: 'ok' } })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', MAKARASTY_SCREEN: 'off', ...env })
  mock.clock(on, { now: 1_000_000 })
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
  on('model.complete', (_$, e) => {
    asked.push(String((e as { system?: string }).system ?? ''))
    return { value: reply === undefined ? { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } : { isAnswered: true, text: reply, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } as never
  })
  return { ran, asked }
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

test('a Write or Edit is never sent back; the look-around call after it is', async ($, on) => {
  const w = world(on, 'makarasty-tools:commit')
  await $.prompt.submit(typed('закоммить'))
  expect(await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [] } as never)).toEqual({ result: 'ok' })
  expect(await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'x' } as never)).toEqual({ result: 'ok' })
  expect(await $.tool.call(glob)).toEqual({ deny: expect.stringContaining('makarasty-tools:commit') })
  expect(w.ran).toEqual(['mcp__ccd_turn__update_plan', 'Write'])
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
