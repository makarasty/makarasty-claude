import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { MAX_MS, QUIET_MS, dueReports, renderReports } from '../skills/inbox/core.mjs'
declare const setTimeout: (f: (v?: unknown) => void, ms: number) => unknown // the test runtime has it

// Finish reports: a chat switched on for them writes one per working turn; the inbox chat is woken about them in
// batches. Kept apart from inbox.test.ts, which other chats edit.

const R = '/cfg/makarasty/inbox'
function world(on: On, o: { self?: string; session?: string; failSubmits?: number; dialog?: Promise<void>; transcript?: 'seen' | 'absent' | 'unreadable' } = {}) {
  const disk = new Map<string, string>([['/cfg/makarasty/inbox.on', 'x']])
  if (o.self) disk.set(`${R}/self`, o.self)
  const plain = (p: string): string => p.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_HOST_SESSION_ID: 'local_aaaa', CLAUDE_CODE_ACCOUNT_UUID: 'acc1', MAKARASTY_SCREEN: 'off' })
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
  const mtimes = new Map<string, number>() // a file's age for fs.stat; default: just now
  on('fs.stat', (_$, e) => (disk.has(plain(e.path)) ? { value: { kind: 'file' as const, size: 1, mtimeMs: mtimes.get(plain(e.path)) ?? 10_000_000, isLink: false } } : { deny: 'ENOENT' }))
  // The CLI's `done`, played on the same disk: it closes an item only if nothing answered it yet.
  on('process.run', (_$, e) => {
    if (e.argv[1] === '-e') return { value: { exitCode: { seen: 0, absent: 1, unreadable: 2 }[o.transcript ?? 'absent'], stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } // the transcript look-up
    const [, , cmd, id, ...rest] = e.argv as string[]
    const ans = `${R}/answers/${id}.json`
    if (cmd === 'wait') return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } // no waiter here: the dialog alone answers
    if (cmd === 'done' && !disk.has(ans)) disk.set(ans, JSON.stringify({ id, at: 0, by: 'chat', ...(rest.length ? { choice: rest.join(' ') } : {}) }))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', async (_$, e) => (e.tool === 'AskUserQuestion' && o.dialog ? (await o.dialog, { result: 'Пользователь выбрал: SQLite' }) : e.tool === 'mcp__ccd_session__start_session'
    ? { result: 'Started session "Деплой" (local_12345678-aaaa-bbbb-cccc-1234567890ab) in C:/work/x (task_id: task_abc123)' }
    : { result: 'Shown in the next-step box.' }))
  const submitted: string[] = []
  const contexts: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_$, e) => { if (o.failSubmits) { o.failSubmits--; throw new Error('the prompt did not go') } submitted.push(e.text); contexts.push(e.context); return { text: e.text } })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const under = (d: string) => [...disk.keys()].filter((k) => k.startsWith(`${R}/${d}/`) && !k.slice(R.length + d.length + 2).includes('/'))
  const reports = () => under('reports').filter((k) => k.endsWith('.json')).map((k) => JSON.parse(disk.get(k)!))
  const items = () => under('items').map((k) => JSON.parse(disk.get(k)!))
  const until = async (f: () => boolean, what = '') => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); expect([what, f()]).toEqual([what, true]) }
  return { clock, disk, mtimes, reports, items, submitted, contexts, until }
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

