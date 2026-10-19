import { expect, test } from 'claude-code/testing'
import { READS, withReads } from './reads.ts'

const core = [{ id: 'engine:core', text: 'core', scope: 'shared' as const }]

test('a session that offers Read gets the line, last', () => {
  expect(withReads(core, ['Read', 'Bash'], false).at(-1)).toEqual({ id: 'makarasty-tools:reads', text: READS, scope: 'session' })
})

test('MAKARASTY_READS=off, or no Read tool, leaves the prompt alone', () => {
  expect(withReads(core, ['Read'], true)).toBe(core)
  expect(withReads(core, ['Bash'], false)).toBe(core)
})
