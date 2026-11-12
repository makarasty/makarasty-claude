import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { BOX, MESSAGE, continueBox, continueQuestions, onlyContinue } from './ask-guard.ts'

const q = (question: string, ...labels: string[]) => ({ question, header: 'h', multiSelect: false, options: labels.map((label) => ({ label, description: '' })) })

test('a question that only asks whether to go on is refused, in Russian and English', () => {
  for (const [text, opts] of [
    ['Продолжать?', ['Да', 'Нет']],
    ['Довести до конца оставшиеся 3 пункта?', ['Да, доводи (Recommended)', 'Стоп']],
    ['Доделать остальное?', ['Да', 'Потом']],
    ['Продолжаю со следующей волной?', ['Продолжай', 'Пауза']],
    ['Continue with the remaining tasks?', ['Yes, continue', 'No, stop here']],
    ['Should I keep going?', ['Keep going', 'Not now']],
    ['Finish the rest?', ['Yes (Recommended)', 'Later']],
  ] as [string, string[]][]) expect([text, onlyContinue(text, opts)]).toEqual([text, true])
})

test('a real choice, or a step that stays the person’s, passes', () => {
  for (const [text, opts] of [
    ['Продолжить с Postgres или SQLite?', ['Postgres', 'SQLite']],
    ['Continue with approach A or B?', ['A: patch the parser', 'B: rewrite it']],
    ['Продолжить и запушить?', ['Да', 'Нет']],
    ['Continue and merge into master?', ['Yes', 'No']],
    ['Продолжить удаление 4 папок?', ['Да', 'Нет']],
    ['Продолжить в новом чате?', ['Да', 'Нет, здесь']],
    ['Continue in the cloud?', ['Yes', 'No']],
    ['Какую базу взять?', ['Да', 'Нет']],
    ['Continue?', ['Yes', 'Delete the branch first']],
  ] as [string, string[]][]) expect([text, onlyContinue(text, opts)]).toEqual([text, false])
})

test('the numbers of the continue-only questions in a dialog', () => {
  expect(continueQuestions([q('Какую базу взять?', 'Postgres', 'SQLite'), q('Продолжать дальше?', 'Да', 'Нет')])).toEqual([2])
  expect(continueQuestions([q('Какую базу взять?', 'Postgres', 'SQLite')])).toEqual([])
})

test('the end-of-turn box: reply buttons only; an app action is a real step', () => {
  expect(continueBox('Продолжить?', [{ label: 'Да' }, { label: 'Нет' }])).toBe(true)
  expect(continueBox('Довести до конца?', [])).toBe(true)
  expect(continueBox('Continue?', [{ action: 'commit' }])).toBe(false)
  expect(continueBox('Which fix first?', [{ label: 'The parser' }, { label: 'The cache' }])).toBe(false)
  expect(continueBox('', [])).toBe(false)
})

function world(on: On, env: Record<string, string> = {}) {
  const passed: string[] = []
  on('tool.call', async (_$, e) => { passed.push(e.tool); return { result: 'ok' } })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', ...env })
  // Every other hook of the plugin runs too: no inbox, no state on disk, one session.
  mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  return passed
}

test('hook: a continue-only dialog is refused; a mixed one names the question to drop; others pass', async ($, on) => {
  const passed = world(on)
  expect(await $.tool.call({ tool: 'AskUserQuestion', questions: [q('Продолжать?', 'Да', 'Нет')] } as never)).toEqual({ deny: MESSAGE })
  const mixed = await $.tool.call({ tool: 'AskUserQuestion', questions: [q('Какую базу?', 'Postgres', 'SQLite'), q('Продолжать?', 'Да', 'Нет')] } as never)
  expect(mixed).toEqual({ deny: `${MESSAGE} Ask the other questions again without question 2.` })
  await $.tool.call({ tool: 'AskUserQuestion', questions: [q('Какую базу?', 'Postgres', 'SQLite')] } as never)
  expect(passed).toEqual(['AskUserQuestion'])
})

test('hook: wrap_up with a continue-only ask is refused with the re-call hint', async ($, on) => {
  world(on)
  expect(await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask: 'Продолжить?', actions: [{ label: 'Да' }, { label: 'Нет' }] } as never)).toEqual({ deny: BOX })
})