test('switched on by its app id: a plain reply with no wrap_up is a finish; a subagent writes none and leaves no recap; a /loop tick is no finish', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/reports/on/local_aaaa`, 'x')
  await $.turn.complete(turn('Просто ответ.', { turnId: 'a' }))
  await $.tool.call(wrap('сабагент', { agentId: 'sub1' }))
  await $.turn.complete(turn('Работа сабагента закончена.', { turnId: 'sub', agentId: 'sub1' }))
  await $.turn.complete(turn('Ответ без вызова wrap_up.', { turnId: 'b' }))
  await $.prompt.submit({ text: '/loop tick', origin: { kind: 'scheduled-trigger' } } as never)
  await $.tool.call(wrap('тик'))
  await $.turn.complete(turn('Тик закончен.', { turnId: 'c' }))
  expect(w.reports().map((r) => r.id).sort()).toEqual(['chatA~turn-a', 'chatA~turn-b'])
  expect(w.reports().find((r) => r.id === 'chatA~turn-b')?.recap).toBeUndefined() // not the subagent's wrap_up
})

test('a turn the person typed (composer, bridge) writes no report, errors included; the next one from elsewhere does', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/reports/on/chatA`, 'started 1')
  await $.prompt.submit({ text: 'дальше', origin: { kind: 'composer' } } as never)
  await $.turn.complete(turn('Сделал, всё прошло хорошо.', { turnId: 'd1' }))
  await $.prompt.submit({ text: 'ещё', origin: { kind: 'bridge' } } as never)
  await $.turn.complete(turn('', { turnId: 'd2', reason: 'error' }))
  expect(w.reports()).toEqual([])
  await $.prompt.submit({ text: 'task finished', origin: { kind: 'task-notification' } } as never)
  await $.turn.complete(turn('', { turnId: 'd3', reason: 'error' }))
  expect(w.reports()).toMatchObject([{ id: 'chatA~turn-d3', error: true, urgent: true }])
})

test('an empty or one-word final message with no recap is no report; with a recap, or ending on an error, it is', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/reports/on/chatA`, 'x')
  await $.turn.complete(turn('', { turnId: 'q1' }))
  await $.turn.complete(turn('Готово.', { turnId: 'q2' }))
  expect(w.reports()).toEqual([])
  await $.tool.call(wrap('Выгрузка записана.'))
  await $.turn.complete(turn('Готово.', { turnId: 'q3' }))
  expect(w.reports().map((r) => r.id)).toEqual(['chatA~turn-q3'])
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
  const put = (id: string, at: number) => w.disk.set(`${R}/reports/${id}.json`, JSON.stringify({ id, at, session: id.split('~')[0], cwd: 'C:/work/proj-alpha', chat: 'c' }))
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
  expect(wakes[0]).toContain('2 chats finished work (2 finish reports: proj-alpha)')
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
  w.disk.set(`${R}/reports/chatE~turn-1.json`, JSON.stringify({ id: 'chatE~turn-1', at: now, session: 'chatE', cwd: 'C:/work/proj-gamma', chat: 'c' }))
  await $.prompt.submit({ text: 'что нового?', origin: { kind: 'composer' } } as never)
  expect(w.contexts.at(-1)?.join(' ')).toContain('1 chat finished work (1 finish report: proj-gamma)')
  for (let i = 0; i < 80; i++) await w.clock.advance(15000) // shown with the prompt: no batch wake later
  expect(w.submitted.filter((s) => s.startsWith('Inbox:'))).toHaveLength(1)
})

test('the inbox chat switches on every session it starts, and marks its turns busy and idle for the watchdog', async ($, on) => {
  const w = world(on, { self: 'inbox', session: 'inbox' })
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', initiation: 'user_asked', title: 'Деплой', prompt: 'p', tool_use_id: 's1' } as never)
  expect(w.disk.get(`${R}/reports/on/local_12345678-aaaa-bbbb-cccc-1234567890ab`)).toMatch(/^started /)
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

// 2026-11-12, 46 inbox items of 20 chats: three times a chat asked its box again (the same decision, 80-100% the same
// words) and the person answered both copies. Different questions of one chat overlapped 50% at most.
const box = (ask: string, id: string) => ({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask, actions: [{ label: 'Да' }], tool_use_id: id }) as never
const ASK1 = 'Закоммитить инбокс 1.19.14 вместе с незакоммиченной работой других чатов в этих файлах?'
const ASK2 = 'Закоммитить инбокс 1.19.14–1.19.15 вместе с незакоммиченной работой других чатов в этих файлах?'

test('a box asked again closes its earlier open copy, kept on disk; a box on another topic stays open', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'a', turnId: 'a' } as never)
  await $.tool.call(box('Какая сенса верная: 1.8 или 1.3?', 'b0'))
  await $.tool.call(box(ASK1, 'b1'))
  await $.turn.complete(turn('ok', { turnId: 'a' }))
  await w.clock.advance(60000)
  await $.turn.start({ text: 'b', turnId: 'b' } as never)
  await $.tool.call(box(ASK2, 'b2'))
  await $.turn.complete(turn('ok', { turnId: 'b' }))
  const answer = (id: string) => (w.disk.has(`${R}/answers/${id}.json`) ? JSON.parse(w.disk.get(`${R}/answers/${id}.json`)!) : undefined)
  expect(answer('chatA~b1')).toMatchObject({ by: 'chat', choice: '[superseded: the chat asked it again]' })
  expect(w.items().map((i) => i.id).sort()).toEqual(['chatA~b0', 'chatA~b1', 'chatA~b2'])
  expect(answer('chatA~b0')).toBeUndefined()
  expect(answer('chatA~b2')).toBeUndefined()
  // Run B and run C share half their words: different runs, both stay.
  await $.tool.call(box('Запустить прогон B (slot leads)?', 'r1'))
  await w.clock.advance(60000)
  await $.tool.call(box('Запустить прогон C (проверка /compact)?', 'r2'))
  expect(answer('chatA~r1')).toBeUndefined()
})

test('a box asked again while the inbox answer to it waits in the queue is not filed a second time', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'a', turnId: 'a' } as never)
  await $.tool.call(box(ASK1, 'q1'))
  await $.turn.complete(turn('ok', { turnId: 'a' }))
  await w.clock.advance(60000)
  await $.turn.start({ text: 'b', turnId: 'b' } as never) // a long turn: the person answers the box from the inbox meanwhile
  await w.clock.advance(60000)
  w.disk.set(`${R}/answers/chatA~q1.json`, JSON.stringify({ id: 'chatA~q1', at: 10_000_000 + 120000, by: 'inbox', choice: 'Да' }))
  await $.tool.call(box(ASK2, 'q2'))
  expect(w.items().map((i) => i.id)).toEqual(['chatA~q1'])
  // Answered before this turn began: the chat has read it and asks anew, so the new box is filed.
  await $.turn.complete(turn('ok', { turnId: 'b' }))
  await w.clock.advance(15000) // the queued answer entered as turn c
  await $.turn.start({ text: 'c', turnId: 'c' } as never)
  await $.tool.call(box(ASK2, 'q3'))
  expect(w.items().map((i) => i.id).sort()).toEqual(['chatA~q1', 'chatA~q3'])
})

// 2026-11-12: a chat collecting complaints in hold mode had each complaint's turn filed as a box, waking the inbox.
test('a chat in hold mode files no box and no finish report until the codeword', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/reports/on/chatA`, 'x')
  w.disk.set('/cfg/makarasty/hold/chatA/index.md', 'collecting until абрикос\n')
  await $.tool.call(wrap('Записал жалобу 2.'))
  await $.turn.complete(turn('Записал. Это баг или так задумано?', { turnId: 'h1' }))
  expect(w.items()).toEqual([])
  expect(w.reports()).toEqual([])
  w.disk.set('/cfg/makarasty/hold/chatA/index.md', 'fixing\n') // the codeword: the hold works the list, reports again
  await $.tool.call(wrap('Починил 3 жалобы.'))
  await $.turn.complete(turn('Готово, все три.', { turnId: 'h2' }))
  expect(w.reports()).toHaveLength(1)
})

