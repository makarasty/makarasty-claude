import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { BEHAVIOUR, BOX, COMMAND, DEFERRED, ELSEWHERE, MESSAGE, NOT_DROPPED, OTHER_CHAT, SELF, SCREEN, asksSelf, behaviour, continueBox, continueQuestions, defers, freshLedger, holdsCommand, investigated, leftAtStop, notePassed, noteRefusal, onlyContinue, pointsAbove, reminder, screened, sendsToChat, showsScreen, staked } from './ask-guard.ts'

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
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', MAKARASTY_SCREEN: 'off', ...env }) // the screen has its own tests below
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
  await $.tool.call({ tool: 'AskUserQuestion', questions: [q('Какой вариант выше нравится больше?', 'A', 'B')] } as never)
  expect(passed).toEqual(['AskUserQuestion'])
})

test('a step in another chat is never a dialog', async ($, on) => {
  const passed = world(on)
  for (const [t, a, b] of [['Нажми карточку в чате «Relaunch». Нажал?', 'Нажал', 'Не сейчас'], ['В чате «Coordinator» на аккаунте dev ответь «да». Ответил?', 'Открой мне этот чат', 'Ответил'], ['Answer in the chat "Fleet B". Done?', 'Done', 'Not now']])
    expect(await $.tool.call({ tool: 'AskUserQuestion', questions: [q(t!, a!, b!)] } as never)).toEqual({ deny: OTHER_CHAT })
  expect(sendsToChat([{ question: 'Какую базу берём в этом чате?' }])).toBe(false)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [q('Какую базу берём в этом чате?', 'Postgres', 'SQLite')] } as never)
  expect(passed).toEqual(['AskUserQuestion'])
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

