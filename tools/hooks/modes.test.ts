import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const plain = (p: string): string => p.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
const UNSLOP = 'UNSLOP MODE ON, in every reply until /unslop off.\nAnswer first.\n'
const ANTISLOP = 'Antislop pointer.\nRead hooks/antislop/SKILL.md.\n'

// The flags that exist, by name; the plugin's own two text files are always readable.
function world(on: On, flags: string[]) {
  on('classic.SessionStart', async () => ({}))
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg' })
  on('fs.exists', async (_$, e) => ({ value: flags.some((f) => plain(e.path) === `/cfg/makarasty/${f}`) }))
  on('fs.read', async (_$, e) => {
    const p = plain(e.path)
    if (p.endsWith('/hooks/unslop.txt')) return { value: UNSLOP }
    if (p.endsWith('/hooks/antislop.txt')) return { value: ANTISLOP }
    return { deny: 'ENOENT' }
  })
}
const SOURCES = ['startup', 'resume', 'clear', 'compact'] as const
// gates.ts adds its own rules to every start: only the mode texts are looked at.
const ctx = async ($: Engine, source: (typeof SOURCES)[number]) =>
  ((await $.classic.SessionStart({ source })).additionalContext ?? []).filter((s) => s === UNSLOP || s.startsWith('antislop root: '))
const ROOT_LINE = /^antislop root: [^\\\n]+\n/

test('unslop.on: every source gets the text of unslop.txt exactly, nothing from antislop', async ($, on) => {
  world(on, ['unslop.on'])
  for (const source of SOURCES) expect(await ctx($, source)).toEqual([UNSLOP])
})

test('antislop.on: the root line with forward slashes, then the text of antislop.txt exactly', async ($, on) => {
  world(on, ['antislop.on'])
  for (const source of SOURCES) {
    const [text, ...rest] = await ctx($, source)
    expect(rest).toEqual([])
    expect(text).toMatch(ROOT_LINE)
    expect(text!.replace(ROOT_LINE, '')).toBe(ANTISLOP)
  }
})

test('both flags: unslop first, then antislop', async ($, on) => {
  world(on, ['unslop.on', 'antislop.on'])
  const [a, b] = await ctx($, 'startup')
  expect(a).toBe(UNSLOP)
  expect(b).toMatch(ROOT_LINE)
})

test('no flag: nothing injected', async ($, on) => {
  world(on, [])
  for (const source of SOURCES) expect(await ctx($, source)).toEqual([])
})