test('a hold chat also files no wrap_up box and no card; a collecting list untouched for 24 h no longer holds', async ($, on) => {
  const w = world(on)
  const hold = '/cfg/makarasty/hold/chatA/index.md'
  w.disk.set(hold, 'collecting until абрикос\n')
  await $.tool.call(box('Это баг или так задумано?', 'hb1'))
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', initiation: 'own_initiative', title: 'Карточка', prompt: 'p', tool_use_id: 'hc1' } as never)
  expect(w.items()).toEqual([])
  w.mtimes.set(hold, 10_000_000 - 25 * 3600e3) // forgotten: gates.ts ignores it too
  await $.tool.call(box('Это баг или так задумано?', 'hb2'))
  expect(w.items().map((i) => i.id)).toEqual(['chatA~hb2'])
})

test('a card filed this turn hides neither the turn prose question nor its finish report; a scheduled turn origin does not leak into the next', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/reports/on/chatA`, 'x')
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', initiation: 'own_initiative', title: 'Карточка', prompt: 'p', tool_use_id: 'c1' } as never)
  await $.turn.complete(turn('Готово. Удалить временный лог?', { turnId: 'k1' }))
  expect(w.items().map((i) => [i.kind, i.ask])).toEqual([['card', undefined], ['choice', 'Удалить временный лог?']])
  await w.clock.advance(60000)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', initiation: 'own_initiative', title: 'Ещё', prompt: 'p', tool_use_id: 'c2' } as never)
  await $.tool.call(wrap('Сделал.'))
  await $.turn.complete(turn('Готово.', { turnId: 'k2' }))
  expect(w.reports().map((r) => r.id)).toEqual(['chatA~turn-k2'])
  // turnOrigin: a /loop tick makes no report, and the person's next prompt (origin read at its own start) is not tainted
  await $.prompt.submit({ text: '/loop tick', origin: { kind: 'scheduled-trigger' } } as never)
  await $.turn.complete(turn('Тик.', { turnId: 'k3' }))
  await $.tool.call(wrap('Позже.'))
  await $.turn.complete(turn('Дальше.', { turnId: 'k4' })) // no prompt.submit set an origin: not a scheduled turn
  expect(w.reports().map((r) => r.id)).toContain('chatA~turn-k4')
})

// 2026-11-12: the inbox chat's own dialog stayed open an hour (one turn), three items came in meanwhile, and the person
// typed his next prompt 9 s after answering, before the next tick: none of them was shown to him.
test('items that came in during a long turn of the inbox chat wake it the moment the turn ends, once', async ($, on) => {
  const w = world(on, { self: 'inbox', session: 'inbox' })
  const now = 10_000_000 // the mock clock's start
  await $.prompt.submit({ text: 'hi' } as never) // starts the timer
  await $.turn.start({ text: 'x', turnId: 'dialog' } as never)
  for (const id of ['chatB~t1', 'chatC~t2']) w.disk.set(`${R}/items/${id}.json`, JSON.stringify({ id, kind: 'ask', at: now, session: id.split('~')[0], cwd: 'C:/work/proj-alpha', chat: 'c', account: 'acc2', questions: [{ question: `${id}?`, options: [] }] }))
  for (let i = 0; i < 240; i++) await w.clock.advance(15000) // an hour in the dialog
  expect(w.submitted.filter((s) => s.startsWith('Inbox:'))).toEqual([])
  await $.turn.complete(turn('ok', { turnId: 'dialog' }))
  await w.until(() => w.submitted.some((s) => s.startsWith('Inbox:')), 'woken at the end of the turn, no tick needed')
  await w.clock.advance(15000)
  const wakes = w.submitted.filter((s) => s.startsWith('Inbox:'))
  expect(wakes).toHaveLength(1)
  expect(wakes[0]).toContain('Inbox: 2 new items')
})

// 2026-11-12: a tests session started by the inbox chat finished a first turn with a wrap_up, then a second one with a plain
// reply after its 6 min test limit ran out: no wrap_up, so no report, no wake. Every finish of an enrolled chat is a report;
// a started chat's, an error's and a waiting one's wake the inbox chat at once; the rest keep the batch.
const wakes = (w: ReturnType<typeof world>) => w.submitted.filter((s) => s.startsWith('Inbox:'))
const asChat = (o: { session: string }, id: string) => { o.session = id } // the mock reads the session id on every call

test('a started chat finishing twice 2 min apart: the first wakes at once, the second (inside the 10 min limit) waits for the batch, both shown whole', async ($, on) => {
  const o = { self: 'inbox', session: 'child' }
  const w = world(on, o)
  w.disk.set(`${R}/reports/on/child`, 'started 1')
  await $.tool.call(wrap('Прогон запущен в фоне.'))
  await $.turn.complete(turn('Прогон запущен, результата пока нет.', { turnId: 't1' }))
  asChat(o, 'inbox')
  await $.prompt.submit({ text: 'hi' } as never) // starts the timer in the inbox chat
  await w.clock.advance(15000)
  await w.until(() => wakes(w).length === 1, 'the first finish wakes at once')
  expect(wakes(w)[0]).toContain('1 chat finished work (1 finish report')
  asChat(o, 'child')
  await w.clock.advance(105000) // 2 min after the first finish
  await $.turn.complete(turn('Тесты не дали результата: прогон оставлен незаконченным.', { turnId: 't2' }))
  asChat(o, 'inbox')
  await w.clock.advance(270000)
  expect(wakes(w)).toHaveLength(1) // one urgent wake per chat per 10 min
  await w.clock.advance(30000)
  await w.until(() => wakes(w).length === 2, 'batch wake')
  expect(wakes(w)[1]).toContain('1 chat finished work (1 finish report')
  expect(w.reports().map((r) => [r.started, r.urgent])).toEqual([[true, true], [true, undefined]])
  const shown = renderReports(w.reports(), 10_000_000 + 600e3)
  expect(shown).toContain('2 finishes of one chat')
  expect(shown).toContain('Прогон запущен, результата пока нет.')
  expect(shown).toContain('прогон оставлен незаконченным')
  expect(shown.match(/Last message:/g)).toHaveLength(2) // the earlier finish of a started chat is not folded to a line
})

test('at most one urgent wake per chat per 10 min: a second error in the window waits for the batch', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/reports/on/chatA`, 'x')
  await $.turn.complete(turn('', { turnId: 'u1', reason: 'error' }))
  await w.clock.advance(120000)
  await $.turn.complete(turn('', { turnId: 'u2', reason: 'error' }))
  await w.clock.advance(600000)
  await $.turn.complete(turn('', { turnId: 'u3', reason: 'error' }))
  expect(w.reports().map((r) => [r.id, r.urgent ?? false])).toEqual([['chatA~turn-u1', true], ['chatA~turn-u2', false], ['chatA~turn-u3', true]])
})

