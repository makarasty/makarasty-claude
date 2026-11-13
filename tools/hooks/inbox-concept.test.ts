import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { namesSource, renderReports, sourceTag, undeliverable } from '../skills/inbox/core.mjs'
import { STARTED_BRIEF } from './inbox.ts'
declare const setTimeout: (f: (v?: unknown) => void, ms: number) => unknown // the test runtime has it

// The inbox concept the owner agreed on 2026-11-13: questions name their chat, nothing goes into a chat that no longer
// waits, the inbox never writes into a chat on its own, mute is silence, a started chat ends with one summary, no duplicates.

const R = '/cfg/makarasty/inbox'
const H = 3600e3
function world(on: On, o: { self?: string; session?: string; now?: number; failSubmits?: number; names?: Record<string, string> } = {}) {
  const disk = new Map<string, string>([['/cfg/makarasty/inbox.on', 'x']])
  if (o.self) disk.set(`${R}/self`, o.self)
  const plain = (p: string): string => p.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_HOST_SESSION_ID: 'local_aaaa', CLAUDE_CODE_ACCOUNT_UUID: 'acc1', MAKARASTY_SCREEN: 'off' })
  const clock = mock.clock(on, { now: o.now ?? 100 * H })
  on('session.id', () => ({ value: o.session ?? 'chatA' }))
  on('session.cwd', () => ({ value: 'C:/work/reports-app' }))
  on('session.messages', () => ({ value: [{ role: 'user' as const, text: 'Сделай выгрузку отчётов', toolUses: [] }] }))
  on('fs.exists', (_$, e) => ({ value: disk.has(plain(e.path)) }))
  on('fs.read', (_$, e) => (disk.has(plain(e.path)) ? { value: disk.get(plain(e.path))! } : { deny: 'ENOENT' }))
  on('fs.write', (_$, e) => { disk.set(plain(e.path), e.text); return { value: undefined } })
  on('fs.list', (_$, e) => {
    const dir = `${plain(e.path)}/`
    const names = [...disk.keys()].filter((k) => k.startsWith(dir) && !k.slice(dir.length).includes('/')).map((k) => k.slice(dir.length))
    return names.length ? { value: names.map((name) => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) } : { deny: 'ENOENT' }
  })
  on('fs.stat', (_$, e) => (disk.has(plain(e.path)) ? { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }))
  const sends: unknown[] = []
  let answerDialog: ((v: unknown) => void) | undefined
  let opened = 0
  on('process.run', (_$, e) => {
    if (e.argv[1] === '-e') return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } // no tool_result: a dead dialog
    const [, , cmd, id, ...rest] = e.argv as string[]
    const ans = `${R}/answers/${id}.json`
    if (cmd === 'names') return { value: { exitCode: 0, stdout: [id, ...rest].filter((i) => o.names?.[i]).map((i) => `${i}\t${o.names![i]}`).join('\n'), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'wait') return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'done' && !disk.has(ans)) disk.set(ans, JSON.stringify({ id, at: 0, by: 'chat', ...(rest.length ? { choice: rest.join(' ') } : {}) }))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_$, e) => {
    if (e.tool === 'AskUserQuestion') return new Promise((r) => { opened++; answerDialog = r as (v: unknown) => void })
    if ((e.tool as string) === 'SendMessage') { sends.push(e); return { result: 'sent' } }
    return { result: 'Shown in the next-step box.' }
  })
  const submitted: string[] = []
  const contexts: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_$, e) => { if (o.failSubmits) { o.failSubmits--; throw new Error('the prompt did not go') } submitted.push(e.text); contexts.push(e.context); return { text: e.text } })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const under = (d: string) => [...disk.keys()].filter((k) => k.startsWith(`${R}/${d}/`) && !k.slice(R.length + d.length + 2).includes('/'))
  const items = () => under('items').map((k) => JSON.parse(disk.get(k)!))
  const reports = () => under('reports').filter((k) => k.endsWith('.json')).map((k) => JSON.parse(disk.get(k)!))
  const until = async (f: () => boolean, what = '') => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); expect([what, f()]).toEqual([what, true]) }
  return { clock, disk, items, reports, submitted, contexts, sends, until, opened: () => opened, answerDialog: (v: unknown) => answerDialog?.(v) }
}
const turn = (answer: string, extra: object = {}) => ({ answer, reason: 'answer', durationMs: 5000, isAborted: false, turnId: 't1', ...extra }) as never
const box = (id: string, at: number, extra: object = {}) => JSON.stringify({ id, kind: 'choice', at, session: 'chatA', cwd: 'C:/work/reports-app', chat: 'Сделай выгрузку отчётов (chatA)', ask: 'Запушить?', actions: ['Да'], ...extra })
const inboxAnswer = (id: string) => JSON.stringify({ id, at: 1, by: 'inbox', choice: 'Да' })

