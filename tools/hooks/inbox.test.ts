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

// pushed/<id> is empty once pushed, or {fails, at} after a failed try: tried again after 5 min, 3 times at most.
const pushCases: [string, string, boolean][] = [
    ['empty: pushed', '', false],
    ['one fail, 6 min old', JSON.stringify({ fails: 1, at: 1_000_000 - 6 * 60e3 }), true],
    ['one fail, 1 min old', JSON.stringify({ fails: 1, at: 1_000_000 }), false],
    ['three fails', JSON.stringify({ fails: 3, at: 1_000_000 - 3600e3 }), false],
    ['garbage', 'not json {', false],
  ]
for (const [what, marker, pushes] of pushCases) {
  test(`push marker, ${what}: the tick ${pushes ? 'pushes again' : 'does not push'}`, async ($, on) => {
    const w = world(on)
    await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'r', ask: 'Удалить старые отчёты?', actions: [{ label: 'Да' }], tool_use_id: 'toolu_p' } as never)
    w.disk.set('/cfg/makarasty/inbox/pushed/chatA~toolu_p', marker)
    await w.clock.advance(3 * 60e3)
    if (pushes) await w.until(() => w.cli.some((c) => c[0] === 'push'), what)
    else await new Promise((r) => setTimeout(r, 50))
    expect([what, w.cli.filter((c) => c[0] === 'push').length]).toEqual([what, pushes ? 1 : 0])
  })
}

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

// 2026-11-12: 1.19.11 refused re-asking a question of a session the inbox chat started, assuming the app shows that
// session's dialog there; the person did not see it and answered it in its own chat unprompted. It is asked like any.
test('the inbox chat asks a question of a session it started like any other: with the flag it goes, without it is refused', async ($, on) => {
  const w = world(on, { self: 'chatA', children: ['local_bbbb'] })
  const item = { kind: 'ask', at: 1, cwd: 'C:/work/lifelines', chat: 'c', questions: [{ question: 'Что обновлять в LifeLines? Vize и tsrs, oxlint, prettier только проверяют код. Vite, plugin-vue, sass, firebase, axios попадают в бандл.', options: [{ label: 'A: только проверки' }, { label: 'B: A + vite и plugin-vue' }] }] }
  w.disk.set('/cfg/makarasty/inbox/items/chatB~t1.json', JSON.stringify({ ...item, id: 'chatB~t1', session: 'chatB', host: 'local_bbbb' }))
  const reworded = [{ question: 'Vize-сессия составила план для LifeLines: vize, tsrs, oxlint, prettier проверяют код; vite, plugin-vue, sass, firebase, axios идут в сайт. Что обновляем?', header: 'LifeLines', multiSelect: false, options: [{ label: 'A: только проверки (Recommended)', description: '' }, { label: 'B: A + vite и plugin-vue', description: '' }] }]
  const bare = await $.tool.call({ tool: 'AskUserQuestion', questions: reworded, tool_use_id: 't-bare' })
  expect(bare.deny).toContain('"inbox:<the ids')
  expect(bare.deny).toContain('chatB~t1')
  expect(w.dialog.shown).toBe(0)
  const q = $.tool.call({ tool: 'AskUserQuestion', questions: reworded, metadata: { source: 'inbox:chatB~t1' }, tool_use_id: 't-flag' })
  await w.until(() => w.dialog.shown === 1, 'asked with the flag')
  w.inboxAnswers('chatB~t1', { by: 'chat' }) // answered in its own chat: this dialog closes by itself
  const r = await q
  expect((r.result as { answers: Record<string, string> }).answers).toEqual({ [reworded[0].question]: '[answered in its own chat]' })
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

// One path for every kind: the inbox chat asks a box and a card with the flag too, and its dialog closes by itself once
// the person answered both in their own chats (a button there, a click on the card).
test('the inbox chat asks a box and a card with the flag; answered in their chats, its dialog closes by itself', async ($, on) => {
  const w = world(on, { self: 'chatA', children: ['local_bbbb'] })
  const put = (id: string, o: object) => w.disk.set(`/cfg/makarasty/inbox/items/${id}.json`, JSON.stringify({ id, at: 1, session: id.split('~')[0], cwd: 'C:/work/x', chat: 'c', host: 'local_bbbb', ...o }))
  put('chatB~box1', { kind: 'choice', ask: 'Запушить ветку?', actions: ['Да', 'Нет'] })
  put('chatC~card1', { kind: 'card', title: 'Чистка логов', taskId: 'task_1' })
  const qs = [
    { question: 'chatB: запушить ветку?', header: 'chatB', multiSelect: false, options: [{ label: 'Да', description: '' }, { label: 'Нет', description: '' }] },
    { question: 'chatC: запустить «Чистка логов»?', header: 'chatC', multiSelect: false, options: [{ label: 'Запустить', description: '' }, { label: 'Отказаться', description: '' }] },
  ]
  expect((await $.tool.call({ tool: 'AskUserQuestion', questions: qs, tool_use_id: 'bare' })).deny).toContain('chatB~box1, chatC~card1')
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: qs, metadata: { source: 'inbox:chatB~box1,chatC~card1' }, tool_use_id: 'flagged' })
  await w.until(() => w.dialog.shown === 1, 'shown')
  w.inboxAnswers('chatB~box1', { by: 'chat' })
  await new Promise((r) => setTimeout(r, 30))
  expect(w.dialog.closed).toBe(0) // one of two answered: still open
  w.inboxAnswers('chatC~card1', { by: 'chat' })
  const r = await call
  expect(Object.values((r.result as { answers: Record<string, string> }).answers)).toEqual(['[answered in its own chat]', '[answered in its own chat]'])
})