test('a negated or conditional mention of a step is no waiting; a plain one is', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/reports/on/chatA`, 'x')
  const nots = ['Готово. Ничего делать не нужно, тебе нужно только прочитать.', 'Готово. Если тебе нужно, запусти ещё раз.', 'All green. Nothing you need to do here.', 'All green. If you must, run it again.']
  for (const [i, t] of nots.entries()) await $.turn.complete(turn(t, { turnId: `n${i}` }))
  expect(w.reports().map((r) => r.urgent)).toEqual([undefined, undefined, undefined, undefined])
  await $.turn.complete(turn('Готово. Тебе нужно запустить миграцию самому.', { turnId: 'y1' }))
  expect(w.reports().find((r) => r.id === 'chatA~turn-y1')?.urgent).toBe(true)
})

test('shown: the three newest urgent or started finishes of a chat in full, the rest a line each', () => {
  const at = (n: number) => ({ id: `x~${n}`, at: n * 1000, session: 'x', cwd: 'C:/work/proj', chat: 'c', excerpt: `finish ${n}`, urgent: true })
  const shown = renderReports([1, 2, 3, 4, 5, 6].map(at), 7000)
  expect(shown.match(/Last message:/g)).toHaveLength(4) // the newest and three more
  expect(shown.match(/Earlier, /g)).toHaveLength(2)
})

test('a finish that ends on a timeout error: a report, and the inbox chat is woken at once', async ($, on) => {
  const o = { self: 'inbox', session: 'chatB' }
  const w = world(on, o)
  w.disk.set(`${R}/reports/on/chatB`, '2026-11-12T10:00:00Z') // switched on by `report on`: not a started chat
  await $.turn.complete(turn('', { turnId: 'e1', reason: 'error' }))
  expect(w.reports()).toMatchObject([{ id: 'chatB~turn-e1', error: true, urgent: true }])
  asChat(o, 'inbox')
  await $.prompt.submit({ text: 'hi' } as never)
  await w.clock.advance(15000)
  await w.until(() => wakes(w).length === 1, 'woken')
})

test('a last message that names a step for the person wakes at once; an ordinary finish of the same chat keeps the batch', async ($, on) => {
  const o = { self: 'inbox', session: 'chatB' }
  const w = world(on, o)
  w.disk.set(`${R}/reports/on/chatB`, '2026-11-12T10:00:00Z')
  await $.turn.complete(turn('Готово. Тебе нужно запустить миграцию самому.', { turnId: 'w1' }))
  await $.turn.complete(turn('Готово, всё зелёное.', { turnId: 'w2' }))
  expect(w.reports().map((r) => [r.id, r.urgent ?? false])).toEqual([['chatB~turn-w1', true], ['chatB~turn-w2', false]])
})

test('a batch-only chat still batches: nothing for 5 min, then one wake', async ($, on) => {
  const o = { self: 'inbox', session: 'chatB' }
  const w = world(on, o)
  w.disk.set(`${R}/reports/on/chatB`, '2026-11-12T10:00:00Z')
  await $.turn.complete(turn('Готово, всё зелёное.', { turnId: 'b1' }))
  expect(w.reports()).toMatchObject([{ id: 'chatB~turn-b1' }])
  expect(w.reports()[0].urgent).toBeUndefined()
  asChat(o, 'inbox')
  await $.prompt.submit({ text: 'hi' } as never)
  for (let i = 0; i < 19; i++) await w.clock.advance(15000)
  expect(wakes(w)).toEqual([])
  for (let i = 0; i < 3; i++) await w.clock.advance(15000)
  await w.until(() => wakes(w).length === 1, 'batch wake')
})

// 2026-11-12: an answer written while its chat was mid-turn was marked delivered at once, the prompt never reached the chat,
// and nothing retried it; a new ask of the same chat was then held back as "queued" for an answer that was already gone.
const answerFor = (w: ReturnType<typeof world>, id: string) => w.disk.set(`${R}/answers/${id}.json`, JSON.stringify({ id, at: 10_000_000, by: 'inbox', choice: 'Да, коммит' }))
const delivered = (w: ReturnType<typeof world>, id: string) => w.disk.has(`${R}/delivered/${id}`)

test('an answer that comes in while its chat is mid-turn is held, then delivered when the turn ends', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'x', turnId: 'm1' } as never)
  await $.tool.call(box('Запушить ветку fix-login?', 'p1'))
  answerFor(w, 'chatA~p1')
  for (let i = 0; i < 6; i++) await w.clock.advance(15000)
  expect(w.submitted).toEqual([])
  expect(delivered(w, 'chatA~p1')).toBe(false)
  await $.turn.complete(turn('Готово, жду ответа.', { turnId: 'm1' }))
  await w.until(() => w.submitted.length === 1 && delivered(w, 'chatA~p1'), 'delivered after the turn')
  expect(w.submitted[0]).toContain('Да, коммит')
})

test('a submit that fails is not marked delivered: it is tried again at the next tick, once it goes', async ($, on) => {
  const w = world(on, { failSubmits: 1 })
  w.disk.set(`${R}/turns/chatA`, 'idle 1')
  await $.tool.call(box('Запушить ветку fix-login?', 'p2'))
  answerFor(w, 'chatA~p2')
  await w.clock.advance(15000)
  await w.until(() => w.disk.has(`${R}/answers/chatA~p2.json`))
  expect(w.submitted).toEqual([])
  expect(delivered(w, 'chatA~p2')).toBe(false)
  await w.clock.advance(15000)
  await w.until(() => w.submitted.length === 1 && delivered(w, 'chatA~p2'), 'retried')
  await w.clock.advance(30000)
  expect(w.submitted).toHaveLength(1)
})

test('a new ask after an answered and delivered one is a new item, even in the turn the answer came in', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'a', turnId: 'a' } as never)
  await $.tool.call(box(ASK1, 'r1'))
  answerFor(w, 'chatA~r1')
  w.disk.set(`${R}/delivered/chatA~r1`, '10000000') // the chat has read it
  await $.tool.call(box(ASK2, 'r2'))
  expect(w.items().map((i) => i.id).sort()).toEqual(['chatA~r1', 'chatA~r2'])
})

test('a new ask while the answer to the old one is in flight is not filed; that answer is delivered once', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'a', turnId: 'a' } as never)
  await $.tool.call(box(ASK1, 's1'))
  answerFor(w, 'chatA~s1')
  await $.tool.call(box(ASK2, 's2'))
  expect(w.items().map((i) => i.id)).toEqual(['chatA~s1'])
  await $.turn.complete(turn('Жду ответа на вопрос.', { turnId: 'a' }))
  await w.until(() => w.submitted.length === 1 && delivered(w, 'chatA~s1'), 'delivered')
  await w.clock.advance(60000)
  expect(w.submitted).toHaveLength(1)
})

// The inbox's `scan` files an ask for a dialog no waiter in its chat races (plugin reloaded mid-dialog): its answer is a prompt.
test('an ask the scan found is answered as a prompt with the questions and the picks; a live ask is not', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/turns/chatA`, 'idle 1')
  const ask = (id: string, o: object) => w.disk.set(`${R}/items/${id}.json`, JSON.stringify({ id, kind: 'ask', at: 1, session: 'chatA', cwd: 'C:/work/x', chat: 'c', questions: [{ question: 'Какую базу взять?', options: [] }], ...o }))
  const answer = (id: string) => w.disk.set(`${R}/answers/${id}.json`, JSON.stringify({ id, at: 2, by: 'inbox', answers: { 'Какую базу взять?': 'SQLite' } }))
  ask('chatA~scan', { found: 'scan' }); answer('chatA~scan')
  await $.prompt.submit({ text: 'hi' } as never) // starts the timer
  await w.clock.advance(15000)
  const sent = () => w.submitted.filter((x) => x !== 'hi')
  await w.until(() => sent().length === 1 && delivered(w, 'chatA~scan'), 'delivered')
  expect(sent()[0]).toContain('"Какую базу взять?": "SQLite"')
  expect(sent()[0]).toContain('from the inbox')
  await w.clock.advance(60000)
  expect(sent()).toHaveLength(1)
})

