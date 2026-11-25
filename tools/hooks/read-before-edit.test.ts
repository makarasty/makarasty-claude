import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { MAX_BYTES, NOTE, register } from './read-before-edit.ts'

const NOT_READ = 'File has not been read yet. Read it first before writing to it.'
const MODIFIED = 'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.'

// The app beneath the hook: Edit answers `errors` in turn, then succeeds; a Read succeeds (or fails with readFails).
function app(on: On, o: { errors?: string[]; size?: number; env?: Record<string, string>; readFails?: boolean } = {}) {
  const log: string[] = []
  const errors = [...(o.errors ?? [])]
  mock.env(on, { ...o.env })
  mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 's1' }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: o.size ?? 100, mtimeMs: 0, isLink: false } }))
  on('tool.call', (_$, e) => {
    log.push(e.tool)
    if (e.tool === 'Read') return o.readFails ? { deny: 'nope' } : { result: 'read', text: 'read' }
    const err = errors.shift()
    return err ? { result: err } : { result: 'edited', text: 'updated' }
  })
  return log
}
const edit = (file_path = 'C:/r/a.md') => ({ tool: 'Edit', file_path, old_string: 'x', new_string: 'y' }) as never
const ctx = (r: unknown) => (r as { context?: string[] }).context ?? []
const textOf = (r: unknown) => String((r as { text?: string }).text ?? (r as { result?: string }).result ?? '')
const errored = (r: unknown) => /not been read|modified since|not found/.test(textOf(r))

test('not read yet: the file is read, the edit runs again and passes with a note', async ($, on) => {
  const log = app(on, { errors: [NOT_READ] })
  const r = await $.tool.call(edit())
  expect(log).toEqual(['Edit', 'Read', 'Edit'])
  expect(errored(r)).toBe(false)
  expect(ctx(r).at(-1)).toBe(NOTE)
})

test('modified since read: the same re-read and retry', async ($, on) => {
  const log = app(on, { errors: [MODIFIED] })
  expect(ctx(await $.tool.call(edit())).at(-1)).toBe(NOTE)
  expect(log).toEqual(['Edit', 'Read', 'Edit'])
})

test('one retry only: a second refusal is the answer and no third Edit runs', async ($, on) => {
  const log = app(on, { errors: [NOT_READ, 'String to replace not found in file.', NOT_READ] })
  const r = await $.tool.call(edit())
  expect(errored(r)).toBe(true)
  expect(textOf(r)).toContain('String to replace not found')
  expect(log).toEqual(['Edit', 'Read', 'Edit'])
})

test('an edit that passes is left alone', async ($, on) => {
  const log = app(on)
  expect(ctx(await $.tool.call(edit()))).not.toContain(NOTE)
  expect(log).toEqual(['Edit'])
})

test('an error that is not about reading is left alone', async ($, on) => {
  const log = app(on, { errors: ['String to replace not found in file.'] })
  expect(errored(await $.tool.call(edit()))).toBe(true)
  expect(log).toEqual(['Edit'])
})

test('a Write of an unread file stays refused: the hook does not touch it', async ($, on) => {
  const log = app(on, { errors: [NOT_READ] })
  expect(errored(await $.tool.call({ tool: 'Write', file_path: 'C:/r/a.md', content: 'z' } as never))).toBe(true)
  expect(log).toEqual(['Write'])
})

test('a file past the size limit is not re-read', async ($, on) => {
  const log = app(on, { errors: [NOT_READ], size: MAX_BYTES + 1 })
  expect(errored(await $.tool.call(edit()))).toBe(true)
  expect(log).toEqual(['Edit'])
})

test('a Read that fails leaves the first refusal as the answer', async ($, on) => {
  const log = app(on, { errors: [NOT_READ], readFails: true })
  expect(textOf(await $.tool.call(edit()))).toBe(NOT_READ)
  expect(log).toEqual(['Edit', 'Read'])
})

test('MAKARASTY_READ_GUARD=off keeps the refusal', async ($, on) => {
  const log = app(on, { errors: [NOT_READ], env: { MAKARASTY_READ_GUARD: 'off' } })
  expect(errored(await $.tool.call(edit()))).toBe(true)
  expect(log).toEqual(['Edit'])
})