// 2026-11-12: the person left with one question open in the inbox chat; items that came in meanwhile waited behind it.
test('the queue: a dialog open 10 min when a new item comes in is closed to be asked again with every open item', async ($, on) => {
  const w = world(on, { self: 'chatA' })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const put = (id: string) => w.disk.set(`/cfg/makarasty/inbox/items/${id}.json`, JSON.stringify({ id, kind: 'ask', at: 1_000_000, session: id.split('~')[0], cwd: 'C:/work/x', chat: 'c', questions: QUESTIONS }))
  put('chatB~t1')
  await $.prompt.submit({ text: 'hi' } as never) // the timer
  await $.turn.start({ text: 'x', turnId: 'q' } as never)
  w.disk.set('/cfg/makarasty/inbox/announced/chatB~t1', '')
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: QUESTIONS, metadata: { source: 'inbox:chatB~t1' }, tool_use_id: 'q1' })
  await w.until(() => w.dialog.shown === 1, 'shown')
  for (let i = 0; i < 8; i++) await w.clock.advance(15000) // 2 min
  put('chatC~t2') // comes in while he is away
  for (let i = 0; i < 28; i++) await w.clock.advance(15000) // 9 min open: not yet
  expect(w.dialog.closed).toBe(0)
  for (let i = 0; i < 6; i++) await w.clock.advance(15000) // past 10 min
  const r = await call
  expect((r.result as { answers: Record<string, string> }).answers).toEqual({ [Q]: '[not answered yet: more items came in while this dialog waited; ask again with every open item, these first]' })
  await w.until(() => w.dialog.closed === 1, 'closed')
  expect(w.disk.has('/cfg/makarasty/inbox/answers/chatB~t1.json')).toBe(false) // still open, asked again
  expect(w.submitted.filter((s) => s.startsWith('Inbox:'))).toEqual([]) // no prompt queued behind the turn
})

// "continue?" questions: answered at once when the person's profile.md / answers.md says so, and only then.
const CQ = 'Продолжить с миграцией схемы?' // not the bare shape ask-guard.ts already refuses
const cont = (labels: string[], q = CQ) => [{ question: q, header: 'Дальше', multiSelect: false, options: labels.map((label) => ({ label })) }]
const RULE_LINE = 'Continue questions: answered yes'
const YESNO = ['Да, продолжать (Рекомендую)', 'Нет, остановиться']

test('a continue-only question with the standing rule is answered at once: the answer says who gave it, is logged, and is written before the item', async ($, on) => {
  const w = world(on)
  w.disk.set('/cfg/makarasty/answers.md', `# Answers\n- ${RULE_LINE}\n`)
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: cont(YESNO) as never, tool_use_id: 'toolu_c1' })
  const got = (r.result as { answers: Record<string, string> }).answers[CQ]
  expect(got).toBe(`Да, продолжать (Рекомендую) [answered by the person's standing rule: "${RULE_LINE}"]`)
  const ans = JSON.parse(w.disk.get('/cfg/makarasty/inbox/answers/chatA~toolu_c1.json')!)
  expect([ans.by, ans.standing, ans.answers[CQ]]).toEqual(['inbox', true, got])
  const log = w.disk.get('/cfg/makarasty/inbox/auto.jsonl')!.trim().split('\n').map((l) => JSON.parse(l))
  expect(log.map((l) => [l.id, l.question, l.label, l.rule])).toEqual([['chatA~toolu_c1', CQ, 'Да, продолжать (Рекомендую)', RULE_LINE]])
  const keys = [...w.disk.keys()]
  expect(keys.indexOf('/cfg/makarasty/inbox/answers/chatA~toolu_c1.json')).toBeLessThan(keys.indexOf('/cfg/makarasty/inbox/items/chatA~toolu_c1.json'))
  expect(w.dialog.shown).toBe(0)
})

