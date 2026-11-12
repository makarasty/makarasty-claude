import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { render } from '../skills/inbox/core.mjs'

// The world beneath the inbox hook: one disk shared by chat A and the inbox (the CLI's answer and done are played on it),
// a dialog that answers only when the test says so, and every prompt the hook submits.
declare const setTimeout: (f: (v?: unknown) => void, ms: number) => unknown // the test runtime has it; the hook types do not
const plain = (p: string): string => p.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
const Q = 'Какую базу взять для отчётов?'
const QUESTIONS = [{ question: Q, header: 'База', multiSelect: false, options: [{ label: 'Postgres', description: 'та, что уже в проекте' }, { label: 'SQLite', description: 'файл рядом с отчётом' }] }]

function world(on: On, o: { on?: boolean; session?: string; self?: string; children?: string[] } = {}) {
  const disk = new Map<string, string>()
  if (o.on !== false) disk.set('/cfg/makarasty/inbox.on', 'x')
  if (o.self) disk.set('/cfg/makarasty/inbox/self', o.self)
  const submitted: string[] = []
  const cli: string[][] = []
  let answerDialog: ((v: unknown) => void) | undefined
  const dialog = { shown: 0, closed: 0 }
  let wake: (() => void) | undefined
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_HOST_SESSION_ID: 'local_aaaa', CLAUDE_CODE_ACCOUNT_UUID: 'acc1' })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.id', () => ({ value: o.session ?? 'chatA' }))
  on('session.cwd', () => ({ value: 'C:\\work\\reports-app' }))
  on('session.messages', () => ({ value: [
    { role: 'user' as const, text: '<system-reminder>\nLinked sessions now: x\n</system-reminder>', toolUses: [] },
    { role: 'user' as const, text: 'Сделай выгрузку отчётов за месяц', toolUses: [] },
    { role: 'assistant' as const, text: 'Отчётам нужна база; в проекте уже есть Postgres.', toolUses: [] },
  ] }))
  on('fs.exists', (_$, e) => ({ value: disk.has(plain(e.path)) }))
  on('fs.read', (_$, e) => (disk.has(plain(e.path)) ? { value: disk.get(plain(e.path))! } : { deny: 'ENOENT' }))
  on('fs.write', (_$, e) => { disk.set(plain(e.path), e.text); return { value: undefined } })
  on('fs.list', (_$, e) => {
    const dir = `${plain(e.path)}/`
    const names = [...disk.keys()].filter((k) => k.startsWith(dir) && !k.slice(dir.length).includes('/')).map((k) => k.slice(dir.length))
    return names.length ? { value: names.map((name) => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) } : { deny: 'ENOENT' }
  })
  // The CLI, played on the same disk: `wait` answers once an answer file is there, `done` creates one only if none is.
  on('process.run', async (_$, e) => {
    const [, script, cmd, id] = e.argv
    cli.push(e.argv.slice(2) as string[])
    expect(script).toMatch(/skills\/inbox\/inbox\.mjs$/)
    const ans = `/cfg/makarasty/inbox/answers/${id}.json`
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === 'wait') {
      const all = () => id!.split(',').every((i) => disk.has(`/cfg/makarasty/inbox/answers/${i}.json`))
      while (!all()) await new Promise<void>((r) => { wake = r })
      cli.push(['wait-returned', id!])
      return ok(disk.get(ans) ?? '[]')
    }
    if (cmd === 'children') return ok((o.children ?? []).join('\n'))
    if (cmd === 'push') disk.set(`/cfg/makarasty/inbox/pushed/${id}`, '')
    if (cmd === 'done') { if (!disk.has(ans)) { disk.set(ans, JSON.stringify({ id, at: 0, by: 'chat' })); wake?.() } return ok() }
    return ok()
  })
  on('tool.call', (_$, e, next) => {
    // The dialog: open until answered, closed when the engine abandons the call beneath (the hook answered first).
    if (e.tool === 'AskUserQuestion') {
      dialog.shown++
      return new Promise((r, j) => { answerDialog = r as (v: unknown) => void; next.signal.addEventListener('abort', () => { dialog.closed++; j(new Error('closed')) }) })
    }
    if (e.tool === 'mcp__ccd_session__start_session') return { result: 'Proposed "Чистка логов" (task_id: task_ab12cd34)' }
    return { result: 'Shown in the next-step box.' }
  })
  on('prompt.submit', (_$, e) => { submitted.push(e.text); return { text: e.text } })
  on('model.complete', () => ({ value: { isAnswered: true as const, text: 'Чат делает выгрузку и спрашивает, какую базу взять.', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) as never)
  const items = () => [...disk.keys()].filter((k) => k.startsWith('/cfg/makarasty/inbox/items/')).map((k) => JSON.parse(disk.get(k)!))
  // The inbox chat's `inbox.mjs answer`: the first answer file wins.
  const inboxAnswers = (id: string, body: object) => { disk.set(`/cfg/makarasty/inbox/answers/${id}.json`, JSON.stringify({ id, at: 1, by: 'inbox', ...body })); wake?.() }
  const until = async (f: () => boolean, what = '') => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); expect([what, f(), JSON.stringify(cli), JSON.stringify(dialog)]).toEqual([what, true, JSON.stringify(cli), JSON.stringify(dialog)]) }
  return { dialog, clock, disk, submitted, cli, items, inboxAnswers, until, answerDialog: (v: unknown) => answerDialog?.(v) }
}