// 1. Source
test('1. the inbox chat asking an item without its source in the question is refused, with the exact tag to use', async ($, on) => {
  const w = world(on, { session: 'inboxChat', self: 'inboxChat' })
  w.disk.set(`${R}/items/chatA~w1.json`, box('chatA~w1', 100 * H - 60e3))
  const tag = sourceTag({ cwd: 'C:/work/reports-app', chat: 'Сделай выгрузку отчётов (chatA)' })
  expect(tag).toBe('reports-app · Сделай выгрузку отчётов')
  const bad = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Запушить?', header: 'reports', multiSelect: false, options: [{ label: 'Да' }, { label: 'Нет' }] }], metadata: { source: 'inbox:chatA~w1' } } as never)
  expect(bad.deny).toContain(`"${tag}: " (chatA~w1)`)
  const good = $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: `${tag}: Запушить?`, header: 'reports', multiSelect: false, options: [{ label: 'Да' }, { label: 'Нет' }] }], metadata: { source: 'inbox:chatA~w1' } } as never)
  await w.until(() => w.opened() === 1, 'dialog')
  w.answerDialog({ result: { answers: { [`${tag}: Запушить?`]: 'Да' } } })
  expect((await good).deny).toBeUndefined()
  expect(namesSource(`  REPORTS-app ·  Сделай выгрузку отчётов: x`, { cwd: 'C:/work/reports-app', chat: 'Сделай выгрузку отчётов (chatA)' })).toBe(true)
})

// 2. Not into a closed or abandoned chat
test('2. an inbox answer is not delivered once the person typed in that chat after the question; skipped holds why', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/turns/chatA`, 'idle 1')
  w.disk.set(`${R}/items/chatA~w2.json`, box('chatA~w2', 100 * H - 60e3))
  w.disk.set(`${R}/answers/chatA~w2.json`, inboxAnswer('chatA~w2'))
  await $.prompt.submit({ text: 'я сам запушил, не надо', origin: { kind: 'composer' } } as never)
  await w.clock.advance(15000)
  await w.clock.advance(15000)
  expect(w.submitted.filter((s) => s.startsWith('The person answered'))).toEqual([])
  expect(w.disk.get(`${R}/skipped/chatA~w2`)).toContain('you wrote in that chat')
})

test('2. typed earlier, before the question, does not block delivery; a question over 12 h old is not delivered', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/turns/chatA`, 'idle 1')
  w.disk.set(`${R}/said.jsonl`, `${JSON.stringify({ at: 100 * H - 14 * H, session: 'chatA', text: 'раньше' })}\n`)
  w.disk.set(`${R}/items/chatA~w3.json`, box('chatA~w3', 100 * H - 60e3))
  w.disk.set(`${R}/answers/chatA~w3.json`, inboxAnswer('chatA~w3'))
  w.disk.set(`${R}/items/chatA~w4.json`, box('chatA~w4', 100 * H - 13 * H, { ask: 'Удалить старый лог?' }))
  w.disk.set(`${R}/answers/chatA~w4.json`, inboxAnswer('chatA~w4'))
  await $.prompt.submit({ text: 'tick start', origin: { kind: 'plugin' } } as never) // starts this chat's timer
  for (let i = 0; i < 4; i++) await w.clock.advance(15000)
  expect(w.submitted.filter((s) => s.startsWith('The person answered')).length).toBe(1)
  expect(w.submitted.find((s) => s.startsWith('The person answered'))).toContain('Запушить?')
  expect(w.disk.get(`${R}/skipped/chatA~w4`)).toContain('13 h old')
  expect(undeliverable({ id: 'x', kind: 'ask', at: 0, session: 's', cwd: '', chat: '' }, { now: 13 * H, prompt: false })).toBeUndefined() // a live dialog
  expect(undeliverable({ id: 'x', kind: 'choice', at: 0, session: 's', cwd: '', chat: '' }, { now: 1, archived: true })).toBe('the chat is archived')
})