// 2026-11-13: an AskUserQuestion answered from the inbox after its dialog died (chat restarted, plugin reloaded) never reached the chat.
test('an ask no live dialog waits on, answered by the inbox, is delivered once as a prompt; a by:chat answer never', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/turns/chatA`, 'idle 1')
  const ask = (id: string) => w.disk.set(`${R}/items/${id}.json`, JSON.stringify({ id, kind: 'ask', at: 1, session: 'chatA', cwd: 'C:/work/x', chat: 'c', questions: [{ question: 'Что делаем?', options: [] }] }))
  const answer = (id: string, by: string) => w.disk.set(`${R}/answers/${id}.json`, JSON.stringify({ id, at: 2, by, answers: { 'Что делаем?': 'Коммит' } }))
  ask('chatA~dead'); answer('chatA~dead', 'inbox')
  ask('chatA~own'); answer('chatA~own', 'chat')
  await $.prompt.submit({ text: 'hi' } as never)
  await w.clock.advance(15000)
  const sent = () => w.submitted.filter((x) => x !== 'hi')
  await w.until(() => sent().length === 1 && delivered(w, 'chatA~dead'), 'delivered')
  expect(sent()[0]).toContain('"Что делаем?": "Коммит"')
  expect(sent()[0]).toContain('in place of the dialog here')
  await w.clock.advance(60000)
  expect(sent()).toHaveLength(1)
  expect(delivered(w, 'chatA~own')).toBe(false)
})

// Older waiter paths wrote no delivered/<id>: an old by:'inbox' answer whose dialog did get it must not come back as a prompt.
const oldAsk = (w: ReturnType<typeof world>, id: string, at: number) => {
  w.disk.set(`${R}/turns/chatA`, 'idle 1')
  w.disk.set(`${R}/items/${id}.json`, JSON.stringify({ id, kind: 'ask', at: 1, session: 'chatA', cwd: 'C:/work/x', chat: 'c', questions: [{ question: 'Что делаем?', options: [] }] }))
  w.disk.set(`${R}/answers/${id}.json`, JSON.stringify({ id, at, by: 'inbox', answers: { 'Что делаем?': 'Коммит' } }))
}
const idle = async (w: ReturnType<typeof world>, $: Parameters<Parameters<typeof test>[1]>[0]) => {
  await $.prompt.submit({ text: 'hi' } as never)
  for (let i = 0; i < 4; i++) await w.clock.advance(15000)
  return w.submitted.filter((x) => x !== 'hi')
}

test('a dead-looking ask whose dialog has its tool_result in the transcript is marked delivered and never re-sent', async ($, on) => {
  const w = world(on, { transcript: 'seen' })
  oldAsk(w, 'chatA~old', 9_000_000)
  expect(await idle(w, $)).toEqual([])
  expect(delivered(w, 'chatA~old')).toBe(true)
})

test('an ask whose transcript cannot be read is not delivered, and not marked', async ($, on) => {
  const w = world(on, { transcript: 'unreadable' })
  oldAsk(w, 'chatA~old', 9_000_000)
  expect(await idle(w, $)).toEqual([])
  expect(delivered(w, 'chatA~old')).toBe(false)
})

test('an ask whose id is time-based (no tool use id) is never delivered as a dead dialog, even with no tool_result', async ($, on) => {
  const w = world(on)
  oldAsk(w, 'chatA~9999999', 9_000_000)
  expect(await idle(w, $)).toEqual([])
  expect(delivered(w, 'chatA~9999999')).toBe(false)
})

test('an ask answered more than 24 h ago is not delivered even with no tool_result', async ($, on) => {
  const w = world(on)
  oldAsk(w, 'chatA~old', 1)
  await w.clock.advance(90_000_000)
  expect(await idle(w, $)).toEqual([])
})

test('an ask whose dialog is open here is not delivered by the tick: its waiter returns it', async ($, on) => {
  let close = () => {}
  const w = world(on, { dialog: new Promise<void>((r) => { close = r }) })
  w.disk.set(`${R}/turns/chatA`, 'idle 1')
  const q = { question: 'Какую базу взять?', header: 'База', multiSelect: false, options: [{ label: 'SQLite', description: 'a' }, { label: 'Postgres', description: 'b' }] }
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [q], tool_use_id: 'live1' } as never)
  await w.until(() => w.disk.has(`${R}/items/chatA~live1.json`), 'item filed')
  w.disk.set(`${R}/answers/chatA~live1.json`, JSON.stringify({ id: 'chatA~live1', at: 2, by: 'inbox', answers: { 'Какую базу взять?': 'SQLite' } }))
  for (let i = 0; i < 3; i++) await w.clock.advance(15000)
  expect(w.submitted).toEqual([])
  expect(delivered(w, 'chatA~live1')).toBe(false)
  close()
  await call
})

test('the turn state is on disk: a plugin reload mid-turn does not let a tick deliver; the turn end does', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/turns/chatA`, 'busy 10000000') // the turn began before the reload: this module never saw its turn.start
  await $.tool.call(box('Запушить ветку fix-login?', 'rl1'))
  answerFor(w, 'chatA~rl1')
  for (let i = 0; i < 6; i++) await w.clock.advance(15000)
  expect(w.submitted).toEqual([])
  await $.turn.complete(turn('Готово, жду ответа.', { turnId: 'rl' }))
  expect(w.disk.get(`${R}/turns/chatA`)).toMatch(/^idle /)
  await w.until(() => w.submitted.length === 1 && delivered(w, 'chatA~rl1'), 'delivered at the turn end')
})

