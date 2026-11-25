import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { NEW_FILE, PLAN, WAIT, isNewSourcePath } from './pace.ts'

// The app beneath the hooks: a wakeup is scheduled, or refused.
function app(on: On, o: { refuse?: boolean; env?: Record<string, string> } = {}) {
  mock.env(on, { ...o.env })
  mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 's1' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', (_$, e) => (e.tool === 'ScheduleWakeup' && o.refuse ? { deny: 'no loop' } : { result: 'Scheduled.' }))
}
const wake = (more: object = {}) => ({ tool: 'ScheduleWakeup', delaySeconds: 1680, reason: 'Fallback if the 16:00 shots never arrive', prompt: 'p', ...more }) as never
const ctx = (r: unknown) => (r as { context?: string[] }).context ?? []

test('a scheduled wait carries the note to start what does not need the wait', async ($, on) => {
  app(on)
  expect(ctx(await $.tool.call(wake())).at(-1)).toBe(WAIT)
})

test('a stop and other tools stay quiet', async ($, on) => {
  app(on)
  expect(ctx(await $.tool.call(wake({ stop: true })))).not.toContain(WAIT)
  expect(ctx(await $.tool.call({ tool: 'Read', file_path: 'C:/x.md' } as never))).not.toContain(WAIT)
})

const plan = (n: number, tool = 'mcp__ccd_turn__update_plan') => (tool === 'TodoWrite'
  ? { tool, todos: Array.from({ length: n }, (_, i) => ({ content: `s${i}`, status: 'pending' })) }
  : { tool, items: Array.from({ length: n }, (_, i) => ({ content: `s${i}`, status: 'pending' })), scope: 'first_task' }) as never

test('a plan of three or more steps, in the app or the CLI, carries the shape note', async ($, on) => {
  app(on)
  expect(ctx(await $.tool.call(plan(5))).at(-1)).toBe(PLAN)
  expect(ctx(await $.tool.call(plan(3, 'TodoWrite'))).at(-1)).toBe(PLAN)
})

test('a short plan, a step advance and the switch stay quiet', async ($, on) => {
  app(on)
  expect(ctx(await $.tool.call(plan(2)))).not.toContain(PLAN)
  expect(ctx(await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never))).not.toContain(PLAN)
})

test('MAKARASTY_PACE=off drops the plan note', async ($, on) => {
  app(on, { env: { MAKARASTY_PACE: 'off' } })
  expect(ctx(await $.tool.call(plan(5)))).not.toContain(PLAN)
})

function files(on: On, existing: string[], turn: { n: number }, env: Record<string, string> = {}) {
  mock.env(on, env)
  mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 's1' }))
  on('session.turns', () => ({ value: turn.n }))
  on('fs.exists', (_$, e) => ({ value: existing.includes(String(e.path).replaceAll('\\', '/').replace(/^[A-Za-z]:/, '')) }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }))
}
const write = (file_path: string) => ({ tool: 'Write', file_path, content: 'x' }) as never

test('which paths count as new source: code yes; tests, docs, fixtures, scratch and data no', () => {
  for (const p of ['/r/src/invoices/summary.js', 'C:\\r\\frontend\\src\\components\\Pick.vue', '/r/server/api.ts', '/r/cmd/main.go']) expect(isNewSourcePath(p)).toBe(true)
  for (const p of ['/r/test/a.test.js', '/r/src/a.spec.ts', '/r/docs/x.md', '/r/tests/util.js', 'C:\\Users\\me\\AppData\\Local\\Temp\\x.js', '/r/fixtures/f.js', '/r/data.json', '/r/node_modules/a/i.js']) expect(isNewSourcePath(p)).toBe(false)
})

test('the first new source file of a prompt carries the reuse note; an edit of an existing file, a second new file and a test do not', async ($, on) => {
  const turn = { n: 1 }
  files(on, ['/r/src/orders/order.js'], turn)
  expect(ctx(await $.tool.call(write('/r/test/summary.test.js')))).not.toContain(NEW_FILE)
  expect(ctx(await $.tool.call(write('/r/src/orders/order.js')))).not.toContain(NEW_FILE)
  expect(ctx(await $.tool.call(write('/r/src/invoices/summary.js'))).at(-1)).toBe(NEW_FILE)
  expect(ctx(await $.tool.call(write('/r/src/invoices/due.js')))).not.toContain(NEW_FILE)
  turn.n = 2
  expect(ctx(await $.tool.call(write('/r/src/invoices/more.js'))).at(-1)).toBe(NEW_FILE)
})

test('MAKARASTY_PACE=off drops the reuse note', async ($, on) => {
  files(on, [], { n: 1 }, { MAKARASTY_PACE: 'off' })
  expect(ctx(await $.tool.call(write('/r/src/x.js')))).not.toContain(NEW_FILE)
})

test('a refused wakeup gets no note', async ($, on) => {
  app(on, { refuse: true })
  expect(await $.tool.call(wake())).toEqual({ deny: 'no loop' })
})

test('MAKARASTY_PACE=off drops the note', async ($, on) => {
  app(on, { env: { MAKARASTY_PACE: 'off' } })
  expect(ctx(await $.tool.call(wake()))).not.toContain(WAIT)
})