// 3. The inbox never writes into a chat on its own
test('3. the inbox chat cannot SendMessage in a turn the person did not start (a wake, a report, a session event)', async ($, on) => {
  const w = world(on, { session: 'inboxChat', self: 'inboxChat' })
  await $.prompt.submit({ text: 'Inbox: 1 chat finished work', origin: { kind: 'plugin' } } as never)
  const r = await $.tool.call({ tool: 'SendMessage', to: 'local_bbbb', message: 'сделай X' } as never)
  expect(r.deny).toContain('only on the person\'s own command')
  expect(w.sends).toEqual([])
})

test('3. the inbox chat may send in a turn he typed, or after he answered its dialog; the next turn needs him again', async ($, on) => {
  const w = world(on, { session: 'inboxChat', self: 'inboxChat' })
  await $.prompt.submit({ text: 'передай чату, пусть доделает', origin: { kind: 'composer' } } as never)
  expect((await $.tool.call({ tool: 'SendMessage', to: 'local_bbbb', message: 'доделай' } as never)).deny).toBeUndefined()
  await $.turn.complete(turn('Передал.'))
  expect((await $.tool.call({ tool: 'SendMessage', to: 'local_bbbb', message: 'ещё' } as never)).deny).toBeTruthy()
  const ask = $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Передать чату X «доделай»?', header: 'X', multiSelect: false, options: [{ label: 'Да' }, { label: 'Нет' }] }], metadata: { source: 'inbox' } } as never)
  await w.until(() => w.opened() === 1, 'dialog')
  w.answerDialog({ result: { answers: { 'Передать чату X «доделай»?': 'Да' } } })
  await ask
  expect((await $.tool.call({ tool: 'SendMessage', to: 'local_bbbb', message: 'доделай' } as never)).deny).toBeUndefined()
  expect(w.sends.length).toBe(2)
})

