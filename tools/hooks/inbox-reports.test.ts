import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { MAX_MS, QUIET_MS, dueReports, renderReports } from '../skills/inbox/core.mjs'
declare const setTimeout: (f: (v?: unknown) => void, ms: number) => unknown // the test runtime has it

// Finish reports: a chat switched on for them writes one per working turn; the inbox chat is woken about them in
// batches. Kept apart from inbox.test.ts, which other chats edit.

const R = '/cfg/makarasty/inbox'
function world(on: On, o: { self?: string; session?: string } = {}) {
  const disk = new Map<string, string>([['/cfg/makarasty/inbox.on', 'x']])
  if (o.self) disk.set(`${R}/self`, o.self)
  const plain = (p: string): string => p.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_HOST_SESSION_ID: 'local_aaaa', CLAUDE_CODE_ACCOUNT_UUID: 'acc1' })
  const clock = mock.clock(on, { now: 10_000_000 })
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
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', (_$, e) => (e.tool === 'mcp__ccd_session__start_session'
    ? { result: 'Started session "Деплой" (local_12345678-aaaa-bbbb-cccc-1234567890ab) in C:/work/x' }
    : { result: 'Shown in the next-step box.' }))
  const submitted: string[] = []
  const contexts: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_$, e) => { submitted.push(e.text); contexts.push(e.context); return { text: e.text } })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const under = (d: string) => [...disk.keys()].filter((k) => k.startsWith(`${R}/${d}/`) && !k.slice(R.length + d.length + 2).includes('/'))
  const reports = () => under('reports').filter((k) => k.endsWith('.json')).map((k) => JSON.parse(disk.get(k)!))
  const items = () => under('items').map((k) => JSON.parse(disk.get(k)!))
  const until = async (f: () => boolean, what = '') => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); expect([what, f()]).toEqual([what, true]) }
  return { clock, disk, reports, items, submitted, contexts, until }
}
const turn = (answer: string, extra: object = {}) => ({ answer, reason: 'answer', durationMs: 5000, isAborted: false, turnId: 't1', ...extra }) as never
const wrap = (recap: string, extra: object = {}) => ({ tool: 'mcp__ccd_turn__wrap_up', recap, tool_use_id: 'w1', ...extra }) as never

test('opt-in: a chat not switched on writes no report; switched on, a working turn writes one, outside items', async ($, on) => {
  const w = world(on)
  await $.tool.call(wrap('Выгрузка готова, тесты зелёные.'))
  await $.turn.complete(turn('Готово. Нашёл ещё: в `export.ts` дата без часового пояса.'))
  expect(w.reports()).toEqual([])
  w.disk.set(`${R}/reports/on/chatA`, 'x')
  await $.tool.call(wrap('Выгрузка готова, тесты зелёные.'))
  await $.turn.complete(turn('Готово. Нашёл ещё: в `export.ts` дата без часового пояса.', { turnId: 't2' }))
  expect(w.reports()).toHaveLength(1)
  expect(w.reports()[0]).toMatchObject({ id: 'chatA~turn-t2', session: 'chatA', host: 'local_aaaa', recap: 'Выгрузка готова, тесты зелёные.', chat: 'Сделай выгрузку отчётов (chatA)' })
  expect(w.reports()[0].excerpt).toContain('дата без часового пояса')
  expect(w.items()).toEqual([])
  expect(renderReports(w.reports(), w.reports()[0].at + 60e3, 'acc1')).toContain('Open the chat: [Сделай выгрузку отчётов (chatA)](#local_aaaa)')
})

