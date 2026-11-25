import { test, expect } from 'claude-code/testing'
import { register, route, type SpawnFacts } from './router.ts'

const spawn = (description: string, more: Partial<SpawnFacts> = {}): SpawnFacts => ({
  parentModel: 'claude-opus-5-5', subagentType: 'general-purpose', description, plugin: 'engine',
  builtIn: true, workflow: false, fork: false, ...more,
})

test('a named model, a plugin agent, a workflow agent or a fork is never touched', () => {
  expect(route(spawn('[exec] Port worker commands', { model: 'opus' })).to).toBeUndefined()
  expect(route(spawn('[exec] Port worker commands', { builtIn: false })).to).toBeUndefined()
  expect(route(spawn('[exec] Port worker commands', { workflow: true })).to).toBeUndefined()
  expect(route(spawn('[exec] Port worker commands', { fork: true })).to).toBeUndefined()
})

test('a parent below the top tier keeps its own model', () => {
  expect(route(spawn('[exec] Port worker commands', { parentModel: 'claude-sonnet-5-5' })).to).toBeUndefined()
  expect(route(spawn('Map callers', { subagentType: 'Explore', parentModel: 'claude-sonnet-5-5' })).to).toBeUndefined()
})

test('untagged work keeps the parent model, whatever it says', () => {
  for (const d of ['Port worker commands to TS', 'F page header foundation', 'Review RPM controllers', 'Silent catches batch 4'])
    expect(route(spawn(d)).to).toBeUndefined()
})

test('a leading tag routes, a tag elsewhere does not; Explore is never moved', () => {
  expect(route(spawn('[exec] Merge wave 2')).to).toBe('sonnet')
  expect(route(spawn('[mech] Collect open items')).to).toBe('haiku')
  expect(route(spawn('Fix the [exec] parser')).to).toBeUndefined()
  expect(route(spawn('Map RHS integration', { subagentType: 'Explore' })).to).toBeUndefined()
})

test("a user's own agent keeps its frontmatter model even when tagged", () => {
  expect(route(spawn('[exec] Port worker commands', { subagentType: 'my-porter' })).to).toBeUndefined()
  expect(route(spawn('[mech] Collect', { subagentType: 'Plan' })).to).toBeUndefined()
})

test("the fleet's coder routes on a tag, with or without the plugin prefix, and its reviewer never does", () => {
  const fleet = (type: string, d: string, more: Partial<SpawnFacts> = {}): SpawnFacts =>
    spawn(d, { subagentType: type, plugin: 'makarasty', builtIn: false, ...more })
  expect(route(fleet('makarasty:fleet-coder', '[exec] Fix t-12')).to).toBe('sonnet')
  expect(route(fleet('fleet-coder', '[mech] Rename helpers')).to).toBe('haiku')
  // The reviewer is the independent check that makes [exec] safe: it keeps the parent's model.
  expect(route(fleet('makarasty:fleet-reviewer', '[exec] Review wave 2')).to).toBeUndefined()
  expect(route(fleet('fleet-reviewer', '[mech] Review wave 2')).to).toBeUndefined()
  expect(route(fleet('makarasty:fleet-reviewer', '[exec] Review wave 2')).why).toBe('reviewer is the check')
  expect(route(fleet('makarasty:fleet-coder', '[exec] Fix t-12', { plugin: 'makarasty@makarasty' })).to).toBe('sonnet')
  expect(route(fleet('makarasty:fleet-coder', 'Fix t-12')).to).toBeUndefined()
  expect(route(fleet('makarasty:fleet-coder', '[exec] Fix t-12', { parentModel: 'claude-sonnet-5-5' })).to).toBeUndefined()
  expect(route(fleet('makarasty:fleet-coder', '[exec] Fix t-12', { model: 'opus' })).to).toBeUndefined()
  expect(route(fleet('makarasty:fleet-scenario', '[exec] Walk login')).to).toBeUndefined()
  // A user's own fleet-coder.md comes from the engine, not the plugin: its frontmatter model stands.
  expect(route(fleet('fleet-coder', '[exec] Fix t-12', { plugin: 'engine' })).to).toBeUndefined()
})

test('/router prints the skill router counts beside the spawn counts', async () => {
  const handlers: Record<string, (...a: never[]) => unknown> = {}
  const on = ((event: string, a: unknown, b?: unknown) => { handlers[event] = (b ?? a) as never; return { catch: () => undefined } }) as never
  register(on, {} as never)
  const mem = new Map<string, unknown>([['stats', { routed: { haiku: 1 }, kept: {}, last: ['a line'] }], ['skillStats', { '2026-11-25': { named: 3, none: 5, failed: 2, late: 1, answered: 9, ms: 4500 } }]])
  const $ = { store: { get: async (k: string) => mem.get(k) }, clock: { now: async () => 0 } }
  const out = (await handlers['command.run']!($ as never, { command: 'router' } as never, undefined as never)) as { text: string }
  expect(out.text).toContain('routed {"haiku":1}')
  expect(out.text).toContain('2026-11-25: named 3, none 5, failed 2, late 1; answered 9, avg 500 ms')
  mem.delete('stats')
  expect(((await handlers['command.run']!($ as never, { command: 'router' } as never, undefined as never)) as { text: string }).text).toContain('named 3')
})