// 4. Mute is silence
test('4. a muted chat files no question, no box, no prose question and no report, and gets no answer', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/muted/local_aaaa`, 'x')
  w.disk.set(`${R}/reports/on/chatA`, 'started 1')
  w.disk.set(`${R}/turns/chatA`, 'idle 1')
  const ask = $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Какую базу взять?', header: 'База', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }], tool_use_id: 'm1' } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Готово.', ask: 'Запушить?', actions: [{ label: 'Да' }], tool_use_id: 'm2' } as never)
  await $.turn.complete(turn('Готово. Удалить временный лог?'))
  expect(w.items()).toEqual([])
  expect(w.reports()).toEqual([])
  w.answerDialog({ result: { answers: { 'Какую базу взять?': 'A' } } })
  await ask
  w.disk.set(`${R}/items/chatA~w5.json`, box('chatA~w5', 100 * H - 60e3))
  w.disk.set(`${R}/answers/chatA~w5.json`, inboxAnswer('chatA~w5'))
  await w.clock.advance(15000)
  expect(w.submitted).toEqual([])
})

test('4. the inbox chat is not woken by a muted chat\'s item or report, and cannot message it even when he typed', async ($, on) => {
  const w = world(on, { session: 'inboxChat', self: 'inboxChat' })
  w.disk.set(`${R}/muted/chatB`, 'x')
  w.disk.set(`${R}/items/chatB~q.json`, JSON.stringify({ id: 'chatB~q', kind: 'choice', at: 100 * H - 60e3, session: 'chatB', cwd: 'C:/work/SchoolDogs', chat: 'x', ask: 'Ок?', actions: [] }))
  w.disk.set(`${R}/reports/chatB~turn-1.json`, JSON.stringify({ id: 'chatB~turn-1', at: 100 * H - 20 * 60e3, session: 'chatB', cwd: 'C:/work/SchoolDogs', chat: 'x', recap: 'Готово', urgent: true }))
  await w.clock.advance(15000)
  expect(w.submitted).toEqual([])
  await $.prompt.submit({ text: 'что там', origin: { kind: 'composer' } } as never)
  expect((await $.tool.call({ tool: 'SendMessage', to: 'chatB', message: 'x' } as never)).deny).toContain('muted')
})

// 6. A started chat ends with one summary
test('6. a chat the inbox started is told once to ask in dialogs and end with one summary; a chat it did not start is not', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: 'обычный чат', origin: { kind: 'task-notification' } } as never)
  expect(w.contexts[0] ?? []).not.toContain(STARTED_BRIEF)
  w.disk.set(`${R}/reports/on/local_aaaa`, 'started 1')
  await $.prompt.submit({ text: 'Бриф: расследуй падение', origin: { kind: 'plugin' } } as never)
  await $.prompt.submit({ text: 'продолжение', origin: { kind: 'plugin' } } as never)
  expect(w.contexts[1]).toContain(STARTED_BRIEF)
  expect(w.contexts[2] ?? []).not.toContain(STARTED_BRIEF)
})

// 7. No duplicates
test('7. a dialog asked again replaces its earlier open copy; a recap that restates the last message is shown once', async ($, on) => {
  const w = world(on)
  const Q = [{ question: 'Какую базу взять для отчётов за месяц?', header: 'База', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] }]
  w.disk.set(`${R}/items/chatA~old.json`, JSON.stringify({ id: 'chatA~old', kind: 'ask', at: 100 * H - 60e3, session: 'chatA', cwd: 'C:/work/reports-app', chat: 'x', questions: Q }))
  void $.tool.call({ tool: 'AskUserQuestion', questions: Q, tool_use_id: 'new1' } as never)
  await w.until(() => w.disk.has(`${R}/items/chatA~new1.json`))
  await w.until(() => w.disk.has(`${R}/answers/chatA~old.json`), 'old copy closed')
  const shown = renderReports([{ id: 'r1', at: 1, session: 's', cwd: 'C:/x/proj', chat: 'c', recap: 'Выгрузка готова, тесты зелёные, отчёт лежит в export', excerpt: 'Готово. Выгрузка готова, тесты зелёные; отчёт лежит в export/2026-11.csv.' }], 60e3)
  expect(shown).not.toContain('Recap:')
  expect(shown.match(/тесты зелёные/g)?.length).toBe(1)
})

// Review round 1 (2026-11-13)
test('3. a send by name to a muted chat is refused (mute keeps its title); main, a subagent and a chat `start` made pass', async ($, on) => {
  const w = world(on, { session: 'inboxChat', self: 'inboxChat' })
  w.disk.set(`${R}/muted/local_cccc`, 'SkullDogs деплой бота')
  w.disk.set(`${R}/starts/k1.json`, JSON.stringify({ name: 'relaunch-lifelines', state: 'imported', updated: new Date(100 * H - 60e3).toISOString() }))
  await $.prompt.submit({ text: 'передай', origin: { kind: 'composer' } } as never)
  expect((await $.tool.call({ tool: 'SendMessage', to: 'SkullDogs деплой бота', message: 'x' } as never)).deny).toContain('muted')
  await $.turn.complete(turn('ok'))
  expect((await $.tool.call({ tool: 'SendMessage', to: 'main', message: 'x' } as never)).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'SendMessage', to: 'a1549210860c2e136', message: 'x' } as never)).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'SendMessage', to: 'relaunch-lifelines', message: 'бриф' } as never)).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'SendMessage', to: 'other-chat', message: 'x' } as never)).deny).toBeTruthy()
})

test('3. his word survives a plugin reload within the turn (kept on disk), and ends with the turn', async ($, on) => {
  const w = world(on, { session: 'inboxChat', self: 'inboxChat' })
  w.disk.set(`${R}/heard`, String(100 * H - 1000)) // written by the copy before the reload
  expect((await $.tool.call({ tool: 'SendMessage', to: 'chat-x', message: 'x' } as never)).deny).toBeUndefined()
  await $.turn.complete(turn('ok'))
  expect((await $.tool.call({ tool: 'SendMessage', to: 'chat-x', message: 'x' } as never)).deny).toBeTruthy()
})

test('2. a card answer still reaches its chat when old or after he typed there: it only withdraws the card', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/turns/chatA`, 'idle 1')
  w.disk.set(`${R}/said.jsonl`, `${JSON.stringify({ at: 100 * H - 60e3, session: 'chatA', text: 'привет' })}\n`)
  w.disk.set(`${R}/items/chatA~c1.json`, JSON.stringify({ id: 'chatA~c1', kind: 'card', at: 100 * H - 13 * H, session: 'chatA', cwd: 'C:/work/reports-app', chat: 'x', title: 'Чистка логов', taskId: 'task_1' }))
  w.disk.set(`${R}/answers/chatA~c1.json`, JSON.stringify({ id: 'chatA~c1', at: 1, by: 'inbox', choice: 'Started from the inbox' }))
  await $.prompt.submit({ text: 'tick start', origin: { kind: 'plugin' } } as never)
  await w.clock.advance(15000)
  expect(w.submitted.some((s) => s.includes('session card "Чистка логов"'))).toBe(true)
})