test('a question from chat A shows up in the inbox, and the inbox answer comes back to chat A as the dialog\'s own', async ($, on) => {
  const w = world(on)
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS, tool_use_id: 'toolu_1' })
  await w.until(() => w.items().length === 1)
  const item = w.items()[0]
  expect(item.id).toBe('chatA~toolu_1')
  expect(item.chat).toBe('Сделай выгрузку отчётов за месяц (chatA)')
  expect(item.context).not.toContain('system-reminder')
  // What the inbox shows: project, the question with its options, the chat's context to explain it from.
  const shown = render(item, item.at + 5 * 60e3)
  expect(shown).toContain('reports-app — question, waiting 5 min')
  expect(shown).toContain(Q)
  expect(shown).toContain('- SQLite: файл рядом с отчётом')
  expect(shown).toContain('в проекте уже есть Postgres')
  expect(render(item, item.at, 'acc1')).toContain('Open the chat: [Сделай выгрузку отчётов за месяц (chatA)](#local_aaaa)')
  expect(render(item, item.at, 'acc2')).toContain('Chat on another account: open it with `inbox.mjs open chatA~toolu_1`')
  await w.until(() => w.cli.some((c) => c[0] === 'wait'), 'wait')
  w.inboxAnswers(item.id, { answers: { [Q]: 'SQLite' } })
  await w.until(() => w.cli.some((c) => c[0] === 'wait-returned'), 'returned')
  await w.until(() => w.dialog.closed === 1, 'closed')
  const r = await call
  expect(r.isError).not.toBe(true)
  expect((r.result as { answers: Record<string, string> }).answers).toEqual({ [Q]: 'SQLite' })
})

test('answered in the dialog first: the dialog\'s answer stands and the item leaves the inbox', async ($, on) => {
  const w = world(on)
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS, tool_use_id: 'toolu_2' })
  await w.until(() => w.items().length === 1)
  w.answerDialog({ result: { questions: QUESTIONS, answers: { [Q]: 'Postgres' } } })
  const r = await call
  expect((r.result as { answers: Record<string, string> }).answers).toEqual({ [Q]: 'Postgres' })
  expect(JSON.parse(w.disk.get('/cfg/makarasty/inbox/answers/chatA~toolu_2.json')!).by).toBe('chat')
})

test('an end-of-turn box answered in the inbox reaches chat A as a prompt with the whole question and the pick', async ($, on) => {
  const w = world(on)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Тесты прошли.', ask: 'Запушить ветку fix-login?', actions: [{ label: 'Да, пушь' }, { label: 'Не сейчас' }], tool_use_id: 'toolu_3' } as never)
  const item = w.items()[0]
  expect(item.kind).toBe('choice')
  expect(render(item)).toContain('Запушить ветку fix-login?')
  w.inboxAnswers(item.id, { choice: 'Да, пушь' })
  await w.clock.advance(15000) // this chat's timer
  await w.until(() => w.submitted.length === 1)
  expect(w.submitted[0]).toContain('"Запушить ветку fix-login?" from the inbox (makarasty-tools inbox): "Да, пушь"')
  await w.clock.advance(15000) // delivered once
  expect(w.submitted.length).toBe(1)
})

