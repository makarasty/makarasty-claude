import { expect, test } from 'claude-code/testing'
import { READS, readsFor, withReads } from './reads.ts'

const core = [{ id: 'engine:core', text: 'core', scope: 'shared' as const }]

test('a session that offers Read gets the line, last', () => {
  expect(withReads(core, ['Read', 'Grep', 'Glob', 'Bash'], false).at(-1)).toEqual({ id: 'makarasty-tools:reads', text: READS, scope: 'session' })
})

test('MAKARASTY_READS=off, or no Read tool, leaves the prompt alone', () => {
  expect(withReads(core, ['Read'], true)).toBe(core)
  expect(withReads(core, ['Bash'], false)).toBe(core)
})

test('it names only the tools the agent has', () => {
  const read = readsFor(['Read', 'Edit'])
  expect(read).toMatch(/^Read files with the Read tool, not with/)
  expect(read).not.toMatch(/Grep|Glob/)
  expect(readsFor(['Read', 'Grep'])).toMatch(/^Read and search files with the Read and Grep tools, not with/)
  expect((withReads(core, ['Read', 'Edit'], false).at(-1) as { text: string }).text).toBe(read)
})