test('hook: MAKARASTY_ASK_GUARD=off', async ($, on) => {
  const passed = world(on, { MAKARASTY_ASK_GUARD: 'off' })
  await $.tool.call({ tool: 'AskUserQuestion', questions: [q('Продолжать?', 'Да', 'Нет')] } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask: 'Продолжить?' } as never)
  expect(passed).toEqual(['AskUserQuestion', 'mcp__ccd_turn__wrap_up'])
})

// The red team's rows (2026-11-12): real decisions worded as "continue?" with yes/no, and pure go-on asks it missed.
test('red team: a go-on verb with an object, a stake or a richer option is a real decision', () => {
  for (const [text, opts] of [
    ['Продолжить с миграцией схемы БД? Откатить будет нельзя.', ['Да', 'Нет']],
    ['Proceed with dropping the users table?', ['Yes', 'No']],
    ['Next step: run rm -rf node_modules and reinstall?', ['Yes', 'No']],
    ['Нашёл баг в auth вне задачи. Продолжить с его исправлением?', ['Да', 'Нет']],
    ['Found an unrelated flaky test. Continue and also fix it properly?', ['Yes', 'No']],
    ['Продолжить? Это потратит ещё около $40 API-кредитов.', ['Да', 'Нет']],
    ['Продолжить с 8 воркерами вместо 4?', ['Да', 'Нет']],
    ['Continue with the rest of the migrations against the prod database?', ['Yes', 'No']],
    ['Proceed with sending the email to the client?', ['Yes', 'No']],
    ['Continue and force-reset the branch to origin/master?', ['Yes', 'No']],
    ['Продолжить и убить процесс на порту 3000?', ['Да', 'Нет']],
    ['Продолжить после перезагрузки компьютера?', ['Да', 'Нет']],
    ['Продолжить и закоммитить чужие файлы?', ['Да', 'Нет']],
    ['Go on and install the package globally?', ['Yes', 'No']],
    ['Продолжить?', ['Да', 'Да, и перезапиши конфиг', 'Нет']],
    ['Продолжить?', ['Да, 4 воркера', 'Да, 8 воркеров', 'Нет']],
  ] as [string, string[]][]) expect([text, onlyContinue(text, opts)]).toEqual([text, false])
})

test('red team: pure go-on asks with "удалось", emoji labels or resume words are caught (a file name in the question is an object: it passes)', () => {
  for (const [text, opts] of [
    ['Удалось сделать 5 из 8. Продолжать дальше?', ['✅ Да', '⏸ Нет']],
    ['Want me to go ahead with the remaining items?', ['Yes', 'No']],
    ['Возобновить работу?', ['Да', 'Нет']],
    ['Приступить к остальным пунктам?', ['Да', 'Позже']],
  ] as [string, string[]][]) expect([text, onlyContinue(text, opts)]).toEqual([text, true])
})

test('red team: odd inputs pass instead of throwing, and a long question is cheap', () => {
  expect(onlyContinue(undefined as never, ['Да'])).toBe(false)
  expect(onlyContinue('Продолжить?', undefined as never)).toBe(false)
  expect(onlyContinue('Продолжить?', [1, null] as never)).toBe(false)
  expect(continueQuestions(undefined as never)).toEqual([])
  expect(continueQuestions([null] as never)).toEqual([])
  expect(continueBox(undefined as never, [])).toBe(false)
  expect(continueBox('Продолжить?', null as never)).toBe(false)
  const t = Date.now()
  onlyContinue('a'.repeat(200000), ['Yes', 'No']); onlyContinue(`${'a. '.repeat(1300)}Продолжить?`, ['Да', 'Нет'])
  expect(Date.now() - t).toBeLessThan(200)
})

test('review rows: a fix of findings, substrings of go-on words, a "No, <other>" option, a version number', () => {
  for (const [text, opts] of [
    ['Proceed with fixing the 3 findings?', ['Yes, fix them', 'Not now']],
    ['Исправить найденные баги? Продолжаю?', ['Да', 'Нет']],
    ['Discontinue support for Node 18?', ['Yes', 'No']],
    ['Put the logo on the left?', ['Yes', 'No']],
    ['Should I use the REST API here?', ['Yes', 'No']],
    ['Сдвинуть кнопку дальше от края?', ['Да', 'Нет']],
    ['Go on with Postgres?', ['Yes', 'No, use SQLite']],
    ['Done 3 of 5. Continue with v2.1?', ['Yes', 'No']],
    ['Продолжить на проде?', ['Да', 'Нет']],
  ] as [string, string[]][]) expect([text, onlyContinue(text, opts)]).toEqual([text, false])
})