// The owner's real profile.md: one line, the rule is one sentence of several, and a later sentence says "Never".
const PROFILE = 'Language: Russian, plain and short. Machine facts for tooling, perf and OS work: ~/.claude/MACHINE.md (Windows 11, RAM shared by 20-30 chats at once). Continue questions about work already asked are answered yes. Never propose fewer workers, test workers or parallel chats to save RAM: a RAM fix must not cost speed.'
test('a one-line profile.md (the owner own wording): a continue question is answered yes', async ($, on) => {
  const w = world(on)
  w.disk.set('/cfg/makarasty/profile.md', PROFILE)
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: cont(YESNO) as never, tool_use_id: 'toolu_c6' })
  expect((r.result as { answers: Record<string, string> }).answers[CQ]).toContain('standing rule: "Continue questions about work already asked are answered yes"')
})

test('the rule in profile.md as "Continue: yes" counts too', async ($, on) => {
  const w = world(on)
  w.disk.set('/cfg/makarasty/profile.md', 'Отвечай коротко.\nContinue: yes\n')
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: cont(['Yes, continue', 'No, stop']) as never, tool_use_id: 'toolu_c1b' })
  expect((r.result as { answers: Record<string, string> }).answers[CQ]).toContain('Yes, continue [answered by the person')
})

// Each of these must reach the person's dialog; the answered-at-once path never opens it.
async function notAnswered(on: On, $: Parameters<Parameters<typeof test>[1]>[0], rule: string, questions: unknown, id: string) {
  const w = world(on)
  w.disk.set('/cfg/makarasty/profile.md', rule)
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: questions as never, tool_use_id: id })
  await w.until(() => w.dialog.shown === 1, 'dialog')
  expect(w.disk.has(`/cfg/makarasty/inbox/answers/chatA~${id}.json`)).toBe(false)
  w.answerDialog({ result: { questions: [], answers: {} } })
  await call
}

for (const q of ['Продолжить и закоммитить?', 'Продолжать и запушить?', 'Продолжить и смержить в master?', 'Продолжать, задеплоить на прод?', 'Продолжить выкатку на прод?',
  'Продолжить, стереть старые данные?', 'Продолжить, перезаписав прод-базу?', 'Продолжить и отправить письмо клиенту?', 'Continue and ship it to production?',
  'Продолжить и сбросить базу?', 'Продолжить, снести старую ветку?', 'Продолжить и откатить миграцию?', 'Продолжить и залить на сервер?', 'Продолжить и очистить папку dist?', 'Продолжить чистку диска?', 'Продолжить сброс кэша?', 'Continue the cleanup?',
  'Continue and reset the database?', 'Continue with a force rebase?', 'Continue and buy the domain?', 'Continue and close the PR?', 'Продолжить, пока ты не уйдёшь на обед и мы не вернёмся к этому разговору позже?']) {
  test(`a stake or a long question is never answered by the rule: ${q}`, ($, on) => notAnswered(on, $, RULE_LINE, cont(['Да', 'Нет'], q), 'toolu_c3'))
}

test('a choice between approaches phrased with "continue" is left to the person', ($, on) =>
  notAnswered(on, $, RULE_LINE, cont(['Продолжить через REST (Рекомендую)', 'Продолжить через GraphQL'], 'Как продолжим?'), 'toolu_c5'))

for (const labels of [['Остановиться', 'Сначала покажи план'], ['Да, продолжать', 'Сначала покажи план'], ['Да', 'Нет', 'Позже']]) {
  test(`a continue question whose options are not exactly one yes and one no is left to the person: ${labels.join(' / ')}`, ($, on) => notAnswered(on, $, RULE_LINE, cont(labels), 'toolu_c4'))
}

for (const rule of ['Continue questions: never answer yes for me, ask me.', 'Продолжать без спроса: нет, спрашивай.', 'Продолжительность созвонов: да', 'Continue: yes, but never for deploys', 'Отвечай коротко и по делу.']) {
  test(`a negated or unrelated line is no standing rule: ${rule}`, ($, on) => notAnswered(on, $, rule, cont(YESNO), 'toolu_c2'))
}