test('switched on by its app id; no wrap_up, a subagent wrap_up, a /loop tick: no report; a dead turn: one', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/reports/on/local_aaaa`, 'x')
  await $.turn.complete(turn('Просто ответ.', { turnId: 'a' }))
  await $.tool.call(wrap('сабагент', { agentId: 'sub1' }))
  await $.turn.complete(turn('Ответ.', { turnId: 'b' }))
  await $.prompt.submit({ text: '/loop tick', origin: { kind: 'scheduled-trigger' } } as never)
  await $.tool.call(wrap('тик'))
  await $.turn.complete(turn('Тик.', { turnId: 'c' }))
  expect(w.reports()).toEqual([])
  await $.prompt.submit({ text: 'дальше', origin: { kind: 'composer' } } as never)
  await $.turn.complete(turn('', { turnId: 'd', reason: 'error' }))
  expect(w.reports()).toMatchObject([{ id: 'chatA~turn-d', error: true }])
})

test('no duplicate with a pending question: a turn that asked writes its item and no report', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/reports/on/chatA`, 'x')
  await $.tool.call(wrap('Тесты прошли.', { ask: 'Запушить ветку?', actions: [{ label: 'Да' }] }))
  await $.turn.complete(turn('Тесты прошли.', { turnId: 'q1' }))
  await w.clock.advance(60000) // the next turn, a minute later
  await $.tool.call(wrap('Лог почищен.'))
  await $.turn.complete(turn('Готово.\n\nОстался временный лог. Удалить его?', { turnId: 'q2' }))
  expect(w.items().map((i) => i.ask)).toEqual(['Запушить ветку?', 'Удалить его?'])
  expect(w.reports()).toEqual([])
})