test('after 2 minutes an open item gets a plain explanation and one push', async ($, on) => {
  const w = world(on)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask: 'Удалить старые отчёты?', actions: [{ label: 'Да' }], tool_use_id: 'toolu_4' } as never)
  await w.clock.advance(15000)
  expect(w.cli.filter((c) => c[0] === 'push').length).toBe(0) // too young
  await w.clock.advance(3 * 60e3)
  await w.until(() => w.cli.some((c) => c[0] === 'push'), 'push')
  expect(w.items()[0].explain).toContain('спрашивает')
  expect(w.cli.filter((c) => c[0] === 'push')).toEqual([['push', 'chatA~toolu_4']])
})

test('a card offered by chat A enters the inbox with its task id; a click on it closes the item', async ($, on) => {
  const w = world(on)
  await $.tool.call({ tool: 'mcp__ccd_session__start_session', initiation: 'own_initiative', title: 'Чистка логов', prompt: 'Убери старые логи', tool_use_id: 'toolu_5' } as never)
  expect(w.items()[0]).toMatchObject({ kind: 'card', taskId: 'task_ab12cd34', title: 'Чистка логов' })
  await $.prompt.submit({ text: 'The user started your suggested background task task_ab12cd34' } as never)
  expect(w.cli).toContainEqual(['done', 'chatA~toolu_5'])
})

test('off: nothing is written and the dialog alone answers', async ($, on) => {
  const w = world(on, { on: false })
  const p = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS, tool_use_id: 'toolu_6' })
  await w.until(() => w.dialog.shown === 1)
  w.answerDialog({ result: { questions: QUESTIONS, answers: { [Q]: 'SQLite' } } })
  expect(((await p).result as { answers: Record<string, string> }).answers).toEqual({ [Q]: 'SQLite' })
  expect(w.items()).toEqual([])
})

test("the inbox chat itself writes nothing", async ($, on) => {
  const w = world(on, { self: 'chatA' })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask: 'x?', tool_use_id: 't7' } as never)
  expect(w.items()).toEqual([])
})

test('an ask marked metadata.source inbox is not caught', async ($, on) => {
  const w = world(on)
  const q = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS, metadata: { source: 'inbox' }, tool_use_id: 't8' })
  await w.until(() => w.dialog.shown === 1)
  w.answerDialog({ result: { questions: QUESTIONS, answers: {} } })
  await q
  expect(w.items()).toEqual([])
})

test("the inbox chat's own dialog closes by itself once the person answered all its items in their own chats", async ($, on) => {
  const w = world(on, { self: 'chatA' })
  const qs = [{ question: 'chatB: база?', header: 'chatB', multiSelect: false, options: [{ label: 'Да', description: '' }, { label: 'Нет', description: '' }] }]
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: qs, metadata: { source: 'inbox:chatB~t1,chatC~t2' }, tool_use_id: 't9' })
  await w.until(() => w.dialog.shown === 1, 'shown')
  w.disk.set('/cfg/makarasty/inbox/answers/chatB~t1.json', JSON.stringify({ id: 'chatB~t1', at: 1, by: 'chat' }))
  w.inboxAnswers('chatC~t2', { by: 'chat' })
  const r = await call
  expect((r.result as { answers: Record<string, string> }).answers).toEqual({ 'chatB: база?': '[answered in its own chat]' })
  await w.until(() => w.dialog.closed === 1, 'closed')
  expect(w.items()).toEqual([])
})

// 2026-11-12: chat B's dialog was open, the inbox asked the same question without the flag, the person answered in
// chat B, and the inbox's dialog stayed open, so they answered it a second time.
test('the inbox chat asking without the flag while items are open is refused, with the ids to name', async ($, on) => {
  const w = world(on, { self: 'chatA' })
  w.disk.set('/cfg/makarasty/inbox/items/chatB~t1.json', JSON.stringify({ id: 'chatB~t1', kind: 'ask', at: 1, session: 'chatB', cwd: 'C:/work/x', chat: 'c', questions: QUESTIONS }))
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS, tool_use_id: 't10' })
  expect(r.deny).toContain('"inbox:<the ids')
  expect(r.deny).toContain('chatB~t1')
  expect(w.dialog.shown).toBe(0)
  // Answered in chat B: nothing open, so a plain dialog of the inbox chat goes through.
  w.disk.set('/cfg/makarasty/inbox/answers/chatB~t1.json', JSON.stringify({ id: 'chatB~t1', at: 2, by: 'chat' }))
  const q = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS, tool_use_id: 't11' })
  await w.until(() => w.dialog.shown === 1, 'shown')
  w.answerDialog({ result: { questions: QUESTIONS, answers: { [Q]: 'SQLite' } } })
  expect(((await q).result as { answers: Record<string, string> }).answers).toEqual({ [Q]: 'SQLite' })
})

