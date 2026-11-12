import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { BOX, COMMAND, ELSEWHERE, MESSAGE, continueBox, continueQuestions, holdsCommand, onlyContinue, pointsAbove } from './ask-guard.ts'

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

test('a question pointing at a link "above" without naming the place is refused; one that names it passes', async ($, on) => {
  const passed = world(on)
  for (const t of ['В чате по ссылке выше напиши «запусти тест». Написал?', 'Open the chat linked above and type go. Done?', 'Нажми в окне выше Allow. Готово?'])
    expect(await $.tool.call({ tool: 'AskUserQuestion', questions: [q(t, 'Написал', 'Не сейчас')] } as never)).toEqual({ deny: ELSEWHERE })
  expect(pointsAbove([{ question: 'В чате «Coordinator» (аккаунт main, [чат](#local_339c936f-797e)) по ссылке выше напиши go. Написал?' }])).toBe(false)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [q('В чате «Coordinator» на аккаунте main напиши `go`. Написал?', 'Написал', 'Не сейчас')] } as never)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [q('Какой вариант выше нравится больше?', 'A', 'B')] } as never)
  expect(passed).toEqual(['AskUserQuestion', 'AskUserQuestion'])
})

test('a command in a question or an option is refused; a short title or a bare tool name passes', async ($, on) => {
  const passed = world(on)
  for (const t of ['Запусти `cd C:\\work\\app && bun run dev`. Запустил?', 'Run npm run build -- --prod and tell me. Done?', 'Выполни git push --force origin main. Готово?', 'Запусти node scripts/fleet.mjs check. Что вышло?'])
    expect(await $.tool.call({ tool: 'AskUserQuestion', questions: [q(t, 'Запустил', 'Не сейчас')] } as never)).toEqual({ deny: COMMAND })
  expect(holdsCommand([{ question: 'Запустил?', options: [{ label: 'Да', description: 'cd C:\\work; bun run dev' }] }])).toBe(true)
  for (const t of ['Запустил? Что вышло?', 'Пушим в git?', 'Коммитим 3 файла (git, без пуша)?', 'Какой пакетный менеджер: npm или bun?'])
    await $.tool.call({ tool: 'AskUserQuestion', questions: [q(t, 'Да', 'Нет')] } as never)
  expect(passed).toEqual(['AskUserQuestion', 'AskUserQuestion', 'AskUserQuestion', 'AskUserQuestion'])
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

// 2026-11-12: real decisions that ended in "Continue?" were refused. Each row is one case from the operator's list.
test('a stake worded in the statement before "Continue?" is a real decision', () => {
  for (const [text, opts] of [
    ['Удалю 4 папки с кэшем (1.2 ГБ). Продолжить?', ['Да', 'Нет']],
    ['I\'ll remove the 3 stale worktrees. Continue?', ['Yes', 'No']],
    ['Found 3 stale worktrees (2.1 GB). Keep them?', ['Yes', 'No']],
    ['Proceed with the plan?', ['Yes', 'No']],
    ['Tests failed: 3 of 40. Continue?', ['Yes, continue', 'No, stop']],
    ['Открыл окно входа в браузере, войди под своим аккаунтом. Продолжаем?', ['Да', 'Нет']],
  ] as [string, string[]][]) expect([text, onlyContinue(text, opts)]).toEqual([text, false])
})

test('a stake in an option description, the header or the wrap_up recap is a real decision', () => {
  const asked = { question: 'Продолжить?', header: 'h', multiSelect: false, options: [{ label: 'Да', description: 'Удалит 4 папки и запушит ветку' }, { label: 'Нет' }] }
  expect(continueQuestions([asked])).toEqual([])
  expect(continueQuestions([{ ...asked, header: 'Deploy', options: [{ label: 'Да' }, { label: 'Нет' }] }])).toEqual([])
  expect(continueQuestions([{ ...asked, options: [{ label: 'Да', description: 'Идём дальше' }, { label: 'Нет' }] }])).toEqual([1])
  expect(continueBox('Proceed?', [{ label: 'Yes' }, { label: 'Not now' }], 'Ready to push 3 commits to origin/master')).toBe(false)
  expect(continueBox('Proceed?', [{ label: 'Yes' }, { label: 'Not now' }], 'Done 3 of 5')).toBe(true)
})

test('hook: a wrap_up recap with a stake lets the ask through', async ($, on) => {
  const passed = world(on)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Ready to push 3 commits to origin/master', ask: 'Proceed?', actions: [{ label: 'Yes' }, { label: 'Not now' }] } as never)
  expect(passed).toEqual(['mcp__ccd_turn__wrap_up'])
})

test('a bare go-on question is still refused', () => {
  for (const [text, opts] of [
    ['Продолжать с остальными задачами?', ['Да', 'Нет']],
    ['Should I proceed?', ['Yes', 'No']],
    ['Довести до конца?', ['Да, доводи (Recommended)', 'Нет, стоп']],
    ['Continue with the remaining tasks?', ['Yes', 'Not now']],
    ['Keep going?', ['Yes', 'No']],
    ['Keep on going?', ['Keep going', 'No']],
  ] as [string, string[]][]) expect([text, onlyContinue(text, opts)]).toEqual([text, true])
})

// Review round 2: common words that contain a stake stem, and recaps that report status, stay bare continues.
test('words that only contain a stake stem do not make a continue a decision', () => {
  for (const [text, opts] of [
    ['Сделал выпадающий список. Продолжаем?', ['Да', 'Нет']],
    ['Добавил сотрудников. Продолжить?', ['Да', 'Нет']],
    ['Сборка удалась. Продолжить?', ['Да', 'Нет']],
    ['Finished the design in Figma. Continue?', ['Yes', 'No']],
    ['Added the catalog in the sidebar. Continue?', ['Yes', 'No']],
    ['All 40 tests pass, 0 failed, no errors. Continue?', ['Yes', 'No']],
    ['Продолжить по плану?', ['Да', 'Нет']],
  ] as [string, string[]][]) expect([text, onlyContinue(text, opts)]).toEqual([text, true])
})

test('the stems still catch the real word: sign in, log in, стереть, удалить, упало', () => {
  for (const [text, opts] of [
    ['Please sign in to the site. Continue?', ['Yes', 'No']],
    ['Нужно стереть логи. Продолжить?', ['Да', 'Нет']],
    ['Удалить кэш. Продолжить?', ['Да', 'Нет']],
    ['Сборка упала. Продолжить?', ['Да', 'Нет']],
    ['2 errors in the build. Continue?', ['Yes', 'No']],
    ['Нажми «Разрешить» в окне. Продолжаем?', ['Да', 'Нет']],
  ] as [string, string[]][]) expect([text, onlyContinue(text, opts)]).toEqual([text, false])
})

test('a recap, header or description that reports status does not hide a bare continue', () => {
  const yn = [{ label: 'Да' }, { label: 'Нет' }]
  expect(continueBox('Продолжить?', yn, 'Сделал 3 волны из 5, ничего не закоммичено.')).toBe(true)
  expect(continueBox('Продолжить?', yn, 'Fixed 12 of 20 findings; nothing committed yet.')).toBe(true)
  expect(continueBox('Продолжить?', yn, 'Тесты: 3 failed, 1 error. Исправил остальное.')).toBe(true)
  const described = (description: string) => [{ question: 'Продолжить?', header: 'h', multiSelect: false, options: [{ label: 'Да', description }, { label: 'Нет' }] }]
  expect(continueQuestions(described('Продолжу исправлять оставшиеся баги'))).toEqual([1])
  expect(continueQuestions(described('Запушу ветку'))).toEqual([])
})

// Review round 3: cleaning, reset, rollback and deploy verbs in the first person are real decisions.
test('a reset, clean, rollback or deploy announced before "Continue?" is a real decision', () => {
  for (const [text, opts] of [
    ['Сброшу локальные изменения. Продолжить?', ['Да', 'Нет']],
    ['Очищу корзину (2 ГБ). Продолжить?', ['Да', 'Нет']],
    ['Почищу 4 ветки. Продолжить?', ['Да', 'Нет']],
    ['Подчищу старые логи. Продолжить?', ['Да', 'Нет']],
    ['Деплою на стейджинг. Продолжить?', ['Да', 'Нет']],
    ['Откачу миграцию. Продолжить?', ['Да', 'Нет']],
    ['I\'ll revert the last 2 commits. Continue?', ['Yes', 'No']],
    ['Roll back the release?', ['Yes', 'No']],
    ['Rollback the deploy. Continue?', ['Yes', 'No']],
  ] as [string, string[]][]) expect([text, onlyContinue(text, opts)]).toEqual([text, false])
  const asked = (description: string) => [{ question: 'Продолжить?', header: 'h', multiSelect: false, options: [{ label: 'Да', description }, { label: 'Нет' }] }]
  expect(continueQuestions(asked('Откачу миграцию'))).toEqual([])
  expect(continueBox('Продолжить?', [{ label: 'Да' }, { label: 'Нет' }], 'Will revert the last 2 commits')).toBe(false)
})