test('a secret in the reply is not copied into the report', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/reports/on/chatA`, 'x')
  await $.tool.call(wrap('Ключ настроен.'))
  await $.turn.complete(turn(`Готово, ключ ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)} записан.`, { turnId: 's1' }))
  const r = w.reports()[0]
  expect(r.excerpt).toContain('open the chat')
  expect(JSON.stringify(r)).not.toContain('ghp_a1B2')
})

test('the batching window: quiet 5 min or 15 min from the first, whichever comes first', () => {
  const at = (ms: number) => ({ id: `x~${ms}`, at: ms, session: 'x', cwd: 'c', chat: 'c' })
  expect(dueReports([], 1e9)).toBe(false)
  expect(dueReports([at(0), at(60e3)], 60e3 + QUIET_MS - 1)).toBe(false)
  expect(dueReports([at(0), at(60e3)], 60e3 + QUIET_MS)).toBe(true)
  const stream = [0, 4, 8, 12].map((m) => at(m * 60e3)) // a new one every 4 min: never quiet for 5
  expect(dueReports(stream, 14 * 60e3)).toBe(false)
  expect(dueReports(stream, MAX_MS)).toBe(true)
})

test('the inbox chat: reports never wake one by one; one wake per batch, none again for the same reports', async ($, on) => {
  const w = world(on, { self: 'inbox', session: 'inbox' })
  const now = 10_000_000 // the mock clock's start
  const put = (id: string, at: number) => w.disk.set(`${R}/reports/${id}.json`, JSON.stringify({ id, at, session: id.split('~')[0], cwd: 'C:/work/oxi-yapper', chat: 'c' }))
  await $.prompt.submit({ text: 'hi' } as never) // starts the timer
  put('chatB~turn-1', now)
  put('chatC~turn-1', now + 60e3)
  put('inbox~turn-1', now) // its own: never
  for (let i = 0; i < 23; i++) await w.clock.advance(15000) // 5:45 from the first, 4:45 from the second: not yet
  expect(w.submitted.filter((s) => s.startsWith('Inbox:'))).toEqual([])
  for (let i = 0; i < 8; i++) await w.clock.advance(15000)
  await w.until(() => w.submitted.some((s) => s.startsWith('Inbox:')), 'woken')
  const wakes = w.submitted.filter((s) => s.startsWith('Inbox:'))
  expect(wakes).toHaveLength(1)
  expect(wakes[0]).toContain('2 chats finished work (2 finish reports: oxi-yapper)')
  for (let i = 0; i < 40; i++) await w.clock.advance(15000)
  expect(w.submitted.filter((s) => s.startsWith('Inbox:'))).toHaveLength(1)
  expect(w.disk.has(`${R}/beat`)).toBe(true)
})

test('the inbox chat: an item wake carries the waiting reports; a typed prompt carries them too', async ($, on) => {
  const w = world(on, { self: 'inbox', session: 'inbox' })
  const now = 10_000_000 // the mock clock's start
  w.disk.set(`${R}/reports/chatB~turn-1.json`, JSON.stringify({ id: 'chatB~turn-1', at: now, session: 'chatB', cwd: 'C:/work/vize', chat: 'c' }))
  w.disk.set(`${R}/items/chatD~t1.json`, JSON.stringify({ id: 'chatD~t1', kind: 'choice', at: now, session: 'chatD', cwd: 'C:/work/app', chat: 'c', ask: 'Запушить?' }))
  await $.prompt.submit({ text: 'hi' } as never)
  await w.clock.advance(15000)
  await w.until(() => w.submitted.some((s) => s.startsWith('Inbox: 1 new item')), 'item wake')
  expect(w.submitted.find((s) => s.startsWith('Inbox: 1 new item'))).toContain('Also: 1 chat finished work (1 finish report: vize)')
  w.disk.set(`${R}/reports/chatE~turn-1.json`, JSON.stringify({ id: 'chatE~turn-1', at: now, session: 'chatE', cwd: 'C:/work/lifelines', chat: 'c' }))
  await $.prompt.submit({ text: 'что нового?', origin: { kind: 'composer' } } as never)
  expect(w.contexts.at(-1)?.join(' ')).toContain('1 chat finished work (1 finish report: lifelines)')
  for (let i = 0; i < 80; i++) await w.clock.advance(15000) // shown with the prompt: no batch wake later
  expect(w.submitted.filter((s) => s.startsWith('Inbox:'))).toHaveLength(1)
})

test('the inbox chat switches on every session it starts, and marks its turns busy and idle for the watchdog', async ($, on) => {
  const w = world(on, { self: 'inbox', session: 'inbox' })
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', initiation: 'user_asked', title: 'Деплой', prompt: 'p', tool_use_id: 's1' } as never)
  expect(w.disk.has(`${R}/reports/on/local_12345678-aaaa-bbbb-cccc-1234567890ab`)).toBe(true)
  await $.turn.start({ text: 'x', turnId: 'u1' } as never)
  expect(w.disk.get(`${R}/turn`)).toMatch(/^busy \d+$/)
  await $.turn.complete(turn('ok', { turnId: 'u1' }))
  expect(w.disk.get(`${R}/turn`)).toMatch(/^idle \d+$/)
})

// 2026-11-12: "3 new items" woke the inbox chat after all three had been answered; list said "nothing pending". A wake
// prompt queued during a turn entered after it, built from what was open before.
test('the inbox chat gets no wake while its turn runs, and none for items answered by its end', async ($, on) => {
  const w = world(on, { self: 'inbox', session: 'inbox' })
  const now = 10_000_000 // the mock clock's start
  const put = (id: string) => w.disk.set(`${R}/items/${id}.json`, JSON.stringify({ id, kind: 'choice', at: now, session: id.split('~')[0], cwd: 'C:/work/app', chat: 'c', ask: `${id}?` }))
  await $.prompt.submit({ text: 'hi' } as never) // starts the timer
  await $.turn.start({ text: 'x', turnId: 'long' } as never)
  put('chatB~t1')
  put('chatC~t2')
  for (let i = 0; i < 8; i++) await w.clock.advance(15000)
  expect(w.submitted.filter((s) => s.startsWith('Inbox:'))).toEqual([])
  w.disk.set(`${R}/answers/chatB~t1.json`, '{"by":"chat"}')
  w.disk.set(`${R}/answers/chatC~t2.json`, '{"by":"chat"}')
  await $.turn.complete(turn('ok', { turnId: 'long' }))
  for (let i = 0; i < 4; i++) await w.clock.advance(15000)
  expect(w.submitted.filter((s) => s.startsWith('Inbox:'))).toEqual([])
  put('chatD~t3') // still open after a turn: woken, with it alone
  await $.turn.start({ text: 'y', turnId: 'two' } as never)
  w.disk.set(`${R}/items/chatE~t4.json`, JSON.stringify({ id: 'chatE~t4', kind: 'choice', at: now, session: 'chatE', cwd: 'C:/work/app', chat: 'c', ask: 'chatE~t4?' }))
  w.disk.set(`${R}/answers/chatE~t4.json`, '{"by":"chat"}')
  await $.turn.complete(turn('ok', { turnId: 'two' }))
  await w.clock.advance(15000)
  await w.until(() => w.submitted.some((s) => s.startsWith('Inbox:')), 'woken after the turn')
  const wake = w.submitted.filter((s) => s.startsWith('Inbox:'))
  expect(wake).toHaveLength(1)
  expect(wake[0]).toContain('Inbox: 1 new item')
  expect(wake[0]).toContain('chatD~t3?')
  expect(wake[0]).not.toContain('chatE')
})