test('7. a recap that adds a finding to a short last message is kept', () => {
  const shown = renderReports([{ id: 'r1', at: 1, session: 's', cwd: 'C:/x/proj', chat: 'c', recap: 'Выгрузка отчётов работает; нашёл баг в auth, осталось починить миграцию и задеплоить', excerpt: 'Готово: выгрузка отчётов работает.' }], 60e3)
  expect(shown).toContain('баг в auth')
})

// Red team round 1 (2026-11-13)
test('3. a plugin message that arrives as a composer prompt is not his word: no send', async ($, on) => {
  const w = world(on, { session: 'inboxChat', self: 'inboxChat' })
  await $.prompt.submit({ text: 'The makarasty-tools plugin sent a message: Inbox: 2 new items waiting for the person', origin: { kind: 'composer' } } as never)
  expect((await $.tool.call({ tool: 'SendMessage', to: 'chat-x', message: 'x' } as never)).deny).toBeTruthy()
  expect((await $.tool.call({ tool: 'SendMessage', to: '*', message: 'x' } as never)).deny).toBeTruthy()
  expect(w.sends).toEqual([])
})

test('a reload mid-turn (no turn seen by this copy) does not queue a wake behind the busy turn', async ($, on) => {
  const w = world(on, { session: 'inboxChat', self: 'inboxChat' })
  w.disk.set(`${R}/turn`, `busy ${100 * H - 60e3}`)
  w.disk.set(`${R}/items/chatB~q.json`, JSON.stringify({ id: 'chatB~q', kind: 'choice', at: 100 * H - 60e3, session: 'chatB', cwd: 'C:/work/x', chat: 'x', ask: 'Ок?', actions: [] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: 'C:/work/app', surface: null, isInteractive: true } as never) // the reloaded copy's timer
  await w.clock.advance(15000)
  await new Promise((r) => setTimeout(r, 50))
  expect(w.submitted.filter((s) => s.startsWith('Inbox:'))).toEqual([])
  w.disk.set(`${R}/turn`, `idle ${100 * H}`)
  await w.clock.advance(15000)
  await w.until(() => w.submitted.some((s) => s.startsWith('Inbox:')), 'woken once idle')
})

test('a session cloned to another account: this copy never delivers the other copy\'s answer', async ($, on) => {
  const w = world(on) // this copy is local_aaaa
  w.disk.set(`${R}/turns/chatA`, 'idle 1')
  w.disk.set(`${R}/items/chatA~w9.json`, box('chatA~w9', 100 * H - 60e3, { host: 'local_other' }))
  w.disk.set(`${R}/answers/chatA~w9.json`, inboxAnswer('chatA~w9'))
  await $.prompt.submit({ text: 'tick start', origin: { kind: 'plugin' } } as never)
  await w.clock.advance(15000)
  expect(w.submitted.filter((s) => s.startsWith('The person answered'))).toEqual([])
})

test('7. a started chat\'s report shows its summary once: the last message, not also the recap', () => {
  const shown = renderReports([{ id: 'r1', at: 1, session: 's', cwd: 'C:/x/proj', chat: 'c', started: true, recap: 'Расследовал падение: причина в кэше', excerpt: 'Сделал: нашёл причину. Нашёл: кэш не сбрасывается. Дальше: починить сброс.' } as never], 60e3)
  expect(shown).not.toContain('Recap:')
})

// Review of 1.19.21..39
test('2. a plugin message that arrives as a composer prompt in an asking chat closes nothing and keeps the inbox answer', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/turns/chatA`, 'idle 1')
  w.disk.set(`${R}/items/chatA~p1.json`, box('chatA~p1', 100 * H - 60e3))
  w.disk.set(`${R}/answers/chatA~p1.json`, inboxAnswer('chatA~p1'))
  w.disk.set(`${R}/items/chatA~p2.json`, box('chatA~p2', 100 * H - 60e3, { ask: 'Удалить лог?' }))
  await $.prompt.submit({ text: 'The makarasty-tools plugin sent a message: Inbox: 2 new items waiting for the person', origin: { kind: 'composer' } } as never)
  expect(w.disk.has(`${R}/skipped/chatA~p1`)).toBe(false)
  expect(w.disk.has(`${R}/answers/chatA~p2.json`)).toBe(false)
  await w.clock.advance(15000)
  await w.until(() => w.submitted.some((s) => s.startsWith('The person answered')), 'answer delivered')
})

test('3. a chat `start` made gets one send without his word (the brief), not a second', async ($, on) => {
  const w = world(on, { session: 'inboxChat', self: 'inboxChat' })
  w.disk.set(`${R}/starts/k3.json`, JSON.stringify({ name: 'fresh-start', state: 'imported', updated: new Date(100 * H - 60e3).toISOString() }))
  expect((await $.tool.call({ tool: 'SendMessage', to: 'fresh-start', message: 'бриф' } as never)).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'SendMessage', to: 'fresh-start', message: 'ещё' } as never)).deny).toBeTruthy()
})

test('a wake whose submit failed is sent again on the next tick', async ($, on) => {
  const w = world(on, { session: 'inboxChat', self: 'inboxChat', failSubmits: 1 })
  w.disk.set(`${R}/turn`, `idle ${100 * H - 60e3}`)
  w.disk.set(`${R}/items/chatB~f1.json`, JSON.stringify({ id: 'chatB~f1', kind: 'choice', at: 100 * H - 60e3, session: 'chatB', cwd: 'C:/work/x', chat: 'x', ask: 'Ок?', actions: [] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: 'C:/work/app', surface: null, isInteractive: true } as never)
  await w.clock.advance(15000)
  await new Promise((r) => setTimeout(r, 50))
  expect(w.submitted.filter((s) => s.startsWith('Inbox:'))).toEqual([])
  await w.clock.advance(15000)
  await w.until(() => w.submitted.some((s) => s.startsWith('Inbox: 1 new item')), 'woken after the failed submit')
})

test('6. a muted chat the inbox started gets no brief: nothing of the inbox goes into it', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/reports/on/local_aaaa`, 'started 1')
  w.disk.set(`${R}/muted/local_aaaa`, 'x')
  await $.prompt.submit({ text: 'Бриф: расследуй падение', origin: { kind: 'plugin' } } as never)
  expect(w.contexts[0] ?? []).not.toContain(STARTED_BRIEF)
})

