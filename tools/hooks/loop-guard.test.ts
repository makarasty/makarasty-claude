import { expect, test } from 'claude-code/testing'
import { NOTE_A, NOTE_B, callOf, fresh, normalize, observe, stateFor, type Call } from './loop-guard.ts'

const sh = (input: string): Call => ({ tool: 'Bash', input })
const fail = (text: string) => ({ isError: true, text })
const ok = (text = 'ok') => ({ isError: false, text })
// Runs calls at one-second steps and returns the note each one got.
const run = (steps: [Call, { isError: boolean; text: string }][]): (string | null)[] => {
  const st = fresh()
  return steps.map(([c, o], i) => observe(st, c, o, i * 1000))
}

test('three identical failures: a note on the third, none before', () => {
  const t = sh('npm test')
  expect(run([[t, fail('boom')], [t, fail('boom')], [t, fail('boom')]])).toEqual([null, null, NOTE_A])
})

test('the note fires once per pattern, not on the fourth or fifth', () => {
  const t = sh('npm test')
  expect(run([1, 2, 3, 4, 5].map(() => [t, fail('boom')] as [Call, ReturnType<typeof fail>]))).toEqual([null, null, NOTE_A, null, null])
})

test('three identical successes (polling, git status) never trigger', () => {
  const t = sh('git status')
  expect(run([[t, ok()], [t, ok()], [t, ok()], [t, ok()]])).toEqual([null, null, null, null])
})

test('timestamps, durations, digits and temp paths in the error do not make failures differ', () => {
  const t = sh('node build.js')
  const e = (n: number, tmp: string) => fail(`2026-10-20T10:0${n}:11.${n}00Z build failed after ${n}.2s (${n}2 ms) at ${tmp}\\out.log pid ${n}0001 id 0x7ffd${n}a1b2c3 line 42`)
  expect(run([
    [t, e(1, 'C:\\Users\\mky\\AppData\\Local\\Temp\\claude\\a1b2')],
    [t, e(2, 'C:\\Users\\mky\\AppData\\Local\\Temp\\claude\\c3d4')],
    [t, e(3, 'C:\\Users\\mky\\AppData\\Local\\Temp\\claude\\e5f6')],
  ])).toEqual([null, null, NOTE_A])
  expect(normalize('built in 12 ms at /tmp/x9/y on 2026-10-20 10:11:12')).toBe(normalize('built in 3 ms at /tmp/q/z on 2025-01-02 03:04:05'))
})

test('a number that matters, or a difference past the first 2 KB, is a different outcome', () => {
  const t = sh('curl api')
  expect(run([[t, fail('HTTP 502')], [t, fail('HTTP 503')], [t, fail('HTTP 502')]])).toEqual([null, null, null])
  const long = (end: string) => fail('x'.repeat(5000) + end)
  expect(run([[t, long('refused')], [t, long('timeout')], [t, long('refused')]])).toEqual([null, null, null])
  expect(run([[t, long('refused')], [t, long('refused')], [t, long('refused')]])).toEqual([null, null, NOTE_A])
})

test('a call a guard refuses three times in a row counts as failing, the note rides on the refusal', () => {
  const t = sh('git stash')
  expect(run([[t, fail('Blocked by git-guard')], [t, fail('Blocked by git-guard')], [t, fail('Blocked by git-guard')]])).toEqual([null, null, NOTE_A])
})

test('a different error text is a different outcome', () => {
  const t = sh('npm test')
  expect(run([[t, fail('ENOENT foo')], [t, fail('EACCES bar')], [t, fail('ETIMEDOUT baz')]])).toEqual([null, null, null])
})

test('whitespace in a shell command does not make the call differ', () => {
  const a = callOf({ tool: 'Bash', command: 'npm   test\n' }), b = callOf({ tool: 'Bash', command: ' npm test' })
  expect(a).toEqual(b)
  expect(callOf({ tool: 'Edit', file_path: 'a.ts', old_string: 'x', new_string: 'y' })).not.toEqual(callOf({ tool: 'Edit', file_path: 'a.ts', old_string: 'x', new_string: 'z' }))
})

test('A,B,A,B,A,B all failing: a note on the sixth call', () => {
  const a = sh('npm run lint'), b = sh('npm run build')
  const notes = run([[a, fail('lint bad')], [b, fail('build bad')], [a, fail('lint bad')], [b, fail('build bad')], [a, fail('lint bad')], [b, fail('build bad')], [a, fail('lint bad')]])
  expect(notes).toEqual([null, null, null, null, null, NOTE_B, null])
})

test('alternation where one side succeeds, or the output keeps changing, does not trigger', () => {
  const a = sh('npm run lint'), b = sh('npm run build')
  expect(run([[a, fail('x')], [b, ok()], [a, fail('x')], [b, ok()], [a, fail('x')], [b, ok()]])).toEqual([null, null, null, null, null, null])
  expect(run([[a, fail('alpha')], [b, fail('beta')], [a, fail('gamma')], [b, fail('delta')], [a, fail('omega')], [b, fail('sigma')]]).filter(Boolean)).toEqual([])
})

test('a different command in between resets the run', () => {
  const t = sh('npm test'), other = sh('ls')
  expect(run([[t, fail('boom')], [t, fail('boom')], [other, ok()], [t, fail('boom')], [t, fail('boom')]])).toEqual([null, null, null, null, null])
  expect(run([[t, fail('boom')], [t, fail('boom')], [sh('echo hi'), fail('other')], [t, fail('boom')]])).toEqual([null, null, null, null])
})

test('a success lets the note speak again when the loop comes back', () => {
  const t = sh('npm test'), fix = sh('git add .')
  const fails = [0, 1, 2].map(() => [t, fail('boom')] as [Call, ReturnType<typeof fail>])
  expect(run([...fails, [fix, ok()], ...fails])).toEqual([null, null, NOTE_A, null, null, null, NOTE_A])
})

test('calls more than ten minutes apart are not a streak', () => {
  const st = fresh(), t = sh('npm test'), min = 60_000
  expect([0, 5 * min, 16 * min].map((at) => observe(st, t, fail('boom'), at))).toEqual([null, null, null])
  expect([17 * min, 18 * min].map((at) => observe(st, t, fail('boom'), at))).toEqual([null, NOTE_A])
})

test('memory is bounded: 50 loops, 10 calls each', () => {
  for (let i = 0; i < 80; i++) { const st = stateFor(`s${i}|`); for (let k = 0; k < 30; k++) observe(st, sh(`c${k}`), fail(`e${k}`), k) }
  expect(stateFor('s79|').calls.length).toBe(10)
  expect(stateFor('s0|').calls.length).toBe(0) // evicted, started again empty
})