test('asking for a secret or to run something by hand is refused; a decision passes', async ($, on) => {
  const passed = world(on)
  for (const t of ['Дай пароль от базы песочницы (SQL_DB_PASS)?', 'Пришлёшь токен бота?', 'What is the API key for staging?', 'Запустишь скрипт сам и скажешь результат?', 'Can you run the migration yourself and tell me?'])
    expect(await $.tool.call({ tool: 'AskUserQuestion', questions: [q(t, 'Да', 'Нет')] } as never)).toEqual({ deny: SELF })
  for (const t of ['Пушим 3 коммита в master?', 'Какую базу берём: Postgres или SQLite?', 'Перезапустил приложение? Окно открылось?'])
    await $.tool.call({ tool: 'AskUserQuestion', questions: [q(t, 'Да', 'Нет')] } as never)
  expect(passed).toEqual(['AskUserQuestion', 'AskUserQuestion', 'AskUserQuestion'])
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

// The screen: a question with no stake reaches the person only after the asking chat checked it could not answer it itself.
const PLAIN = [q('Какую базу взять для отчётов?', 'Postgres', 'SQLite')]
const ask = ($: Engine, questions: unknown, metadata?: unknown) => $.tool.call({ tool: 'AskUserQuestion', questions, ...(metadata ? { metadata } : {}) } as never)

test('the screen: a plain question is refused once; screened (20+ chars) it passes; a short screened still does not', async ($, on) => {
  const passed = world(on, { MAKARASTY_SCREEN: 'on' })
  expect(await ask($, PLAIN)).toEqual({ deny: SCREEN })
  expect(await ask($, PLAIN, { screened: 'ok' })).toEqual({ deny: SCREEN })
  await ask($, PLAIN, { screened: 'checked CLAUDE.md, docs and ports: a choice of approach only he can make' })
  expect(passed).toEqual(['AskUserQuestion'])
})

test('the screen: a question with a stake, one from the inbox chat, and MAKARASTY_SCREEN=off pass without metadata', async ($, on) => {
  const passed = world(on, { MAKARASTY_SCREEN: 'on' })
  await ask($, [q('Запушить ветку fix-login в main?', 'Да', 'Нет')])
  await ask($, PLAIN, { source: 'inbox:x' })
  await ask($, PLAIN, { source: 'inbox' })
  expect(passed).toEqual(['AskUserQuestion', 'AskUserQuestion', 'AskUserQuestion'])
})

test('the screen: off by env', async ($, on) => {
  const passed = world(on, { MAKARASTY_SCREEN: 'off' })
  await ask($, PLAIN)
  expect(passed).toEqual(['AskUserQuestion'])
})

// Three questions that reached the owner on 2026-11-16..17 past the old screen [M76].
const SCHEDULE = [{ question: 'Пункт 3, «Schedule call». Сейчас три места спорят: меню в списке кейсов прячет пункт для Draft, Aborted и Canceled; меню на странице кейса и сервер запрещают только Draft (сервер даже проверяет тестом, что для Aborted звонок можно назначить — коммит 2026-11-05). При этом Abort и Cancel кейса сами отменяют все назначенные звонки (шаг «Cancel scheduled calls» в алгоритмах, помечен как обязательный). Как сделать одинаково везде?', header: 'Schedule call', options: [{ label: 'Запретить Draft+Aborted+Canceled (Recommended)', description: 'Сервер и страница кейса начнут отказывать так же, как меню списка. Чтобы позвонить — сначала Reactivate.' }, { label: 'Запретить только Draft', description: 'Меню списка снова покажет «Schedule call» для Aborted и Canceled.' }] }]
const TWILIO = [{ question: 'Дыра X-001: вебхуки Twilio принимают неподписанные запросы (флаг TWILIO_SIGNATURE_ENFORCE не включён, сейчас только пишется в лог). Через поддельный запрос можно звонить от имени сотрудника (телефонное мошенничество). Что делаем?', header: 'Twilio', options: [{ label: 'Включить проверку (Recommended)', description: 'Сначала я смотрю логи sandbox и prod (только чтение) — есть ли там WOULD-REJECT от настоящего Twilio.' }, { label: 'Оставить только лог', description: 'Как сейчас; дыра остаётся.' }] }]
const SM14 = [{ question: 'SM-14. Человеку скрыта колонка (например Charged у клейма), но он может фильтровать по ней в отчётах и списках и по счётчикам угадать значение. Запрещать такой фильтр?', header: 'SM-14', options: [{ label: 'Запрещать везде (Recommended)', description: 'Часть сохранённых отчётов у узких ролей перестанет работать.' }, { label: 'Только в отчётах', description: '' }, { label: 'Не запрещать', description: '' }, { label: 'Отправить разработчику', description: 'Решает он.' }] }]
const INVESTIGATED = { investigated: 'callers: list menu, case page, server, Pulse bookCall; history: git log -S 59d6879dcd 2025-04-01, e16ecd1491; usage: не посчитано, prod proxy not running' }

test('real questions: evidence words no longer wave them past; behaviour asks need an investigation, a deferred check is refused', async ($, on) => {
  expect([staked(SCHEDULE), staked(TWILIO), staked(SM14)]).toEqual([false, false, false])
  expect([behaviour(SCHEDULE), behaviour(SM14)]).toEqual([true, true])
  expect(defers(TWILIO)).toBe(true)
  const passed = world(on, { MAKARASTY_SCREEN: 'on' })
  expect(await ask($, SCHEDULE, { screened: 'checked docs and CLAUDE.md: a product call only he can make' })).toEqual({ deny: BEHAVIOUR })
  expect(await ask($, SM14)).toEqual({ deny: BEHAVIOUR })
  expect(await ask($, TWILIO, INVESTIGATED)).toEqual({ deny: DEFERRED })
  expect(await ask($, SCHEDULE, { investigated: 'looked at the code, it is a product decision for the owner to make really' })).toEqual({ deny: BEHAVIOUR })
  await ask($, SCHEDULE, INVESTIGATED)
  expect(passed).toEqual(['AskUserQuestion'])
})

test('a stake is the act the ask or a label proposes, at a word start; every question in the call must carry one', () => {
  expect(staked([q('Запушить ветку fix-login в main?', 'Да', 'Нет')])).toBe(true)
  expect(staked([q('Что убрать в корзину (вернуть можно)?', 'Все', 'Ничего')])).toBe(true)
  expect(staked([q('Флаг FORCE_RELOAD включён в конфиге. Что делаем?', 'Выключить', 'Оставить')])).toBe(false)
  expect(staked([q('Сервер проверяет это тестом — коммит 2026-11-05. Как назвать вкладку?', 'Paste', 'Output')])).toBe(false)
  expect(staked([q('Запушить?', 'Да', 'Нет'), q('Как назвать вкладку?', 'Paste', 'Output')])).toBe(false)
  expect(defers([{ question: 'Где деплоить?', options: [{ label: 'Пока не знаю', description: 'Сначала посмотрю превью, потом решим.' }] }])).toBe(false)
})

// Real refused asks from 2026-11-13..20 [M85]: a question a guard refused is asked again or said in one line, never lost.
const opts = (...labels: string[]) => labels.map((label) => ({ label, description: '' }))
const WEEKEND = [
  { question: 'Порог для кода, который угадывает смысл фраз (пример — Pulse решает, вопрос про данные клиники или про правила). Какой ставить по умолчанию?', header: 'Порог', options: opts('95% (Рекомендую)', '98%', 'Решать в каждой задаче') },
  { question: 'Сколько и каких «искателей» (агентов, которые ищут ошибки) ставить на каждый круг? Данных пока нет: все наши искатели были дорогой моделью.', header: 'Искатели', options: opts('Сначала измерить (Рекомендую)', '1 дорогой', '1 дорогой + 2 дешёвых') },
  { question: 'HTML-отчёты на рабочем столе тебе не нравятся. Что делать?', header: 'Отчёты', options: opts('Переделать концепцию (Рекомендую)', 'Только текст в чате', 'Оставить как есть') },
  { question: 'Что ещё запустить отдельными задачами (можно несколько)?', header: 'Ещё задачи', options: opts('Pulse — хабу на выходные', 'Расследовать обрыв вопросов', 'Измерить качество судей') },
]
type M = { role: string; text: string }
const transcript = (on: On) => { let msgs: M[] = [{ role: 'user', text: 'Давай обсудим, задавай вопросы' }]; on('session.messages', () => ({ value: msgs as never })); return (text: string) => { msgs = [...msgs, { role: 'assistant', text }] } }
const stopNow = ($: { classic: { Stop(e: never): Promise<{ block?: unknown }> } }, last = '', again = false) => $.classic.Stop({ stop_hook_active: again, last_assistant_message: last } as never)
const stops = (on: On) => on('classic.Stop', async () => ({}))

test('real false positives no longer refuse: "что делать", a usage figure in tokens, a chat that "сам запустил", node in prose', () => {
  expect(behaviour(WEEKEND)).toBe(false)
  expect(behaviour([q('Spotify 1.2.84 → 1.3.10: обновление сотрёт патч SpotX. Что делать?', 'Не трогать', 'Обновить')])).toBe(false)
  expect(asksSelf([q('Рутина в чатах сейчас идёт на Opus, модель тратит около 200 тыс. токенов на сводку. Переводить на Sonnet?', 'Да', 'Нет')])).toBe(false)
  expect(asksSelf([q('Хаб-чат 17.11 сам запустил около 12 чатов, почти все про тулинг. Сделать правило?', 'Да', 'Нет')])).toBe(false)
  expect(asksSelf([q('Чат написал тебе команды: положить новый тестовый ключ Stedi в секрет. Выдал права и положил новый тестовый ключ?', 'Да, сделал', 'Позже')])).toBe(false)
  expect(asksSelf([q('Добавить создание тестовых аккаунтов только на sandbox, с паролями в локальном gitignored-файле?', 'Да', 'Нет')])).toBe(false)
  expect(holdsCommand([q('Git 2.56, Node 26.13.1 и OBS 33 мешают работающим чатам: сейчас работают 12 процессов node из C:\\Program Files\\nodejs. Когда ставить?', 'Сам после перезагрузки', 'Сейчас')])).toBe(false)
  expect(holdsCommand([{ question: 'Когда ставить?', options: [{ label: 'Сам после перезагрузки', description: 'Перед запуском Claude выполнишь: winget upgrade --id Git.Git -e' }] }])).toBe(true)
  expect(asksSelf([q('Поднимешь сам (`cd frontend; npm run dev`) или мне запустить его через панель браузера?', 'Подниму', 'Запусти ты')])).toBe(true)
})

test('red team: real asks for a secret or a by-hand run still refuse in every form', () => {
  for (const t of ['Введите пароль от sandbox-базы', 'Отправь токен бота сюда', 'Можешь прислать токен бота?', 'Нужен пароль от sandbox-БД. Есть?', 'Какой пароль у песочницы?', 'Your staging API key?',
    'Введи, пожалуйста, значение переменной окружения STRIPE_SECRET_KEY', 'Скинь из .env значение STRIPE_SECRET_KEY', 'What’s the API key for staging?', 'Введи OPENAI_API_KEY', 'Пришли ключ от Stedi',
    'Запустите миграцию вручную', 'Сможешь самостоятельно выполнить миграцию?', 'Самостоятельно запусти миграцию', 'Запусти seed.mjs сам и скажи, что вышло', 'Please restart the dev server manually', 'Try running the script yourself'])
    expect([t, asksSelf([q(t, 'Да', 'Нет')])]).toEqual([t, true])
  expect(asksSelf([q('Как передать доступ к sandbox?', 'Скину пароль в чат', 'Иначе')])).toBe(true)
  for (const t of ['pip install requests flask django numpy -U', 'git commit "Исправил баг" --amend', 'Выполни «git push --force origin main». Готово?'])
    expect([t, holdsCommand([q(t, 'Да', 'Нет')])]).toEqual([t, true])
})

test('the screen takes what the tool schema allows: metadata.source "screened: ..." or "investigated: ..."', async ($, on) => {
  expect(screened({ source: 'screened: checked CLAUDE.md, ports and the answers file; his taste' })).toBe(true)
  expect(screened({ source: 'screened' })).toBe(false)
  expect(investigated({ source: 'investigated: callers: list menu, case page; history: git log -S e16ecd1491; usage: не посчитано, prod proxy down' })).toBe(true)
  const passed = world(on, { MAKARASTY_SCREEN: 'on' })
  expect(await ask($, WEEKEND)).toEqual({ deny: SCREEN })
  await ask($, WEEKEND, { source: 'screened: a plan and taste question only he answers; nothing on disk settles it' })
  expect(passed).toEqual(['AskUserQuestion'])
})

// 14 days of chats: 102 screen refusals, a main cause the first ask of a screened question lacking metadata.source.
test('the screen: a question whose text says what was checked or found passes without metadata; one that does not is refused with the field to add', async ($, on) => {
  const passed = world(on, { MAKARASTY_SCREEN: 'on' })
  const found = [q('«Microstic Lot» не нашёлся ни в одном чате: проверил транскрипты за 14 дней. О чём речь?', 'Про другой проект', 'Опечатка')]
  expect(showsScreen(found)).toBe(true)
  await ask($, found)
  await ask($, [q('Found 3 stale worktrees in the repo. Which one does the next fleet take?', 'wt-a', 'wt-b')])
  expect(passed).toEqual(['AskUserQuestion', 'AskUserQuestion'])
  expect(SCREEN).toContain('send the same call again with one added field: metadata {"source": "screened:')
  expect(await ask($, PLAIN)).toEqual({ deny: SCREEN })
  expect(await ask($, [q('Какой цвет у кнопки Save?', 'Синий', 'Зелёный'), q('Нашёл 3 варианта значка. Какой взять?', 'A', 'B')])).toEqual({ deny: SCREEN })
  expect(showsScreen([q('Не проверено, есть ли там лимит. Какой поставить?', '1', '2')])).toBe(false)
  expect(showsScreen([q('Проверю логи потом. Какой поставить?', '1', '2')])).toBe(false)
  expect(passed.length).toBe(2)
})

test('a secret named in a decision is not a request for one; a short bare ask or a give verb still is', () => {
  const no = [
    q('Причина 403: в переменных Windows задан GH_TOKEN, токен аккаунта без доступа к репозиторию. Как исправить насовсем?', 'Дать токену доступ', 'Убрать GH_TOKEN', 'Только для git'),
    q('Адрес VPS и пускает ли туда с этого компа по ключу? Адрес напиши в Other.', 'По ключу пускает', 'Только по паролю'),
    q('Токен бота попал в журнал этой сессии. Замаскировать его в переписке или оставить как есть?', 'Замаскировать', 'Оставить'),
    q('Пушить на GitHub: токен в скрипте не нужен, вход уже сохранён?', 'Да, пушить', 'Не пушить'),
    q('Перевыпустить токен?', 'Да', 'Нет'),
  ]
  for (const x of no) expect([x.question, asksSelf([x])]).toEqual([x.question, false])
  for (const x of [q('Токен бота?', 'Скину', 'Нет'), q('Пароль от базы?', 'Скину', 'Нет'), q('Как передать доступ?', 'Скину пароль в чат', 'Иначе'), q('Как передать доступ?', 'Скину api key для Stripe', 'Иначе')])
    expect([x.question, asksSelf([x])]).toEqual([x.question, true])
})

// 2026-11-13..18: the owner's rule is to ask him to start what the chat cannot start (his dev server, a window only he has).
test('a by-hand run is asked when the question says it is his own service or the chat cannot start it; a script the chat could run is still refused', () => {
  for (const x of [
    q('Pulse на твоём локальном сервере (localhost:5001, окно start-firebase-emulator.bat) отвечает 500. Лог пишется в твоё окно cmd. Как дать мне лог?', 'Перезапусти сам (рекоменд.)', 'Скопирую ошибку сам', 'Не сейчас'),
    q('Для скриншотов нужен vite на :5173. Он не запущен, а в FLEET.md он записан как твой сервис. Поднимешь сам (`cd frontend; npm run dev`) или мне запустить его через панель браузера?', 'Запусти сам', 'Подниму сам'),
    q('Для проверки глазами нужен vite на http://localhost:5173: он не запущен после перезагрузки, а запускаешь его ты. Запустишь vite?', 'Запустил vite', 'Запусти сам', 'Позже'),
    q('I cannot start the emulator from this chat. Can you run it yourself and tell me when it is up?', 'Done', 'Later'),
  ]) expect([x.question, asksSelf([x])]).toEqual([x.question, false])
  for (const x of [q('Запустишь npm test сам и скажешь результат?', 'Да', 'Нет'), q('Запусти seed.mjs сам и скажи, что вышло', 'Да', 'Нет'), q('Can you run the migration yourself and tell me?', 'Да', 'Нет'), q('Как проверить сборку?', 'Запусти сам npm test', 'Запущу я')])
    expect([x.question, asksSelf([x])]).toEqual([x.question, true])
})

// Review of the first change: a direct request for a secret's value is refused whatever its length or verb; a negated, quoted or asking marker is no check.
test('a request for a secret value is refused in any length ("можешь дать", "какой пароль у ... на ..."); decisions about a secret still pass', () => {
  for (const t of ['Можешь дать пароль от базы?', 'Можешь дать токен?', 'Сможешь выдать мне токен бота?', 'Какой пароль у пользователя postgres на staging сервере?', 'Какой токен использовать для деплоя на прод?', 'What password does the staging database use for the reports user?'])
    expect([t, asksSelf([q(t, 'Да', 'Нет')])]).toEqual([t, true])
  for (const x of [q('Дать токену доступ к репозиторию?', 'Да', 'Нет'), q('Как исправить?', 'Дать токену доступ', 'Убрать GH_TOKEN'), q('Токен бота попал в журнал этой сессии, замаскировать его в переписке сейчас?', 'Да', 'Нет'), q('Пушить без токена в скрипте, вход уже сохранён на этой машине?', 'Да', 'Нет')])
    expect([x.question, asksSelf([x])]).toEqual([x.question, false])
})

test('the screen is shown by a plain statement of a check or a found fact; a negated, quoted or asked marker shows none', () => {
  for (const t of ['Нашёл 3 варианта значка. Какой взять?', 'Я проверил docs и CLAUDE.md, ответа там нет. Какой порт взять?', '«Microstic Lot» не нашёлся ни в одном чате. О чём речь?', 'Looked at the logs: nothing there. Which port do we take?'])
    expect([t, showsScreen([q(t, 'A', 'B')])]).toEqual([t, true])
  for (const t of ['Не посмотрел конфиг. Какой порт у dev-сервера?', 'Have you checked whether the server is up?', 'Error says module not found. Install it?', 'Ты проверил логи? Какой порт взять?', 'Ошибка «found nothing to run». Какой порт взять?', "I haven't checked the config. Which port?", 'Ещё не проверил docs. Какой порт?'])
    expect([t, showsScreen([q(t, 'A', 'B')])]).toEqual([t, false])
})

test('every refusal that sends the chat off to fix or check first says the question is not dropped', () => {
  for (const m of [SCREEN, BEHAVIOUR, SELF, DEFERRED, COMMAND, ELSEWHERE]) expect(m.endsWith(NOT_DROPPED)).toBe(true)
  expect(MESSAGE.includes(NOT_DROPPED)).toBe(false)
})

const call = (id: string, text = '') => ({ role: 'assistant', text, toolUses: [{ tool_use_id: id }] })
const said = (text: string) => ({ role: 'assistant', text })
const user = (text: string) => ({ role: 'user', text })

test('ledger: what the chat wrote after the refused call in this turn, or a shorter re-ask, covers a question; the rest is sent back', () => {
  const st = freshLedger()
  noteRefusal(st, WEEKEND.map((w) => w.question), 'Not asked yet: this asks how the product or code should behave. First run ...', 't1')
  const msgs = [user('Давай обсудим'), call('t1', 'HTML-отчёты, порог, искатели: ниже вопросы.'), said('Still waiting on the fact-checker and three cheap finders.')]
  const left = leftAtStop(st, msgs)
  expect(left.map((r) => r.question)).toEqual(WEEKEND.map((w) => w.question))
  expect(reminder(left)).toContain('4 questions this turn tried to ask the person were refused')
  expect(reminder(left)).toContain('(refused: this asks how the product or code should behave.)')
  expect(st.refused).toEqual([])
  const push = 'Пуш Max отклонён pre-push хуком (ничего не ушло). Причина: Rost в origin/main добавил проверку «type-debt ratchet» со своим базовым счётом, а в коде Max она насчитала 68 новых «дыр» типизации: почти все — `!` в тестах. Что делаем?'
  noteRefusal(st, [push], 'Not asked: the question or an option holds a command.', 't2')
  notePassed(st, ['Пуш Max остановила проверка типового долга из ветки Rost: в коде Max 68 новых «дыр» (в основном `!` в тестах отчётов). Что делаем?'])
  expect(st.refused).toEqual([])
  noteRefusal(st, ['Где снят первый скрин с тёмным углом и скруглённой границей?'], 'Screen this question first.', 't3')
  expect(leftAtStop(st, [user('x'), call('t3'), said('Не нашёл сам.\nВопрос: где снят первый скрин с тёмным углом и скруглённой границей?')])).toEqual([])
})

test('ledger: narration, a status recap or a short unrelated question does not count as asking', () => {
  const st = freshLedger()
  const vite = 'Для скриншотов страницы Console › External systems нужен vite на :5173. Сейчас он не запущен. Поднимаю его через панель браузера?'
  noteRefusal(st, [vite], 'Screen this question first.', 'v1')
  notePassed(st, ['Какой вариант?'], 'Делаю скриншоты страницы Console External systems, vite на :5173 не запущен.')
  expect(leftAtStop(st, [user('x'), call('v1'), said('Делаю скриншоты страницы Console External systems, vite на :5173 не запущен.')]).length).toBe(1)
  noteRefusal(st, ['Удалить ветку cleanup-comments после мержа?'], 'Not asked: x.', 'd1')
  notePassed(st, [], 'Ветку cleanup-comments доделал, тесты зелёные.')
  expect(st.refused.length).toBe(1)
  notePassed(st, ['Мержить PR 41 в main?'])
  noteRefusal(st, ['Мержить PR 42 в main?'], 'Not asked: x.', 'm1')
  notePassed(st, ['Мержить PR 41 в main?'])
  expect(st.refused.map((r) => r.question)).toEqual(['Удалить ветку cleanup-comments после мержа?', 'Мержить PR 42 в main?'])
})

test('ledger: one dialog\'s questions never replace each other, a prefix is not a retry, a re-worded retry is', () => {
  const st = freshLedger()
  noteRefusal(st, ['Какую базу взять для отчётов: Postgres или SQLite?', 'Какую базу взять для логов?', 'Это баг?'], 'Not asked: x.', 'a')
  expect(st.refused.length).toBe(3)
  noteRefusal(st, ['5056_life_lines-app · Флит отчётов: удалять файлы Classic?'], 'Not asked: x.', 'b')
  noteRefusal(st, ['5056_life_lines-app · Флит отчётов: мержить ветку?'], 'Not asked: x.', 'c')
  expect(st.refused.length).toBe(5)
  const st2 = freshLedger()
  noteRefusal(st2, ['Admin может захватить чужой аккаунт: меняет email пользователя на свой ящик и шлёт туда reset пароля. Как должно работать?'], 'Not asked: x.', 'p')
  noteRefusal(st2, ['Admin может захватить чужой аккаунт: сам меняет email пользователя на свой ящик и шлёт туда reset пароля. Как должно работать?'], 'Not asked yet: y.', 'q')
  expect(st2.refused.map((r) => r.why)).toEqual(['y.'])
})

test('ledger: a refusal from an earlier prompt (aborted, failed) or another conversation (/clear) is not sent back', () => {
  const st = freshLedger()
  noteRefusal(st, ['Какую базу взять для отчётов флита, Postgres или SQLite?'], 'Screen this question first.', 'old', 3, 's1')
  expect(leftAtStop(st, [user('первый'), call('old'), user('новая задача'), said('Готово.')], '', 4, 's1')).toEqual([])
  noteRefusal(st, ['Какую базу взять для отчётов флита, Postgres или SQLite?'], 'Screen this question first.', 'old', 3, 's1')
  expect(leftAtStop(st, [said('Готово.')], '', 3, 's2')).toEqual([])
  noteRefusal(st, ['Какую базу взять для отчётов флита, Postgres или SQLite?'], 'Screen this question first.', 'old', 3, 's1')
  expect(leftAtStop(st, [user('Stop hook feedback: Not finished'), said('Готово.')], '', 3, 's1').length).toBe(1)
})

test('hook: a refused dialog the chat never asks again comes back at the Stop; a passing re-ask or a continue-only ask does not', async ($, on) => {
  world(on, { MAKARASTY_SCREEN: 'on' })
  stops(on)
  const add = transcript(on)
  const vite = [q('Для скриншотов страницы Console › External systems нужен vite на :5173. Сейчас он не запущен. Поднимаю его через панель браузера?', 'Да', 'Нет')]
  expect(await ask($, vite)).toEqual({ deny: SCREEN })
  add('Жду, пока эмулятор начнёт слушать :5001, после этого вход и скриншоты.')
  const b = String((await stopNow($, 'Жду, пока эмулятор начнёт слушать :5001.')).block)
  expect(b).toContain('a question this turn tried to ask the person was refused')
  expect(b).toContain('нужен vite на :5173')
  expect(await ask($, [q('Порт :5173 занят другим чатом. Какой порт взять для второго vite этого чата?', '5174', '5180')])).toEqual({ deny: SCREEN })
  expect((await stopNow($, 'Жду.', true)).block).toBeUndefined()
  expect((await stopNow($)).block).toBeUndefined()
  const base = [q('Какую базу взять для отчётов флита, Postgres или SQLite?', 'Postgres', 'SQLite')]
  expect(await ask($, base)).toEqual({ deny: SCREEN })
  await ask($, base, { source: 'screened: a choice of approach; CLAUDE.md and docs do not settle it' })
  expect(await ask($, [q('Продолжать?', 'Да', 'Нет')])).toEqual({ deny: MESSAGE })
  expect(await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask: 'Продолжить?', actions: [{ label: 'Да' }, { label: 'Нет' }] } as never)).toEqual({ deny: BOX })
  expect((await stopNow($, 'Готово.')).block).toBeUndefined()
})

test('hook: MAKARASTY_ASK_GUARD=off refuses nothing and sends nothing back at the Stop', async ($, on) => {
  const passed = world(on, { MAKARASTY_SCREEN: 'on', MAKARASTY_ASK_GUARD: 'off' })
  stops(on)
  transcript(on)
  await ask($, [q('Какой цвет у кнопки Save на странице отчётов оставить?', 'Синий', 'Зелёный')])
  expect(passed).toEqual(['AskUserQuestion'])
  expect((await stopNow($)).block).toBeUndefined()
})
