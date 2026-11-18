import { expect, test } from 'claude-code/testing'
import { telegramTick } from './telegram.ts'

declare const setTimeout: (f: (v?: unknown) => void, ms: number) => unknown // the test runtime has it; the hook types do not
// The Telegram poll, called directly with a hand-made hook-side `$` (`$.fs.read(path)`): a test's own `$` is the engine's
// driver, which has no fs, env or http to mock. The disk is a Map, the clock a number the test moves, every Bot API call goes to a
// fake `http.fetch` and every process the poll starts to a fake `process.run`.
type Call = { method: string; body: Record<string, any> }
const TOKEN = '123456789:Zq8Lm3Vb7Nx2Wc5Rt9Yh4Js6'
const H = 3600e3
const Q = 'Какую базу взять?'
const TG = '/cfg/makarasty/telegram'
const INBOX = '/cfg/makarasty/inbox'
let worlds = 0

// o.config: notify.json text (null: none). o.steal: another session overwrites the poll claim at once. o.getUpdates: the
// n-th getUpdates answer (status and body); by default the same `updates` list every time, as Telegram does until the offset moves.
function world(o: { config?: string | null; profile?: string | null; steal?: boolean; getUpdates?: (n: number) => [number, object] } = {}) {
  const NOW = 1_000_000_000 + ++worlds * 100_000_000 // a module that keeps state between tests never sees a time it has paused until
  let t = NOW
  const disk = new Map<string, string>()
  if (o.config !== null) disk.set('/cfg/makarasty/notify.json', o.config ?? JSON.stringify({ telegram: { token: TOKEN, chat_id: '42' } }))
  // The words follow the profile: Russian by default here (most cases pin the Russian texts), null for no profile (English).
  if (o.profile !== null) disk.set('/cfg/makarasty/profile.md', o.profile ?? 'Language: Russian')
  const calls: Call[] = []
  const log: string[] = [] // every fetch and process.run, in order
  const runs: { argv: string[]; stdin?: string }[] = []
  const completions: string[] = []
  let updates: object[] = []
  let gets = 0
  const reply = (status: number, body: object) => ({ status, ok: status < 300, headers: {}, text: JSON.stringify(body) })
  const $ = {
    env: { get: async (name: string) => (name === 'CLAUDE_CONFIG_DIR' ? '/cfg' : undefined) },
    fs: {
      read: async (p: string) => { if (!disk.has(p)) throw new Error('ENOENT'); return disk.get(p)! },
      write: async (p: string, text: string) => { disk.set(p, text); if (o.steal && p === `${TG}/polled`) disk.set(p, '1 someone-else') },
      exists: async (p: string) => disk.has(p),
      list: async (p: string) => {
        const names = [...disk.keys()].filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/')).map((k) => k.slice(p.length + 1))
        if (!names.length) throw new Error('ENOENT')
        return names.map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false }))
      },
    },
    http: {
      fetch: async (url: string, init?: { body?: string }) => {
        const method = url.split('/').pop()!
        expect(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true)
        calls.push({ method, body: JSON.parse(init?.body ?? '{}') })
        log.push(method)
        if (method === 'getUpdates') { const [status, body] = o.getUpdates ? o.getUpdates(++gets) : [200, { ok: true, result: updates }]; return reply(status, body) }
        if (method === 'sendMessage') return reply(200, { ok: true, result: { message_id: 900 + calls.length } })
        return reply(200, { ok: true, result: true })
      },
    },
    process: {
      run: async (argv: string[], init?: { stdin?: string }) => {
        expect(argv[1]).toMatch(/skills\/inbox\/inbox\.mjs$/)
        runs.push({ argv: argv.slice(2), stdin: init?.stdin })
        log.push(`run:${argv[2]}`)
        return { exitCode: 0, stdout: `inbox: answered ${argv[3]}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    },
    plugin: { root: '/plugin/tools' },
    session: { id: async () => 'chatA' },
    clock: { now: async () => t, sleep: async (ms: number) => { t += ms }, every: () => ({ cancel() { /* the 3 s timer after traffic is not run here */ } }) },
    model: { complete: async () => { completions.push('x'); return { isAnswered: true as const, text: 'Чат делает выгрузку и спрашивает, какую базу взять.' } } },
  }
  const tick = () => telegramTick($ as never)
  const advance = async (ms: number) => { t += ms }
  const wait = () => new Promise((r) => setTimeout(r, 30))
  const json = <T = any>(p: string): T => JSON.parse(disk.get(p) ?? 'null')
  const put = (p: string, o: unknown) => disk.set(p, typeof o === 'string' ? o : JSON.stringify(o))
  const item = (id: string, extra: object = {}) => put(`${INBOX}/items/${id}.json`, { id, kind: 'ask', at: NOW, session: 'chatB', cwd: String.raw`C:\work\reports-app`, chat: 'c', context: '', questions: [{ question: Q, header: 'База', multiSelect: false, options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }] }], ...extra })
  const ask = (msg: number, extra: object = {}) => put(`${TG}/asks/${msg}.json`, { item: 'chatB~t1', html: `<b>${Q}</b>\n<i>reports-app · вопрос · 5 мин</i>`, short: Q, options: ['Postgres', 'SQLite'], reply: true, at: NOW, ...extra })
  const inbound = () => [...disk.keys()].filter((k) => k.startsWith(`${TG}/inbound/`))
  const sent = (method: string) => calls.filter((c) => c.method === method)
  return { NOW, disk, calls, log, runs, completions, advance, tick, wait, json, put, item, ask, inbound, sent, feed: (u: object[]) => { updates = u } }
}

const tap = (id: number, from: number, msg: number, data: string) => ({ update_id: id, callback_query: { id: `cb${id}`, from: { id: from }, data, message: { message_id: msg, chat: { id: 42 } } } })
const say = (id: number, text: string, extra: object = {}) => ({ update_id: id, message: { message_id: 60 + id, chat: { id: 42, type: 'private' }, from: { id: 42 }, text, ...extra } })

for (const [what, config] of [['no notify.json', null], ['a token with no chat bound', JSON.stringify({ telegram: { token: TOKEN } })]] as const) {
  test(`${what}: nothing is asked of Telegram`, async () => {
    const w = world({ config })
    await w.tick()
    expect(w.calls).toEqual([])
  })
}

test('the leader long-polls again at once; another chat waits while the lease is fresh and takes over once it is 30 s old', async () => {
  const w = world()
  await w.tick()
  await w.tick()
  expect(w.sent('getUpdates').length).toBe(2) // its own lease: the next long poll right after the last
  expect(w.sent('getUpdates')[0]!.body).toMatchObject({ offset: 0, timeout: 20, allowed_updates: ['message', 'callback_query'] })
  w.put(`${TG}/polled`, `${w.NOW + 1000} chatZ`) // chat Z leads now
  await w.advance(10000)
  await w.tick()
  expect(w.sent('getUpdates').length).toBe(2)
  await w.advance(25000)
  await w.tick()
  expect(w.sent('getUpdates').length).toBe(3)
  expect(w.disk.get(`${TG}/polled`)).toMatch(/ chatA$/)
})

test('a request with no HTTP answer (the engine cannot hold a long one): short polls, 2 s apart', async () => {
  let n = 0
  const w = world({ getUpdates: () => { if (++n === 1) throw new Error('socket hang up'); return [200, { ok: true, result: [] }] } })
  await w.tick()
  await w.advance(500)
  await w.tick()
  expect(w.sent('getUpdates').map((c) => c.body.timeout)).toEqual([20]) // 2 s apart
  await w.advance(2000)
  await w.tick()
  await w.advance(2000)
  await w.tick()
  expect(w.sent('getUpdates').map((c) => c.body.timeout)).toEqual([20, 0, 0])
})

test('a tap on a question already answered in the app: "already answered" at once, collapsed, no second answer', async () => {
  const w = world()
  w.item('chatB~t1'); w.ask(70)
  w.put(`${INBOX}/answers/chatB~t1.json`, { id: 'chatB~t1', at: 1, by: 'chat' })
  w.feed([tap(1, 42, 70, 'a1')])
  await w.tick()
  expect(w.sent('answerCallbackQuery')[0]!.body.text).toBe('Уже отвечено в приложении')
  expect(w.runs).toEqual([])
  expect(w.sent('editMessageText')[0]!.body.text).toContain('отвечено в приложении')
  expect(w.json(`${TG}/log.json`)[0]).toMatchObject({ update: 1, kind: 'tap-answered', poll: 'long' })
})

test('a claim another session overwrote right after this one wrote it: this one does not poll', async () => {
  const w = world({ steal: true })
  await w.tick()
  expect(w.calls).toEqual([])
})

test('a tap of the bound user: acknowledged first, then the item answered with the label, then the message collapsed, and the ask closed', async () => {
  const w = world()
  w.item('chatB~t1'); w.ask(101)
  w.feed([tap(7, 42, 101, 'a1')])
  await w.tick()
  expect(w.log).toEqual(['getUpdates', 'answerCallbackQuery', 'run:answer', 'editMessageText'])
  expect(w.runs).toEqual([{ argv: ['answer', 'chatB~t1'], stdin: 'SQLite' }])
  expect(w.sent('answerCallbackQuery')[0]!.body).toMatchObject({ callback_query_id: 'cb7' })
  expect(w.sent('editMessageText')[0]!.body).toMatchObject({ chat_id: '42', message_id: 101, text: `<i>${Q} — SQLite</i>`, parse_mode: 'HTML' })
  expect(typeof w.json(`${TG}/asks/101.json`).closed).toBe('number')
  expect(w.disk.get(`${TG}/offset`)).toBe('8')
})

test('a dialog of two questions, one message each: the first tap only collapses its message, the second answers the item with both', async () => {
  const w = world()
  w.item('chatB~t1')
  w.ask(101, { q: Q, of: 2 }); w.ask(102, { q: 'Какой порт?', short: 'Какой порт?', options: ['5432', '5433'] })
  w.feed([tap(7, 42, 101, 'a1')])
  await w.tick()
  expect(w.runs).toEqual([])
  expect(w.sent('editMessageText')[0]!.body.text).toBe(`<i>${Q} — SQLite</i>`)
  w.put(`${TG}/asks/102.json`, { ...w.json(`${TG}/asks/102.json`), q: 'Какой порт?', of: 2 })
  w.feed([tap(8, 42, 102, 'a0')])
  await w.advance(20000)
  await w.tick()
  expect(w.runs).toEqual([{ argv: ['answer', 'chatB~t1'], stdin: JSON.stringify({ [Q]: 'SQLite', 'Какой порт?': '5432' }) }])
})

test('a message while the headless inbox is busy with an earlier one: a silent "in the queue" line at once', async () => {
  const w = world()
  w.put(`${TG}/headless.lock`, String(w.NOW - 60_000))
  w.feed([say(7, 'что нового?')])
  await w.tick()
  const q = w.sent('sendMessage')[0]!.body
  expect(q).toMatchObject({ disable_notification: true, reply_parameters: { message_id: 67 } })
  expect(q.text).toContain('В очереди')
})

test('a second tap on an answered message does not answer again', async () => {
  const w = world()
  w.item('chatB~t1'); w.ask(101)
  w.feed([tap(7, 42, 101, 'a1'), tap(8, 42, 101, 'a0')])
  await w.tick()
  expect(w.runs.filter((r) => r.argv[0] === 'answer').length).toBe(1)
  expect(w.sent('answerCallbackQuery').map((c) => c.body.text)).toEqual(['Принято, отправляю в чат', 'Уже закрыто'])
})

test('a tap of another user is refused and reaches no inbox', async () => {
  const w = world()
  w.item('chatB~t1'); w.ask(101)
  w.feed([tap(7, 99, 101, 'a1')])
  await w.tick()
  expect(w.runs).toEqual([])
  expect(w.sent('editMessageText')).toEqual([])
  expect(w.sent('answerCallbackQuery').length).toBe(1)
  expect(w.json(`${TG}/asks/101.json`).closed).toBeUndefined()
})

test('"Подробнее" with no explanation yet: a small model writes it into the item, the buttons stay without that one', async () => {
  const w = world()
  w.item('chatB~t1'); w.ask(101)
  w.feed([tap(7, 42, 101, 'm')])
  await w.tick()
  expect(w.completions.length).toBe(1)
  const edit = w.sent('editMessageText')[0]!.body
  expect(edit.text).toContain('<blockquote>Чат делает выгрузку и спрашивает, какую базу взять.</blockquote>')
  expect((edit.reply_markup.inline_keyboard as { callback_data: string }[][]).flat().map((b) => b.callback_data)).toEqual(['a0', 'a1'])
  expect(w.json(`${INBOX}/items/chatB~t1.json`).explain).toBe('Чат делает выгрузку и спрашивает, какую базу взять.')
  expect(w.json(`${TG}/asks/101.json`)).toMatchObject({ more: true })
  expect(w.json(`${TG}/asks/101.json`).closed).toBeUndefined()
  expect(w.runs).toEqual([])
})

test('"Подробнее" on an item that already has its explanation: no model call', async () => {
  const w = world()
  w.item('chatB~t1', { explain: 'Уже объяснено.' }); w.ask(101)
  w.feed([tap(7, 42, 101, 'm')])
  await w.tick()
  expect(w.completions.length).toBe(0)
  expect(w.sent('editMessageText')[0]!.body.text).toContain('<blockquote>Уже объяснено.</blockquote>')
})

test('a text reply to an ask that takes a free answer answers the item with those words', async () => {
  const w = world()
  w.item('chatB~t1'); w.ask(101)
  w.feed([say(7, 'в пятницу', { reply_to_message: { message_id: 101 } })])
  await w.tick()
  expect(w.runs.filter((r) => r.argv[0] === 'answer')).toEqual([{ argv: ['answer', 'chatB~t1'], stdin: 'в пятницу' }])
  expect(w.sent('editMessageText')[0]!.body.text).toBe(`<i>${Q} — в пятницу</i>`)
  expect(w.inbound()).toEqual([])
  expect(typeof w.json(`${TG}/asks/101.json`).closed).toBe('number')
})

for (const [what, text, extra] of [['a reply ending in a question mark', 'а почему не MySQL?', {}], ['a reply to an ask that takes no free answer', 'пока не знаю', { reply: false }]] as const) {
  test(`${what} goes to the inbox as a message about the ask, and answers nothing`, async () => {
    const w = world()
    w.item('chatB~t1'); w.ask(101, extra)
    w.feed([say(7, text, { reply_to_message: { message_id: 101 } })])
    await w.tick()
    expect(w.runs.filter((r) => r.argv[0] === 'answer')).toEqual([])
    expect(w.inbound()).toEqual([`${TG}/inbound/7.json`])
    expect(w.json(`${TG}/inbound/7.json`)).toMatchObject({ id: 7, text, message_id: 67, about: { item: 'chatB~t1', short: Q } })
    expect(w.json(`${TG}/asks/101.json`).closed).toBeUndefined()
  })
}

// No commands but /start (owner, 2026-11-17): "идея …", /idea and /ideas are plain text for the inbox model.
for (const text of ['идея купить молоко', '💡 купить молоко', '/idea купить молоко', '/ideas']) {
  test(`"${text}": a message for the inbox, no ideas.md, no reply from the poller`, async () => {
    const w = world()
    w.feed([say(7, text)])
    await w.tick()
    expect(w.json(`${TG}/inbound/7.json`)).toMatchObject({ id: 7, text })
    expect(w.disk.has('/cfg/makarasty/ideas.md')).toBe(false)
    expect(w.sent('sendMessage')).toEqual([])
  })
}

test('/status lists the open items, not the answered or the old ones, and says whether the inbox chat runs', async () => {
  const w = world()
  w.item('chatB~t1', { at: w.NOW - 5 * 60000 })
  w.item('chatC~t2', { at: w.NOW - 5 * 60000 }); w.put(`${INBOX}/answers/chatC~t2.json`, '{}')
  w.item('chatD~t3', { at: w.NOW - 13 * H })
  w.feed([say(7, '/status')])
  await w.tick()
  const text = w.sent('sendMessage')[0]!.body.text as string
  expect(text).toContain('<b>Ждут ответа: 1</b>')
  expect(text).toContain(`${Q} <i>reports-app · 5 мин</i>`)
  expect(text).toContain('не запущен')
  expect(w.inbound()).toEqual([])
})

test('a plain message: a file for it and a reaction', async () => {
  const w = world()
  w.feed([say(7, 'сколько вопросов ждёт?')])
  await w.tick()
  expect(w.json(`${TG}/inbound/7.json`)).toEqual({ id: 7, text: 'сколько вопросов ждёт?', message_id: 67, at: w.NOW })
  expect(w.sent('setMessageReaction')[0]!.body).toEqual({ chat_id: '42', message_id: 67, reaction: [{ type: 'emoji', emoji: '👀' }] })
})

// Always the headless inbox, the inbox chat running or not (2026-11-18: a working Opus chat paid a turn per message).
for (const [what, beat] of [['the inbox chat running', (n: number) => String(n - 10_000)], ['an inbox beat older than 60 s', (n: number) => String(n - 61_000)], ['no inbox beat at all', () => undefined]] as const) {
  test(`a plain message with ${what}: the headless inbox turn is started`, async () => {
    const w = world()
    const b = beat(w.NOW)
    if (b) w.put(`${INBOX}/beat`, b)
    w.feed([say(7, 'что нового?')])
    await w.tick()
    await w.wait()
    expect(w.runs).toEqual([{ argv: ['telegram'], stdin: undefined }])
    expect(w.inbound()).toEqual([`${TG}/inbound/7.json`])
  })
}

for (const [what, u] of [
  ['a forwarded message', say(7, 'чужой текст', { forward_origin: { type: 'user' } })],
  ['a message in a group', { update_id: 7, message: { message_id: 67, chat: { id: 42, type: 'group' }, from: { id: 42 }, text: 'привет' } }],
  ['a message from a stranger', { update_id: 7, message: { message_id: 67, chat: { id: 99, type: 'private' }, from: { id: 99 }, text: 'привет' } }],
] as const) {
  test(`${what}: nothing, not even a reply`, async () => {
    const w = world()
    w.feed([u])
    await w.tick()
    await w.wait()
    expect(w.log).toEqual(['getUpdates'])
    expect(w.inbound()).toEqual([])
    expect(w.disk.has('/cfg/makarasty/ideas.md')).toBe(false)
  })
}

test('the same update twice (a second poller, or a batch not yet confirmed) is handled once', async () => {
  const w = world()
  w.feed([say(7, '/start')])
  await w.tick()
  await w.advance(20000)
  await w.tick()
  await w.wait()
  expect(w.sent('sendMessage').length).toBe(1)
  expect(JSON.parse(w.disk.get(`${TG}/seen.json`)!)).toEqual([7])
})

test('a 401 pauses the poll for 10 minutes', async () => {
  const w = world({ getUpdates: (n) => (n === 1 ? [401, { ok: false, description: 'Unauthorized' }] : [200, { ok: true, result: [] }]) })
  await w.tick()
  await w.advance(5 * 60000)
  await w.tick()
  expect(w.sent('getUpdates').length).toBe(1)
  await w.advance(6 * 60000)
  await w.tick()
  expect(w.sent('getUpdates').length).toBe(2)
})

test('the computer was off over 23 h: one silent notice, since Telegram kept nothing older than a day', async () => {
  const w = world()
  w.put(`${TG}/lastok`, String(w.NOW - 24 * H))
  await w.tick()
  const notice = w.sent('sendMessage')
  expect(notice.length).toBe(1)
  expect(notice[0]!.body.text).toContain('Компьютер был недоступен 24 ч')
  expect(notice[0]!.body.disable_notification).toBe(true)
  expect(w.disk.get(`${TG}/lastok`)).toBe(String(w.NOW))
})

test('a gap under 23 h says nothing', async () => {
  const w = world()
  w.put(`${TG}/lastok`, String(w.NOW - 2 * H))
  await w.tick()
  expect(w.sent('sendMessage')).toEqual([])
})

test('the sweep collapses an ask past 12 h, one answered on the computer and one whose item is gone, and leaves a fresh one', async () => {
  const w = world()
  for (const id of ['i-old', 'i-ans', 'i-fresh']) w.item(id)
  w.put(`${INBOX}/answers/i-ans.json`, '{}')
  w.ask(201, { item: 'i-old', short: 'S-old', at: w.NOW - 13 * H })
  w.ask(202, { item: 'i-ans', short: 'S-ans' })
  w.ask(203, { item: 'i-gone', short: 'S-gone' })
  w.ask(204, { item: 'i-fresh', short: 'S-fresh' })
  await w.tick()
  const edits = Object.fromEntries(w.sent('editMessageText').map((c) => [c.body.message_id, c.body.text]))
  expect(edits).toEqual({ 201: '<i>S-old — устарело</i>', 202: '<i>S-ans — отвечено на компьютере</i>', 203: '<i>S-gone — закрыто</i>' })
  for (const id of [201, 202, 203]) expect(typeof w.json(`${TG}/asks/${id}.json`).closed).toBe('number')
  expect(w.json(`${TG}/asks/204.json`).closed).toBeUndefined()
})

// The language of every word: no profile is English, "Language: Russian" is the Russian texts above.
test('no profile: a tap is acknowledged and collapsed in English', async () => {
  const w = world({ profile: null })
  w.item('chatB~t1'); w.ask(70)
  w.put(`${INBOX}/answers/chatB~t1.json`, { id: 'chatB~t1', at: 1, by: 'chat' })
  w.feed([tap(1, 42, 70, 'a1'), tap(2, 42, 70, 'a9')])
  await w.tick()
  expect(w.sent('answerCallbackQuery').map((c) => c.body.text)).toEqual(['Already answered in the app', 'Already closed'])
  expect(w.sent('editMessageText')[0]!.body.text).toContain('answered in the app')
})

test('no profile: /start and /status are English; Language: Russian gives the Russian ones', async () => {
  const en = world({ profile: null })
  en.item('chatB~t1', { at: en.NOW - 5 * 60000 })
  en.feed([say(7, '/start'), say(8, '/status')])
  await en.tick()
  const [help, status] = en.sent('sendMessage').map((c) => c.body.text as string)
  expect(help).toContain('<b>What the bot does</b>')
  expect(status).toContain('<b>Waiting for an answer: 1</b>')
  expect(status).toContain(`${Q} <i>reports-app · 5 min</i>`)
  expect(status).toContain('the inbox is not running')
  expect(help).not.toMatch(/\/ideas|\/status|idea/)
  for (const text of [help, status]) expect(text).not.toMatch(/Что умеет|Ждут|Идей|мин|запущен/) // the question itself (Q) is the chat's own Russian text
  const ru = world()
  ru.feed([say(7, '/start')])
  await ru.tick()
  const [rhelp] = ru.sent('sendMessage').map((c) => c.body.text as string)
  expect(rhelp).toContain('<b>Что умеет бот</b>')
  expect(rhelp).toContain('• пиши что угодно обычным текстом')
  expect(rhelp).toContain('• «❔ Подробнее» — пояснение к вопросу')
})

test('Язык: русский in the profile counts, and the explanation hint follows the language', async () => {
  for (const [profile, hint] of [['Язык: русский', 'Непонятно — ответь на это сообщение вопросом.'], [null, 'Not clear? Reply to this message with a question.']] as const) {
    const w = world({ profile })
    w.item('chatB~t1', { explain: 'x' }); w.ask(101)
    w.feed([tap(1, 42, 101, 'm')])
    await w.tick()
    const edit = w.sent('editMessageText')[0]!.body
    expect(edit.text).toContain(hint)
    expect(JSON.stringify(edit.reply_markup)).not.toContain(profile ? 'Details' : 'Подробнее')
  }
})