test('a turn state never written (chat from before the upgrade, reloaded): busy for 30 min or until a turn ends, then delivered', async ($, on) => {
  const w = world(on)
  await $.tool.call(box('Запушить ветку fix-login?', 'nf1'))
  answerFor(w, 'chatA~nf1')
  for (let i = 0; i < 20; i++) await w.clock.advance(60000) // 20 min
  expect(w.submitted).toEqual([])
  for (let i = 0; i < 12; i++) await w.clock.advance(60000)
  await w.until(() => w.submitted.length === 1 && delivered(w, 'chatA~nf1'), 'after 30 min')
})

test('one answer per delivery: the second goes at a later tick, never together', async ($, on) => {
  const w = world(on)
  w.disk.set(`${R}/turns/chatA`, 'idle 1')
  await $.tool.call(box('Запушить ветку fix-login?', 'o1'))
  await $.tool.call(box('Какая сенса верная: 1.8 или 1.3?', 'o2'))
  answerFor(w, 'chatA~o1'); answerFor(w, 'chatA~o2')
  await w.clock.advance(15000)
  await w.until(() => w.submitted.length === 1, 'first')
  expect(delivered(w, 'chatA~o2') && delivered(w, 'chatA~o1')).toBe(false)
  await w.clock.advance(15000)
  await w.until(() => w.submitted.length === 2 && delivered(w, 'chatA~o1') && delivered(w, 'chatA~o2'), 'second, a tick later')
})