test('3. after a crash mid-turn his word counts 30 min, not 3 h; the wake is silent for 30 min, not 3 h', async ($, on) => {
  const w = world(on, { session: 'inboxChat', self: 'inboxChat' })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  w.disk.set(`${R}/heard`, String(100 * H - 40 * 60e3))
  expect((await $.tool.call({ tool: 'SendMessage', to: 'chat-x', message: 'x' } as never)).deny).toBeTruthy()
  w.disk.set(`${R}/turn`, `busy ${100 * H - 40 * 60e3}`)
  w.disk.set(`${R}/items/chatB~c1.json`, JSON.stringify({ id: 'chatB~c1', kind: 'choice', at: 100 * H - 60e3, session: 'chatB', cwd: 'C:/work/x', chat: 'x', ask: 'Ок?', actions: [] }))
  await $.session.start({ cwd: 'C:/work/app', surface: null, isInteractive: true } as never)
  await w.clock.advance(15000)
  await w.until(() => w.submitted.some((s) => s.startsWith('Inbox: 1 new item')), 'woken after a 40 min old busy mark')
})

test('1. the wake names each chat by its app title, not the brief it started with', async ($, on) => {
  const w = world(on, { session: 'inboxChat', self: 'inboxChat', names: { 'chatB~n1': 'Починка выгрузки (chatB)' } })
  w.disk.set(`${R}/turn`, `idle ${100 * H - 60e3}`)
  w.disk.set(`${R}/items/chatB~n1.json`, JSON.stringify({ id: 'chatB~n1', kind: 'choice', at: 100 * H - 60e3, session: 'chatB', cwd: 'C:/work/x', chat: 'Background (from the session that started this one) (chatB)', ask: 'Ок?', actions: [] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: 'C:/work/app', surface: null, isInteractive: true } as never)
  await w.clock.advance(15000)
  await w.until(() => w.submitted.some((s) => s.startsWith('Inbox: 1 new item')), 'woken')
  const wakeText = w.submitted.find((s) => s.startsWith('Inbox: 1 new item'))!
  expect(wakeText).toContain('x · Починка выгрузки: Ок?')
  expect(wakeText).not.toContain('Background')
})

test('1. the explanation written after the model\'s wait keeps a chat name `list` wrote meanwhile', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/turns/chatA`, 'busy 1')
  w.disk.set(`${R}/items/chatA~x1.json`, box('chatA~x1', 100 * H - 3 * 60e3))
  on('model.complete', () => {
    w.disk.set(`${R}/items/chatA~x1.json`, box('chatA~x1', 100 * H - 3 * 60e3, { chat: 'Выгрузка отчётов (chatA)' })) // `list` renamed it during the wait
    return { value: { isAnswered: true as const, text: 'Чат спрашивает, пушить ли.', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } } as never
  })
  await $.prompt.submit({ text: 'tick start', origin: { kind: 'plugin' } } as never)
  await w.clock.advance(15000)
  await w.until(() => !!w.items()[0]?.explain, 'explained')
  expect(w.items()[0].chat).toBe('Выгрузка отчётов (chatA)')
})

// Review round 2 (2026-11-13)
test('3. his yes to a plain dialog of the inbox chat (no items open) opens the send; main passes a muted "Main page"; a started name only for 30 min', async ($, on) => {
  const w = world(on, { session: 'inboxChat', self: 'inboxChat' })
  w.disk.set(`${R}/muted/local_dddd`, 'Main page redesign')
  w.disk.set(`${R}/starts/k2.json`, JSON.stringify({ name: 'old-start', state: 'done', updated: new Date(100 * H - 2 * H).toISOString() }))
  expect((await $.tool.call({ tool: 'SendMessage', to: 'main', message: 'x' } as never)).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'SendMessage', to: 'old-start', message: 'делай X' } as never)).deny).toBeTruthy()
  const ask = $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Отправить чату X «доделай»?', header: 'X', multiSelect: false, options: [{ label: 'Да' }, { label: 'Нет' }] }] } as never)
  await w.until(() => w.opened() === 1, 'dialog')
  w.answerDialog({ result: { answers: { 'Отправить чату X «доделай»?': 'Да' } } })
  await ask
  expect((await $.tool.call({ tool: 'SendMessage', to: 'chat-x', message: 'доделай' } as never)).deny).toBeUndefined()
})
