import { expect, test } from 'claude-code/testing'
import { MESSAGE, check } from './generated-guard.ts'

const H = '0'.repeat(64)
const MANIFEST = [`${H}  hooks/fleet-guard.mjs`, `${H}  scripts/design-probe.js`, `${H}  src/hooks/fleet-guard.mts`, `${H}  tools/hooks/notify.mjs`, ''].join('\n')
const CWD = 'C:\\Users\\dev\\proj'

test('a listed compiled file is refused, whatever the spelling of its path', () => {
  for (const p of [`${CWD}\\hooks\\fleet-guard.mjs`, `${CWD}/hooks/fleet-guard.mjs`, 'hooks/fleet-guard.mjs', './hooks/fleet-guard.mjs', `${CWD}\\scripts\\design-probe.js`,
    `${CWD}\\tools\\hooks\\notify.mjs`, `${CWD.toUpperCase()}\\HOOKS\\Fleet-Guard.mjs`, '/c/Users/dev/proj/hooks/fleet-guard.mjs', `${CWD}\\src\\..\\hooks\\fleet-guard.mjs`]) {
    expect([p, check(p, CWD, MANIFEST)]).toEqual([p, MESSAGE])
  }
  expect(MESSAGE).toBe('compiled output (listed in src/build.sha256): edit the .mts/.ts source, then npm run build --prefix src')
})

test('an unlisted file, a listed source, a file outside the folder and a sibling folder pass', () => {
  for (const p of [`${CWD}\\hooks\\other.mjs`, `${CWD}\\src\\hooks\\fleet-guard.mts`, `${CWD}\\README.md`, 'C:\\Users\\dev\\elsewhere\\hooks\\fleet-guard.mjs',
    'C:\\Users\\dev\\proj2\\hooks\\fleet-guard.mjs', `${CWD}\\x\\hooks\\fleet-guard.mjs`]) {
    expect([p, check(p, CWD, MANIFEST)]).toEqual([p, null])
  }
})

test('no manifest or an empty one: allowed', () => {
  expect(check(`${CWD}\\hooks\\fleet-guard.mjs`, CWD, null)).toBeNull()
  expect(check(`${CWD}\\hooks\\fleet-guard.mjs`, CWD, '')).toBeNull()
})
