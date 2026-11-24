import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { WAIT } from './pace.ts'

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

test('a refused wakeup gets no note', async ($, on) => {
  app(on, { refuse: true })
  expect(await $.tool.call(wake())).toEqual({ deny: 'no loop' })
})

test('MAKARASTY_PACE=off drops the note', async ($, on) => {
  app(on, { env: { MAKARASTY_PACE: 'off' } })
  expect(ctx(await $.tool.call(wake()))).not.toContain(WAIT)
})