// 2026-11-12: the inbox re-asked, reworded, a question of a session it had started (Vize), whose own dialog the app
// already showed in the inbox chat, so the person saw it twice.
test('the inbox chat never re-asks an ask item of a session it started, with or without the flag', async ($, on) => {
  const w = world(on, { self: 'chatA', children: ['local_bbbb'] })
  const item = { kind: 'ask', at: 1, cwd: 'C:/work/lifelines', chat: 'c', questions: [{ question: 'Что обновлять в LifeLines? Vize и tsrs, oxlint, prettier только проверяют код. Vite, plugin-vue, sass, firebase, axios попадают в бандл.', options: [{ label: 'A: только проверки' }, { label: 'B: A + vite и plugin-vue' }] }] }
  w.disk.set('/cfg/makarasty/inbox/items/chatB~t1.json', JSON.stringify({ ...item, id: 'chatB~t1', session: 'chatB', host: 'local_bbbb' }))
  const reworded = [{ question: 'Vize-сессия составила план для LifeLines: vize, tsrs, oxlint, prettier проверяют код; vite, plugin-vue, sass, firebase, axios идут в сайт. Что обновляем?', header: 'LifeLines', multiSelect: false, options: [{ label: 'A: только проверки (Recommended)', description: '' }, { label: 'B: A + vite и plugin-vue', description: '' }] }]
  for (const source of ['inbox:chatB~t1', 'inbox', undefined]) {
    const r = await $.tool.call({ tool: 'AskUserQuestion', questions: reworded, ...(source ? { metadata: { source } } : {}), tool_use_id: `t-${source}` })
    expect(`${source}: ${r.deny}`).toContain(`${source}: chatB~t1 is a question from a session this chat started`)
    expect(r.deny).toContain('answer it in its own dialog above')
    expect(r.deny).toContain('chatB~t1')
  }
  expect(w.dialog.shown).toBe(0)
  // The same question from a chat it did not start goes through with the flag; a question of its own too.
  w.disk.set('/cfg/makarasty/inbox/items/chatC~t2.json', JSON.stringify({ ...item, id: 'chatC~t2', session: 'chatC', host: 'local_cccc' }))
  const q = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS, metadata: { source: 'inbox' }, tool_use_id: 't12' })
  await w.until(() => w.dialog.shown === 1, 'own question shown')
  w.answerDialog({ result: { questions: QUESTIONS, answers: { [Q]: 'SQLite' } } })
  await q
})

test('the inbox chat is woken once per new item from another chat, never for its own or answered ones', async ($, on) => {
  const w = world(on, { self: 'chatA' })
  const put = (id: string, o: object) => w.disk.set(`/cfg/makarasty/inbox/items/${id}.json`, JSON.stringify({ id, kind: 'ask', at: 1, session: id.split('~')[0], cwd: 'C:/work/reports-app', chat: 'c', questions: QUESTIONS, ...o }))
  put('chatB~t1', {})
  put('chatA~t2', {}) // its own
  put('chatC~t3', {})
  w.disk.set('/cfg/makarasty/inbox/answers/chatC~t3.json', '{"by":"chat"}') // answered already
  await $.prompt.submit({ text: 'hi' } as never) // starts the timer in the inbox chat too
  await w.clock.advance(15000)
  await w.until(() => w.submitted.some((s) => s.startsWith('Inbox: 1 new item')), 'woken')
  const wake = w.submitted.find((s) => s.startsWith('Inbox:'))!
  expect(wake).toContain('- reports-app: Какую базу взять для отчётов?')
  expect(wake).not.toContain('chatA')
  await w.clock.advance(15000)
  expect(w.submitted.filter((s) => s.startsWith('Inbox:')).length).toBe(1) // once per item
})
