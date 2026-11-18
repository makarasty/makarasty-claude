import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { MESSAGE, RESEARCH, claimLines, freshResearch, noteTool, researchRefusal } from './verify-guard.ts'

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

// 11-18: research replies. The must-catch case is c46c3894's first report (LifeLines, 11-17), trimmed: nine of its
// claims were wrong, among them "такого хука нет" (verify-guard existed) and "105 из 195 коммитов" (32 of 106).
const C46 = `Готово. Отчёт: \`C:\Users\mky\Desktop\Тренды ИИ-разработки и мой флоу.html\`
**Что сделал:** 3 агента собрали сетап и тренды (со ссылками). Fable и Opus ответили на один и тот же промпт и совпали в 10 пунктах из 13.
1. **«Готово» без проверки.** Правило уже есть в CLAUDE.md, а «перепроверь» всё равно было в 120+ чатах. Тут нужен Stop-хук: «готово» не проходит без запущенной проверки. Такого хука нет, я смотрел \`routes.ts\`.
2. **Инбокс съедает тулкит.** 105 из 195 коммитов с 15.10, релизы 1–2 в час. Стоит поставить его на паузу и попробовать встроенный \`claude agents\`.
3. **Хаб-чат работает сам.** Лучше, чтобы он только раздавал задачи. У тебя 0 из 511 коммитов с TASK, у Роста 216 из 727.
4. **Лимит.** На этой неделе не хватает: 51% потрачено за 31% недели.
**Не менять:** охранные хуки, повторное ревью (41% находок), ponytail, параллельные чаты.
Не проверял: работает ли agent view с чатами desktop на Windows.`
const agent = (description: string, subagent_type = 'general-purpose') => ({ tool: 'Agent', description, subagent_type, prompt: 'Review the setup and report numbers.' }) as never
const said = (on: On, text: string) => on('session.messages', () => ({ value: [{ role: 'user' as const, text: 'Ресерч трендов', toolUses: [] }, { role: 'assistant' as const, text, toolUses: [] }] }))
const stop = ($: { classic: { Stop(e: never): Promise<{ block?: unknown }> } }) => $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Окно с вопросами не открылось.' } as never)

test('claim lines: numbers and verdicts with no source on the line; a caveat, a source, a test result or a version is none', () => {
  expect(claimLines(C46)).toHaveLength(5)
  for (const none of ['Не проверено: 51% потрачено за 31% недели.', 'Тесты: 773 из 773 проходят.', 'Gate reads 3 of 6.', 'Node 26.12.1 стоит.',
    '28 of 54 tasks are done.', 'По замеру [M75] снимок срабатывает на 34.7% вызовов.', 'Сверил сам: 32 из 106 коммитов.', 'Готово, закоммитил.'])
    expect([none, claimLines(none)]).toEqual([none, []])
  expect(claimLines('Хука такого нет.\nНе существует файла commit.md.\nПо данным опроса, так делают все.')).toHaveLength(3)
})

test('state: three hand-backs need a red team or a verifier; one or two are covered by an own read after them; a refusal is once', () => {
  const st = freshResearch()
  for (let i = 0; i < 3; i++) noteTool(st, 'Agent', { description: 'Research AI coding tools trends' })
  noteTool(st, 'Read', {}); noteTool(st, 'Grep', {})
  expect(researchRefusal(C46, st)).toHaveLength(5)
  expect(researchRefusal(C46, st)).toEqual([]) // the second ending passes, and clears what it was about
  expect(researchRefusal(C46, st)).toEqual([])
  noteTool(st, 'Agent', { description: 'Inventory current setup' }); noteTool(st, 'Bash', { command: 'git log --oneline | wc -l' })
  expect(researchRefusal(C46, st)).toEqual([])
  for (let i = 0; i < 3; i++) noteTool(st, 'Agent', { description: 'Fable consult: workflow verdict' })
  noteTool(st, 'Skill', { skill: 'makarasty-tools:redteam' })
  expect(researchRefusal(C46, st)).toEqual([])
  for (let i = 0; i < 3; i++) noteTool(st, 'Agent', { description: `Research part ${i}` })
  noteTool(st, 'Agent', { description: 'Red team: recount local facts', subagent_type: 'Explore' })
  expect(researchRefusal(C46, st)).toEqual([])
  for (let i = 0; i < 3; i++) noteTool(st, 'Agent', { description: `Fix ${i}`, subagent_type: 'makarasty:fleet-coder' })
  expect(researchRefusal(C46, st)).toEqual([]) // coders hand back changes, not findings
  expect(researchRefusal(C46, freshResearch())).toEqual([]) // no subagent behind the reply
})

test('Stop: the c46c3894 report is refused once with its lines, read from the whole turn; the second Stop ends the turn', async ($, on) => {
  for (const ev of ['Stop', 'SubagentStop'] as const) on(`classic.${ev}`, async () => ({}))
  world(on)
  said(on, C46)
  for (const d of ['Inventory current Claude setup', 'Research AI coding tools trends', 'Research AI dev approaches trends']) await $.tool.call(agent(d))
  await $.tool.call({ tool: 'Grep', pattern: 'Stop' } as never)
  const b = String((await stop($)).block)
  expect(b).toContain(RESEARCH)
  expect(b).toContain('105 из 195')
  expect((await stop($)).block).toBeUndefined()
})

test('Stop: no subagent, a red team after the hand-backs, or MAKARASTY_VERIFY_GUARD=off ends the turn', async ($, on) => {
  for (const ev of ['Stop', 'SubagentStop'] as const) on(`classic.${ev}`, async () => ({}))
  world(on, { MAKARASTY_VERIFY_GUARD: 'off' })
  said(on, C46)
  expect((await stop($)).block).toBeUndefined()
  for (let i = 0; i < 3; i++) await $.tool.call(agent(`Research ${i}`))
  expect((await stop($)).block).toBeUndefined()
})
