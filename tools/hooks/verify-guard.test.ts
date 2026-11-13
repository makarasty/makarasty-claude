import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { MESSAGE } from './verify-guard.ts'

function world(on: On, env: Record<string, string> = {}) {
  const ran: string[] = []
  on('tool.call', async (_$, e) => { ran.push(e.tool); return { result: 'ok' } })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', MAKARASTY_SCREEN: 'off', ...env })
  mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  return ran
}
const edit = (file_path: string) => ({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' }) as never
const bash = (command: string) => ({ tool: 'Bash', command }) as never
const wrap = (recap: string) => ({ tool: 'mcp__ccd_turn__wrap_up', recap }) as never

test('code edited, nothing run, "fixed": refused once, then the second call passes', async ($, on) => {
  const ran = world(on)
  await $.tool.call(edit('/work/src/app.ts'))
  expect(await $.tool.call(wrap('Исправил баг в app.ts, всё работает.'))).toEqual({ deny: MESSAGE })
  await $.tool.call(wrap('Исправил баг в app.ts, всё работает.'))
  expect(ran).toEqual(['Edit', 'mcp__ccd_turn__wrap_up'])
})

test('a check after the last edit, a recap that says what is not checked, or a docs-only edit passes', async ($, on) => {
  const ran = world(on)
  await $.tool.call(edit('/work/src/app.ts'))
  await $.tool.call(bash('npx vitest run src/app.test.ts'))
  await $.tool.call(wrap('Fixed; 3 tests pass.'))
  await $.tool.call(edit('/work/src/app.ts'))
  await $.tool.call(wrap('Исправил, в браузере не проверял.'))
  await $.tool.call(edit('/work/README.md'))
  await $.tool.call(wrap('Готово.'))
  expect(ran.filter((t) => t === 'mcp__ccd_turn__wrap_up').length).toBe(3)
})

test('a check before the last edit does not cover it; git status is no check', async ($, on) => {
  world(on)
  await $.tool.call(edit('/work/a.ts'))
  await $.tool.call(bash('npm test'))
  await $.tool.call(edit('/work/a.ts'))
  await $.tool.call(bash('git status'))
  expect(await $.tool.call(wrap('Done, it works.'))).toEqual({ deny: MESSAGE })
})

test('a recap that claims nothing passes; no edit passes; MAKARASTY_VERIFY_GUARD=off passes', async ($, on) => {
  const ran = world(on, { MAKARASTY_VERIFY_GUARD: 'off' })
  await $.tool.call(edit('/work/a.ts'))
  await $.tool.call(wrap('Done.'))
  expect(ran).toEqual(['Edit', 'mcp__ccd_turn__wrap_up'])
})

test('a recap that says it is not done, or admits what was not run, passes', async ($, on) => {
  const ran = world(on)
  for (const recap of ['Не готово: тесты падают.', 'Ещё не работает, причина в X.', 'Fixed X; no tests were run.', 'Исправил, тесты не прогонял.', "Done, but I haven't run it."]) {
    await $.tool.call(edit('/work/a.ts'))
    await $.tool.call(wrap(recap))
  }
  expect(ran.filter((t) => t === 'mcp__ccd_turn__wrap_up').length).toBe(5)
})

test('real checks count: Pester, py, a .ps1, a subagent, a skill; an Explore search, git commit "fix test" and cat do not', async ($, on) => {
  const ran = world(on)
  for (const c of ['Invoke-Pester tests', 'py -3 check.py', 'pwsh -File .\\check.ps1', 'bun test']) {
    await $.tool.call(edit('/work/a.ts')); await $.tool.call(bash(c)); await $.tool.call(wrap('Fixed.'))
  }
  await $.tool.call(edit('/work/a.ts')); await $.tool.call({ tool: 'Agent', subagent_type: 'makarasty:fleet-coder', prompt: 'run tests' } as never); await $.tool.call(wrap('Fixed.'))
  expect(ran.filter((t) => t === 'mcp__ccd_turn__wrap_up').length).toBe(5)
  for (const step of [bash('git commit -m "fix test"'), bash('cat tests/a.ts'), bash('sed -n 1,40p src/a.ts'), bash('Get-ChildItem tests'), { tool: 'Agent', subagent_type: 'Explore', prompt: 'find' } as never]) {
    await $.tool.call(edit('/work/a.ts')); await $.tool.call(step)
    expect(await $.tool.call(wrap('Fixed.'))).toEqual({ deny: MESSAGE })
    await $.tool.call(wrap('Fixed.')) // the second call passes
  }
})

test('an edit by shell (sed -i, sg -U, Set-Content) counts as an edit; scratch files do not', async ($, on) => {
  world(on)
  await $.tool.call(bash("sg run -p 'a' -r 'b' -U src"))
  expect(await $.tool.call(wrap('Готово.'))).toEqual({ deny: MESSAGE })
  await $.tool.call(wrap('Готово.'))
  await $.tool.call(edit('C:\\Users\\x\\AppData\\Local\\Temp\\claude\\s\\scratchpad\\page.html'))
  expect(await $.tool.call(wrap('Опубликовал, готово.'))).not.toEqual({ deny: MESSAGE })
})

test('no edit, or a status recap with no claim, passes', async ($, on) => {
  const ran = world(on)
  await $.tool.call(wrap('Готово: ответил на вопрос.'))
  await $.tool.call(edit('/work/a.ts'))
  await $.tool.call(wrap('Начал правку a.ts, осталось два места.'))
  expect(ran).toEqual(['mcp__ccd_turn__wrap_up', 'Edit', 'mcp__ccd_turn__wrap_up'])
})
